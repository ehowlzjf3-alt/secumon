import { z } from 'zod';
import type { ModelReply, SessionCompactReply } from './ports.js';
import { PlanProposalSchema } from './contracts.js';
import { SessionCompactCandidateSchema } from './session-compact-contracts.js';

const id = z.string().min(1).max(256);
const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
export const ModelIdentitySchema = z.strictObject({ provider: id, model: id, revision: id });
export const ModelReplySchema: z.ZodType<ModelReply> = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), proposal: PlanProposalSchema, inputTokens: tokens, outputTokens: tokens, provider: id, model: id }),
  z.strictObject({ status: z.enum(['refused', 'truncated', 'invalid', 'error', 'cancelled']), code: id, inputTokens: tokens, outputTokens: tokens }),
]);
export const SessionCompactReplySchema: z.ZodType<SessionCompactReply> = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), candidate: SessionCompactCandidateSchema, inputTokens: tokens, outputTokens: tokens, provider: id, model: id }),
  z.strictObject({ status: z.enum(['refused', 'truncated', 'invalid', 'error', 'cancelled']), code: id, inputTokens: tokens, outputTokens: tokens }),
]);
