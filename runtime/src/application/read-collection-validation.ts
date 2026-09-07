import type { z } from 'zod';
import type { ReadCollectionState, ReadKey, ReadLimits, ReadPage, ReadRequest } from '../domain/read-collection.js';
import type { ToolUsage } from '../domain/model.js';
import { ReadCollectionStateSchema, ReadKeySchema, ReadLimitsSchema, ReadPageSchema, ReadRequestSchema } from './read-collection-contracts.js';
import { uniqueKnowledgeDependencies } from './knowledge-validity.js';

export class ReadCollectionError extends Error {
  constructor(readonly code: string) { super(code); }
}
function fail(code: string): never { throw new ReadCollectionError(code); }
function parse<T>(schema: z.ZodType<T>, input: unknown, code: string): T {
  const result = schema.safeParse(input); if (!result.success) fail(code); return result.data;
}
function bytes(input: unknown) {
  try { const text = JSON.stringify(input); if (text === undefined) fail('read_invalid_json'); return new TextEncoder().encode(text).byteLength; }
  catch { return fail('read_invalid_json'); }
}
function keys(values: ReadKey[]) {
  const map = new Map<string, string>();
  for (const key of values) { if (map.has(key.id)) fail('read_duplicate_item'); map.set(key.id, key.inputDigest); }
  return map;
}
function sameKeys(expected: ReadKey[], actual: ReadKey[]) {
  const wanted = keys(expected); const found = keys(actual);
  if (wanted.size !== found.size || [...wanted].some(([id, digest]) => found.get(id) !== digest)) fail('read_item_set_mismatch');
}
function pageShape(page: ReadPage) {
  sameKeys(page.expected, page.items);
  if (page.exhausted !== (page.nextCursor === null)) fail('read_cursor_completion_mismatch');
}
function knownTotal(prior: number | null, next: number | null) {
  if (prior !== null && next !== null && prior !== next) fail('read_total_changed');
  return prior ?? next;
}
function countCheck(count: number, total: number | null, exhausted: boolean) {
  if (total !== null && (count > total || (exhausted && count !== total))) fail('read_total_mismatch');
}
function checkpoint(state: ReadCollectionState, limits: ReadLimits) {
  if (bytes(state) > limits.maxCheckpointBytes) fail('read_checkpoint_too_large');
}

/** Structural validation does not authenticate a checkpoint or its trusted batch manifest. */
function current(input: ReadCollectionState, limits: ReadLimits): ReadCollectionState {
  checkpoint(input, limits);
  const state = parse(ReadCollectionStateSchema, input, 'read_invalid_state');
  if ((state.kind === 'batch') !== (state.batchExpected !== null)) fail('read_invalid_manifest');
  if (state.batchExpected) {
    keys(state.batchExpected);
    if (state.batchExpected.length > Math.min(limits.pageSize, limits.maxItems)) fail('read_item_limit');
  }
  const all = [...state.pages, ...(state.pending ? [state.pending] : [])];
  if (all.length > limits.maxPages) fail('read_page_limit');
  if (state.calls > limits.maxCalls) fail('read_call_limit');
  if (state.calls !== state.acceptedRequestIds.length || state.calls < all.length || (!all.length && state.calls !== 0)) fail('read_invalid_call_count');
  const accepted = new Set(state.acceptedRequestIds);
  if (accepted.size !== state.acceptedRequestIds.length) fail('read_invalid_request_history');
  if (state.kind === 'batch' && all.length > 1) fail('read_batch_page_mismatch');
  const seen: string[] = []; const ids = new Set<string>(); const requests = new Set<string>();
  let cursor: string | null = null; let snapshot: string | null = null; let total: number | null = null;
  for (const [index, page] of all.entries()) {
    pageShape(page);
    if (!accepted.has(page.requestId)) fail('read_invalid_request_history');
    if (requests.has(page.requestId)) fail('read_request_replayed'); requests.add(page.requestId);
    if (page.cursor !== cursor || (index < all.length - 1 && page.exhausted)) fail('read_cursor_chain_changed');
    if (snapshot !== null && snapshot !== page.sourceSnapshot) fail('read_snapshot_changed'); snapshot = page.sourceSnapshot;
    if (page.cursor !== null) { if (seen.includes(page.cursor)) fail('read_cursor_loop'); seen.push(page.cursor); }
    if (page.nextCursor !== null && seen.includes(page.nextCursor)) fail('read_cursor_loop');
    if (state.kind === 'batch') {
      sameKeys(state.batchExpected!, page.expected);
      if (page.cursor !== null || !page.exhausted) fail('read_batch_page_mismatch');
    }
    if (page.expected.length > limits.pageSize) fail('read_item_limit');
    for (const key of page.expected) { if (ids.has(key.id)) fail('read_duplicate_item'); ids.add(key.id); }
    if (ids.size > limits.maxItems) fail('read_item_limit');
    const complete = page.items.every(item => item.status === 'success');
    if (index < state.pages.length ? !complete : complete) fail('read_pending_mismatch');
    total = knownTotal(total, page.totalItems); countCheck(ids.size, total, page.exhausted);
    cursor = page.nextCursor;
  }
  const last = state.pages.at(-1);
  if (state.snapshot !== snapshot || state.totalItems !== total ||
    state.exhausted !== (state.pending ? false : last?.exhausted ?? false) ||
    state.nextCursor !== (state.pending ? state.pending.cursor : last?.nextCursor ?? null) ||
    state.seenCursors.length !== seen.length || state.seenCursors.some((value, index) => value !== seen[index])) fail('read_state_projection_mismatch');
  return state;
}

export function initialize(kind: ReadCollectionState['kind'], batchExpected: ReadKey[] | null = null): ReadCollectionState {
  if ((kind !== 'batch' && kind !== 'paged') || (kind === 'batch') !== (batchExpected !== null)) fail('read_invalid_manifest');
  const manifest = batchExpected === null ? null : parse(ReadKeySchema.array().max(1000), batchExpected, 'read_invalid_manifest');
  if (manifest) keys(manifest);
  return { kind, snapshot: null, pages: [], pending: null, nextCursor: null, exhausted: false, totalItems: null,
    seenCursors: [], batchExpected: manifest, calls: 0, acceptedRequestIds: [] };
}

/** Called only for a new explicit request; it neither retries nor changes collection state. */
export function nextRequest(input: ReadCollectionState, requestId: string, configuration: ReadLimits): ReadRequest | null {
  const limits = parse(ReadLimitsSchema, configuration, 'read_invalid_limits'); const state = current(input, limits);
  if (state.exhausted) return null;
  if (state.calls >= limits.maxCalls) fail('read_call_limit');
  if (state.acceptedRequestIds.includes(requestId)) fail('read_request_replayed');
  const retryItems = state.pending?.items.filter(item => item.status !== 'success').map(({ id, inputDigest }) => ({ id, inputDigest })) ?? null;
  if (state.pending?.items.some(item => item.status !== 'success' && item.error?.retryable === false)) fail('read_retry_forbidden');
  if (!state.pending && state.pages.length >= limits.maxPages) fail('read_page_limit');
  const remaining = limits.maxItems - state.pages.reduce((count, page) => count + page.expected.length, 0);
  if (!state.pending && remaining <= 0) fail('read_item_limit');
  return parse(ReadRequestSchema, { requestId, cursor: state.nextCursor, snapshot: state.snapshot, retryItems,
    itemLimit: retryItems?.length ?? Math.min(limits.pageSize, remaining) }, 'read_invalid_request');
}

function addUsage(prior: ToolUsage | undefined, next: ToolUsage | undefined): ToolUsage | undefined {
  if (!prior && !next) return undefined;
  const sum = (key: keyof ToolUsage) => {
    const a = prior?.[key]; const b = next?.[key];
    if (a === undefined || a === null || b === undefined || b === null) return null;
    if (!Number.isSafeInteger(a + b)) fail('read_usage_overflow'); return a + b;
  };
  return { transportCalls: sum('transportCalls'), internalOperations: sum('internalOperations'), imageBytes: sum('imageBytes'), waitMs: sum('waitMs') };
}

export function acceptPage(input: ReadCollectionState, proposed: ReadRequest, response: unknown, configuration: ReadLimits): ReadCollectionState {
  const limits = parse(ReadLimitsSchema, configuration, 'read_invalid_limits'); const state = current(input, limits);
  const request = parse(ReadRequestSchema, proposed, 'read_invalid_request'); const expectedRequest = nextRequest(state, request.requestId, limits);
  if (!expectedRequest) fail('read_already_complete');
  if (request.cursor !== expectedRequest.cursor || request.snapshot !== expectedRequest.snapshot || request.itemLimit !== expectedRequest.itemLimit ||
    (request.retryItems === null) !== (expectedRequest.retryItems === null)) fail('read_request_changed');
  if (request.retryItems && expectedRequest.retryItems) sameKeys(expectedRequest.retryItems, request.retryItems);
  if (bytes(response) > limits.maxPageBytes) fail('read_page_too_large');
  const received = parse(ReadPageSchema, response, 'read_invalid_page'); pageShape(received);
  if (received.requestId !== request.requestId || received.cursor !== request.cursor) fail('read_response_request_mismatch');
  if (state.snapshot !== null && received.sourceSnapshot !== state.snapshot) fail('read_snapshot_changed');
  if (received.expected.length > request.itemLimit) fail('read_item_limit');
  let page = received;
  if (state.pending) {
    sameKeys(request.retryItems!, received.expected);
    const prior = state.pending;
    if (received.nextCursor !== prior.nextCursor || received.exhausted !== prior.exhausted || received.totalItems !== prior.totalItems ||
      received.sourceSnapshot !== prior.sourceSnapshot) fail('read_pending_metadata_changed');
    const changes = new Map(received.items.map(item => [item.id, item]));
    const dependencies = uniqueKnowledgeDependencies([...(prior.knowledgeDependencies ?? []), ...(received.knowledgeDependencies ?? [])]);
    if (dependencies.length > 50) fail('read_dependencies_limit');
    const usage = addUsage(prior.usage, received.usage);
    page = { ...received, expected: structuredClone(prior.expected),
      items: prior.items.map(item => structuredClone(item.status === 'success' ? item : changes.get(item.id)!)),
      ...(usage ? { usage } : {}), ...(dependencies.length ? { knowledgeDependencies: structuredClone(dependencies) } : {}) };
  } else if (state.kind === 'batch') {
    sameKeys(state.batchExpected!, received.expected);
    if (received.cursor !== null || !received.exhausted) fail('read_batch_page_mismatch');
  }
  const total = knownTotal(state.totalItems, page.totalItems);
  const ids = new Set(state.pages.flatMap(value => value.expected.map(item => item.id)));
  for (const key of page.expected) { if (ids.has(key.id)) fail('read_duplicate_item'); ids.add(key.id); }
  if (ids.size > limits.maxItems) fail('read_item_limit'); countCheck(ids.size, total, page.exhausted);
  const seenCursors = [...state.seenCursors];
  if (!state.pending && page.cursor !== null) {
    if (seenCursors.includes(page.cursor)) fail('read_cursor_loop'); seenCursors.push(page.cursor);
  }
  if (page.nextCursor !== null && seenCursors.includes(page.nextCursor)) fail('read_cursor_loop');
  const complete = page.items.every(item => item.status === 'success');
  const next: ReadCollectionState = { ...state, snapshot: page.sourceSnapshot, totalItems: total, seenCursors, calls: state.calls + 1,
    acceptedRequestIds: [...state.acceptedRequestIds, request.requestId],
    pages: complete ? [...state.pages, page] : state.pages, pending: complete ? null : page,
    nextCursor: complete ? page.nextCursor : page.cursor, exhausted: complete && page.exhausted };
  return current(next, limits);
}
