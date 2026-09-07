import test from 'node:test';
import assert from 'node:assert/strict';
import type { Attempt, ToolExecution, WorkState } from '../domain/model.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { summarizeToolExecution, toolExecution } from '../application/tool-execution-usage.js';
import { createMcpResponseCustodyFixture, type McpResponseCustodyFixture } from './mcp-response-custody-fixture.js';
import { adapters } from './state-conformance-helpers.js';

const reported = (): ToolExecution => toolExecution('invoked', { transportCalls: 1, internalOperations: null, imageBytes: null, waitMs: null });
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function selected(state: WorkState, attemptId: string): Attempt {
  const value = state.attempts.find(attempt => attempt.id === attemptId); assert.ok(value); return value;
}
function onlyAccountingChanged(before: WorkState, after: WorkState, attemptId: string) {
  const normalized = structuredClone(after); normalized.revision = before.revision; normalized.updatedAt = before.updatedAt;
  const prior = selected(before, attemptId), current = selected(normalized, attemptId);
  if (prior.execution) current.execution = structuredClone(prior.execution); else delete current.execution;
  assert.deepEqual(normalized, before, 'only the original attempt measurement and transaction revision/time may change');
}
const usageEvents = async (f: McpResponseCustodyFixture) =>
  (await f.services.state.events(f.work.id, 0)).filter(event => event.type === 'tool_execution_usage_recorded');
async function body(f: McpResponseCustodyFixture, state: WorkState, attemptId: string) {
  const ref = selected(state, attemptId).resultArtifact; assert.ok(ref);
  return { ref, bytes: await f.services.artifacts.get(ref, f.work.policy) };
}

for (const backend of adapters) {
  test(`${backend}: reopened usage custody refines the original attempt once without invoking or projecting`, async t => {
    const f = await createMcpResponseCustodyFixture(t, backend), { attempt } = await f.prepare();
    f.controls.callMode = 'captured-failure';
    await assert.rejects(f.invoke(attempt.id), error => error === f.errors.captured);
    const response = await f.response(attempt.id); assert.ok(response);
    const raw = f.rawRef(); assert.ok(raw); const original = await f.raw(raw), before = await f.current();
    assert.deepEqual(selected(before, attempt.id).execution, toolExecution('unreported'));
    assert.equal(selected(before, attempt.id).resultArtifact, null); assert.equal(f.counters.projections, 0);
    const originalCounters = structuredClone(f.counters);
    await f.reopen();
    const contracts = new ToolContracts([f.reader()], f.schemas);
    const resumed = new ExecutionRuntime(f.services, contracts, 'reopened-accountant');
    const after = await resumed.recordStoredUsage(f.work.id, attempt.id); assert.ok(after);
    assert.deepEqual(selected(after, attempt.id).execution, reported()); onlyAccountingChanged(before, after, attempt.id);
    assert.equal(selected(after, attempt.id).owner, attempt.owner); assert.equal(selected(after, attempt.id).leaseUntil, attempt.leaseUntil);
    assert.equal(after.budget.used.toolCalls, 1); assert.equal(after.budget.reservedToolCalls, 0);
    assert.deepEqual(summarizeToolExecution(after).transportCalls, { measured: 1, unknown: 0 });
    assert.deepEqual(summarizeToolExecution(after).internalOperations, { measured: 0, unknown: 1 });
    assert.deepEqual(await f.response(attempt.id), response); assert.deepEqual((await f.raw(raw)).bytes, original.bytes);
    const events = await usageEvents(f); assert.equal(events.length, 1);
    const receipt = await f.services.state.receipt(f.work.id, events[0]!.commandId); assert.ok(receipt);
    assert.deepEqual(await resumed.recordStoredUsage(f.work.id, attempt.id), after);
    assert.deepEqual(await f.services.state.receipt(f.work.id, events[0]!.commandId), receipt);
    assert.deepEqual(await usageEvents(f), events); assert.deepEqual(f.counters, originalCounters);
    assert.equal(await f.services.state.receipt(f.work.id, `receive:${attempt.id}`), null);
  });

  test(`${backend}: two runtime accountants converge through one real usage receipt and never sum a transport measurement`, async t => {
    const f = await createMcpResponseCustodyFixture(t, backend), { attempt } = await f.prepare();
    f.controls.callMode = 'captured-failure'; await assert.rejects(f.invoke(attempt.id), error => error === f.errors.captured);
    const before = await f.current(), originalCounters = structuredClone(f.counters);
    const left = new ExecutionRuntime(f.services, f.contracts, 'accountant-left');
    const right = new ExecutionRuntime(f.services, f.contracts, 'accountant-right');
    const commit = f.services.state.commit.bind(f.services.state);
    let arrivals = 0, release!: () => void; const both = new Promise<void>(resolve => { release = resolve; });
    f.services.state.commit = async request => {
      if (request.commandId.startsWith(`tool-usage:${attempt.id}:`)) {
        arrivals++; if (arrivals === 2) release(); await both;
      }
      return commit(request);
    };
    try {
      const [a, b] = await Promise.all([left.recordStoredUsage(f.work.id, attempt.id), right.recordStoredUsage(f.work.id, attempt.id)]);
      assert.ok(a && b); assert.equal(arrivals, 2, 'both transactions reached the same actual storage boundary');
      assert.deepEqual(a, b);
    } finally { release(); }
    const after = await f.current(); onlyAccountingChanged(before, after, attempt.id);
    assert.deepEqual(selected(after, attempt.id).execution, reported()); assert.equal((await usageEvents(f)).length, 1);
    assert.equal(after.budget.used.toolCalls, 1); assert.deepEqual(f.counters, originalCounters);
  });

  test(`${backend}: usage accounting preserves existing received, adopted and failed result bytes and receipts`, async t => {
    for (const phase of ['received', 'adopted', 'failed'] as const) {
      const f = await createMcpResponseCustodyFixture(t, backend), { attempt } = await f.prepare();
      if (phase === 'failed') f.controls.callMode = 'sent-true';
      const result = await f.invoke(attempt.id);
      // The historical public receive default leaves implementationCalls unknown even when transport usage exists.
      await f.runtime.receive(f.work.id, attempt.id, result);
      if (phase !== 'received') await f.runtime.adopt(f.work.id, attempt.id);
      const before = await f.current(), prior = selected(before, attempt.id);
      assert.ok(prior.execution); assert.equal(prior.execution.mode, 'unreported'); assert.equal(prior.execution.implementationCalls, null);
      assert.equal(prior.status, phase === 'received' ? 'received' : phase === 'adopted' ? 'succeeded' : 'failed');
      assert.equal(prior.adopted, phase === 'adopted');
      const original = await body(f, before, attempt.id), response = await f.response(attempt.id);
      const receive = await f.services.state.receipt(f.work.id, `receive:${attempt.id}`);
      const adopt = await f.services.state.receipt(f.work.id, `adopt:${attempt.id}`);
      const counters = structuredClone(f.counters);
      const after = await f.runtime.recordStoredUsage(f.work.id, attempt.id); assert.ok(after);
      onlyAccountingChanged(before, after, attempt.id); assert.deepEqual(selected(after, attempt.id).execution, reported());
      assert.deepEqual(await body(f, after, attempt.id), original);
      assert.deepEqual(await f.response(attempt.id), response);
      assert.deepEqual(await f.services.state.receipt(f.work.id, `receive:${attempt.id}`), receive);
      assert.deepEqual(await f.services.state.receipt(f.work.id, `adopt:${attempt.id}`), adopt);
      assert.deepEqual(f.counters, counters); assert.equal((await usageEvents(f)).length, 1);
    }
  });
}

test('contradictory known usage refuses accounting without rewriting the result or adding a receipt', async t => {
  const f = await createMcpResponseCustodyFixture(t), { attempt } = await f.prepare();
  f.controls.callMode = 'captured-failure'; await assert.rejects(f.invoke(attempt.id), error => error === f.errors.captured);
  await f.mutate(state => { selected(state, attempt.id).execution = toolExecution('invoked', {
    transportCalls: 2, internalOperations: null, imageBytes: null, waitMs: null,
  }); });
  const before = await f.current(), response = await f.response(attempt.id), counters = structuredClone(f.counters);
  await assert.rejects(f.runtime.recordStoredUsage(f.work.id, attempt.id), /tool_execution_usage_conflict/);
  assert.deepEqual(await f.current(), before); assert.deepEqual(await f.response(attempt.id), response);
  assert.deepEqual(await usageEvents(f), []); assert.deepEqual(f.counters, counters);
});

test('execute failure preserves captured known usage while returning only a body-free result under narrower labels or a new goal', async t => {
  for (const change of ['labels', 'goal'] as const) {
    const f = await createMcpResponseCustodyFixture(t), { attempt } = await f.prepare({ dispatch: false });
    f.controls.callMode = 'captured-failure';
    f.controls.afterCapture = async () => { await f.mutate(state => {
      if (change === 'labels') state.policy.allowedLabels = [];
      else { state.goal.revision++; state.goal.description = 'A later goal'; state.plan = null; }
    }); };
    await f.runtime.execute(f.work.id, attempt.id); await f.runtime.settlePending(attempt.id);
    const state = await f.current(), saved = selected(state, attempt.id);
    assert.deepEqual(saved.execution, reported()); assert.equal(saved.owner, attempt.owner);
    assert.equal(saved.status, 'received'); assert.equal(saved.adopted, false); assert.equal(state.evidence.length, 0);
    const persisted = await body(f, state, attempt.id), failure = JSON.parse(new TextDecoder().decode(persisted.bytes));
    assert.equal(failure.status, 'error'); assert.deepEqual(failure.evidence, []); assert.deepEqual(failure.artifacts, []);
    assert.equal(failure.output, null); assert.deepEqual(persisted.ref.labels, []);
    assert.equal(state.budget.used.toolCalls, 1); assert.equal(state.budget.used.modelCalls, 0);
    assert.equal(f.counters.calls, 1); assert.equal(f.counters.captures, 1); assert.equal(f.counters.projections, 0);
    assert.equal((await usageEvents(f)).length, 1); assert.ok(await f.response(attempt.id));
    await f.runtime.adopt(f.work.id, attempt.id);
    const settled = await f.current(); assert.equal(selected(settled, attempt.id).adopted, false);
    assert.equal(settled.evidence.length, 0); assert.deepEqual(selected(settled, attempt.id).execution, reported());
    assert.equal(change === 'goal' ? settled.goal.revision : settled.policy.allowedLabels.length, change === 'goal' ? 2 : 0);
  }
});

test('an explicit cancellation after decoded capture keeps the original usage and stop status without another call', async t => {
  const f = await createMcpResponseCustodyFixture(t, 'file-journal'), { attempt } = await f.prepare({ dispatch: false });
  f.controls.callMode = 'captured-failure';
  f.controls.afterCapture = async () => {
    await f.runtime.command(f.work.id, 'stop-after-capture', { tenantId: f.work.policy.tenantId, principalId: f.work.policy.principalId },
      f.work.goal.revision, { kind: 'cancel', reason: 'explicit stop' });
  };
  await f.runtime.execute(f.work.id, attempt.id); await f.runtime.settlePending(attempt.id);
  let state = await f.current(); assert.equal(state.status, 'cancelled'); assert.equal(state.statusReason, 'explicit stop');
  assert.deepEqual(selected(state, attempt.id).execution, reported()); assert.equal(selected(state, attempt.id).owner, attempt.owner);
  assert.equal(state.evidence.length, 0); assert.equal(f.counters.calls, 1); assert.equal(f.counters.projections, 0);
  assert.equal((await usageEvents(f)).length, 1); assert.ok(await f.response(attempt.id));
  await f.runtime.adopt(f.work.id, attempt.id);
  assert.equal((await f.runtime.step(f.work.id)).kind, 'cancelled'); state = await f.current();
  assert.equal(state.status, 'cancelled'); assert.equal(state.statusReason, 'explicit stop');
  assert.equal(selected(state, attempt.id).adopted, false); assert.deepEqual(selected(state, attempt.id).execution, reported());
  assert.equal(state.budget.used.toolCalls, 1); assert.equal(state.budget.used.modelCalls, 0); assert.equal(f.counters.calls, 1);
});

test('late receive and adopt preserve an explicit blocked or completed work state and reject body adoption', async t => {
  for (const status of ['blocked', 'completed'] as const) {
    const f = await createMcpResponseCustodyFixture(t), { attempt } = await f.prepare(), result = await f.invoke(attempt.id);
    await f.mutate(state => { state.status = status; state.statusReason = 'preserved-terminal-state'; });
    await f.runtime.recordStoredUsage(f.work.id, attempt.id);
    await f.runtime.receive(f.work.id, attempt.id, result, 'invoked');
    const received = await f.current(), original = await body(f, received, attempt.id);
    assert.equal(received.status, status); assert.equal(received.statusReason, 'preserved-terminal-state');
    await f.runtime.adopt(f.work.id, attempt.id); const settled = await f.current();
    assert.equal(settled.status, status); assert.equal(settled.statusReason, 'preserved-terminal-state');
    assert.equal(selected(settled, attempt.id).adopted, false); assert.equal(settled.evidence.length, 0);
    assert.deepEqual(await body(f, settled, attempt.id), original); assert.deepEqual(selected(settled, attempt.id).execution, reported());
    assert.equal(settled.budget.used.toolCalls, 1); assert.equal(f.counters.calls, 1);
  }
});

test('intent alone supplies no received-response usage and does not trigger a replacement call', async t => {
  const f = await createMcpResponseCustodyFixture(t), { attempt } = await f.prepare();
  f.controls.callMode = 'arbitrary-error'; await assert.rejects(f.invoke(attempt.id), error => error === f.errors.arbitrary);
  const before = await f.current(), counters = structuredClone(f.counters);
  assert.equal(await f.response(attempt.id), null); assert.equal(f.rawRef(), undefined);
  assert.equal(await f.runtime.recordStoredUsage(f.work.id, attempt.id), null);
  assert.deepEqual(await f.current(), before); assert.deepEqual(await usageEvents(f), []); assert.deepEqual(f.counters, counters);
  assert.equal(selected(before, attempt.id).execution?.usage.transportCalls, null);
});

test('finishClose waits for a captured raw publication and usage settlement while rejecting new execution', { timeout: 10000 }, async t => {
  const f = await createMcpResponseCustodyFixture(t), { attempt } = await f.prepare({ dispatch: false });
  const reached = gate(), release = gate();
  f.controls.afterRaw = async () => { reached.resolve(); await release.promise; };
  const running = f.runtime.execute(f.work.id, attempt.id);
  let closing: Promise<void> | undefined;
  try {
    await Promise.race([reached.promise, running.then(() => { throw new Error('raw_boundary_not_reached'); })]);
    assert.ok(f.rawRef()); assert.equal(await f.response(attempt.id), null);
    let closed = false;
    closing = f.runtime.finishClose(5000).then(() => { closed = true; });
    await running; assert.equal(closed, false, 'abort returns control while custody still waits on its raw boundary');
    await assert.rejects(f.runtime.execute(f.work.id, 'another-attempt'), /executor_closed/);
    assert.equal(await f.response(attempt.id), null); assert.equal(f.counters.calls, 1);
    release.resolve(); await closing; await f.runtime.settlePending(attempt.id);
    const state = await f.current(); assert.ok(await f.response(attempt.id));
    assert.deepEqual(selected(state, attempt.id).execution, reported());
    assert.equal(selected(state, attempt.id).status, 'received'); assert.equal(state.evidence.length, 0);
    const failure = JSON.parse(new TextDecoder().decode((await body(f, state, attempt.id)).bytes));
    assert.equal(failure.status, 'error'); assert.equal(failure.output, null); assert.deepEqual(failure.evidence, []);
    assert.equal(f.counters.calls, 1); assert.equal((await usageEvents(f)).length, 1);
    await assert.rejects(f.runtime.recordStoredUsage(f.work.id, attempt.id), /executor_closed/);
  } finally {
    release.resolve(); await Promise.allSettled([running, ...(closing ? [closing] : [])]);
    await Promise.allSettled(f.runtime.pendingExecutions().map(id => f.runtime.settlePending(id)));
  }
});

test('finishClose timeout revokes custody so releasing an orphan raw cannot publish response or receive afterward', { timeout: 10000 }, async t => {
  const f = await createMcpResponseCustodyFixture(t, 'file-journal'), { attempt } = await f.prepare({ dispatch: false });
  const reached = gate(), release = gate();
  f.controls.afterRaw = async () => { reached.resolve(); await release.promise; };
  const running = f.runtime.execute(f.work.id, attempt.id);
  try {
    await Promise.race([reached.promise, running.then(() => { throw new Error('raw_boundary_not_reached'); })]);
    const raw = f.rawRef(); assert.ok(raw); assert.equal(await f.services.artifacts.exists(raw), true);
    await assert.rejects(f.runtime.finishClose(25), /executor_close_unconfirmed/);
    await running; const beforeRelease = await f.current();
    assert.equal(await f.response(attempt.id), null); assert.equal(selected(beforeRelease, attempt.id).resultArtifact, null);
    release.resolve(); await assert.rejects(f.runtime.settlePending(attempt.id), /result_persistence_failed/);
    assert.deepEqual(await f.current(), beforeRelease);
    assert.equal(await f.response(attempt.id), null);
    assert.equal(await f.services.state.receipt(f.work.id, `receive:${attempt.id}`), null);
    assert.deepEqual(await usageEvents(f), []); assert.equal(f.counters.responseCommits, 0);
    assert.equal(f.counters.calls, 1); assert.equal(f.counters.projections, 0);
    await assert.rejects(f.runtime.execute(f.work.id, 'another-attempt'), /executor_closed/);
    await assert.rejects(f.runtime.recordStoredUsage(f.work.id, attempt.id), /executor_closed/);
  } finally {
    release.resolve(); await Promise.allSettled([running]);
    await Promise.allSettled(f.runtime.pendingExecutions().map(id => f.runtime.settlePending(id)));
  }
});
