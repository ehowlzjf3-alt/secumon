import type { Scalar } from './model.js';
import type { TrustedKnowledgeActor } from './knowledge.js';

export interface BoardActor extends TrustedKnowledgeActor { canManageBoards: boolean }
export interface AgentRole { id: string; principalId: string; purpose: string; active: boolean }
export interface SharedEntity {
  id: string; authority: string; key: string; kind: string; title: string; validFrom: number; validThrough: number | null;
}
export interface BoardCitation {
  workId: string; evidenceId: string; ownerId: string; goalRevision: number; sourceVersion: string;
  lineages: string[]; labels: string[]; observedAt: number; recordedAt: number;
}
export interface BoardPost {
  id: string; authorId: string; workId: string; goalRevision: number; entityId: string;
  kind: 'observation' | 'hypothesis' | 'question' | 'counterevidence' | 'decision';
  body: string; labels: string[]; citations: BoardCitation[]; quotedPostIds: string[];
  replyTo: string | null; relation: 'supports' | 'contradicts' | 'clarifies' | 'duplicates' | null;
  causeId: string; createdAt: number; expiresAt: number | null; status: 'active' | 'retracted'; retractedAt: number | null;
  generation?: number | undefined;
}
export interface BoardRequest {
  id: string; questionId: string; fromAgentId: string; toAgentId: string; fromWorkId: string; fromGoalRevision: number;
  deliverable: string; dueAt: number; status: 'offered' | 'accepted' | 'answered' | 'satisfied' | 'declined' | 'cancelled';
  acceptedWorkId: string | null; acceptedGoalRevision: number | null; answerPostId: string | null;
  waitFor: string[]; createdAt: number; updatedAt: number; closedAt: number | null;
}
export interface BoardState {
  schemaVersion: 1; id: string; tenantId: string; namespace: string; scope: string; ownerId: string;
  revision: number; createdAt: number; updatedAt: number; labels: string[];
  limits: { maxPosts: number; maxReplies: number; maxUnproductiveReplies: number; maxRequests: number };
  roles: AgentRole[]; entities: SharedEntity[]; posts: BoardPost[]; requests: BoardRequest[];
}
export interface BoardPostView extends Omit<BoardPost, 'citations'> {
  citations: (Pick<BoardCitation, 'workId' | 'evidenceId' | 'sourceVersion' | 'observedAt' | 'recordedAt'> &
    { coverage: 'complete' | 'partial' | 'unknown' })[];
  referencedSources: number;
  support: 'question' | 'unverified' | 'cited';
}
export interface BoardView {
  id: string; revision: number; roleId: string; entities: SharedEntity[]; posts: BoardPostView[];
  requests: (BoardRequest & { effectiveStatus: BoardRequest['status'] | 'expired' | 'needs_review' })[];
  findings: { entityId: string; key: string; values: Scalar[]; independentSources: number; conflicted: boolean }[];
}

export interface BoardReadCursor { revision: number; afterPostId: string }
export interface BoardReadQuery {
  boardId: string; workId: string; entityId?: string | undefined; cursor?: BoardReadCursor | undefined;
  maxPosts: number; maxBytes: number;
}
/** A bounded observation of visible discussion, never proof that missing posts or facts do not exist. */
export interface BoardReadPage {
  id: string; revision: number; roleId: string; observedAt: number;
  interpretation: 'discussion_not_independent_evidence';
  visibility: 'permitted_current_posts_only';
  findingsBasis: 'returned_posts_only';
  entities: SharedEntity[]; posts: BoardPostView[]; findings: BoardView['findings'];
  nextCursor: BoardReadCursor | null;
}

export type BoardRequestMetadata = Omit<BoardRequest, 'deliverable' | 'waitFor' | 'createdAt' | 'closedAt'> &
  { effectiveStatus: BoardRequest['status'] | 'expired' | 'needs_review' };
export interface BoardRequestQuery {
  boardId: string; workId: string; requestId?: string | undefined;
  cursor?: { revision: number; afterRequestId: string } | undefined;
  maxRequests: number; maxBytes: number;
}
export interface BoardRequestPage {
  boardId: string; revision: number; roleId: string; observedAt: number;
  interpretation: 'observed_coordination_metadata'; visibility: 'permitted_participant_requests';
  requests: BoardRequestMetadata[]; nextCursor: { revision: number; afterRequestId: string } | null;
}
export interface BoardChange {
  revision: number; at: number; requestIds: string[]; roleIds: string[];
}
export interface BoardChangeQuery { afterRevision: number; maxEvents: number; maxBytes: number }
export interface BoardChangePage { headRevision: number; throughRevision: number; historyAfterRevision: number; resyncRequired: boolean; more: boolean; events: BoardChange[] }

/** Derive a body-free event from the same transition committed by the repository. */
export function boardChange(prior: BoardState | null, next: BoardState): BoardChange {
  const affected = new Set(next.requests.filter(request => JSON.stringify(request) !== JSON.stringify(prior?.requests.find(value => value.id === request.id))).map(value => value.id));
  const posts = new Set(next.posts.filter(post => JSON.stringify(post) !== JSON.stringify(prior?.posts.find(value => value.id === post.id))).map(value => value.id));
  const changedRoles = new Set(next.roles.filter(role => role.active !== prior?.roles.find(value => value.id === role.id)?.active).map(value => value.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const post of next.posts) if (!posts.has(post.id) && [...post.quotedPostIds, ...(post.replyTo ? [post.replyTo] : [])].some(id => posts.has(id))) { posts.add(post.id); changed = true; }
    for (const request of next.requests) if (!affected.has(request.id) && (posts.has(request.questionId) ||
      (request.answerPostId !== null && posts.has(request.answerPostId)) || changedRoles.has(request.fromAgentId) || changedRoles.has(request.toAgentId) ||
      request.waitFor.some(id => affected.has(id)))) { affected.add(request.id); changed = true; }
  }
  return { revision: next.revision, at: next.updatedAt, requestIds: [...affected].sort(),
    roleIds: [...new Set(next.requests.filter(request => affected.has(request.id)).flatMap(request => [request.fromAgentId, request.toAgentId]))].sort() };
}

export function boardRole(board: BoardState, actor: BoardActor): AgentRole | undefined {
  if (board.tenantId !== actor.tenantId || !actor.allowedNamespaces.includes(board.namespace) ||
    !actor.allowedScopes.includes(board.scope) || !board.labels.every(label => actor.allowedLabels.includes(label))) return undefined;
  return board.roles.find(role => role.principalId === actor.principalId && role.active);
}
export function postThread(board: BoardState, post: Pick<BoardPost, 'id' | 'replyTo'>): BoardPost[] {
  const chain: BoardPost[] = []; const seen = new Set<string>([post.id]); let parent = post.replyTo;
  while (parent !== null) {
    if (seen.has(parent)) throw new Error('board_reply_cycle'); seen.add(parent);
    const prior = board.posts.find(value => value.id === parent); if (!prior) throw new Error('board_parent_missing');
    chain.unshift(prior); parent = prior.replyTo;
  }
  return chain;
}
export function boardPostGate(board: BoardState, post: BoardPost): string | null {
  if (board.posts.length >= board.limits.maxPosts) return 'board_post_limit';
  const chain = postThread(board, post);
  if (chain.length > board.limits.maxReplies) return 'board_reply_limit';
  const seen = new Set<string>(); let unproductive = 0;
  for (const value of [...chain, post]) {
    const keys = value.citations.map(citation => `${citation.workId}\u0000${citation.evidenceId}\u0000${citation.sourceVersion}`);
    const novel = keys.some(key => !seen.has(key)); keys.forEach(key => seen.add(key));
    if (value.replyTo !== null) unproductive = novel ? 0 : unproductive + 1;
  }
  return unproductive > board.limits.maxUnproductiveReplies ? 'board_no_progress' : null;
}
export function boardWaitCycle(requests: readonly BoardRequest[]): boolean {
  const waiting = new Map(requests.filter(request => request.status === 'accepted').map(request => [request.id, request.waitFor]));
  const done = new Set<string>(), path = new Set<string>();
  const visit = (id: string): boolean => {
    if (path.has(id)) return true; if (done.has(id)) return false;
    path.add(id); for (const parent of waiting.get(id) ?? []) if (waiting.has(parent) && visit(parent)) return true;
    path.delete(id); done.add(id); return false;
  };
  return [...waiting.keys()].some(visit);
}
