import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { ComputerReconciliation } from '../domain/computer-reconciliation.js';
import type { ArtifactRef, TaskSpec, WorkState } from '../domain/model.js';
import type { ArtifactStore, Tool } from '../application/ports.js';
import type { RuntimeServices } from '../application/services.js';
import { effectProofsCurrent, refreshEffectProofs } from '../application/effect-proofs.js';
import { executionActive, prepareExecutionBoundary, requestExecutionMode } from '../application/execution-control.js';
import { DataLifecycleService } from '../application/data-lifecycle.js';
import { ConversationService } from '../application/conversation-service.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { PlanningRuntime } from '../application/planning-runtime.js';
import { ContextCompiler } from '../application/context-compiler.js';
import { ContextFrameSchema } from '../application/context-contracts.js';
import { buildContextPacket } from '../application/context-packet.js';
import { toolExecution, summarizeToolExecution } from '../application/tool-execution-usage.js';
import { ToolBroker } from '../application/tool-broker.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { asJson } from '../application/plan-validator.js';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { FakeClock, FakeSink, ScriptedPlanner, SequenceIds } from '../infrastructure/fakes.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { advance, attempt, command, initial, modelCall } from './state-conformance-helpers.js';

const actor = { tenantId: 'tenant-a', principalId: 'person-a' };
const task: TaskSpec = { id: 'fresh-read', description: 'Read a synthetic record', toolId: 'fixture.read', toolVersion: '1', input: {},
  effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: ['criterion'] };
const usage = { transportCalls: 1, internalOperations: 2, imageBytes: 0, waitMs: 0 };

async function fixture(t: TestContext, phase: ComputerReconciliation['status'] | 'none' = 'settled') {
  const state = new MemoryStateRepository(); t.after(() => state.close());
  const artifacts = new MemoryArtifactStore(); const clock = new FakeClock(1100); const digester = new Sha256Digester();
  const refs = new Map<string, ArtifactRef>();
  for (const id of ['head', 'request', 'response', 'proof', 'model-input']) refs.set(id, await artifacts.put(
    new TextEncoder().encode(JSON.stringify({ synthetic: id })), { tenantId: actor.tenantId, labels: ['synthetic'], mediaType: 'application/json' }));
  let toolCalls = 0; let current = true; let checks = 0; let refreshes = 0;
  const tool: Tool = { definition: { provider: 'fixture', id: 'fixture.read', version: '1', description: 'Synthetic read', effect: 'read',
    destination: 'local', labels: ['synthetic'], inputSchema: { type: 'object' }, outputSchema: { type: 'object' } },
    async execute(_task, context) { toolCalls++; return { resultId: `${context.attemptId}:result`, attemptId: context.attemptId,
      status: 'success', effectState: 'none', evidence: [], artifacts: [], output: {}, error: null, cursor: null, coverage: 'complete', usage }; } };
  const planner = new ScriptedPlanner([packet => ({ status: 'ok', provider: 'scripted', model: 'fixture', inputTokens: 12, outputTokens: 5,
    proposal: { baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision, basePlanRevision: packet.plan?.revision ?? 0,
      reason: 'Synthetic model boundary proposal', tasks: [task], hypotheses: [] } })]);
  const services: RuntimeServices = { state, artifacts, clock, digester, planner, ids: new SequenceIds(), sink: new FakeSink(), tools: [tool],
    effects: { current: async () => { checks++; return current; }, refresh: async workId => { refreshes++; return (await state.get(workId))!; } } };
  const contracts = new ToolContracts([tool], new AjvSchemas()); const runtime = new ExecutionRuntime(services, contracts, 'worker');
  const work = initial(); work.budget.limits.tokens = 1000000;
  work.attempts = [{ ...attempt('unknown'), id: 'source', taskId: 'source-task', toolId: 'synthetic.ui.act', effect: 'write', effectState: 'unknown',
    contractDigest: 'c'.repeat(64), execution: toolExecution('unreported'), finishedAt: 1000,
    computerUse: { head: refs.get('head')!, phase: 'unknown', completedSteps: 0, pendingOperationId: 'original-input' } }];
  work.budget.used.toolCalls = 1; work.artifacts = [refs.get('head')!];
  work.obligations = [{ id: 'effect:source', kind: 'effect_reconciliation', reason: 'input_outcome_unknown', status: 'pending', wakeKey: null, dueAt: null }];
  assert.equal((await state.commit(command(work, 'initial'))).kind, 'committed');
  let serial = 0;
  const edit = async (change: (next: WorkState) => void, id = `fixture-${++serial}`) => {
    const next = advance((await state.get(work.id))!); change(next);
    assert.equal((await state.commit(command(next, id))).kind, 'committed'); return (await state.get(work.id))!;
  };
  if (phase !== 'none') {
    const record: ComputerReconciliation = { id: 'lookup', sourceAttemptId: 'source', obligationId: 'effect:source', sourceHead: refs.get('head')!,
      sourceResultArtifact: null, requestArtifact: refs.get('request')!, responseArtifact: null, proofArtifact: null, operationId: 'original-input', stepIndex: 0,
      goalRevision: 1, policyDigest: digester.digest(asJson(work.policy)), generation: 0, contractDigest: 'c'.repeat(64), driver: { id: 'synthetic-document-app', version: '2' },
      owner: 'lookup-worker', leaseUntil: 2000, createdAt: 1000, dispatchedAt: null, finishedAt: null, status: 'reserved', execution: toolExecution('not_invoked'),
      reason: null, outcome: null, effectState: 'unknown' };
    await edit(next => { next.computerReconciliations = [record]; next.artifacts.push(record.requestArtifact); next.budget.reservedToolCalls++; });
    if (phase !== 'reserved') await edit(next => {
      const record = next.computerReconciliations![0]!; record.status = 'running'; record.dispatchedAt = 1000; record.execution = toolExecution('unreported');
      next.budget.reservedToolCalls--; next.budget.used.toolCalls++;
    });
    if (phase === 'received' || phase === 'settled') await edit(next => {
      const record = next.computerReconciliations![0]!; record.status = 'received'; record.responseArtifact = refs.get('response')!;
      record.finishedAt = 1000; record.execution = toolExecution('invoked', usage); record.outcome = 'applied';
      next.artifacts.push(record.responseArtifact);
    });
    if (phase === 'settled') await edit(next => {
      const record = next.computerReconciliations![0]!; record.status = 'settled'; record.effectState = 'confirmed'; record.proofArtifact = refs.get('proof')!;
      next.artifacts.push(record.proofArtifact); next.obligations[0]!.status = 'satisfied';
    });
  }
  const conversation = new ConversationService(services);
  const makeConversationReady = async () => {
    await edit(next => { next.evidence = [{ id: 'original-evidence', tenantId: actor.tenantId, scope: next.goal.scope, sourceId: 'fixture-original', lineageId: 'fixture-original',
      locator: 'fixture://original', observedAt: 1000, recordedAt: 1000, labels: ['synthetic'], coverage: 'complete', status: 'accepted',
      supersedes: [], derivedFrom: [], facts: { available: true }, artifact: null }]; });
    await edit(next => { next.conversation = { primaryBindingId: 'binding', completionRequiresDelivery: false, result: null,
      bindings: [{ id: 'binding', ...actor, channel: 'cli', conversationId: 'fixture-chat', destination: 'local', recipientId: actor.principalId }] }; });
  };
  const planAndDispatch = async () => {
    const before = (await state.get(work.id))!;
    await runtime.submitPlan(work.id, 'plan-read', { baseStateRevision: before.revision, baseGoalRevision: 1, basePlanRevision: 0,
      reason: 'Exercise a stored dispatch', tasks: [task], hypotheses: [] });
    const reserved = await runtime.reserve(work.id, task.id); assert.equal(await runtime.dispatch(work.id, reserved.id), true); return reserved;
  };
  return { state, services, artifacts, clock, refs, contracts, runtime, planner, conversation, edit, makeConversationReady, planAndDispatch,
    workId: work.id, toolCalls: () => toolCalls, valid: (value: boolean) => { current = value; }, checks: () => checks, refreshes: () => refreshes };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const noChecker = (f: Fixture) => { const { effects: _effects, ...services } = f.services; return services; };
function artifactsPort(f: Fixture, overrides: Partial<ArtifactStore>): ArtifactStore {
  return { put: f.artifacts.put.bind(f.artifacts), get: f.artifacts.get.bind(f.artifacts), exists: f.artifacts.exists.bind(f.artifacts), ...overrides };
}

/** Isolates model entry/adoption guards from context compilation and receipt-body authentication, tested separately. */
function planning(f: Fixture) {
  const context = new ContextCompiler(f.services, f.contracts);
  context.prepare = async (state, limits) => {
    const packet = buildContextPacket(state, f.contracts); const options = { callId: limits.callId, maxOutputTokens: limits.maxOutputTokens,
      tools: f.contracts.visible(state.policy) };
    const bytes = new TextEncoder().encode(JSON.stringify({ packet, options })).byteLength;
    const frame = ContextFrameSchema.parse({ schemaVersion: 1, kind: 'model_context', packet, tools: options.tools, decisions: [],
      basis: { workId: state.id, stateRevision: state.revision, goalRevision: state.goal.revision, planRevision: state.plan?.revision ?? 0,
        eventCursor: 1, policyDigest: f.services.digester.digest(asJson(state.policy)), dataGeneration: 0, toolsDigest: 'a'.repeat(64), knowledgeDigest: 'b'.repeat(64) },
      memo: { cycle: 1, mode: 'full', entries: [], evictions: 0, reloads: 0 }, protectedDigest: 'c'.repeat(64),
      metrics: { baselinePacketBytes: bytes, baselineToolBytes: 0, packetBytes: bytes, toolBytes: 0, envelopeBytes: bytes, requestBytes: bytes,
        estimatedTokens: 20, estimateMethod: 'synthetic_boundary', outputTokenReservation: limits.maxOutputTokens, sourceReads: 0, extraModelCalls: 0, evictions: 0, reloads: 0 } });
    const artifact = await f.services.artifacts.put(new TextEncoder().encode(JSON.stringify(frame)), { tenantId: actor.tenantId, labels: ['synthetic'], mediaType: 'application/json' });
    return { packet, options, frame, head: { artifact, basisRevision: state.revision, cycle: 1 }, estimate: { tokens: 20, bytes, method: 'synthetic_boundary' } };
  };
  context.sourcesCurrent = async () => true; context.definitionsCurrent = () => true;
  return new PlanningRuntime(f.services, f.contracts, f.runtime, 'planner', {}, context);
}

test('effect proofs: a legacy work uses neither the optional checker nor any refresh mutation', async t => {
  const f = await fixture(t, 'none'); f.valid(false); const before = (await f.state.get(f.workId))!;
  assert.equal(await effectProofsCurrent(f.services, before), true); assert.equal(f.checks(), 0);
  assert.deepEqual(await refreshEffectProofs(noChecker(f), f.workId), before);
  assert.equal(Object.hasOwn((await f.state.get(f.workId))!, 'computerReconciliations'), false);
});

test('effect proofs: settled claims require a checker and checker failures stay unavailable', async t => {
  const f = await fixture(t); const before = (await f.state.get(f.workId))!;
  assert.equal(await effectProofsCurrent({}, before), false);
  assert.equal(await effectProofsCurrent(f.services, before), true); f.valid(false);
  assert.equal(await effectProofsCurrent(f.services, before), false);
  assert.equal(await effectProofsCurrent({ effects: { current: async () => { throw new Error('unreadable proof'); } } }, before), false);
  assert.deepEqual(await refreshEffectProofs(f.services, f.workId), before); assert.equal(f.refreshes(), 1);
  assert.deepEqual(await f.state.get(f.workId), before);
});

test('effect proofs: missing checker reopens the original obligation and cancels ordinary reservations once without rewriting proof history', async t => {
  const f = await fixture(t);
  await f.edit(next => {
    next.attempts.push({ ...attempt('reserved'), id: 'unstarted-tool' }); next.budget.reservedToolCalls++;
    next.modelCalls.push({ ...modelCall('reserved'), inputArtifact: f.refs.get('model-input')! });
    next.budget.reservedModelCalls++; next.budget.reservedTokens += 11;
  });
  const before = (await f.state.get(f.workId))!; const proof = before.computerReconciliations![0]!;
  const next = await refreshEffectProofs(noChecker(f), f.workId); const invalid = next.computerReconciliations![0]!;
  assert.deepEqual(invalid, { ...proof, status: 'failed', reason: 'effect_proof_unavailable' });
  assert.deepEqual(next.attempts[0], before.attempts[0]); assert.equal(next.obligations[0]!.status, 'pending');
  assert.equal(next.attempts.find(value => value.id === 'unstarted-tool')!.status, 'cancelled'); assert.equal(next.modelCalls[0]!.status, 'cancelled');
  assert.equal(next.budget.reservedToolCalls, 0); assert.equal(next.budget.reservedModelCalls, 0); assert.equal(next.budget.reservedTokens, 0);
  assert.deepEqual(next.budget.used, before.budget.used); assert.deepEqual(next.artifacts, before.artifacts);
  const events = await f.state.events(f.workId, 0);
  assert.deepEqual(await refreshEffectProofs(noChecker(f), f.workId), next); assert.deepEqual(await f.state.events(f.workId, 0), events);
});

for (const phase of ['reserved', 'running'] as const) test(`effect proofs: expired ${phase} lookup releases only an undispatched reservation and preserves measured uncertainty`, async t => {
  const f = await fixture(t, phase); const before = (await f.state.get(f.workId))!;
  assert.equal(executionActive(before), true); assert.deepEqual(await refreshEffectProofs(noChecker(f), f.workId), before);
  await f.edit(next => requestExecutionMode(next, 'fast', 'switch after lookup', next.executionControl?.revision ?? 1));
  f.clock.advance(900); const next = await prepareExecutionBoundary(noChecker(f), f.workId); const record = next.computerReconciliations![0]!;
  assert.equal(record.status, 'failed'); assert.equal(record.finishedAt, 2000); assert.equal(record.leaseUntil, 2000);
  assert.equal(next.budget.reservedToolCalls, 0); assert.equal(next.budget.used.toolCalls, phase === 'running' ? 2 : 1);
  assert.deepEqual(record.execution, before.computerReconciliations![0]!.execution); assert.equal(record.outcome, null); assert.equal(record.effectState, 'unknown');
  assert.equal(executionActive(next), false); assert.equal(next.executionControl!.requestedMode, 'fast');
  assert.equal(next.obligations[0]!.status, 'pending');
  assert.equal(summarizeToolExecution(next).unknownInvocations, phase === 'running' ? 2 : 1);
});

test('effect proofs: lifecycle deletion reopens a settled effect and quarantines all linked references without changing received facts or timestamps', async t => {
  const f = await fixture(t); await f.makeConversationReady(); const before = (await f.state.get(f.workId))!; const proof = before.computerReconciliations![0]!;
  await new DataLifecycleService(f.services).change(f.workId, actor, 'delete-source', { action: 'delete', evidenceIds: ['original-evidence'],
    expectedGeneration: 0, reason: 'Synthetic lifecycle transition', replacement: null });
  const next = (await f.state.get(f.workId))!; const invalid = next.computerReconciliations![0]!;
  assert.deepEqual(invalid, { ...proof, status: 'failed', reason: 'data_lifecycle_changed' });
  assert.equal(next.obligations.find(value => value.id === proof.obligationId)!.status, 'pending');
  for (const ref of [proof.sourceHead, proof.requestArtifact, proof.responseArtifact!, proof.proofArtifact!]) assert.ok(next.dataLifecycle!.blockedArtifactIds.includes(ref.id));
  assert.deepEqual(summarizeToolExecution(next), summarizeToolExecution(before)); assert.equal(next.dataLifecycle!.generation, 1);
});

for (const mode of ['missing', 'invalid', 'valid'] as const) test(`effect proofs: a committed tool dispatch with ${mode} proof authority cannot silently bypass the broker`, async t => {
  const f = await fixture(t); const dispatched = await f.planAndDispatch(); const before = (await f.state.get(f.workId))!;
  f.valid(mode === 'valid'); const broker = new ToolBroker(f.state, f.contracts, f.services.digester, f.clock, undefined,
    mode === 'missing' ? undefined : f.services.effects);
  const invoke = broker.invoke(f.workId, dispatched.id, f.runtime.owner, new AbortController().signal);
  if (mode === 'valid') { assert.equal((await invoke).status, 'success'); assert.equal(f.toolCalls(), 1); }
  else { await assert.rejects(invoke, /broker_effect_proof_changed/); assert.equal(f.toolCalls(), 0); }
  assert.deepEqual(await f.state.get(f.workId), before);
});

test('effect proofs: a reuse await that loses proof validity is checked before implementation entry', async t => {
  const f = await fixture(t); const dispatched = await f.planAndDispatch(); let reused = 0; let entered = 0;
  const broker = new ToolBroker(f.state, f.contracts, f.services.digester, f.clock, undefined, f.services.effects);
  await assert.rejects(broker.invoke(f.workId, dispatched.id, f.runtime.owner, new AbortController().signal,
    { reuse: async () => { await f.state.get(f.workId); f.valid(false); reused++; return null; }, entered: () => { entered++; } }), /broker_effect_proof_changed/);
  assert.equal(reused, 1); assert.equal(entered, 0); assert.equal(f.toolCalls(), 0);
});

test('effect proofs: invalid proof prevents new model reservation before compiling input', async t => {
  const f = await fixture(t); f.valid(false); const model = planning(f); const before = (await f.state.get(f.workId))!;
  await assert.rejects(model.reserve(f.workId), /model_reservation_stale/);
  assert.deepEqual(await f.state.get(f.workId), before); assert.equal(f.planner.inputs.length, 0); assert.ok(f.checks() > 0);
});

test('effect proofs: losing proof during model input read prevents actual planner entry and still settles the dispatched call', async t => {
  const f = await fixture(t); const model = planning(f); const call = await model.reserve(f.workId); let fired = false;
  f.services.artifacts = artifactsPort(f, { get: async (ref, policy) => {
    const bytes = await f.artifacts.get(ref, policy); if (ref.id === call.inputArtifact.id) { fired = true; f.valid(false); } return bytes;
  } });
  await model.execute(f.workId, call.id); assert.equal(fired, true); assert.equal(f.planner.inputs.length, 0);
  const next = (await f.state.get(f.workId))!; assert.equal(next.modelCalls[0]!.status, 'received');
  assert.equal(next.modelCalls[0]!.outcome, 'error'); assert.equal(next.budget.used.modelCalls, 1); assert.equal(next.budget.used.tokens, 0);
  assert.equal(next.budget.reservedModelCalls, 0); assert.equal(next.budget.reservedTokens, 0); assert.equal(await model.adopt(f.workId, call.id), false);
});

test('effect proofs: loss during adoption artifact checks rejects a stored model proposal while preserving usage', async t => {
  const f = await fixture(t); const model = planning(f); const call = await model.reserve(f.workId); await model.execute(f.workId, call.id);
  const received = (await f.state.get(f.workId))!.modelCalls[0]!; assert.equal(received.status, 'received'); let fired = false;
  f.services.artifacts = artifactsPort(f, { exists: async ref => {
    const exists = await f.artifacts.exists(ref); if (!fired && ref.id === received.replyArtifact!.id) { fired = true; f.valid(false); } return exists;
  } });
  assert.equal(await model.adopt(f.workId, call.id), false); assert.equal(fired, true);
  const next = (await f.state.get(f.workId))!; assert.equal(next.plan, null); assert.equal(next.modelCalls[0]!.status, 'rejected');
  assert.equal(next.budget.used.tokens, 17); assert.equal(next.budget.used.modelCalls, 1); assert.equal(f.planner.inputs.length, 1); assert.equal(f.toolCalls(), 0);
});

test('effect proofs: a valid checker permits one model invocation and adoption with the historical proof unchanged', async t => {
  const f = await fixture(t); const before = (await f.state.get(f.workId))!.computerReconciliations; const model = planning(f);
  const call = await model.reserve(f.workId); await model.execute(f.workId, call.id); assert.equal(await model.adopt(f.workId, call.id), true);
  const next = (await f.state.get(f.workId))!; assert.equal(f.planner.inputs.length, 1); assert.equal(next.plan!.tasks[0]!.id, task.id);
  assert.deepEqual(next.computerReconciliations, before); assert.equal(next.budget.used.tokens, 17); assert.equal(f.toolCalls(), 0);
});

test('effect proofs: proof loss during result body storage prevents response publication', async t => {
  const f = await fixture(t); await f.makeConversationReady(); const before = (await f.state.get(f.workId))!; let fired = false;
  f.services.artifacts = artifactsPort(f, { put: async (bytes, attributes) => {
    const ref = await f.artifacts.put(bytes, attributes); if (attributes.mediaType === 'text/plain') { fired = true; f.valid(false); } return ref;
  } });
  await assert.rejects(f.conversation.prepare(f.workId, actor), /response_state_changed/); assert.equal(fired, true);
  assert.deepEqual(await f.state.get(f.workId), before); assert.deepEqual(await f.state.deliveries(f.workId), []);
});

test('effect proofs: a same-revision snapshot suppresses an existing result when its proof becomes unavailable during the read', async t => {
  const f = await fixture(t); await f.makeConversationReady(); const prepared = await f.conversation.prepare(f.workId, actor); assert.equal(prepared?.kind, 'result');
  const before = (await f.state.get(f.workId))!; assert.equal((await f.conversation.snapshot(f.workId, actor)).resultReady, true); let fired = false;
  f.services.artifacts = artifactsPort(f, { exists: async ref => {
    const exists = await f.artifacts.exists(ref); if (ref.id === before.conversation!.result!.artifact.id) { fired = true; f.valid(false); } return exists;
  } });
  const snapshot = await f.conversation.snapshot(f.workId, actor); assert.equal(fired, true);
  assert.equal(snapshot.analysisReady, false); assert.equal(snapshot.resultReady, false); assert.deepEqual(await f.state.get(f.workId), before);
});
