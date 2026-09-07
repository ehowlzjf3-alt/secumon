import test from 'node:test';
import assert from 'node:assert/strict';
import type { KnowledgeDependency } from '../domain/knowledge.js';
import type { ArtifactRef, Evidence } from '../domain/model.js';
import type { ReadCollectionState, ReadItem, ReadKey, ReadLimits, ReadPage, ReadRequest } from '../domain/read-collection.js';
import { ReadCollectionStateSchema, ReadItemSchema, ReadLimitsSchema, ReadPageSchema } from '../application/read-collection-contracts.js';
import { acceptPage, initialize, nextRequest, ReadCollectionError } from '../application/read-collection-validation.js';

const limits: ReadLimits = { maxPages: 8, maxItems: 20, maxCalls: 12, maxPageBytes: 65536, maxCheckpointBytes: 262144, pageSize: 5 };
const key = (id: string): ReadKey => ({ id, inputDigest: id.charCodeAt(0).toString(16).padStart(2, '0').repeat(32) });
const artifact: ArtifactRef = { id: 'original-bytes', sha256: 'a'.repeat(64), byteLength: 5, mediaType: 'text/plain', tenantId: 'tenant', labels: ['synthetic'] };
const evidence: Evidence = { id: 'original-evidence', tenantId: 'tenant', scope: 'fixture', sourceId: 'original-source', lineageId: 'original-lineage',
  locator: 'fixture://original', observedAt: 10, recordedAt: 20, labels: ['synthetic'], coverage: 'complete', status: 'accepted', access: 'available',
  supersedes: [], derivedFrom: [], facts: { value: 'original' }, artifact };
const item = (id: string, status: ReadItem['status'] = 'success'): ReadItem => ({ ...key(id), status,
  output: status === 'not_run' ? null : { value: id }, evidence: [], artifacts: [],
  coverage: status === 'success' ? 'complete' : status === 'partial' ? 'partial' : 'unknown',
  error: status === 'error' ? { code: 'synthetic_failure', retryable: true } : null });
const dependency = (id: string): KnowledgeDependency => ({ tenantId: 'tenant', knowledgeId: id, knowledgeRevision: 1, actorDigest: 'a'.repeat(64),
  parents: [], sources: [{ workId: 'source-work', evidenceId: id, sourceVersion: 'b'.repeat(64), generation: 0, workRevision: 1, policyDigest: 'c'.repeat(64) }] });
function request(state: ReadCollectionState, id = 'request-1', bounds = limits): ReadRequest {
  const value = nextRequest(state, id, bounds); assert.ok(value); return value;
}
function page(request: ReadRequest, items: ReadItem[], extras: Partial<ReadPage> = {}): ReadPage {
  return { requestId: request.requestId, sourceSnapshot: request.snapshot ?? 'snapshot-1', cursor: request.cursor, nextCursor: null,
    exhausted: true, totalItems: null, expected: items.map(({ id, inputDigest }) => ({ id, inputDigest })), items, ...extras };
}
function pending() {
  const start = initialize('paged'); const next = request(start);
  const value = page(next, [item('a'), item('b', 'partial'), item('c', 'error')], { nextCursor: 'cursor-2', exhausted: false, totalItems: 4 });
  value.items[0]!.evidence = [structuredClone(evidence)]; value.items[0]!.artifacts = [structuredClone(artifact)];
  return acceptPage(start, next, value, limits);
}
function rejects(code: string, action: () => unknown) {
  assert.throws(action, error => error instanceof ReadCollectionError && error.code === code);
}
const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

test('read collection: bounded batch keeps original observations and input objects independent', () => {
  const expected = [key('a'), key('b')]; const state = initialize('batch', expected); const next = request(state);
  const response = page(next, [item('b'), item('a')], { expected: [...expected], totalItems: 2 });
  response.items[1]!.evidence = [structuredClone(evidence)]; response.items[1]!.artifacts = [structuredClone(artifact)];
  const before = structuredClone(state); const after = acceptPage(state, next, response, limits);
  assert.equal(after.exhausted, true); assert.equal(after.calls, 1); assert.equal(after.pages.length, 1); assert.equal(after.pending, null);
  assert.deepEqual(after.pages[0]!.items[1]!.evidence, [evidence]); assert.deepEqual(after.pages[0]!.items[1]!.artifacts, [artifact]);
  assert.equal(nextRequest(after, 'unused', limits), null); assert.deepEqual(state, before);
  expected[0]!.id = 'mutated'; response.items[1]!.evidence[0]!.observedAt = 999; response.items[1]!.output = null;
  assert.equal(after.batchExpected![0]!.id, 'a'); assert.equal(after.pages[0]!.items[1]!.evidence[0]!.observedAt, 10);
  assert.deepEqual(after.pages[0]!.items[1]!.output, { value: 'a' });
});

test('read collection: explicit retries request every unfinished key and advance only when the original page is complete', () => {
  let state = pending(); const original = structuredClone(state.pending!.items[0]!);
  state.pending!.usage = { transportCalls: 1, internalOperations: null, imageBytes: 2, waitMs: 3 };
  state.pending!.knowledgeDependencies = [dependency('first')];
  const retry = request(state, 'retry-1'); assert.deepEqual(retry.retryItems, [key('b'), key('c')]); assert.equal(retry.itemLimit, 2);
  const response = page(retry, [item('c', 'not_run'), item('b')], { nextCursor: 'cursor-2', exhausted: false, totalItems: 4,
    usage: { transportCalls: 2, internalOperations: 5, imageBytes: 4, waitMs: 6 }, knowledgeDependencies: [dependency('second')] });
  const after = acceptPage(state, retry, response, limits);
  assert.equal(after.calls, 2); assert.equal(after.pages.length, 0); assert.equal(after.nextCursor, null); assert.equal(after.exhausted, false);
  assert.deepEqual(after.pending!.items[0], original); assert.deepEqual(after.pending!.usage, { transportCalls: 3, internalOperations: null, imageBytes: 6, waitMs: 9 });
  assert.deepEqual(after.pending!.knowledgeDependencies, [dependency('first'), dependency('second')]);
  const finalRequest = request(after, 'retry-2'); assert.deepEqual(finalRequest.retryItems, [key('c')]);
  const final = acceptPage(after, finalRequest, page(finalRequest, [item('c')], { nextCursor: 'cursor-2', exhausted: false, totalItems: 4 }), limits);
  assert.equal(final.calls, 3); assert.equal(final.pages.length, 1); assert.equal(final.nextCursor, 'cursor-2'); assert.equal(final.pending, null);
  assert.deepEqual(final.pages[0]!.items[0], original); assert.deepEqual(final.pages[0]!.expected, [key('a'), key('b'), key('c')]);
  assert.deepEqual(final.pages[0]!.usage, { transportCalls: null, internalOperations: null, imageBytes: null, waitMs: null });
  assert.deepEqual(final.pages[0]!.knowledgeDependencies, [dependency('first'), dependency('second')]);
  const last = request(final, 'page-2'); assert.equal(last.cursor, 'cursor-2'); assert.equal(last.retryItems, null);
  const complete = acceptPage(final, last, page(last, [item('d')], { totalItems: 4 }), limits);
  assert.equal(complete.exhausted, true); assert.equal(complete.pages.length, 2); assert.equal(complete.calls, 4);
});

for (const change of ['extra', 'missing', 'wrong-digest', 'duplicate-expected', 'duplicate-item'] as const) {
  test(`read collection: ${change} cannot satisfy a trusted batch manifest`, () => {
    const state = initialize('batch', [key('a'), key('b')]); const next = request(state); const response = page(next, [item('a'), item('b')]);
    if (change === 'extra') { response.items.push(item('c')); response.expected.push(key('c')); }
    if (change === 'missing') { response.items.pop(); response.expected.pop(); }
    if (change === 'wrong-digest') { response.items[1]!.inputDigest = 'e'.repeat(64); response.expected[1]!.inputDigest = 'e'.repeat(64); }
    if (change === 'duplicate-expected') response.expected.push(key('b'));
    if (change === 'duplicate-item') response.items.push(item('b'));
    const before = structuredClone(state);
    rejects(change.startsWith('duplicate') ? 'read_duplicate_item' : 'read_item_set_mismatch', () => acceptPage(state, next, response, limits));
    assert.deepEqual(state, before);
  });
}

for (const change of ['successful-item', 'missing-unfinished', 'changed-digest'] as const) {
  test(`read collection: retry rejects ${change} instead of overwriting successful observations`, () => {
    const state = pending(); const next = request(state, 'retry'); let items = [item('b'), item('c')];
    if (change === 'successful-item') items = [item('a'), item('b'), item('c')];
    if (change === 'missing-unfinished') items = [item('b')];
    if (change === 'changed-digest') items[0]!.inputDigest = 'd'.repeat(64);
    const response = page(next, items, { nextCursor: 'cursor-2', exhausted: false, totalItems: 4 }); const before = structuredClone(state);
    rejects(change === 'successful-item' ? 'read_item_limit' : 'read_item_set_mismatch', () => acceptPage(state, next, response, limits));
    assert.deepEqual(state, before);
  });
}

for (const change of ['snapshot', 'cursor', 'nextCursor', 'totalItems', 'exhausted', 'requestId'] as const) {
  test(`read collection: pending retry binds ${change} to its original source page`, () => {
    const state = pending(); const next = request(state, 'retry'); const response = page(next, [item('b'), item('c')], { nextCursor: 'cursor-2', exhausted: false, totalItems: 4 });
    if (change === 'snapshot') response.sourceSnapshot = 'snapshot-2';
    if (change === 'cursor') response.cursor = 'not-requested';
    if (change === 'nextCursor') response.nextCursor = 'another-next-cursor';
    if (change === 'totalItems') response.totalItems = 5;
    if (change === 'exhausted') { response.exhausted = true; response.nextCursor = null; }
    if (change === 'requestId') response.requestId = 'unrelated-request';
    const code = change === 'snapshot' ? 'read_snapshot_changed' : change === 'cursor' || change === 'requestId' ? 'read_response_request_mismatch' : 'read_pending_metadata_changed';
    rejects(code, () => acceptPage(state, next, response, limits));
  });
}

test('read collection: an explicit retry cannot omit a key in the request or reuse the last request identity', () => {
  const state = pending(); const next = request(state, 'retry'); const response = page(next, [item('b'), item('c')], { nextCursor: 'cursor-2', exhausted: false, totalItems: 4 });
  const forged = { ...next, retryItems: [key('b')] };
  rejects('read_item_set_mismatch', () => acceptPage(state, forged, response, limits));
  rejects('read_request_replayed', () => nextRequest(state, state.pending!.requestId, limits));
});

test('read collection: accepted request history survives replaced pending IDs and is checked on restore', () => {
  const state = pending(); const next = request(state, 'retry');
  const after = acceptPage(state, next, page(next, [item('b', 'partial'), item('c')], { nextCursor: 'cursor-2', exhausted: false, totalItems: 4 }), limits);
  assert.equal(after.pending!.requestId, 'retry'); assert.deepEqual(after.acceptedRequestIds, ['request-1', 'retry']);
  rejects('read_request_replayed', () => nextRequest(after, 'request-1', limits));
  const duplicate = structuredClone(after); duplicate.acceptedRequestIds = ['retry', 'retry'];
  rejects('read_invalid_request_history', () => nextRequest(duplicate, 'next', limits));
  const missing = structuredClone(after); missing.acceptedRequestIds = ['request-1', 'unrelated'];
  rejects('read_invalid_request_history', () => nextRequest(missing, 'next', limits));
  const shortened = structuredClone(after); shortened.acceptedRequestIds.pop();
  rejects('read_invalid_call_count', () => nextRequest(shortened, 'next', limits));
});

test('read collection: a nonretryable error preserves the pending observations but forbids resume', () => {
  const state = initialize('batch', [key('a'), key('b')]); const next = request(state); const failure = item('b', 'error'); failure.error!.retryable = false;
  const after = acceptPage(state, next, page(next, [item('a'), failure], { totalItems: 2 }), limits);
  assert.equal(after.exhausted, false); assert.equal(after.pages.length, 0); assert.equal(after.pending!.items[0]!.status, 'success');
  rejects('read_retry_forbidden', () => nextRequest(after, 'explicit-retry', limits));
});

test('read collection: retries consume the operation call limit without advancing page count', () => {
  const bounds = { ...limits, maxCalls: 2 }; const state = pending(); const next = request(state, 'retry', bounds);
  const after = acceptPage(state, next, page(next, [item('b', 'partial'), item('c', 'error')], { nextCursor: 'cursor-2', exhausted: false, totalItems: 4 }), bounds);
  assert.equal(after.calls, 2); assert.equal(after.pages.length, 0); assert.ok(after.pending);
  rejects('read_call_limit', () => nextRequest(after, 'extra-retry', bounds));
});

test('read collection: declared totals count unique logical items and may become known on the final page', () => {
  const start = initialize('paged'); const first = request(start); const one = acceptPage(start, first, page(first, [item('a')], { exhausted: false, nextCursor: 'next' }), limits);
  const second = request(one, 'request-2'); const complete = acceptPage(one, second, page(second, [item('b')], { totalItems: 2 }), limits);
  assert.equal(complete.totalItems, 2); assert.equal(complete.exhausted, true);
  rejects('read_total_mismatch', () => acceptPage(one, second, page(second, [item('b')], { totalItems: 3 }), limits));
  rejects('read_total_mismatch', () => acceptPage(start, first, page(first, [item('a'), item('b')], { exhausted: false, nextCursor: 'next', totalItems: 1 }), limits));
});

test('read collection: a known total stays binding when a later response omits it', () => {
  const start = initialize('paged'); const first = request(start); const one = acceptPage(start, first, page(first, [item('a')], { exhausted: false, nextCursor: 'next', totalItems: 2 }), limits);
  const second = request(one, 'request-2'); assert.equal(acceptPage(one, second, page(second, [item('b')]), limits).totalItems, 2);
  rejects('read_total_changed', () => acceptPage(one, second, page(second, [item('b')], { totalItems: 3 }), limits));
  rejects('read_total_mismatch', () => acceptPage(one, second, page(second, []), limits));
});

test('read collection: repeated IDs cannot create another item even with a different digest', () => {
  const start = initialize('paged'); const first = request(start); const one = acceptPage(start, first, page(first, [item('a')], { exhausted: false, nextCursor: 'next' }), limits);
  const second = request(one, 'request-2'); const duplicate = item('a'); duplicate.inputDigest = 'f'.repeat(64);
  rejects('read_duplicate_item', () => acceptPage(one, second, page(second, [duplicate]), limits));
});

test('read collection: cursor loops and snapshot changes are rejected across finalized pages', () => {
  const start = initialize('paged'); const first = request(start); const one = acceptPage(start, first, page(first, [item('a')], { exhausted: false, nextCursor: 'cursor-a' }), limits);
  const second = request(one, 'request-2');
  rejects('read_cursor_loop', () => acceptPage(one, second, page(second, [item('b')], { exhausted: false, nextCursor: 'cursor-a' }), limits));
  rejects('read_snapshot_changed', () => acceptPage(one, second, page(second, [item('b')], { sourceSnapshot: 'new-snapshot' }), limits));
  const two = acceptPage(one, second, page(second, [item('b')], { exhausted: false, nextCursor: 'cursor-b' }), limits); const third = request(two, 'request-3');
  rejects('read_cursor_loop', () => acceptPage(two, third, page(third, [item('c')], { exhausted: false, nextCursor: 'cursor-a' }), limits));
});

test('read collection: empty pages may progress with new cursors and a complete empty collection is valid', () => {
  const start = initialize('paged'); const first = request(start); const empty = acceptPage(start, first, page(first, [], { exhausted: false, nextCursor: 'empty-next', totalItems: 0 }), limits);
  assert.equal(empty.pages.length, 1); assert.equal(empty.calls, 1); assert.equal(empty.nextCursor, 'empty-next');
  const second = request(empty, 'request-2'); const done = acceptPage(empty, second, page(second, [], { totalItems: 0 }), limits);
  assert.equal(done.exhausted, true); assert.equal(done.pages.length, 2); assert.equal(done.calls, 2);
  const batch = initialize('batch', []); const batchRequest = request(batch); assert.equal(acceptPage(batch, batchRequest, page(batchRequest, [], { totalItems: 0 }), limits).exhausted, true);
});

test('read collection: page, item and batch bounds stop further requests without truncation', () => {
  const start = initialize('paged'); const first = request(start); const one = acceptPage(start, first, page(first, [], { exhausted: false, nextCursor: 'next' }), limits);
  rejects('read_page_limit', () => nextRequest(one, 'more', { ...limits, maxPages: 1 }));
  const fullRequest = request(start, 'full', { ...limits, maxItems: 2 });
  const full = acceptPage(start, fullRequest, page(fullRequest, [item('a'), item('b')], { exhausted: false, nextCursor: 'next' }), { ...limits, maxItems: 2 });
  rejects('read_item_limit', () => nextRequest(full, 'more', { ...limits, maxItems: 2 }));
  const smallRequest = request(start, 'small', { ...limits, pageSize: 1 });
  rejects('read_item_limit', () => acceptPage(start, smallRequest, page(smallRequest, [item('a'), item('b')]), { ...limits, pageSize: 1 }));
  rejects('read_item_limit', () => nextRequest(initialize('batch', [key('a'), key('b')]), 'batch', { ...limits, pageSize: 1 }));
});

test('read collection: response and checkpoint limits use exact UTF-8 byte lengths', () => {
  const state = initialize('batch', [key('a')]); const next = request(state); const response = page(next, [{ ...item('a'), output: { text: '한글🙂' } }]);
  const pageBytes = byteLength(response); assert.ok(pageBytes > JSON.stringify(response).length);
  const after = acceptPage(state, next, response, { ...limits, maxPageBytes: pageBytes });
  rejects('read_page_too_large', () => acceptPage(state, next, response, { ...limits, maxPageBytes: pageBytes - 1 }));
  assert.deepEqual(acceptPage(state, next, response, { ...limits, maxCheckpointBytes: byteLength(after) }), after);
  rejects('read_checkpoint_too_large', () => acceptPage(state, next, response, { ...limits, maxCheckpointBytes: byteLength(after) - 1 }));
});

test('read collection: each raw retry is byte-bounded while the merged logical page uses the checkpoint bound', () => {
  const state = initialize('batch', [key('a'), key('b')]); const next = request(state);
  const first = page(next, [{ ...item('a'), output: 'a'.repeat(2000) }, item('b', 'not_run')]);
  const partial = acceptPage(state, next, first, limits); const retry = request(partial, 'retry'); const second = page(retry, [{ ...item('b'), output: 'b'.repeat(2000) }]);
  const bounds = { ...limits, maxPageBytes: Math.max(byteLength(first), byteLength(second)) };
  const complete = acceptPage(partial, retry, second, bounds);
  assert.ok(byteLength(complete.pages[0]) > bounds.maxPageBytes); assert.equal(complete.exhausted, true);
});

for (const change of ['projection', 'cursor-chain', 'calls', 'completed-pending', 'manifest'] as const) {
  test(`read collection: restored ${change} corruption is rejected before producing a request`, () => {
    const state = pending();
    if (change === 'projection') state.snapshot = 'changed';
    if (change === 'cursor-chain') state.pending!.cursor = 'skipped';
    if (change === 'calls') state.calls = 0;
    if (change === 'completed-pending') state.pending!.items = state.pending!.items.map(value => item(value.id));
    if (change === 'manifest') state.batchExpected = [key('a')];
    const code = change === 'projection' ? 'read_state_projection_mismatch' : change === 'cursor-chain' ? 'read_cursor_chain_changed' :
      change === 'calls' ? 'read_invalid_call_count' : change === 'completed-pending' ? 'read_pending_mismatch' : 'read_invalid_manifest';
    rejects(code, () => nextRequest(state, 'resume', limits));
  });
}

test('read collection: strict schemas reject false completion, fabricated not-run output and invalid budgets', () => {
  assert.equal(ReadItemSchema.safeParse({ ...item('a'), coverage: 'partial' }).success, false);
  assert.equal(ReadItemSchema.safeParse({ ...item('a', 'partial'), coverage: 'complete' }).success, false);
  assert.equal(ReadItemSchema.safeParse({ ...item('a', 'error'), error: null }).success, false);
  assert.equal(ReadItemSchema.safeParse({ ...item('a', 'not_run'), output: 'fabricated observation' }).success, false);
  assert.equal(ReadItemSchema.safeParse({ ...item('a'), unexpected: true }).success, false);
  const state = initialize('paged'); const next = request(state);
  assert.equal(ReadPageSchema.safeParse({ ...page(next, []), unknownField: 1 }).success, false);
  assert.equal(ReadCollectionStateSchema.safeParse({ ...state, calls: -1 }).success, false);
  for (const key of Object.keys(limits) as (keyof ReadLimits)[]) assert.equal(ReadLimitsSchema.safeParse({ ...limits, [key]: 0 }).success, false);
  assert.equal(ReadLimitsSchema.safeParse({ ...limits, maxPageBytes: 4 * 1024 * 1024 + 1 }).success, false);
  assert.equal(ReadLimitsSchema.safeParse({ ...limits, maxCheckpointBytes: 16 * 1024 * 1024 + 1 }).success, false);
  rejects('read_invalid_manifest', () => initialize('batch'));
  rejects('read_invalid_manifest', () => initialize('paged', [key('a')]));
});

test('read collection: usage overflow and dependency overflow fail without dropping earlier accounting or custody', () => {
  const state = pending(); state.pending!.usage = { transportCalls: Number.MAX_SAFE_INTEGER, internalOperations: 0, imageBytes: 0, waitMs: 0 };
  const next = request(state, 'retry'); const response = page(next, [item('b'), item('c')], { nextCursor: 'cursor-2', exhausted: false, totalItems: 4,
    usage: { transportCalls: 1, internalOperations: 0, imageBytes: 0, waitMs: 0 } });
  rejects('read_usage_overflow', () => acceptPage(state, next, response, limits));
  delete state.pending!.usage; delete response.usage;
  state.pending!.knowledgeDependencies = Array.from({ length: 50 }, (_, index) => dependency(`source-${index}`));
  response.knowledgeDependencies = [dependency('another-source')];
  rejects('read_dependencies_limit', () => acceptPage(state, next, response, limits));
});
