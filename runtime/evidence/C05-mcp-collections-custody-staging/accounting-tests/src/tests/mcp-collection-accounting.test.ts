import test from 'node:test';
import assert from 'node:assert/strict';
import type { TaskSpec } from '../domain/model.js';
import { toolExecution, summarizeToolExecution } from '../application/tool-execution-usage.js';
import { createMcpCollectionCustodyFixture } from './mcp-collection-custody-fixture.js';
import { adapters } from './state-conformance-helpers.js';
import { accountingRuntime, authorizeOwner, inspected, onlyAccountingChanged, originals, owner, selected,
  usageEvents, withHeldSecondCollection } from './mcp-collection-accounting-fixture.js';

const measured = (transportCalls: number | null) => toolExecution('invoked', {
  transportCalls, internalOperations: null, imageBytes: null, waitMs: null,
});

for (const backend of adapters) {
  test(`${backend}: one closed original call set refines unknown to known when its late page receipt arrives`, { timeout: 45000 }, async t => {
    await withHeldSecondCollection(t, backend, async ({ f, prepared, second, release, completed }) => {
      const runtime = accountingRuntime(f), active = await f.current();
      assert.equal(await runtime.recordStoredUsage(prepared.workId, prepared.attempt.id), null);
      assert.deepEqual(await f.current(), active); assert.deepEqual(await usageEvents(f), []);
      await f.composed.runtime.command(prepared.workId, 'pause-before-accounting', owner(active), active.goal.revision,
        { kind: 'pause', reason: 'Keep original work paused while completing accounting' });
      f.setNow(prepared.attempt.leaseUntil + 1);
      const before = await f.current(), head = structuredClone(selected(before, prepared.attempt.id).readProgress!.head);
      const firstRequest = [...f.requests.values()][0]!, firstReceipt = await f.response(firstRequest);
      const firstBytes = Buffer.from((await f.raw(firstRequest)).bytes);
      assert.equal(await f.response(second), null);
      const partial = await runtime.recordStoredUsage(prepared.workId, prepared.attempt.id); assert.ok(partial);
      onlyAccountingChanged(before, partial, prepared.attempt.id);
      assert.deepEqual(selected(partial, prepared.attempt.id).execution, measured(null));
      assert.equal((await usageEvents(f)).length, 1); assert.equal(partial.budget.used.toolCalls, 1);
      const old = await inspected(f, prepared.attempt.id);
      const oldTicket = await old.helper.prepareUsage(old.state, old.inspection); assert.ok(oldTicket);
      assert.equal(oldTicket.usage.transportCalls, null);

      const beforeRelease = { ...f.counters }; release();
      assert.equal((await completed).kind, 'failed', 'pause prevents page use after the late receipt is kept');
      assert.ok(await f.response(second)); const late = await f.current();
      assert.deepEqual(selected(late, prepared.attempt.id).readProgress!.head, head, 'the original call set and head did not change');
      assert.deepEqual(selected(late, prepared.attempt.id).execution, measured(null));
      await assert.rejects(old.helper.assertCurrent(late, oldTicket), /stored_read_usage_ticket_invalid|stored_read_usage_changed/);
      assert.equal(f.counters.calls, beforeRelease.calls); assert.equal(f.counters.projections, beforeRelease.projections);
      const counters = { ...f.counters }, saved = await originals(f);
      const pass = await runtime.reconcileStoredUsages(prepared.workId, authorizeOwner(late));
      assert.deepEqual(pass.changed, [prepared.attempt.id], 'the previous null usage receipt must not skip this newly proved response');
      const final = await f.current(); onlyAccountingChanged(late, final, prepared.attempt.id);
      assert.deepEqual(selected(final, prepared.attempt.id).execution, measured(2));
      assert.equal(final.status, 'paused'); assert.equal(final.budget.used.toolCalls, 1); assert.equal(final.budget.reservedToolCalls, 0);
      assert.equal(selected(final, prepared.attempt.id).owner, prepared.attempt.owner);
      assert.equal(selected(final, prepared.attempt.id).leaseUntil, prepared.attempt.leaseUntil);
      assert.equal(selected(final, prepared.attempt.id).resultArtifact, null); assert.equal(selected(final, prepared.attempt.id).adopted, false);
      assert.deepEqual(summarizeToolExecution(final).transportCalls, { measured: 2, unknown: 0 });
      assert.equal((await usageEvents(f)).length, 2, 'unknown receipt then refinement, never addition of a third invocation');
      assert.deepEqual(await f.response(firstRequest), firstReceipt); assert.deepEqual(Buffer.from((await f.raw(firstRequest)).bytes), firstBytes);
      const events = await usageEvents(f), receipts = await Promise.all(events.map(event => f.services.state.receipt(prepared.workId, event.commandId)));
      assert.deepEqual((await runtime.reconcileStoredUsages(prepared.workId, authorizeOwner(final))).changed, []);
      assert.deepEqual(await runtime.recordStoredUsage(prepared.workId, prepared.attempt.id), final);
      assert.deepEqual(await f.current(), final); assert.deepEqual(await usageEvents(f), events);
      assert.deepEqual(await Promise.all(events.map(event => f.services.state.receipt(prepared.workId, event.commandId))), receipts);
      assert.deepEqual(await originals(f), saved); assert.deepEqual(f.counters, counters);
    });
  });

  test(`${backend}: two accountants publish one collection usage receipt and preserve the original unreceived result`, { timeout: 30000 }, async t => {
    const f = await createMcpCollectionCustodyFixture(t, backend), p = await f.prepare(); await f.invoke(p.attempt.id);
    f.setNow(p.attempt.leaseUntil); const before = await f.current(), saved = await originals(f), counters = { ...f.counters };
    const left = accountingRuntime(f, 'accountant-left'), right = accountingRuntime(f, 'accountant-right');
    const commit = f.services.state.commit.bind(f.services.state);
    let arrivals = 0, timedOut = false, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const timer = setTimeout(() => { timedOut = true; release(); }, 10000);
    const mock = t.mock.method(f.services.state, 'commit', async request => {
      if (request.commandId.startsWith(`tool-usage:${p.attempt.id}:`)) {
        if (++arrivals === 2) release(); await gate;
      }
      return commit(request);
    });
    const attempts = [left.recordStoredUsage(p.workId, p.attempt.id), right.recordStoredUsage(p.workId, p.attempt.id)];
    try {
      const [a, b] = await Promise.all(attempts); assert.ok(a && b); assert.deepEqual(a, b);
      assert.equal(arrivals, 2); assert.equal(timedOut, false);
    } finally { release(); clearTimeout(timer); await Promise.allSettled(attempts); mock.mock.restore(); }
    const final = await f.current(); onlyAccountingChanged(before, final, p.attempt.id);
    assert.deepEqual(selected(final, p.attempt.id).execution, measured(1)); assert.equal((await usageEvents(f)).length, 1);
    assert.equal(final.budget.used.toolCalls, 1); assert.equal(selected(final, p.attempt.id).resultArtifact, null);
    assert.deepEqual(await originals(f), saved); assert.deepEqual(f.counters, counters);
  });
}

test('a successor charges only its own new page and keeps the parent result and original receipts unchanged', { timeout: 30000 }, async t => {
  const f = await createMcpCollectionCustodyFixture(t, 'sqlite', { family: 'observations' }), p = await f.prepare();
  f.controls.afterCapture = async () => { if (f.requests.size === 2) f.controls.callMode = 'captured-failure'; };
  const parentResult = await f.invoke(p.attempt.id); assert.equal(parentResult.status, 'partial');
  await f.composed.runtime.receive(p.workId, p.attempt.id, parentResult);
  await f.composed.runtime.adopt(p.workId, p.attempt.id);
  const parentBefore = await f.current(), parent = selected(parentBefore, p.attempt.id); assert.equal(parent.status, 'partial');
  assert.ok(parent.resultArtifact);
  const parentBytes = Buffer.from(await f.services.artifacts.get(parent.resultArtifact, parentBefore.policy));
  const receive = await f.services.state.receipt(p.workId, `receive:${p.attempt.id}`), adopt = await f.services.state.receipt(p.workId, `adopt:${p.attempt.id}`);
  const runtime = accountingRuntime(f); const parentAccounted = await runtime.recordStoredUsage(p.workId, p.attempt.id); assert.ok(parentAccounted);
  onlyAccountingChanged(parentBefore, parentAccounted, p.attempt.id); assert.deepEqual(selected(parentAccounted, p.attempt.id).execution, measured(2));

  f.controls.afterCapture = undefined; f.controls.callMode = 'returned';
  const task: TaskSpec = { ...p.task, id: 'explicit-successor',
    readResume: { attemptId: p.attempt.id, checkpointId: parent.readProgress!.head.id } };
  const basis = await f.current();
  await f.composed.runtime.submitPlan(p.workId, 'successor-plan', { baseStateRevision: basis.revision, baseGoalRevision: basis.goal.revision,
    basePlanRevision: basis.plan!.revision, reason: 'Read only the remaining original page', tasks: [task], hypotheses: [] });
  const child = await f.composed.runtime.reserve(p.workId, task.id); assert.equal(await f.composed.runtime.dispatch(p.workId, child.id), true);
  const childResult = await f.invoke(child.id); assert.equal(childResult.status, 'success'); assert.equal(childResult.usage!.transportCalls, 1);
  await f.composed.runtime.receive(p.workId, child.id, childResult);
  const childBefore = await f.current(), childRef = selected(childBefore, child.id).resultArtifact; assert.ok(childRef);
  const childBytes = Buffer.from(await f.services.artifacts.get(childRef, childBefore.policy)), counters = { ...f.counters }, saved = await originals(f);
  const proof = await inspected(f, child.id), ticket = await proof.helper.prepareUsage(proof.state, proof.inspection); assert.ok(ticket);
  assert.equal(ticket.usage.transportCalls, 1); assert.equal(selected(proof.state, child.id).readProgress!.callCount, 3);
  const childAccounted = await runtime.recordStoredUsage(p.workId, child.id); assert.ok(childAccounted);
  onlyAccountingChanged(childBefore, childAccounted, child.id); assert.deepEqual(selected(childAccounted, child.id).execution, measured(1));
  assert.deepEqual(selected(childAccounted, p.attempt.id).execution, measured(2));
  assert.deepEqual(summarizeToolExecution(childAccounted).transportCalls, { measured: 3, unknown: 0 });
  assert.equal(childAccounted.budget.used.toolCalls, 2);
  assert.deepEqual(await f.services.state.receipt(p.workId, `receive:${p.attempt.id}`), receive);
  assert.deepEqual(await f.services.state.receipt(p.workId, `adopt:${p.attempt.id}`), adopt);
  assert.deepEqual(Buffer.from(await f.services.artifacts.get(parent.resultArtifact, childAccounted.policy)), parentBytes);
  assert.deepEqual(Buffer.from(await f.services.artifacts.get(childRef, childAccounted.policy)), childBytes);
  assert.deepEqual(await originals(f), saved); assert.deepEqual(f.counters, counters);
});

test('a contradictory known collection total rejects accounting without rewriting the result or adding an event', { timeout: 20000 }, async t => {
  const f = await createMcpCollectionCustodyFixture(t), p = await f.prepare(); const result = await f.invoke(p.attempt.id);
  await f.composed.runtime.receive(p.workId, p.attempt.id, result);
  await f.mutate(state => { selected(state, p.attempt.id).execution = measured(2); });
  const before = await f.current(), saved = await originals(f), events = await usageEvents(f), counters = { ...f.counters };
  await assert.rejects(accountingRuntime(f).recordStoredUsage(p.workId, p.attempt.id), /tool_execution_usage_conflict/);
  assert.deepEqual(await f.current(), before); assert.deepEqual(await originals(f), saved); assert.deepEqual(await usageEvents(f), events);
  assert.deepEqual(f.counters, counters);
});
