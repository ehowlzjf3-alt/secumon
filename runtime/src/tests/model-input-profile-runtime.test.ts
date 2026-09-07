import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContextPacket, ModelCall, WorkState } from '../domain/model.js';
import type { ModelCallOptions, ModelReply, Planner } from '../application/ports.js';
import type { RuntimeServices } from '../application/services.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { PlanningRuntime } from '../application/planning-runtime.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { transact } from '../application/work-transactions.js';
import { readGeneratedAnswer } from '../application/generated-answer.js';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { FakeClock, FakeSink, FixtureReadTool, SequenceIds } from '../infrastructure/fakes.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { command, initial } from './state-conformance-helpers.js';
import { fixture as turnFixture, replaceTurn, answer } from './agent-turn-flow-helpers.js';
import { initialize, openCompact, seedCompletedXAndActiveY, compactUsage } from './session-compact-flow-helpers.js';

type Envelope = { packet: ContextPacket; options: ModelCallOptions };
const registeredEstimator = () => ({ id: 'synthetic-runtime-estimator', revision: '1', templateRevision: '1', kind: 'tokenizer' as const });
async function fixture() {
  const repository = new MemoryStateRepository(), artifacts = new MemoryArtifactStore(), digester = new Sha256Digester();
  const clock = new FakeClock(1100), tool = new FixtureReadTool([]), tools = new ToolContracts([tool], new AjvSchemas());
  const work = initial('input-profile-work'); work.budget.limits.tokens = 1000000;
  const estimates: Envelope[] = [], invocations: Envelope[] = [], estimator = { tokens: 1000 };
  const planner: Planner = { identity: { provider: 'synthetic', model: 'profile-runtime', revision: '1' }, destination: 'local',
    inputEstimation: registeredEstimator(),
    capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 100000 },
    estimateInput(packet, options) { estimates.push(structuredClone({ packet, options }));
      return { tokens: estimator.tokens, bytes: Buffer.byteLength(JSON.stringify({ packet, options })), method: 'synthetic_exact_envelope' }; },
    async propose(packet, _signal, options): Promise<ModelReply> {
      assert.ok(options); invocations.push(structuredClone({ packet, options }));
      return { status: 'ok', provider: 'synthetic', model: 'profile-runtime', inputTokens: 19, outputTokens: 7,
        proposal: { baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision, basePlanRevision: packet.plan?.revision ?? 0,
          reason: 'read the permitted source', hypotheses: [], tasks: [{ id: 'read', description: 'read current original', dependsOn: [],
            toolId: 'fixture.read', toolVersion: '1', input: { evidenceIds: ['original'] }, effect: 'read', maxAttempts: 1,
            satisfies: packet.goal.criteria.map(criterion => criterion.id) }] } };
    } };
  const services: RuntimeServices = { state: repository, artifacts, digester, clock, ids: new SequenceIds(), planner, tools: [tool], sink: new FakeSink() };
  assert.equal((await repository.commit(command(work, 'accept'))).kind, 'committed');
  const execution = new ExecutionRuntime(services, tools, 'worker');
  const planning = new PlanningRuntime(services, tools, execution, 'planner', { maxOutputTokens: 128, leaseMs: 10000 });
  return { services, artifacts, execution, planning, workId: work.id, estimator, estimates, invocations,
    current: () => execution.state(work.id), readInput: (call: ModelCall) => artifacts.get(call.inputArtifact, work.policy) };
}
function noOutstandingResources(state: WorkState) {
  assert.equal(state.budget.reservedTokens, 0); assert.equal(state.budget.reservedModelCalls, 0);
  assert.equal(state.budget.used.unmeasuredModelCalls, 0);
}
async function removeHistoricalPin(f: Awaited<ReturnType<typeof fixture>>, call: ModelCall, shortenReservation = false) {
  await transact(f.services, f.workId, `restore-legacy:${call.id}`, 'synthetic_historical_call_restored', {}, state => {
    const saved = state.modelCalls.find(value => value.id === call.id)!;
    delete saved.inputProfileDigest;
    if (shortenReservation) { saved.tokenReservation--; state.budget.reservedTokens--; }
  });
}
function deferred() {
  let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve };
}

for (const changed of ['capability', 'estimator_revision'] as const) test(`planning: ${changed} after reservation cancels without dispatching or spending its reservation`, async () => {
  const f = await fixture(), call = await f.planning.reserve(f.workId), original = await f.readInput(call);
  assert.match(call.inputProfileDigest!, /^[a-f0-9]{64}$/);
  const prior = f.services.planner;
  f.services.planner = changed === 'capability' ? { ...prior, capabilities: { ...prior.capabilities, maxInputTokens: 99999 } } :
    { ...prior, inputEstimation: { ...prior.inputEstimation!, revision: '2' } };
  assert.equal(await f.planning.dispatch(f.workId, call.id), false);
  const state = await f.current(), saved = state.modelCalls[0]!;
  assert.equal(saved.status, 'cancelled'); assert.equal(saved.usageStatus, 'not_called');
  assert.equal(saved.reason, 'model_input_profile_changed'); assert.equal(saved.inputTokens, 0); assert.equal(saved.outputTokens, 0);
  assert.equal(state.budget.used.modelCalls, 0); assert.equal(state.budget.used.tokens, 0); noOutstandingResources(state);
  assert.equal(f.invocations.length, 0); assert.deepEqual(saved.inputArtifact, call.inputArtifact);
  assert.deepEqual(await f.readInput(call), original);
});

test('a profile change during the final source await prevents transport and settles zero token usage without rewriting the fixed input', { timeout: 5000 }, async () => {
  const f = await fixture(), call = await f.planning.reserve(f.workId), original = await f.readInput(call);
  const entered = deferred(), released = deferred(), sourceCheck = f.planning.context.sourcesCurrent.bind(f.planning.context);
  f.planning.context.sourcesCurrent = async (...args) => {
    const current = await sourceCheck(...args); entered.resolve(); await released.promise; return current;
  };
  const execution = f.planning.execute(f.workId, call.id);
  try {
    await Promise.race([entered.promise, execution.then(() => { throw new Error('source_boundary_not_reached'); })]);
    assert.equal((await f.current()).modelCalls[0]!.status, 'running');
    f.services.planner = { ...f.services.planner, inputEstimation: { ...f.services.planner.inputEstimation!, revision: '2' } };
  } finally { released.resolve(); await execution; await f.planning.settlePending(); }
  const state = await f.current(), saved = state.modelCalls[0]!;
  assert.equal(f.invocations.length, 0); assert.equal(saved.outcome, 'cancelled'); assert.equal(saved.usageStatus, 'reported');
  assert.equal(saved.inputTokens, 0); assert.equal(saved.outputTokens, 0); assert.equal(state.budget.used.tokens, 0);
  assert.equal(state.budget.used.modelCalls, 1, 'the existing ledger counts the dispatch; the transport and token usage stay zero');
  noOutstandingResources(state); assert.deepEqual(saved.inputArtifact, call.inputArtifact); assert.deepEqual(await f.readInput(call), original);
});

test('planning: a received reply remains adoptable after a capacity-only change, with one invocation and unchanged reported usage', async () => {
  const f = await fixture(), call = await f.planning.reserve(f.workId);
  await f.planning.execute(f.workId, call.id);
  const received = await f.current(); assert.equal(received.modelCalls[0]!.status, 'received');
  assert.equal(received.budget.used.tokens, 26); const reply = received.modelCalls[0]!.replyArtifact;
  f.services.planner = { ...f.services.planner, capabilities: { ...f.services.planner.capabilities, maxInputTokens: 1 } };
  assert.equal(await f.planning.adopt(f.workId, call.id), true);
  assert.equal(await f.planning.adopt(f.workId, call.id), true);
  const state = await f.current(); assert.ok(state.plan); assert.equal(state.modelCalls[0]!.status, 'accepted');
  assert.deepEqual(state.modelCalls[0]!.replyArtifact, reply); assert.equal(f.invocations.length, 1);
  assert.equal(state.budget.used.tokens, 26); assert.equal(state.budget.used.modelCalls, 1); noOutstandingResources(state);
});

test('an unpinned legacy reservation sends only its original input, re-estimated within current limits and the original reservation', async () => {
  const f = await fixture(), call = await f.planning.reserve(f.workId), original = await f.readInput(call);
  await removeHistoricalPin(f, call); f.estimates.length = 0; f.estimator.tokens = 900;
  // A changed registration does not retroactively pin or reject a historical call whose real input still fits.
  f.services.planner = { ...f.services.planner, inputEstimation: { ...f.services.planner.inputEstimation!, revision: '2' },
    capabilities: { ...f.services.planner.capabilities, maxInputTokens: 900 } };
  await f.planning.execute(f.workId, call.id);
  assert.equal(f.invocations.length, 1); assert.ok(f.estimates.length > 0);
  const envelope = JSON.parse(Buffer.from(original).toString('utf8')) as Envelope;
  for (const estimated of f.estimates) assert.deepEqual(estimated, envelope);
  assert.deepEqual(f.invocations[0], envelope); assert.deepEqual(await f.readInput(call), original);
  const state = await f.current(), saved = state.modelCalls[0]!;
  assert.equal(Object.hasOwn(saved, 'inputProfileDigest'), false);
  assert.equal(saved.inputEstimate, call.inputEstimate); assert.equal(saved.tokenReservation, call.tokenReservation);
  assert.equal(saved.status, 'received'); assert.equal(state.budget.used.tokens, 26); noOutstandingResources(state);
});

for (const exceeds of ['current_capacity', 'original_input_estimate', 'original_token_reservation'] as const)
  test(`legacy input exceeding ${exceeds} is cancelled; the original call is never enlarged and a new reservation is required`, async () => {
    const f = await fixture(), call = await f.planning.reserve(f.workId), original = await f.readInput(call);
    await removeHistoricalPin(f, call, exceeds === 'original_token_reservation');
    if (exceeds === 'current_capacity') f.services.planner = { ...f.services.planner,
      capabilities: { ...f.services.planner.capabilities, maxInputTokens: 999 } };
    if (exceeds === 'original_input_estimate') f.estimator.tokens = 1001;
    assert.equal(await f.planning.dispatch(f.workId, call.id), false);
    const cancelled = await f.current(), saved = cancelled.modelCalls[0]!;
    assert.equal(saved.status, 'cancelled'); assert.equal(saved.usageStatus, 'not_called');
    assert.equal(saved.inputEstimate, call.inputEstimate); assert.equal(Object.hasOwn(saved, 'inputProfileDigest'), false);
    assert.equal(saved.tokenReservation, call.tokenReservation - (exceeds === 'original_token_reservation' ? 1 : 0));
    assert.equal(f.invocations.length, 0); assert.equal(cancelled.budget.used.tokens, 0); assert.equal(cancelled.budget.used.modelCalls, 0);
    noOutstandingResources(cancelled); assert.deepEqual(await f.readInput(call), original);
    f.services.planner = { ...f.services.planner, capabilities: { ...f.services.planner.capabilities, maxInputTokens: 100000 } };
    const replacement = await f.planning.reserve(f.workId);
    assert.notEqual(replacement.id, call.id); assert.ok(replacement.inputProfileDigest);
    assert.equal(replacement.tokenReservation, f.estimator.tokens + replacement.maxOutputTokens);
    assert.equal((await f.current()).modelCalls[0]!.status, 'cancelled');
  });

test('agent turn: a received generated answer survives a changed input capacity and is adopted from its stored reply once', { timeout: 60000 }, async () => {
  const f = await turnFixture(); let invocations = 0;
  try {
    replaceTurn(f.profile, async input => { invocations++; return answer(input, 'stored response survives the capacity change'); });
    const planning = f.profile.planning!, accepted = await f.accept('explain the stored request', 'profile-request', 'deep');
    const call = await planning.reserve(accepted.workId); assert.equal(call.purpose, 'agent_turn');
    await planning.execute(accepted.workId, call.id);
    const received = await f.profile.runtime.state(accepted.workId); assert.equal(received.modelCalls[0]!.status, 'received');
    planning.services.planner = { ...planning.services.planner, capabilities: { ...planning.services.planner.capabilities, maxInputTokens: 1 } };
    assert.equal(await planning.adopt(accepted.workId, call.id), true);
    assert.equal(await planning.adopt(accepted.workId, call.id), true);
    const state = await f.profile.runtime.state(accepted.workId);
    assert.equal((await readGeneratedAnswer(planning.services, state))?.text, 'stored response survives the capacity change');
    assert.equal(state.generatedAnswer!.callId, call.id); assert.equal(invocations, 1);
    assert.equal(state.budget.used.modelCalls, 1); assert.equal(state.budget.used.tokens, 10); noOutstandingResources(state);
    assert.deepEqual(state.modelCalls[0]!.replyArtifact, received.modelCalls[0]!.replyArtifact);
  } finally { await f.close(); }
});

test('compact: a changed reserved profile prevents invocation, but a later received compact remains publishable after capacity changes', { timeout: 60000 }, async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'model-input-profile-compact-')));
  try {
    mkdirSync(join(base, 'engine'), { mode: 0o700 }); initialize(base, 'sqlite');
    const f = await openCompact(base);
    try {
      const { session, y } = await seedCompletedXAndActiveY(f), planning = f.compactPlanning!;
      const stateBefore = await f.runtime.state(y.workId);
      const history = await f.stores.sessions.history(session.scope, stateBefore.policy, { limit: 256 });
      const first = await planning.requestCompact(y.workId, { requestId: 'before-change', force: true, expectedGoalRevision: 1 }); assert.ok(first);
      const original = await f.stores.artifacts.get(first.inputArtifact, stateBefore.policy);
      f.planner.capabilities.maxInputTokens = 99999;
      assert.equal(await planning.dispatch(y.workId, first.id), false);
      const cancelled = await f.runtime.state(y.workId); noOutstandingResources(cancelled);
      assert.equal(cancelled.budget.used.modelCalls, 0); assert.equal(f.planner.inputs.length, 0);
      assert.deepEqual(await f.stores.artifacts.get(first.inputArtifact, stateBefore.policy), original);
      const second = await planning.requestCompact(y.workId, { requestId: 'after-change', force: true, expectedGoalRevision: 1 }); assert.ok(second);
      assert.notEqual(second.id, first.id); assert.equal(second.purpose, 'session_compact');
      await planning.execute(y.workId, second.id);
      assert.equal((await f.runtime.state(y.workId)).modelCalls.find(call => call.id === second.id)!.status, 'received');
      f.planner.capabilities.maxInputTokens = 1;
      assert.equal(await planning.adopt(y.workId, second.id), true);
      const state = await f.runtime.state(y.workId); assert.equal(f.planner.inputs.length, 1); assert.equal(f.planner.planCalls, 0);
      assert.equal(state.budget.used.modelCalls, 1); assert.equal(state.budget.used.tokens, compactUsage.inputTokens + compactUsage.outputTokens);
      noOutstandingResources(state); assert.ok(await f.stores.sessions.publication(session.scope, second.id));
      assert.deepEqual(await f.stores.sessions.history(session.scope, state.policy, { limit: 256 }), history);
      assert.equal(state.modelCalls.find(call => call.id === first.id)!.status, 'cancelled');
    } finally { await f.close(); }
  } finally { rmSync(base, { recursive: true, force: true }); }
});
