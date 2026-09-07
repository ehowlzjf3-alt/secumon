import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionJoin } from '../application/execution-join.js';
import { composeRuntime } from '../application/compose-runtime.js';
import type { StateRepository, Tool } from '../application/ports.js';
import type { ExecutionRuntime } from '../application/execution-runtime.js';
import type { TaskSpec } from '../domain/model.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { FakeClock, FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { adapters, command, initial, openRepository, type Adapter } from './state-conformance-helpers.js';

const actor = { tenantId: 'tenant-a', principalId: 'person-a' };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function statePort(backing: StateRepository, overrides: Partial<StateRepository>): StateRepository {
  return { get: backing.get.bind(backing), receipt: backing.receipt.bind(backing), commit: backing.commit.bind(backing), events: backing.events.bind(backing),
    recentEventMetadata: backing.recentEventMetadata.bind(backing), conversationWorkPage: backing.conversationWorkPage.bind(backing),
    deliveries: backing.deliveries.bind(backing), runnable: backing.runnable.bind(backing), workIdsForConversation: backing.workIdsForConversation.bind(backing), close: backing.close.bind(backing), ...overrides };
}
async function fixture(t: TestContext, adapter: Adapter, effect: 'read' | 'write' = 'read') {
  const directory = await mkdtemp(join(tmpdir(), 'execution-join-')); let state = openRepository(adapter, directory);
  const entered = deferred(); const release = deferred(); const runtimes: ExecutionRuntime[] = []; let calls = 0; let toolSignal: AbortSignal | undefined;
  const tool: Tool = { definition: { provider: 'fixture', id: 'fixture.join', version: '1', description: 'Wait on a controlled local synthetic result', effect,
    destination: 'local', labels: ['synthetic'], inputSchema: { type: 'object', properties: {}, additionalProperties: false }, outputSchema: { type: 'object' } },
    async execute(_task, context) {
      calls++; toolSignal = context.signal; entered.resolve(); await release.promise;
      return { resultId: `${context.attemptId}:result`, attemptId: context.attemptId, status: 'success', effectState: effect === 'write' ? 'confirmed' : 'none',
        evidence: [], artifacts: [], output: { synthetic: true }, error: null, cursor: null, coverage: 'complete' };
    } };
  const clock = new FakeClock(1000);
  t.after(async () => {
    release.resolve();
    await Promise.allSettled(runtimes.flatMap(runtime => runtime.pendingExecutions().map(id => runtime.settlePending(id))));
    await state.close(); await rm(directory, { recursive: true, force: true });
  });
  const compose = async (owner = 'join-owner') => {
    const c = await composeRuntime({ services: { state, clock, artifacts: new FileArtifactStore(join(directory, 'artifacts')), tools: [tool],
      ids: new RandomIds(), digester: new Sha256Digester(), planner: new ScriptedPlanner([]), sink: new FakeSink() }, schemas: new AjvSchemas(),
      guidanceSource: { list: async () => [], read: async () => { throw new Error('no_guidance'); } }, owner, leaseMs: 30000, enablePlanning: false });
    runtimes.push(c.runtime); return c;
  };
  const seed = initial(); seed.policy.allowedTools = ['fixture.join']; seed.policy.allowWrites = effect === 'write';
  assert.equal((await state.commit(command(seed, 'seed'))).kind, 'committed');
  const c = await compose(); const step: TaskSpec = { id: 'task', description: 'Synthetic join test', toolId: tool.definition.id, toolVersion: '1', input: {},
    dependsOn: [], effect, maxAttempts: 2, satisfies: [] };
  await c.runtime.submitPlan(seed.id, 'plan', { baseStateRevision: seed.revision, baseGoalRevision: seed.goal.revision, basePlanRevision: 0,
    reason: 'Exercise the durable execution boundary', tasks: [step], hypotheses: [] });
  const attempt = await c.runtime.reserve(seed.id, step.id);
  const facade = new ExecutionJoin(c.services, c.runtime);
  return { c, facade, attempt, clock, entered: entered.promise, release: release.resolve, calls: () => calls, toolSignal: () => toolSignal,
    state: () => state, workId: seed.id, compose,
    reopen: async (owner = 'join-owner') => { await state.close(); state = openRepository(adapter, directory); return compose(owner); } };
}

for (const adapter of adapters) {
  test(`${adapter}: two local callers join one real execution and preserve owner, lease, deadline and one budget charge`, async t => {
    const f = await fixture(t, adapter); const before = (await f.state().get(f.workId))!;
    const first = f.facade.execute(f.workId, f.attempt.id); const second = f.facade.execute(f.workId, f.attempt.id);
    await f.entered; assert.equal(f.calls(), 1);
    const running = (await f.state().get(f.workId))!;
    assert.equal(running.attempts[0]!.owner, f.attempt.owner); assert.equal(running.attempts[0]!.leaseUntil, f.attempt.leaseUntil); assert.equal(running.deadlineAt, before.deadlineAt);
    assert.equal(running.budget.used.toolCalls, 1); assert.equal(running.budget.reservedToolCalls, 0);
    f.release(); const [owner, follower] = await Promise.all([first, second]);
    assert.equal(owner.joined, false); assert.equal(follower.joined, true); assert.deepEqual({ ...owner, joined: true }, follower);
    assert.equal(owner.kind, 'settled'); if (owner.kind !== 'settled') throw new Error('expected_stored_execution');
    assert.equal(owner.status, 'received'); assert.equal(owner.hasResultArtifact, true); assert.equal(owner.dispatched, true);
    assert.equal((await f.state().get(f.workId))!.attempts[0]!.adopted, false);
    assert.equal((await f.state().events(f.workId, 0)).filter(e => e.type === 'attempt_dispatched').length, 1); assert.equal(f.calls(), 1);
  });

  test(`${adapter}: cancelling the initiating caller and another joined caller detaches only their waits`, async t => {
    const f = await fixture(t, adapter); const initiating = new AbortController(); const joining = new AbortController();
    const first = f.facade.execute(f.workId, f.attempt.id, initiating.signal); await f.entered;
    const survivor = f.facade.execute(f.workId, f.attempt.id); const third = f.facade.execute(f.workId, f.attempt.id, joining.signal);
    const before = (await f.state().get(f.workId))!; initiating.abort(); joining.abort();
    assert.deepEqual(await first, { kind: 'detached', workId: f.workId, attemptId: f.attempt.id, reason: 'caller_aborted', joined: false });
    assert.deepEqual(await third, { kind: 'detached', workId: f.workId, attemptId: f.attempt.id, reason: 'caller_aborted', joined: true });
    assert.equal(f.toolSignal()!.aborted, false); assert.deepEqual(await f.state().get(f.workId), before);
    f.release(); const result = await survivor; assert.equal(result.kind, 'settled'); assert.equal(result.joined, true); assert.equal(f.calls(), 1);
  });

  test(`${adapter}: an already aborted caller cannot create an execution`, async t => {
    const f = await fixture(t, adapter); const before = (await f.state().get(f.workId))!; const abort = new AbortController(); abort.abort();
    assert.equal((await f.facade.execute(f.workId, f.attempt.id, abort.signal)).kind, 'detached');
    assert.equal(f.calls(), 0); assert.deepEqual(await f.state().get(f.workId), before);
  });

  test(`${adapter}: another facade observes durable running and settled states without claiming local promise ownership`, async t => {
    const f = await fixture(t, adapter); const active = f.facade.execute(f.workId, f.attempt.id); await f.entered;
    const other = await f.compose(); const facade = new ExecutionJoin(other.services, other.runtime);
    const waiting = await facade.execute(f.workId, f.attempt.id);
    assert.equal(waiting.kind, 'waiting'); if (waiting.kind !== 'waiting') throw new Error('expected_durable_wait');
    assert.equal(waiting.reason, 'running_without_local_flight'); assert.equal(waiting.dispatched, true); assert.equal(waiting.joined, false); assert.equal(f.calls(), 1);
    f.release(); await active; const settled = await facade.execute(f.workId, f.attempt.id);
    assert.equal(settled.kind, 'settled'); assert.equal(settled.joined, false); assert.equal(f.calls(), 1);
  });

  test(`${adapter}: a different owner and an expired reservation remain explicit waits without lease renewal or automatic recovery`, async t => {
    const f = await fixture(t, adapter); const other = await f.compose('different-owner'); const before = (await f.state().get(f.workId))!;
    const denied = await new ExecutionJoin(other.services, other.runtime).execute(f.workId, f.attempt.id);
    assert.equal(denied.kind, 'waiting'); if (denied.kind !== 'waiting') throw new Error('expected_owner_wait'); assert.equal(denied.reason, 'different_owner');
    f.clock.advance(f.attempt.leaseUntil - f.clock.now()); const expired = await f.facade.execute(f.workId, f.attempt.id);
    assert.equal(expired.kind, 'waiting'); if (expired.kind !== 'waiting') throw new Error('expected_expired_wait'); assert.equal(expired.reason, 'lease_expired');
    assert.equal(expired.dispatched, false); assert.deepEqual(await f.state().get(f.workId), before); assert.equal(f.calls(), 0);
    await f.c.runtime.recover(f.workId, f.attempt.id); const recovered = await f.facade.execute(f.workId, f.attempt.id);
    assert.equal(recovered.kind, 'settled'); if (recovered.kind !== 'settled') throw new Error('expected_expired_reservation'); assert.equal(recovered.status, 'failed');
    const recoveredState = (await f.state().get(f.workId))!;
    assert.equal(recoveredState.attempts.find(a => a.id === f.attempt.id)!.error?.code, 'reservation_expired');
    assert.equal(recoveredState.budget.used.toolCalls, 0); assert.equal(recoveredState.budget.reservedToolCalls, 0);
  });

  test(`${adapter}: reopening a dispatched write never replays it and explicit recovery retains the unknown effect obligation`, async t => {
    const f = await fixture(t, adapter, 'write'); await f.c.runtime.dispatch(f.workId, f.attempt.id);
    const before = (await f.state().get(f.workId))!; const reopened = await f.reopen(); const facade = new ExecutionJoin(reopened.services, reopened.runtime);
    const waiting = await facade.execute(f.workId, f.attempt.id); assert.equal(waiting.kind, 'waiting');
    if (waiting.kind !== 'waiting') throw new Error('expected_durable_dispatch'); assert.equal(waiting.dispatched, true); assert.equal(waiting.effectState, 'unknown');
    assert.deepEqual(await f.state().get(f.workId), before); assert.equal(f.calls(), 0);
    f.clock.advance(f.attempt.leaseUntil - f.clock.now()); const expired = await facade.execute(f.workId, f.attempt.id);
    assert.equal(expired.kind, 'waiting'); assert.equal(f.calls(), 0);
    await reopened.runtime.recover(f.workId, f.attempt.id); const unknown = await facade.execute(f.workId, f.attempt.id);
    assert.equal(unknown.kind, 'settled'); if (unknown.kind !== 'settled') throw new Error('expected_unknown_execution');
    assert.equal(unknown.status, 'unknown'); assert.equal(unknown.effectState, 'unknown'); assert.equal(unknown.hasResultArtifact, false);
    const state = (await f.state().get(f.workId))!;
    assert.equal(state.obligations.find(o => o.id === `effect:${f.attempt.id}`)!.status, 'pending'); assert.equal(state.budget.used.toolCalls, 1); assert.equal(f.calls(), 0);
  });

  test(`${adapter}: reopening after a stored result reports received without executing or adopting it again`, async t => {
    const f = await fixture(t, adapter); f.release(); const first = await f.facade.execute(f.workId, f.attempt.id); assert.equal(first.kind, 'settled');
    const before = (await f.state().get(f.workId))!; const reopened = await f.reopen();
    const result = await new ExecutionJoin(reopened.services, reopened.runtime).execute(f.workId, f.attempt.id);
    assert.equal(result.kind, 'settled'); if (result.kind !== 'settled') throw new Error('expected_stored_result');
    assert.equal(result.status, 'received'); assert.equal(result.dispatched, true); assert.equal(result.hasResultArtifact, true); assert.equal(result.joined, false);
    assert.deepEqual(await f.state().get(f.workId), before); assert.equal(f.calls(), 1);
  });

  test(`${adapter}: state changes during receipt lookup are reread before the facade decides to execute`, async t => {
    const f = await fixture(t, adapter); let fired = false; let executions = 0;
    const state = statePort(f.state(), { receipt: async (...args) => {
      const receipt = await f.state().receipt(...args);
      if (!fired) { fired = true; await f.c.runtime.command(f.workId, 'cancel-during-read', actor, 1, { kind: 'cancel', reason: 'Synthetic read race' }); }
      return receipt;
    } });
    const facade = new ExecutionJoin({ ...f.c.services, state }, { owner: f.c.runtime.owner, execute: async (...args) => { executions++; await f.c.runtime.execute(...args); } });
    const result = await facade.execute(f.workId, f.attempt.id);
    assert.equal(fired, true); assert.equal(result.kind, 'settled'); if (result.kind !== 'settled') throw new Error('expected_cancelled_state');
    assert.equal(result.status, 'cancelled'); assert.equal(result.revision, (await f.state().get(f.workId))!.revision); assert.equal(executions, 0); assert.equal(f.calls(), 0);
  });

  test(`${adapter}: a reporting read error after successful execution is shared as an error and retry only observes the durable result`, async t => {
    const f = await fixture(t, adapter); let failNextRead = false; let executions = 0;
    const state = statePort(f.state(), { get: async id => { if (failNextRead) { failNextRead = false; throw new Error('synthetic_join_read_failed'); } return f.state().get(id); } });
    const facade = new ExecutionJoin({ ...f.c.services, state }, { owner: f.c.runtime.owner, execute: async (...args) => {
      executions++; await f.c.runtime.execute(...args); failNextRead = true;
    } });
    const first = facade.execute(f.workId, f.attempt.id); const second = facade.execute(f.workId, f.attempt.id);
    const failures = Promise.all([assert.rejects(first, /synthetic_join_read_failed/), assert.rejects(second, /synthetic_join_read_failed/)]);
    await f.entered; f.release(); await failures;
    assert.equal((await f.state().get(f.workId))!.attempts[0]!.status, 'received');
    const retry = await facade.execute(f.workId, f.attempt.id); assert.equal(retry.kind, 'settled'); assert.equal(retry.joined, false);
    assert.equal(executions, 1); assert.equal(f.calls(), 1);
  });
}
