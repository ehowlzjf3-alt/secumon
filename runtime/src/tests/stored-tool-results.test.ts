import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkState } from '../domain/model.js';
import type { StoredToolResult, StoredToolResultInput, Tool } from '../application/ports.js';
import { StoredToolResults } from '../application/stored-tool-results.js';
import { ToolContracts, snapshotTool } from '../application/tool-contracts.js';
import { createExecutionAuthority } from '../application/execution-authority.js';
import { toolExecution } from '../application/tool-execution-usage.js';
import { transact } from '../application/work-transactions.js';
import { snapshot } from './state-conformance-helpers.js';
import { storedResultFixture } from './stored-result-fixture.js';

type Fixture = Awaited<ReturnType<typeof storedResultFixture>>;
type Available = Extract<StoredToolResult, { kind: 'available' }>;
async function available(f: Fixture): Promise<Available> {
  const receipt = await f.state.receipt(f.workId, f.responseCommandId); assert.ok(receipt);
  return { kind: 'available', result: structuredClone(f.result), receivedAt: f.receivedAt,
    receipt: { commandId: f.responseCommandId, digest: receipt.digest, artifact: structuredClone(f.raw) } };
}
function mutateReceipt(f: Fixture, commandId: string, edit: (value: NonNullable<Awaited<ReturnType<Fixture['state']['receipt']>>>) => void) {
  const read = f.state.receipt.bind(f.state);
  f.state.receipt = async (workId, id) => {
    const value = await read(workId, id); if (value && id === commandId) edit(value); return value;
  };
}

test('stored result preparation and revalidation preserve custody, ledger and original owner without writes', async () => {
  const f = await storedResultFixture(), state = await f.current();
  const commands = [`dispatch:${f.attempt.id}`, f.responseCommandId, `receive:${f.attempt.id}`, `adopt:${f.attempt.id}`];
  const before = await snapshot(f.state, f.workId, commands), raw = await f.artifacts.get(f.raw, state.policy);
  let writes = 0;
  const commit = f.state.commit.bind(f.state), put = f.artifacts.put.bind(f.artifacts);
  f.state.commit = async request => { writes++; return commit(request); };
  f.artifacts.put = async (...args) => { writes++; return put(...args); };
  assert.equal(f.restore.candidate(state, f.attempt.id), true); // The lease has not expired yet.
  const ticket = await f.restore.prepare(state, f.attempt.id); assert.ok(ticket);
  assert.deepEqual(ticket.result, f.result); assert.equal(ticket.receivedAt, 1010);
  assert.equal(ticket.receipt.commandId, f.responseCommandId);
  assert.ok(Object.isFrozen(ticket) && Object.isFrozen(ticket.result) && Object.isFrozen(ticket.result.evidence));
  assert.ok(Object.isFrozen(ticket.receipt) && Object.isFrozen(ticket.receipt.artifact));
  await f.restore.assertCurrent(state, ticket);
  assert.equal(writes, 0); assert.equal(f.controls.executeCalls, 0);
  assert.equal(state.attempts[0]!.owner, 'original-executor');
  assert.deepEqual(await snapshot(f.state, f.workId, commands), before);
  assert.deepEqual(await f.artifacts.get(f.raw, state.policy), raw);
});

test('stored-only registration preserves current result proof and restoration without granting new execution', async t => {
  const f = await storedResultFixture(); t.after(() => f.state.close()); const state = await f.current();
  const commands = [`dispatch:${f.attempt.id}`, f.responseCommandId, `receive:${f.attempt.id}`, `adopt:${f.attempt.id}`];
  const before = await snapshot(f.state, f.workId, commands);
  f.contracts.replaceProvider('fixture', [{ ...f.tool, availability: 'stored_only' }],
    { expectedEpoch: f.contracts.providerEpoch('fixture'), sourceRevision: 'stored-only' });
  assert.deepEqual(f.contracts.get(f.task.toolId, f.task.toolVersion)!.tool.definition, f.tool.definition);
  assert.equal(f.contracts.check(f.task, state.policy), null);
  assert.equal(f.contracts.checkExecution(f.task, state.policy), 'tool_connection_required');
  const ticket = await f.restore.prepare(state, f.attempt.id); assert.ok(ticket);
  await f.restore.assertCurrent(state, ticket); assert.deepEqual(ticket.result, f.result);
  assert.equal(await f.contracts.validateResult(state, f.result), true);
  f.controls.valid = false;
  assert.equal(await f.contracts.validateResult(state, f.result), false, 'stored-only never bypasses the original proof callback');
  assert.equal(f.controls.executeCalls, 0);
  assert.deepEqual(await snapshot(f.state, f.workId, commands), before);
});

test('metadata prefilter recognizes blocked custody but preparation preserves the explicit work block', async () => {
  const f = await storedResultFixture(), state = await f.current();
  const cases: [string, (value: WorkState) => void][] = [
    ...(['cancelled', 'paused', 'failed', 'completed'] as const).map(status => [status, (value: WorkState) => { value.status = status; }] as [string, (value: WorkState) => void]),
    ['received', value => { value.attempts[0]!.status = 'received'; }],
    ['result-id', value => { value.attempts[0]!.resultId = 'already-received'; }],
    ['result-artifact', value => { value.attempts[0]!.resultArtifact = f.raw; }],
    ['adopted', value => { value.attempts[0]!.adopted = true; }],
    ['explicit-failure', value => { value.attempts[0]!.status = 'failed'; value.attempts[0]!.error = { code: 'cancelled', retryable: false }; }],
    ['known-invocation', value => { value.attempts[0]!.execution = toolExecution('invoked'); }],
    ['known-zero', value => { value.attempts[0]!.execution = toolExecution('not_invoked'); }],
    ['known-partial-usage', value => { value.attempts[0]!.execution = toolExecution('unreported', { transportCalls: 0, internalOperations: null, imageBytes: null, waitMs: null }); }],
    ['new-goal', value => { value.goal.revision++; }],
    ['new-plan', value => { value.plan!.revision++; }],
    ['new-task-input', value => { value.plan!.tasks[0]!.input = { changed: true }; }],
    ['newer-attempt', value => { value.attempts.push({ ...structuredClone(value.attempts[0]!), id: 'later', status: 'cancelled' }); }],
    ['missing-contract-pin', value => { delete value.attempts[0]!.contractDigest; }],
  ];
  for (const [name, edit] of cases) { const changed = structuredClone(state); edit(changed); assert.equal(f.restore.candidate(changed, f.attempt.id), false, name); }
  const blocked = structuredClone(state); blocked.status = 'blocked';
  assert.equal(f.restore.candidate(blocked, f.attempt.id), true);
  await assert.rejects(f.restore.prepare(blocked, f.attempt.id), /stored_result_work_blocked/);
  assert.equal(f.controls.restoreCalls, 0); assert.equal(f.controls.executeCalls, 0);
});

test('only a matching explicit lease-recovery receipt permits a failed attempt', async () => {
  const f = await storedResultFixture(); await f.markLeaseExpired();
  const state = await f.current(), ticket = await f.restore.prepare(state, f.attempt.id); assert.ok(ticket);
  await f.restore.assertCurrent(state, ticket);
  const read = f.state.receipt.bind(f.state);
  f.state.receipt = async (workId, id) => id === `recover:${f.attempt.id}` ? null : read(workId, id);
  await assert.rejects(f.restore.prepare(state, f.attempt.id), /stored_result_invalid/);
  assert.equal(f.controls.executeCalls, 0);
});

test('recovery receipt in a different goal or policy cannot attest the same failed attempt', async () => {
  for (const change of ['goal', 'policy'] as const) {
    const f = await storedResultFixture(); await f.markLeaseExpired();
    mutateReceipt(f, `recover:${f.attempt.id}`, receipt => {
      if (change === 'goal') receipt.state.goal.description = 'Different receipt goal';
      else receipt.state.policy.principalId = 'another-user';
    });
    await assert.rejects(f.restore.prepare(await f.current(), f.attempt.id), /stored_result_invalid/);
    assert.equal(f.controls.restoreCalls, 0);
  }
});

test('raw artifact without response receipt is absent; existing receive or adoption receipts are not recoverable', async () => {
  const absent = await storedResultFixture({ publishResponse: false });
  const state = await absent.current();
  assert.equal(await absent.restore.prepare(state, absent.attempt.id), null);
  assert.equal(await absent.artifacts.exists(absent.raw), true);
  assert.deepEqual(await absent.current(), state);
  for (const prefix of ['receive', 'adopt']) {
    const f = await storedResultFixture(), read = f.state.receipt.bind(f.state);
    f.state.receipt = async (workId, id) => read(workId, id === `${prefix}:${f.attempt.id}` ? f.responseCommandId : id);
    await assert.rejects(f.restore.prepare(await f.current(), f.attempt.id), /stored_result_invalid/);
    assert.equal(f.controls.restoreCalls, 0);
  }
});

test('dispatch identity, supplied receipt digest and response ordering are checked independently of projection', async () => {
  for (const change of ['dispatch-digest', 'dispatch-owner', 'response-digest', 'response-work', 'response-revision', 'response-original'] as const) {
    const f = await storedResultFixture(); f.controls.restored = await available(f);
    if (change.startsWith('dispatch')) mutateReceipt(f, `dispatch:${f.attempt.id}`, receipt => {
      if (change === 'dispatch-digest') receipt.digest = '0'.repeat(64);
      else receipt.state.attempts[0]!.owner = 'different-executor';
    });
    else mutateReceipt(f, f.responseCommandId, receipt => {
      if (change === 'response-digest') receipt.digest = '0'.repeat(64);
      if (change === 'response-work') receipt.state.id = 'other-work';
      if (change === 'response-revision') receipt.state.revision = 1;
      if (change === 'response-original') receipt.state.artifacts = [];
    });
    await assert.rejects(f.restore.prepare(await f.current(), f.attempt.id), /stored_result_invalid/, change);
    assert.equal(f.controls.executeCalls, 0);
  }
});

test('capture timestamps must precede the original lease and deadline and cannot be from a future clock', async () => {
  for (const change of ['before-dispatch', 'after-response', 'lease', 'future-clock'] as const) {
    const f = await storedResultFixture(); f.controls.restored = await available(f);
    if (change === 'before-dispatch') f.controls.restored.receivedAt = 999;
    if (change === 'after-response') f.controls.restored.receivedAt = 1011;
    if (change === 'lease') mutateReceipt(f, f.responseCommandId, receipt => { receipt.state.updatedAt = f.attempt.leaseUntil; });
    if (change === 'future-clock') f.services.clock = { now: () => 990 };
    await assert.rejects(f.restore.prepare(await f.current(), f.attempt.id), /stored_result_time_invalid/, change);
  }
});

test('raw bytes are hashed on preparation and again after asynchronous projection validation', async () => {
  for (const afterProof of [false, true]) {
    const f = await storedResultFixture(), get = f.artifacts.get.bind(f.artifacts);
    let rawReads = 0;
    f.artifacts.get = async (ref, policy) => {
      const bytes = await get(ref, policy);
      if (ref.id === f.raw.id && ++rawReads >= (afterProof ? 2 : 1)) bytes[0] = bytes[0]! ^ 1;
      return bytes;
    };
    await assert.rejects(f.restore.prepare(await f.current(), f.attempt.id), /stored_result_original_unavailable/);
    assert.equal(f.controls.proofCalls, afterProof ? 1 : 0); assert.equal(f.controls.executeCalls, 0);
  }
});

test('bounded normalization and current artifact proof reject oversized or invalid projected results', async () => {
  const oversized = await storedResultFixture(); oversized.controls.restored = await available(oversized);
  oversized.controls.restored.result.output = { text: 'x'.repeat(1024 * 1024) };
  await assert.rejects(oversized.restore.prepare(await oversized.current(), oversized.attempt.id), /stored_result_too_large/);
  const invalid = await storedResultFixture(); invalid.controls.valid = false;
  await assert.rejects(invalid.restore.prepare(await invalid.current(), invalid.attempt.id), /stored_result_proof_invalid/);
  assert.equal(oversized.controls.proofCalls, 0);
  const rawBound = await storedResultFixture(), state = await rawBound.current();
  const ref = await rawBound.artifacts.put(new Uint8Array(512 * 1024 + 1),
    { tenantId: state.policy.tenantId, labels: ['synthetic'], mediaType: 'application/json' });
  const receiptId = 'fixture-large-original';
  await transact(rawBound.services, rawBound.workId, receiptId, 'fixture_response_recorded', {}, next => { next.artifacts.push(ref); });
  const receipt = await rawBound.state.receipt(rawBound.workId, receiptId); assert.ok(receipt);
  rawBound.controls.restored = { ...await available(rawBound), receipt: { commandId: receiptId, digest: receipt.digest, artifact: ref } };
  await assert.rejects(rawBound.restore.prepare(await rawBound.current(), rawBound.attempt.id), /stored_result_original_unavailable/);
  assert.equal(rawBound.controls.proofCalls, 0);
});

test('current execution authority is required before custody access and after an awaited proof', async () => {
  for (const duringProof of [false, true]) {
    const f = await storedResultFixture(), state = await f.current(), abort = new AbortController();
    f.services.executionAuthority = createExecutionAuthority({ actor: state.policy, scope: state.goal.scope, signal: abort.signal });
    if (duringProof) f.controls.beforeProof = async () => { abort.abort(); };
    else abort.abort();
    await assert.rejects(f.restore.prepare(state, f.attempt.id), /execution_authority_denied/);
    assert.equal(f.controls.restoreCalls, duringProof ? 1 : 0); assert.equal(f.controls.executeCalls, 0);
  }
  const f = await storedResultFixture(), state = await f.current(); state.policy.allowedTools = [];
  await assert.rejects(f.restore.prepare(state, f.attempt.id), /stored_result_permission_denied/);
  assert.equal(f.controls.restoreCalls, 0);
});

test('issued ticket cannot cross instances or be copied, and a new state revision needs fresh preparation', async () => {
  const f = await storedResultFixture(), state = await f.current(), ticket = await f.restore.prepare(state, f.attempt.id); assert.ok(ticket);
  await assert.rejects(new StoredToolResults(f.services, f.contracts).assertCurrent(state, ticket), /stored_result_ticket_invalid/);
  await assert.rejects(f.restore.assertCurrent(state, structuredClone(ticket)), /stored_result_ticket_invalid/);
  await transact(f.services, f.workId, 'unrelated-note', 'fixture_note', {}, next => { next.statusReason = 'New committed note'; });
  const next = await f.current();
  await assert.rejects(f.restore.assertCurrent(next, ticket), /stored_result_ticket_invalid/);
  const renewed = await f.restore.prepare(next, f.attempt.id); assert.ok(renewed);
  await f.restore.assertCurrent(next, renewed); assert.equal(f.controls.executeCalls, 0);
});

test('caller mutation is isolated while a real state commit during restoration invalidates preparation', async () => {
  const f = await storedResultFixture(), state = await f.current();
  f.controls.beforeRestore = async () => { state.id = 'caller-mutated-work'; state.policy.principalId = 'caller-mutated-user'; };
  const ticket = await f.restore.prepare(state, f.attempt.id); assert.ok(ticket); assert.equal(ticket.workId, f.workId);
  delete f.controls.beforeRestore;
  f.controls.beforeProof = async () => { await transact(f.services, f.workId, 'concurrent-note', 'fixture_note', {}, next => { next.statusReason = 'Concurrent commit'; }); };
  await assert.rejects(f.restore.prepare(await f.current(), f.attempt.id), /stored_result_changed/);
});

test('source receipt changes after proof and provider replacement after callback invalidate restoration', async () => {
  const f = await storedResultFixture();
  f.controls.beforeProof = async () => { mutateReceipt(f, f.responseCommandId, receipt => { receipt.digest = '0'.repeat(64); }); };
  await assert.rejects(f.restore.prepare(await f.current(), f.attempt.id), /stored_result_changed/);
  const g = await storedResultFixture();
  g.controls.beforeRestore = async () => {
    g.contracts.replaceProvider('fixture', [g.tool], { expectedEpoch: g.contracts.providerEpoch('fixture'), sourceRevision: 'new-registration' });
  };
  await assert.rejects(g.restore.prepare(await g.current(), g.attempt.id), /stored_result_changed/);
});

test('registration captures restore callback and receiver; changed public methods cannot replace it', async () => {
  const f = await storedResultFixture(); let replacements = 0;
  const original = f.tool.restoreResult!, withReceiver = Object.assign({}, f.tool, { marker: 'original' });
  withReceiver.restoreResult = async function (this: typeof withReceiver, state: WorkState, input: StoredToolResultInput) {
    assert.equal(this, withReceiver); return original(state, input);
  };
  const contracts = new ToolContracts([withReceiver], f.schemas);
  withReceiver.restoreResult = async () => { replacements++; return { kind: 'absent' }; };
  const restored = await contracts.restoreResult(await f.current(), { attemptId: f.attempt.id, task: f.task });
  assert.equal(restored.kind, 'available'); assert.equal(replacements, 0);
  assert.throws(() => snapshotTool({ ...f.tool, restoreResult: true } as unknown as Tool), /invalid_tool_adapter/);
});

test('restore callback contract rejects extra fields, wrong identities and unsafe result effects', async () => {
  const f = await storedResultFixture(), state = await f.current();
  for (const change of ['absent-extra', 'receipt-extra', 'attempt', 'effect'] as const) {
    let value: unknown = await available(f);
    if (change === 'absent-extra') value = { kind: 'absent', artifact: f.raw };
    else {
      const result = value as Available;
      if (change === 'receipt-extra') Object.assign(result.receipt, { trusted: true });
      if (change === 'attempt') result.result.attemptId = 'other-attempt';
      if (change === 'effect') result.result.effectState = 'confirmed';
    }
    const contracts = new ToolContracts([{ ...f.tool, restoreResult: async () => value as StoredToolResult }], f.schemas);
    await assert.rejects(contracts.restoreResult(state, { attemptId: f.attempt.id, task: f.task }), change);
  }
});

test('simple recovery refuses reuse and computer contracts without changing existing definition digests', async () => {
  const f = await storedResultFixture(), state = await f.current();
  const without = { ...f.tool }; delete without.restoreResult;
  assert.deepEqual(snapshotTool(without).definition, snapshotTool(f.tool).definition);
  for (const definition of [
    { ...f.tool.definition, reuse: { mode: 'immutable' as const, sourceVersion: 'snapshot-1' } },
    { ...f.tool.definition, computerContinuation: 'verify' as const },
    { ...f.tool.definition, collection: { kind: 'paged' as const,
      limits: { maxPages: 1, maxItems: 1, maxPageBytes: 1024, maxCheckpointBytes: 2048, maxCalls: 1, pageSize: 1 } } },
    { ...f.tool.definition, effect: 'write' as const },
  ]) {
    const contracts = new ToolContracts([{ ...f.tool, definition }], f.schemas);
    await assert.rejects(contracts.restoreResult(state, { attemptId: f.attempt.id, task: f.task }), /stored_result_restore_unavailable/);
  }
  const contracts = new ToolContracts([without], f.schemas);
  assert.equal(new StoredToolResults(f.services, contracts).candidate(state, f.attempt.id), false);
});
