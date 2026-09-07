import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Json, WorkState } from '../domain/model.js';
import type { ReadCollectionBinding, ReadCollectionSource, ReadUsageRestoreInput } from '../application/ports.js';
import { asJson } from '../application/plan-validator.js';
import { createReadCollectionTool } from '../application/read-collections.js';
import { ReadCheckpointReader } from '../application/read-checkpoint-store.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { McpCallError } from '../infrastructure/mcp-stdio-client.js';
import { createMcpStoredReadCollection } from '../infrastructure/mcp-read-collections.js';
import { adapters } from './state-conformance-helpers.js';
import { createMcpCollectionCustodyFixture, type CollectionCustodyRequest } from './mcp-collection-custody-fixture.js';

type Fixture = Awaited<ReturnType<typeof createMcpCollectionCustodyFixture>>;
function one(f: Fixture): CollectionCustodyRequest {
  assert.equal(f.requests.size, 1); return [...f.requests.values()][0]!;
}
function marker(outcome: 'returned' | 'captured' | 'failure', transportCalls: 0 | 1,
  recordedAtKind: 'decoded_response' | 'response_prepared'): Json {
  return { schemaVersion: 1, outcome, transportCalls, recordedAtKind };
}
async function assertOriginal(f: Fixture, request: CollectionCustodyRequest, expected: Json) {
  const receipt = await f.response(request); assert.ok(receipt); assert.ok(request.raw);
  const raw = await f.raw(request);
  assert.equal(raw.bytes.byteLength, request.raw.byteLength);
  assert.equal(raw.envelope['kind'], 'mcp_collection_response');
  assert.equal(raw.envelope['workId'], request.workId);
  assert.equal(raw.envelope['attemptId'], request.input.attemptId);
  assert.deepEqual(raw.envelope['request'], request.input.request);
  assert.deepEqual(raw.envelope['intentHead'], request.intentHead);
  assert.deepEqual(raw.envelope['session'], f.session);
  assert.equal(receipt.digest, f.services.digester.digest({ type: 'mcp_collection_response_recorded',
    data: asJson({ attemptId: request.input.attemptId, requestId: request.input.request.requestId,
      artifact: request.raw, custody: expected }) }));
  if (request.capture) assert.deepEqual(raw.envelope['value'], JSON.parse(request.capture.json));
  return { raw, receipt };
}
async function assertReadOnlyUsage(f: Fixture, request: CollectionCustodyRequest, transportCalls: number | null,
  responseObserved: boolean, custodyOnly = true) {
  const before = await f.current(request.workId), events = await f.services.state.events(request.workId, 0);
  const counters = { ...f.counters }, receipt = await f.response(request); assert.ok(receipt); assert.ok(request.raw);
  const original = await f.raw(request), value = await f.restore(request);
  assert.equal(value.kind, 'available'); if (value.kind !== 'available') assert.fail('usage proof is required');
  assert.deepEqual(value.usage, { transportCalls, internalOperations: null, imageBytes: null, waitMs: null });
  assert.equal(value.responseObserved, responseObserved); assert.equal(value.custodyOnly, custodyOnly);
  assert.equal(value.receivedAt, original.envelope['recordedAt']);
  assert.deepEqual(value.receipt, { commandId: `mcp-page:${request.input.attemptId}:${request.input.request.requestId}`,
    digest: receipt.digest, artifact: request.raw });
  const intentId = `read:${request.input.attemptId}:${request.intentHead.id}`;
  const intent = await f.services.state.receipt(request.workId, intentId); assert.ok(intent);
  assert.deepEqual(value.intent, { commandId: intentId, digest: intent.digest, artifact: request.intentHead });
  assert.equal(Object.hasOwn(value, 'response'), false); assert.equal(Object.hasOwn(value, 'result'), false);
  assert.deepEqual(await f.restore(request), value, 'the same page receipt remains repeatable');
  assert.deepEqual(await f.composed.contracts.restoreReadUsage(before, request.input), value, 'the registered Tool callback preserves the source proof');
  assert.deepEqual(await f.current(request.workId), before); assert.deepEqual(await f.services.state.events(request.workId, 0), events);
  assert.deepEqual(await f.response(request), receipt);
  assert.deepEqual(Buffer.from((await f.raw(request)).bytes), Buffer.from(original.bytes));
  assert.deepEqual(f.counters, counters, 'proof reads never call, project, build a manifest, or publish');
  return value;
}

for (const backend of adapters) {
  for (const mode of ['returned', 'captured-failure'] as const) {
    test(`${backend}: collection ${mode} retains one request after policy narrowing without projecting it`, { timeout: 15000 }, async t => {
      const f = await createMcpCollectionCustodyFixture(t, backend); const p = await f.prepare();
      const dispatch = await f.services.state.receipt(p.workId, `dispatch:${p.attempt.id}`);
      f.controls.callMode = mode;
      f.controls.afterCapture = request => f.mutate(state => {
        state.policy.allowedLabels = []; state.policy.allowedTools = []; state.policy.allowedDestinations = [];
      }, request.workId);
      await assert.rejects(f.invoke(p.attempt.id), /broker_execution_not_current|read_scope_changed|read_interrupted/);
      const request = one(f), original = await assertOriginal(f, request,
        marker(mode === 'returned' ? 'returned' : 'captured', 1, 'decoded_response'));
      assert.equal(original.raw.envelope['recordedAt'], 1100); assert.equal(original.raw.envelope['failure'], null);
      assert.equal(f.counters.calls, 1); assert.equal(f.counters.rawPuts, 1); assert.equal(f.counters.responseCommits, 1);
      assert.equal(f.counters.projections, 0);
      const state = await f.current(), attempt = state.attempts[0]!;
      assert.deepEqual(state.policy.allowedLabels, []); assert.equal(state.evidence.length, 0);
      assert.equal(attempt.resultId, null); assert.equal(attempt.adopted, false); assert.equal(attempt.owner, p.attempt.owner);
      assert.equal(attempt.leaseUntil, p.attempt.leaseUntil);
      assert.deepEqual(await f.services.state.receipt(p.workId, `dispatch:${p.attempt.id}`), dispatch);
      await assertReadOnlyUsage(f, request, 1, true);
      if (mode === 'captured-failure') assert.deepEqual(await f.restoreResponse(request), { kind: 'custody_only', reason: 'captured' });
      else await assert.rejects(f.restoreResponse(request), /mcp_saved_response_invalid/);
      assert.equal(f.counters.projections, 0);
      if (mode === 'captured-failure') assert.equal(f.sourceErrors[0], f.errors.captured);
      await assert.rejects(request.custody!, /broker_response_custody_closed/, 'custody ends with the invocation');
    });
  }

  test(`${backend}: normal pages remain verifiable after the current head advances and the stores reopen`, { timeout: 15000 }, async t => {
    const f = await createMcpCollectionCustodyFixture(t, backend, { family: 'observations' });
    const p = await f.prepare(); const result = await f.invoke(p.attempt.id);
    assert.equal(result.status, 'success'); assert.equal(f.requests.size, 2);
    assert.equal(f.counters.calls, 2); assert.equal(f.counters.captures, 2);
    const state = await f.current(), cp = await f.checkpoint();
    assert.equal(cp.collection.pages.length, 2); assert.equal(state.evidence.length, 0, 'Broker has not received or adopted the result');
    const originals = await Promise.all([...f.requests.values()].map(async request => {
      assert.notEqual(state.attempts[0]!.readProgress!.head.id, request.intentHead.id);
      return assertOriginal(f, request, marker('returned', 1, 'decoded_response'));
    }));
    await f.reopen();
    for (const [index, request] of [...f.requests.values()].entries()) {
      await assertReadOnlyUsage(f, request, 1, true);
      const restored = await f.restoreResponse(request); assert.equal(restored.kind, 'available');
      if (restored.kind !== 'available') assert.fail('normal marked page must retain body restoration');
      assert.deepEqual(restored.response, cp.collection.pages[index]);
      assert.deepEqual(await f.response(request), originals[index]!.receipt);
      assert.deepEqual(Buffer.from((await f.raw(request)).bytes), Buffer.from(originals[index]!.raw.bytes));
    }
    assert.equal(f.counters.calls, 2); assert.equal(f.counters.fetches, 2);
  });
}

for (const seam of ['beforeRaw', 'afterRaw', 'beforeResponseCommit'] as const) {
  test(`collection cancellation at ${seam} preserves raw custody but no current page`, { timeout: 15000 }, async t => {
    const f = await createMcpCollectionCustodyFixture(t); const p = await f.prepare(); let reached = 0;
    f.controls[seam] = async () => {
      reached++; const state = await f.current();
      await f.composed.runtime.command(p.workId, `cancel-${seam}`,
        { tenantId: state.policy.tenantId, principalId: state.policy.principalId }, state.goal.revision,
        { kind: 'cancel', reason: 'Stop after the original collection response' });
      f.controller.abort();
    };
    await assert.rejects(f.invoke(p.attempt.id), /broker_execution_not_current|read_interrupted|read_scope_changed/);
    assert.equal(reached, 1); const request = one(f);
    await assertOriginal(f, request, marker('returned', 1, 'decoded_response'));
    await assertReadOnlyUsage(f, request, 1, true);
    const state = await f.current(); assert.equal(state.status, 'cancelled'); assert.equal(state.evidence.length, 0);
    assert.equal(state.attempts[0]!.resultId, null); assert.equal(state.attempts[0]!.owner, p.attempt.owner);
    assert.equal(state.attempts[0]!.leaseUntil, p.attempt.leaseUntil); assert.equal(f.counters.projections, 0);
  });
}

for (const [change, seam] of [['owner', 'afterCapture'], ['generation', 'afterRaw'], ['intent', 'beforeResponseCommit']] as const) {
  test(`collection ${change} corruption at ${seam} cannot publish the original response`, { timeout: 15000 }, async t => {
    const f = await createMcpCollectionCustodyFixture(t); const p = await f.prepare(); let reached = 0;
    f.controls[seam] = async request => {
      reached++;
      if (change === 'intent') f.controls.damageReceipt = 'intent';
      else await f.mutate(state => {
        if (change === 'owner') state.attempts[0]!.owner = 'another-owner';
        else state.dataLifecycle = { generation: 1, blockedArtifactIds: [], changes: [] };
      }, request.workId);
    };
    // ReadCollections may translate a source error into an empty partial result; neither is a page acceptance.
    const result = await f.invoke(p.attempt.id).catch(() => null);
    if (result) { assert.equal(result.status, 'partial'); assert.equal(result.evidence.length, 0); }
    assert.equal(reached, 1); assert.equal(f.counters.calls, 1); assert.equal(f.counters.projections, 0);
    const request = one(f); assert.equal(await f.response(request), null);
    assert.equal(f.counters.responseCommits, 0); assert.equal(f.counters.rawPuts, change === 'owner' ? 0 : 1);
    assert.ok(f.sourceErrors.some(error => error instanceof Error &&
      /broker_response_custody_invalid|read_intent_changed|mcp_custody_changed|mcp_saved_response_invalid/.test(error.message)));
    assert.deepEqual(await f.restore(request), { kind: 'absent' });
    const state = await f.current(); assert.equal(state.evidence.length, 0); assert.equal(state.attempts[0]!.resultId, null);
    assert.equal(state.attempts[0]!.adopted, false);
  });
}

test('a captured call failure and a custody denial retain both original errors', { timeout: 15000 }, async t => {
  const f = await createMcpCollectionCustodyFixture(t); const p = await f.prepare(); f.controls.callMode = 'captured-failure';
  f.controls.afterCapture = request => f.mutate(state => { state.attempts[0]!.owner = 'replaced-owner'; }, request.workId);
  await assert.rejects(f.invoke(p.attempt.id), /read_lease_unavailable|broker_execution_not_current/);
  assert.equal(f.sourceErrors.length, 1); const failure = f.sourceErrors[0]; assert.ok(failure instanceof AggregateError);
  assert.equal(failure.message, 'mcp_collection_custody_failed'); assert.equal(failure.errors[0], f.errors.captured);
  assert.ok(failure.errors[1] instanceof Error); assert.equal(failure.errors[1].message, 'broker_response_custody_invalid');
  assert.equal(f.counters.rawPuts, 0); assert.equal(f.counters.responseCommits, 0); assert.equal(f.counters.projections, 0);
  assert.deepEqual(await f.restore(one(f)), { kind: 'absent' });
});

test('removed current catalog entry does not erase the original in-flight collection custody', { timeout: 15000 }, async t => {
  const f = await createMcpCollectionCustodyFixture(t); const p = await f.prepare();
  f.controls.afterCapture = async () => { f.composed.contracts.replaceProvider('fixture', [], {
    expectedEpoch: f.composed.contracts.providerEpoch('fixture'), sourceRevision: 'removed-after-send' }); };
  await assert.rejects(f.invoke(p.attempt.id), /tool_contract_changed|read_tool_unavailable|read_contract_changed/);
  const request = one(f); await assertOriginal(f, request, marker('returned', 1, 'decoded_response'));
  const counters = { ...f.counters }, restored = await f.restore(request);
  assert.equal(restored.kind, 'available'); assert.deepEqual(f.counters, counters); assert.equal(f.counters.projections, 0);
  await assert.rejects(f.composed.contracts.restoreReadUsage(await f.current(), request.input), /restore_unavailable/);
});

for (const mode of ['sent-false', 'sent-true', 'arbitrary-error'] as const) {
  test(`collection ${mode} preserves only observed send information without a decoded body`, { timeout: 15000 }, async t => {
    const f = await createMcpCollectionCustodyFixture(t); const p = await f.prepare(); f.controls.callMode = mode;
    const result = await f.invoke(p.attempt.id); assert.equal(result.status, 'partial');
    const request = one(f); assert.equal(f.counters.captures, 0); assert.equal(f.counters.projections, 0); assert.equal(result.evidence.length, 0);
    if (mode === 'arbitrary-error') {
      assert.equal(f.sourceErrors[0], f.errors.arbitrary); assert.equal(await f.response(request), null);
      assert.equal(f.counters.rawPuts, 0); assert.deepEqual(await f.restore(request), { kind: 'absent' });
    } else {
      const count = mode === 'sent-false' ? 0 : 1;
      const original = await assertOriginal(f, request, marker('failure', count, 'response_prepared'));
      assert.equal(original.raw.envelope['value'], null); await assertReadOnlyUsage(f, request, count, false);
      assert.deepEqual(await f.restoreResponse(request), { kind: 'custody_only', reason: 'failure' });
    }
    assert.equal(f.counters.calls, 1, 'fixture adapter entry is not itself a confirmed transport send');
  });
}

for (const mode of ['returned-without-capture', 'sent-true'] as const) {
  test(`legacy collection ${mode} keeps the old body and unknown-send interpretations`, { timeout: 15000 }, async t => {
    const f = await createMcpCollectionCustodyFixture(t, 'sqlite', { legacyReceipt: true });
    const p = await f.prepare(); f.controls.callMode = mode; const result = await f.invoke(p.attempt.id);
    assert.equal(result.status, mode === 'sent-true' ? 'partial' : 'success'); const request = one(f);
    const receipt = await f.response(request); assert.ok(receipt); assert.ok(request.raw);
    assert.equal(receipt.digest, f.services.digester.digest({ type: 'mcp_collection_response_recorded',
      data: asJson({ attemptId: p.attempt.id, requestId: request.input.request.requestId, artifact: request.raw }) }));
    await assertReadOnlyUsage(f, request, mode === 'sent-true' ? null : 1, mode !== 'sent-true', false);
    if (mode === 'returned-without-capture') assert.equal((await f.restoreResponse(request)).kind, 'available');
    else await assert.rejects(f.restoreResponse(request), /mcp_transport_failed/);
    assert.equal(f.counters.calls, 1); assert.equal(f.counters.captures, 0);
  });
}

for (const mode of ['returned', 'returned-without-capture'] as const) {
  test(`${mode} distinguishes decoded observation from late response preparation`, { timeout: 15000 }, async t => {
    const f = await createMcpCollectionCustodyFixture(t); const p = await f.prepare(); f.controls.callMode = mode;
    f.controls.afterCapture = async () => { f.setNow(p.attempt.leaseUntil + 100); };
    await assert.rejects(f.invoke(p.attempt.id), /broker_execution_not_current|read_interrupted|read_lease_unavailable/);
    const request = one(f), decoded = mode === 'returned';
    const original = await assertOriginal(f, request, marker('returned', 1, decoded ? 'decoded_response' : 'response_prepared'));
    assert.equal(original.raw.envelope['recordedAt'], decoded ? 1100 : p.attempt.leaseUntil + 100);
    await assertReadOnlyUsage(f, request, 1, true);
    if (decoded) assert.equal((await f.restoreResponse(request)).kind, 'available', 'captured inside the original lease');
    else assert.deepEqual(await f.restoreResponse(request), { kind: 'custody_only', reason: 'late_returned' });
  });
}

test('captured failure is never restored as a page even with unchanged authority', { timeout: 15000 }, async t => {
  const f = await createMcpCollectionCustodyFixture(t); const p = await f.prepare(); f.controls.callMode = 'captured-failure';
  const result = await f.invoke(p.attempt.id); assert.equal(result.status, 'partial');
  assert.equal(f.sourceErrors[0], f.errors.captured); const request = one(f);
  await assertReadOnlyUsage(f, request, 1, true);
  assert.deepEqual(await f.restoreResponse(request), { kind: 'custody_only', reason: 'captured' });
  assert.equal(f.counters.projections, 0); assert.equal(result.evidence.length, 0);
});

test('page usage rejects wrong request/time/contract and damaged raw or original intent', { timeout: 15000 }, async t => {
  const f = await createMcpCollectionCustodyFixture(t); const p = await f.prepare(); await f.invoke(p.attempt.id);
  const request = one(f), before = { ...f.counters };
  for (const altered of [
    { ...request.input, dispatchedAt: request.input.dispatchedAt + 1 },
    { ...request.input, request: { ...request.input.request, itemLimit: request.input.request.itemLimit - 1 } },
    { ...request.input, task: { ...request.input.task, input: { ids: ['d'] } } },
  ]) await assert.rejects(f.restore(request, altered), /mcp_saved_response_invalid/);
  const changed = createMcpStoredReadCollection({ ...f.host, projectorVersion: 'different' },
    { endpointId: f.session.endpointId, protocolVersion: f.session.protocolVersion }, f.services, f.schemas);
  await assert.rejects(changed.source.restoreUsage!(await f.current(), request.input), /mcp_saved_response_invalid/);
  f.controls.damageReceipt = 'intent'; await assert.rejects(f.restore(request), /mcp_saved_response_invalid/); f.controls.damageReceipt = null;
  f.controls.damageReceipt = 'dispatch'; await assert.rejects(f.restore(request), /mcp_saved_response_invalid/); f.controls.damageReceipt = null;
  assert.ok(request.raw); await writeFile(join(f.artifactDirectory, `${request.raw.id}.blob`), '{}');
  await assert.rejects(f.restore(request), /artifact|mcp_saved_response_invalid/);
  assert.deepEqual(f.counters, before);
});

test('an impossible persisted custody marker is not accepted as either legacy or new proof', { timeout: 15000 }, async t => {
  const f = await createMcpCollectionCustodyFixture(t, 'sqlite', { receiptMarker: marker('captured', 0, 'response_prepared') });
  const p = await f.prepare(); const result = await f.invoke(p.attempt.id);
  assert.equal(result.status, 'partial'); const request = one(f); assert.ok(await f.response(request));
  const before = { ...f.counters };
  await assert.rejects(f.restore(request), /mcp_saved_response_invalid/);
  await assert.rejects(f.restoreResponse(request), /mcp_saved_response_invalid/); assert.deepEqual(f.counters, before);
});

test('two concurrent work requests retain their own captures, intents and raw payloads', { timeout: 15000 }, async t => {
  const f = await createMcpCollectionCustodyFixture(t), a = await f.prepare('work-a', ['a']), b = await f.prepare('work-b', ['b']);
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; release(); }, 3000); let arrived = 0;
  f.controls.afterCapture = async request => {
    await f.mutate(state => { state.policy.allowedLabels = []; }, request.workId);
    if (++arrived === 2) release(); await barrier;
  };
  const invocations = [f.invoke(a.attempt.id, a.workId), f.invoke(b.attempt.id, b.workId)];
  try {
    const results = await Promise.allSettled(invocations);
    assert.equal(arrived, 2, 'both requests reached the request-local capture seam');
    assert.equal(timedOut, false, 'the barrier opened because both captures arrived, not its fallback timer');
    assert.deepEqual(results.map(value => value.status), ['rejected', 'rejected']);
  } finally { release(); clearTimeout(timer); await Promise.allSettled(invocations); }
  assert.equal(f.requests.size, 2); assert.equal(f.counters.captures, 2); assert.equal(f.counters.rawPuts, 2); assert.equal(f.counters.projections, 0);
  for (const request of f.requests.values()) {
    const original = await assertOriginal(f, request, marker('returned', 1, 'decoded_response'));
    assert.ok(request.capture); const payload = JSON.parse(request.capture.json).structuredContent as { records: { id: string }[]; requestId: string };
    assert.deepEqual(payload.records.map(value => value.id), request.input.task.input['ids']);
    assert.equal(payload.requestId, request.input.request.requestId); await assertReadOnlyUsage(f, request, 1, true);
    const other = [...f.requests.values()].find(value => value !== request)!;
    assert.notEqual(original.raw.envelope['attemptId'], other.input.attemptId); assert.notEqual(request.raw!.id, other.raw!.id);
    assert.deepEqual(await f.reader().source.restoreUsage!(await f.current(other.workId), request.input), { kind: 'absent' },
      'another work cannot authenticate this request receipt');
  }
});

test('real stdio SDK post-capture abort preserves the collection original without a fabricated successful reply', { timeout: 20000 }, async t => {
  const f = await createMcpCollectionCustodyFixture(t, 'sqlite', { transport: 'stdio' }); const p = await f.prepare();
  f.controls.afterDecoded = () => { f.controller.abort(); };
  await assert.rejects(f.invoke(p.attempt.id), /broker_execution_not_current|read_interrupted/);
  const request = one(f); await assertOriginal(f, request, marker('captured', 1, 'decoded_response'));
  assert.equal(f.clientErrors.length, 1); const failure = f.clientErrors[0]; assert.ok(failure instanceof McpCallError);
  assert.equal(failure.stage, 'post_response'); assert.equal(failure.code, 'mcp_cancelled'); assert.equal(failure.sent, true);
  assert.equal(f.sourceErrors[0], failure); assert.equal(f.peer()!.snapshot().toolCalls, 1);
  assert.equal(f.counters.captures, 1); assert.equal(f.counters.projections, 0);
  assert.equal((await f.audit()).filter(value => value.event === 'call').length, 1);
  await assertReadOnlyUsage(f, request, 1, true);
  assert.deepEqual(await f.restoreResponse(request), { kind: 'custody_only', reason: 'captured' });
  assert.equal(f.peer()!.snapshot().processCloses, 1);
});

test('collection registration reads source and restoreUsage getters once and binds that exact callback', { timeout: 15000 }, async t => {
  const f = await createMcpCollectionCustodyFixture(t); const p = await f.prepare(); await f.invoke(p.attempt.id);
  const request = one(f), original = f.source.source.restoreUsage; assert.ok(original);
  let sourceReads = 0, callbackReads = 0, callbackCalls = 0;
  const bad = async () => { assert.fail('a later getter value must not replace the reviewed callback'); };
  const selected: ReadCollectionSource = { ...f.source.source, get restoreUsage() {
    callbackReads++;
    return callbackReads === 1 ? async function(this: ReadCollectionSource, state: WorkState, input: ReadUsageRestoreInput) {
      assert.equal(this, selected); callbackCalls++; return original.call(this, state, input);
    } : bad;
  } };
  const supplied: ReadCollectionBinding = { definition: f.source.definition, get source() {
    sourceReads++; return sourceReads === 1 ? selected : { ...f.source.source, restoreUsage: bad };
  } };
  // createReadCollectionTool exercises snapshotReadCollectionBinding; ToolContracts then registers the captured tool.
  const contracts = new ToolContracts([createReadCollectionTool(supplied, () => f.composed.readCollections)], f.schemas);
  assert.equal(sourceReads, 1); assert.equal(callbackReads, 1);
  const expected = await f.restore(request), counters = { ...f.counters };
  for (let repeat = 0; repeat < 2; repeat++) assert.deepEqual(await contracts.restoreReadUsage(await f.current(), request.input), expected);
  assert.equal(callbackCalls, 2); assert.equal(sourceReads, 1); assert.equal(callbackReads, 1);
  assert.deepEqual(f.counters, counters);
});

test('the first intent receipt must carry its original work and attempt even when digest and head match', { timeout: 20000 }, async t => {
  for (const changed of ['work', 'createdAt', 'owner'] as const) {
    const f = await createMcpCollectionCustodyFixture(t); const p = await f.prepare();
    const read = f.services.state.receipt.bind(f.services.state);
    const observed: { commandId: string; receipt: { digest: string; state: WorkState } }[] = [];
    const mock = t.mock.method(f.services.state, 'receipt', async (workId: string, commandId: string) => {
      const receipt = await read(workId, commandId);
      if (observed.length || !receipt || workId !== p.workId || !commandId.startsWith(`read:${p.attempt.id}:`)) return receipt;
      const attempt = receipt.state.attempts.find(value => value.id === p.attempt.id), head = attempt?.readProgress?.head;
      if (!head || commandId !== `read:${p.attempt.id}:${head.id}`) return receipt;
      const checkpoint = await new ReadCheckpointReader(receipt.state, f.services.artifacts, f.services.digester).load(head);
      if (checkpoint.calls.at(-1)?.status !== 'intent') return receipt;
      observed.push({ commandId, receipt: structuredClone(receipt) });
      const supplied = structuredClone(receipt);
      if (changed === 'work') supplied.state.id = 'foreign-work';
      else if (changed === 'createdAt') supplied.state.createdAt++;
      else supplied.state.attempts.find(value => value.id === p.attempt.id)!.owner = 'foreign-owner';
      assert.equal(supplied.digest, receipt.digest);
      assert.deepEqual(supplied.state.attempts.find(value => value.id === p.attempt.id)!.readProgress!.head, head);
      return supplied;
    });
    try {
      await assert.rejects(f.invoke(p.attempt.id), /read_intent_changed|read_lease_unavailable/);
      assert.equal(observed.length, 1, `${changed} replacement reached the first persisted intent read`);
      assert.equal(f.counters.fetches, 0); assert.equal(f.counters.calls, 0); assert.equal(f.counters.captures, 0);
      assert.equal(f.counters.rawPuts, 0); assert.equal(f.counters.responseCommits, 0);
      assert.deepEqual(await read(p.workId, observed[0]!.commandId), observed[0]!.receipt, 'only the read return was substituted');
      const state = await f.current(); assert.equal(state.evidence.length, 0); assert.equal(state.attempts[0]!.resultId, null);
      assert.equal(state.attempts[0]!.owner, p.attempt.owner); assert.equal(state.id, p.workId);
    } finally { mock.mock.restore(); }
  }
});
