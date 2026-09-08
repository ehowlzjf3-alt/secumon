import { z } from 'zod';
import type { EvaluationPins, EvaluationReplayBundle, EvaluationReplayResult, EvaluationSample } from '../domain/execution-evaluation.js';
import type { ArtifactRef, Delivery, Policy, StoredEvent, WorkState } from '../domain/model.js';
import type { ResumePacket } from '../domain/recovery.js';
import { accessibleEvidence, historicalEvidence } from '../domain/completion.js';
import { artifactBlocked, dataGeneration } from '../domain/data-lifecycle.js';
import { readCollectionContext, visibleReadProgress } from '../domain/context.js';
import { hypothesesRequireReview } from '../domain/hypotheses.js';
import { executionControl } from '../domain/execution-policy.js';
import { budgetSummary } from '../domain/budget-delegation.js';
import { ArtifactSchema, JsonSchema, WorkStateSchema } from './contracts.js';
import { DeliverySchema, StoredEventSchema } from './store-contract.js';
import { ResumePacketSchema } from './recovery-contracts.js';
import { progressSummary } from './execution-control.js';
import { scoreEvaluation } from './execution-evaluation.js';
import { asJson } from './plan-validator.js';
import type { RuntimeServices } from './services.js';
import type { WorkActor } from './work-resources.js';

const id = z.string().min(1).max(256);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const pinsSchema = z.strictObject({ suite: id, fixture: id, caseDefinition: hash, code: id, configuration: id, environment: JsonSchema });
const actorSchema = z.strictObject({ tenantId: id, principalId: id, allowedLabels: z.array(id).max(10000).optional(),
  allowedTools: z.array(id).max(10000).optional(), allowedDestinations: z.array(id).max(10000).optional(), allowWrites: z.boolean().optional() });
const sampleSchema: z.ZodType<EvaluationSample> = z.strictObject({
  case: z.strictObject({ id, family: z.enum(['document_comparison', 'observation_review']), fixtureId: id, backend: id,
    mode: z.enum(['auto', 'fast', 'deep']), variant: z.enum(['simple', 'complex', 'late_counterevidence', 'partial_result', 'source_missing', 'permission_revoked',
      'tool_errors', 'model_errors', 'next_day_reply', 'mode_change', 'cancel_running', 'stored_model_resume', 'stored_tool_resume', 'compact', 'unknown_delivery', 'status_only']),
    oracle: z.strictObject({ expectedFinal: z.enum(['complete', 'blocked', 'cancelled', 'wait', 'unchanged']), completionEligible: z.boolean(),
      requiredEvidenceIds: z.array(id).max(10000), originals: z.array(z.strictObject({ id, sourceId: id, lineageId: id, observedAt: count })).max(10000),
      facts: z.record(z.string(), scalar), finalHypothesis: z.strictObject({ id, status: z.enum(['supported', 'refuted', 'inconclusive']) }).nullable(),
      forbiddenEvidenceIds: z.array(id).max(10000), noCompletionBefore: count.nullable(),
      response: z.strictObject({ kind: z.literal('exact_text'), text: z.string().min(1).max(256 * 1024), sha256: hash }).optional() }) }),
  observations: z.array(z.strictObject({ at: count, stage: id, state: WorkStateSchema, eventTypes: z.array(id).max(10000), deliveries: z.array(DeliverySchema).max(10000),
    response: z.strictObject({ artifact: ArtifactSchema, text: z.string().max(256 * 1024) }).optional() })).min(1).max(10000),
  entries: z.array(z.strictObject({ kind: z.enum(['model', 'tool', 'send', 'lookup']), at: count, id, sourceKey: z.string().max(100000).nullable() })).max(100000),
  finalControl: id, startedAt: count, finishedAt: count, wallElapsedMs: z.number().finite().nonnegative(), runError: z.string().max(100000).nullable(),
});
const bundleSchema = z.strictObject({ version: z.literal(1), workId: id, pins: pinsSchema, sample: sampleSchema, sampleDigest: hash,
  score: JsonSchema, scoreDigest: hash, finalStateDigest: hash, eventsDigest: hash, deliveriesDigest: hash,
  receipts: z.array(z.strictObject({ commandId: id, digest: id, stateRevision: count.min(1), stateDigest: hash })).min(1).max(10000),
  artifacts: z.array(ArtifactSchema).max(10000), checkpoint: ArtifactSchema.nullable() });

class ReplayFailure extends Error {}
const fail = (code: string): never => { throw new ReplayFailure(code); };
type Services = Pick<RuntimeServices, 'state' | 'artifacts' | 'digester'>;

/** Consistency verification only: no state writes, artifact publication, recovery or external invocation. */
export async function replayEvaluation(bundle: EvaluationReplayBundle, expectedPins: EvaluationPins, actor: WorkActor, services: Services): Promise<EvaluationReplayResult> {
  let checkedReceipts = 0; let checkedArtifacts = 0;
  try {
    if (!bundle || bundle.version !== 1) fail('replay_version_unsupported');
    // Pin caller-owned objects before the first asynchronous boundary.
    const input = bundleSchema.parse(structuredClone(bundle));
    const expected = pinsSchema.parse(structuredClone(expectedPins));
    const principal = actorSchema.parse(structuredClone(actor));
    const digest = (value: unknown) => services.digester.digest(asJson(value));
    const equal = (left: unknown, right: unknown) => left === undefined || right === undefined ? left === right : digest(left) === digest(right);
    if (!equal(input.pins, expected)) fail('replay_pins_mismatch');
    if (digest(input.sample.case) !== expected.caseDefinition) fail('replay_case_definition_mismatch');
    if (digest(input.sample) !== input.sampleDigest || digest(input.score) !== input.scoreDigest) fail('replay_payload_digest_mismatch');
    const responseOracle = input.sample.case.oracle.response;
    if (responseOracle) {
      const bytes = new TextEncoder().encode(responseOracle.text);
      const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
      const sha256 = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
      if (!responseOracle.text.trim() || bytes.byteLength > 256 * 1024 || sha256 !== responseOracle.sha256) fail('replay_response_oracle_invalid');
    }
    const score = scoreEvaluation(input.sample);
    if (!equal(score, input.score)) fail('replay_score_mismatch');

    const readCanonical = async () => {
      const raw = await services.state.get(input.workId);
      if (!raw) return fail('replay_work_unavailable');
      const state = WorkStateSchema.parse(raw);
      if (state.id !== input.workId || state.policy.tenantId !== principal.tenantId || state.policy.principalId !== principal.principalId)
        fail('replay_work_unavailable');
      if (digest(state) !== input.finalStateDigest) fail('replay_state_changed');
      return state;
    };
    const state = await readCanonical();
    const policy: Policy = { ...structuredClone(state.policy),
      allowedLabels: state.policy.allowedLabels.filter(label => principal.allowedLabels === undefined || principal.allowedLabels.includes(label)),
      allowedTools: state.policy.allowedTools.filter(tool => principal.allowedTools === undefined || principal.allowedTools.includes(tool)),
      allowedDestinations: state.policy.allowedDestinations.filter(destination => principal.allowedDestinations === undefined || principal.allowedDestinations.includes(destination)),
      allowWrites: state.policy.allowWrites && principal.allowWrites !== false };
    const readHistory = async () => {
      const events = z.array(StoredEventSchema).min(1).max(100000).parse(await services.state.events(input.workId, 0));
      const deliveries = z.array(DeliverySchema).max(10000).parse(await services.state.deliveries(input.workId));
      if (digest(events) !== input.eventsDigest || digest(deliveries) !== input.deliveriesDigest) fail('replay_history_changed');
      if (deliveries.some(delivery => delivery.workId !== state.id) || new Set(deliveries.map(delivery => delivery.id)).size !== deliveries.length)
        fail('replay_history_invalid');
      const commands = new Map<string, number>(); const revisions = new Map<number, string>();
      for (const [index, event] of events.entries()) {
        const prior = events[index - 1];
        if (event.workId !== state.id || event.sequence !== index + 1 || event.revision > state.revision ||
          (!prior ? event.revision !== 1 : event.revision < prior.revision || event.revision > prior.revision + 1) ||
          commands.has(event.commandId) && commands.get(event.commandId) !== event.revision ||
          revisions.has(event.revision) && revisions.get(event.revision) !== event.commandId) fail('replay_history_invalid');
        commands.set(event.commandId, event.revision); revisions.set(event.revision, event.commandId);
      }
      if (events.at(-1)!.revision !== state.revision) fail('replay_history_invalid');
      return { events, deliveries, commands };
    };
    const history = await readHistory();
    const pins = new Map(input.receipts.map(receipt => [receipt.commandId, receipt]));
    if (pins.size !== input.receipts.length || pins.size !== history.commands.size || [...history.commands.keys()].some(command => !pins.has(command)))
      fail('replay_receipts_incomplete');
    const snapshots = new Map<number, WorkState>();
    const readReceipts = async (initial: boolean) => {
      for (const pin of input.receipts) {
        const receipt = await services.state.receipt(input.workId, pin.commandId);
        if (!receipt || receipt.digest !== pin.digest) fail('replay_receipt_unavailable');
        const snapshot = WorkStateSchema.parse(receipt!.state);
        if (snapshot.id !== state.id || snapshot.revision !== pin.stateRevision || history.commands.get(pin.commandId) !== pin.stateRevision ||
          snapshot.policy.tenantId !== principal.tenantId || snapshot.policy.principalId !== principal.principalId || digest(snapshot) !== pin.stateDigest)
          fail('replay_receipt_changed');
        if (initial) { snapshots.set(snapshot.revision, snapshot); checkedReceipts++; }
        else if (!equal(snapshot, snapshots.get(snapshot.revision))) fail('replay_receipt_changed');
      }
    };
    await readReceipts(true);
    if (!equal(snapshots.get(state.revision), state)) fail('replay_final_receipt_mismatch');
    const statusOnly = input.sample.case.variant === 'status_only';
    if (statusOnly && (input.sample.case.oracle.expectedFinal !== 'unchanged' || input.sample.entries.length)) fail('replay_status_phase_invalid');
    const observed = new Set<number>(); const eventObserved = new Set<number>();
    for (const observation of input.sample.observations) {
      const revision = observation.state.revision;
      if (observation.state.id !== state.id || !equal(observation.state, snapshots.get(revision))) fail('replay_observation_changed');
      if (observation.deliveries.some(delivery => delivery.workId !== state.id) || new Set(observation.deliveries.map(delivery => delivery.id)).size !== observation.deliveries.length)
        fail('replay_observation_changed');
      // Intermediate delivery rows are a measurement snapshot, not a historical receipt projection.
      if (statusOnly) {
        if (!equal(observation.state, state) || !equal(observation.deliveries, history.deliveries) || observation.eventTypes.length) fail('replay_status_phase_invalid');
      } else if (observation.eventTypes.length) {
        if (!equal(observation.eventTypes, history.events.filter(event => event.revision === revision).map(event => event.type))) fail('replay_observation_events_changed');
        eventObserved.add(revision);
      } else if (!eventObserved.has(revision)) fail('replay_observation_events_missing');
      observed.add(revision);
    }
    if (!statusOnly && [...snapshots.keys()].some(revision => !observed.has(revision) || !eventObserved.has(revision))) fail('replay_observations_incomplete');
    const final = input.sample.observations.at(-1)!;
    if (!equal(final.state, state) || !equal(final.deliveries, history.deliveries)) fail('replay_final_observation_changed');

    const refs = new Map<string, ArtifactRef>(); let nodes = 0;
    const collect = (value: unknown, depth = 0): void => {
      if (++nodes > 2000000 || depth > 100) fail('replay_reference_limit');
      if (value === null || typeof value !== 'object') return;
      if (Array.isArray(value)) { for (const child of value) collect(child, depth + 1); return; }
      const object = value as Record<string, unknown>;
      if ('sha256' in object && 'byteLength' in object && 'mediaType' in object && 'tenantId' in object && 'labels' in object && 'id' in object) {
        const ref = ArtifactSchema.parse(object); const prior = refs.get(ref.id);
        if (prior && !equal(prior, ref)) fail('replay_reference_conflict');
        refs.set(ref.id, ref); if (refs.size > 10000) fail('replay_reference_limit');
        return;
      }
      for (const child of Object.values(object)) collect(child, depth + 1);
    };
    collect(state); collect([...snapshots.values()]); collect(input.sample); collect(history.deliveries); collect(input.checkpoint);
    const blockedEvidence = new Set(state.evidence.filter(evidence => (evidence.access ?? 'available') !== 'available').map(evidence => evidence.id));
    for (const change of state.dataLifecycle?.changes ?? []) if (['delete', 'restrict', 'dependency_changed'].includes(change.action))
      for (const evidenceId of change.evidenceIds) blockedEvidence.add(evidenceId);
    for (const snapshot of snapshots.values()) {
      if (snapshot.evidence.some(evidence => evidence.tenantId !== policy.tenantId || evidence.labels.some(label => !policy.allowedLabels.includes(label)) ||
        (evidence.access ?? 'available') !== 'available' || blockedEvidence.has(evidence.id))) fail('replay_source_unavailable');
    }
    const permitted = (ref: ArtifactRef) => !artifactBlocked(state, ref) && ref.tenantId === policy.tenantId && ref.labels.every(label => policy.allowedLabels.includes(label));
    const read = async (ref: ArtifactRef) => {
      if (!permitted(ref)) return fail('replay_artifact_unavailable');
      let bytes: Uint8Array;
      // The ArtifactStore contract authenticates the full reference, content hash and bytes.
      try { bytes = await services.artifacts.get(structuredClone(ref), structuredClone(policy)); }
      catch { return fail('replay_artifact_unavailable'); }
      if (bytes.byteLength !== ref.byteLength) fail('replay_artifact_unavailable');
      return bytes;
    };
    if (input.checkpoint) {
      if (input.checkpoint.mediaType !== 'application/json') fail('replay_checkpoint_invalid');
      const bytes = await read(input.checkpoint);
      let packet: ResumePacket;
      try { packet = ResumePacketSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
      catch { return fail('replay_checkpoint_invalid'); }
      validateCheckpoint(packet, state, history.events, history.deliveries, equal, digest);
      collect(packet);
    }
    const listed = new Map<string, ArtifactRef>();
    for (const ref of input.artifacts) { if (listed.has(ref.id)) fail('replay_references_incomplete'); listed.set(ref.id, ref); }
    if (listed.size !== refs.size || [...refs.values()].some(ref => !equal(ref, listed.get(ref.id)))) fail('replay_references_incomplete');
    const responses = new Map<string, string>();
    for (const observation of input.sample.observations) if (observation.response) {
      const response = observation.response, prior = responses.get(response.artifact.id);
      if (!equal(response.artifact, observation.state.generatedAnswer?.artifact) || response.artifact.mediaType !== 'text/plain' ||
        response.artifact.byteLength > 256 * 1024 || new TextEncoder().encode(response.text).byteLength !== response.artifact.byteLength ||
        prior !== undefined && prior !== response.text) fail('replay_response_original_changed');
      responses.set(response.artifact.id, response.text);
    }
    for (const ref of refs.values()) {
      const bytes = await read(ref); checkedArtifacts++;
      const response = responses.get(ref.id);
      if (response !== undefined) {
        let text: string;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { return fail('replay_response_original_changed'); }
        if (text !== response) fail('replay_response_original_changed');
      }
    }
    await readReceipts(false);
    await readHistory();
    await readCanonical();
    if (!equal(actorSchema.parse(actor), principal) || !equal(pinsSchema.parse(expectedPins), expected)) fail('replay_authority_changed');
    return { available: true, failures: [], score: structuredClone(score), checkedReceipts, checkedArtifacts };
  } catch (error) {
    return { available: false, failures: [error instanceof ReplayFailure ? error.message : 'replay_invalid_or_unavailable'], score: null, checkedReceipts, checkedArtifacts };
  }
}

function validateCheckpoint(packet: ResumePacket, state: WorkState, events: StoredEvent[], deliveries: Delivery[],
  equal: (left: unknown, right: unknown) => boolean, digest: (value: unknown) => string): void {
  if (packet.workId !== state.id || packet.stateRevision !== state.revision || packet.eventCursor !== events.at(-1)!.sequence ||
    packet.stateDigest !== digest({ state, deliveries })) fail('replay_checkpoint_binding_changed');
  const evidence = accessibleEvidence(state.evidence, state.policy, state.goal.scope);
  const historical = historicalEvidence(state.evidence, state.policy, state.goal.scope);
  const currentIds = new Set(evidence.map(item => item.id));
  const referenced = new Set([...state.hypotheses.flatMap(hypothesis => [...hypothesis.supportIds, ...hypothesis.counterIds]), ...(state.hypothesisAssessment?.evidenceIds ?? [])]);
  const readCollections = readCollectionContext(state); const tips = new Set(readCollections.map(collection => collection.attemptId));
  const attempts = state.attempts.filter(attempt => attempt.goalRevision === state.goal.revision && attempt.scope === state.goal.scope)
    .map(({ knowledgeDependencies: _dependencies, readProgress, ...attempt }) => ({ ...attempt,
      ...(readProgress && tips.has(attempt.id) ? { readProgress } : {}), ...(attempt.resultArtifact && artifactBlocked(state, attempt.resultArtifact) ? { resultArtifact: null } : {}) }));
  if (packet.context.activeToolIds.some(tool => !state.policy.allowedTools.includes(tool)))
    fail('replay_checkpoint_binding_changed');
  // Current catalog bytes are pinned by expectedPins; this read-only API has no catalog service.
  const context = { schemaVersion: 1, workId: state.id, stateRevision: state.revision, goal: state.goal, policy: state.policy, plan: state.plan,
    ...(state.attempts.some(attempt => attempt.readProgress) ? { readCollections } : {}), hypotheses: state.hypotheses, obligations: state.obligations,
    evidence: [...evidence, ...historical.filter(item => referenced.has(item.id) && !currentIds.has(item.id))]
      .map(item => item.artifact && artifactBlocked(state, item.artifact) ? { ...item, artifact: null } : item),
    activeToolIds: packet.context.activeToolIds, purpose: hypothesesRequireReview(state) ? 'assess' : 'plan',
    execution: { budget: state.budget, deadlineAt: state.deadlineAt, attempts, hypothesisAssessment: state.hypothesisAssessment,
      control: executionControl(state), ...(state.progress ? { progress: progressSummary(state) } : {}),
      ...(state.budgetParent || state.budgetGrants?.length ? { delegation: budgetSummary(state) } : {}) },
    planningFeedback: state.modelCalls.filter(call => call.goalRevision === state.goal.revision && call.status === 'rejected').slice(-3).map(call => ({ callId: call.id, reason: call.reason })) };
  const expectedRefs = [...state.artifacts, ...state.evidence.flatMap(item => item.artifact ? [item.artifact] : []), ...state.attempts.flatMap(attempt => attempt.resultArtifact ? [attempt.resultArtifact] : []),
    ...state.modelCalls.flatMap(call => [call.inputArtifact, ...(call.replyArtifact ? [call.replyArtifact] : [])]), ...(state.conversation?.result ? [state.conversation.result.artifact] : []),
    ...deliveries.flatMap(delivery => delivery.context?.artifact ? [delivery.context.artifact] : []), ...(state.workspaceCheckpoints?.map(checkpoint => checkpoint.artifact) ?? []),
    ...state.attempts.flatMap(attempt => attempt.readProgress && visibleReadProgress(state, attempt.readProgress) ? [attempt.readProgress.head] : [])].filter(ref => !artifactBlocked(state, ref));
  const runtime = { status: state.status, statusReason: state.statusReason, budget: state.budget, deadlineAt: state.deadlineAt,
    executionControl: executionControl(state), ...(state.progress ? { progress: progressSummary(state) } : {}),
    ...(state.budgetParent || state.budgetGrants?.length ? { delegation: budgetSummary(state) } : {}), ...(state.retryWakeAt === undefined ? {} : { retryWakeAt: state.retryWakeAt }),
    attempts: state.attempts.map(({ knowledgeDependencies: _dependencies, readProgress, ...attempt }) => ({ ...attempt,
      ...(readProgress && visibleReadProgress(state, readProgress) ? { readProgress } : {}), resultArtifact: attempt.resultArtifact && artifactBlocked(state, attempt.resultArtifact) ? null : attempt.resultArtifact })),
    modelCalls: state.modelCalls.map(call => ({ ...call, inputArtifact: artifactBlocked(state, call.inputArtifact) ? null : call.inputArtifact,
      replyArtifact: call.replyArtifact && artifactBlocked(state, call.replyArtifact) ? null : call.replyArtifact })), hypothesisAssessment: state.hypothesisAssessment,
    artifacts: [...new Map(expectedRefs.map(ref => [ref.id, ref])).values()].sort((a, b) => a.id.localeCompare(b.id, 'en')), conversation: state.conversation,
    ...(state.dataLifecycle ? { dataLifecycle: state.dataLifecycle } : {}), ...(state.workspaceCheckpoints ? { workspaceCheckpoints: state.workspaceCheckpoints.filter(checkpoint => checkpoint.lifecycleGeneration === dataGeneration(state) && !artifactBlocked(state, checkpoint.artifact)) } : {}) };
  const evidenceIndex = historical.map(({ facts: _facts, ...metadata }) => metadata.artifact && artifactBlocked(state, metadata.artifact) ? { ...metadata, artifact: null } : metadata);
  const visibleDeliveries = deliveries.map(({ text: _text, ...metadata }) => metadata.context && state.dataLifecycle
    ? { ...metadata, context: { ...metadata.context, labels: [], evidenceIds: [], artifact: null } } : metadata).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  if (!equal(packet.context, context) || !equal(packet.runtime, runtime) || !equal(packet.evidenceIndex, evidenceIndex) || !equal(packet.deliveries, visibleDeliveries))
    fail('replay_checkpoint_binding_changed');
}
