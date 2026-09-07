import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Json } from '../../domain/model.js';

export const MCPC_PROTOCOL = '2026-07-28';
export const MCPC_IDS = ['a', 'b', 'c', 'd'] as const;
export type McpCollectionId = typeof MCPC_IDS[number];
export type McpCollectionName = 'documents.batch' | 'observations.page';
export const MCPC_MODES = ['normal', 'partial', 'empty', 'error', 'rate-limit', 'item-error', 'forbidden',
  'snapshot-change', 'cursor-loop', 'late'] as const;
export type McpCollectionMode = typeof MCPC_MODES[number];
const idsSchema = { type: 'array', items: { type: 'string', enum: [...MCPC_IDS] }, minItems: 1, maxItems: 4, uniqueItems: true };
const nullableString = { anyOf: [{ type: 'string', minLength: 1, maxLength: 256 }, { type: 'null' }] };
export const MCPC_QUERY_SCHEMA = { type: 'object' as const, properties: { ids: idsSchema },
  required: ['ids'], additionalProperties: false } satisfies Json;
export const MCPC_READ_SCHEMA = { type: 'object' as const, properties: {
  requestId: { type: 'string', minLength: 1, maxLength: 256 }, cursor: nullableString, snapshot: nullableString,
  retryIds: { anyOf: [idsSchema, { type: 'null' }] }, itemLimit: { type: 'integer', minimum: 1, maximum: 4 },
}, required: ['requestId', 'cursor', 'snapshot', 'retryIds', 'itemLimit'], additionalProperties: false } satisfies Json;
export const MCPC_INPUT_SCHEMA = { type: 'object' as const, properties: { query: MCPC_QUERY_SCHEMA, read: MCPC_READ_SCHEMA },
  required: ['query', 'read'], additionalProperties: false } satisfies Json;
const recordSchema = { type: 'object', properties: {
  sourceKey: { type: 'string', minLength: 1, maxLength: 64 }, rootSourceKey: { type: 'string', minLength: 1, maxLength: 64 },
  recordRevision: { type: 'string', minLength: 1, maxLength: 64 }, observedAt: { type: 'integer', minimum: 0 }, value: { type: 'number' },
}, required: ['sourceKey', 'rootSourceKey', 'recordRevision', 'observedAt', 'value'], additionalProperties: false };
function outputSchema(dataset: string) {
  return { type: 'object' as const, properties: {
    version: { const: 1 }, dataset: { type: 'string', const: dataset }, requestId: { type: 'string', minLength: 1, maxLength: 256 },
    snapshot: { type: 'string', minLength: 1, maxLength: 256 }, cursor: nullableString, nextCursor: nullableString,
    done: { type: 'boolean' }, total: { type: 'integer', minimum: 0, maximum: 4 }, records: { type: 'array', maxItems: 4, items: {
      type: 'object', properties: { id: { type: 'string', enum: [...MCPC_IDS] },
        outcome: { type: 'string', enum: ['ok', 'partial', 'error', 'not_run'] },
        record: { anyOf: [recordSchema, { type: 'null' }] }, error: { anyOf: [{ type: 'object', properties: {
          code: { type: 'string', enum: ['temporary', 'rate_limited', 'forbidden'] }, retryable: { type: 'boolean' },
        }, required: ['code', 'retryable'], additionalProperties: false }, { type: 'null' }] },
      }, required: ['id', 'outcome', 'record', 'error'], additionalProperties: false,
    } },
  }, required: ['version', 'dataset', 'requestId', 'snapshot', 'cursor', 'nextCursor', 'done', 'total', 'records'], additionalProperties: false } satisfies Json;
}
export const MCPC_DOCUMENTS_TOOL = { name: 'documents.batch', inputSchema: MCPC_INPUT_SCHEMA, outputSchema: outputSchema('documents-v1') };
export const MCPC_OBSERVATIONS_TOOL = { name: 'observations.page', inputSchema: MCPC_INPUT_SCHEMA, outputSchema: outputSchema('observations-v1') };
export const MCPC_TOOLS = [MCPC_DOCUMENTS_TOOL, MCPC_OBSERVATIONS_TOOL];

export interface McpCollectionArguments {
  query: { ids: McpCollectionId[] };
  read: { requestId: string; cursor: string | null; snapshot: string | null; retryIds: McpCollectionId[] | null; itemLimit: number };
}
export interface McpCollectionRecord {
  sourceKey: string; rootSourceKey: string; recordRevision: string; observedAt: number; value: number;
}
export interface McpCollectionPayload {
  version: 1; dataset: 'documents-v1' | 'observations-v1'; requestId: string; snapshot: string;
  cursor: string | null; nextCursor: string | null; done: boolean; total: number;
  records: { id: McpCollectionId; outcome: 'ok' | 'partial' | 'error' | 'not_run'; record: McpCollectionRecord | null;
    error: { code: 'temporary' | 'rate_limited' | 'forbidden'; retryable: boolean } | null }[];
}
export interface McpCollectionAudit {
  sequence: number; pid: number;
  event: 'start' | 'method' | 'call' | 'handler-ready' | 'response-delayed' | 'response-sent' | 'close' | 'error';
  method?: string; tool?: McpCollectionName; query?: { ids: McpCollectionId[] }; requestId?: string;
  retryIds?: McpCollectionId[] | null; snapshot?: string | null; cursor?: string | null;
  returnedIds?: McpCollectionId[]; reason?: string;
}
const idList = z.array(z.enum(MCPC_IDS)).min(1).max(4).refine(ids => new Set(ids).size === ids.length);
const token = z.string().min(1).max(256).nullable();
const argumentsSchema = z.strictObject({ query: z.strictObject({ ids: idList }), read: z.strictObject({
  requestId: z.string().min(1).max(256), cursor: token, snapshot: token, retryIds: idList.nullable(), itemLimit: z.number().int().min(1).max(4),
}) });
export function parseCollectionFixtureArguments(input: unknown): McpCollectionArguments {
  const parsed = argumentsSchema.safeParse(input);
  if (!parsed.success) throw new Error('mcpc_arguments_invalid');
  return parsed.data;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function dataset(name: McpCollectionName): McpCollectionPayload['dataset'] {
  return name === 'documents.batch' ? 'documents-v1' : 'observations-v1';
}
function selected(ids: readonly string[]): McpCollectionId[] {
  const parsed = idList.safeParse(ids);
  if (!parsed.success) throw new Error('mcpc_ids_invalid');
  return [...parsed.data].sort();
}
export function collectionFixtureRecord(name: McpCollectionName, id: McpCollectionId): McpCollectionRecord {
  return { sourceKey: `${name === 'documents.batch' ? 'document' : 'observation'}:${id}`,
    rootSourceKey: name === 'documents.batch' ? 'doc-origin' : 'observation-origin', recordRevision: '1', observedAt: 900,
    value: name === 'documents.batch' ? 30 : 1 };
}
export function collectionFixtureSnapshot(name: McpCollectionName, ids: readonly string[]): string {
  const ordered = selected(ids);
  return `mcpc-snapshot:${hash({ dataset: dataset(name), ids: ordered,
    records: ordered.map(id => ({ id, record: collectionFixtureRecord(name, id) })) })}`;
}

/** Fixed local records and page layout; no process/session state participates in source identity. */
export function collectionFixturePage(name: McpCollectionName, supplied: McpCollectionArguments, mode: McpCollectionMode = 'normal'): McpCollectionPayload {
  const args = parseCollectionFixtureArguments(supplied); const ids = selected(args.query.ids);
  const snapshot = collectionFixtureSnapshot(name, ids);
  if (args.read.snapshot !== null && args.read.snapshot !== snapshot) throw new Error('mcpc_snapshot_unavailable');
  if ((args.read.cursor !== null || args.read.retryIds !== null) && args.read.snapshot === null) throw new Error('mcpc_snapshot_required');
  const pages: McpCollectionId[][] = name === 'documents.batch' ? [ids] : [ids.slice(0, 2), ...(ids.length > 2 ? [ids.slice(2)] : [])];
  if (mode === 'empty' && name === 'observations.page') pages.splice(pages.length > 1 ? 1 : 0, 0, []);
  const layout = mode === 'empty' && name === 'observations.page' ? 'empty-middle' : 'normal';
  const cursorFor = (index: number): string | null => index === 0 ? null : `mcpc-cursor:${hash({ snapshot, layout, index })}`;
  const index = pages.findIndex((_page, position) => cursorFor(position) === args.read.cursor);
  if (index < 0) throw new Error('mcpc_cursor_unavailable');
  const page = pages[index]!;
  if (args.read.retryIds?.some(id => !page.includes(id))) throw new Error('mcpc_retry_ids_invalid');
  const wanted = args.read.retryIds ?? page;
  if (wanted.length > args.read.itemLimit) throw new Error('mcpc_item_limit');
  let nextCursor = index + 1 < pages.length ? cursorFor(index + 1) : null;
  if (mode === 'cursor-loop' && args.read.cursor !== null) nextCursor = args.read.cursor;
  return { version: 1, dataset: dataset(name), requestId: args.read.requestId,
    snapshot: mode === 'snapshot-change' && args.read.cursor !== null ? `mcpc-snapshot:${hash({ snapshot, changed: true })}` : snapshot,
    cursor: args.read.cursor, nextCursor, done: nextCursor === null, total: ids.length,
    records: wanted.map(id => {
      const affected = id === 'b' && args.read.retryIds === null;
      if (affected && (mode === 'item-error' || mode === 'forbidden')) return { id, outcome: 'error', record: null,
        error: { code: mode === 'forbidden' ? 'forbidden' : 'temporary', retryable: mode !== 'forbidden' } };
      return { id, outcome: affected && mode === 'partial' ? 'partial' : 'ok', record: collectionFixtureRecord(name, id), error: null };
    }) };
}
