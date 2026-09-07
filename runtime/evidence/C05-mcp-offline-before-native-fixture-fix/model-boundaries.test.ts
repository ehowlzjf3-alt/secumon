import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ArtifactStore, ModelCallOptions, ModelReply, Planner } from '../application/ports.js';
import type { Limits, ContextPacket, ModelCall } from '../domain/model.js';
import { newWork } from '../application/new-work.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { PlanningRuntime } from '../application/planning-runtime.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { transact } from '../application/work-transactions.js';
import { validateScenario } from '../application/fixtures.js';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { Sha256Digester, RandomIds } from '../infrastructure/digest.js';
import { FakeClock, FakeSink, FixtureReadTool } from '../infrastructure/fakes.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';

const actor = { tenantId: 'synthetic', principalId: 'learner' };
const scenario = validateScenario(JSON.parse(readFileSync(new URL('../../fixtures/documents-simple.json', import.meta.url), 'utf8')));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function success(packet: ContextPacket, inputTokens = 120, outputTokens = 30): ModelReply {
  return { status: 'ok', provider: 'boundary', model: 'fake', inputTokens, outputTokens,
    proposal: { baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision, basePlanRevision: packet.plan?.revision ?? 0,
      reason: 'Read a permitted synthetic source', hypotheses: [], tasks: [{ id: `source-g${packet.goal.revision}`, description: 'Read current evidence', dependsOn: [],
        toolId: 'fixture.read', toolVersion: '1', input: { evidenceIds: ['doc-current'] }, effect: 'read', maxAttempts: 1, satisfies: packet.goal.criteria.map(c => c.id) }] } };
}
class BoundaryPlanner implements Planner {
  readonly identity = { provider: 'boundary', model: 'fake', revision: '1' };
  readonly destination = 'local';
  readonly capabilities = { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 1000000 };
  readonly invocations: { packet: ContextPacket; signal: AbortSignal; options: ModelCallOptions | undefined }[] = [];
  constructor(readonly responder: (packet: ContextPacket, signal: AbortSignal) => Promise<ModelReply> = async packet => success(packet)) {}
  estimateInput(packet: ContextPacket, options: ModelCallOptions) {
    const bytes = Buffer.byteLength(JSON.stringify({ packet, options }), 'utf8');
    return { tokens: bytes + 2048, bytes, method: 'synthetic_byte_estimate' };
  }
  async propose(packet: ContextPacket, signal: AbortSignal, options?: ModelCallOptions) {
    this.invocations.push({ packet: structuredClone(packet), signal, options: options ? structuredClone(options) : undefined });
    return this.responder(packet, signal);
  }
}
type SetupOptions = { planner?: BoundaryPlanner; artifacts?: ArtifactStore; limits?: Partial<Limits>;
  config?: Partial<{ leaseMs: number; maxInputBytes: number; maxOutputTokens: number; maxReplyBytes: number }> };
async function setup(options: SetupOptions = {}) {
  const planner = options.planner ?? new BoundaryPlanner(); const tool = new FixtureReadTool(scenario.evidence);
  const state = new MemoryStateRepository(); const clock = new FakeClock(1788566400000);
  const initial = newWork({ id: 'boundary-work', goal: scenario.goal, policy: scenario.policy,
    limits: { toolCalls: 10, modelCalls: 5, tokens: 1000000, replans: 4, wallTimeMs: 120000, ...options.limits }, now: clock.now() });
  await state.commit({ workId: initial.id, expectedRevision: 0, commandId: 'accept', commandDigest: 'accept', next: initial,
    events: [{ type: 'work_accepted', at: clock.now(), data: {} }], deliveries: [] });
  const services = { state, clock, planner, artifacts: options.artifacts ?? new MemoryArtifactStore(),
    tools: [tool], digester: new Sha256Digester(), ids: new RandomIds(), sink: new FakeSink() };
  const contracts = new ToolContracts([tool], new AjvSchemas());
  const execution = new ExecutionRuntime(services, contracts, 'executor');
  const config = { leaseMs: 10000, ...options.config };
  const planning = new PlanningRuntime(services, contracts, execution, 'owner-1', config);
  const restart = (owner = 'owner-2') => new PlanningRuntime(services, contracts, new ExecutionRuntime(services, contracts, 'restarted-executor'), owner, config);
  return { services, execution, planning, planner, tool, restart, workId: initial.id };
}
function heldInputRead() {
  const store = new MemoryArtifactStore(); const entered = deferred<void>(); const released = deferred<void>(); let held = false;
  const artifacts: ArtifactStore = { put: store.put.bind(store), exists: store.exists.bind(store), async get(ref, policy) {
    const bytes = await store.get(ref, policy);
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (!held && value['packet'] && value['options']) { held = true; entered.resolve(); await released.promise; }
    return bytes;
  } };
  return { artifacts, entered, released };
}
async function originalPacket(f: Awaited<ReturnType<typeof setup>>, call: ModelCall) {
  const state = await f.execution.state(f.workId);
  return (JSON.parse(new TextDecoder().decode(await f.services.artifacts.get(call.inputArtifact, state.policy))) as { packet: ContextPacket }).packet;
}

for (const change of ['cancel', 'goal', 'destination', 'labels'] as const) {
  test(`${change} during input artifact read prevents transport invocation and releases the known unused token reservation`, { timeout: 2000 }, async () => {
    const held = heldInputRead(); const f = await setup({ artifacts: held.artifacts }); const call = await f.planning.reserve(f.workId);
    const running = f.planning.execute(f.workId, call.id);
    await held.entered.promise;
    try {
      if (change === 'cancel') await f.execution.command(f.workId, 'cancel', actor, 1, { kind: 'cancel', reason: 'Stop before model transmission' });
      else if (change === 'goal') await f.execution.command(f.workId, 'change-goal', actor, 1, { kind: 'goal', expectedControlRevision: (await f.execution.state(f.workId)).executionControl?.revision ?? 1, goal: { ...scenario.goal, revision: 2, scope: 'revised-scope' } });
      else await transact(f.services, f.workId, 'revoke', 'policy_changed', {}, state => {
        if (change === 'destination') state.policy.allowedDestinations = []; else state.policy.allowedLabels = [];
      });
    } finally { held.released.resolve(); }
    await running;
    assert.equal(f.planner.invocations.length, 0); assert.equal(await f.planning.adopt(f.workId, call.id), false);
    const state = await f.execution.state(f.workId);
    assert.equal(state.plan, null); assert.equal(state.budget.used.tokens, 0); assert.equal(state.budget.reservedTokens, 0);
    assert.equal(state.budget.reservedModelCalls, 0); assert.equal(state.budget.used.unmeasuredModelCalls, 0);
    if (change === 'cancel') assert.equal(state.status, 'cancelled');
    if (change === 'goal') assert.equal(state.goal.revision, 2);
  });
}

test('cancelling an active model sends its signal, yields promptly and settles late usage once without adopting the old plan', { timeout: 2000 }, async () => {
  const entered = deferred<void>(); const response = deferred<ModelReply>();
  const planner = new BoundaryPlanner(async () => { entered.resolve(); return response.promise; });
  const f = await setup({ planner }); const call = await f.planning.reserve(f.workId);
  const running = f.planning.execute(f.workId, call.id); await entered.promise;
  await f.execution.command(f.workId, 'cancel-running', actor, 1, { kind: 'cancel', reason: 'Stop this task' });
  assert.equal(planner.invocations[0]!.signal.aborted, true);
  await running;
  let state = await f.execution.state(f.workId);
  assert.equal(state.status, 'cancelled'); assert.equal(state.modelCalls[0]!.status, 'unknown'); assert.equal(state.budget.used.unmeasuredModelCalls, 1);
  response.resolve(success(planner.invocations[0]!.packet, 91, 17));
  assert.deepEqual(await f.planning.settlePending(), []);
  assert.ok((await f.services.state.runnable(f.services.clock.now())).includes(f.workId));
  assert.equal(await f.planning.adopt(f.workId, call.id), false);
  state = await f.execution.state(f.workId);
  assert.equal(state.plan, null); assert.equal(state.status, 'cancelled'); assert.equal(state.budget.used.tokens, 108);
  assert.equal(state.budget.reservedTokens, 0); assert.equal(state.budget.used.unmeasuredModelCalls, 0); assert.equal(state.budget.used.modelCalls, 1);
  await f.planning.receive(f.workId, call.id, success(planner.invocations[0]!.packet, 91, 17));
  assert.equal((await f.execution.state(f.workId)).budget.used.tokens, 108); assert.equal(planner.invocations.length, 1);
});

for (const [name, options, expected] of [
  ['input byte limit', { config: { maxInputBytes: 64 } }, 'model_input_limit'],
  ['token budget', { limits: { tokens: 1 } }, 'token_budget_exhausted'],
  ['model call budget', { limits: { modelCalls: 0 } }, 'model_budget_exhausted'],
] satisfies [string, SetupOptions, string][]) {
  test(`${name} rejects before a durable reservation or transport call`, async () => {
    const f = await setup(options);
    await assert.rejects(f.planning.reserve(f.workId), new RegExp(expected));
    const state = await f.execution.state(f.workId);
    assert.equal(state.modelCalls.length, 0); assert.equal(state.budget.reservedTokens, 0); assert.equal(state.budget.reservedModelCalls, 0);
    assert.equal(state.budget.used.modelCalls, 0); assert.equal(f.planner.invocations.length, 0);
  });
}

test('model context capacity and destination policy reject input without invoking the planner', async () => {
  const planner = new BoundaryPlanner(); planner.capabilities.maxInputTokens = 1;
  const limited = await setup({ planner }); await assert.rejects(limited.planning.reserve(limited.workId), /model_input_limit/);
  const denied = await setup();
  await transact(denied.services, denied.workId, 'deny-destination', 'policy_changed', {}, state => { state.policy.allowedDestinations = []; });
  await assert.rejects(denied.planning.reserve(denied.workId), /model_destination_denied/);
  assert.equal(limited.planner.invocations.length, 0); assert.equal(denied.planner.invocations.length, 0);
});

test('concurrent reservations have one winner and duplicate execution performs one dispatch and one transport call', async () => {
  const f = await setup(); const competitor = f.restart();
  const results = await Promise.allSettled([f.planning.reserve(f.workId), competitor.reserve(f.workId)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const winner = results.find(result => result.status === 'fulfilled'); assert.ok(winner && winner.status === 'fulfilled');
  const call = winner.value; const owner = call.owner === 'owner-1' ? f.planning : competitor;
  await Promise.all([owner.execute(f.workId, call.id), owner.execute(f.workId, call.id)]);
  assert.equal(await owner.dispatch(f.workId, call.id), false);
  assert.equal(f.planner.invocations.length, 1); assert.equal(await owner.adopt(f.workId, call.id), true);
  const state = await f.execution.state(f.workId); const events = await f.services.state.events(f.workId, 0);
  assert.equal(state.modelCalls.length, 1); assert.equal(state.budget.used.modelCalls, 1); assert.equal(state.budget.used.tokens, 150);
  assert.equal(state.budget.reservedTokens, 0); assert.equal(state.budget.reservedModelCalls, 0);
  assert.equal(events.filter(event => event.type === 'model_call_reserved').length, 1);
  assert.equal(events.filter(event => event.type === 'model_call_dispatched').length, 1);
});

test('a replacement owner waits for a reserved lease, then releases it and creates a fresh intent without repeating a transport call', async () => {
  const f = await setup(); const original = await f.planning.reserve(f.workId); const restarted = f.restart();
  assert.equal((await restarted.step(f.workId)).kind, 'wait'); assert.deepEqual(await f.services.state.runnable(f.services.clock.now()), []);
  f.services.clock.advance(10001); assert.deepEqual(await f.services.state.runnable(f.services.clock.now()), [f.workId]);
  await restarted.step(f.workId);
  let state = await f.execution.state(f.workId);
  assert.equal(state.modelCalls[0]!.status, 'cancelled'); assert.equal(state.modelCalls[0]!.usageStatus, 'not_called');
  assert.equal(state.budget.used.modelCalls, 0); assert.equal(state.budget.reservedModelCalls, 0); assert.equal(state.budget.reservedTokens, 0);
  assert.ok(await f.services.artifacts.exists(original.inputArtifact));
  const fresh = await restarted.reserve(f.workId); assert.notEqual(fresh.id, original.id);
  await restarted.execute(f.workId, fresh.id); assert.equal(await restarted.adopt(f.workId, fresh.id), true);
  state = await f.execution.state(f.workId); assert.equal(state.modelCalls.length, 2); assert.equal(state.budget.used.modelCalls, 1);
  assert.equal(f.planner.invocations.length, 1);
});

test('a recovered running lease retains uncertain cost and accepts only late accounting, never its expired plan', async () => {
  const f = await setup(); const call = await f.planning.reserve(f.workId); const packet = await originalPacket(f, call);
  await f.planning.dispatch(f.workId, call.id);
  const restarted = f.restart(); assert.equal((await restarted.step(f.workId)).kind, 'wait');
  f.services.clock.advance(10001); await restarted.step(f.workId);
  let state = await f.execution.state(f.workId);
  assert.equal(state.modelCalls[0]!.status, 'unknown'); assert.equal(state.budget.used.unmeasuredModelCalls, 1);
  assert.equal(state.budget.reservedTokens, call.tokenReservation); assert.equal(state.budget.used.modelCalls, 1);
  await assert.rejects(restarted.reserve(f.workId), /model_usage_unknown/); assert.equal(f.planner.invocations.length, 0);
  await restarted.receive(f.workId, call.id, success(packet, 70, 9));
  assert.ok((await f.services.state.runnable(f.services.clock.now())).includes(f.workId));
  assert.equal(await restarted.adopt(f.workId, call.id), false);
  state = await f.execution.state(f.workId);
  assert.equal(state.plan, null); assert.equal(state.budget.used.tokens, 79); assert.equal(state.budget.reservedTokens, 0);
  assert.equal(state.budget.used.unmeasuredModelCalls, 0); assert.equal(state.modelCalls[0]!.status, 'rejected');
  assert.equal(f.planner.invocations.length, 0);
});

test('a reply without usage keeps its reservation and prevents a further model call after rejection', async () => {
  const planner = new BoundaryPlanner(async () => ({ status: 'error', code: 'synthetic_failure', inputTokens: null, outputTokens: null }));
  const f = await setup({ planner }); const call = await f.planning.reserve(f.workId);
  await f.planning.execute(f.workId, call.id); assert.equal(await f.planning.adopt(f.workId, call.id), false);
  const state = await f.execution.state(f.workId);
  assert.equal(state.budget.used.unmeasuredModelCalls, 1); assert.equal(state.budget.reservedTokens, call.tokenReservation);
  assert.equal(state.budget.used.tokens, 0); await assert.rejects(f.planning.reserve(f.workId), /model_usage_unknown/);
  assert.equal(planner.invocations.length, 1);
});
