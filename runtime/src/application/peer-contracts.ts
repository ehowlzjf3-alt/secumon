import { z } from 'zod';
import { HypothesisSchema } from './contracts.js';
import { ModelIdentitySchema } from './model-contracts.js';

const id = z.string().min(1).max(256), hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const prose = z.string().min(1).max(16000).refine(value => value.trim().length > 0);
export const PeerIdentitySchema = z.strictObject({ agentId: id, revision: id, role: z.enum(['resident', 'temporary']), model: ModelIdentitySchema });
export const PeerRequestSchema = z.strictObject({ schemaVersion: z.literal(1), id, kind: z.enum(['consult', 'review']), text: prose,
  from: z.strictObject({ agentId: id, tenantId: id, principalId: id, workId: id, goalRevision: count.positive(), planRevision: count }),
  policyDigest: hash, generation: count, labels: z.array(id).max(64), deadlineAt: count,
  target: z.strictObject({ version: hash, hypothesis: HypothesisSchema }).nullable(),
}).refine(value => (value.kind === 'review') === (value.target !== null), 'peer_review_target_required');
export const PeerTicketSchema = z.strictObject({ requestId: id, requestDigest: hash, workId: id, sessionId: id, goalRevision: count.positive() });
export const PeerReplySchema = z.strictObject({ ticket: PeerTicketSchema, status: z.enum(['answer', 'waiting', 'rejected']),
  text: z.string().max(32000).nullable(), answerDigest: hash.nullable(), reason: id, labels: z.array(id).max(64),
  model: ModelIdentitySchema, observedAt: count, stateRevision: count.positive(),
}).refine(value => value.status === 'answer' ? !!value.text?.trim() && value.answerDigest !== null : value.text === null && value.answerDigest === null);
/** These are reviewer claims. Evidence references belong to the reviewer and never become caller Evidence IDs. */
export const PeerReviewSchema = z.strictObject({ schemaVersion: z.literal(1), targetVersion: hash,
  target: prose, alternative: prose, basis: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('none'), reason: prose }),
    z.strictObject({ kind: z.literal('references'), references: z.array(z.strictObject({ workId: id, evidenceId: id })).min(1).max(32), caveat: prose }),
  ]), discriminatingQuestions: z.array(prose).min(1).max(12), impact: prose,
});
export type PeerIdentity = z.infer<typeof PeerIdentitySchema>;
export type PeerRequest = z.infer<typeof PeerRequestSchema>;
export type PeerTicket = z.infer<typeof PeerTicketSchema>;
export type PeerReply = z.infer<typeof PeerReplySchema>;
export interface PeerAgent {
  readonly identity: PeerIdentity;
  readonly destination: string;
  readonly allowedLabels: readonly string[];
  request(request: PeerRequest, signal: AbortSignal): Promise<PeerTicket>;
  run(request: PeerRequest, ticket: PeerTicket, signal: AbortSignal): Promise<PeerReply>;
  current(request: PeerRequest, reply: PeerReply): Promise<boolean>;
}
