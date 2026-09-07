import test from 'node:test';
import assert from 'node:assert/strict';
import type { ContextPacket, WorkState } from '../domain/model.js';
import type { SessionContext } from '../domain/session.js';
import type { ModelReply, Planner } from '../application/ports.js';
import type { RuntimeServices } from '../application/services.js';
import { ContextCompiler } from '../application/context-compiler.js';
import { ContextFrameStore } from '../application/context-store.js';
import { ContextRecovery } from '../application/context-recovery.js';
import { buildModelContextPacket } from '../application/context-packet.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { PlanningRuntime } from '../application/planning-runtime.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { asJson } from '../application/plan-validator.js';
import { transact } from '../application/work-transactions.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';
import { FakeClock, FakeSink, FixtureReadTool, ScriptedPlanner, SequenceIds } from '../infrastructure/fakes.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { command, initial } from './state-conformance-helpers.js';

const actor = { tenantId: 'tenant-a', principalId: 'person-a' };
const scope = { ...actor, agentId: 'agent-a', sessionId: 'session-a' };
const limits = { callId: 'context', maxOutputTokens: 128, maxInputBytes: 65536, maxInputTokens: 100000 };
function reply(packet: ContextPacket): ModelReply {
  return { status: 'ok', provider: 'scripted', model: 'fixture', inputTokens: 17, outputTokens: 11,
    proposal: { baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision, basePlanRevision: packet.plan?.revision ?? 0,
      reason: 'Use an independent source for the new work', hypotheses: [], tasks: [{ id: 'read-y', description: 'Read Y evidence',
        toolId: 'fixture.read', toolVersion: '1', effect: 'read', input: { evidenceIds: ['source-y'] }, dependsOn: [], maxAttempts: 1, satisfies: [] }] } };
}
async function fixture(planner: Planner = new ScriptedPlanner([reply]), session = true) {
  const state = new MemoryStateRepository(); const artifacts = new MemoryArtifactStore(); const digester = new Sha256Digester();
  const work = initial('work-y'); work.budget.limits.tokens = 1000000;
  if (session) work.conversation = { bindings: [{ id: 'binding', channel: 'test', conversationId: 'room', recipientId: actor.principalId,
    destination: 'local', ...actor, session: scope }], primaryBindingId: 'binding', completionRequiresDelivery: false, result: null,
    session: { scope, input: { messageId: 'input-y', sequence: 3, digest: digester.digest('input-y') } } };
  const contexts = new Map<number, SessionContext>();
  const makeContext = (work: WorkState, text = 'Now perform Y'): SessionContext => {
    const basis = structuredClone(work.conversation!.session!);
    const entries: SessionContext['entries'] = [
      { sequence: 1, role: 'user', sourceId: 'input-x', workId: 'work-x', text: 'Keep future answers short.', labels: ['synthetic'], artifact: null, status: 'received', kind: 'work' },
      { sequence: 2, role: 'assistant', sourceId: 'response-x', workId: 'work-x', text: 'I will keep answers short.', labels: ['synthetic'], artifact: null, status: 'delivered', kind: 'result' },
      { sequence: basis.input.sequence, role: 'user', sourceId: basis.input.messageId, workId: work.id, text, labels: ['synthetic'], artifact: null, status: 'received', kind: 'work' },
    ];
    return { schemaVersion: 1, basis, head: { revision: 1, throughSequence: basis.input.sequence,
      digest: digester.digest(asJson(entries)), policyDigest: digester.digest(asJson(work.policy)) }, entries,
      interpretation: 'conversation_history_not_verified_evidence' };
  };
  if (session) contexts.set(3, makeContext(work));
  const access = { current: true, unrelatedTail: 3 };
  const expected = (value: WorkState) => {
    const basis = value.conversation?.session;
    if (!basis || digester.digest(asJson(basis.scope)) !== digester.digest(asJson(scope))) return null;
    const context = contexts.get(basis.input.sequence);
    return context && digester.digest(asJson(context.basis)) === digester.digest(asJson(basis)) ? context : null;
  };
  const tool = new FixtureReadTool([]); const contracts = new ToolContracts([tool], new AjvSchemas());
  const services: RuntimeServices = { state, artifacts, digester, planner, tools: [tool], clock: new FakeClock(1100), ids: new SequenceIds(), sink: new FakeSink(),
    sessions: { context: async value => structuredClone(expected(value)), current: async (value, context, signal) => {
      const stored = expected(value);
      return !signal?.aborted && access.current && !!stored && (!context || digester.digest(asJson(context)) === digester.digest(asJson(stored)));
    } } };
  assert.equal((await state.commit(command(work, 'accept-y'))).kind, 'committed');
  const execution = new ExecutionRuntime(services, contracts, 'session-worker');
  const compiler = new ContextCompiler(services, contracts); const planning = new PlanningRuntime(services, contracts, execution, 'session-planner', {}, compiler);
  const current = async () => (await state.get(work.id))!;
  const applyNext = async () => {
    await transact(services, work.id, 'apply-next-input', 'session_input_applied', {}, next => {
      next.conversation!.session!.input = { messageId: 'input-amended', sequence: 4, digest: digester.digest('input-amended') };
      contexts.set(4, makeContext(next, 'Change the requested format.'));
    });
  };
  return { state, artifacts, services, contracts, execution, compiler, planning, work, contexts, access, current, applyNext };
}

test('session context: Y receives prior utterances with source IDs while its work state and protected input remain independent', async () => {
  const f = await fixture(); const prepared = await f.compiler.prepare(await f.current(), { ...limits, forceCompact: true });
  assert.deepEqual(prepared.packet.session, f.contexts.get(3));
  assert.deepEqual(prepared.frame.basis.session, { basis: prepared.packet.session!.basis, head: prepared.packet.session!.head });
  assert.equal(prepared.packet.workId, 'work-y'); assert.equal(prepared.packet.plan, null); assert.deepEqual(prepared.packet.evidence, []);
  assert.deepEqual(prepared.packet.hypotheses, []); assert.deepEqual(prepared.packet.execution!.attempts, []);
  assert.equal(prepared.packet.execution!.budget.used.modelCalls, 0); assert.equal(prepared.frame.metrics.extraModelCalls, 0);
  assert.equal(prepared.packet.session!.entries[0]!.workId, 'work-x');
  assert.equal(prepared.packet.session!.interpretation, 'conversation_history_not_verified_evidence');
  const stored = JSON.parse(Buffer.from(await f.artifacts.get(prepared.head.artifact, f.work.policy)).toString());
  assert.deepEqual(stored.packet.session, prepared.packet.session);
  const model = await buildModelContextPacket(await f.current(), f.contracts, f.services);
  assert.deepEqual(model.session, prepared.packet.session);
});

test('session context: omitted, rewritten and foreign session packets are rejected even with an unchanged work revision', async () => {
  const f = await fixture(); const current = await f.current(); const prepared = await f.compiler.prepare(current, limits);
  const omitted = structuredClone(prepared.packet); delete omitted.session;
  const rewritten = structuredClone(prepared.packet); rewritten.session!.entries[0]!.text = 'Invented user instruction';
  const foreign = structuredClone(prepared.packet); foreign.session!.basis.scope.agentId = 'other-agent';
  for (const packet of [omitted, rewritten, foreign]) assert.equal(await f.compiler.sourcesCurrent(packet, current), false);
  const missing = new ContextCompiler({ ...f.services, sessions: undefined }, f.contracts);
  await assert.rejects(missing.prepare(current, limits), /context_state_changed/);
  const cancelled = new AbortController(); cancelled.abort();
  assert.equal(await f.compiler.sourcesCurrent(prepared.packet, current, cancelled.signal), false);
  assert.equal((await f.current()).revision, current.revision);
});

test('session context: oversized protected history refuses the model input instead of silently discarding prior agreements', async () => {
  const f = await fixture(); f.contexts.get(3)!.entries[0]!.text = 'x'.repeat(20000);
  await assert.rejects(f.compiler.prepare(await f.current(), { ...limits, maxInputBytes: 12000 }), /model_input_limit/);
  assert.deepEqual((await f.current()).modelCalls, []); assert.equal((await f.current()).contextHead, undefined);
});

test('session frame store: stage rejects altered text and previous refuses foreign or stale session bases', async () => {
  const f = await fixture(); const state = await f.current(); const prepared = await f.compiler.prepare(state, limits);
  const store = new ContextFrameStore(f.services); const changed = structuredClone(prepared.frame);
  changed.packet.session!.entries[1]!.text = 'Altered response';
  await assert.rejects(store.stage(state, changed), /context_state_changed/);
  const wrongHead = structuredClone(prepared.frame); wrongHead.basis.session!.head.digest = 'a'.repeat(64);
  await assert.rejects(store.stage(state, wrongHead), /context_state_changed/);
  await transact(f.services, f.work.id, 'install-context', 'context_compacted', {}, next => { next.contextHead = prepared.head; });
  assert.equal((await store.previous(await f.current())).disposition, 'usable');
  await f.applyNext();
  assert.equal((await store.previous(await f.current())).disposition, 'regenerated');
  const next = await f.compiler.prepare(await f.current(), limits);
  assert.equal(next.packet.session!.basis.input.sequence, 4); assert.equal(next.packet.session!.entries.at(-1)!.text, 'Change the requested format.');
});

test('session planning: semantic version 3 reaches the actual planner and a newer unrelated session tail does not invalidate its fixed input', async () => {
  const planner = new ScriptedPlanner([reply]); const f = await fixture(planner); const call = await f.planning.reserve(f.work.id);
  assert.equal(call.semanticVersion, 3);
  const input = JSON.parse(Buffer.from(await f.artifacts.get(call.inputArtifact, f.work.policy)).toString());
  assert.deepEqual(input.packet.session, f.contexts.get(3));
  f.access.unrelatedTail = 20;
  await f.planning.execute(f.work.id, call.id); assert.equal(await f.planning.adopt(f.work.id, call.id), true);
  assert.equal(planner.inputs.length, 1); assert.deepEqual(planner.inputs[0]!.session, input.packet.session);
  assert.equal((await f.current()).budget.used.tokens, 28);
});

test('session planning: an applied input invalidates a reserved call without copying or invoking its obsolete packet', async () => {
  const planner = new ScriptedPlanner([reply]); const f = await fixture(planner); const call = await f.planning.reserve(f.work.id);
  await f.applyNext(); await assert.rejects(f.planning.dispatch(f.work.id, call.id), /model_not_dispatchable/);
  assert.equal(planner.inputs.length, 0); assert.equal((await f.current()).modelCalls[0]!.status, 'reserved');
});

test('session planning: input applied during a model call rejects the late plan but retains reported usage', async () => {
  let started!: () => void; const start = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const base = new ScriptedPlanner([]);
  const planner: Planner = { identity: base.identity, destination: base.destination, capabilities: base.capabilities,
    propose: async packet => { started(); await gate; return reply(packet); } };
  const f = await fixture(planner); const call = await f.planning.reserve(f.work.id);
  const running = f.planning.execute(f.work.id, call.id); await start; await f.applyNext(); release(); await running;
  assert.equal(await f.planning.adopt(f.work.id, call.id), false);
  const state = await f.current(); assert.equal(state.plan, null); assert.equal(state.modelCalls[0]!.status, 'rejected');
  assert.equal(state.budget.used.tokens, 28); assert.equal(state.budget.used.modelCalls, 1); assert.equal(state.budget.reservedTokens, 0);
});

test('session planning: losing access to the referenced conversation after execution prevents plan adoption', async () => {
  const f = await fixture(); const call = await f.planning.reserve(f.work.id); await f.planning.execute(f.work.id, call.id);
  f.access.current = false; assert.equal(await f.planning.adopt(f.work.id, call.id), false);
  assert.equal((await f.current()).plan, null); assert.equal((await f.current()).budget.used.tokens, 28);
});

test('session planning: legacy non-session calls retain semantic version 2 and need no session provider', async () => {
  const planner = new ScriptedPlanner([reply]); const f = await fixture(planner, false); f.services.sessions = undefined;
  const call = await f.planning.reserve(f.work.id); assert.equal(call.semanticVersion, 2);
  await f.planning.execute(f.work.id, call.id); assert.equal(await f.planning.adopt(f.work.id, call.id), true);
  assert.equal(planner.inputs[0]!.session, undefined);
});

test('session recovery: reconstruction retains source conversation, reuses an equal packet and refuses unavailable session inputs', async () => {
  const f = await fixture(); const recovery = new ContextRecovery(f.services, f.contracts);
  const first = await recovery.restore(f.work.id, actor);
  assert.deepEqual(first.packet.context.session, f.contexts.get(3));
  const second = await new ContextRecovery(f.services, f.contracts).restore(f.work.id, actor, first.artifact);
  assert.equal(second.disposition, 'reused'); assert.deepEqual(second.packet.context.evidence, []);
  f.access.current = false;
  await assert.rejects(recovery.restore(f.work.id, actor, first.artifact), /resume_session_changed/);
});
