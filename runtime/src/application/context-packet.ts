import { visibleComputerProgress, type ComputerCheckpoint, type ComputerCheckpointV2 } from '../domain/computer-use.js';
import type { ComputerReconciliation } from '../domain/computer-reconciliation.js';
import type { ComputerContinuationClaim } from '../domain/computer-continuation.js';
import { accessibleEvidence, historicalEvidence } from '../domain/completion.js';
import { artifactBlocked, dataGeneration, visibleArtifact } from '../domain/data-lifecycle.js';
import { hypothesesRequireReview } from '../domain/hypotheses.js';
import type { ArtifactRef, Attempt, ContextPacket, WorkState } from '../domain/model.js';
import { readSessionContext, sessionContextCurrent } from './session-context.js';
import { ComputerContinuationClaimSchema, ContextPacketSchema, ToolResultSchema, parseContract } from './contracts.js';
import type { ToolContracts } from './tool-contracts.js';
import type { RuntimeServices } from './services.js';
import { knowledgeInputsCurrent } from './knowledge-validity.js';
import { readCollectionContext } from '../domain/context.js';
import { executionControl } from '../domain/execution-policy.js';
import { progressSummary } from './execution-control.js';
import { budgetSummary } from '../domain/budget-delegation.js';
import { ComputerCheckpointSchema, ComputerObservationRecordSchema } from './computer-use-contracts.js';
import { asJson } from './plan-validator.js';
import { controlProofsCurrent as effectProofsCurrent, requiresControlProofs as requiresEffectProofs } from './control-proofs.js';

const reference = (ref: ArtifactRef): ArtifactRef => ({ id: ref.id, sha256: ref.sha256, byteLength: ref.byteLength,
  mediaType: ref.mediaType, tenantId: ref.tenantId, labels: [...ref.labels] });
const sameReference = (a: ArtifactRef | null, b: ArtifactRef | null): boolean => a === null || b === null ? a === b :
  a.id === b.id && a.sha256 === b.sha256 && a.byteLength === b.byteLength && a.mediaType === b.mediaType &&
  a.tenantId === b.tenantId && a.labels.length === b.labels.length && a.labels.every((label, index) => label === b.labels[index]);

function continuationChain(state: WorkState, value: ComputerContinuationClaim): ComputerContinuationClaim[] | null {
  const result: ComputerContinuationClaim[] = []; const visited = new Set<string>(); let claim = value;
  for (let depth = 0; depth < 8; depth++) {
    if (visited.has(claim.successorAttemptId) || claim.rootAttemptId !== value.rootAttemptId) return null;
    visited.add(claim.successorAttemptId); result.push(claim);
    if (claim.sourceAttemptId === claim.rootAttemptId) return claim.depth === 1 ? result : null;
    const parents = (state.computerContinuations ?? []).filter(parent => parent.successorAttemptId === claim.sourceAttemptId);
    if (parents.length !== 1 || parents[0]!.depth !== claim.depth - 1) return null;
    claim = parents[0]!;
  }
  return null;
}

function continuationReferences(state: WorkState, chain: ComputerContinuationClaim[]): ArtifactRef[] | null {
  const refs: ArtifactRef[] = [];
  for (const claim of chain) {
    const source = state.attempts.find(attempt => attempt.id === claim.sourceAttemptId);
    if (!source?.computerUse || !sameReference(source.computerUse.head, claim.sourceHead) ||
      !sameReference(source.resultArtifact, claim.sourceResultArtifact)) return null;
    refs.push(claim.sourceHead, ...(claim.sourceResultArtifact ? [claim.sourceResultArtifact] : []));
    if (claim.reconciliation) {
      const record = state.computerReconciliations?.find(item => item.id === claim.reconciliation!.id);
      if (!record || record.sourceAttemptId !== claim.sourceAttemptId || !sameReference(record.sourceHead, claim.sourceHead) ||
        !sameReference(record.sourceResultArtifact, claim.sourceResultArtifact) ||
        !sameReference(record.proofArtifact, claim.reconciliation.proofArtifact)) return null;
      refs.push(...computerReconciliationRefs(record));
    }
  }
  return refs;
}

/** Explicit, bounded metadata only; every ancestor remains a protected dependency of the successor. */
export function computerContinuationContext(state: WorkState): ComputerContinuationClaim[] {
  return (state.computerContinuations ?? []).filter(claim => {
    const chain = continuationChain(state, claim); const refs = chain && continuationReferences(state, chain);
    return chain && refs && chain.every(parent => parent.generation === dataGeneration(state)) && refs.every(ref => visibleArtifact(state, ref));
  }).map(claim => ({ sourceAttemptId: claim.sourceAttemptId, sourceHead: reference(claim.sourceHead),
    sourceResultArtifact: claim.sourceResultArtifact && reference(claim.sourceResultArtifact), successorAttemptId: claim.successorAttemptId,
    successorTaskDigest: claim.successorTaskDigest, mode: claim.mode,
    reconciliation: claim.reconciliation && { id: claim.reconciliation.id, proofArtifact: reference(claim.reconciliation.proofArtifact) },
    rootAttemptId: claim.rootAttemptId, sourceContractDigest: claim.sourceContractDigest, contractDigest: claim.contractDigest,
    goalRevision: claim.goalRevision, scope: claim.scope, policyDigest: claim.policyDigest, generation: claim.generation,
    createdAt: claim.createdAt, actionDeadlineAt: claim.actionDeadlineAt, maxObservations: claim.maxObservations,
    maxInputAttempts: claim.maxInputAttempts, maxSuccessors: claim.maxSuccessors, depth: claim.depth,
    observationsUsed: claim.observationsUsed, inputAttemptsUsed: claim.inputAttemptsUsed, nextStep: claim.nextStep, totalSteps: claim.totalSteps }));
}

export function computerContinuationRefs(state: WorkState): ArtifactRef[] {
  const refs = new Map<string, ArtifactRef>();
  for (const claim of computerContinuationContext(state)) for (const ref of continuationReferences(state, continuationChain(state, claim)!)!) {
    const prior = refs.get(ref.id); if (prior && !sameReference(prior, ref)) throw new Error('context_continuation_reference_conflict');
    refs.set(ref.id, reference(ref));
  }
  return [...refs.values()];
}

const checkpointObservationRefs = (checkpoint: ComputerCheckpoint): ArtifactRef[] => [checkpoint.initialObservation, checkpoint.latestObservation,
  ...checkpoint.steps.flatMap(step => [step.before, ...(step.after ? [step.after] : [])]),
  ...(checkpoint.schemaVersion === 2 ? [checkpoint.entryObservation, checkpoint.continuation?.inheritedObservation]
    .filter((ref): ref is ArtifactRef => ref !== null && ref !== undefined) : [])];

function checkpointLineageRefs(state: WorkState, checkpoint: ComputerCheckpointV2): ArtifactRef[] {
  const incoming = (state.computerContinuations ?? []).filter(claim => claim.successorAttemptId === checkpoint.attemptId);
  if (!checkpoint.continuation) {
    if (incoming.length) throw new Error('context_continuation_source_unavailable');
    return [];
  }
  const claim = checkpoint.continuation.claim;
  if (incoming.length !== 1 || JSON.stringify(parseContract(ComputerContinuationClaimSchema, incoming[0])) !== JSON.stringify(claim))
    throw new Error('context_continuation_source_unavailable');
  const chain = continuationChain(state, incoming[0]!); const refs = chain && continuationReferences(state, chain);
  if (!chain || !refs || !chain.every(parent => parent.generation === dataGeneration(state)) || !refs.every(ref => visibleArtifact(state, ref)))
    throw new Error('context_continuation_source_unavailable');
  return refs;
}

async function readComputerOriginal(ref: ArtifactRef, read: (ref: ArtifactRef) => Promise<Uint8Array>): Promise<unknown> {
  if (ref.mediaType !== 'application/json' || ref.byteLength > 262144) throw new Error('context_continuation_source_unavailable');
  const bytes = await read(ref);
  if (bytes.byteLength !== ref.byteLength) throw new Error('context_continuation_source_unavailable');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

async function verifyCheckpointV2References(state: WorkState, checkpoint: ComputerCheckpointV2,
  read: (ref: ArtifactRef) => Promise<Uint8Array>): Promise<void> {
  checkpointLineageRefs(state, checkpoint);
  if (checkpoint.continuation) {
    const source = parseContract(ComputerCheckpointSchema, await readComputerOriginal(checkpoint.continuation.claim.sourceHead, read));
    if (source.workId !== state.id || source.attemptId !== checkpoint.continuation.claim.sourceAttemptId ||
      !sameReference(checkpoint.initialObservation, source.latestObservation)) throw new Error('context_continuation_source_unavailable');
  }
  const refs = [checkpoint.entryObservation, checkpoint.continuation?.inheritedObservation]
    .filter((ref): ref is ArtifactRef => ref !== null && ref !== undefined);
  const seen = new Map<string, ArtifactRef>();
  for (const ref of refs) {
    if (!visibleArtifact(state, ref)) throw new Error('context_continuation_source_unavailable');
    const previous = seen.get(ref.id);
    if (previous && !sameReference(previous, ref)) throw new Error('context_continuation_reference_conflict');
    if (previous) continue; seen.set(ref.id, ref);
    const observation = parseContract(ComputerObservationRecordSchema, await readComputerOriginal(ref, read));
    if (observation.workId !== checkpoint.workId || observation.attemptId !== checkpoint.attemptId ||
      observation.goalRevision !== checkpoint.goalRevision || observation.scope !== checkpoint.scope ||
      observation.policyDigest !== checkpoint.policyDigest || observation.lifecycleGeneration !== checkpoint.lifecycleGeneration ||
      observation.driver.id !== checkpoint.driver.id || observation.driver.version !== checkpoint.driver.version ||
      observation.view.sessionId !== checkpoint.sessionId || observation.view.epoch !== checkpoint.epoch)
      throw new Error('context_continuation_source_unavailable');
  }
}

/** Read the canonical parent graph to retain artifact references, never its action or response bodies. */
export async function computerContinuationOriginalRefs(state: WorkState, read: (ref: ArtifactRef) => Promise<Uint8Array>): Promise<ArtifactRef[]> {
  const refs = new Map<string, ArtifactRef>();
  const add = (ref: ArtifactRef) => {
    if (!visibleArtifact(state, ref)) throw new Error('context_continuation_source_unavailable');
    const prior = refs.get(ref.id); if (prior && !sameReference(prior, ref)) throw new Error('context_continuation_reference_conflict');
    refs.set(ref.id, reference(ref));
  };
  const originals = new Map<string, Promise<unknown>>();
  const original = (ref: ArtifactRef): Promise<unknown> => {
    add(ref); let value = originals.get(ref.id);
    if (!value) { value = readComputerOriginal(ref, read); originals.set(ref.id, value); }
    return value;
  };
  computerContinuationRefs(state).forEach(add);
  const attempts = new Map<string, { head: ArtifactRef; result: ArtifactRef | null }>();
  for (const claim of computerContinuationContext(state)) {
    attempts.set(claim.sourceAttemptId, { head: claim.sourceHead, result: claim.sourceResultArtifact });
    const successor = state.attempts.find(attempt => attempt.id === claim.successorAttemptId);
    if (successor?.computerUse) attempts.set(successor.id, { head: successor.computerUse.head, result: successor.resultArtifact });
  }
  for (const [attemptId, refs] of attempts) {
    const checkpoint = parseContract(ComputerCheckpointSchema, await original(refs.head));
    if (checkpoint.workId !== state.id || checkpoint.attemptId !== attemptId) throw new Error('context_continuation_source_unavailable');
    checkpointObservationRefs(checkpoint).forEach(add);
    if (checkpoint.schemaVersion === 2) {
      checkpointLineageRefs(state, checkpoint).forEach(add);
      await verifyCheckpointV2References(state, checkpoint, read);
    }
    if (refs.result) {
      const result = parseContract(ToolResultSchema, await original(refs.result));
      if (result.attemptId !== attemptId) throw new Error('context_continuation_source_unavailable');
      [...result.artifacts, ...result.evidence.flatMap(evidence => evidence.artifact ? [evidence.artifact] : [])].forEach(add);
    }
  }
  return [...refs.values()];
}

export function computerReconciliationRefs(record: ComputerReconciliation): ArtifactRef[] {
  return [record.sourceHead, record.sourceResultArtifact, record.requestArtifact, record.responseArtifact, record.proofArtifact]
    .filter((ref): ref is ArtifactRef => ref !== null);
}

/** Keeps historical lookup metadata without copying action or response bodies into a model or resume packet. */
export function computerReconciliationContext(state: WorkState): ComputerReconciliation[] {
  return (state.computerReconciliations ?? []).filter(record => record.generation === dataGeneration(state) &&
    computerReconciliationRefs(record).every(ref => visibleArtifact(state, ref))).map(record => ({
    id: record.id, sourceAttemptId: record.sourceAttemptId, obligationId: record.obligationId,
    sourceHead: reference(record.sourceHead), sourceResultArtifact: record.sourceResultArtifact && reference(record.sourceResultArtifact),
    requestArtifact: reference(record.requestArtifact), responseArtifact: record.responseArtifact && reference(record.responseArtifact),
    proofArtifact: record.proofArtifact && reference(record.proofArtifact), operationId: record.operationId, stepIndex: record.stepIndex,
    goalRevision: record.goalRevision, policyDigest: record.policyDigest, generation: record.generation,
    contractDigest: record.contractDigest, driver: { id: record.driver.id, version: record.driver.version },
    owner: record.owner, leaseUntil: record.leaseUntil, createdAt: record.createdAt, dispatchedAt: record.dispatchedAt,
    finishedAt: record.finishedAt, status: record.status,
    execution: { mode: record.execution.mode, implementationCalls: record.execution.implementationCalls,
      usage: { transportCalls: record.execution.usage.transportCalls, internalOperations: record.execution.usage.internalOperations,
        imageBytes: record.execution.usage.imageBytes, waitMs: record.execution.usage.waitMs } },
    reason: record.reason, outcome: record.outcome, effectState: record.effectState,
  }));
}

/** A pending input remains an obligation even if its task is no longer on the current plan. */
export function mandatoryComputerAttempt(state: WorkState, attempt: Attempt): boolean {
  return Boolean(attempt.computerUse && visibleComputerProgress(state, attempt.computerUse) &&
    (attempt.computerUse.phase === 'running' || attempt.computerUse.phase === 'unknown' || attempt.effectState === 'unknown'));
}

/** Verifies a stored diagnostic head, not current UI state, action authorization or completion evidence. */
export async function verifyComputerContextHead(state: WorkState, attempt: Attempt,
  services: Pick<RuntimeServices, 'artifacts' | 'digester'>): Promise<void> {
  const progress = attempt.computerUse;
  if (!progress || !visibleComputerProgress(state, progress)) throw new Error('context_computer_source_unavailable');
  const digest = (value: unknown) => services.digester.digest(asJson(value));
  const head = progress.head;
  if (head.mediaType !== 'application/json' || head.byteLength > 262144 ||
    !state.artifacts.some(ref => digest(ref) === digest(head))) throw new Error('context_computer_source_unavailable');
  const bytes = await services.artifacts.get(head, state.policy);
  if (bytes.byteLength !== head.byteLength) throw new Error('context_computer_source_unavailable');
  const checkpoint = parseContract(ComputerCheckpointSchema, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  if (checkpoint.workId !== state.id || checkpoint.attemptId !== attempt.id || checkpoint.goalRevision !== attempt.goalRevision ||
    checkpoint.scope !== attempt.scope || checkpoint.taskDigest !== attempt.inputDigest || checkpoint.contractDigest !== attempt.contractDigest ||
    checkpoint.lifecycleGeneration > dataGeneration(state) || checkpoint.phase !== progress.phase ||
    checkpoint.steps.filter(step => step.verified).length !== progress.completedSteps ||
    (checkpoint.steps.find(step => step.status === 'intent' || step.status === 'unknown')?.operationId ?? null) !== progress.pendingOperationId)
    throw new Error('context_computer_source_unavailable');
  if (checkpoint.schemaVersion === 2) await verifyCheckpointV2References(state, checkpoint, ref => services.artifacts.get(ref, state.policy));
}

export function buildContextPacket(state: WorkState, tools: ToolContracts): ContextPacket {
  const evidence = accessibleEvidence(state.evidence, state.policy, state.goal.scope);
  const known = new Set(evidence.map(e => e.id));
  const historical = historicalEvidence(state.evidence, state.policy, state.goal.scope);
  const historicalIds = new Set(historical.map(e => e.id));
  const referenced = new Set(state.hypotheses.flatMap(h => [...h.supportIds, ...h.counterIds]));
  if ([...referenced].some(id => !historicalIds.has(id))) throw new Error('hypothesis_context_permission_changed');
  if (state.hypothesisAssessment?.evidenceIds.some(id => !historicalIds.has(id))) throw new Error('assessment_context_permission_changed');
  for (const id of state.hypothesisAssessment?.evidenceIds ?? []) referenced.add(id);
  const readCollections = readCollectionContext(state);
  const visibleTips = new Set(readCollections.map(t => t.attemptId));
  const attempts = state.attempts.filter(a => a.goalRevision === state.goal.revision && a.scope === state.goal.scope || mandatoryComputerAttempt(state, a) || a.effectReceipt)
    .map(({ knowledgeDependencies: _dependencies, inputDependencies: _dependenciesInputs, readProgress, computerUse, ...a }) => ({ ...a,
      ...(readProgress && visibleTips.has(a.id) ? { readProgress } : {}),
      ...(computerUse && visibleComputerProgress(state, computerUse) ? { computerUse } : {}),
      ...(a.resultArtifact && artifactBlocked(state, a.resultArtifact) ? { resultArtifact: null } : {}) }));
  if (attempts.some(a => a.resultArtifact && (a.resultArtifact.tenantId !== state.policy.tenantId || a.resultArtifact.labels.some(l => !state.policy.allowedLabels.includes(l))))) throw new Error('attempt_context_permission_changed');
  return parseContract(ContextPacketSchema, { schemaVersion: 1, workId: state.id, stateRevision: state.revision, goal: state.goal, policy: state.policy, plan: state.plan,
    ...(state.notifications === undefined ? {} : { notifications: state.notifications }),
    ...(state.disclosureLabels ? { disclosureLabels: state.disclosureLabels } : {}),
    ...(state.attempts.some(a => a.readProgress) ? { readCollections } : {}),
    ...(state.computerReconciliations === undefined ? {} : { computerReconciliations: computerReconciliationContext(state) }),
    ...(state.computerContinuations === undefined ? {} : { computerContinuations: computerContinuationContext(state) }),
    hypotheses: state.hypotheses, obligations: state.obligations, evidence: [...evidence, ...historical.filter(e => referenced.has(e.id) && !known.has(e.id))]
      .map(e => e.artifact && artifactBlocked(state, e.artifact) ? { ...e, artifact: null } : e),
    activeToolIds: tools.visible(state.policy).map(t => t.id), purpose: hypothesesRequireReview(state) ? 'assess' : state.goal.responseRequirement ? 'respond' : 'plan',
    execution: { budget: state.budget, deadlineAt: state.deadlineAt, attempts, hypothesisAssessment: state.hypothesisAssessment,
      control: executionControl(state), ...(state.progress ? { progress: progressSummary(state) } : {}),
      ...(state.budgetParent || state.budgetGrants?.length ? { delegation: budgetSummary(state) } : {}) },
    planningFeedback: state.modelCalls.filter(c => c.goalRevision === state.goal.revision && c.status === 'rejected').slice(-3).map(c => ({ callId: c.id, reason: c.reason })) });
}

export async function buildModelContextPacket(state: WorkState, tools: ToolContracts, services: Pick<RuntimeServices, 'state' | 'artifacts' | 'knowledge' | 'effects' | 'obligations' | 'notifications' | 'inputs' | 'sessions'>): Promise<ContextPacket> {
  if (!(await knowledgeInputsCurrent(services, state))) throw new Error('knowledge_dependency_changed');
  if (requiresEffectProofs(state) && !(await effectProofsCurrent(services, state))) throw new Error('context_effect_proof_changed');
  const session = await readSessionContext(services, state);
  const packet = { ...buildContextPacket(state, tools), ...(session ? { session } : {}) };
  const candidates = state.attempts.filter(a => !a.readProgress && a.adopted && a.scope === state.goal.scope && a.knowledgeDependencies?.length && a.resultArtifact && !artifactBlocked(state, a.resultArtifact));
  const entries: NonNullable<ContextPacket['retrievedKnowledge']>['entries'] = [];
  let remaining = 16384;
  for (const attempt of candidates.slice(-8).reverse()) {
    const result = parseContract(ToolResultSchema, JSON.parse(new TextDecoder().decode(await services.artifacts.get(attempt.resultArtifact!, state.policy))));
    if (result.attemptId !== attempt.id || result.resultId !== attempt.resultId) throw new Error('invocation_identity_mismatch');
    const entry = { attemptId: attempt.id, toolId: attempt.toolId, output: result.output };
    const size = new TextEncoder().encode(JSON.stringify(entry)).byteLength;
    if (size <= remaining) { entries.push(entry); remaining -= size; }
  }
  if (!(await sessionContextCurrent(services, state, packet.session)) || !(await knowledgeInputsCurrent(services, state)) ||
    requiresEffectProofs(state) && !(await effectProofsCurrent(services, state)) ||
    (await services.state.get(state.id))?.revision !== state.revision) throw new Error('model_reservation_stale');
  if (!candidates.length) return packet;
  return parseContract(ContextPacketSchema, { ...packet, retrievedKnowledge: { entries, omitted: candidates.length - entries.length,
    interpretation: 'prior_observations_not_fresh_evidence' } });
}
