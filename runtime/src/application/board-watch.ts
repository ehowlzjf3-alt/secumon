import type { BoardActor, BoardRequestMetadata } from '../domain/board.js';
import { boardRole } from '../domain/board.js';
import { dataGeneration } from '../domain/data-lifecycle.js';
import type { ExternalNotification, ExternalSubscription } from '../domain/external-events.js';
import type { WorkState } from '../domain/model.js';
import { BoardActorSchema } from './board-contracts.js';
import { ExternalNotificationsSchema, ExternalSubscriptionSchema, ExternalSubscriptionsSchema } from './external-event-contracts.js';
import type { BoardActorProvider, BoardRepository } from './board-ports.js';
import type { BoardWorkSources } from './board-work-sources.js';
import { BoardService } from './board-service.js';
import type { RuntimeServices } from './services.js';
import { asJson } from './plan-validator.js';
import { transact } from './work-transactions.js';
import type { InputAuthority } from './knowledge-ports.js';
import { captureProgress } from './work-progress.js';

type Dependencies = { services: RuntimeServices; repository: BoardRepository; actors: BoardActorProvider; authority: InputAuthority; workSources?: BoardWorkSources | undefined };
const unavailable = () => new Error('board_watch_unavailable');
const terminal = (state: WorkState) => ['paused', 'cancelled', 'failed', 'completed'].includes(state.status);

/** Host-owned subscriptions consume durable changes without sending messages or invoking models. */
export class BoardWatch {
  constructor(private readonly deps: Dependencies) {}
  private within(deadline: number) { if (this.deps.services.clock.now() >= deadline) throw new Error('board_watch_deadline'); }
  private digest(value: unknown) { return this.deps.services.digester.digest(asJson(value)); }
  private async state(id: string) { const state = await this.deps.services.state.get(id); if (!state) throw unavailable(); return state; }
  private identity(state: WorkState, resourceId: string) { return `watch-${this.digest({ workId: state.id, provider: 'board', resourceId, goalRevision: state.goal.revision, generation: dataGeneration(state) })}`; }
  private checkpoint(subscription: ExternalSubscription, notifications: ExternalNotification[]) {
    const { checkpointId: _checkpointId, ...source } = subscription;
    return asJson({ subscription: source, notifications });
  }
  private async access(state: WorkState, resourceId: string) {
    const local = BoardActorSchema.parse(await this.deps.actors.current());
    const raw = await this.deps.authority.resolve({ tenantId: state.policy.tenantId, principalId: state.policy.principalId }); if (!raw) throw unavailable();
    const trusted = BoardActorSchema.parse({ ...raw, canManageBoards: false });
    if (trusted.tenantId !== local.tenantId || trusted.principalId !== local.principalId) throw unavailable();
    const actor = { ...local, allowedScopes: local.allowedScopes.filter(value => trusted.allowedScopes.includes(value)),
      allowedNamespaces: local.allowedNamespaces.filter(value => trusted.allowedNamespaces.includes(value)), allowedLabels: local.allowedLabels.filter(value => trusted.allowedLabels.includes(value)),
      canPublish: local.canPublish && trusted.canPublish, canReview: local.canReview && trusted.canReview };
    if (actor.tenantId !== state.policy.tenantId || actor.principalId !== state.policy.principalId ||
      !actor.allowedScopes.includes(state.goal.scope) || !state.policy.allowedLabels.every(label => actor.allowedLabels.includes(label)) ||
      !state.policy.allowedDestinations.includes('local')) throw unavailable();
    const board = await this.deps.repository.get(actor.tenantId, resourceId);
    if (!board || !actor.allowedScopes.includes(board.scope) || !actor.allowedNamespaces.includes(board.namespace) || !board.labels.every(label => state.policy.allowedLabels.includes(label)) || !boardRole(board, actor)) throw unavailable();
    return { actor, board, roleId: boardRole(board, actor)!.id };
  }
  private service(actor: BoardActor) { return new BoardService({ ...this.deps, actors: { current: async () => structuredClone(actor) } }); }
  private async recorded(state: WorkState, subscription: ExternalSubscription, notifications: ExternalNotification[]) {
    if (subscription.provider !== 'board' || subscription.goalRevision !== state.goal.revision || subscription.generation !== dataGeneration(state) ||
      subscription.id !== this.identity(state, subscription.resourceId) || notifications.some(value => value.subscriptionId !== subscription.id || value.provider !== subscription.provider ||
        value.resourceId !== subscription.resourceId || value.goalRevision !== subscription.goalRevision || value.id !== `notice-${this.digest({ subscriptionId: subscription.id, referenceId: value.referenceId })}`)) return false;
    const receipt = await this.deps.services.state.receipt(state.id, subscription.checkpointId);
    return !!receipt && receipt.digest === this.digest({ type: 'external_subscription_checkpoint', data: this.checkpoint(subscription, notifications) }) &&
      this.digest(receipt.state.subscriptions?.find(value => value.id === subscription.id)) === this.digest(subscription) &&
      this.digest(receipt.state.notifications?.filter(value => value.subscriptionId === subscription.id) ?? []) === this.digest(notifications);
  }
  async current(state: WorkState): Promise<boolean> {
    try {
      const allSubscriptions = ExternalSubscriptionsSchema.parse(state.subscriptions ?? []), allNotices = ExternalNotificationsSchema.parse(state.notifications ?? []);
      const subscriptions = allSubscriptions.filter(value => value.provider === 'board'), notices = allNotices.filter(value => value.provider === 'board');
      if (notices.some(notice => !subscriptions.some(value => value.id === notice.subscriptionId && value.status === 'active'))) return false;
      for (const subscription of subscriptions.filter(value => value.status === 'active')) {
        const own = notices.filter(value => value.subscriptionId === subscription.id);
        if (!(await this.recorded(state, subscription, own))) return false;
        const { actor, board, roleId } = await this.access(state, subscription.resourceId);
        if (subscription.cursor > board.revision || !(await this.service(actor).requestMetadataPermitted(board.id, state.id, own.map(value => value.referenceId)))) return false;
        if (!terminal(state) && subscription.cursor < board.revision) {
          if (!this.deps.repository.changes) return false;
          const pending = await this.deps.repository.changes(state.policy.tenantId, board.id, { afterRevision: subscription.cursor, maxEvents: 32, maxBytes: 65536 });
          if (pending.resyncRequired || pending.more || pending.events.some(event => event.roleIds.includes(roleId))) return false;
        }
        if (this.digest((await this.access(await this.state(state.id), board.id)).actor) !== this.digest(actor)) return false;
      }
      const latest = await this.state(state.id);
      return latest.goal.revision === state.goal.revision && dataGeneration(latest) === dataGeneration(state) && this.digest(latest.policy) === this.digest(state.policy) &&
        this.digest(latest.subscriptions ?? []) === this.digest(allSubscriptions) && this.digest(latest.notifications ?? []) === this.digest(allNotices);
    } catch { return false; }
  }
  async register(workId: string, resourceId: string): Promise<WorkState> {
    const state = await this.state(workId); if (terminal(state) || !this.deps.repository.changes) throw unavailable();
    const access = await this.access(state, resourceId), id = this.identity(state, resourceId);
    if (state.subscriptions?.some(value => value.id === id)) return this.refresh(workId);
    if ((state.subscriptions?.length ?? 0) >= 16) throw new Error('subscription_capacity');
    const subscription = ExternalSubscriptionSchema.parse({ id, provider: 'board', resourceId, goalRevision: state.goal.revision, generation: dataGeneration(state),
      cursor: 0, status: 'active', checkpointId: `watch-register:${id}` });
    await transact(this.deps.services, workId, subscription.checkpointId, 'external_subscription_checkpoint', this.checkpoint(subscription, []), next => {
      if (next.revision !== state.revision || terminal(next)) throw unavailable();
      next.subscriptions = [...(next.subscriptions ?? []), subscription]; next.notifications ??= [];
    }, async () => { if (this.digest((await this.access(await this.state(workId), resourceId)).actor) !== this.digest(access.actor)) throw unavailable(); });
    return this.refresh(workId);
  }
  async close(workId: string, subscriptionId: string): Promise<WorkState> {
    const state = await this.state(workId), subscription = state.subscriptions?.find(value => value.id === subscriptionId);
    if (!subscription || subscription.provider !== 'board') throw unavailable();
    const actor = BoardActorSchema.parse(await this.deps.actors.current());
    if (actor.tenantId !== state.policy.tenantId || actor.principalId !== state.policy.principalId) throw unavailable();
    if (subscription.status === 'closed') return state;
    return (await transact(this.deps.services, workId, `watch-close:${subscription.id}:${state.revision}`, 'external_subscription_closed', { subscriptionId }, next => {
      if (next.revision !== state.revision) throw unavailable();
      next.subscriptions!.find(value => value.id === subscriptionId)!.status = 'closed';
      next.notifications = (next.notifications ?? []).filter(value => value.subscriptionId !== subscriptionId);
    }, async () => { const latest = BoardActorSchema.parse(await this.deps.actors.current()); if (latest.tenantId !== actor.tenantId || latest.principalId !== actor.principalId) throw unavailable(); })).state;
  }
  private async rows(state: WorkState, subscription: ExternalSubscription, actor: BoardActor, expectedRevision: number, deadline: number) {
    const rows: BoardRequestMetadata[] = []; let cursor: { revision: number; afterRequestId: string } | undefined;
    for (let pageNumber = 0; pageNumber < 13; pageNumber++) {
      this.within(deadline);
      const page = await this.service(actor).requestPage({ boardId: subscription.resourceId, workId: state.id, maxRequests: 20, maxBytes: 32768, ...(cursor ? { cursor } : {}) });
      this.within(deadline);
      if (page.revision !== expectedRevision) throw new Error('board_watch_contention');
      rows.push(...page.requests); if (!page.nextCursor) return rows; cursor = page.nextCursor;
    }
    throw new Error('board_watch_page_limit');
  }
  private async poll(workId: string, subscriptionId: string, deadline: number): Promise<WorkState> {
    for (let retry = 0; retry < 8; retry++) {
      this.within(deadline);
      const state = await this.state(workId), subscription = state.subscriptions?.find(value => value.id === subscriptionId);
      if (!subscription || subscription.status !== 'active' || terminal(state)) return state;
      if (!this.deps.repository.changes) throw unavailable();
      const old = (state.notifications ?? []).filter(value => value.subscriptionId === subscription.id);
      if (!(await this.recorded(state, subscription, old))) throw unavailable();
      const { board, actor, roleId } = await this.access(state, subscription.resourceId);
      const page = await this.deps.repository.changes(state.policy.tenantId, board.id, { afterRevision: subscription.cursor, maxEvents: 32, maxBytes: 65536 });
      this.within(deadline);
      if (page.headRevision !== board.revision) continue;
      let notices = old;
      if (subscription.cursor === 0 || page.resyncRequired || page.more || old.length || page.events.some(event => event.roleIds.includes(roleId))) {
        let rows: BoardRequestMetadata[];
        try { rows = await this.rows(state, subscription, actor, board.revision, deadline); }
        catch (error) {
          if (error instanceof Error && ['board_watch_contention', 'board_contention', 'board_revision_conflict', 'board_request_cursor_stale'].includes(error.message)) continue;
          throw error;
        }
        notices = rows.filter(value => value.toAgentId === roleId && value.status === 'offered' && value.effectiveStatus === 'offered')
          .map(value => old.find(notice => notice.referenceId === value.id) ?? { id: `notice-${this.digest({ subscriptionId: subscription.id, referenceId: value.id })}`,
            subscriptionId: subscription.id, provider: 'board', resourceId: board.id, referenceId: value.id, goalRevision: state.goal.revision,
            observedPlanRevision: state.plan?.revision ?? 0, receivedAt: this.deps.services.clock.now() }).sort((a, b) => a.id.localeCompare(b.id));
      }
      const cursor = page.resyncRequired || page.more ? board.revision : page.throughRevision;
      if (cursor === subscription.cursor && this.digest(notices) === this.digest(old)) return state;
      const nextSubscription: ExternalSubscription = { ...subscription, cursor, checkpointId: `watch-poll:${subscription.id}:${state.revision}` };
      const all = ExternalNotificationsSchema.parse([...(state.notifications ?? []).filter(value => value.subscriptionId !== subscription.id), ...notices]).sort((a, b) => a.id.localeCompare(b.id));
      try {
        return (await transact(this.deps.services, workId, nextSubscription.checkpointId, 'external_subscription_checkpoint', this.checkpoint(nextSubscription, notices), next => {
          if (next.revision !== state.revision || terminal(next)) throw new Error('board_watch_contention');
          next.subscriptions = next.subscriptions!.map(value => value.id === subscription.id ? nextSubscription : value); next.notifications = all;
          const added = notices.filter(value => !old.some(prior => prior.id === value.id));
          if (added.length) captureProgress(next, this.deps.services.digester, nextSubscription.checkpointId, this.deps.services.clock.now(),
            { additionalKeys: added.map(value => `notification:${value.id}`) });
          if (this.digest(old) !== this.digest(notices) && !next.attempts.some(value => ['reserved', 'running', 'received'].includes(value.status)) &&
            !next.modelCalls.some(value => ['reserved', 'running', 'received'].includes(value.status))) { next.status = 'ready'; next.statusReason = 'external_notification_changed'; }
        }, async () => {
          const latest = await this.state(workId);
          const access = await this.access(latest, board.id);
          if (latest.revision !== state.revision || access.board.revision !== board.revision || this.digest(access.actor) !== this.digest(actor) ||
            !(await this.service(actor).requestMetadataPermitted(board.id, state.id, notices.map(value => value.referenceId)))) throw new Error('board_watch_contention');
          const final = await this.access(await this.state(workId), board.id);
          if (final.board.revision !== board.revision || this.digest(final.actor) !== this.digest(actor)) throw new Error('board_watch_contention');
          this.within(deadline);
        })).state;
      } catch (error) { if (!(error instanceof Error && error.message === 'board_watch_contention')) throw error; }
    }
    throw new Error('board_watch_contention');
  }
  async refresh(workId: string): Promise<WorkState> {
    const deadline = Math.min(Number.MAX_SAFE_INTEGER, this.deps.services.clock.now() + 10000);
    let state = await this.state(workId);
    for (const subscription of state.subscriptions ?? []) if (subscription.provider === 'board' && subscription.status === 'active') state = await this.poll(workId, subscription.id, deadline);
    return state;
  }
}
