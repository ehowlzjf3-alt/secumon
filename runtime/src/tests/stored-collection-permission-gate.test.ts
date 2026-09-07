import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { ArtifactRef, TaskSpec, WorkState } from '../domain/model.js';
import type { CommitRequest, Tool } from '../application/ports.js';
import { ScriptedPlanner } from '../infrastructure/fakes.js';
import { createMcpCollectionCustodyFixture } from './mcp-collection-custody-fixture.js';
import { originals } from './mcp-collection-accounting-fixture.js';

// Real SQLite, artifacts, Broker and checkpoint settlement; the reused transport supplies fixed decoded data.
async function terminalCollection(t: TestContext) {
  const f = await createMcpCollectionCustodyFixture(t), p = await f.prepare();
  const result = await f.invoke(p.attempt.id); assert.equal(result.status, 'success');
  const running = await f.current(), head = running.attempts[0]!.readProgress!.head;
  assert.equal(running.attempts[0]!.readProgress!.phase, 'complete');
  assert.equal(running.attempts[0]!.resultArtifact, null);
  f.setNow(p.attempt.leaseUntil + 1);
  assert.deepEqual(await f.composed.runtime.settleStoredCollection(p.workId), {
    kind: 'continue', action: 'recover', id: p.attempt.id, reason: 'stored_collection_expired',
  });
  const state = await f.current();
  assert.equal(state.attempts[0]!.status, 'failed'); assert.equal(state.attempts[0]!.error?.code, 'lease_expired');
  assert.deepEqual(state.attempts[0]!.readProgress!.head, head); assert.equal(state.attempts[0]!.readProgress!.unknownCalls, 0);
  assert.deepEqual(f.composed.runtime.control(state), { kind: 'replan', reason: 'plan_cannot_complete_goal' });
  assert.equal(f.counters.calls, 1); assert.equal(state.budget.used.toolCalls, 1);
  const originalPolicy = structuredClone(state.policy);
  const custody = async () => ({ responses: await originals(f),
    head: Buffer.from(await f.services.artifacts.get(head, originalPolicy)),
    dispatch: await f.services.state.receipt(p.workId, `dispatch:${p.attempt.id}`),
    headReceipt: await f.services.state.receipt(p.workId, `read:${p.attempt.id}:${head.id}`) });
  const witness = async () => ({ state: await f.current(), events: await f.services.state.events(p.workId, 0),
    deliveries: await f.services.state.deliveries(p.workId), custody: await custody() });
  return { f, p, head, originalPolicy, custody, witness };
}
type Fixture = Awaited<ReturnType<typeof terminalCollection>>;
const denied = (h: Fixture) => h.f.mutate(state => { state.policy.allowedTools = []; });
async function submit(h: Fixture, tasks: TaskSpec[], id: string) {
  const state = await h.f.current();
  await h.f.composed.runtime.submitPlan(h.p.workId, id, { baseStateRevision: state.revision,
    baseGoalRevision: state.goal.revision, basePlanRevision: state.plan!.revision,
    reason: 'Select a current task independently of the old collection tip.', hypotheses: [], tasks });
}
function noModel(h: Fixture) {
  assert.ok(h.f.services.planner instanceof ScriptedPlanner); assert.equal(h.f.services.planner.inputs.length, 0);
}

test('stored collection permission gate blocks the denied terminal tip once without changing custody or accounting', { timeout: 20000 }, async t => {
  const h = await terminalCollection(t); await denied(h);
  const before = await h.witness(), calls = { ...h.f.counters };
  assert.equal(h.f.composed.contracts.check(h.p.task, before.state.policy), 'tool_permission_denied');
  assert.deepEqual(h.f.composed.runtime.control(before.state), { kind: 'replan', reason: 'plan_cannot_complete_goal' });
  assert.deepEqual(await h.f.composed.runtime.settleStoredCollection(h.p.workId),
    { kind: 'continue', action: 'recover', id: h.p.attempt.id, reason: 'stored_collection_permission_checked' });
  const after = await h.witness(); assert.equal(after.state.status, 'blocked'); assert.equal(after.state.statusReason, 'tool_permission_denied');
  assert.deepEqual({ ...after.state, revision: before.state.revision, updatedAt: before.state.updatedAt,
    status: before.state.status, statusReason: before.state.statusReason, retryWakeAt: before.state.retryWakeAt }, before.state);
  assert.deepEqual(after.custody, before.custody); assert.deepEqual(after.deliveries, before.deliveries);
  assert.deepEqual(after.events.slice(0, -1), before.events); assert.equal(after.events.at(-1)!.type, 'execution_gate_rejected');
  assert.equal(after.state.attempts[0]!.adopted, false); assert.equal(after.state.attempts[0]!.resultArtifact, null);
  assert.equal(await h.f.composed.runtime.settleStoredCollection(h.p.workId), null);
  assert.deepEqual(await h.witness(), after); assert.deepEqual(h.f.counters, calls); noModel(h);
});

test('stored collection permission gate ignores an old plan, goal, scope or different current task input', { timeout: 30000 }, async t => {
  for (const boundary of ['plan', 'goal', 'scope', 'input'] as const) {
    const h = await terminalCollection(t);
    if (boundary === 'plan') await submit(h, [], 'drop-old-collection');
    else await h.f.mutate(state => {
      // Isolate the gate's current snapshot checks; these edits do not grant execution or rewrite original receipts.
      if (boundary === 'goal') state.goal.revision++;
      if (boundary === 'scope') state.goal.scope = 'another-work-scope';
      if (boundary === 'input') state.plan!.tasks[0]!.input = { ids: ['different-record'] };
    });
    await denied(h); const before = await h.witness(), calls = { ...h.f.counters };
    assert.equal(await h.f.composed.runtime.settleStoredCollection(h.p.workId), null, boundary);
    assert.deepEqual(await h.witness(), before, boundary); assert.deepEqual(h.f.counters, calls); noModel(h);
  }
});

test('stored collection permission gate does not block a superseded parent after its explicit successor has settled', { timeout: 25000 }, async t => {
  const h = await terminalCollection(t);
  const successor: TaskSpec = { ...structuredClone(h.p.task), id: 'consume-complete',
    readResume: { attemptId: h.p.attempt.id, checkpointId: h.head.id } };
  await submit(h, [h.p.task, successor], 'consume-existing-collection');
  const child = await h.f.composed.runtime.reserve(h.p.workId, successor.id);
  await h.f.composed.runtime.execute(h.p.workId, child.id); await h.f.composed.runtime.settlePending(child.id);
  await h.f.composed.runtime.adopt(h.p.workId, child.id);
  const settled = await h.f.current(), parent = settled.attempts.find(value => value.id === h.p.attempt.id)!;
  assert.equal(parent.readProgress!.successorAttemptId, child.id);
  assert.equal(settled.attempts.find(value => value.id === child.id)!.adopted, true);
  assert.equal(h.f.counters.calls, 1, 'the explicit complete successor consumes the stored page without another call');
  await denied(h); const before = await h.witness(), calls = { ...h.f.counters };
  assert.deepEqual(h.f.composed.runtime.control(before.state), { kind: 'replan', reason: 'plan_cannot_complete_goal' });
  assert.equal(await h.f.composed.runtime.settleStoredCollection(h.p.workId), null);
  assert.deepEqual(await h.witness(), before); assert.deepEqual(h.f.counters, calls); noModel(h);
});

test('stored collection permission gate leaves an independent permitted task runnable', { timeout: 20000 }, async t => {
  const h = await terminalCollection(t); let calls = 0;
  const tool: Tool = { definition: { provider: 'independent', id: 'independent.read', version: '1', description: 'Independent local read',
    effect: 'read', destination: 'local', labels: ['synthetic'], inputSchema: { type: 'object' }, outputSchema: { type: 'object' } },
    async execute(_task, context) { calls++; return { resultId: `${context.attemptId}:result`, attemptId: context.attemptId,
      status: 'success', effectState: 'none', evidence: [], artifacts: [], output: {}, error: null, cursor: null, coverage: 'complete' }; } };
  h.f.composed.contracts.replaceProvider('independent', [tool], { expectedEpoch: 0, sourceRevision: '1' });
  await h.f.mutate(state => { state.policy.allowedTools.push(tool.definition.id); });
  const task: TaskSpec = { id: 'independent', description: 'Continue independent work', toolId: tool.definition.id, toolVersion: '1',
    input: {}, effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: [] };
  await submit(h, [h.p.task, task], 'independent-plan');
  await h.f.mutate(state => { state.policy.allowedTools = [tool.definition.id]; });
  const before = await h.witness(), counters = { ...h.f.counters };
  assert.deepEqual(h.f.composed.runtime.control(before.state), { kind: 'continue', action: 'reserve', id: task.id, reason: 'task_ready' });
  assert.equal(await h.f.composed.runtime.settleStoredCollection(h.p.workId), null); assert.deepEqual(await h.witness(), before);
  const next = await h.f.composed.runtime.reserve(h.p.workId, task.id);
  await h.f.composed.runtime.execute(h.p.workId, next.id); await h.f.composed.runtime.settlePending(next.id);
  assert.equal(calls, 1); assert.deepEqual((await h.f.current()).attempts[0], before.state.attempts[0]);
  assert.deepEqual(await h.custody(), before.custody); assert.deepEqual(h.f.counters, counters); noModel(h);
});

test('stored collection permission gate preserves explicit cancelled and paused work states', { timeout: 25000 }, async t => {
  for (const kind of ['cancel', 'pause'] as const) {
    const h = await terminalCollection(t); await denied(h); const current = await h.f.current();
    await h.f.composed.runtime.command(h.p.workId, `user-${kind}`, { tenantId: current.policy.tenantId, principalId: current.policy.principalId },
      current.goal.revision, { kind, reason: `Explicit ${kind} remains authoritative` });
    const before = await h.witness(), calls = { ...h.f.counters };
    assert.equal(before.state.status, kind === 'cancel' ? 'cancelled' : 'paused');
    assert.equal(await h.f.composed.runtime.settleStoredCollection(h.p.workId), null);
    assert.deepEqual(await h.witness(), before); assert.deepEqual(h.f.counters, calls); noModel(h);
  }
});

test('stored collection permission gate rechecks restored policy and replaced registration before publication', { timeout: 30000 }, async t => {
  for (const change of ['policy', 'registration'] as const) {
    const h = await terminalCollection(t); await h.f.mutate(state => { state.policy.allowedLabels = []; });
    const before = await h.witness(), calls = { ...h.f.counters };
    const entry = h.f.composed.contracts.get(h.p.task.toolId, h.p.task.toolVersion)!;
    assert.equal(h.f.composed.contracts.check(h.p.task, before.state.policy), 'tool_permission_denied');
    const receipt = h.f.services.state.receipt.bind(h.f.services.state), exists = h.f.services.artifacts.exists.bind(h.f.services.artifacts);
    const commit = h.f.services.state.commit.bind(h.f.services.state);
    let armed = false, changed = false, publications = 0, expected: WorkState = before.state;
    const receipts = t.mock.method(h.f.services.state, 'receipt', async (workId: string, commandId: string) => {
      const value = await receipt(workId, commandId);
      if (workId === h.p.workId && commandId.startsWith(`collection-permission:${h.p.attempt.id}:`)) armed = true;
      return value;
    });
    const reads = t.mock.method(h.f.services.artifacts, 'exists', async (ref: ArtifactRef) => {
      const value = await exists(ref);
      if (armed && !changed) {
        changed = true;
        if (change === 'policy') await h.f.mutate(state => { state.policy.allowedLabels = [...h.originalPolicy.allowedLabels]; });
        else h.f.composed.contracts.replaceProvider(entry.tool.definition.provider,
          [{ ...entry.tool, definition: { ...entry.tool.definition, labels: [] } }],
          { expectedEpoch: h.f.composed.contracts.providerEpoch(entry.tool.definition.provider), sourceRevision: 'replacement' });
        expected = await h.f.current();
      }
      return value;
    });
    const commits = t.mock.method(h.f.services.state, 'commit', async (request: CommitRequest) => {
      if (request.next.status === 'blocked' && request.next.statusReason === 'tool_permission_denied') publications++;
      return commit(request);
    });
    try {
      await assert.rejects(h.f.composed.runtime.settleStoredCollection(h.p.workId), { message: 'control_stale' });
      assert.equal(armed, true); assert.equal(changed, true, 'the gate was selected before its artifact dependency await changed authority');
      assert.equal(publications, 0); assert.deepEqual(await h.f.current(), expected);
      assert.deepEqual(expected.attempts, before.state.attempts); assert.deepEqual(expected.budget, before.state.budget);
      assert.deepEqual(await h.custody(), before.custody); assert.deepEqual(h.f.counters, calls);
    } finally { commits.mock.restore(); reads.mock.restore(); receipts.mock.restore(); }
    assert.equal(h.f.composed.contracts.check(h.p.task, (await h.f.current()).policy), null);
    const stable = await h.witness(); assert.equal(await h.f.composed.runtime.settleStoredCollection(h.p.workId), null);
    assert.deepEqual(await h.witness(), stable); noModel(h);
  }
});
