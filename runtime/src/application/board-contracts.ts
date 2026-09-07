import { z } from 'zod';
import { boardWaitCycle, postThread } from '../domain/board.js';
import type { BoardActor, BoardReadPage, BoardReadQuery, BoardState, BoardRequestPage, BoardRequestQuery } from '../domain/board.js';

const id = z.string().trim().min(1).max(160).refine(value => !value.includes('\u0000'));
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ids = z.array(id).max(64).refine(value => new Set(value).size === value.length);
const labels = ids;
const role = z.strictObject({ id, principalId: id, purpose: z.string().min(1).max(1024), active: z.boolean() });
const entity = z.strictObject({ id, authority: id, key: id, kind: id, title: z.string().min(1).max(256), validFrom: time, validThrough: time.nullable() })
  .refine(value => value.validThrough === null || value.validThrough > value.validFrom);
const citation = z.strictObject({ workId: id, evidenceId: id, ownerId: id, goalRevision: time.positive(),
  sourceVersion: z.string().regex(/^[a-f0-9]{64}$/), lineages: ids.refine(value => value.length > 0), labels,
  observedAt: time, recordedAt: time }).refine(value => value.observedAt <= value.recordedAt);
const post = z.strictObject({ id, authorId: id, workId: id, goalRevision: time.positive(), entityId: id,
  kind: z.enum(['observation', 'hypothesis', 'question', 'counterevidence', 'decision']), body: z.string().min(1).max(8192),
  labels, citations: z.array(citation).max(64), quotedPostIds: ids, replyTo: id.nullable(),
  relation: z.enum(['supports', 'contradicts', 'clarifies', 'duplicates']).nullable(), causeId: id,
  createdAt: time, expiresAt: time.nullable(), status: z.enum(['active', 'retracted']), retractedAt: time.nullable(), generation: time.optional() });
const request = z.strictObject({ id, questionId: id, fromAgentId: id, toAgentId: id, fromWorkId: id, fromGoalRevision: time.positive(),
  deliverable: z.string().min(1).max(1024), dueAt: time, status: z.enum(['offered', 'accepted', 'answered', 'satisfied', 'declined', 'cancelled']),
  acceptedWorkId: id.nullable(), acceptedGoalRevision: time.positive().nullable(), answerPostId: id.nullable(), waitFor: ids,
  createdAt: time, updatedAt: time, closedAt: time.nullable() });
const limits = z.strictObject({ maxPosts: time.min(1).max(512), maxReplies: time.min(1).max(32),
  maxUnproductiveReplies: time.min(1).max(8), maxRequests: time.min(1).max(256) });
export const BoardActorSchema: z.ZodType<BoardActor> = z.strictObject({ tenantId: id, principalId: id,
  allowedLabels: labels, allowedNamespaces: ids, allowedScopes: ids, canReview: z.boolean(), canPublish: z.boolean(), canManageBoards: z.boolean() });
export const BoardStateSchema: z.ZodType<BoardState> = z.strictObject({ schemaVersion: z.literal(1), id, tenantId: id,
  namespace: id, scope: id, ownerId: id, revision: time.positive(), createdAt: time, updatedAt: time, labels, limits,
  roles: z.array(role).min(1).max(64), entities: z.array(entity).max(256), posts: z.array(post).max(512), requests: z.array(request).max(256),
}).superRefine((board, context) => {
  const fail = () => context.addIssue({ code: 'custom', message: 'board_invariant' });
  if (board.updatedAt < board.createdAt || board.posts.length > board.limits.maxPosts || board.requests.length > board.limits.maxRequests) fail();
  for (const values of [board.roles, board.entities, board.posts, board.requests]) if (new Set(values.map(value => value.id)).size !== values.length) fail();
  if (new Set(board.roles.map(value => value.principalId)).size !== board.roles.length) fail();
  if (new Set(board.entities.map(value => JSON.stringify([value.authority, value.key, value.validFrom, value.validThrough]))).size !== board.entities.length) fail();
  for (const value of board.posts) {
    const inherited = [...board.labels, ...value.citations.flatMap(item => item.labels)];
    if (!board.roles.some(member => member.id === value.authorId) || !board.entities.some(item => item.id === value.entityId) ||
      inherited.some(label => !value.labels.includes(label)) || (value.status === 'retracted') !== (value.retractedAt !== null) ||
      (value.expiresAt !== null && value.expiresAt <= value.createdAt) ||
      (!['question', 'hypothesis'].includes(value.kind) && value.citations.length === 0) ||
      value.quotedPostIds.some(parent => parent === value.id || !board.posts.some(item => item.id === parent)) ||
      (value.replyTo === null) !== (value.relation === null)) fail();
    try { postThread(board, value); } catch { fail(); }
  }
  for (const value of board.requests) {
    if (value.fromAgentId === value.toAgentId || ![value.fromAgentId, value.toAgentId].every(member => board.roles.some(item => item.id === member)) ||
      !board.posts.some(item => item.id === value.questionId && item.kind === 'question' && item.authorId === value.fromAgentId) ||
      value.waitFor.some(parent => parent === value.id || !board.requests.some(item => item.id === parent)) ||
      (value.acceptedWorkId === null) !== (value.acceptedGoalRevision === null) || value.dueAt <= value.createdAt || value.updatedAt < value.createdAt ||
      (['accepted', 'answered', 'satisfied'].includes(value.status) && value.acceptedWorkId === null) ||
      (['answered', 'satisfied'].includes(value.status) && !board.posts.some(item => item.id === value.answerPostId && item.authorId === value.toAgentId)) ||
      (['satisfied', 'declined', 'cancelled'].includes(value.status) !== (value.closedAt !== null))) fail();
  }
  if (boardWaitCycle(board.requests)) fail();
});
export const CreateBoardSchema = z.strictObject({ id, commandId: id, namespace: id, scope: id, labels, roles: z.array(role).min(1).max(64), limits });
const mutation = z.strictObject({ boardId: id, expectedRevision: time.positive(), commandId: id });
export const AddBoardEntitySchema = mutation.extend({ entity });
export const SetBoardRoleSchema = mutation.extend({ agentId: id, active: z.boolean() });
export const PublishBoardSchema = mutation.extend({ id, workId: id, entityId: id, kind: post.shape.kind, body: post.shape.body, labels,
  sources: z.array(z.strictObject({ workId: id, evidenceId: id })).max(16), quotedPostIds: ids.default([]),
  replyTo: id.nullable(), relation: post.shape.relation, causeId: id, expiresAt: time.nullable() });
export const RetractBoardSchema = mutation.extend({ postId: id });
export const OfferBoardRequestSchema = mutation.extend({ id, questionId: id, toAgentId: id, deliverable: request.shape.deliverable, dueAt: time });
export const ChangeBoardRequestSchema = mutation.extend({ requestId: id,
  action: z.enum(['accept', 'wait', 'answer', 'confirm', 'decline', 'cancel']), workId: id.optional(), postId: id.optional(), waitFor: ids.optional() });
const requestCursor = z.strictObject({ revision: time.positive(), afterRequestId: id });
export const BoardRequestQuerySchema: z.ZodType<BoardRequestQuery> = z.strictObject({ boardId: id, workId: id, requestId: id.optional(),
  cursor: requestCursor.optional(), maxRequests: time.min(1).max(20), maxBytes: time.min(1024).max(32768) });
export const BoardRequestPageSchema: z.ZodType<BoardRequestPage> = z.strictObject({ boardId: id, revision: time.positive(), roleId: id, observedAt: time,
  interpretation: z.literal('observed_coordination_metadata'), visibility: z.literal('permitted_participant_requests'),
  requests: z.array(request.omit({ deliverable: true, waitFor: true, createdAt: true, closedAt: true }).extend({
    effectiveStatus: z.enum(['offered', 'accepted', 'answered', 'satisfied', 'declined', 'cancelled', 'expired', 'needs_review']) })).max(20), nextCursor: requestCursor.nullable() });
export const BoardReadQuerySchema: z.ZodType<BoardReadQuery> = z.strictObject({ boardId: id, workId: id, entityId: id.optional(),
  cursor: z.strictObject({ revision: time.positive(), afterPostId: id }).optional(),
  maxPosts: time.min(1).max(20), maxBytes: time.min(1024).max(32768) });
export const BoardReadPageSchema: z.ZodType<BoardReadPage> = z.strictObject({ id, revision: time.positive(), roleId: id, observedAt: time,
  interpretation: z.literal('discussion_not_independent_evidence'), visibility: z.literal('permitted_current_posts_only'),
  findingsBasis: z.literal('returned_posts_only'), entities: z.array(entity).max(20),
  posts: z.array(post.extend({ citations: z.array(z.strictObject({ workId: id, evidenceId: id, sourceVersion: citation.shape.sourceVersion,
    observedAt: time, recordedAt: time, coverage: z.enum(['complete', 'partial', 'unknown']) })).max(64),
    referencedSources: time, support: z.enum(['question', 'unverified', 'cited']) })).max(20),
  findings: z.array(z.strictObject({ entityId: id, key: z.string(), values: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
    independentSources: time, conflicted: z.boolean() })), nextCursor: z.strictObject({ revision: time.positive(), afterPostId: id }).nullable() });
export type CreateBoardInput = z.input<typeof CreateBoardSchema>;
export type PublishBoardInput = z.input<typeof PublishBoardSchema>;
export type ChangeBoardRequestInput = z.input<typeof ChangeBoardRequestSchema>;
export type AddBoardEntityInput = z.input<typeof AddBoardEntitySchema>;
export type SetBoardRoleInput = z.input<typeof SetBoardRoleSchema>;
export type RetractBoardInput = z.input<typeof RetractBoardSchema>;
export type OfferBoardRequestInput = z.input<typeof OfferBoardRequestSchema>;
