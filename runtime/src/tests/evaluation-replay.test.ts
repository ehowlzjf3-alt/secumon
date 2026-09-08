import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactRef, WorkState } from '../domain/model.js';
import type { EvaluationPins, EvaluationReplayBundle, EvaluationSample } from '../domain/execution-evaluation.js';
import type { ArtifactStore, StateRepository } from '../application/ports.js';
import type { WorkActor } from '../application/work-resources.js';
import { replayEvaluation } from '../application/evaluation-replay.js';
import { scoreEvaluation } from '../application/execution-evaluation.js';
import { asJson } from '../application/plan-validator.js';
import { ContextRecovery } from '../application/context-recovery.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { adapters, advance, command, initial, modelCall, openRepository, type Adapter } from './state-conformance-helpers.js';

const actor: WorkActor = { tenantId: 'tenant-a', principalId: 'person-a' };
const basePins: Omit<EvaluationPins, 'caseDefinition'> = { suite: 'synthetic-replay-1', fixture: 'original-v1', code: 'local-code-v1', configuration: 'local-policy-v1', environment: { synthetic: true, node: '24', backendContract: '1' } };
type StoreHook = (operation: 'get' | 'events' | 'deliveries' | 'receipt', commandId?: string) => Promise<void>;
const responseExpected = '회의는 오후 세 시에 시작합니다.';
const responseHash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

async function fixture(adapter: Adapter, responseText?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'evaluation-replay-'));
  let repository = openRepository(adapter, directory);
  const artifacts = new FileArtifactStore(join(directory, 'artifacts'));
  const digester = new Sha256Digester();
  const digest = (value: unknown) => digester.digest(asJson(value));
  const specification: EvaluationSample['case'] = { id: `${adapter}-synthetic`, family: 'document_comparison', fixtureId: 'synthetic', backend: adapter, mode: 'auto', variant: 'simple',
    oracle: { expectedFinal: 'complete', completionEligible: true, requiredEvidenceIds: ['source'], originals: [{ id: 'source', sourceId: 'original', lineageId: 'original-lineage', observedAt: 1000 }],
      facts: { available: true }, finalHypothesis: null, forbiddenEvidenceIds: [], noCompletionBefore: null,
      ...(responseText !== undefined ? { response: { kind: 'exact_text' as const, text: responseExpected, sha256: responseHash(responseExpected) } } : {}) } };
  const pins: EvaluationPins = { ...structuredClone(basePins), caseDefinition: digest(specification) };
  const ref = await artifacts.put(new TextEncoder().encode('SYNTHETIC_ORIGINAL_BODY'), { tenantId: actor.tenantId, labels: ['synthetic'], mediaType: 'text/plain' });
  const past = await artifacts.put(new TextEncoder().encode('HISTORICAL_ORIGINAL_BODY'), { tenantId: actor.tenantId, labels: ['synthetic'], mediaType: 'text/plain' });
  const states: WorkState[] = [];
  const save = async (state: WorkState, commandId: string) => {
    const result = await repository.commit(command(state, commandId));
    assert.equal(result.kind, 'committed');
    const saved = (await repository.get(state.id))!; states.push(saved); return saved;
  };
  const start = initial('replay-work');
  if (responseText !== undefined) {
    start.goal.criteria = [];
    start.goal.responseRequirement = { version: 1, requestMessageId: 'response-request', requestTextDigest: responseHash('회의 시간을 알려주세요.'), format: 'text' };
    const scope = { tenantId: actor.tenantId, principalId: actor.principalId, agentId: 'replay-response-agent', sessionId: 'replay-response-session' };
    start.conversation = { bindings: [{ id: 'response-binding', tenantId: actor.tenantId, principalId: actor.principalId,
      channel: 'test', conversationId: 'replay-response', recipientId: actor.principalId, destination: 'local', session: scope }],
      primaryBindingId: 'response-binding', completionRequiresDelivery: false, result: null,
      session: { scope,
        input: { messageId: 'response-request', sequence: 1, digest: responseHash('applied-request') } }, sessionReviewRequired: false };
  }
  const first = await save(start, 'created');
  const middle = advance(first); middle.artifacts = [ref, past];
  middle.evidence = [{ id: 'source', tenantId: actor.tenantId, scope: 'fixture', sourceId: 'original', lineageId: 'original-lineage', locator: 'synthetic:original',
    observedAt: 1000, recordedAt: 1001, labels: ['synthetic'], coverage: 'complete', status: 'accepted', supersedes: [], derivedFrom: [],
    facts: { available: true }, artifact: ref }];
  const second = await save(middle, 'evidence');
  const final = advance(second); final.artifacts = [ref]; final.status = 'completed'; final.statusReason = 'verified';
  const responseRefs: ArtifactRef[] = [];
  if (responseText !== undefined) {
    // Recorded receipt fixture only: the actual generic model loop is covered by the separate paired-profile trial.
    const put = (text: string, mediaType: string) => artifacts.put(new TextEncoder().encode(text), { tenantId: actor.tenantId, labels: ['synthetic'], mediaType });
    const answer = await put(responseText, 'text/plain'), input = await put('{"kind":"recorded-model-input"}', 'application/json');
    const reply = await put(JSON.stringify({ kind: 'recorded-model-answer', text: responseText }), 'application/json');
    responseRefs.push(answer, input, reply); final.artifacts.push(...responseRefs);
    const call = { ...modelCall('accepted'), purpose: 'agent_turn' as const, semanticVersion: 4 as const,
      inputArtifact: input, replyArtifact: reply, agentTurnPromptDigest: responseHash('prompt'), finishedAt: final.updatedAt,
      outcome: 'ok' as const, reason: 'agent_answer_stored', usageStatus: 'reported' as const, inputTokens: 1, outputTokens: 2 };
    final.modelCalls = [call]; final.budget.used.modelCalls = 1; final.budget.used.tokens = 3;
    final.generatedAnswer = { id: 'recorded-answer', callId: call.id, goalRevision: final.goal.revision, planRevision: 0, dataGeneration: 0,
      input: structuredClone(final.conversation!.session!), inputArtifact: input, promptDigest: call.agentTurnPromptDigest,
      basisDigest: responseHash('recorded-answer-basis'), artifact: answer, evidenceIds: ['source'], observedEvidenceIds: ['source'],
      assessment: { type: 'model_self_review', verdict: 'satisfied', rationale: 'Recorded claim, not independent fixture truth.', missing: [], counterarguments: [] }, createdAt: final.updatedAt };
  }
  await save(final, 'completed');
  const checkpoint = responseText === undefined ? await new ContextRecovery({ state: repository, artifacts, digester, clock: { now: () => states.at(-1)!.updatedAt } }, new ToolContracts([], new AjvSchemas())).restore(first.id, actor) : null;

  const makeBundle = async (checkpointRef: ArtifactRef | null = checkpoint?.artifact ?? null): Promise<EvaluationReplayBundle> => {
    const current = (await repository.get(first.id))!;
    const events = await repository.events(first.id, 0); const deliveries = await repository.deliveries(first.id);
    const sample: EvaluationSample = { case: structuredClone(specification),
      observations: states.map(state => ({ at: state.updatedAt, stage: 'committed', state: structuredClone(state),
        eventTypes: events.filter(event => event.revision === state.revision).map(event => event.type), deliveries: [],
        ...(state.generatedAnswer && responseText !== undefined ? { response: { artifact: structuredClone(state.generatedAnswer.artifact), text: responseText } } : {}) })),
      entries: [], finalControl: 'complete', startedAt: first.createdAt, finishedAt: current.updatedAt, wallElapsedMs: 1, runError: null };
    const score = scoreEvaluation(sample);
    const receipts: EvaluationReplayBundle['receipts'] = [];
    for (const commandId of new Set(events.map(event => event.commandId))) {
      const receipt = (await repository.receipt(first.id, commandId))!;
      receipts.push({ commandId, digest: receipt.digest, stateRevision: receipt.state.revision, stateDigest: digest(receipt.state) });
    }
    return { version: 1, workId: first.id, pins: structuredClone(pins), sample, sampleDigest: digest(sample), score, scoreDigest: digest(score),
      finalStateDigest: digest(current), eventsDigest: digest(events), deliveriesDigest: digest(deliveries), receipts,
      artifacts: [ref, past, ...responseRefs, ...(checkpointRef ? [checkpointRef] : [])], checkpoint: checkpointRef };
  };
  let storeHook: StoreHook | null = null;
  let artifactHook: ((ref: ArtifactRef) => Promise<void>) | null = null;
  let receiptEdit: ((id: string, receipt: Awaited<ReturnType<StateRepository['receipt']>>) => Awaited<ReturnType<StateRepository['receipt']>>) | null = null;
  const counts = { commit: 0, put: 0, exists: 0, model: 0, tool: 0, send: 0, lookup: 0 };
  const writesForbidden = (key: 'commit' | 'put' | 'model' | 'tool' | 'send' | 'lookup'): never => { counts[key]++; throw new Error(`replay_called_${key}`); };
  const readonlyState: StateRepository = {
    async get(id) { const value = await repository.get(id); await storeHook?.('get'); return value; },
    async events(id, cursor) { const value = await repository.events(id, cursor); await storeHook?.('events'); return value; },
    async deliveries(id) { const value = await repository.deliveries(id); await storeHook?.('deliveries'); return value; },
    async receipt(id, commandId) { const value = await repository.receipt(id, commandId); await storeHook?.('receipt', commandId); return receiptEdit ? receiptEdit(commandId, value) : value; },
    async commit() { return writesForbidden('commit'); },
    recentEventMetadata: (...args) => repository.recentEventMetadata(...args), conversationWorkPage: query => repository.conversationWorkPage(query),
    workIdsForConversation: (...args) => repository.workIdsForConversation(...args), runnable: now => repository.runnable(now), close: () => repository.close(),
  };
  const readonlyArtifacts: ArtifactStore = { async put() { return writesForbidden('put'); },
    async get(value, policy) { const result = await artifacts.get(value, policy); await artifactHook?.(value); return result; },
    async exists(value) { counts.exists++; return artifacts.exists(value); } };
  const services = { state: readonlyState, artifacts: readonlyArtifacts, digester,
    planner: { propose: () => writesForbidden('model') }, tools: [{ execute: () => writesForbidden('tool') }],
    sink: { send: () => writesForbidden('send'), lookup: () => writesForbidden('lookup') } };
  const before = { state: await repository.get(first.id), events: await repository.events(first.id, 0), deliveries: await repository.deliveries(first.id) };
  return { directory, ref, past, checkpoint, states, digest, makeBundle, services, artifacts, counts, save, pins,
    state: () => repository.get(first.id), setStoreHook: (hook: StoreHook | null) => { storeHook = hook; },
    setArtifactHook: (hook: typeof artifactHook) => { artifactHook = hook; }, setReceiptEdit: (edit: typeof receiptEdit) => { receiptEdit = edit; },
    rehash: (bundle: EvaluationReplayBundle) => { bundle.sampleDigest = digest(bundle.sample); bundle.score = scoreEvaluation(bundle.sample); bundle.scoreDigest = digest(bundle.score); },
    async reopen() { await repository.close(); repository = openRepository(adapter, directory); },
    async assertUntouched() {
      assert.deepEqual(counts, { commit: 0, put: 0, exists: 0, model: 0, tool: 0, send: 0, lookup: 0 });
      assert.deepEqual({ state: await repository.get(first.id), events: await repository.events(first.id, 0), deliveries: await repository.deliveries(first.id) }, before);
    },
    async close() { await repository.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test('response replay: fixed answer and captured original survive repository reopen without model calls or writes', async () => {
  const f = await fixture('sqlite', responseExpected);
  try {
    const bundle = await f.makeBundle(); assert.equal(bundle.score.contractPassed, true, JSON.stringify(bundle.score.failures));
    assert.equal(bundle.score.goalCompleted, true); assert.equal(bundle.checkpoint, null, 'this receipt fixture does not claim session compact recovery');
    const original = structuredClone(bundle), answer = bundle.sample.observations.at(-1)!.response; assert.ok(answer);
    assert.equal(answer.text, responseExpected); assert.equal(answer.artifact.sha256, responseHash(responseExpected));
    await f.reopen();
    const result = await replayEvaluation(bundle, f.pins, actor, f.services);
    assert.equal(result.available, true, JSON.stringify(result)); assert.deepEqual(result.score, bundle.score);
    assert.equal(result.checkedReceipts, 3); assert.equal(result.checkedArtifacts, 5);
    assert.deepEqual(bundle, original); await f.assertUntouched();
  } finally { await f.close(); }
});

test('response replay: authentic wrong answers remain failures while altered text, references and oracle hashes cannot replace originals', async () => {
  const wrongText = '회의는 오후 네 시에 시작합니다.', f = await fixture('sqlite', wrongText);
  try {
    const bundle = await f.makeBundle();
    assert.equal(bundle.score.contractPassed, false); assert.equal(bundle.score.goalCompleted, false);
    assert.ok(bundle.score.failures.some(value => value.includes('response_original_invalid')));
    assert.equal(bundle.sample.observations.at(-1)!.state.generatedAnswer!.assessment.verdict, 'satisfied');
    const result = await replayEvaluation(bundle, f.pins, actor, f.services);
    assert.equal(result.available, true, JSON.stringify(result)); assert.deepEqual(result.score, bundle.score, 'replay authenticates a failed trial without converting it to success');
    const altered = structuredClone(bundle); altered.sample.observations.at(-1)!.response!.text = responseExpected; f.rehash(altered);
    assert.equal(Buffer.byteLength(wrongText), Buffer.byteLength(responseExpected));
    assert.deepEqual((await replayEvaluation(altered, f.pins, actor, f.services)).failures, ['replay_response_original_changed']);
    const wrongRef = structuredClone(bundle); wrongRef.sample.observations.at(-1)!.response!.artifact = structuredClone(f.past); f.rehash(wrongRef);
    assert.deepEqual((await replayEvaluation(wrongRef, f.pins, actor, f.services)).failures, ['replay_response_original_changed']);
    const wrongOracle = structuredClone(bundle); wrongOracle.sample.case.oracle.response!.sha256 = '0'.repeat(64);
    wrongOracle.pins.caseDefinition = f.digest(wrongOracle.sample.case); f.rehash(wrongOracle);
    assert.deepEqual((await replayEvaluation(wrongOracle, wrongOracle.pins, actor, f.services)).failures, ['replay_response_oracle_invalid']);
    const unknownField = structuredClone(bundle);
    Object.assign(unknownField.sample.observations.at(-1)!.response!, { reviewed: true }); f.rehash(unknownField);
    assert.deepEqual((await replayEvaluation(unknownField, f.pins, actor, f.services)).failures, ['replay_invalid_or_unavailable']);
    await f.assertUntouched();
  } finally { await f.close(); }
});

for (const adapter of adapters) {
  test(`${adapter}: readonly evaluation replay authenticates full receipt history, old originals and the current resume packet after reopen`, async () => {
    const f = await fixture(adapter);
    try {
      const bundle = await f.makeBundle(); assert.equal(bundle.score.contractPassed, true);
      await f.reopen();
      const result = await replayEvaluation(bundle, f.pins, actor, f.services);
      assert.equal(result.available, true, JSON.stringify(result)); assert.deepEqual(result.score, bundle.score);
      assert.equal(result.checkedReceipts, 3); assert.equal(result.checkedArtifacts, 3);
      assert.equal((await replayEvaluation(await f.makeBundle(null), f.pins, actor, f.services)).available, true);
      await f.assertUntouched();
    } finally { await f.close(); }
  });

  test(`${adapter}: version, pins and independently recomputed score are required without writes`, async () => {
    const f = await fixture(adapter);
    try {
      const original = await f.makeBundle();
      const version = structuredClone(original); (version as { version: number }).version = 2;
      const badPins = structuredClone(original); badPins.pins.code = 'different-code';
      const staleSampleHash = structuredClone(original); staleSampleHash.sample.wallElapsedMs = 2;
      const staleScoreHash = structuredClone(original); staleScoreHash.score.latency.wallElapsedMs = 2;
      const inventedScore = structuredClone(original); inventedScore.score.goalCompleted = false; inventedScore.scoreDigest = f.digest(inventedScore.score);
      for (const bundle of [version, badPins, staleSampleHash, staleScoreHash, inventedScore]) {
        const result = await replayEvaluation(bundle, f.pins, actor, f.services); assert.equal(result.available, false); assert.equal(result.score, null);
      }
      await f.assertUntouched();
    } finally { await f.close(); }
  });

  test(`${adapter}: receipt omission, duplicates, absent receipts and changed stored states fail closed`, async () => {
    const f = await fixture(adapter);
    try {
      const bundle = await f.makeBundle();
      for (const receipts of [bundle.receipts.slice(1), [...bundle.receipts, bundle.receipts[0]!]]) {
        assert.equal((await replayEvaluation({ ...bundle, receipts }, f.pins, actor, f.services)).available, false);
      }
      f.setReceiptEdit((id, receipt) => id === 'evidence' ? null : receipt);
      assert.deepEqual((await replayEvaluation(bundle, f.pins, actor, f.services)).failures, ['replay_receipt_unavailable']);
      f.setReceiptEdit((id, receipt) => { if (id === 'evidence' && receipt) receipt.state.statusReason = 'changed'; return receipt; });
      assert.deepEqual((await replayEvaluation(bundle, f.pins, actor, f.services)).failures, ['replay_receipt_changed']);
      f.setReceiptEdit((id, receipt) => { if (id === 'created' && receipt) receipt.digest = 'different-command'; return receipt; });
      assert.deepEqual((await replayEvaluation(bundle, f.pins, actor, f.services)).failures, ['replay_receipt_unavailable']);
      await f.assertUntouched();
    } finally { await f.close(); }
  });

  test(`${adapter}: altered oracle and expected outcome cannot be blessed by recomputing sample and score hashes`, async () => {
    const f = await fixture(adapter);
    try {
      const altered = await f.makeBundle();
      altered.sample.case.oracle.expectedFinal = 'blocked';
      altered.sample.case.oracle.completionEligible = false;
      altered.sample.case.oracle.facts = { available: false };
      altered.sample.case.oracle.requiredEvidenceIds = [];
      altered.sample.finalControl = 'blocked';
      f.rehash(altered);
      assert.equal(altered.sampleDigest, f.digest(altered.sample));
      assert.equal(altered.scoreDigest, f.digest(scoreEvaluation(altered.sample)));
      assert.equal(altered.pins.fixture, f.pins.fixture);
      assert.deepEqual((await replayEvaluation(altered, f.pins, actor, f.services)).failures, ['replay_case_definition_mismatch']);
      altered.pins.caseDefinition = f.digest(altered.sample.case);
      assert.deepEqual((await replayEvaluation(altered, f.pins, actor, f.services)).failures, ['replay_pins_mismatch']);
      const missing = await f.makeBundle(); delete (missing.pins as Partial<EvaluationPins>).caseDefinition;
      assert.equal((await replayEvaluation(missing, f.pins, actor, f.services)).available, false);
      await f.assertUntouched();
    } finally { await f.close(); }
  });

  test(`${adapter}: rehashing an altered or dropped intermediate completion cannot bypass receipt-state binding`, async () => {
    const f = await fixture(adapter);
    try {
      const changed = await f.makeBundle(); changed.sample.observations[0]!.state.status = 'completed'; f.rehash(changed);
      assert.deepEqual((await replayEvaluation(changed, f.pins, actor, f.services)).failures, ['replay_observation_changed']);
      const dropped = await f.makeBundle(); dropped.sample.observations.splice(1, 1); f.rehash(dropped);
      assert.deepEqual((await replayEvaluation(dropped, f.pins, actor, f.services)).failures, ['replay_observations_incomplete']);
      const badEvents = await f.makeBundle(); badEvents.sample.observations[1]!.eventTypes = ['invented_completion']; f.rehash(badEvents);
      assert.deepEqual((await replayEvaluation(badEvents, f.pins, actor, f.services)).failures, ['replay_observation_events_changed']);
      await f.assertUntouched();
    } finally { await f.close(); }
  });

  test(`${adapter}: repeated readonly observations and explicit status-only measurement preserve historical receipt validation`, async () => {
    const f = await fixture(adapter);
    try {
      const repeated = await f.makeBundle(); repeated.sample.observations.push({ ...structuredClone(repeated.sample.observations.at(-1)!), stage: 'readonly', eventTypes: [] }); f.rehash(repeated);
      assert.equal((await replayEvaluation(repeated, f.pins, actor, f.services)).available, true);
      const status = await f.makeBundle(null); status.sample.case.variant = 'status_only'; status.sample.case.oracle.expectedFinal = 'unchanged'; status.sample.case.oracle.completionEligible = false;
      const baseline = { ...structuredClone(status.sample.observations.at(-1)!), stage: 'baseline', eventTypes: [] };
      status.sample.observations = [baseline, { ...structuredClone(baseline), stage: 'status' }]; status.sample.startedAt = baseline.at; status.sample.finalControl = 'unchanged'; f.rehash(status);
      const statusPins = { ...f.pins, caseDefinition: f.digest(status.sample.case) }; status.pins = structuredClone(statusPins);
      const result = await replayEvaluation(status, statusPins, actor, f.services); assert.equal(result.available, true, JSON.stringify(result)); assert.equal(result.checkedReceipts, 3);
      f.setReceiptEdit((id, receipt) => id === 'created' ? null : receipt);
      assert.equal((await replayEvaluation(status, statusPins, actor, f.services)).available, false);
      await f.assertUntouched();
    } finally { await f.close(); }
  });

  test(`${adapter}: omitted historical artifacts and conflicting refs are detected independently of the supplied list`, async () => {
    const f = await fixture(adapter);
    try {
      const omitted = await f.makeBundle(); omitted.artifacts = omitted.artifacts.filter(ref => ref.id !== f.past.id);
      assert.deepEqual((await replayEvaluation(omitted, f.pins, actor, f.services)).failures, ['replay_references_incomplete']);
      const duplicate = await f.makeBundle(); duplicate.artifacts.push(f.ref);
      assert.deepEqual((await replayEvaluation(duplicate, f.pins, actor, f.services)).failures, ['replay_references_incomplete']);
      const wrong = await f.makeBundle(); wrong.artifacts[0] = { ...f.ref, sha256: '0'.repeat(64) };
      assert.deepEqual((await replayEvaluation(wrong, f.pins, actor, f.services)).failures, ['replay_references_incomplete']);
      await f.assertUntouched();
    } finally { await f.close(); }
  });

  for (const fault of ['deleted', 'corrupt', 'historical_deleted'] as const) test(`${adapter}: ${fault} original is unavailable even with intact state, score and resume blob`, async () => {
    const f = await fixture(adapter);
    try {
      const bundle = await f.makeBundle(); const target = fault === 'historical_deleted' ? f.past : f.ref;
      const path = join(f.directory, 'artifacts', `${target.id}.blob`);
      if (fault === 'corrupt') await writeFile(path, new Uint8Array(target.byteLength)); else await rm(path);
      assert.deepEqual((await replayEvaluation(bundle, f.pins, actor, f.services)).failures, ['replay_artifact_unavailable']);
      await f.assertUntouched();
    } finally { await f.close(); }
  });

  test(`${adapter}: wrong owner and the current actor's narrower label policy cannot replay source bytes`, async () => {
    const f = await fixture(adapter);
    try {
      const bundle = await f.makeBundle();
      assert.deepEqual((await replayEvaluation(bundle, f.pins, { ...actor, principalId: 'other' }, f.services)).failures, ['replay_work_unavailable']);
      assert.deepEqual((await replayEvaluation(bundle, f.pins, { ...actor, allowedLabels: [] }, f.services)).failures, ['replay_source_unavailable']);
      await f.assertUntouched();
    } finally { await f.close(); }
  });

  test(`${adapter}: a currently indexed original cannot override a durable lifecycle tombstone`, async () => {
    const f = await fixture(adapter);
    try {
      const state = advance((await f.state())!); state.status = 'blocked';
      state.dataLifecycle = { generation: 1, blockedArtifactIds: [f.ref.id], changes: [{ id: 'delete', action: 'delete', principalId: actor.principalId,
        at: state.updatedAt, evidenceIds: ['source'], replacementId: null, reason: 'synthetic deletion', purge: 'pending_retention_review' }] };
      await f.save(state, 'delete');
      const bundle = await f.makeBundle(null); bundle.sample.case.oracle.expectedFinal = 'blocked'; bundle.sample.finalControl = 'blocked'; f.rehash(bundle);
      const deletedPins = { ...f.pins, caseDefinition: f.digest(bundle.sample.case) }; bundle.pins = structuredClone(deletedPins);
      assert.deepEqual((await replayEvaluation(bundle, deletedPins, actor, f.services)).failures, ['replay_source_unavailable']);
      assert.equal(f.counts.commit, 0); assert.equal(f.counts.put, 0);
    } finally { await f.close(); }
  });

  test(`${adapter}: foreign, body-altered and lost resume packets fail without regeneration`, async () => {
    const f = await fixture(adapter);
    try {
      assert.ok(f.checkpoint);
      for (const change of [(packet: typeof f.checkpoint.packet) => { packet.workId = 'foreign'; },
        (packet: typeof f.checkpoint.packet) => { packet.context.goal.description = 'untrusted changed goal'; },
        (packet: typeof f.checkpoint.packet) => { packet.runtime.budget.limits.tokens++; }]) {
        const packet = structuredClone(f.checkpoint.packet); change(packet);
        const altered = await f.artifacts.put(new TextEncoder().encode(JSON.stringify(packet)), { tenantId: actor.tenantId, labels: ['synthetic'], mediaType: 'application/json' });
        const bundle = await f.makeBundle(altered);
        assert.deepEqual((await replayEvaluation(bundle, f.pins, actor, f.services)).failures, ['replay_checkpoint_binding_changed']);
      }
      const bundle = await f.makeBundle(); await rm(join(f.directory, 'artifacts', `${f.checkpoint.artifact.id}.blob`));
      assert.deepEqual((await replayEvaluation(bundle, f.pins, actor, f.services)).failures, ['replay_artifact_unavailable']);
      await f.assertUntouched();
    } finally { await f.close(); }
  });

  test(`${adapter}: canonical changes during original I/O prevent a successful replay result`, async () => {
    const f = await fixture(adapter);
    try {
      const bundle = await f.makeBundle(); let fired = false;
      f.setArtifactHook(async ref => {
        if (ref.id === f.ref.id && !fired) { fired = true; const next = advance((await f.state())!); next.policy.allowedLabels = []; await f.save(next, 'revoked-during-replay'); }
      });
      const result = await replayEvaluation(bundle, f.pins, actor, f.services);
      assert.equal(fired, true); assert.equal(result.available, false); assert.equal(result.score, null);
      assert.equal(f.counts.commit, 0); assert.equal(f.counts.put, 0);
    } finally { await f.close(); }
  });

  test(`${adapter}: a receipt changed after initial validation is caught at the final read boundary`, async () => {
    const f = await fixture(adapter);
    try {
      const bundle = await f.makeBundle(); let fired = false;
      f.setArtifactHook(async ref => {
        if (ref.id === f.past.id && !fired) { fired = true; f.setReceiptEdit((id, receipt) => id === 'evidence' ? null : receipt); }
      });
      const result = await replayEvaluation(bundle, f.pins, actor, f.services);
      assert.equal(fired, true); assert.deepEqual(result.failures, ['replay_receipt_unavailable']); await f.assertUntouched();
    } finally { await f.close(); }
  });

  test(`${adapter}: caller mutation cannot replace the in-flight sample and current actor revocation is detected`, async () => {
    const f = await fixture(adapter);
    try {
      const bundle = await f.makeBundle(); let fired = false;
      // Mutate a real caller field after the verifier has pinned the input.
      f.setStoreHook(async operation => { if (operation === 'get' && !fired) { fired = true; bundle.sample.observations[0]!.state.status = 'completed'; } });
      assert.equal((await replayEvaluation(bundle, f.pins, actor, f.services)).available, true); assert.equal(fired, true);
      f.setStoreHook(null); const other = await f.makeBundle(); const mutableActor = { ...actor, allowedLabels: ['synthetic'] }; fired = false;
      f.setArtifactHook(async () => { if (!fired) { fired = true; mutableActor.allowedLabels = []; } });
      assert.deepEqual((await replayEvaluation(other, f.pins, mutableActor, f.services)).failures, ['replay_authority_changed']);
      await f.assertUntouched();
    } finally { await f.close(); }
  });
}
