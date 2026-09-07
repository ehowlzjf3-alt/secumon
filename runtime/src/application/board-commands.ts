import { z } from 'zod';
import type { Attempt, EffectReceipt, Obligation, ToolResult, WorkState } from '../domain/model.js';
import { dataGeneration, visibleArtifact } from '../domain/data-lifecycle.js';
import { boardRole } from '../domain/board.js';
import { BoardActorSchema, PublishBoardSchema, RetractBoardSchema, OfferBoardRequestSchema, ChangeBoardRequestSchema } from './board-contracts.js';
import type { BoardActorProvider, BoardRepository } from './board-ports.js';
import type { BoardWorkSources } from './board-work-sources.js';
import type { InputAuthority } from './knowledge-ports.js';
import { BoardService } from './board-service.js';
import { asJson, taskDigest } from './plan-validator.js';
import type { Tool } from './ports.js';
import type { RuntimeServices } from './services.js';
import { transact } from './work-transactions.js';
import { knowledgeInputsCurrent } from './knowledge-validity.js';
import { cancelBudgetReservations } from './budget-delegation.js';
import { captureProgress } from './work-progress.js';
import { BOARD_REQUEST_READ_TOOL } from './board-request-tools.js';

export const BOARD_WRITE_TOOLS = ['core.board.publish', 'core.board.retract'] as const;
export const BOARD_REQUEST_TOOLS = ['core.board.requests.offer', 'core.board.requests.accept', 'core.board.requests.answer',
  'core.board.requests.confirm', 'core.board.requests.decline', 'core.board.requests.cancel'] as const;
const requestActions = ['offer', 'accept', 'answer', 'confirm', 'decline', 'cancel'] as const;
type WriteToolId = typeof BOARD_WRITE_TOOLS[number] | typeof BOARD_REQUEST_TOOLS[number];
const PublishInput = PublishBoardSchema.omit({ commandId: true, workId: true, sources: true }).extend({ evidenceIds: z.array(z.string().min(1).max(160)).max(16) });
const RetractInput = RetractBoardSchema.omit({ commandId: true });
const OfferInput = OfferBoardRequestSchema.omit({ commandId: true });
const RequestInput = ChangeBoardRequestSchema.pick({ boardId: true, expectedRevision: true, requestId: true });
const AnswerInput = RequestInput.extend({ postId: z.string().min(1).max(160) });
const requestAction = (id: string) => requestActions[BOARD_REQUEST_TOOLS.indexOf(id as typeof BOARD_REQUEST_TOOLS[number])];
const schemaFor = (id: WriteToolId) => id === BOARD_WRITE_TOOLS[0] ? PublishInput : id === BOARD_WRITE_TOOLS[1] ? RetractInput :
  requestAction(id) === 'offer' ? OfferInput : requestAction(id) === 'answer' ? AnswerInput : RequestInput;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const ProofSchema = z.strictObject({ schemaVersion: z.literal(1), workId: z.string(), attemptId: z.string(), commandId: z.string(),
  commandDigest: hash, inputDigest: hash, boundary: hash, boardId: z.string(), revision: z.number().int().positive(),
  outcome: z.enum(['applied', 'not_applied']), observedAt: z.number().int().nonnegative() });
type Dependencies = { services: RuntimeServices; repository: BoardRepository; actors: BoardActorProvider; authority: InputAuthority;
  workSources?: BoardWorkSources | undefined;
  containsPosts(state: WorkState, boardId: string, ids: string[]): Promise<boolean> };
const unavailable = () => new Error('board_command_unavailable');

/** Local board commands have durable storage receipts. Neither a receipt nor an input application completes a goal. */
export class BoardCommands {
  readonly tools: Tool[];
  constructor(private readonly deps: Dependencies) { this.tools = [...BOARD_WRITE_TOOLS, ...BOARD_REQUEST_TOOLS].map(id => this.tool(id)); }
  private digest(value: unknown) { return this.deps.services.digester.digest(asJson(value)); }
  private boundary(state: WorkState) { return this.digest({ id: state.id, scope: state.goal.scope, generation: dataGeneration(state),
    tenantId: state.policy.tenantId, principalId: state.policy.principalId, labels: [...state.policy.allowedLabels].sort() }); }
  private async state(id: string) { const state = await this.deps.services.state.get(id); if (!state) throw unavailable(); return state; }
  private async descriptor(state: WorkState, attemptId: string) {
    const attempt = state.attempts.find(value => value.id === attemptId);
    const dispatch = await this.deps.services.state.receipt(state.id, `dispatch:${attemptId}`);
    const source = dispatch?.state.attempts.find(value => value.id === attemptId);
    const task = dispatch?.state.plan?.tasks.find(value => value.id === attempt?.taskId);
    const tool = this.tools.find(value => value.definition.id === attempt?.toolId);
    if (!attempt || !source || !task || !dispatch || !tool || source.status !== 'running' || attempt.effect !== 'write' || task.effect !== 'write' ||
      source.inputDigest !== attempt.inputDigest || source.contractDigest !== attempt.contractDigest ||
      attempt.contractDigest !== this.digest(tool.definition) || taskDigest(task, this.deps.services.digester) !== attempt.inputDigest ||
      task.toolId !== attempt.toolId || task.toolVersion !== '1' || attempt.toolVersion !== '1' ||
      attempt.scope !== dispatch.state.goal.scope || attempt.goalRevision !== dispatch.state.goal.revision ||
      this.boundary(dispatch.state) !== this.boundary(state)) throw unavailable();
    const commandId = `board:${this.digest({ workId: state.id, attemptId })}`;
    const parsed = schemaFor(attempt.toolId as WriteToolId).parse(task.input);
    const action = attempt.toolId === BOARD_WRITE_TOOLS[0] ? 'publish' : attempt.toolId === BOARD_WRITE_TOOLS[1] ? 'retract' : requestAction(attempt.toolId)!;
    const args = action === 'publish' ? (() => { const { evidenceIds, ...input } = PublishInput.parse(parsed);
      return PublishBoardSchema.parse({ ...input, commandId, workId: state.id, sources: evidenceIds.map(evidenceId => ({ workId: state.id, evidenceId })) }); })() :
      action === 'retract' ? RetractBoardSchema.parse({ ...parsed, commandId }) : action === 'offer' ? OfferBoardRequestSchema.parse({ ...parsed, commandId }) :
      ChangeBoardRequestSchema.parse({ ...parsed, commandId, action, ...(action === 'accept' ? { workId: state.id } : {}) });
    return { attempt, task, action, args, commandId, commandDigest: this.digest({ action: ['publish', 'retract', 'offer'].includes(action) ? action : 'request', actorId: state.policy.principalId, data: args }),
      boundary: this.boundary(state), dispatch: dispatch.state };
  }
  private output(descriptor: Awaited<ReturnType<BoardCommands['descriptor']>>) {
    const { action, args } = descriptor;
    if (action === 'publish' || action === 'retract') return { boardId: args.boardId,
      postId: action === 'publish' ? PublishBoardSchema.parse(args).id : RetractBoardSchema.parse(args).postId,
      status: action === 'publish' ? 'published' : 'retracted' };
    return { boardId: args.boardId, requestId: action === 'offer' ? OfferBoardRequestSchema.parse(args).id : ChangeBoardRequestSchema.parse(args).requestId,
      status: { offer: 'offered', accept: 'accepted', answer: 'answered', confirm: 'satisfied', decline: 'declined', cancel: 'cancelled' }[action]! };
  }
  private async access(state: WorkState, boardId: string) {
    const trusted = await this.deps.authority.resolve({ tenantId: state.policy.tenantId, principalId: state.policy.principalId });
    if (!trusted) throw unavailable();
    const actor = BoardActorSchema.parse({ ...trusted, canManageBoards: false });
    const board = await this.deps.repository.get(state.policy.tenantId, boardId);
    if (!board || actor.tenantId !== state.policy.tenantId || actor.principalId !== state.policy.principalId ||
      !actor.allowedScopes.includes(state.goal.scope) || !actor.allowedScopes.includes(board.scope) || !actor.allowedNamespaces.includes(board.namespace) ||
      !boardRole(board, actor) || !state.policy.allowedLabels.every(label => actor.allowedLabels.includes(label)) ||
      !board.labels.every(label => state.policy.allowedLabels.includes(label))) throw unavailable();
    return { board, actor: { ...actor, allowedLabels: [...state.policy.allowedLabels], allowedScopes: [...actor.allowedScopes] } };
  }
  private async ownedAccess(state: WorkState, boardId: string, write = false) {
    const actor = BoardActorSchema.parse(await this.deps.actors.current());
    const access = await this.access(state, boardId);
    if (actor.tenantId !== state.policy.tenantId || actor.principalId !== state.policy.principalId || !boardRole(access.board, actor) ||
      !actor.allowedScopes.includes(state.goal.scope) || !actor.allowedScopes.includes(access.board.scope) || !actor.allowedNamespaces.includes(access.board.namespace) ||
      !state.policy.allowedLabels.every(label => actor.allowedLabels.includes(label)) || (write && (!actor.canPublish || !access.actor.canPublish))) throw unavailable();
    return access;
  }
  private async recorded(state: WorkState, attemptId: string, origin: EffectReceipt['origin'], close: boolean): Promise<EffectReceipt> {
    const descriptor = await this.descriptor(state, attemptId);
    for (let retry = 0; retry < 8; retry++) {
      const { board } = await this.access(state, descriptor.args.boardId);
      const receipt = await this.deps.repository.receipt(board.tenantId, board.id, descriptor.commandId);
      if (!receipt) {
        if (!close) throw unavailable();
        const latest = await this.state(state.id);
        if (this.boundary(latest) !== descriptor.boundary) throw unavailable();
        await this.ownedAccess(latest, board.id);
        const next = structuredClone(board); next.revision++; next.updatedAt = Math.max(board.updatedAt, this.deps.services.clock.now());
        const committed = await this.deps.repository.commit({ expectedRevision: board.revision, next,
          commandId: descriptor.commandId, commandDigest: descriptor.commandDigest, disposition: 'not_applied' });
        if (committed.kind === 'idempotency_conflict') throw unavailable();
        continue;
      }
      if (receipt.digest !== descriptor.commandDigest || receipt.revision > board.revision) throw unavailable();
      const proof = { schemaVersion: 1, workId: state.id, attemptId, commandId: descriptor.commandId, commandDigest: descriptor.commandDigest,
        inputDigest: descriptor.attempt.inputDigest, boundary: descriptor.boundary, boardId: board.id, revision: receipt.revision,
        outcome: receipt.disposition ? 'not_applied' as const : 'applied' as const, observedAt: this.deps.services.clock.now() };
      const artifact = await this.deps.services.artifacts.put(new TextEncoder().encode(JSON.stringify(proof)),
        { tenantId: state.policy.tenantId, labels: [...state.policy.allowedLabels], mediaType: 'application/json' });
      return { provider: 'board', operationId: descriptor.commandId, outcome: proof.outcome, origin, artifact, observedAt: proof.observedAt };
    }
    throw unavailable();
  }
  async verify(state: WorkState, attemptId: string, receipt: EffectReceipt): Promise<boolean> {
    try {
      if (receipt.provider !== 'board' || !visibleArtifact(state, receipt.artifact) || receipt.artifact.byteLength > 4096) return false;
      const descriptor = await this.descriptor(state, attemptId);
      const { board } = await this.access(state, descriptor.args.boardId);
      const bytes = await this.deps.services.artifacts.get(receipt.artifact, state.policy);
      if (bytes.byteLength !== receipt.artifact.byteLength) return false;
      const proof = ProofSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      const stored = await this.deps.repository.receipt(board.tenantId, board.id, descriptor.commandId);
      const valid = !!stored && stored.digest === descriptor.commandDigest && stored.revision <= board.revision &&
        receipt.operationId === descriptor.commandId && receipt.observedAt === proof.observedAt && receipt.observedAt >= descriptor.attempt.startedAt &&
        receipt.observedAt <= this.deps.services.clock.now() && proof.workId === state.id && proof.attemptId === attemptId &&
        proof.commandId === descriptor.commandId && proof.commandDigest === descriptor.commandDigest && proof.inputDigest === descriptor.attempt.inputDigest &&
        proof.boundary === descriptor.boundary && proof.boardId === board.id && proof.revision === stored.revision &&
        receipt.outcome === proof.outcome && proof.outcome === (stored.disposition ? 'not_applied' : 'applied');
      if (!valid) return false;
      const latest = await this.state(state.id);
      if (this.boundary(latest) !== descriptor.boundary) return false;
      await this.access(latest, board.id);
      return true;
    } catch { return false; }
  }
  async proofsCurrent(state: WorkState) {
    for (const attempt of state.attempts) if (attempt.effectReceipt &&
      (attempt.effectReceipt.provider === 'board' || this.tools.some(tool => tool.definition.id === attempt.toolId)) &&
      !(await this.verify(state, attempt.id, attempt.effectReceipt))) return false;
    return true;
  }
  async reconcile(workId: string, attemptId: string): Promise<WorkState> {
    const state = await this.state(workId), attempt = state.attempts.find(value => value.id === attemptId);
    if (!attempt || !this.tools.some(tool => tool.definition.id === attempt.toolId) || attempt.effect !== 'write' ||
      ['reserved', 'running', 'received'].includes(attempt.status)) return state;
    const obligation = state.obligations.find(value => value.id === `effect:${attemptId}` && value.kind === 'effect_reconciliation');
    if (obligation?.status !== 'pending') return state;
    if (attempt.effectReceipt && !(await this.verify(state, attemptId, attempt.effectReceipt))) return state;
    try {
      const descriptor = await this.descriptor(state, attemptId);
      await this.ownedAccess(state, descriptor.args.boardId);
      const receipt: EffectReceipt = attempt.effectReceipt ? { ...attempt.effectReceipt, origin: 'reconciliation' } :
        await this.recorded(state, attemptId, 'reconciliation', true);
      if (!(await this.verify(state, attemptId, receipt))) return state;
      return (await transact(this.deps.services, workId, `board-reconcile:${attemptId}:${state.revision}`, 'effect_reconciled',
        { attemptId, outcome: receipt.outcome, artifactId: receipt.artifact.id }, next => {
          if (next.revision !== state.revision) throw unavailable();
          const target = next.attempts.find(value => value.id === attemptId)!;
          target.effectReceipt = receipt; target.effectState = receipt.outcome === 'applied' ? 'confirmed' : 'none';
          target.adopted = false;
          next.obligations.find(value => value.id === obligation.id)!.status = 'satisfied';
          if (!['paused', 'cancelled', 'failed'].includes(next.status)) { next.status = 'ready'; next.statusReason = 'effect_reconciled_requires_plan'; }
        }, async () => { if (!(await this.verify(await this.state(workId), attemptId, receipt))) throw unavailable(); })).state;
    } catch { return this.state(workId); }
  }
  async refresh(workId: string): Promise<WorkState> {
    let state = await this.state(workId);
    const invalid: Attempt[] = [];
    for (const attempt of state.attempts) if (attempt.effectReceipt &&
      (attempt.effectReceipt.provider === 'board' || this.tools.some(tool => tool.definition.id === attempt.toolId)) &&
      !(await this.verify(state, attempt.id, attempt.effectReceipt))) invalid.push(attempt);
    const newlyInvalid = invalid.filter(attempt => !state.obligations.some(value => value.id === `effect:${attempt.id}` && value.status === 'pending'));
    if (newlyInvalid.length) state = (await transact(this.deps.services, workId, `board-proof-invalid:${state.revision}`, 'effect_proofs_invalidated',
      { expectedRevision: state.revision }, next => {
        if (next.revision !== state.revision) throw unavailable();
        for (const attempt of next.attempts.filter(value => newlyInvalid.some(source => source.id === value.id))) {
          attempt.adopted = false; attempt.effectState = 'unknown';
          const id = `effect:${attempt.id}`, existing = next.obligations.find(value => value.id === id);
          if (existing) existing.status = 'pending';
          else next.obligations.push({ id, kind: 'effect_reconciliation', status: 'pending', reason: 'effect_proof_unavailable', wakeKey: null, dueAt: null });
        }
        cancelBudgetReservations(next, this.deps.services.clock.now());
      })).state;
    // An unavailable original proof remains a retained dependency. Do not silently replace it with a new summary.
    const pending = new Set(state.obligations.filter(value => value.kind === 'effect_reconciliation' && value.status === 'pending').map(value => value.id));
    for (const attempt of state.attempts.filter(value => pending.has(`effect:${value.id}`) && this.tools.some(tool => tool.definition.id === value.toolId) &&
      (!value.effectReceipt || !invalid.some(source => source.id === value.id))))
      state = await this.reconcile(workId, attempt.id);
    return state;
  }
  private async projectedObligations(state: WorkState): Promise<Obligation[]> {
    const obligations: Obligation[] = [];
    for (const attempt of state.attempts) {
      if (!['offer', 'accept'].includes(requestAction(attempt.toolId) ?? '') || attempt.effectReceipt?.outcome !== 'applied') continue;
      if (!(await this.verify(state, attempt.id, attempt.effectReceipt))) throw unavailable();
      const descriptor = await this.descriptor(state, attempt.id);
      const role = descriptor.action === 'offer' ? 'requester' as const : 'assignee' as const;
      const externalId = role === 'requester' ? OfferBoardRequestSchema.parse(descriptor.args).id : ChangeBoardRequestSchema.parse(descriptor.args).requestId;
      const source = { provider: 'board', resourceId: descriptor.args.boardId, externalId, role, goalRevision: descriptor.dispatch.goal.revision, attemptId: attempt.id };
      const id = `external:${this.digest({ workId: state.id, source })}`;
      let status = 'needs_review', dueAt: number | null = null;
      try {
        const service = new BoardService({ ...this.deps, actors: { current: async () => (await this.access(await this.state(state.id), source.resourceId)).actor } });
        const value = await service.requestStatus(source.resourceId, externalId, state.id);
        const matches = role === 'requester' ? value.fromWorkId === state.id && value.fromGoalRevision === source.goalRevision :
          value.acceptedWorkId === state.id && value.acceptedGoalRevision === source.goalRevision;
        if (matches) { status = value.status; dueAt = value.dueAt; }
      } catch { /* The receipt survives, but an unavailable request does not discharge an obligation. */ }
      if (source.goalRevision !== state.goal.revision && !['cancelled', 'declined'].includes(status)) status = 'needs_review';
      const closed = ['satisfied', 'cancelled', 'declined'].includes(status);
      const actionable = ['needs_review', 'expired'].includes(status) || (role === 'requester' ? status === 'answered' : status === 'accepted');
      obligations.push({ id, source, kind: 'response', status: status === 'satisfied' ? 'satisfied' : closed ? 'waived' : 'pending',
        mode: actionable ? 'actionable' : 'waiting', reason: `agent_request_${status}`, wakeKey: closed ? null : id,
        dueAt: closed || actionable ? null : dueAt, resumeToolIds: closed ? [] : [BOARD_REQUEST_READ_TOOL, role === 'requester' ? BOARD_REQUEST_TOOLS[5] : BOARD_REQUEST_TOOLS[4]] });
    }
    return obligations;
  }
  async obligationsCurrent(state: WorkState): Promise<boolean> {
    try { return this.digest(state.obligations.filter(value => value.source)) === this.digest(await this.projectedObligations(state)); }
    catch { return false; }
  }
  async refreshObligations(workId: string): Promise<WorkState> {
    for (let retry = 0; retry < 8; retry++) {
      const state = await this.state(workId), projected = await this.projectedObligations(state);
      const existing = state.obligations.filter(value => value.source);
      if (this.digest(existing) === this.digest(projected)) return state;
      if (existing.some(value => !projected.some(candidate => candidate.id === value.id && this.digest(candidate.source) === this.digest(value.source)))) throw unavailable();
      for (const obligation of projected) await this.ownedAccess(state, obligation.source!.resourceId);
      try {
        return (await transact(this.deps.services, workId, `board-obligations:${state.revision}`, 'external_obligations_refreshed',
          { expectedRevision: state.revision, obligationIds: projected.map(value => value.id) }, next => {
            if (next.revision !== state.revision) throw new Error('board_obligation_contention');
            next.obligations = [...next.obligations.filter(value => !value.source), ...projected];
            const milestones = projected.filter(value => value.source!.goalRevision === next.goal.revision &&
              ['agent_request_accepted', 'agent_request_answered', 'agent_request_satisfied'].includes(value.reason) &&
              !existing.some(prior => prior.id === value.id && prior.reason === value.reason));
            if (milestones.length) captureProgress(next, this.deps.services.digester, `board-obligations:${state.revision}`, this.deps.services.clock.now(),
              { additionalKeys: milestones.map(value => `coordination:${this.digest({ source: value.source, phase: value.reason })}`) });
            if (!['paused', 'cancelled', 'failed'].includes(next.status)) { next.status = 'ready'; next.statusReason = 'agent_request_updated'; }
          }, async () => {
            const latest = await this.state(workId);
            if (latest.revision !== state.revision || this.digest(projected) !== this.digest(await this.projectedObligations(latest))) throw new Error('board_obligation_contention');
            for (const obligation of projected) await this.ownedAccess(latest, obligation.source!.resourceId);
          })).state;
      } catch (error) { if (!(error instanceof Error && error.message === 'board_obligation_contention')) throw error; }
    }
    throw new Error('board_obligation_contention');
  }
  private tool(id: WriteToolId): Tool {
    const schema = schemaFor(id);
    return { definition: { provider: 'core', id, version: '1', effect: 'write', destination: 'local', labels: [], resultValidation: 'artifact-proof-v1',
      description: id === BOARD_WRITE_TOOLS[0] ? 'Publish a discussion post. Cite evidence owned by this work and previously read posts. A post is not independent evidence.' :
        id === BOARD_WRITE_TOOLS[1] ? 'Retract a post authored by this work.' : `Apply ${requestAction(id)} to a collaboration request owned by this role and work. An answer requires requester confirmation.`,
      inputSchema: asJson(z.toJSONSchema(schema, { target: 'draft-7' })), outputSchema: { type: ['object', 'null'] } },
      execute: async (task, context): Promise<ToolResult> => {
        const base = { resultId: `${context.attemptId}:result`, attemptId: context.attemptId, evidence: [], artifacts: [], cursor: null };
        try {
          const state = await this.state(context.workId), descriptor = await this.descriptor(state, context.attemptId);
          const { actor, board } = await this.ownedAccess(state, descriptor.args.boardId, true);
          if (task.toolId !== id || this.digest(task) !== this.digest(descriptor.task) || this.digest(state.policy) !== this.digest(context.policy) ||
            !state.policy.allowWrites || !state.policy.allowedTools.includes(id) || !actor.canPublish || context.signal.aborted) throw unavailable();
          if (descriptor.action === 'publish') {
            const args = PublishBoardSchema.parse(descriptor.args);
            if (!(await this.deps.containsPosts(state, args.boardId, [...args.quotedPostIds, ...(args.replyTo ? [args.replyTo] : [])]))) throw unavailable();
          } else if (descriptor.action === 'retract') {
            if (!board.posts.some(post => post.id === RetractBoardSchema.parse(descriptor.args).postId && post.workId === state.id)) throw unavailable();
          } else if (descriptor.action === 'offer') {
            if (!board.posts.some(post => post.id === OfferBoardRequestSchema.parse(descriptor.args).questionId && post.workId === state.id)) throw unavailable();
          } else {
            const args = ChangeBoardRequestSchema.parse(descriptor.args), request = board.requests.find(value => value.id === args.requestId);
            if (!request) throw unavailable();
            if (['confirm', 'cancel'].includes(descriptor.action)) { if (request.fromWorkId !== state.id) throw unavailable(); }
            else if (descriptor.action === 'answer' ? request.acceptedWorkId !== state.id : request.acceptedWorkId && request.acceptedWorkId !== state.id) throw unavailable();
            const readIds = descriptor.action === 'accept' ? [request.questionId] : descriptor.action === 'confirm' ? [request.questionId, request.answerPostId ?? ''] : [];
            if (!(await this.deps.containsPosts(state, board.id, readIds))) throw unavailable();
          }
          const authorize = async () => {
            if (context.signal.aborted) throw unavailable();
            await context.authorize?.();
            const latest = await this.state(state.id);
            const active = latest.attempts.find(value => value.id === context.attemptId);
            if (latest.goal.revision !== state.goal.revision || this.boundary(latest) !== descriptor.boundary ||
              this.digest(latest.policy) !== this.digest(state.policy) || ['paused', 'cancelled', 'failed', 'completed'].includes(latest.status) ||
              !active || active.status !== 'running' || active.leaseUntil <= this.deps.services.clock.now() || latest.deadlineAt <= this.deps.services.clock.now() ||
              !(await knowledgeInputsCurrent(this.deps.services, latest))) throw unavailable();
            const current = await this.ownedAccess(latest, board.id, true);
            if (!current.actor.canPublish || context.signal.aborted) throw unavailable();
          };
          await authorize();
          const service = new BoardService({ ...this.deps, actors: { current: async () => (await this.access(await this.state(state.id), board.id)).actor }, authorize });
          if (descriptor.action === 'publish') await service.publish(PublishBoardSchema.parse(descriptor.args));
          else if (descriptor.action === 'retract') await service.retract(RetractBoardSchema.parse(descriptor.args));
          else if (descriptor.action === 'offer') await service.offer(OfferBoardRequestSchema.parse(descriptor.args));
          else await service.changeRequest(ChangeBoardRequestSchema.parse(descriptor.args));
          const latest = await this.state(state.id), receipt = await this.recorded(latest, context.attemptId, 'execution', false);
          if (receipt.outcome !== 'applied' || !(await this.verify(latest, context.attemptId, receipt))) throw unavailable();
          return { ...base, status: 'success', effectState: 'confirmed', coverage: 'complete', error: null, effectReceipt: receipt,
            output: this.output(descriptor) };
        } catch { return { ...base, status: context.signal.aborted ? 'cancelled' : 'error', effectState: 'unknown', coverage: 'unknown', output: null,
          error: { code: 'board_command_unavailable', retryable: false } }; }
      },
      validateResult: async (state, result) => {
        try {
          if (result.evidence.length || result.artifacts.length || result.cursor !== null || result.collection || result.reuse || result.resultId !== `${result.attemptId}:result`) return false;
          if (result.status !== 'success') return ['error', 'cancelled'].includes(result.status) && result.effectState === 'unknown' && !result.effectReceipt &&
            result.output === null && result.coverage === 'unknown' && result.error?.code === 'board_command_unavailable';
          if (!result.effectReceipt || result.effectReceipt.origin !== 'execution' || result.effectReceipt.outcome !== 'applied' || result.effectState !== 'confirmed' ||
            result.coverage !== 'complete' || result.error !== null || !(await this.verify(state, result.attemptId, result.effectReceipt)) ||
            !(await knowledgeInputsCurrent(this.deps.services, state))) return false;
          const descriptor = await this.descriptor(state, result.attemptId);
          return descriptor.attempt.toolId === id && this.digest(result.output) === this.digest(this.output(descriptor));
        } catch { return false; }
      },
    };
  }
}
