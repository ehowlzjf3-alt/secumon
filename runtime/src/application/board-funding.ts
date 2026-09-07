import { z } from 'zod';
import type { Goal, Limits, Policy, TaskSpec } from '../domain/model.js';
import { BUDGET_DIMENSIONS, type BudgetMandate } from '../domain/budget-delegation.js';
import { boardRole, type BoardActor } from '../domain/board.js';
import { allowsDisclosure } from '../domain/disclosure.js';
import type { BudgetAuthority, BudgetAuthorityBinding, BudgetInvocation } from './budget-authority.js';
import type { BoardRepository } from './board-ports.js';
import type { InputAuthority } from './knowledge-ports.js';
import type { RuntimeServices } from './services.js';
import { BoardService } from './board-service.js';
import { BoardActorSchema, BoardReadQuerySchema, BoardRequestQuerySchema, ChangeBoardRequestSchema } from './board-contracts.js';
import { BudgetSchema, GoalSchema, PolicySchema } from './contracts.js';
import { BudgetDelegationService } from './budget-delegation.js';
import { asJson } from './plan-validator.js';

export const BOARD_FUNDING_PROVIDER = 'board-funding';
const id = z.string().trim().min(1).max(160);
export const BoardFundingReferenceSchema = z.strictObject({ profileId: id, boardId: id, requestId: id });
export interface BoardFundingProfile {
  id: string; revision: number; boardId: string; sponsorRoleId: string; workerRoleId: string;
  policy: Policy; goal: Goal; maximum: Limits;
}
export const BoardFundingProfileSchema: z.ZodType<BoardFundingProfile> = z.strictObject({ id, revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  boardId: id, sponsorRoleId: id, workerRoleId: id, policy: PolicySchema, goal: GoalSchema, maximum: BudgetSchema.shape.limits });
export interface BoardFundingProfiles { get(profileId: string): Promise<BoardFundingProfile | null> }
export const BoardFundingAllocationSchema = BoardFundingReferenceSchema.extend({ profileRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), limits: BudgetSchema.shape.limits });
export type BoardFundingAllocation = z.infer<typeof BoardFundingAllocationSchema>;
type Dependencies = { services: RuntimeServices; repository: BoardRepository; authority: InputAuthority; profiles: BoardFundingProfiles };

/** Resource policy checks do not publish the worker's policy, goal, or source content to its sponsor. */
export class BoardFunding implements BudgetAuthority {
  constructor(readonly deps: Dependencies) {}
  private digest(value: unknown) { return this.deps.services.digester.digest(asJson(value)); }
  referenceId(boardId: string, requestId: string) { return this.digest({ boardId, requestId }); }
  childId(parentWorkId: string, referenceId: string) { return `funded:${this.digest({ parentWorkId, referenceId })}`; }
  private async actor(policy: Pick<Policy, 'tenantId' | 'principalId'>): Promise<BoardActor> {
    const actor = await this.deps.authority.resolve(policy);
    if (!actor || actor.tenantId !== policy.tenantId || actor.principalId !== policy.principalId) throw new Error('board_funding_actor_unavailable');
    return BoardActorSchema.parse({ ...actor, canManageBoards: false });
  }
  private preparation(task: TaskSpec, workId: string, ref: z.infer<typeof BoardFundingReferenceSchema>, entityId: string) {
    if (task.toolVersion !== '1' || task.computerResume || task.readResume) return false;
    try {
      if (task.toolId === 'core.board.read' && task.effect === 'read') {
        const query = BoardReadQuerySchema.parse({ ...task.input, workId });
        return query.boardId === ref.boardId && query.entityId === entityId;
      }
      if (task.toolId === 'core.board.requests.read' && task.effect === 'read') {
        const query = BoardRequestQuerySchema.parse({ ...task.input, workId });
        return query.boardId === ref.boardId && query.requestId === ref.requestId;
      }
      if (task.toolId === 'core.board.requests.accept' && task.effect === 'write') {
        const query = ChangeBoardRequestSchema.parse({ ...task.input, commandId: 'host-permission-check', action: 'accept', workId });
        return query.boardId === ref.boardId && query.requestId === ref.requestId;
      }
    } catch { return false; }
    return false;
  }
  async current(binding: BudgetAuthorityBinding, purpose: 'allocation' | 'execution', signal?: AbortSignal, invocation?: BudgetInvocation): Promise<boolean> {
    if (signal?.aborted || binding.mandate.provider !== BOARD_FUNDING_PROVIDER) return false;
    const ref = BoardFundingReferenceSchema.parse(binding.mandate.attributes);
    const rawProfile = await this.deps.profiles.get(ref.profileId); if (!rawProfile) return false;
    const profile = BoardFundingProfileSchema.parse(rawProfile), { services } = this.deps;
    if (profile.id !== ref.profileId || profile.revision !== binding.mandate.revision || profile.boardId !== ref.boardId ||
      binding.mandate.referenceId !== this.referenceId(ref.boardId, ref.requestId) ||
      binding.child.workId !== this.childId(binding.parent.workId, binding.mandate.referenceId) ||
      binding.child.goalRevision !== profile.goal.revision || binding.mandate.childGoalRevision !== profile.goal.revision ||
      binding.child.goalDigest !== this.digest(profile.goal) || binding.child.scope !== profile.goal.scope ||
      this.digest(binding.child.policy) !== this.digest(profile.policy) || profile.policy.tenantId !== binding.parent.tenantId ||
      BUDGET_DIMENSIONS.some(d => binding.child.allocated[d] > profile.maximum[d])) return false;
    const parent = await services.state.get(binding.parent.workId);
    const child = await services.state.get(binding.child.workId);
    if (!parent || parent.goal.revision !== binding.parent.goalRevision || parent.policy.tenantId !== binding.parent.tenantId ||
      parent.policy.principalId !== binding.parent.principalId || ['cancelled', 'failed', 'completed', 'paused'].includes(parent.status)) return false;
    const board = await this.deps.repository.get(binding.parent.tenantId, ref.boardId);
    if (!board || board.scope !== binding.child.scope) return false;
    const sponsor = await this.actor(parent.policy), worker = await this.actor(profile.policy);
    if (boardRole(board, sponsor)?.id !== profile.sponsorRoleId || boardRole(board, worker)?.id !== profile.workerRoleId ||
      !sponsor.canPublish || !worker.canPublish || !profile.policy.allowWrites || !profile.policy.allowedTools.includes('core.board.requests.accept') ||
      !board.labels.every(label => parent.policy.allowedLabels.includes(label) && profile.policy.allowedLabels.includes(label)) ||
      !parent.policy.allowedLabels.every(label => sponsor.allowedLabels.includes(label)) ||
      !profile.policy.allowedLabels.every(label => worker.allowedLabels.includes(label)) ||
      !allowsDisclosure(parent.policy, 'local', 'a2a', board.labels) || !allowsDisclosure(profile.policy, 'local', 'a2a', board.labels)) return false;
    const request = board.requests.find(value => value.id === ref.requestId), question = request && board.posts.find(post => post.id === request.questionId);
    if (!request || !question || request.fromWorkId !== parent.id || request.fromGoalRevision !== parent.goal.revision ||
      request.fromAgentId !== profile.sponsorRoleId || request.toAgentId !== profile.workerRoleId ||
      !question.labels.every(label => worker.allowedLabels.includes(label) && profile.policy.allowedLabels.includes(label)) ||
      binding.child.deadlineAt !== request.dueAt || binding.child.deadlineAt > Math.min(parent.deadlineAt, (child?.createdAt ?? services.clock.now()) + profile.maximum.wallTimeMs) ||
      services.clock.now() >= binding.child.deadlineAt) return false;
    const ownAcceptance = request.acceptedWorkId === binding.child.workId;
    const statusPolicy = ownAcceptance ? profile.policy : parent.policy;
    const service = new BoardService({ services, repository: this.deps.repository, actors: { current: () => this.actor(statusPolicy) } });
    const status = await service.requestStatus(board.id, request.id, ownAcceptance ? binding.child.workId : parent.id);
    let allowed = ['offered', 'accepted', 'answered', 'satisfied'].includes(status.status);
    if (request.status !== 'offered') allowed &&= request.acceptedWorkId === binding.child.workId && request.acceptedGoalRevision === binding.child.goalRevision;
    if (allowed && purpose === 'execution' && request.status === 'offered') {
      allowed = invocation?.workId === binding.child.workId;
      const operation = invocation?.operation;
      if (operation?.kind === 'control') { /* A control refresh spends no model or tool call. */ }
      else if (operation?.kind === 'plan') allowed &&= operation.tasks.length > 0 && operation.tasks.every(task => this.preparation(task, binding.child.workId, ref, question.entityId));
      else if (operation?.kind === 'tool') allowed &&= this.preparation(operation.task, binding.child.workId, ref, question.entityId);
      else allowed = false;
    }
    if (!allowed || signal?.aborted || (await services.state.get(parent.id))?.revision !== parent.revision ||
      (await this.deps.repository.get(board.tenantId, board.id))?.revision !== board.revision ||
      this.digest(await this.deps.profiles.get(ref.profileId)) !== this.digest(rawProfile) ||
      this.digest(await this.actor(parent.policy)) !== this.digest(sponsor) || this.digest(await this.actor(profile.policy)) !== this.digest(worker)) return false;
    return !signal?.aborted && this.digest(await this.deps.profiles.get(ref.profileId)) === this.digest(rawProfile) &&
      (await services.state.get(parent.id))?.revision === parent.revision &&
      (await this.deps.repository.get(board.tenantId, board.id))?.revision === board.revision;
  }
  async allocate(parentWorkId: string, commandId: string, actor: Pick<Policy, 'tenantId' | 'principalId'>, expectedGoalRevision: number, input: BoardFundingAllocation) {
    const args = BoardFundingAllocationSchema.parse(input), raw = await this.deps.profiles.get(args.profileId);
    if (!raw) throw new Error('board_funding_profile_unavailable');
    const profile = BoardFundingProfileSchema.parse(raw);
    if (profile.revision !== args.profileRevision || profile.id !== args.profileId || profile.boardId !== args.boardId ||
      BUDGET_DIMENSIONS.some(d => args.limits[d] > profile.maximum[d]) || args.limits.wallTimeMs > profile.maximum.wallTimeMs) throw new Error('board_funding_profile_changed');
    const board = await this.deps.repository.get(actor.tenantId, args.boardId), request = board?.requests.find(item => item.id === args.requestId);
    if (!request || request.fromWorkId !== parentWorkId) throw new Error('board_funding_request_unavailable');
    const mandate: BudgetMandate = { provider: BOARD_FUNDING_PROVIDER, referenceId: this.referenceId(args.boardId, args.requestId), revision: profile.revision,
      childGoalRevision: profile.goal.revision, attributes: { profileId: args.profileId, boardId: args.boardId, requestId: args.requestId } };
    const child = await new BudgetDelegationService(this.deps.services).createChild(parentWorkId, commandId, actor, expectedGoalRevision,
      { id: this.childId(parentWorkId, mandate.referenceId), goal: profile.goal, policy: profile.policy, limits: args.limits, deadlineAt: request.dueAt, mandate });
    return { workId: child.id, grantId: child.budgetParent!.grantId };
  }
}
