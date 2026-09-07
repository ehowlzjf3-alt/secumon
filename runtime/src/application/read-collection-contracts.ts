import { z } from 'zod';
import type { ReadCollectionState, ReadDeferral, ReadItem, ReadKey, ReadLimits, ReadPage, ReadRequest, ReadResponse } from '../domain/read-collection.js';
import { ArtifactSchema, EvidenceSchema, JsonSchema, ToolUsageSchema } from './contracts.js';
import { KnowledgeDependencySchema } from './knowledge-contracts.js';

const id = z.string().min(1).max(256);
const cursor = z.string().min(1).max(4096);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const ReadKeySchema: z.ZodType<ReadKey> = z.strictObject({ id, inputDigest: z.string().regex(/^[0-9a-f]{64}$/) });
export const ReadItemSchema: z.ZodType<ReadItem> = z.strictObject({ id, inputDigest: z.string().regex(/^[0-9a-f]{64}$/),
  status: z.enum(['success', 'partial', 'error', 'not_run']), output: JsonSchema,
  evidence: z.array(EvidenceSchema).max(10000), artifacts: z.array(ArtifactSchema).max(10000),
  coverage: z.enum(['complete', 'partial', 'unknown']), error: z.strictObject({ code: id, retryable: z.boolean() }).nullable(),
  retryAt: count.optional(),
}).superRefine((value, ctx) => {
  if (value.status === 'success' && (value.coverage !== 'complete' || value.error !== null))
    ctx.addIssue({ code: 'custom', message: 'read_success_requires_complete' });
  if (value.status !== 'success' && value.coverage === 'complete')
    ctx.addIssue({ code: 'custom', message: 'read_incomplete_status_requires_incomplete_coverage' });
  if (value.status === 'error' && value.error === null)
    ctx.addIssue({ code: 'custom', message: 'read_error_requires_code' });
  if (value.retryAt !== undefined && (value.status === 'success' || value.error?.retryable !== true))
    ctx.addIssue({ code: 'custom', message: 'read_retry_time_requires_retryable_item' });
  if (value.status === 'not_run' && (value.output !== null || value.evidence.length || value.artifacts.length || value.coverage !== 'unknown'))
    ctx.addIssue({ code: 'custom', message: 'read_not_run_has_no_observation' });
});
export const ReadRequestSchema: z.ZodType<ReadRequest> = z.strictObject({ requestId: id, cursor: cursor.nullable(), snapshot: id.nullable(),
  retryItems: z.array(ReadKeySchema).min(1).max(1000).nullable(), itemLimit: count.min(1).max(1000) });
export const ReadPageSchema: z.ZodType<ReadPage> = z.strictObject({ requestId: id, sourceSnapshot: id, cursor: cursor.nullable(),
  nextCursor: cursor.nullable(), exhausted: z.boolean(), totalItems: count.nullable(), expected: z.array(ReadKeySchema).max(1000),
  items: z.array(ReadItemSchema).max(1000), rawArtifact: ArtifactSchema.optional(), usage: ToolUsageSchema.optional(),
  knowledgeDependencies: z.array(KnowledgeDependencySchema).max(50).optional() });
export const ReadDeferralSchema: z.ZodType<ReadDeferral> = z.strictObject({ kind: z.literal('read_deferral'), requestId: id,
  dueAt: count, reason: z.literal('rate_limited'), rawArtifact: ArtifactSchema.optional(), usage: ToolUsageSchema.optional(),
  knowledgeDependencies: z.array(KnowledgeDependencySchema).max(50).optional() });
export const ReadResponseSchema: z.ZodType<ReadResponse> = z.union([ReadPageSchema, ReadDeferralSchema]);
export const ReadLimitsSchema: z.ZodType<ReadLimits> = z.strictObject({ maxPages: count.min(1).max(1000), maxItems: count.min(1).max(10000),
  maxCalls: count.min(1).max(10000), maxPageBytes: count.min(1).max(4 * 1024 * 1024),
  maxCheckpointBytes: count.min(1).max(16 * 1024 * 1024), pageSize: count.min(1).max(1000) });
export const ReadCollectionStateSchema: z.ZodType<ReadCollectionState> = z.strictObject({ kind: z.enum(['batch', 'paged']), snapshot: id.nullable(),
  pages: z.array(ReadPageSchema).max(1000), pending: ReadPageSchema.nullable(), nextCursor: cursor.nullable(), exhausted: z.boolean(),
  totalItems: count.nullable(), seenCursors: z.array(cursor).max(1000), batchExpected: z.array(ReadKeySchema).max(1000).nullable(), calls: count,
  acceptedRequestIds: z.array(id).max(10000) });
