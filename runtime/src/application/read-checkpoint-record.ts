import { z } from 'zod';
import type { ArtifactRef } from '../domain/model.js';
import type { ReadCheckpoint, ReadCall } from '../domain/read-checkpoint.js';
import type { ReadCheckpointChange, ReadCheckpointRecord } from '../domain/read-checkpoint-record.js';
import { isReadDeferral, pendingReadRetryAt, type ReadDeferral, type ReadPage, type ReadResponse } from '../domain/read-collection.js';
import type { Digester } from './ports.js';
import { ArtifactSchema } from './contracts.js';
import { ReadCallSchema, ReadCheckpointSchema } from './read-checkpoint-contracts.js';
import { ReadDeferralSchema, ReadPageSchema } from './read-collection-contracts.js';
import { KnowledgeDependencySchema } from './knowledge-contracts.js';
import { uniqueKnowledgeDependencies } from './knowledge-validity.js';
import { acceptPage, initialize, nextRequest, ReadCollectionError } from './read-collection-validation.js';
import { asJson } from './plan-validator.js';

const maxRecordBytes = 16 * 1024 * 1024;
const id = z.string().min(1).max(256);
const time = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
function invalid(): never { throw new Error('read_record_invalid'); }
function byteLength(value: unknown) { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
function digest(value: unknown, digester: Digester) { return digester.digest(asJson(value)); }
function same(a: unknown, b: unknown, digester: Digester) { return digest(a, digester) === digest(b, digester); }
function rootStart(cp: ReadCheckpoint) {
  const collection = cp.collection;
  return cp.parent === null && cp.rootAttemptId === cp.attemptId && cp.calls.length === 0 && cp.artifacts.length === 0 &&
    cp.phase === 'running' && cp.stopReason === null && cp.retryAt === undefined && collection.pages.length === 0 && collection.pending === null &&
    collection.snapshot === null && collection.nextCursor === null && collection.totalItems === null && !collection.exhausted &&
    collection.calls === 0 && collection.acceptedRequestIds.length === 0 && collection.seenCursors.length === 0;
}
export const ReadCheckpointRecordSchema: z.ZodType<ReadCheckpointRecord> = z.strictObject({ schemaVersion: z.literal(2),
  kind: z.literal('read_checkpoint_record'), logicalDigest: z.string().regex(/^[0-9a-f]{64}$/),
  change: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('start'), checkpoint: ReadCheckpointSchema.refine(rootStart, 'read_record_start_invalid') }),
    z.strictObject({ type: z.literal('resume'), base: ArtifactSchema, attemptId: id, updatedAt: time, knowledgeDependencies: z.array(KnowledgeDependencySchema).max(50) }),
    z.strictObject({ type: z.literal('intent'), base: ArtifactSchema, call: ReadCallSchema.refine(call => call.status === 'intent', 'read_record_intent_invalid'), updatedAt: time }),
    z.strictObject({ type: z.literal('settle'), base: ArtifactSchema, call: ReadCallSchema.refine(call => call.status === 'accepted' || call.status === 'deferred' ||
      (call.status === 'rejected' && call.response === null), 'read_record_settle_invalid'), updatedAt: time }),
    z.strictObject({ type: z.literal('stop'), base: ArtifactSchema, reason: z.string().min(1).max(10000), updatedAt: time }),
  ]),
}).refine(record => byteLength(record) <= maxRecordBytes, 'read_record_too_large');

function refs(values: ArtifactRef[], digester: Digester): ArtifactRef[] {
  const unique = new Map<string, ArtifactRef>();
  for (const value of values) {
    const ref = ArtifactSchema.parse(value); const old = unique.get(ref.id);
    if (old && !same(old, ref, digester)) invalid();
    unique.set(ref.id, ref);
  }
  if (unique.size > 10000) invalid();
  return [...unique.values()];
}
function checkpoint(value: ReadCheckpoint, digester: Digester): ReadCheckpoint {
  if (byteLength(value) > maxRecordBytes) invalid();
  const cp = ReadCheckpointSchema.parse(value);
  if (byteLength(cp) > cp.limits.maxCheckpointBytes || !same(refs(cp.artifacts, digester), cp.artifacts, digester) ||
    !same(uniqueKnowledgeDependencies(cp.knowledgeDependencies), cp.knowledgeDependencies, digester)) invalid();
  if (cp.collection.batchExpected && cp.collection.batchExpected.length > Math.min(cp.limits.pageSize, cp.limits.maxItems)) invalid();
  if ([...cp.collection.pages, ...(cp.collection.pending ? [cp.collection.pending] : [])].some(page => page.expected.length > cp.limits.pageSize)) invalid();
  // nextRequest validates the complete collection projection before checking whether another request is permitted.
  const acceptedIds = new Set(cp.collection.acceptedRequestIds); let suffix = 0;
  while (acceptedIds.has(`record-validation-${suffix}`)) suffix++;
  const probe = `record-validation-${suffix}`;
  try { nextRequest(cp.collection, probe, cp.limits); }
  catch (error) {
    if (!(error instanceof ReadCollectionError) || !['read_call_limit', 'read_retry_forbidden', 'read_page_limit', 'read_item_limit'].includes(error.code)) invalid();
  }
  return cp;
}
function baseFor(change: Exclude<ReadCheckpointChange, { type: 'start' }>, base: ReadCheckpoint | null, digester: Digester) {
  if (!base) invalid();
  const cp = checkpoint(base, digester);
  if (change.updatedAt < cp.updatedAt) invalid();
  return cp;
}
function appendIntent(base: ReadCheckpoint, change: Extract<ReadCheckpointChange, { type: 'intent' }>, digester: Digester): ReadCheckpoint {
  const call = change.call;
  if (base.phase !== 'running' || base.calls.some(value => value.status === 'intent') || base.calls.length >= base.limits.maxCalls ||
    call.attemptId !== base.attemptId || call.dispatchedAt < base.updatedAt || call.dispatchedAt < (base.retryAt ?? 0) ||
    !same(nextRequest(base.collection, call.request.requestId, base.limits), call.request, digester)) invalid();
  return { ...base, calls: [...base.calls, call], artifacts: refs([...base.artifacts, change.base], digester), updatedAt: change.updatedAt };
}
function resume(base: ReadCheckpoint, change: Extract<ReadCheckpointChange, { type: 'resume' }>, digester: Digester): ReadCheckpoint {
  if (change.attemptId === base.attemptId || change.attemptId === base.rootAttemptId || change.updatedAt < (base.retryAt ?? 0)) invalid();
  return { ...base, attemptId: change.attemptId, calls: base.calls.map(call => call.status === 'intent' ?
    { ...call, status: 'unknown', errorCode: 'read_response_unknown' } : call),
    parent: { attemptId: base.attemptId, checkpoint: change.base }, artifacts: refs([change.base, ...base.artifacts], digester),
    knowledgeDependencies: uniqueKnowledgeDependencies([...base.knowledgeDependencies, ...change.knowledgeDependencies]),
    phase: base.collection.exhausted ? 'complete' : 'running', stopReason: null, updatedAt: change.updatedAt };
}
function settleCall(base: ReadCheckpoint, call: ReadCall, digester: Digester) {
  const intent = base.calls.at(-1);
  if (base.phase !== 'running' || !intent || intent.status !== 'intent' || call.receivedAt === null || call.receivedAt < base.updatedAt ||
    !same({ ...call, status: 'intent', response: null, receivedAt: null, errorCode: null }, intent, digester)) invalid();
  return [...base.calls.slice(0, -1), call];
}
function stop(base: ReadCheckpoint, change: Extract<ReadCheckpointChange, { type: 'stop' }>, digester: Digester): ReadCheckpoint {
  if (base.phase !== 'running' || base.calls.some(call => call.status === 'intent')) invalid();
  return { ...base, phase: 'partial', stopReason: change.reason, artifacts: refs([...base.artifacts, change.base], digester), updatedAt: change.updatedAt };
}
function settled(base: ReadCheckpoint, change: Extract<ReadCheckpointChange, { type: 'settle' }>, response: ReadResponse | null, digester: Digester): ReadCheckpoint {
  const calls = settleCall(base, change.call, digester);
  const deferral = response && isReadDeferral(response) ? response : null;
  const page = response && !isReadDeferral(response) ? response : null;
  if ((change.call.status === 'accepted') !== (page !== null)) invalid();
  if ((change.call.status === 'deferred') !== (deferral !== null) || response && response.requestId !== change.call.request.requestId) invalid();
  const collection = page ? acceptPage(base.collection, change.call.request, page, base.limits) : base.collection;
  const incoming = page ? [...(page.rawArtifact ? [page.rawArtifact] : []),
    ...page.items.flatMap(item => [...item.artifacts, ...item.evidence.flatMap(evidence => evidence.artifact ? [evidence.artifact] : [])])] : [];
  if (deferral?.rawArtifact) incoming.push(deferral.rawArtifact);
  const pendingAt = pendingReadRetryAt(collection);
  const retryAt = deferral ? Math.max(deferral.dueAt, pendingAt ?? 0) : page ? pendingAt : base.retryAt;
  return { ...base, calls, collection,
    ...(retryAt !== undefined && (retryAt !== null || base.retryAt !== undefined) ? { retryAt } : {}),
    artifacts: refs([...base.artifacts, change.base, ...(change.call.response ? [change.call.response] : []), ...incoming], digester),
    knowledgeDependencies: uniqueKnowledgeDependencies([...base.knowledgeDependencies, ...(response?.knowledgeDependencies ?? [])]),
    phase: collection.exhausted ? 'complete' : !page || collection.pending ? 'partial' : 'running',
    stopReason: collection.exhausted ? null : change.call.errorCode ?? (collection.pending ? 'read_items_pending' : null), updatedAt: change.updatedAt };
}

/** Uses the same deterministic settlement as record replay; callers authenticate response custody before publication. */
export function settleReadCheckpoint(base: { head: ArtifactRef; checkpoint: ReadCheckpoint }, call: ReadCall,
  response: ReadResponse, digester: Digester): ReadCheckpoint {
  const parsedCall = ReadCallSchema.parse(call);
  if (!['accepted', 'deferred'].includes(parsedCall.status) || parsedCall.receivedAt === null) invalid();
  const value = isReadDeferral(response) ? ReadDeferralSchema.parse(response) : ReadPageSchema.parse(response);
  return checkpoint(settled(checkpoint(base.checkpoint, digester), { type: 'settle', base: ArtifactSchema.parse(base.head), call: parsedCall,
    updatedAt: parsedCall.receivedAt }, value, digester), digester);
}

/** Encodes only legal changes. Accepted raw-page replay is checked by decode, whose loader authenticates the referenced bytes. */
export function encodeReadCheckpoint(value: ReadCheckpoint, previous: { head: ArtifactRef; checkpoint: ReadCheckpoint } | null, digester: Digester): ReadCheckpointRecord {
  try {
    const next = checkpoint(value, digester); let change: ReadCheckpointChange; let expected: ReadCheckpoint;
    if (!previous) {
      if (!rootStart(next) || !same(next.collection, initialize(next.collection.kind, next.collection.batchExpected), digester)) invalid();
      change = { type: 'start', checkpoint: next }; expected = next;
    } else {
      const head = ArtifactSchema.parse(previous.head); const base = checkpoint(previous.checkpoint, digester);
      if (next.updatedAt < base.updatedAt) invalid();
      if (next.attemptId !== base.attemptId) {
        change = { type: 'resume', base: head, attemptId: next.attemptId, updatedAt: next.updatedAt,
          knowledgeDependencies: next.knowledgeDependencies.filter(dependency => !base.knowledgeDependencies.some(old => same(old, dependency, digester))) };
        expected = resume(base, change, digester);
      } else if (next.calls.length === base.calls.length + 1) {
        change = { type: 'intent', base: head, call: next.calls.at(-1)!, updatedAt: next.updatedAt }; expected = appendIntent(base, change, digester);
      } else if (base.calls.at(-1)?.status === 'intent') {
        change = { type: 'settle', base: head, call: next.calls.at(-1)!, updatedAt: next.updatedAt };
        if (change.call.status === 'accepted' || change.call.status === 'deferred') {
          if (!change.call.response || change.call.response.byteLength > base.limits.maxPageBytes) invalid();
          const required = refs([...base.artifacts, head, change.call.response!], digester);
          if (!same(next.artifacts.slice(0, required.length), required, digester) ||
            !same(uniqueKnowledgeDependencies([...base.knowledgeDependencies, ...next.knowledgeDependencies]), next.knowledgeDependencies, digester)) invalid();
          const deferred = change.call.status === 'deferred';
          const retryAt = deferred ? next.retryAt : pendingReadRetryAt(next.collection);
          if (deferred && (typeof retryAt !== 'number' || !same(next.collection, base.collection, digester))) invalid();
          expected = { ...base, calls: settleCall(base, change.call, digester), collection: next.collection, artifacts: next.artifacts,
            ...(retryAt !== null && retryAt !== undefined || base.retryAt !== undefined ? { retryAt } : {}),
            knowledgeDependencies: next.knowledgeDependencies, phase: deferred ? 'partial' : next.collection.exhausted ? 'complete' : next.collection.pending ? 'partial' : 'running',
            stopReason: deferred ? 'read_rate_limited' : next.collection.pending ? 'read_items_pending' : null, updatedAt: next.updatedAt };
        } else expected = settled(base, change, null, digester);
      } else {
        if (next.stopReason === null) invalid();
        change = { type: 'stop', base: head, reason: next.stopReason, updatedAt: next.updatedAt }; expected = stop(base, change, digester);
      }
    }
    if (!same(expected, next, digester)) invalid();
    return ReadCheckpointRecordSchema.parse({ schemaVersion: 2, kind: 'read_checkpoint_record', logicalDigest: digest(next, digester), change });
  } catch { return invalid(); }
}

export async function decodeReadCheckpoint(value: ReadCheckpointRecord, previous: ReadCheckpoint | null, readPage: (ref: ArtifactRef) => Promise<ReadPage>, digester: Digester,
  readDeferral?: (ref: ArtifactRef) => Promise<ReadDeferral>): Promise<ReadCheckpoint> {
  try {
    if (byteLength(value) > maxRecordBytes) invalid();
    const record = ReadCheckpointRecordSchema.parse(value); const change = record.change; let next: ReadCheckpoint;
    if (change.type === 'start') {
      if (previous !== null) invalid(); next = checkpoint(change.checkpoint, digester);
      if (!same(next.collection, initialize(next.collection.kind, next.collection.batchExpected), digester)) invalid();
    } else {
      const base = baseFor(change, previous, digester);
      if (change.type === 'resume') next = resume(base, change, digester);
      else if (change.type === 'intent') next = appendIntent(base, change, digester);
      else if (change.type === 'stop') next = stop(base, change, digester);
      else {
        let response: ReadResponse | null = null;
        settleCall(base, change.call, digester);
        if (change.call.status === 'accepted') {
          if (!change.call.response || change.call.response.byteLength > base.limits.maxPageBytes) invalid();
          response = ReadPageSchema.parse(await readPage(structuredClone(change.call.response)));
        }
        if (change.call.status === 'deferred') {
          if (!readDeferral || !change.call.response || change.call.response.byteLength > base.limits.maxPageBytes) invalid();
          response = ReadDeferralSchema.parse(await readDeferral(structuredClone(change.call.response)));
        }
        next = settled(base, change, response, digester);
      }
    }
    next = checkpoint(next, digester);
    if (digest(next, digester) !== record.logicalDigest) invalid();
    return next;
  } catch { return invalid(); }
}
