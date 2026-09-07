import { z } from 'zod';
import type { AppliedSessionInput, SessionEntry, SessionScope, SessionInputBasis } from '../domain/session.js';

const id = z.string().min(1).max(256);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const SessionScopeSchema: z.ZodType<SessionScope> = z.strictObject({ tenantId: id, agentId: id, principalId: id, sessionId: id });
export const SessionInputBasisSchema: z.ZodType<SessionInputBasis> = z.strictObject({ messageId: id, sequence: count.min(1), digest: hash });
export const AppliedSessionInputSchema: z.ZodType<AppliedSessionInput> = z.strictObject({ scope: SessionScopeSchema,
  input: SessionInputBasisSchema });
export const SessionHeadSchema = z.strictObject({ revision: count.min(1), throughSequence: count.min(1), digest: hash, policyDigest: hash });
export const SessionEntrySchema: z.ZodType<SessionEntry> = z.strictObject({ sequence: count.min(1), role: z.enum(['user', 'assistant']), sourceId: id, workId: id,
  text: z.string().max(100000), labels: z.array(id).max(10000), status: z.enum(['received', 'delivered']), kind: id,
  artifact: z.strictObject({ id, sha256: hash, byteLength: count, mediaType: id, tenantId: id, labels: z.array(id).max(10000) }).nullable(),
});
