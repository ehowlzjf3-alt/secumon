import { z } from 'zod';
import type { BoardCommit } from './board-ports.js';
import type { BoardRequest, BoardState } from '../domain/board.js';
import { BoardStateSchema } from './board-contracts.js';

const commit = z.strictObject({ expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  commandId: z.string().min(1).max(160), commandDigest: z.string().regex(/^[a-f0-9]{64}$/), next: BoardStateSchema,
  disposition: z.literal('not_applied').optional() });
export function validateBoardCommit(input: BoardCommit): BoardCommit {
  const value = commit.parse(input);
  if (value.next.revision !== value.expectedRevision + 1) throw new Error('board_commit_invalid'); return value;
}
export function validateBoardCommand(prior: BoardState | null, command: BoardCommit) {
  validateBoardTransition(prior, command.next);
  if (command.disposition && (!prior || JSON.stringify({ ...prior, revision: command.next.revision, updatedAt: command.next.updatedAt }) !== JSON.stringify(command.next)))
    throw new Error('board_rejection_must_be_noop');
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
export function validateBoardTransition(prior: BoardState | null, next: BoardState) {
  function invalid(): never { throw new Error('board_transition_invalid'); }
  if (!prior) { if (next.revision !== 1 || next.entities.length || next.posts.length || next.requests.length) invalid(); return; }
  for (const key of ['id', 'tenantId', 'namespace', 'scope', 'ownerId', 'createdAt', 'labels', 'limits'] as const) if (!same(prior[key], next[key])) invalid();
  if (next.revision !== prior.revision + 1 || next.updatedAt < prior.updatedAt || next.roles.length !== prior.roles.length) invalid();
  for (const role of prior.roles) {
    const current = next.roles.find(value => value.id === role.id); if (!current || !same({ ...role, active: current.active }, current)) invalid();
  }
  for (const entity of prior.entities) if (!same(entity, next.entities.find(value => value.id === entity.id))) invalid();
  for (const post of prior.posts) {
    const current = next.posts.find(value => value.id === post.id); if (!current) invalid();
    if (!same({ ...post, status: current.status, retractedAt: current.retractedAt }, current) ||
      (post.status === 'retracted' && !same(post, current))) invalid();
  }
  for (const post of next.posts.filter(value => !prior.posts.some(old => old.id === value.id))) {
    if (post.createdAt !== next.updatedAt || post.status !== 'active' ||
      [...post.quotedPostIds, ...(post.replyTo ? [post.replyTo] : [])].some(id => !prior.posts.some(value => value.id === id))) invalid();
  }
  const transitions: Record<BoardRequest['status'], BoardRequest['status'][]> = { offered: ['accepted', 'declined', 'cancelled'], accepted: ['accepted', 'answered', 'declined', 'cancelled'],
    answered: ['satisfied', 'declined', 'cancelled'], satisfied: [], declined: [], cancelled: [] };
  for (const request of prior.requests) {
    const current = next.requests.find(value => value.id === request.id); if (!current) invalid();
    if (same(request, current)) continue;
    if (!transitions[request.status].includes(current.status)) invalid();
    for (const key of ['id', 'questionId', 'fromAgentId', 'toAgentId', 'fromWorkId', 'fromGoalRevision', 'deliverable', 'dueAt', 'createdAt'] as const)
      if (request[key] !== current[key]) invalid();
    if (request.acceptedWorkId !== null && (request.acceptedWorkId !== current.acceptedWorkId || request.acceptedGoalRevision !== current.acceptedGoalRevision)) invalid();
    if (request.answerPostId !== null && request.answerPostId !== current.answerPostId) invalid();
    if (current.updatedAt !== next.updatedAt) invalid();
  }
  for (const request of next.requests.filter(value => !prior.requests.some(old => old.id === value.id)))
    if (request.status !== 'offered' || request.createdAt !== next.updatedAt || request.acceptedWorkId !== null || request.answerPostId !== null) invalid();
}
