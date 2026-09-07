import test from 'node:test';
import assert from 'node:assert/strict';
import type { ArtifactRef, Evidence } from '../domain/model.js';
import type { KnowledgeDependency } from '../domain/knowledge.js';
import type { ReadCall, ReadCheckpoint } from '../domain/read-checkpoint.js';
import type { ReadCheckpointRecord } from '../domain/read-checkpoint-record.js';
import { pendingReadRetryAt, type ReadDeferral, type ReadItem, type ReadKey, type ReadPage } from '../domain/read-collection.js';
import { ReadDeferralSchema, ReadItemSchema, ReadPageSchema } from '../application/read-collection-contracts.js';
import { encodeReadCheckpoint, decodeReadCheckpoint, ReadCheckpointRecordSchema } from '../application/read-checkpoint-record.js';
import { acceptPage, initialize, nextRequest } from '../application/read-collection-validation.js';
import { uniqueKnowledgeDependencies } from '../application/knowledge-validity.js';
import { asJson } from '../application/plan-validator.js';
import { Sha256Digester } from '../infrastructure/digest.js';

const digester = new Sha256Digester();
const digest = (value: unknown) => digester.digest(asJson(value));
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
type Base = { head: ArtifactRef; checkpoint: ReadCheckpoint };
const ref = (id: string, byteLength = 128): ArtifactRef => ({ id, sha256: digest({ id }), byteLength, mediaType: 'application/json', tenantId: 'tenant', labels: ['synthetic'] });
const key = (id: string): ReadKey => ({ id, inputDigest: digest({ id }) });
const dependency = (id: string): KnowledgeDependency => ({ tenantId: 'tenant', knowledgeId: id, knowledgeRevision: 1, actorDigest: 'a'.repeat(64), parents: [],
  sources: [{ workId: 'source-work', evidenceId: id, sourceVersion: 'b'.repeat(64), generation: 0, workRevision: 1, policyDigest: 'c'.repeat(64) }] });
const evidence: Evidence = { id: 'original-a', tenantId: 'tenant', scope: 'fixture', sourceId: 'source-a', lineageId: 'lineage-a', locator: 'fixture://a',
  observedAt: 4, recordedAt: 5, labels: ['synthetic'], coverage: 'complete', status: 'accepted', access: 'available', facts: { original: true },
  supersedes: [], derivedFrom: [], artifact: ref('original-source') };
const item = (id: string, status: ReadItem['status'] = 'success'): ReadItem => ({ ...key(id), status, output: status === 'not_run' ? null : { value: id },
  evidence: [], artifacts: [], coverage: status === 'success' ? 'complete' : status === 'partial' ? 'partial' : 'unknown',
  error: status === 'error' ? { code: 'synthetic_error', retryable: true } : null });
function start(kind: 'paged' | 'batch' = 'paged'): ReadCheckpoint {
  return { schemaVersion: 1, kind: 'read_checkpoint', operationId: 'operation', workId: 'work', rootAttemptId: 'attempt-1', attemptId: 'attempt-1',
    goal: { revision: 1, description: 'Collect synthetic records', scope: 'fixture', mode: 'auto', criteria: [{ id: 'goal', description: 'Original exists', key: 'original',
      operator: 'equals', equals: true, minIndependentSources: 1, requireCompleteCoverage: true }] },
    policy: { tenantId: 'tenant', principalId: 'person', allowedLabels: ['synthetic'], allowedTools: ['fixture.read'], allowedDestinations: ['local'], allowWrites: false },
    lifecycleGeneration: 0, toolId: 'fixture.read', toolVersion: '1', queryDigest: 'd'.repeat(64), contractDigest: 'e'.repeat(64),
    limits: { maxPages: 4, maxItems: 10, maxCalls: 8, maxPageBytes: 65536, maxCheckpointBytes: 262144, pageSize: 2 },
    collection: initialize(kind, kind === 'batch' ? [key('a'), key('b')] : null), calls: [], parent: null, artifacts: [], knowledgeDependencies: [],
    phase: 'running', stopReason: null, createdAt: 10, updatedAt: 10 };
}
const stored = (checkpoint: ReadCheckpoint): Base => ({ checkpoint, head: ref(`head-${digest(checkpoint)}`) });
const uniqueRefs = (refs: ArtifactRef[]) => [...new Map(refs.map(ref => [ref.id, ref])).values()];
function intent(base: Base, requestId = 'request-1'): ReadCheckpoint {
  const cp = base.checkpoint; const request = nextRequest(cp.collection, requestId, cp.limits); assert.ok(request);
  return { ...structuredClone(cp), calls: [...structuredClone(cp.calls), { request, attemptId: cp.attemptId, status: 'intent', response: null,
    dispatchedAt: cp.updatedAt + 1, receivedAt: null, errorCode: null }], artifacts: uniqueRefs([...cp.artifacts, base.head]), updatedAt: cp.updatedAt + 1 };
}
function page(base: Base, items: ReadItem[], nextCursor: string | null = null, totalItems: number | null = null): ReadPage {
  const request = base.checkpoint.calls.at(-1)!.request;
  return { requestId: request.requestId, sourceSnapshot: request.snapshot ?? 'snapshot-1', cursor: request.cursor, nextCursor, exhausted: nextCursor === null,
    totalItems, expected: items.map(({ id, inputDigest }) => ({ id, inputDigest })), items,
    usage: { transportCalls: 1, internalOperations: 2, imageBytes: 0, waitMs: 3 } };
}
function settle(base: Base, source: ReadPage | string): { next: ReadCheckpoint; raw: ArtifactRef | null } {
  const cp = base.checkpoint; const last = cp.calls.at(-1)!; const value = typeof source === 'string' ? null : source;
  const raw = value ? ref(`raw-${digest(value)}`, bytes(value)) : null;
  const collection = value ? acceptPage(cp.collection, last.request, value, cp.limits) : structuredClone(cp.collection);
  const call: ReadCall = { ...last, status: value ? 'accepted' : 'rejected', response: raw, receivedAt: cp.updatedAt + 1,
    errorCode: typeof source === 'string' ? source : null };
  return { raw, next: { ...structuredClone(cp), calls: [...structuredClone(cp.calls.slice(0, -1)), call], collection,
    artifacts: uniqueRefs([...cp.artifacts, base.head, ...(raw ? [raw] : []), ...(value?.items.flatMap(item => [...item.artifacts, ...item.evidence.flatMap(e => e.artifact ? [e.artifact] : [])]) ?? [])]),
    knowledgeDependencies: uniqueKnowledgeDependencies([...cp.knowledgeDependencies, ...(value?.knowledgeDependencies ?? [])]),
    phase: collection.exhausted ? 'complete' : !value || collection.pending ? 'partial' : 'running',
    stopReason: collection.exhausted ? null : call.errorCode ?? (collection.pending ? 'read_items_pending' : null), updatedAt: cp.updatedAt + 1 } };
}
function resumed(base: Base, attemptId = 'attempt-2', dependencies: KnowledgeDependency[] = []): ReadCheckpoint {
  const cp = base.checkpoint;
  return { ...structuredClone(cp), attemptId, parent: { attemptId: cp.attemptId, checkpoint: base.head },
    calls: cp.calls.map(call => call.status === 'intent' ? { ...structuredClone(call), status: 'unknown', errorCode: 'read_response_unknown' } : structuredClone(call)),
    artifacts: uniqueRefs([base.head, ...cp.artifacts]), knowledgeDependencies: uniqueKnowledgeDependencies([...cp.knowledgeDependencies, ...dependencies]),
    phase: cp.collection.exhausted ? 'complete' : 'running', stopReason: null, updatedAt: cp.updatedAt + 1 };
}
const noPage = async (): Promise<ReadPage> => { throw new Error('UNEXPECTED_RAW_READ'); };
function deferred(base: Base, dueAt = 2000) {
  const cp = base.checkpoint; const last = cp.calls.at(-1)!;
  const value: ReadDeferral = { kind: 'read_deferral', requestId: last.request.requestId, dueAt, reason: 'rate_limited',
    rawArtifact: ref('deferral-original'), usage: { transportCalls: 1, internalOperations: 0, imageBytes: 0, waitMs: 0 } };
  const raw = ref(`mapped-${digest(value)}`, bytes(value));
  const next: ReadCheckpoint = { ...structuredClone(cp), calls: [...structuredClone(cp.calls.slice(0, -1)), { ...last,
    status: 'deferred', response: raw, receivedAt: cp.updatedAt + 1, errorCode: 'read_rate_limited' }],
    retryAt: Math.max(dueAt, pendingReadRetryAt(cp.collection) ?? 0), phase: 'partial', stopReason: 'read_rate_limited',
    artifacts: uniqueRefs([...cp.artifacts, base.head, raw, value.rawArtifact!]), updatedAt: cp.updatedAt + 1 };
  return { value, next, raw };
}
async function roundTrip(next: ReadCheckpoint, base: Base | null, type: ReadCheckpointRecord['change']['type'], source?: ReadPage) {
  const nextBefore = structuredClone(next); const baseBefore = structuredClone(base); let reads = 0;
  const record = encodeReadCheckpoint(next, base, digester); assert.equal(record.change.type, type); assert.equal(record.logicalDigest, digest(next));
  const decoded = await decodeReadCheckpoint(record, base?.checkpoint ?? null, async ref => {
    reads++; assert.ok(source); assert.deepEqual(ref, next.calls.at(-1)!.response); return structuredClone(source);
  }, digester);
  assert.deepEqual(decoded, next); assert.deepEqual(next, nextBefore); assert.deepEqual(base, baseBefore);
  assert.equal(reads, source ? 1 : 0); return { record, decoded };
}
function invalidEncode(next: ReadCheckpoint, base: Base | null) { assert.throws(() => encodeReadCheckpoint(next, base, digester), /^Error: read_record_invalid$/); }
function invalidDecode(record: ReadCheckpointRecord, base: ReadCheckpoint | null, reader = noPage) {
  return assert.rejects(decodeReadCheckpoint(record, base, reader, digester), /^Error: read_record_invalid$/);
}

for (const kind of ['paged', 'batch'] as const) test(`checkpoint record: empty ${kind} root round-trips metadata once without raw reads`, async () => {
  const next = start(kind); next.knowledgeDependencies = [dependency('inherited')];
  const { record } = await roundTrip(next, null, 'start'); assert.equal(record.schemaVersion, 2);
  assert.deepEqual(record.change.type === 'start' && record.change.checkpoint.collection.batchExpected, next.collection.batchExpected);
});

test('checkpoint record: multiple normal pages store references rather than repeating large bodies', async () => {
  let base = stored(start()); await roundTrip(base.checkpoint, null, 'start');
  for (const [index, id] of ['a', 'b'].entries()) {
    const dispatched = intent(base, `request-${index + 1}`); await roundTrip(dispatched, base, 'intent'); base = stored(dispatched);
    const observation = item(id); observation.output = { body: 'ORIGINAL_BODY_MARKER'.repeat(1024) };
    observation.evidence = [{ ...structuredClone(evidence), id: `original-${id}` }]; observation.artifacts = [evidence.artifact!];
    const response = page(base, [observation], index === 0 ? 'cursor-2' : null, 2); const accepted = settle(base, response);
    const { record } = await roundTrip(accepted.next, base, 'settle', response);
    assert.equal(JSON.stringify(record).includes('ORIGINAL_BODY_MARKER'), false); assert.ok(bytes(record) < bytes(accepted.next) / 4);
    assert.equal(record.change.type === 'settle' && record.change.call.response?.id, accepted.raw!.id); base = stored(accepted.next);
  }
  assert.equal(base.checkpoint.phase, 'complete'); assert.equal(base.checkpoint.collection.pages.length, 2);
  assert.deepEqual(base.checkpoint.collection.pages[0]!.items[0]!.evidence[0]!.observedAt, 4);
});

test('checkpoint record: partial batch resumes only unfinished items and preserves original successes', async () => {
  const root = stored(start('batch')); const firstIntent = stored(intent(root));
  const a = item('a'); a.evidence = [structuredClone(evidence)]; a.artifacts = [evidence.artifact!];
  const firstPage = page(firstIntent, [a, item('b', 'partial')], null, 2); firstPage.knowledgeDependencies = [dependency('first')];
  const partial = settle(firstIntent, firstPage); await roundTrip(partial.next, firstIntent, 'settle', firstPage);
  assert.equal(partial.next.stopReason, 'read_items_pending'); const partialBase = stored(partial.next);
  const restarted = resumed(partialBase, 'attempt-2', [dependency('second')]);
  const { record } = await roundTrip(restarted, partialBase, 'resume');
  assert.equal(record.change.type, 'resume'); if (record.change.type === 'resume') assert.deepEqual(record.change.knowledgeDependencies, [dependency('second')]);
  const nextBase = stored(restarted); const secondIntent = intent(nextBase, 'request-2'); await roundTrip(secondIntent, nextBase, 'intent');
  assert.deepEqual(secondIntent.calls.at(-1)!.request.retryItems, [key('b')]); const secondBase = stored(secondIntent);
  const secondPage = page(secondBase, [item('b')], null, 2); const complete = settle(secondBase, secondPage);
  await roundTrip(complete.next, secondBase, 'settle', secondPage); assert.equal(complete.next.phase, 'complete');
  assert.deepEqual(complete.next.collection.pages[0]!.items[0], a);
  assert.deepEqual(complete.next.knowledgeDependencies, [dependency('first'), dependency('second')]);
});

test('checkpoint record: rejected source calls survive explicit resume and consume the operation call limit', async () => {
  const initial = start(); initial.limits.maxCalls = 1; const root = stored(initial); const dispatched = stored(intent(root));
  const failure = settle(dispatched, 'read_source_failed'); await roundTrip(failure.next, dispatched, 'settle');
  assert.equal(failure.next.calls.length, 1); assert.equal(failure.next.collection.calls, 0); assert.equal(failure.next.phase, 'partial');
  const failed = stored(failure.next); const next = resumed(failed); await roundTrip(next, failed, 'resume');
  invalidEncode(intent(stored(next), 'request-2'), stored(next));
});

test('checkpoint record: a crashed intent becomes one unknown call and is never silently replayed', async () => {
  const root = stored(start()); const pending = stored(intent(root)); const next = resumed(pending);
  await roundTrip(next, pending, 'resume'); assert.equal(next.calls[0]!.status, 'unknown');
  assert.equal(next.calls[0]!.errorCode, 'read_response_unknown'); assert.equal(next.calls[0]!.receivedAt, null);
  assert.deepEqual(next.calls[0]!.request, pending.checkpoint.calls[0]!.request);
  const resumedBase = stored(next); const second = intent(resumedBase, 'request-2'); await roundTrip(second, resumedBase, 'intent');
  assert.equal(second.calls.length, 2); assert.equal(second.collection.calls, 0);
  const twice = resumed(stored(second), 'attempt-3'); await roundTrip(twice, stored(second), 'resume');
  assert.deepEqual(twice.calls.map(call => call.status), ['unknown', 'unknown']);
});

test('checkpoint record: complete orphan resume performs no new page read or call', async () => {
  const dispatched = stored(intent(stored(start()))); const response = page(dispatched, [item('a')], null, 1);
  const complete = stored(settle(dispatched, response).next); const next = resumed(complete);
  await roundTrip(next, complete, 'resume'); assert.equal(next.phase, 'complete');
  assert.deepEqual(next.collection, complete.checkpoint.collection); assert.deepEqual(next.calls, complete.checkpoint.calls);
});

test('read waits contract: only retryable unfinished items can advertise a bounded absolute barrier', () => {
  const base = item('a', 'partial'); const value = { ...base, error: { code: 'rate_limited', retryable: true }, retryAt: 2000 };
  assert.equal(ReadItemSchema.safeParse(value).success, true);
  for (const changed of [{ ...value, status: 'success', coverage: 'complete' }, { ...value, error: null },
    { ...value, error: { code: 'permanent', retryable: false } }, { ...value, retryAt: -1 }, { ...value, retryAt: 1.5 },
    { ...value, retryAt: Number.MAX_SAFE_INTEGER + 1 }]) assert.equal(ReadItemSchema.safeParse(changed).success, false);
  const valueDeferral: ReadDeferral = { kind: 'read_deferral', requestId: 'r', dueAt: 2000, reason: 'rate_limited' };
  assert.deepEqual(ReadDeferralSchema.parse(valueDeferral), valueDeferral);
  assert.equal(ReadDeferralSchema.safeParse({ ...valueDeferral, items: [] }).success, false);
  assert.equal(ReadDeferralSchema.safeParse({ ...valueDeferral, reason: 'empty_page' }).success, false);
  assert.equal(ReadPageSchema.safeParse(valueDeferral).success, false);
  assert.deepEqual(ReadItemSchema.parse(base), base);
});

test('read waits record: deferral consumes a call but preserves the collection and requires its original response', async () => {
  const base = stored(intent(stored(start()))); const { value, next } = deferred(base);
  const before = structuredClone(base); const record = encodeReadCheckpoint(next, base, digester); let deferralReads = 0;
  const decoded = await decodeReadCheckpoint(record, base.checkpoint, noPage, digester, async original => {
    deferralReads++; assert.deepEqual(original, next.calls.at(-1)!.response); return structuredClone(value);
  });
  assert.deepEqual(decoded, next); assert.deepEqual(base, before); assert.equal(deferralReads, 1);
  assert.deepEqual(decoded.collection, base.checkpoint.collection); assert.equal(decoded.collection.calls, 0);
  assert.equal(decoded.calls.length, 1); assert.equal(decoded.retryAt, 2000); assert.ok(decoded.artifacts.some(a => a.id === value.rawArtifact!.id));
  await assert.rejects(decodeReadCheckpoint(record, base.checkpoint, noPage, digester), /read_record_invalid/);
  await assert.rejects(decodeReadCheckpoint(record, base.checkpoint, noPage, digester, async () => { throw new Error('missing'); }), /read_record_invalid/);
  await assert.rejects(decodeReadCheckpoint(record, base.checkpoint, noPage, digester, async () => ({ ...value, dueAt: 1500 })), /read_record_invalid/);
  const withoutRaw = { ...next, artifacts: next.artifacts.filter(a => a.id !== value.rawArtifact!.id) };
  const missing = encodeReadCheckpoint(withoutRaw, base, digester);
  await assert.rejects(decodeReadCheckpoint(missing, base.checkpoint, noPage, digester, async () => value), /read_record_invalid/);
});

test('read waits record: parent claim and historical dispatch cannot move before the recorded barrier', async () => {
  const initialIntent = stored(intent(stored(start()))); const waiting = stored(deferred(initialIntent).next);
  invalidEncode(resumed(waiting), waiting);
  const child = { ...resumed(waiting), updatedAt: 2000 };
  await roundTrip(child, waiting, 'resume'); assert.equal(child.retryAt, 2000);
  const runningBeforeDue = stored({ ...child, updatedAt: 1500 });
  const early = intent(runningBeforeDue, 'early'); invalidEncode(early, runningBeforeDue);
  // Replay has no wall clock: even a later verifier rejects an historically premature intent.
  const forged: ReadCheckpointRecord = { schemaVersion: 2, kind: 'read_checkpoint_record', logicalDigest: digest(early),
    change: { type: 'intent', base: runningBeforeDue.head, call: early.calls.at(-1)!, updatedAt: early.updatedAt } };
  await invalidDecode(forged, runningBeforeDue.checkpoint);
  const allowedBase = stored(child); const allowed = intent(allowedBase, 'due'); await roundTrip(allowed, allowedBase, 'intent');
  const response = page(stored(allowed), [item('a')], null, 1); const completed = settle(stored(allowed), response).next;
  completed.retryAt = null; await roundTrip(completed, stored(allowed), 'settle', response);
  assert.equal(completed.collection.calls, 1); assert.equal(completed.calls.length, 2);
});

test('read waits record: item barriers use the maximum and a whole-call deferral cannot erase retained successes', async () => {
  const base = stored(intent(stored(start('batch')))); const a = item('a'); const b = { ...item('b', 'partial'),
    error: { code: 'rate_limited', retryable: true }, retryAt: 3000 };
  const response = page(base, [a, b], null, 2); const partial = settle(base, response).next; partial.retryAt = 3000;
  await roundTrip(partial, base, 'settle', response);
  const child = { ...resumed(stored(partial)), updatedAt: 3000 };
  const pending = stored(intent(stored(child), 'retry')); const waiting = deferred(pending, 2500);
  assert.equal(waiting.next.retryAt, 3000); assert.deepEqual(waiting.next.collection.pending!.items[0], a);
  const record = encodeReadCheckpoint(waiting.next, pending, digester);
  assert.deepEqual(await decodeReadCheckpoint(record, pending.checkpoint, noPage, digester, async () => waiting.value), waiting.next);
  const multi = { ...waiting.next.collection, pending: { ...response, items: [b, { ...b, ...key('c'), retryAt: 4000 }] } };
  assert.equal(pendingReadRetryAt(multi), 4000);
});

test('checkpoint record: explicit stop changes only stop metadata and appends its exact base reference', async () => {
  const root = stored(start()); const next: ReadCheckpoint = { ...structuredClone(root.checkpoint), phase: 'partial', stopReason: 'read_call_limit',
    artifacts: [root.head], updatedAt: 11 };
  await roundTrip(next, root, 'stop'); assert.equal(next.collection.exhausted, false); assert.equal(next.calls.length, 0);
  invalidEncode({ ...next, updatedAt: 12 }, stored(next));
  const pending = stored(intent(root)); invalidEncode({ ...pending.checkpoint, phase: 'partial', stopReason: 'read_call_limit' }, pending);
});

test('checkpoint record: unchanged fields and inherited dependencies cannot be dropped from an intent', () => {
  const initial = start(); initial.knowledgeDependencies = [dependency('inherited')]; const base = stored(initial); const next = intent(base);
  const changes: ((cp: ReadCheckpoint) => void)[] = [cp => { cp.workId = 'other'; }, cp => { cp.operationId = 'other'; }, cp => { cp.rootAttemptId = 'other'; },
    cp => { cp.goal.description = 'other'; }, cp => { cp.policy.allowedLabels = []; }, cp => { cp.lifecycleGeneration++; }, cp => { cp.queryDigest = 'f'.repeat(64); },
    cp => { cp.contractDigest = 'f'.repeat(64); }, cp => { cp.toolVersion = '2'; }, cp => { cp.limits.maxPages++; }, cp => { cp.createdAt--; },
    cp => { cp.parent = { attemptId: 'other', checkpoint: ref('other') }; }, cp => { cp.artifacts = []; }, cp => { cp.knowledgeDependencies = []; }];
  for (const change of changes) { const altered = structuredClone(next); change(altered); invalidEncode(altered, base); }
});

test('checkpoint record: start rejects retained history, source artifacts, and non-root identity', () => {
  for (const change of [(cp: ReadCheckpoint) => { cp.artifacts = [ref('original')]; }, (cp: ReadCheckpoint) => { cp.rootAttemptId = 'other'; },
    (cp: ReadCheckpoint) => { cp.parent = { attemptId: 'other', checkpoint: ref('other') }; },
    (cp: ReadCheckpoint) => { cp.collection.snapshot = 'forged'; }]) {
    const cp = start(); change(cp); invalidEncode(cp, null);
  }
  invalidEncode(intent(stored(start())), null);
});

test('checkpoint record: intent, settlement, and resume reject invalid request identity or time transitions', async () => {
  const root = stored(start()); const next = intent(root);
  const wrongRequest = structuredClone(next); wrongRequest.calls[0]!.request.cursor = 'unrequested'; invalidEncode(wrongRequest, root);
  const backdated = structuredClone(next); backdated.calls[0]!.dispatchedAt = 9; invalidEncode(backdated, root);
  const base = stored(next); const response = page(base, [item('a')], null, 1); const accepted = settle(base, response);
  const changedAttempt = structuredClone(accepted.next); changedAttempt.calls[0]!.attemptId = 'other'; invalidEncode(changedAttempt, base);
  const changedDispatch = structuredClone(accepted.next); changedDispatch.calls[0]!.dispatchedAt++; invalidEncode(changedDispatch, base);
  const record = encodeReadCheckpoint(accepted.next, base, digester);
  if (record.change.type === 'settle') record.change.call.status = 'unknown'; await invalidDecode(record, base.checkpoint);
  invalidEncode(resumed(base, base.checkpoint.attemptId), base);
});

test('checkpoint record: wrong logical digest, wrong base, extra keys, and failed source reads are rejected', async () => {
  const root = stored(start()); const next = intent(root); const record = encodeReadCheckpoint(next, root, digester);
  await invalidDecode({ ...record, logicalDigest: '0'.repeat(64) }, root.checkpoint);
  await invalidDecode(record, { ...root.checkpoint, workId: 'wrong-work' }); await invalidDecode(record, null);
  await invalidDecode({ ...record, extra: 'unrecognized' } as ReadCheckpointRecord, root.checkpoint);
  const startRecord = encodeReadCheckpoint(root.checkpoint, null, digester); await invalidDecode(startRecord, root.checkpoint);
  const pending = stored(next); const accepted = settle(pending, page(pending, [item('a')], null, 1));
  await invalidDecode(encodeReadCheckpoint(accepted.next, pending, digester), pending.checkpoint, async () => { throw new Error('PRIVATE_SOURCE_FAILURE'); });
});

test('checkpoint record: accepted encode defers new raw body, source-ref, and dependency authentication to decode', async () => {
  const pending = stored(intent(stored(start()))); const original = item('a'); original.evidence = [structuredClone(evidence)];
  const response = page(pending, [original], null, 1); response.knowledgeDependencies = [dependency('raw-source')];
  const valid = settle(pending, response).next;
  for (const change of [(cp: ReadCheckpoint) => { cp.collection.pages[0]!.items[0]!.output = { fabricated: true }; },
    (cp: ReadCheckpoint) => { cp.artifacts = cp.artifacts.filter(ref => ref.id !== evidence.artifact!.id); },
    (cp: ReadCheckpoint) => { cp.knowledgeDependencies = []; }]) {
    const changed = structuredClone(valid); change(changed); const record = encodeReadCheckpoint(changed, pending, digester);
    await invalidDecode(record, pending.checkpoint, async () => structuredClone(response));
  }
  const record = encodeReadCheckpoint(valid, pending, digester); const replaced = structuredClone(response); replaced.items[0]!.output = { changed: true };
  await invalidDecode(record, pending.checkpoint, async () => replaced);
});

test('checkpoint record: conflicting artifact metadata and dropped inherited references are never encoded', () => {
  const pending = stored(intent(stored(start()))); const response = page(pending, [item('a')], null, 1); const accepted = settle(pending, response).next;
  const missing = structuredClone(accepted); missing.artifacts.shift(); invalidEncode(missing, pending);
  const conflict = structuredClone(accepted); conflict.artifacts.push({ ...conflict.artifacts[0]!, labels: ['changed'] }); invalidEncode(conflict, pending);
  const source = start(); source.knowledgeDependencies = [dependency('old')]; const base = stored(source); const next = resumed(base, 'attempt-2', [dependency('new')]);
  next.knowledgeDependencies.shift(); invalidEncode(next, base);
});

test('checkpoint record: logical checkpoint and referenced response byte limits are enforced before source I/O', async () => {
  const tiny = start(); tiny.limits.maxCheckpointBytes = 16; invalidEncode(tiny, null);
  const pending = stored(intent(stored(start()))); const response = page(pending, [item('a')], null, 1); const accepted = settle(pending, response);
  const record = encodeReadCheckpoint(accepted.next, pending, digester); assert.equal(record.change.type, 'settle');
  if (record.change.type === 'settle') record.change.call.response!.byteLength = pending.checkpoint.limits.maxPageBytes + 1;
  let reads = 0; await invalidDecode(record, pending.checkpoint, async () => { reads++; return response; }); assert.equal(reads, 0);
});

test('checkpoint record: record schema rejects more than 16 MiB of otherwise bounded root metadata', () => {
  const cp = start(); cp.limits.maxCheckpointBytes = 16 * 1024 * 1024;
  cp.goal.criteria = Array.from({ length: 100 }, (_, index) => ({ ...cp.goal.criteria[0]!, id: `criterion-${index}`, description: 'd'.repeat(100000) }));
  cp.policy.allowedLabels = Array.from({ length: 10000 }, () => 'l'.repeat(256));
  cp.policy.allowedTools = Array.from({ length: 10000 }, () => 't'.repeat(256));
  cp.policy.allowedDestinations = Array.from({ length: 10000 }, () => 'd'.repeat(256));
  const record: ReadCheckpointRecord = { schemaVersion: 2, kind: 'read_checkpoint_record', logicalDigest: 'a'.repeat(64), change: { type: 'start', checkpoint: cp } };
  assert.ok(bytes(record) > 16 * 1024 * 1024); assert.equal(ReadCheckpointRecordSchema.safeParse(record).success, false); invalidEncode(cp, null);
});
