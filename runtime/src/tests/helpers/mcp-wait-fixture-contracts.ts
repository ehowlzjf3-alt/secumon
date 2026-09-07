import { z } from 'zod';
import type { Json } from '../../domain/model.js';
import { MCPC_IDS, MCPC_INPUT_SCHEMA, MCPC_PROTOCOL, MCPC_QUERY_SCHEMA, collectionFixturePage,
  type McpCollectionArguments, type McpCollectionAudit, type McpCollectionName } from './mcp-collection-fixture-contracts.js';

export const MCPW_PROTOCOL = MCPC_PROTOCOL;
export const MCPW_QUERY_SCHEMA = MCPC_QUERY_SCHEMA;
export const MCPW_INPUT_SCHEMA = MCPC_INPUT_SCHEMA;
export const MCPW_MAX_DELAY_MS = 60000;
export const MCPW_MODES = ['normal', 'whole-rate-limit', 'item-rate-limit', 'invalid-delay', 'conflicting', 'late'] as const;
export type McpWaitMode = typeof MCPW_MODES[number];
export const MCPW_INVALID_CASES = ['zero', 'negative', 'fraction', 'string', 'null', 'over-limit', 'unsafe', 'missing',
  'wrong-request', 'wrong-cursor', 'false-error', 'success-hint', 'forbidden-hint'] as const;
export type McpWaitInvalidCase = typeof MCPW_INVALID_CASES[number];
export interface McpWaitAudit extends McpCollectionAudit { mode?: McpWaitMode; responseKind?: 'page' | 'rate_limit' | 'invalid'; retryAfterMs?: number }

const token = z.string().min(1).max(256);
const delay = z.number().int().min(1).max(MCPW_MAX_DELAY_MS);
const record = z.strictObject({ sourceKey: z.string().min(1).max(64), rootSourceKey: z.string().min(1).max(64),
  recordRevision: z.string().min(1).max(64), observedAt: z.number().int().nonnegative(), value: z.number() });
const item = z.union([
  z.strictObject({ id: z.enum(MCPC_IDS), outcome: z.literal('ok'), record, error: z.null() }),
  z.strictObject({ id: z.enum(MCPC_IDS), outcome: z.literal('error'), record: z.null(),
    error: z.strictObject({ code: z.literal('rate_limited'), retryable: z.literal(true), retryAfterMs: delay }) }),
]);
const base = { version: z.literal(2), dataset: z.enum(['documents-v1', 'observations-v1']), requestId: token, cursor: token.nullable() };
const page = z.strictObject({ ...base, kind: z.literal('page'), snapshot: token, nextCursor: token.nullable(),
  done: z.boolean(), total: z.number().int().min(0).max(4), records: z.array(item).max(4) });
const deferred = z.strictObject({ ...base, kind: z.literal('rate_limit'), snapshot: token.nullable(), retryAfterMs: delay });
const payload = z.union([page, deferred]);
export type McpWaitPage = z.infer<typeof page>;
export type McpWaitDeferral = z.infer<typeof deferred>;
export type McpWaitPayload = z.infer<typeof payload>;
const result = z.strictObject({ resultType: z.literal('complete').optional(), isError: z.boolean().optional(),
  content: z.array(z.strictObject({ type: z.literal('text'), text: z.string().max(1024) })).max(4),
  structuredContent: payload, _meta: z.record(z.string(), z.unknown()).optional() });
/** Protocol metadata stays opaque; the fixture's duplicate retry slot is explicitly forbidden. */
export function parseWaitFixtureResult(value: unknown): z.infer<typeof result> {
  const parsed = result.safeParse(value);
  if (!parsed.success || parsed.data._meta?.['fixture/retryAfterMs'] !== undefined) throw new Error('mcpw_result_invalid');
  if ((parsed.data.isError === true) !== (parsed.data.structuredContent.kind === 'rate_limit')) throw new Error('mcpw_error_conflict');
  return parsed.data;
}
export function parseWaitFixturePage(value: unknown): McpWaitPage {
  const parsed = page.safeParse(value); if (!parsed.success) throw new Error('mcpw_page_invalid'); return parsed.data;
}

const str = { type: 'string', minLength: 1, maxLength: 256 };
const nullable = { anyOf: [str, { type: 'null' }] };
const after = { type: 'integer', minimum: 1, maximum: MCPW_MAX_DELAY_MS };
const recordSchema = { type: 'object', properties: { sourceKey: { type: 'string', minLength: 1, maxLength: 64 },
  rootSourceKey: { type: 'string', minLength: 1, maxLength: 64 }, recordRevision: { type: 'string', minLength: 1, maxLength: 64 },
  observedAt: { type: 'integer', minimum: 0 }, value: { type: 'number' } },
  required: ['sourceKey', 'rootSourceKey', 'recordRevision', 'observedAt', 'value'], additionalProperties: false };
const id = { type: 'string', enum: [...MCPC_IDS] };
const itemSchema = { anyOf: [
  { type: 'object', properties: { id, outcome: { const: 'ok' }, record: recordSchema, error: { type: 'null' } },
    required: ['id', 'outcome', 'record', 'error'], additionalProperties: false },
  { type: 'object', properties: { id, outcome: { const: 'error' }, record: { type: 'null' }, error: {
    type: 'object', properties: { code: { const: 'rate_limited' }, retryable: { const: true }, retryAfterMs: after },
    required: ['code', 'retryable', 'retryAfterMs'], additionalProperties: false } },
    required: ['id', 'outcome', 'record', 'error'], additionalProperties: false },
] };
function outputSchema(dataset: string): Record<string, Json> {
  const common = { version: { const: 2 }, dataset: { const: dataset }, requestId: str, cursor: nullable };
  return { anyOf: [
    { type: 'object', properties: { ...common, kind: { const: 'page' }, snapshot: str, nextCursor: nullable,
      done: { type: 'boolean' }, total: { type: 'integer', minimum: 0, maximum: 4 }, records: { type: 'array', maxItems: 4, items: itemSchema } },
      required: ['version', 'dataset', 'requestId', 'cursor', 'kind', 'snapshot', 'nextCursor', 'done', 'total', 'records'], additionalProperties: false },
    { type: 'object', properties: { ...common, kind: { const: 'rate_limit' }, snapshot: nullable, retryAfterMs: after },
      required: ['version', 'dataset', 'requestId', 'cursor', 'kind', 'snapshot', 'retryAfterMs'], additionalProperties: false },
  ] };
}
export const MCPW_DOCUMENTS_TOOL = { name: 'documents.batch', inputSchema: MCPW_INPUT_SCHEMA, outputSchema: outputSchema('documents-v1') };
export const MCPW_OBSERVATIONS_TOOL = { name: 'observations.page', inputSchema: MCPW_INPUT_SCHEMA, outputSchema: outputSchema('observations-v1') };
export const MCPW_TOOLS = [MCPW_DOCUMENTS_TOOL, MCPW_OBSERVATIONS_TOOL];

export function waitFixtureResult(name: McpCollectionName, args: McpCollectionArguments, mode: McpWaitMode,
  retryAfterMs: number, invalid: McpWaitInvalidCase = 'negative'): Json {
  // Validate the same finite source/page/cursor semantics even when returning a whole-call deferral.
  const original = collectionFixturePage(name, args);
  const waiting: McpWaitDeferral = { version: 2, kind: 'rate_limit', dataset: original.dataset,
    requestId: args.read.requestId, cursor: args.read.cursor, snapshot: args.read.snapshot, retryAfterMs };
  if (mode === 'whole-rate-limit' || mode === 'invalid-delay' || mode === 'conflicting') {
    const structuredContent: Record<string, Json> = { ...waiting }; let isError = true;
    if (mode === 'invalid-delay') {
      const wrong: Partial<Record<McpWaitInvalidCase, Json>> = { zero: 0, negative: -1, fraction: 1.5, string: '2500', null: null,
        'over-limit': MCPW_MAX_DELAY_MS + 1, unsafe: Number.MAX_SAFE_INTEGER + 1 };
      if (invalid in wrong) structuredContent['retryAfterMs'] = wrong[invalid]!;
      if (invalid === 'missing') delete structuredContent['retryAfterMs'];
      if (invalid === 'wrong-request') structuredContent['requestId'] = 'foreign-request';
      if (invalid === 'wrong-cursor') structuredContent['cursor'] = 'foreign-cursor';
      if (invalid === 'false-error') isError = false;
    }
    if (invalid !== 'success-hint' && invalid !== 'forbidden-hint' || mode !== 'invalid-delay') return {
      resultType: 'complete', isError, content: [{ type: 'text', text: 'fixture_rate_limited' }], structuredContent,
      ...(mode === 'conflicting' ? { _meta: { 'fixture/retryAfterMs': retryAfterMs + 1 } } : {}),
    };
  }
  const records: McpWaitPage['records'] = original.records.map(value => {
    if (mode === 'item-rate-limit' && value.id === 'b' && args.read.retryIds === null) return { id: value.id,
      outcome: 'error', record: null, error: { code: 'rate_limited', retryable: true, retryAfterMs } };
    return { id: value.id, outcome: 'ok', record: value.record!, error: null };
  });
  const structuredContent = { ...original, version: 2, kind: 'page', records } as unknown as Record<string, Json>;
  if (mode === 'invalid-delay') {
    const first = (structuredContent['records'] as Record<string, Json>[])[0]!;
    first['error'] = { code: invalid === 'forbidden-hint' ? 'forbidden' : 'rate_limited', retryable: invalid !== 'forbidden-hint', retryAfterMs };
    if (invalid === 'forbidden-hint') { first['outcome'] = 'error'; first['record'] = null; }
  }
  return { resultType: 'complete', content: [{ type: 'text', text: 'synthetic_wait_collection' }], structuredContent };
}
