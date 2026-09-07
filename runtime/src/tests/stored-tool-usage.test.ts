import test from 'node:test';
import assert from 'node:assert/strict';
import type { ToolUsage } from '../domain/model.js';
import type { StoredToolResultInput, StoredToolUsage, Tool } from '../application/ports.js';
import { StoredToolUsages } from '../application/stored-tool-usage.js';
import { summarizeToolExecution, toolExecution } from '../application/tool-execution-usage.js';
import { ToolContracts, snapshotTool } from '../application/tool-contracts.js';
import { createExecutionAuthority } from '../application/execution-authority.js';
import { transact } from '../application/work-transactions.js';
import { storedResultFixture } from './stored-result-fixture.js';
import { command, snapshot } from './state-conformance-helpers.js';

type Available = Extract<StoredToolUsage, { kind: 'available' }>;
const measured: ToolUsage = { transportCalls: 1, internalOperations: null, imageBytes: null, waitMs: null };
async function fixture(options: { publishResponse?: boolean } = {}) {
  const f = await storedResultFixture(options);
  const controls: { calls: number; before?: () => Promise<void>; value?: StoredToolUsage; input?: StoredToolResultInput } = { calls: 0 };
  const tool: Tool = { ...f.tool, async restoreUsage(current, input) {
    controls.calls++; controls.input = structuredClone(input); await controls.before?.();
    if (controls.value) return structuredClone(controls.value);
    const receipt = await f.state.receipt(current.id, f.responseCommandId);
    return receipt ? { kind: 'available', usage: structuredClone(measured), receivedAt: f.receivedAt,
      receipt: { commandId: f.responseCommandId, digest: receipt.digest, artifact: structuredClone(f.raw) },
      custodyOnly: true, responseObserved: true } : { kind: 'absent' };
  } };
  const contracts = new ToolContracts([tool], f.schemas);
  return { ...f, usageControls: controls, usageTool: tool, usageContracts: contracts, usages: new StoredToolUsages(f.services, contracts) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function available(f: Fixture): Promise<Available> {
  const value = await f.usageContracts.restoreUsage(await f.current(), { attemptId: f.attempt.id, task: f.task });
  assert.ok(value.kind === 'available'); return value;
}
function mutateReceipt(f: Fixture, commandId: string, edit: (value: NonNullable<Awaited<ReturnType<Fixture['state']['receipt']>>>) => void) {
  const read = f.state.receipt.bind(f.state);
  f.state.receipt = async (workId, id) => {
    const value = await read(workId, id); if (value && id === commandId) edit(value); return value;
  };
}

test('stored usage returns only frozen measurements and custody references without writes or result validation', async () => {
  const f = await fixture(), state = await f.current();
  const commands = [`dispatch:${f.attempt.id}`, f.responseCommandId, `receive:${f.attempt.id}`, `adopt:${f.attempt.id}`];
  const before = await snapshot(f.state, f.workId, commands);
  let writes = 0;
  const commit = f.state.commit.bind(f.state), put = f.artifacts.put.bind(f.artifacts);
  f.state.commit = async input => { writes++; return commit(input); };
  f.artifacts.put = async (...args) => { writes++; return put(...args); };
  const ticket = await f.usages.prepare(state, f.attempt.id); assert.ok(ticket);
  assert.deepEqual(Object.keys(ticket).sort(), ['workId', 'attemptId', 'usage', 'receivedAt', 'receipt', 'custodyOnly', 'responseObserved'].sort());
  assert.deepEqual(ticket.usage, measured); assert.equal(ticket.custodyOnly, true); assert.equal(ticket.responseObserved, true);
  assert.ok(Object.isFrozen(ticket) && Object.isFrozen(ticket.usage) && Object.isFrozen(ticket.receipt.artifact));
  await f.usages.assertCurrent(state, ticket);
  assert.equal(writes, 0); assert.equal(f.controls.executeCalls, 0); assert.equal(f.controls.proofCalls, 0); assert.equal(f.controls.restoreCalls, 0);
  assert.deepEqual(await snapshot(f.state, f.workId, commands), before);
});

test('stored-only registration keeps original-call usage proofs without invoking execution or body validation', async t => {
  const f = await fixture(); t.after(() => f.state.close()); const state = await f.current();
  const commands = [`dispatch:${f.attempt.id}`, f.responseCommandId, `receive:${f.attempt.id}`, `adopt:${f.attempt.id}`];
  const before = await snapshot(f.state, f.workId, commands);
  f.usageContracts.replaceProvider('fixture', [{ ...f.usageTool, availability: 'stored_only' }],
    { expectedEpoch: f.usageContracts.providerEpoch('fixture'), sourceRevision: 'stored-only' });
  assert.equal(f.usageContracts.checkExecution(f.task, state.policy), 'tool_connection_required');
  const ticket = await f.usages.prepare(state, f.attempt.id); assert.ok(ticket);
  await f.usages.assertCurrent(state, ticket);
  assert.deepEqual(ticket.usage, measured); assert.equal(ticket.receipt.commandId, f.responseCommandId);
  assert.equal(f.controls.executeCalls + f.controls.proofCalls + f.controls.restoreCalls, 0);
  assert.deepEqual(await snapshot(f.state, f.workId, commands), before);
});

test('cancelled and completed work with new goals and attempts can account for the original dispatch after authority and deadline expire', async () => {
  for (const status of ['cancelled', 'completed'] as const) {
    const f = await fixture(); const old = await f.current(), abort = new AbortController();
    f.services.executionAuthority = createExecutionAuthority({ actor: old.policy, scope: old.goal.scope, signal: abort.signal }); abort.abort();
    f.clock.advance(old.deadlineAt + 10);
    await transact(f.services, f.workId, 'changed-work', 'fixture_changed', {}, next => {
      next.status = status; next.statusReason = 'Host stop remains final'; next.policy.allowedLabels = []; next.policy.allowedTools = [];
      next.policy.allowedDestinations = []; next.policy.allowWrites = false;
      next.goal.revision++; next.goal.scope = 'new-scope'; next.plan = null;
      const original = next.attempts[0]!; original.status = 'failed'; original.error = { code: 'cancelled', retryable: false };
      original.finishedAt = f.clock.now();
      next.attempts.push({ ...structuredClone(original), id: 'new-attempt', goalRevision: next.goal.revision, owner: 'new-executor' });
    });
    const state = await f.current(), policies: unknown[] = [], read = f.artifacts.get.bind(f.artifacts);
    f.artifacts.get = async (ref, policy) => { policies.push(structuredClone(policy)); return read(ref, policy); };
    assert.equal(f.usages.candidate(state, f.attempt.id), true);
    const ticket = await f.usages.prepare(state, f.attempt.id); assert.ok(ticket);
    await f.usages.assertCurrent(state, ticket);
    assert.deepEqual(f.usageControls.input, { attemptId: f.attempt.id, task: f.task });
    assert.ok(policies.length > 0); for (const policy of policies) assert.deepEqual(policy, old.policy);
    assert.deepEqual(await f.current(), state); assert.equal(state.statusReason, 'Host stop remains final');
    assert.equal(f.controls.executeCalls + f.controls.proofCalls, 0);
  }
});

test('a dispatched attempt whose error shares a reservation code remains eligible for proven accounting', async () => {
  for (const code of ['reservation_cancelled', 'reservation_expired']) {
    const f = await fixture();
    await transact(f.services, f.workId, 'dispatched-error', 'fixture_failed', {}, next => {
      const attempt = next.attempts[0]!;
      attempt.status = 'failed'; attempt.error = { code, retryable: true }; attempt.finishedAt = f.clock.now();
    });
    const state = await f.current();
    assert.equal(state.attempts[0]!.execution?.mode, 'unreported');
    assert.equal(f.usages.candidate(state, f.attempt.id), true);
    const ticket = await f.usages.prepare(state, f.attempt.id); assert.ok(ticket);
    assert.deepEqual(ticket.usage, measured); assert.deepEqual(await f.current(), state);
    assert.equal(summarizeToolExecution(state).unknownInvocations, 1);
    const accounted = structuredClone(state); accounted.attempts[0]!.execution = toolExecution('invoked', ticket.usage);
    assert.equal(summarizeToolExecution(accounted).invoked, 1);
    assert.deepEqual(summarizeToolExecution(accounted).transportCalls, { measured: 1, unknown: 0 });
  }
});

test('responses captured beyond the original lease and deadline retain accounting while impossible time order is rejected', async () => {
  const f = await fixture({ publishResponse: false }), original = await f.current();
  f.clock.advance(original.deadlineAt + 5);
  await transact(f.services, f.workId, 'cancel-before-response', 'fixture_cancelled', {}, next => {
    next.status = 'cancelled'; next.statusReason = 'Already cancelled'; next.goal.revision++; next.plan = null;
    next.policy.allowedLabels = []; next.policy.allowedTools = []; next.attempts[0]!.status = 'cancelled';
  });
  await f.publishResponse();
  const late = { ...await available(f), receivedAt: f.clock.now() }; f.usageControls.value = late;
  const state = await f.current(), ticket = await f.usages.prepare(state, f.attempt.id); assert.ok(ticket);
  assert.ok(ticket.receivedAt > f.attempt.leaseUntil && ticket.receivedAt > original.deadlineAt);
  await f.usages.assertCurrent(state, ticket);
  for (const time of [999, f.clock.now() + 1]) {
    late.receivedAt = time;
    await assert.rejects(f.usages.prepare(state, f.attempt.id), /stored_usage_time_invalid/);
  }
});

test('absent receipts are not found by scanning raw artifacts and missing callbacks are not candidates', async () => {
  const f = await fixture({ publishResponse: false }), state = await f.current();
  assert.equal(await f.usages.prepare(state, f.attempt.id), null); assert.equal(await f.artifacts.exists(f.raw), true);
  const tool = { ...f.usageTool }; delete tool.restoreUsage;
  assert.equal(new StoredToolUsages(f.services, new ToolContracts([tool], f.schemas)).candidate(state, f.attempt.id), false);
  assert.deepEqual(snapshotTool(tool).definition, snapshotTool(f.usageTool).definition);
  const reserved = structuredClone(state); reserved.attempts[0]!.status = 'reserved';
  const calls = f.usageControls.calls;
  assert.equal(f.usages.candidate(reserved, f.attempt.id), false);
  await assert.rejects(f.usages.prepare(reserved, f.attempt.id), /stored_usage_not_eligible/);
  assert.equal(f.usageControls.calls, calls);
  assert.equal(f.controls.executeCalls, 0);
});

test('received and adopted originals stay unchanged and usage-only proofs can distinguish an unobserved response', async () => {
  const f = await fixture();
  await f.original.receive(f.workId, f.attempt.id, f.result); await f.original.adopt(f.workId, f.attempt.id);
  const state = await f.current(), ticket = await f.usages.prepare(state, f.attempt.id); assert.ok(ticket);
  assert.equal(state.attempts[0]!.adopted, true); await f.usages.assertCurrent(state, ticket); assert.deepEqual(await f.current(), state);
  f.usageControls.value = { ...await available(f), custodyOnly: true, responseObserved: false };
  const failureTicket = await f.usages.prepare(state, f.attempt.id); assert.ok(failureTicket);
  assert.equal(failureTicket.responseObserved, false); assert.deepEqual(failureTicket.usage, measured);
});

test('original owner, identity, generation and exact response reference cannot be substituted', async () => {
  for (const change of ['owner', 'tenant', 'principal', 'generation', 'reference-labels', 'contract', 'input'] as const) {
    const f = await fixture();
    const state = await f.current();
    {
      if (change === 'owner') state.attempts[0]!.owner = 'someone-else';
      if (change === 'tenant') state.policy.tenantId = 'other-tenant';
      if (change === 'principal') state.policy.principalId = 'other-principal';
      if (change === 'generation') state.dataLifecycle = { generation: 1, blockedArtifactIds: [], changes: [] };
      if (change === 'reference-labels') state.artifacts[0]!.labels = [];
      if (change === 'contract') state.attempts[0]!.contractDigest = '0'.repeat(64);
      if (change === 'input') state.attempts[0]!.inputDigest = '0'.repeat(64);
    }
    // Deliberately damaged state bypasses artifact publication checks to exercise this reader's boundary.
    state.revision++; state.updatedAt = f.clock.now();
    assert.equal((await f.state.commit(command(state, 'tamper'))).kind, 'committed');
    const expected = change === 'contract' ? 'stored_usage_not_eligible' : change === 'reference-labels' ? 'stored_usage_original_unavailable' : 'stored_usage_invalid';
    await assert.rejects(f.usages.prepare(await f.current(), f.attempt.id), { message: expected }, change);
    assert.equal(f.controls.executeCalls, 0);
  }
  // Dispatch and response are really committed at generation 1 before testing the raw-block guard independently.
  {
    const f = await fixture();
    await transact(f.services, f.workId, 'generation-one', 'fixture_lifecycle', {}, state => {
      state.dataLifecycle = { generation: 1, blockedArtifactIds: [], changes: [] };
      const first = state.attempts[0]!; first.status = 'failed'; first.finishedAt = f.clock.now();
      first.error = { code: 'fixture_retryable', retryable: true }; state.status = 'ready';
    });
    f.clock.advance(10);
    const attempt = await f.original.reserve(f.workId, f.task.id); await f.original.dispatch(f.workId, attempt.id);
    const receivedAt = f.clock.now();
    const raw = await f.artifacts.put(new TextEncoder().encode(JSON.stringify({ attemptId: attempt.id, receivedAt, generation: 1 })),
      { tenantId: (await f.current()).policy.tenantId, labels: ['synthetic'], mediaType: 'application/json' });
    const commandId = `generation-one-response:${attempt.id}`;
    await transact(f.services, f.workId, commandId, 'fixture_response_recorded', { attemptId: attempt.id }, state => { state.artifacts.push(raw); });
    const dispatch = await f.state.receipt(f.workId, `dispatch:${attempt.id}`), response = await f.state.receipt(f.workId, commandId);
    assert.ok(dispatch && response); assert.equal(dispatch.state.dataLifecycle?.generation, 1); assert.equal(response.state.dataLifecycle?.generation, 1);
    const restored: Available = { kind: 'available', usage: measured, receivedAt,
      receipt: { commandId, digest: response.digest, artifact: raw }, custodyOnly: true, responseObserved: true };
    const contracts = new ToolContracts([{ ...f.usageTool, restoreUsage: async () => structuredClone(restored) }], f.schemas);
    const usages = new StoredToolUsages(f.services, contracts);
    assert.ok(await usages.prepare(await f.current(), attempt.id));
    await transact(f.services, f.workId, 'block-current-raw', 'fixture_raw_blocked', {}, state => { state.dataLifecycle!.blockedArtifactIds.push(raw.id); });
    const blocked = await f.current(); assert.equal(blocked.dataLifecycle?.generation, 1);
    await assert.rejects(usages.prepare(blocked, attempt.id), { message: 'stored_usage_original_unavailable' });
    assert.equal(f.controls.executeCalls, 0);
  }
  for (const change of ['dispatch-digest', 'response-digest', 'response-reference', 'response-owner', 'response-generation'] as const) {
    const f = await fixture(); f.usageControls.value = await available(f);
    mutateReceipt(f, change === 'dispatch-digest' ? `dispatch:${f.attempt.id}` : f.responseCommandId, receipt => {
      if (change.endsWith('digest')) receipt.digest = '0'.repeat(64);
      if (change === 'response-reference') receipt.state.artifacts = [];
      if (change === 'response-owner') receipt.state.attempts[0]!.owner = 'other-owner';
      if (change === 'response-generation') receipt.state.dataLifecycle = { generation: 1, blockedArtifactIds: [], changes: [] };
    });
    await assert.rejects(f.usages.prepare(await f.current(), f.attempt.id), /stored_usage_invalid/, change);
  }
});

test('raw hashing and the fixed 512 KiB bound apply even when the current actor cannot read the original', async () => {
  const f = await fixture(), stateBefore = await f.current(), ticket = await f.usages.prepare(stateBefore, f.attempt.id); assert.ok(ticket);
  const read = f.artifacts.get.bind(f.artifacts);
  f.artifacts.get = async (ref, policy) => { const bytes = await read(ref, policy); bytes[0] = bytes[0]! ^ 1; return bytes; };
  await assert.rejects(f.usages.prepare(await f.current(), f.attempt.id), /stored_usage_original_unavailable/);
  await assert.rejects(f.usages.assertCurrent(stateBefore, ticket), /stored_usage_original_unavailable/);
  const g = await fixture(), state = await g.current();
  const ref = await g.artifacts.put(new Uint8Array(512 * 1024 + 1), { tenantId: state.policy.tenantId, labels: ['synthetic'], mediaType: 'application/json' });
  await transact(g.services, g.workId, 'large-response', 'fixture_response', {}, next => { next.artifacts.push(ref); });
  const response = await g.state.receipt(g.workId, 'large-response'); assert.ok(response);
  g.usageControls.value = { ...await available(g), receipt: { commandId: 'large-response', digest: response.digest, artifact: ref } };
  let rawReads = 0; const get = g.artifacts.get.bind(g.artifacts);
  g.artifacts.get = async (...args) => { rawReads++; return get(...args); };
  await assert.rejects(g.usages.prepare(await g.current(), g.attempt.id), /stored_usage_original_unavailable/);
  assert.equal(rawReads, 0);
});

test('fabricated tickets, a changed snapshot, callback race and source receipt replacement never authorize accounting', async () => {
  const f = await fixture(), state = await f.current(), ticket = await f.usages.prepare(state, f.attempt.id); assert.ok(ticket);
  await assert.rejects(f.usages.assertCurrent(state, structuredClone(ticket)), /stored_usage_ticket_invalid/);
  await assert.rejects(new StoredToolUsages(f.services, f.usageContracts).assertCurrent(state, ticket), /stored_usage_ticket_invalid/);
  f.usageControls.before = async () => { await transact(f.services, f.workId, 'racing-note', 'fixture_note', {}, next => { next.statusReason = 'Another commit'; }); };
  await assert.rejects(f.usages.prepare(state, f.attempt.id), /stored_usage_changed/);
  await assert.rejects(f.usages.assertCurrent(await f.current(), ticket), /stored_usage_ticket_invalid/);
  const g = await fixture(), originalGet = g.artifacts.get.bind(g.artifacts);
  g.artifacts.get = async (...args) => {
    const bytes = await originalGet(...args); mutateReceipt(g, g.responseCommandId, value => { value.digest = '0'.repeat(64); }); return bytes;
  };
  await assert.rejects(g.usages.prepare(await g.current(), g.attempt.id), /stored_usage_changed/);
});

test('registration pins the usage callback receiver and rejects extra body fields or invalid usage without invoking result projection', async () => {
  const f = await fixture(), tool = { ...f.usageTool }, original = tool.restoreUsage!;
  let replacementCalls = 0;
  tool.restoreUsage = async function (state, input) { assert.equal(this, tool); return original(state, input); };
  const contracts = new ToolContracts([tool], f.schemas);
  tool.restoreUsage = async () => { replacementCalls++; return { kind: 'absent' }; };
  assert.equal((await contracts.restoreUsage(await f.current(), { attemptId: f.attempt.id, task: f.task })).kind, 'available');
  assert.equal(replacementCalls, 0);
  assert.throws(() => snapshotTool({ ...f.usageTool, restoreUsage: true } as unknown as Tool), /invalid_tool_adapter/);
  const good = await available(f);
  for (const value of [{ kind: 'absent', output: {} }, { ...good, output: { secret: true } }, { ...good, custodyOnly: 'true' },
    { ...good, usage: { ...measured, transportCalls: -1 } }, { ...good, receipt: { ...good.receipt, body: 'secret' } }]) {
    const invalid = new ToolContracts([{ ...f.usageTool, restoreUsage: async () => value as StoredToolUsage }], f.schemas);
    await assert.rejects(invalid.restoreUsage(await f.current(), { attemptId: f.attempt.id, task: f.task }));
  }
  assert.equal(f.controls.proofCalls, 0);
});

test('provider replacement during usage restoration invalidates the captured callback and nonplain contracts remain excluded', async () => {
  const f = await fixture();
  f.usageControls.before = async () => { f.usageContracts.replaceProvider('fixture', [f.usageTool], {
    expectedEpoch: f.usageContracts.providerEpoch('fixture'), sourceRevision: 'new-provider-publication' }); };
  await assert.rejects(f.usages.prepare(await f.current(), f.attempt.id), /stored_usage_changed/);
  const state = await f.current();
  for (const definition of [
    { ...f.usageTool.definition, effect: 'write' as const },
    { ...f.usageTool.definition, reuse: { mode: 'immutable' as const, sourceVersion: 'snapshot' } },
    { ...f.usageTool.definition, computerContinuation: 'verify' as const },
    { ...f.usageTool.definition, collection: { kind: 'paged' as const,
      limits: { maxPages: 1, maxItems: 1, maxPageBytes: 1024, maxCheckpointBytes: 2048, maxCalls: 1, pageSize: 1 } } },
  ]) {
    const contracts = new ToolContracts([{ ...f.usageTool, definition }], f.schemas);
    await assert.rejects(contracts.restoreUsage(state, { attemptId: f.attempt.id, task: f.task }), /stored_usage_restore_unavailable/);
  }
});
