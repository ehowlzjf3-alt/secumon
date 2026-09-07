import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkState } from '../domain/model.js';
import type { Tool } from '../application/ports.js';
import { recordedStoredUsageAttempts } from '../application/stored-usage-records.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { toolExecution } from '../application/tool-execution-usage.js';
import { transact } from '../application/work-transactions.js';
import { storedResultFixture } from './stored-result-fixture.js';

async function fixture() {
  const f = await storedResultFixture(); let restores = 0;
  const tool: Tool = { ...f.tool, async restoreUsage(state) {
    restores++; const response = await f.state.receipt(state.id, f.responseCommandId); assert.ok(response);
    return { kind: 'available', usage: structuredClone(f.result.usage!), receivedAt: f.receivedAt,
      receipt: { commandId: f.responseCommandId, digest: response.digest, artifact: f.raw }, custodyOnly: false, responseObserved: true };
  } };
  const runtime = new ExecutionRuntime(f.services, new ToolContracts([tool], f.schemas), 'accounting-worker');
  assert.ok(await runtime.recordStoredUsage(f.workId, f.attempt.id));
  const events = await f.state.events(f.workId, 0), event = events.find(value => value.type === 'tool_execution_usage_recorded'); assert.ok(event);
  const receipt = await f.state.receipt(f.workId, event.commandId); assert.ok(receipt);
  return { ...f, runtime, event, receipt, restores: () => restores };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function observe(f: Fixture) {
  const counts = { state: 0, events: 0, receipts: 0, raw: 0, exists: 0, put: 0 };
  const get = f.state.get.bind(f.state), events = f.state.events.bind(f.state), receipt = f.state.receipt.bind(f.state);
  f.state.get = async workId => { counts.state++; return get(workId); };
  f.state.events = async (...args) => { counts.events++; return events(...args); };
  f.state.receipt = async (...args) => { counts.receipts++; return receipt(...args); };
  f.artifacts.get = async () => { counts.raw++; throw new Error('metadata_lookup_must_not_read_raw'); };
  f.artifacts.exists = async () => { counts.exists++; throw new Error('metadata_lookup_must_not_inspect_artifacts'); };
  f.artifacts.put = async () => { counts.put++; throw new Error('metadata_lookup_must_not_write'); };
  return counts;
}
async function lookup(f: Fixture, state: WorkState) { return recordedStoredUsageAttempts(f.services, state, [f.attempt.id]); }

test('nullable usage is recognized repeatedly with one events read and no raw, restore or mutation per lookup', async () => {
  const f = await fixture(), state = await f.current(), restores = f.restores(), beforeEvents = await f.state.events(f.workId, 0);
  assert.equal(state.attempts[0]!.resultArtifact, null, 'usage-only accounting does not require an already received body');
  assert.equal(state.attempts[0]!.execution!.usage.internalOperations, null);
  const counts = observe(f);
  assert.deepEqual(await lookup(f, state), new Set([f.attempt.id]));
  assert.deepEqual(counts, { state: 2, events: 1, receipts: 1, raw: 0, exists: 0, put: 0 });
  assert.deepEqual(await lookup(f, state), new Set([f.attempt.id]));
  assert.deepEqual(counts, { state: 4, events: 2, receipts: 2, raw: 0, exists: 0, put: 0 });
  assert.equal(f.restores(), restores); assert.deepEqual(await f.current(), state);
  assert.deepEqual(await f.state.events(f.workId, 0), beforeEvents); assert.equal(f.controls.executeCalls, 0);
});

test('no execution-bearing candidate avoids the events query entirely', async () => {
  const f = await fixture();
  await transact(f.services, f.workId, 'remove-measurement-for-fixture', 'fixture_changed', {}, next => { delete next.attempts[0]!.execution; });
  const state = await f.current(), counts = observe(f);
  assert.deepEqual(await lookup(f, state), new Set());
  assert.deepEqual(await recordedStoredUsageAttempts(f.services, state, []), new Set());
  assert.equal(counts.events, 0); assert.equal(counts.receipts, 0); assert.equal(counts.raw, 0);
});

test('malformed event payload, command or time metadata is not accepted as an accounting record', async () => {
  for (const change of ['payload-extra', 'outer-extra', 'source', 'attempt', 'command', 'type', 'revision', 'time'] as const) {
    const f = await fixture(), state = await f.current(), events = f.state.events.bind(f.state);
    f.state.events = async (...args) => (await events(...args)).map(event => {
      if (event.commandId !== f.event.commandId) return event;
      const changed = structuredClone(event);
      const payload = (changed.data as { payload: { attemptId: string; source: string } }).payload;
      if (change === 'payload-extra') changed.data = { payload: { ...payload, trusted: true } };
      if (change === 'outer-extra') changed.data = { payload, trusted: true };
      if (change === 'source') payload.source = 'not-a-digest';
      if (change === 'attempt') payload.attemptId = 'another-attempt';
      if (change === 'command') changed.commandId = `${changed.commandId}:another-command`;
      if (change === 'type') changed.type = 'fixture_note';
      if (change === 'revision') changed.revision = state.revision + 1;
      if (change === 'time') changed.at = state.updatedAt + 1;
      return changed;
    });
    assert.deepEqual(await lookup(f, state), new Set(), change);
    assert.deepEqual(await f.current(), state); assert.equal(f.controls.executeCalls, 0);
  }
});

test('missing, forged, differently attributed or differently measured receipts fall back to ordinary proof', async () => {
  for (const change of ['missing', 'digest', 'attempt', 'owner', 'execution', 'no-execution', 'revision', 'time'] as const) {
    const f = await fixture(), state = await f.current(), read = f.state.receipt.bind(f.state);
    f.state.receipt = async (workId, commandId) => {
      const value = await read(workId, commandId); if (commandId !== f.event.commandId || !value) return value;
      if (change === 'missing') return null;
      const changed = structuredClone(value), attempt = changed.state.attempts[0]!;
      if (change === 'digest') changed.digest = '0'.repeat(64);
      if (change === 'attempt') attempt.id = 'other-attempt';
      if (change === 'owner') attempt.owner = 'other-executor';
      if (change === 'execution') attempt.execution!.usage.transportCalls = 2;
      if (change === 'no-execution') delete attempt.execution;
      if (change === 'revision') changed.state.revision--;
      if (change === 'time') changed.state.updatedAt++;
      return changed;
    };
    assert.deepEqual(await lookup(f, state), new Set(), change);
    assert.deepEqual(await f.current(), state); assert.equal(f.controls.executeCalls, 0);
  }
});

test('already accounted statistics remain recognizable when raw is unavailable after a later goal, restriction and cancellation', async () => {
  const f = await fixture();
  await transact(f.services, f.workId, 'later-lifecycle', 'fixture_changed', {}, next => {
    next.goal.revision++; next.goal.description = 'A new goal'; next.plan = null;
    next.status = 'cancelled'; next.statusReason = 'explicit cancellation';
    next.dataLifecycle = { generation: 1, blockedArtifactIds: [f.raw.id], changes: [] };
  });
  const state = await f.current(), counts = observe(f);
  assert.deepEqual(await lookup(f, state), new Set([f.attempt.id]));
  assert.equal(counts.raw, 0); assert.equal(counts.exists, 0); assert.equal(counts.put, 0);
  assert.deepEqual(await f.current(), state);
});

test('work, principal, tenant or incarnation mixing fails closed instead of suppressing a necessary proof', async () => {
  for (const change of ['event-work', 'receipt-work', 'incarnation', 'principal', 'tenant'] as const) {
    const f = await fixture(), state = await f.current(), events = f.state.events.bind(f.state), read = f.state.receipt.bind(f.state);
    if (change === 'event-work') f.state.events = async (...args) => (await events(...args)).map(event => ({ ...event, workId: 'other-work' }));
    else f.state.receipt = async (workId, commandId) => {
      const value = await read(workId, commandId); if (!value || commandId !== f.event.commandId) return value;
      const changed = structuredClone(value);
      if (change === 'receipt-work') changed.state.id = 'other-work';
      if (change === 'incarnation') changed.state.createdAt--;
      if (change === 'principal') changed.state.policy.principalId = 'other-principal';
      if (change === 'tenant') changed.state.policy.tenantId = 'other-tenant';
      return changed;
    };
    await assert.rejects(lookup(f, state), /stored_usage_owner_mismatch/, change);
    assert.deepEqual(await f.current(), state);
  }
});

test('an actual state commit during the events or receipt await invalidates the captured accounting snapshot', async () => {
  for (const during of ['events', 'receipt'] as const) {
    const f = await fixture(), state = await f.current(), events = f.state.events.bind(f.state), receipt = f.state.receipt.bind(f.state);
    let changed = false;
    const change = async () => {
      if (changed) return; changed = true;
      await transact(f.services, f.workId, 'during-lookup', 'fixture_changed', {}, next => { next.statusReason = 'concurrent commit'; });
    };
    if (during === 'events') f.state.events = async (...args) => { const result = await events(...args); await change(); return result; };
    else f.state.receipt = async (workId, commandId) => {
      const result = await receipt(workId, commandId); if (commandId === f.event.commandId) await change(); return result;
    };
    await assert.rejects(lookup(f, state), /stored_usage_changed/, during);
    assert.equal(changed, true); assert.equal((await f.current()).revision, state.revision + 1);
  }
});

test('duplicate event entries do not duplicate receipt reads and a changed known execution is not skipped', async () => {
  const f = await fixture(), events = f.state.events.bind(f.state);
  f.state.events = async (...args) => { const result = await events(...args); return [...result, structuredClone(f.event)]; };
  const state = await f.current(), read = f.state.receipt.bind(f.state); let receipts = 0;
  f.state.receipt = async (...args) => { receipts++; return read(...args); };
  assert.deepEqual(await recordedStoredUsageAttempts(f.services, state, [f.attempt.id, f.attempt.id]), new Set([f.attempt.id]));
  assert.equal(receipts, 1);
  await transact(f.services, f.workId, 'different-measurement', 'fixture_changed', {}, next => {
    next.attempts[0]!.execution = toolExecution('invoked', { transportCalls: 2, internalOperations: null, imageBytes: null, waitMs: null });
  });
  assert.deepEqual(await lookup(f, await f.current()), new Set());
});
