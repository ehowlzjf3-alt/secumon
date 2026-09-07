import test from 'node:test';
import assert from 'node:assert/strict';
import type { Attempt, WorkState } from '../domain/model.js';
import type { Tool } from '../application/ports.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { StoredToolResults } from '../application/stored-tool-results.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { toolExecution, summarizeToolExecution } from '../application/tool-execution-usage.js';
import { asJson } from '../application/plan-validator.js';
import { transact } from '../application/work-transactions.js';
import { createMcpResponseCustodyFixture } from './mcp-response-custody-fixture.js';
import { storedResultFixture } from './stored-result-fixture.js';
import { adapters } from './state-conformance-helpers.js';

function selected(state: WorkState, attemptId: string): Attempt {
  const attempt = state.attempts.find(value => value.id === attemptId); assert.ok(attempt); return attempt;
}

async function accountedFixture(recoverFirst = false) {
  const f = await storedResultFixture(); let usageReads = 0;
  const tool: Tool = { ...f.tool, async restoreUsage(state) {
    usageReads++;
    const receipt = await f.state.receipt(state.id, f.responseCommandId);
    return receipt ? { kind: 'available', usage: structuredClone(f.result.usage!), receivedAt: f.receivedAt,
      receipt: { commandId: f.responseCommandId, digest: receipt.digest, artifact: structuredClone(f.raw) },
      custodyOnly: false, responseObserved: true } : { kind: 'absent' };
  } };
  const contracts = new ToolContracts([tool], f.schemas), runtime = new ExecutionRuntime(f.services, contracts, 'usage-only-worker');
  if (recoverFirst) await f.markLeaseExpired();
  const accounted = await runtime.recordStoredUsage(f.workId, f.attempt.id); assert.ok(accounted);
  const events = (await f.state.events(f.workId, 0)).filter(event => event.type === 'tool_execution_usage_recorded');
  assert.equal(events.length, 1);
  const commandId = events[0]!.commandId, receipt = await f.state.receipt(f.workId, commandId); assert.ok(receipt);
  return { ...f, tool, contracts, runtime, commandId, accountingReceipt: receipt, usageReads: () => usageReads,
    restore: new StoredToolResults(f.services, contracts) };
}

for (const backend of adapters) {
  test(`${backend}: a committed usage-only response survives reopen and then follows normal receive/adopt once`, async t => {
    const f = await createMcpResponseCustodyFixture(t, backend), { attempt } = await f.prepare();
    const body = await f.invoke(attempt.id), raw = f.rawRef(); assert.ok(raw);
    const response = await f.response(attempt.id); assert.ok(response);
    const originalBytes = (await f.raw(raw)).bytes;
    const beforeUsage = await f.current();
    const accounted = await f.runtime.recordStoredUsage(f.work.id, attempt.id); assert.ok(accounted);
    assert.equal(selected(accounted, attempt.id).status, 'running');
    assert.equal(selected(accounted, attempt.id).resultArtifact, null);
    assert.deepEqual(selected(accounted, attempt.id).execution, toolExecution('invoked', body.usage));
    const usageEvents = (await f.services.state.events(f.work.id, 0)).filter(event => event.type === 'tool_execution_usage_recorded');
    assert.equal(usageEvents.length, 1);
    const usageReceipt = await f.services.state.receipt(f.work.id, usageEvents[0]!.commandId); assert.ok(usageReceipt);
    const normalized = structuredClone(accounted); normalized.revision = beforeUsage.revision; normalized.updatedAt = beforeUsage.updatedAt;
    selected(normalized, attempt.id).execution = structuredClone(selected(beforeUsage, attempt.id).execution!);
    assert.deepEqual(normalized, beforeUsage);
    assert.equal(await f.services.state.receipt(f.work.id, `receive:${attempt.id}`), null);
    // Close and reopen the real stores after the accounting commit, discarding the original runtime's local recovery state.
    await f.reopen(); f.setNow(attempt.leaseUntil);
    const reader = f.reader(), contracts = new ToolContracts([reader], f.schemas);
    const resumed = new ExecutionRuntime(f.services, contracts, 'new-body-worker');
    const restore = new StoredToolResults(f.services, contracts);
    assert.equal(restore.candidate(await f.current(), attempt.id), true);
    const received = await resumed.recover(f.work.id, attempt.id);
    assert.equal(selected(received, attempt.id).status, 'received');
    const receivedRef = selected(received, attempt.id).resultArtifact; assert.ok(receivedRef);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(await f.services.artifacts.get(receivedRef, f.work.policy))), body);
    await resumed.adopt(f.work.id, attempt.id);
    const done = await f.current();
    assert.equal(selected(done, attempt.id).status, 'succeeded'); assert.equal(selected(done, attempt.id).adopted, true);
    assert.equal(selected(done, attempt.id).owner, attempt.owner); assert.equal(selected(done, attempt.id).leaseUntil, attempt.leaseUntil);
    assert.deepEqual(selected(done, attempt.id).execution, toolExecution('invoked', body.usage));
    assert.deepEqual(summarizeToolExecution(done).transportCalls, { measured: 1, unknown: 0 });
    assert.equal(done.budget.used.toolCalls, 1); assert.equal(done.budget.used.modelCalls, 0);
    assert.deepEqual(await f.response(attempt.id), response);
    assert.deepEqual(await f.services.state.receipt(f.work.id, usageEvents[0]!.commandId), usageReceipt);
    assert.deepEqual((await f.raw(raw)).bytes, originalBytes);
    const beforeRepeat = await f.services.state.events(f.work.id, 0);
    assert.equal(await resumed.settleStoredResult(f.work.id), null);
    await resumed.adopt(f.work.id, attempt.id);
    assert.deepEqual(await f.current(), done); assert.deepEqual(await f.services.state.events(f.work.id, 0), beforeRepeat);
    assert.equal(f.counters.calls, 1); assert.equal(f.counters.discoveries, 0);
  });
}

test('a legacy lease-only failure may gain usage and recover, preserving its original failure receipt', async () => {
  const f = await accountedFixture(true), state = await f.current();
  const recovery = await f.state.receipt(f.workId, `recover:${f.attempt.id}`); assert.ok(recovery);
  assert.deepEqual(selected(recovery.state, f.attempt.id).execution, toolExecution('unreported'));
  assert.equal(selected(state, f.attempt.id).execution?.mode, 'invoked');
  const ticket = await f.restore.prepare(state, f.attempt.id); assert.ok(ticket);
  await f.restore.assertCurrent(state, ticket);
  await f.runtime.recover(f.workId, f.attempt.id); await f.runtime.adopt(f.workId, f.attempt.id);
  assert.equal(selected(await f.current(), f.attempt.id).adopted, true);
  assert.deepEqual(await f.state.receipt(f.workId, `recover:${f.attempt.id}`), recovery);
  assert.equal(f.controls.executeCalls, 0);
});

test('usage-only body recovery requires the exact accounting command, digest, original identity and execution', async () => {
  for (const change of ['missing', 'digest', 'work', 'principal', 'attempt', 'owner', 'execution', 'revision', 'future-time'] as const) {
    const f = await accountedFixture(), state = await f.current(), read = f.state.receipt.bind(f.state);
    f.state.receipt = async (workId, commandId) => {
      const value = await read(workId, commandId);
      if (commandId !== f.commandId || !value) return value;
      if (change === 'missing') return null;
      const changed = structuredClone(value);
      if (change === 'digest') changed.digest = '0'.repeat(64);
      if (change === 'work') changed.state.id = 'other-work';
      if (change === 'principal') changed.state.policy.principalId = 'other-principal';
      if (change === 'attempt') selected(changed.state, f.attempt.id).id = 'other-attempt';
      if (change === 'owner') selected(changed.state, f.attempt.id).owner = 'other-owner';
      if (change === 'execution') selected(changed.state, f.attempt.id).execution!.usage.transportCalls = 2;
      if (change === 'revision') changed.state.revision = 1;
      if (change === 'future-time') changed.state.updatedAt = state.updatedAt + 1;
      return changed;
    };
    await assert.rejects(f.restore.prepare(state, f.attempt.id), /stored_result_usage_unproven/, change);
    assert.deepEqual(await f.current(), state); assert.equal(f.controls.executeCalls, 0);
    assert.equal(await read(f.workId, `receive:${f.attempt.id}`), null);
  }
});

test('an invoked measurement with no durable accounting receipt remains unproven even if the provider reports the same usage', async () => {
  const f = await accountedFixture(), receipt = f.accountingReceipt, read = f.state.receipt.bind(f.state);
  let exactReads = 0;
  f.state.receipt = async (workId, commandId) => {
    if (commandId === f.commandId) { exactReads++; return null; }
    // A different command holding the same state is not a substitute for the source-bound usage receipt.
    if (commandId === 'another-usage-command') return receipt;
    return read(workId, commandId);
  };
  const state = await f.current(); assert.equal(f.restore.candidate(state, f.attempt.id), true);
  await assert.rejects(f.restore.prepare(state, f.attempt.id), /stored_result_usage_unproven/);
  assert.equal(exactReads, 1); assert.ok(f.usageReads() > 1); assert.equal(f.controls.executeCalls, 0);
});

test('accounted usage does not revive changed goals, label restrictions, terminal states or already failed results', async t => {
  for (const change of ['deadline', 'labels', 'goal', 'cancelled', 'result-failed'] as const) {
    const f = await createMcpResponseCustodyFixture(t), { attempt } = await f.prepare();
    const body = await f.invoke(attempt.id);
    await f.runtime.recordStoredUsage(f.work.id, attempt.id);
    if (change === 'deadline') f.setNow((await f.current()).deadlineAt);
    if (change === 'labels') await f.mutate(state => { state.policy.allowedLabels = []; });
    if (change === 'goal') await f.mutate(state => { state.goal.revision++; state.goal.description = 'new goal'; state.plan = null; });
    if (change === 'cancelled') await f.mutate(state => { state.status = 'cancelled'; state.statusReason = 'explicit stop'; });
    if (change === 'result-failed') {
      await f.runtime.receive(f.work.id, attempt.id, { ...body, status: 'error', output: null, artifacts: [], evidence: [],
        coverage: 'unknown', error: { code: 'explicit_failure', retryable: false } }, 'invoked');
      await f.runtime.adopt(f.work.id, attempt.id);
    }
    const before = await f.current(), contracts = new ToolContracts([f.reader()], f.schemas);
    const restore = new StoredToolResults(f.services, contracts);
    if (change === 'goal' || change === 'cancelled' || change === 'result-failed') {
      assert.equal(restore.candidate(before, attempt.id), false, change);
      await assert.rejects(restore.prepare(before, attempt.id), /stored_result_not_eligible/, change);
    } else await assert.rejects(restore.prepare(before, attempt.id), change);
    assert.deepEqual(await f.current(), before); assert.equal(f.counters.calls, 1); assert.equal(f.counters.discoveries, 0);
    assert.equal(selected(before, attempt.id).adopted, false);
  }
});

test('an accounting receipt replaced during result proof is rejected by the final receipt fence', async () => {
  const f = await accountedFixture(), state = await f.current(), read = f.state.receipt.bind(f.state);
  f.controls.beforeProof = async () => {
    f.state.receipt = async (workId, commandId) => {
      const value = await read(workId, commandId);
      return commandId === f.commandId && value ? { ...value, digest: '0'.repeat(64) } : value;
    };
  };
  await assert.rejects(f.restore.prepare(state, f.attempt.id), /stored_result_changed/);
  assert.deepEqual(await f.current(), state); assert.equal(f.controls.executeCalls, 0);
});

test('changing a current known measurement cannot borrow a valid receipt for a different execution', async () => {
  const f = await accountedFixture();
  await transact(f.services, f.workId, 'inconsistent-execution', 'fixture_changed', asJson({ attemptId: f.attempt.id }), next => {
    selected(next, f.attempt.id).execution!.usage.transportCalls = 2;
  });
  const state = await f.current();
  await assert.rejects(f.restore.prepare(state, f.attempt.id), /stored_result_usage_unproven/);
  assert.deepEqual(await f.current(), state); assert.equal(f.controls.executeCalls, 0);
});
