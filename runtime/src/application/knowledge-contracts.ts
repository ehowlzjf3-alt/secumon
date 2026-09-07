import { z } from 'zod';
import { knowledgeSourceKey } from '../domain/knowledge.js';
import type { KnowledgeRecord, TrustedKnowledgeActor } from '../domain/knowledge.js';
import { SessionScopeSchema } from './session-base-contracts.js';

const name = z.string().trim().min(1).max(160);
const names = z.array(name).max(64);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const PersonalMemoryOwnerSchema = z.object({ schemaVersion: z.literal(1), agentId: name, principalId: name }).strict();
export const PersonalMemoryRefSchema = PersonalMemoryOwnerSchema.extend({ tenantId: name, id: name, revision: time.positive() }).strict();
const evidenceStamp = z.object({ type: z.literal('evidence').optional(), workId: name, evidenceId: name, sourceVersion: hash, generation: time,
  workRevision: time.positive(), policyDigest: hash }).strict();
const userStamp = z.object({ type: z.literal('session_user_receipt'), schemaVersion: z.literal(1), workId: name, sourceVersion: hash, generation: time,
  workRevision: time.positive(), policyDigest: hash, session: SessionScopeSchema, messageId: name, sequence: time.positive(), receiptDigest: hash }).strict();
export const KnowledgeDependencySchema = z.object({
  schemaVersion: z.literal(2).optional(), owner: PersonalMemoryOwnerSchema.optional(),
  tenantId: name,
  knowledgeId: name,
  knowledgeRevision: time.positive(),
  actorDigest: hash,
  sources: z.array(z.union([evidenceStamp, userStamp])).min(1).max(64),
  parents: z.array(z.object({ id: name, revision: time.positive() }).strict()).max(256),
}).strict().superRefine((d, ctx) => {
  if (new Set(d.sources.map(knowledgeSourceKey)).size !== d.sources.length ||
    new Set(d.parents.map(p => p.id)).size !== d.parents.length || d.parents.some(p => p.id === d.knowledgeId)) {
    ctx.addIssue({ code: 'custom', message: 'invalid_knowledge_dependency_identity' });
  }
  if (d.owner ? (d.schemaVersion !== 2 || d.parents.length !== 0 || d.sources.some(s => s.type !== 'session_user_receipt' ||
    s.session.agentId !== d.owner!.agentId || s.session.principalId !== d.owner!.principalId || s.session.tenantId !== d.tenantId)) :
    (d.schemaVersion !== undefined || d.sources.some(s => s.type === 'session_user_receipt'))) ctx.addIssue({ code: 'custom', message: 'invalid_personal_memory_owner' });
});
export const KnowledgeKindSchema = z.enum(['experience', 'fact', 'procedure_candidate', 'personal']);
const evidenceSource = z.object({ type: z.literal('evidence').optional(), workId: name, evidenceId: name, ownerId: name, sourceId: name, sourceVersion: name,
  generation: time, observedAt: time, recordedAt: time, coverage: z.enum(['complete', 'partial', 'unknown']), labels: names }).strict();
const userSource = z.object({ type: z.literal('session_user_receipt'), schemaVersion: z.literal(1), workId: name, ownerId: name, sourceId: name, sourceVersion: hash,
  generation: time, observedAt: time, recordedAt: time, coverage: z.literal('unknown'), labels: names,
  session: SessionScopeSchema, messageId: name, sequence: time.positive(), receiptDigest: hash, quote: z.string().max(16384) }).strict();
export const KnowledgeRecordSchema = z.object({ id: name, tenantId: name, namespace: name, scope: name, authorId: name,
  schemaVersion: z.literal(2).optional(), owner: PersonalMemoryOwnerSchema.optional(),
  kind: KnowledgeKindSchema, title: z.string().min(1).max(256), body: z.string().min(0).max(16384), labels: names,
  revision: time.positive(), contentRevision: time.positive(), status: z.enum(['active', 'retracted', 'deleted']),
  visibility: z.enum(['private', 'shared']), reviewState: z.enum(['private', 'submitted', 'reviewed']),
  review: z.object({ reviewerId: name, contentRevision: time.positive(), at: time, reason: z.string().min(1).max(1024) }).strict().nullable(),
  sources: z.array(z.union([evidenceSource, userSource])).min(1).max(64), derivedFrom: z.array(z.object({ id: name, revision: time.positive() }).strict()).max(16),
  createdAt: time, updatedAt: time, expiresAt: time.nullable(),
}).strict().superRefine((r, ctx) => {
  if (r.contentRevision > r.revision || r.updatedAt < r.createdAt || r.sources.some(s => s.observedAt > s.recordedAt) ||
    r.sources.some(s => s.labels.some(l => !r.labels.includes(l))) || new Set(r.derivedFrom.map(p => p.id)).size !== r.derivedFrom.length ||
    r.derivedFrom.some(p => p.id === r.id) || (r.visibility === 'shared' && (r.reviewState !== 'reviewed' || !r.review ||
      r.review.reviewerId === r.authorId || r.review.contentRevision !== r.contentRevision))) ctx.addIssue({ code: 'custom', message: 'invalid_knowledge_invariants' });
  if (r.kind === 'personal' ? (r.schemaVersion !== 2 || !r.owner || r.owner.principalId !== r.authorId || r.scope !== 'personal' || r.namespace !== 'personal' ||
    r.visibility !== 'private' || r.reviewState !== 'private' || r.review !== null || r.derivedFrom.length !== 0 || r.sources.length !== 1 ||
    r.sources.some(s => s.type !== 'session_user_receipt' || s.session.tenantId !== r.tenantId || s.session.agentId !== r.owner!.agentId ||
      s.session.principalId !== r.authorId || s.ownerId !== r.authorId || (r.status === 'active' && (s.quote.length === 0 || s.quote !== r.body)))) :
    (r.owner !== undefined || r.schemaVersion !== undefined || r.sources.some(s => s.type === 'session_user_receipt'))) ctx.addIssue({ code: 'custom', message: 'invalid_personal_memory_record' });
});
export function parseKnowledge(value: unknown): KnowledgeRecord { return KnowledgeRecordSchema.parse(value); }
export function parseKnowledgeActor(value: unknown): TrustedKnowledgeActor {
  const parsed = z.object({ tenantId: name, principalId: name, agentId: name.optional(), allowedDestinations: names.optional(), allowedLabels: names, allowedNamespaces: names, allowedScopes: names,
    canReview: z.boolean(), canPublish: z.boolean() }).strict().parse(value);
  const { allowedDestinations, ...actor } = parsed;
  return { ...actor, ...(allowedDestinations === undefined ? {} : { allowedDestinations }) };
}
export const CreateKnowledgeSchema = z.object({ id: name, commandId: name, namespace: name, scope: name, kind: z.enum(['experience', 'fact', 'procedure_candidate']),
  title: z.string().min(1).max(256), body: z.string().min(1).max(16384), labels: names,
  sources: z.array(z.object({ workId: name, evidenceId: name }).strict()).max(16), derivedFrom: z.array(name).max(16).default([]),
  expiresAt: time.nullable(),
}).strict().refine(r => r.sources.length + r.derivedFrom.length > 0, 'knowledge_source_required');
export const KnowledgeMutationSchema = z.object({ id: name, expectedRevision: time.positive(), commandId: name,
  reason: z.string().min(1).max(1024) }).strict();
export const KnowledgeReviewSchema = KnowledgeMutationSchema.extend({ expectedContentRevision: time.positive() }).strict();
export const ReviseKnowledgeSchema = KnowledgeMutationSchema.extend({ title: z.string().min(1).max(256), body: z.string().min(1).max(16384) }).strict();
export const KnowledgeQuerySchema = z.object({ namespace: name, scope: name, text: z.string().max(128).default(''),
  kinds: z.array(KnowledgeKindSchema).max(4).default([]), observedFrom: time.nullable().default(null), observedThrough: time.nullable().default(null),
  limit: z.number().int().min(1).max(50).default(20),
}).strict().refine(q => q.observedFrom === null || q.observedThrough === null || q.observedFrom <= q.observedThrough, 'knowledge_time_range_invalid');
export type CreateKnowledgeInput = z.input<typeof CreateKnowledgeSchema>;
export type KnowledgeMutationInput = z.input<typeof KnowledgeMutationSchema>;
export type KnowledgeReviewInput = z.input<typeof KnowledgeReviewSchema>;
export type ReviseKnowledgeInput = z.input<typeof ReviseKnowledgeSchema>;
export type KnowledgeQueryInput = z.input<typeof KnowledgeQuerySchema>;

const personalSourceRef = z.object({ sessionId: name, messageId: name, quote: z.string().min(1).max(16384) }).strict();
export const RememberPersonalSchema = z.object({ id: name, commandId: name, source: personalSourceRef,
  title: z.string().min(1).max(256), expiresAt: time.nullable().default(null) }).strict();
export const RevisePersonalSchema = KnowledgeMutationSchema.extend({ source: personalSourceRef, title: z.string().min(1).max(256) }).strict();
export type RememberPersonalInput = z.input<typeof RememberPersonalSchema>;
export type RevisePersonalInput = z.input<typeof RevisePersonalSchema>;
