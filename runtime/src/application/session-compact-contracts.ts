import { z } from 'zod';
import type { SessionCompactCandidate, SessionCompactInput, SessionQuote, SessionRetainedItem, SessionSummaryContent,
  SessionSummaryPublication, SessionSummaryRecord, SessionSummaryRef } from '../domain/session-compact.js';
import { AppliedSessionInputSchema, SessionEntrySchema, SessionScopeSchema } from './session-base-contracts.js';

const id = z.string().min(1).max(256);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const SessionQuoteSchema: z.ZodType<SessionQuote> = z.strictObject({ sequence: count.min(1), sourceId: id,
  role: z.enum(['user', 'assistant']), quote: z.string().min(1).max(2048) });
export const SessionRetainedItemSchema: z.ZodType<SessionRetainedItem> = z.strictObject({ id,
  kind: z.enum(['constraint', 'hypothesis', 'counterargument', 'open_question', 'decision', 'outcome', 'reference']),
  text: z.string().min(1).max(2048), status: z.enum(['active', 'contested', 'refuted', 'resolved', 'superseded']),
  citations: z.array(SessionQuoteSchema).min(1).max(16), changedBy: SessionQuoteSchema.optional(),
});
export const SessionSummaryContentSchema: z.ZodType<SessionSummaryContent> = z.strictObject({
  narrative: z.string().min(1).max(32000), retained: z.array(SessionRetainedItemSchema).max(128),
});
const RefShape = { id, revision: count.min(1), throughSequence: count.min(1), digest: hash, policyDigest: hash };
export const SessionSummaryRefSchema: z.ZodType<SessionSummaryRef> = z.strictObject(RefShape);
export const SessionSummaryViewSchema = z.strictObject({ ref: SessionSummaryRefSchema, content: SessionSummaryContentSchema });
export const SessionSourceManifestSchema = z.strictObject({ throughSequence: count.min(1), digest: hash, entries: count.min(1) });
export const SessionCompactInputSchema: z.ZodType<SessionCompactInput> = z.strictObject({
  schemaVersion: z.literal(1), purpose: z.literal('session_compact'), workId: id, basis: AppliedSessionInputSchema,
  policyDigest: hash, inputDigest: hash, expectedHead: SessionSummaryRefSchema.nullable(), previous: SessionSummaryViewSchema.nullable(),
  prefix: SessionSourceManifestSchema, entries: z.array(SessionEntrySchema).min(1).max(256), maxSummaryBytes: count.min(256).max(65536),
  interpretation: z.literal('conversation_history_not_verified_evidence'),
});
export const SessionCompactCandidateSchema: z.ZodType<SessionCompactCandidate> = z.strictObject({ inputDigest: hash, content: SessionSummaryContentSchema });
const RecordShape = { scope: SessionScopeSchema, content: SessionSummaryContentSchema, workId: id, callId: id,
  inputDigest: hash, prefix: SessionSourceManifestSchema, previous: SessionSummaryRefSchema.nullable(), createdAt: count };
export const SessionSummaryRecordSchema: z.ZodType<SessionSummaryRecord> = z.strictObject({ ...RecordShape, ref: SessionSummaryRefSchema });
export const SessionSummaryPublicationSchema: z.ZodType<SessionSummaryPublication> = z.strictObject({ ...RecordShape,
  ref: z.strictObject({ id, throughSequence: count.min(1), digest: hash, policyDigest: hash }),
});
