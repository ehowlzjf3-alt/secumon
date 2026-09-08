import { accessibleEvidence } from '../domain/completion.js';
import { dataGeneration, visibleArtifact } from '../domain/data-lifecycle.js';
import { allowsDisclosure, disclosureLabels } from '../domain/disclosure.js';
import { boardPostGate, boardRole, boardWaitCycle } from '../domain/board.js';
import type { BoardActor, BoardCitation, BoardPost, BoardReadPage, BoardReadQuery, BoardRequest, BoardState, BoardView, BoardRequestPage, BoardRequestQuery } from '../domain/board.js';
import type { Evidence, Scalar, WorkState } from '../domain/model.js';
import type { BoardActorProvider, BoardRepository } from './board-ports.js';
import type { BoardWorkSource, BoardWorkSources } from './board-work-sources.js';
import { AddBoardEntitySchema, BoardActorSchema, BoardReadPageSchema, BoardReadQuerySchema, BoardStateSchema, ChangeBoardRequestSchema, CreateBoardSchema,
  OfferBoardRequestSchema, PublishBoardSchema, RetractBoardSchema, SetBoardRoleSchema, BoardRequestQuerySchema } from './board-contracts.js';
import type { AddBoardEntityInput, ChangeBoardRequestInput, CreateBoardInput, OfferBoardRequestInput, PublishBoardInput, RetractBoardInput, SetBoardRoleInput } from './board-contracts.js';
import type { RuntimeServices } from './services.js';
import { dataProofsCurrent as completionProofsCurrent } from './completion-proofs.js';
import { knowledgeInputsCurrent } from './knowledge-validity.js';
import { asJson } from './plan-validator.js';
import type { SourceInputInspection } from './source-input-inspection.js';

type Services = Pick<RuntimeServices, 'state' | 'artifacts' | 'clock' | 'digester' | 'effects' | 'readCoverage' | 'knowledge' | 'inputs'>;
type Dependencies = { repository: BoardRepository; actors: BoardActorProvider; services: Services;
  workSources?: BoardWorkSources | undefined;
  authorize?: (() => Promise<void>) | undefined };
type CheckedSource = { citation: BoardCitation; evidence: Evidence };
type CheckedPost = { post: BoardPost; evidence: CheckedSource[] };
type Snapshot = { actor: BoardActor; board: BoardState; works: Map<string, WorkState>; expiresAt: number | null;
  workSources: Map<string, BoardWorkSource>;
  sources: Map<string, CheckedSource>; posts: Map<string, CheckedPost>; proofs: Set<string>; collectInputs: boolean };
function unavailable(): never { throw new Error('board_unavailable'); }
const unique = (values: string[]) => [...new Set(values)].sort();
const pending = (request: Pick<BoardRequest, 'status'>) => ['offered', 'accepted', 'answered'].includes(request.status);

function postView({ post, evidence }: CheckedPost): BoardView['posts'][number] {
  return { ...post, citations: post.citations.map(({ workId, evidenceId, sourceVersion, observedAt, recordedAt }) => {
    const source = evidence.find(value => value.citation.workId === workId && value.citation.evidenceId === evidenceId);
    if (!source) unavailable();
    return { workId, evidenceId, sourceVersion, observedAt, recordedAt, coverage: source.evidence.coverage };
  }), referencedSources: new Set(post.citations.flatMap(citation => citation.lineages)).size,
  support: post.kind === 'question' ? 'question' : post.citations.length ? 'cited' : 'unverified' };
}
function findings(posts: CheckedPost[]): BoardView['findings'] {
  const fields = new Map<string, { entityId: string; key: string; values: Map<string, Scalar>; lineages: Set<string> }>();
  for (const { post, evidence } of posts) for (const { evidence: item, citation } of evidence) for (const [key, fact] of Object.entries(item.facts)) {
    const index = JSON.stringify([post.entityId, key]), row = fields.get(index) ?? { entityId: post.entityId, key, values: new Map(), lineages: new Set() };
    row.values.set(JSON.stringify(fact), fact);
    if (item.derivedFrom.length === 0) citation.lineages.forEach(lineage => row.lineages.add(lineage)); fields.set(index, row);
  }
  return [...fields.values()].map(row => ({ entityId: row.entityId, key: row.key, values: [...row.values.values()],
    independentSources: row.lineages.size, conflicted: row.values.size > 1 }));
}

export class BoardService {
  constructor(private readonly dependencies: Dependencies) {}
  #digest(value: unknown) { return this.dependencies.services.digester.digest(asJson(value)); }
  #now() { return this.dependencies.services.clock.now(); }
  async #actor() { return BoardActorSchema.parse(await this.dependencies.actors.current()); }
  #place(board: BoardState, actor: BoardActor) {
    if (board.tenantId !== actor.tenantId || !actor.allowedNamespaces.includes(board.namespace) ||
      !actor.allowedScopes.includes(board.scope) || !board.labels.every(label => actor.allowedLabels.includes(label))) unavailable();
  }
  async #snapshot(id: string, manage = false, collectInputs = false): Promise<Snapshot> {
    const actor = await this.#actor(); const raw = await this.dependencies.repository.get(actor.tenantId, id);
    if (!raw) unavailable(); const board = BoardStateSchema.parse(raw); this.#place(board, actor);
    if (manage ? !actor.canManageBoards || board.ownerId !== actor.principalId : !boardRole(board, actor)) unavailable();
    return { actor, board, works: new Map(), workSources: new Map(), expiresAt: null, sources: new Map(), posts: new Map(), proofs: new Set(), collectInputs };
  }
  async #guard(snapshot: Snapshot) {
    for (const [id, work] of snapshot.works) {
      const source = snapshot.workSources.get(id);
      const latest = await (source?.inputs.state ?? this.dependencies.services.state).get(id);
      if (!latest || latest.revision !== work.revision || source && this.#digest(latest) !== this.#digest(work)) throw new Error('board_contention');
      if (source && !snapshot.collectInputs && snapshot.proofs.has(id) && !(await source.current(latest))) unavailable();
    }
    if ((await this.dependencies.repository.get(snapshot.actor.tenantId, snapshot.board.id))?.revision !== snapshot.board.revision) throw new Error('board_revision_conflict');
    if (this.#digest(await this.#actor()) !== this.#digest(snapshot.actor)) unavailable();
    if (snapshot.expiresAt !== null && snapshot.expiresAt <= this.#now()) throw new Error('board_contention');
  }
  async #work(snapshot: Snapshot, id: string, ownerId?: string): Promise<WorkState> {
    const prior = snapshot.works.get(id);
    if (prior) { if (ownerId === undefined && snapshot.workSources.has(id) || ownerId !== undefined && prior.policy.principalId !== ownerId) unavailable(); return prior; }
    let state = await this.dependencies.services.state.get(id), source: BoardWorkSource | null = null;
    // A shared physical store does not make another owner's readers/proofs local.
    // Prefer the explicitly registered owner even when its row exists here.
    if (ownerId !== undefined && this.dependencies.workSources &&
      (!state || ownerId !== snapshot.actor.principalId || state.policy.principalId !== ownerId)) {
      source = await this.dependencies.workSources.resolve({ tenantId: snapshot.actor.tenantId, principalId: ownerId, workId: id });
      state = source ? await source.inputs.state.get(id) : null;
    }
    if (!state || state.id !== id || state.policy.tenantId !== snapshot.actor.tenantId ||
      ownerId !== undefined && state.policy.principalId !== ownerId || !snapshot.actor.allowedScopes.includes(state.goal.scope)) unavailable();
    if (source) snapshot.workSources.set(id, source);
    snapshot.works.set(id, state); return state;
  }
  #roleOwner(snapshot: Snapshot, roleId: string) {
    const role = snapshot.board.roles.find(value => value.id === roleId); if (!role) unavailable(); return role.principalId;
  }
  async #ownedWork(snapshot: Snapshot, id: string) {
    const state = await this.#work(snapshot, id);
    if (state.policy.principalId !== snapshot.actor.principalId || ['paused', 'cancelled', 'failed'].includes(state.status) ||
      !state.policy.allowedDestinations.includes('local')) unavailable();
    return state;
  }
  async #workProof(snapshot: Snapshot, state: WorkState) {
    if (snapshot.collectInputs) return;
    if (snapshot.proofs.has(state.id)) return;
    const source = snapshot.workSources.get(state.id);
    if (source) {
      if (!(await source.current(state))) unavailable(); snapshot.proofs.add(state.id); return;
    }
    const services = this.dependencies.services;
    if (services.inputs ? !(await services.inputs.current(state)) :
      !(await completionProofsCurrent(services, state)) || !(await knowledgeInputsCurrent(services, state))) unavailable();
    snapshot.proofs.add(state.id);
  }
  async #source(snapshot: Snapshot, workId: string, evidenceId: string, ownerId: string): Promise<{ citation: BoardCitation; evidence: Evidence }> {
    const key = JSON.stringify([workId, evidenceId]), cached = snapshot.sources.get(key);
    if (cached) { if (cached.citation.ownerId !== ownerId) unavailable(); return cached; }
    const state = await this.#work(snapshot, workId, ownerId);
    const artifacts = snapshot.workSources.get(workId)?.artifacts ?? this.dependencies.services.artifacts;
    await this.#workProof(snapshot, state);
    const candidates = accessibleEvidence(state.evidence, state.policy, state.goal.scope);
    const evidence = candidates.find(value => value.id === evidenceId); if (!evidence) unavailable();
    const ancestors = new Map<string, Evidence>(), visiting = new Set<string>();
    const visit = (value: Evidence) => {
      if (visiting.has(value.id) || ancestors.size >= 64) unavailable(); if (ancestors.has(value.id)) return;
      visiting.add(value.id);
      for (const id of value.derivedFrom) { const parent = candidates.find(item => item.id === id); if (!parent) unavailable(); visit(parent); }
      visiting.delete(value.id); ancestors.set(value.id, value);
    };
    visit(evidence);
    const ordered = [...ancestors.values()].sort((a, b) => a.id.localeCompare(b.id));
    const labels = unique(ordered.flatMap(value => [...value.labels, ...(value.artifact?.labels ?? [])]));
    if (!labels.every(label => snapshot.actor.allowedLabels.includes(label) && state.policy.allowedLabels.includes(label))) unavailable();
    for (const value of ordered) if (value.artifact) {
      if (!visibleArtifact(state, value.artifact)) unavailable();
      const bytes = await artifacts.get(value.artifact, state.policy); if (bytes.byteLength !== value.artifact.byteLength) unavailable();
    }
    const checked = { evidence, citation: { workId, evidenceId, ownerId: state.policy.principalId, goalRevision: state.goal.revision,
      sourceVersion: this.#digest({ evidence: ordered, generation: state.dataLifecycle?.generation ?? 0 }),
      lineages: unique(ordered.filter(value => value.derivedFrom.length === 0).map(value => value.lineageId)), labels,
      observedAt: evidence.observedAt, recordedAt: evidence.recordedAt } };
    snapshot.sources.set(key, checked); return checked;
  }
  async #post(snapshot: Snapshot, id: string, path = new Set<string>()): Promise<CheckedPost> {
    if (path.has(id) || path.size >= 64) unavailable(); path.add(id);
    const cached = snapshot.posts.get(id); if (cached) return cached;
    const post = snapshot.board.posts.find(value => value.id === id);
    if (!post || post.status !== 'active' || (post.expiresAt !== null && post.expiresAt <= this.#now()) ||
      !post.labels.every(label => snapshot.actor.allowedLabels.includes(label))) unavailable();
    if (post.expiresAt !== null) snapshot.expiresAt = Math.min(snapshot.expiresAt ?? post.expiresAt, post.expiresAt);
    const role = snapshot.board.roles.find(value => value.id === post.authorId && value.active); if (!role) unavailable();
    const state = await this.#work(snapshot, post.workId, role.principalId);
    if (state.policy.principalId !== role.principalId || state.goal.revision !== post.goalRevision ||
      dataGeneration(state) !== (post.generation ?? 0) ||
      !allowsDisclosure(state.policy, 'local', 'a2a', post.labels)) unavailable();
    await this.#workProof(snapshot, state);
    for (const parent of unique([...post.quotedPostIds, ...(post.replyTo ? [post.replyTo] : [])])) await this.#post(snapshot, parent, new Set(path));
    const evidence: { evidence: Evidence; citation: BoardCitation }[] = [];
    for (const expected of post.citations) {
      const current = await this.#source(snapshot, expected.workId, expected.evidenceId, expected.ownerId);
      if (this.#digest(current.citation) !== this.#digest(expected)) unavailable(); evidence.push(current);
    }
    const checked = { post, evidence }; snapshot.posts.set(id, checked); return checked;
  }
  async #mutate(args: { boardId: string; expectedRevision: number; commandId: string }, action: string, data: unknown,
    edit: (next: BoardState, snapshot: Snapshot) => void | Promise<void>, manage = false) {
    const snapshot = await this.#snapshot(args.boardId, manage), actor = snapshot.actor;
    const digest = this.#digest({ action, actorId: actor.principalId, data });
    const receipt = await this.dependencies.repository.receipt(actor.tenantId, args.boardId, args.commandId);
    if (receipt) {
      if (receipt.digest !== digest) throw new Error('board_command_conflict'); await this.#guard(snapshot);
      if (receipt.disposition) throw new Error('board_command_closed');
      return { revision: receipt.revision, duplicate: true };
    }
    if (snapshot.board.revision !== args.expectedRevision) throw new Error('board_revision_conflict');
    const next = structuredClone(snapshot.board); next.updatedAt = this.#now();
    await edit(next, snapshot); await this.#guard(snapshot); next.revision++;
    await this.dependencies.authorize?.(); await this.#guard(snapshot);
    const result = await this.dependencies.repository.commit({ expectedRevision: args.expectedRevision, commandId: args.commandId,
      commandDigest: digest, next: BoardStateSchema.parse(next) });
    if (result.kind === 'conflict') throw new Error('board_revision_conflict');
    if (result.kind === 'idempotency_conflict') throw new Error('board_command_conflict');
    if (result.kind === 'not_applied') throw new Error('board_command_closed');
    return { revision: result.revision, duplicate: result.kind === 'duplicate' };
  }
  async #satisfiedDependencies(snapshot: Snapshot, request: BoardRequest, visited = new Set<string>()): Promise<void> {
    if (visited.has(request.id) || visited.size >= 64) unavailable(); visited.add(request.id);
    for (const id of request.waitFor) {
      const dependency = snapshot.board.requests.find(value => value.id === id);
      if (!dependency || dependency.status !== 'satisfied' || !dependency.answerPostId) unavailable();
      await this.#post(snapshot, dependency.questionId); await this.#post(snapshot, dependency.answerPostId);
      for (const [workId, roleId] of [[dependency.fromWorkId, dependency.fromAgentId], [dependency.acceptedWorkId, dependency.toAgentId]]) {
        if (!workId || !roleId) unavailable(); const work = await this.#work(snapshot, workId, this.#roleOwner(snapshot, roleId));
        if (['paused', 'cancelled', 'failed'].includes(work.status)) unavailable();
      }
      await this.#satisfiedDependencies(snapshot, dependency, new Set(visited));
    }
  }
  async create(input: CreateBoardInput) {
    const args = CreateBoardSchema.parse(input), actor = await this.#actor(), now = this.#now();
    if (!actor.canManageBoards) unavailable();
    const { commandId: _commandId, ...definition } = args;
    const state: BoardState = { schemaVersion: 1, ...definition, tenantId: actor.tenantId, ownerId: actor.principalId,
      revision: 1, createdAt: now, updatedAt: now, entities: [], posts: [], requests: [] };
    this.#place(state, actor); const digest = this.#digest({ action: 'create', actorId: actor.principalId, args });
    if (this.#digest(await this.#actor()) !== this.#digest(actor)) unavailable();
    const result = await this.dependencies.repository.commit({ next: BoardStateSchema.parse(state), expectedRevision: 0, commandId: args.commandId, commandDigest: digest });
    if (result.kind === 'conflict') throw new Error('board_revision_conflict');
    if (result.kind === 'idempotency_conflict') throw new Error('board_command_conflict');
    if (result.kind === 'not_applied') throw new Error('board_command_closed');
    return { revision: result.revision, duplicate: result.kind === 'duplicate' };
  }
  addEntity(input: AddBoardEntityInput) {
    const args = AddBoardEntitySchema.parse(input);
    return this.#mutate(args, 'entity', args, next => { next.entities.push(args.entity); }, true);
  }
  setRole(input: SetBoardRoleInput) {
    const args = SetBoardRoleSchema.parse(input);
    return this.#mutate(args, 'role', args, next => {
      const role = next.roles.find(value => value.id === args.agentId); if (!role) unavailable(); role.active = args.active;
    }, true);
  }
  publish(input: PublishBoardInput) {
    const args = PublishBoardSchema.parse(input);
    return this.#mutate(args, 'publish', args, async (next, snapshot) => {
      if (!snapshot.actor.canPublish) unavailable(); const work = await this.#ownedWork(snapshot, args.workId);
      await this.#workProof(snapshot, work);
      const role = boardRole(next, snapshot.actor)!;
      if (next.posts.some(post => post.authorId === role.id && post.causeId === args.causeId)) throw new Error('board_cause_duplicate');
      const entity = next.entities.find(value => value.id === args.entityId); if (!entity) unavailable();
      const citations: BoardCitation[] = []; const inheritedLabels: string[] = [];
      for (const reference of args.sources) {
        const sourceWork = await this.#ownedWork(snapshot, reference.workId);
        if (sourceWork.id !== work.id) unavailable();
        citations.push((await this.#source(snapshot, reference.workId, reference.evidenceId, snapshot.actor.principalId)).citation);
      }
      for (const parent of unique([...args.quotedPostIds, ...(args.replyTo ? [args.replyTo] : [])])) {
        const read = await this.#post(snapshot, parent); if (read.post.entityId !== args.entityId) unavailable();
        inheritedLabels.push(...read.post.labels); if (args.quotedPostIds.includes(parent)) citations.push(...read.post.citations);
      }
      const uniqueCitations = [...new Map(citations.map(value => [`${value.workId}\u0000${value.evidenceId}`, value])).values()];
      if (uniqueCitations.some(value => value.observedAt < entity.validFrom || (entity.validThrough !== null && value.observedAt >= entity.validThrough))) unavailable();
      const labels = unique([...next.labels, ...disclosureLabels(work), ...args.labels, ...inheritedLabels, ...uniqueCitations.flatMap(value => value.labels)]);
      if (!labels.every(label => snapshot.actor.allowedLabels.includes(label)) || !allowsDisclosure(work.policy, 'local', 'a2a', labels)) unavailable();
      const post: BoardPost = { id: args.id, authorId: role.id, workId: work.id, goalRevision: work.goal.revision, generation: dataGeneration(work),
        entityId: args.entityId, kind: args.kind, body: args.body, labels, citations: uniqueCitations, quotedPostIds: args.quotedPostIds,
        replyTo: args.replyTo, relation: args.relation, causeId: args.causeId, createdAt: next.updatedAt, expiresAt: args.expiresAt, status: 'active', retractedAt: null };
      if (post.expiresAt !== null) snapshot.expiresAt = Math.min(snapshot.expiresAt ?? post.expiresAt, post.expiresAt);
      const reason = boardPostGate(next, post); if (reason) throw new Error(reason); next.posts.push(post);
    });
  }
  retract(input: RetractBoardInput) {
    const args = RetractBoardSchema.parse(input);
    return this.#mutate(args, 'retract', args, (next, snapshot) => {
      const post = next.posts.find(value => value.id === args.postId);
      if (!post || post.authorId !== boardRole(next, snapshot.actor)!.id || post.status !== 'active') unavailable();
      post.status = 'retracted'; post.retractedAt = next.updatedAt;
    });
  }
  offer(input: OfferBoardRequestInput) {
    const args = OfferBoardRequestSchema.parse(input);
    return this.#mutate(args, 'offer', args, async (next, snapshot) => {
      if (!snapshot.actor.canPublish) unavailable();
      const { post } = await this.#post(snapshot, args.questionId), role = boardRole(next, snapshot.actor)!;
      const work = await this.#ownedWork(snapshot, post.workId);
      if (post.authorId !== role.id || post.kind !== 'question' || work.status === 'completed' || args.dueAt <= this.#now() ||
        args.dueAt > work.deadlineAt || args.toAgentId === role.id || !next.roles.some(value => value.id === args.toAgentId && value.active) ||
        !disclosureLabels(work).every(label => post.labels.includes(label))) unavailable();
      if (next.requests.length >= next.limits.maxRequests) throw new Error('board_request_limit');
      snapshot.expiresAt = Math.min(snapshot.expiresAt ?? args.dueAt, args.dueAt);
      next.requests.push({ id: args.id, questionId: args.questionId, fromAgentId: role.id, toAgentId: args.toAgentId,
        fromWorkId: work.id, fromGoalRevision: work.goal.revision, deliverable: args.deliverable, dueAt: args.dueAt, status: 'offered',
        acceptedWorkId: null, acceptedGoalRevision: null, answerPostId: null, waitFor: [], createdAt: next.updatedAt, updatedAt: next.updatedAt, closedAt: null });
    });
  }
  changeRequest(input: ChangeBoardRequestInput) {
    const args = ChangeBoardRequestSchema.parse(input);
    return this.#mutate(args, 'request', args, async (next, snapshot) => {
      const request = next.requests.find(value => value.id === args.requestId), role = boardRole(next, snapshot.actor)!;
      if (!request || !pending(request)) unavailable();
      const requester = await this.#work(snapshot, request.fromWorkId, this.#roleOwner(snapshot, request.fromAgentId));
      if (args.action === 'cancel' || args.action === 'decline') {
        if (!snapshot.actor.canPublish || role.id !== (args.action === 'cancel' ? request.fromAgentId : request.toAgentId)) unavailable();
        request.status = args.action === 'cancel' ? 'cancelled' : 'declined'; request.closedAt = next.updatedAt;
      } else {
        if (!snapshot.actor.canPublish) unavailable(); snapshot.expiresAt = Math.min(snapshot.expiresAt ?? request.dueAt, request.dueAt);
        if (this.#now() >= request.dueAt || requester.goal.revision !== request.fromGoalRevision ||
          ['paused', 'cancelled', 'failed', 'completed'].includes(requester.status)) unavailable();
        await this.#post(snapshot, request.questionId);
        if (request.acceptedWorkId) {
          const assignee = await this.#work(snapshot, request.acceptedWorkId, this.#roleOwner(snapshot, request.toAgentId));
          if (assignee.goal.revision !== request.acceptedGoalRevision || ['paused', 'cancelled', 'failed'].includes(assignee.status)) unavailable();
        }
        if (args.action === 'confirm') {
          if (role.id !== request.fromAgentId || request.status !== 'answered' || !request.answerPostId) unavailable();
          await this.#satisfiedDependencies(snapshot, request);
          await this.#post(snapshot, request.answerPostId); request.status = 'satisfied'; request.closedAt = next.updatedAt;
        } else {
          if (role.id !== request.toAgentId) unavailable();
          if (args.action === 'accept') {
            if (request.status !== 'offered' || !args.workId) unavailable(); const work = await this.#ownedWork(snapshot, args.workId);
            if (work.status === 'completed' || work.deadlineAt < request.dueAt) unavailable();
            request.acceptedWorkId = work.id; request.acceptedGoalRevision = work.goal.revision; request.status = 'accepted';
          } else {
            if (request.status !== 'accepted' || !request.acceptedWorkId) unavailable();
            const work = await this.#ownedWork(snapshot, request.acceptedWorkId);
            if (work.goal.revision !== request.acceptedGoalRevision || work.status === 'completed') unavailable();
            if (args.action === 'wait') {
              if (!args.waitFor || args.waitFor.some(id => !next.requests.some(value => value.id === id && value.status === 'accepted' && value.dueAt <= request.dueAt))) unavailable();
              request.waitFor = args.waitFor; if (boardWaitCycle(next.requests)) throw new Error('board_wait_cycle');
            } else {
              await this.#satisfiedDependencies(snapshot, request);
              if (!args.postId) unavailable(); const { post } = await this.#post(snapshot, args.postId);
              if (post.authorId !== role.id || post.workId !== work.id || post.replyTo !== request.questionId || post.citations.length === 0) unavailable();
              request.answerPostId = post.id; request.status = 'answered';
            }
          }
        }
      }
      request.updatedAt = next.updatedAt;
    });
  }
  /** Control metadata for one participating work; this does not disclose the question or answer body. */
  async requestStatus(boardId: string, requestId: string, workId: string) {
    const snapshot = await this.#snapshot(boardId), work = await this.#work(snapshot, workId);
    const role = boardRole(snapshot.board, snapshot.actor)!;
    const request = snapshot.board.requests.find(value => value.id === requestId);
    if (!request || work.policy.principalId !== snapshot.actor.principalId ||
      !snapshot.board.labels.every(label => work.policy.allowedLabels.includes(label)) ||
      !((request.fromWorkId === workId && request.fromAgentId === role.id) ||
        (request.acceptedWorkId === workId && request.toAgentId === role.id))) unavailable();
    const status = await this.#requestEffectiveStatus(snapshot, request);
    await this.#guard(snapshot);
    return { status, dueAt: request.dueAt, fromWorkId: request.fromWorkId, fromGoalRevision: request.fromGoalRevision,
      acceptedWorkId: request.acceptedWorkId, acceptedGoalRevision: request.acceptedGoalRevision };
  }
  async #requestEffectiveStatus(snapshot: Snapshot, request: BoardRequest) {
    let status: BoardView['requests'][number]['effectiveStatus'] = request.status;
    if (!['cancelled', 'declined'].includes(status)) {
      try {
        const requester = await this.#work(snapshot, request.fromWorkId, this.#roleOwner(snapshot, request.fromAgentId));
        const assignee = request.acceptedWorkId ? await this.#work(snapshot, request.acceptedWorkId, this.#roleOwner(snapshot, request.toAgentId)) : null;
        if (requester.goal.revision !== request.fromGoalRevision || ['paused', 'cancelled', 'failed'].includes(requester.status) ||
          (assignee && (assignee.goal.revision !== request.acceptedGoalRevision || ['paused', 'cancelled', 'failed'].includes(assignee.status))) ||
          !snapshot.board.roles.some(value => value.id === request.fromAgentId && value.active) ||
          !snapshot.board.roles.some(value => value.id === request.toAgentId && value.active)) unavailable();
        await this.#post(snapshot, request.questionId);
        if (['answered', 'satisfied'].includes(status)) {
          if (!request.answerPostId) unavailable();
          await this.#post(snapshot, request.answerPostId); await this.#satisfiedDependencies(snapshot, request);
        }
        if (pending(request) && request.dueAt <= this.#now()) status = 'expired';
      } catch { status = 'needs_review'; }
    }
    return status;
  }
  async #requestVisible(snapshot: Snapshot, reader: WorkState, request: BoardRequest) {
    const role = boardRole(snapshot.board, snapshot.actor)!;
    if (![request.fromAgentId, request.toAgentId].includes(role.id)) return false;
    const question = snapshot.board.posts.find(post => post.id === request.questionId);
    if (!question) return false;
    const requester = await this.#work(snapshot, request.fromWorkId, this.#roleOwner(snapshot, request.fromAgentId));
    const assignee = request.acceptedWorkId ? await this.#work(snapshot, request.acceptedWorkId, this.#roleOwner(snapshot, request.toAgentId)) : null;
    // Coordination metadata inherits the shared board/question classification, not the reader capabilities of either worker.
    const labels = unique([...snapshot.board.labels, ...question.labels]);
    return labels.every(label => snapshot.actor.allowedLabels.includes(label) && reader.policy.allowedLabels.includes(label)) &&
      allowsDisclosure(requester.policy, 'local', 'a2a', labels) && (!assignee || allowsDisclosure(assignee.policy, 'local', 'a2a', labels));
  }
  /** Current permission for historical metadata, independent of subsequent normal lifecycle advancement. */
  async requestMetadataPermitted(boardId: string, workId: string, requestIds: string[]): Promise<boolean> {
    try {
      const snapshot = await this.#snapshot(boardId), reader = await this.#work(snapshot, workId);
      if (reader.policy.principalId !== snapshot.actor.principalId || !reader.policy.allowedDestinations.includes('local') ||
        !snapshot.board.labels.every(label => reader.policy.allowedLabels.includes(label))) return false;
      for (const id of requestIds) {
        const request = snapshot.board.requests.find(value => value.id === id);
        if (!request || !(await this.#requestVisible(snapshot, reader, request))) return false;
      }
      await this.#guard(snapshot); return true;
    } catch { return false; }
  }
  async requestPage(input: BoardRequestQuery): Promise<BoardRequestPage> {
    const args = BoardRequestQuerySchema.parse(input), snapshot = await this.#snapshot(args.boardId), board = snapshot.board;
    const reader = await this.#ownedWork(snapshot, args.workId);
    if (!board.labels.every(label => reader.policy.allowedLabels.includes(label))) unavailable();
    if (args.requestId && args.cursor) throw new Error('board_request_cursor_invalid');
    let start = 0;
    if (args.cursor) {
      if (args.cursor.revision !== board.revision) throw new Error('board_request_cursor_stale');
      const index = board.requests.findIndex(request => request.id === args.cursor!.afterRequestId);
      if (index < 0 || !(await this.#requestVisible(snapshot, reader, board.requests[index]!))) throw new Error('board_request_cursor_invalid');
      start = index + 1;
    }
    const requests: BoardRequestPage['requests'] = [];
    const make = (more: boolean): BoardRequestPage => ({ boardId: board.id, revision: board.revision, roleId: boardRole(board, snapshot.actor)!.id,
      observedAt: this.#now(), interpretation: 'observed_coordination_metadata', visibility: 'permitted_participant_requests', requests,
      nextCursor: more ? { revision: board.revision, afterRequestId: requests.at(-1)!.id } : null });
    let more = false;
    for (const request of board.requests.slice(start)) {
      if ((args.requestId && request.id !== args.requestId) || !(await this.#requestVisible(snapshot, reader, request))) continue;
      if (requests.length === args.maxRequests) { more = true; break; }
      const { deliverable: _deliverable, waitFor: _waitFor, createdAt: _createdAt, closedAt: _closedAt, ...metadata } = request;
      requests.push({ ...metadata, effectiveStatus: await this.#requestEffectiveStatus(snapshot, request) });
      if (new TextEncoder().encode(JSON.stringify(make(true))).byteLength > args.maxBytes) {
        requests.pop(); if (!requests.length) throw new Error('board_request_page_item_too_large'); more = true; break;
      }
    }
    await this.#guard(snapshot);
    for (const request of requests) if (request.effectiveStatus !== 'needs_review' && pending(request) && request.dueAt <= this.#now()) request.effectiveStatus = 'expired';
    const page = make(more); if (new TextEncoder().encode(JSON.stringify(page)).byteLength > args.maxBytes) throw new Error('board_request_page_item_too_large');
    return structuredClone(page);
  }
  async view(id: string): Promise<BoardView> {
    const snapshot = await this.#snapshot(id); const board = snapshot.board;
    const posts: BoardView['posts'] = [], checked: CheckedPost[] = [];
    for (const value of board.posts) {
      try {
        const read = await this.#post(snapshot, value.id); checked.push(read); posts.push(postView(read));
      } catch (error) { if (error instanceof Error && error.message === 'board_contention') throw error; }
    }
    const roleId = boardRole(board, snapshot.actor)!.id, requests: BoardView['requests'] = [];
    for (const request of board.requests) {
      if (![request.fromAgentId, request.toAgentId].includes(roleId) || !posts.some(post => post.id === request.questionId)) continue;
      let effectiveStatus: BoardView['requests'][number]['effectiveStatus'] = request.status;
      const work = await this.#work(snapshot, request.fromWorkId, this.#roleOwner(snapshot, request.fromAgentId));
      const recipient = request.acceptedWorkId ? await this.#work(snapshot, request.acceptedWorkId, this.#roleOwner(snapshot, request.toAgentId)) : null;
      if (work.goal.revision !== request.fromGoalRevision || ['paused', 'cancelled', 'failed'].includes(work.status) ||
        (recipient && (recipient.goal.revision !== request.acceptedGoalRevision || ['paused', 'cancelled', 'failed'].includes(recipient.status))) ||
        (request.answerPostId && !posts.some(post => post.id === request.answerPostId))) effectiveStatus = 'needs_review';
      else if (pending(request) && this.#now() >= request.dueAt) effectiveStatus = 'expired';
      if (['answered', 'satisfied'].includes(request.status)) {
        try { await this.#satisfiedDependencies(snapshot, request); }
        catch (error) { if (error instanceof Error && error.message === 'board_contention') throw error; effectiveStatus = 'needs_review'; }
      }
      requests.push({ ...request, effectiveStatus });
    }
    await this.#guard(snapshot);
    for (const request of requests) if (request.effectiveStatus !== 'needs_review' && pending(request) && this.#now() >= request.dueAt) request.effectiveStatus = 'expired';
    return { id: board.id, revision: board.revision, roleId, entities: structuredClone(board.entities), posts, requests,
      findings: findings(checked) };
  }
  async readPage(input: BoardReadQuery): Promise<BoardReadPage> {
    const args = BoardReadQuerySchema.parse(input), snapshot = await this.#snapshot(args.boardId), board = snapshot.board;
    const reader = await this.#ownedWork(snapshot, args.workId); await this.#workProof(snapshot, reader);
    if (!board.labels.every(label => reader.policy.allowedLabels.includes(label)) ||
      (args.entityId && !board.entities.some(entity => entity.id === args.entityId))) unavailable();
    const permitted = (post: BoardPost) => (!args.entityId || post.entityId === args.entityId) &&
      post.labels.every(label => reader.policy.allowedLabels.includes(label));
    let start = 0;
    if (args.cursor) {
      if (args.cursor.revision !== board.revision) throw new Error('board_cursor_stale');
      const index = board.posts.findIndex(post => post.id === args.cursor!.afterPostId);
      if (index < 0 || !permitted(board.posts[index]!)) throw new Error('board_cursor_invalid');
      try { await this.#post(snapshot, args.cursor.afterPostId); } catch { throw new Error('board_cursor_invalid'); }
      start = index + 1;
    }
    const selected: CheckedPost[] = [], observedAt = this.#now();
    const make = (values: CheckedPost[], more: boolean): BoardReadPage => ({ id: board.id, revision: board.revision,
      roleId: boardRole(board, snapshot.actor)!.id, observedAt, interpretation: 'discussion_not_independent_evidence',
      visibility: 'permitted_current_posts_only', findingsBasis: 'returned_posts_only',
      entities: board.entities.filter(entity => values.some(value => value.post.entityId === entity.id)),
      posts: values.map(postView), findings: findings(values),
      nextCursor: more ? { revision: board.revision, afterPostId: values.at(-1)!.post.id } : null });
    const fits = (page: BoardReadPage) => new TextEncoder().encode(JSON.stringify(page)).byteLength <= args.maxBytes;
    let more = false;
    for (const post of board.posts.slice(start)) {
      if (!permitted(post)) continue;
      let read: CheckedPost;
      try { read = await this.#post(snapshot, post.id); }
      catch (error) { if (error instanceof Error && error.message === 'board_contention') throw error; continue; }
      if (selected.length === args.maxPosts) { more = true; break; }
      if (!fits(make([...selected, read], true))) {
        if (!selected.length) throw new Error('board_page_item_too_large'); more = true; break;
      }
      selected.push(read);
    }
    const page = make(selected, more); if (!fits(page)) throw new Error('board_page_item_too_large');
    await this.#guard(snapshot); return structuredClone(page);
  }

  /** Internal inspection of an already observed page. The caller must validate sourceWorkIds.
   * Appends do not erase history; changes to a returned post, source or authority do. */
  async inspectPage(input: BoardReadQuery, observed: BoardReadPage): Promise<SourceInputInspection> {
    const args = BoardReadQuerySchema.parse(input), page = BoardReadPageSchema.parse(observed);
    const inspect = async () => {
      const snapshot = await this.#snapshot(args.boardId, false, true), board = snapshot.board;
      const reader = await this.#work(snapshot, args.workId);
      if (reader.policy.principalId !== snapshot.actor.principalId || !reader.policy.allowedDestinations.includes('local') ||
        !board.labels.every(label => reader.policy.allowedLabels.includes(label)) || page.id !== board.id ||
        page.roleId !== boardRole(board, snapshot.actor)!.id || page.revision > board.revision || page.observedAt > this.#now() ||
        page.posts.length > args.maxPosts || new Set(page.posts.map(post => post.id)).size !== page.posts.length ||
        new TextEncoder().encode(JSON.stringify(page)).byteLength > args.maxBytes) unavailable();
      const checked: CheckedPost[] = [];
      for (const post of page.posts) {
        if ((args.entityId && post.entityId !== args.entityId) || !post.labels.every(label => reader.policy.allowedLabels.includes(label))) unavailable();
        checked.push(await this.#post(snapshot, post.id));
      }
      const entities = board.entities.filter(entity => checked.some(value => value.post.entityId === entity.id));
      if (this.#digest({ posts: checked.map(postView), entities, findings: findings(checked) }) !==
        this.#digest({ posts: page.posts, entities: page.entities, findings: page.findings })) unavailable();
      await this.#guard(snapshot);
      const sourceWorks = [...snapshot.workSources].sort(([a], [b]) => a.localeCompare(b)).map(([workId, source]) => ({ workId, source: source.inputs }));
      return { workIds: [...snapshot.works.keys()].filter(id => !snapshot.workSources.has(id)).sort(), sourceWorks,
        sourceIdentities: sourceWorks.map(({ workId, source }) => ({ workId, sourceId: source.id })), actor: snapshot.actor, expiresAt: snapshot.expiresAt,
        bytesRead: new TextEncoder().encode(JSON.stringify({ board, works: [...snapshot.works.values()] })).byteLength };
    };
    const captured = await inspect(), version = this.#digest({ args, page, actor: captured.actor, workIds: captured.workIds, sourceIdentities: captured.sourceIdentities });
    return { version, sourceWorkIds: captured.workIds, ...(captured.sourceWorks.length ? { sourceWorks: captured.sourceWorks } : {}), knowledgeDependencies: [], bytesRead: captured.bytesRead,
      validUntil: captured.expiresAt, current: async () => {
        try { const latest = await inspect(); return this.#digest({ args, page, actor: latest.actor, workIds: latest.workIds, sourceIdentities: latest.sourceIdentities }) === version; }
        catch { return false; }
      } };
  }
}
