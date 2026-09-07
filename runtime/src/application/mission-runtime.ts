import { z } from 'zod';
import type { WorkState } from '../domain/model.js';
import type { ExternalSubscription } from '../domain/external-events.js';
import { dataGeneration, visibleArtifact } from '../domain/data-lifecycle.js';
import { MissionEventSchema, MissionPageSchema, MissionRuleSchema, type MissionEventSource, type MissionRule } from './mission-contracts.js';
import type { RuntimeServices } from './services.js';
import type { WorkActor } from './work-resources.js';
import type { WorkflowRuntime } from './workflow-runtime.js';
import { assertExecutionAuthority } from './execution-authority.js';
import { asJson } from './plan-validator.js';
import { transact } from './work-transactions.js';
import { frozen } from './resource-contracts.js';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), hash = z.string().regex(/^[a-f0-9]{64}$/);
const CheckpointSchema = z.strictObject({ schemaVersion: z.literal(1), workId: z.string(), createdAt: count,
  rule: MissionRuleSchema, goalRevision: count.positive(), generation: count, cursor: count, snapshotDigest: z.string().max(256).nullable(),
  nextPollAt: count, idlePolls: count, noProgress: count, resumes: count, pendingRun: z.boolean(), resumeAt: count,
  observedPlanRevision: count,
  claim: z.strictObject({ owner: z.string(), until: count }).nullable(), progress: hash,
  status: z.enum(['active', 'closed']), reason: z.string().max(256).nullable(),
  seen: z.array(z.strictObject({ id: z.string(), digest: hash })).max(512), events: z.array(MissionEventSchema).max(32) });
type Checkpoint = z.infer<typeof CheckpointSchema>;
type Dependencies = { services: RuntimeServices; actor: WorkActor; agentId: string; scope: string; signal: AbortSignal; sources: readonly MissionEventSource[] };
const terminal = (state: WorkState) => ['cancelled', 'paused', 'failed', 'completed', 'blocked'].includes(state.status);
function changed(): never { throw new Error('mission_state_changed'); }

/** Durable observation/wake loop over the existing work repository. Waiting and polling never call a model. */
export class MissionRuntime {
  readonly #actor: WorkActor; readonly #sources = new Map<string, MissionEventSource>(); readonly #owner: string;
  readonly sources: readonly MissionEventSource[];
  constructor(readonly deps: Dependencies) {
    this.#actor = frozen(structuredClone(deps.actor)); this.#owner = deps.services.ids.next('mission-driver');
    for (const source of deps.sources) {
      const { id, destination, labels, poll } = source;
      if (!id || id.length > 160 || this.#sources.has(id) || !destination || !Array.isArray(labels) || typeof poll !== 'function') throw new Error('mission_source_invalid');
      this.#sources.set(id, Object.freeze({ id, destination, labels: Object.freeze([...labels]), poll: poll.bind(source) }));
    }
    this.sources = Object.freeze([...this.#sources.values()]);
  }
  private digest(value: unknown) { return this.deps.services.digester.digest(asJson(value)); }
  private identity(ruleId: string) { return `mission-${this.digest({ agentId: this.deps.agentId, ruleId })}`; }
  private access(state: WorkState) {
    this.deps.signal.throwIfAborted(); assertExecutionAuthority(this.deps.services, state);
    if (state.policy.tenantId !== this.#actor.tenantId || state.policy.principalId !== this.#actor.principalId ||
      state.goal.scope !== this.deps.scope || state.conversation?.session?.scope.agentId !== this.deps.agentId ||
      !state.policy.allowedLabels.every(label => this.#actor.allowedLabels?.includes(label))) throw new Error('mission_access_denied');
  }
  private async state(workId: string) {
    const state = await this.deps.services.state.get(workId); if (!state) throw new Error('work_not_found'); this.access(state); return state;
  }
  private source(state: WorkState, id: string) {
    const source = this.#sources.get(id);
    if (!source || !state.policy.allowedDestinations.includes(source.destination) || !this.#actor.allowedDestinations?.includes(source.destination) ||
      source.labels.some(label => !state.policy.allowedLabels.includes(label))) throw new Error('mission_source_unavailable');
    return source;
  }
  private progress(state: WorkState) {
    return this.digest({ goal: state.goal.revision, evidence: state.evidence.map(value => ({ id: value.id, digest: this.digest(value) })),
      acceptedInputs: [...new Set(state.attempts.filter(value => value.adopted).map(value => value.inputDigest))].sort(),
      hypotheses: state.hypotheses.map(value => ({ id: value.id, status: value.status, supportIds: value.supportIds, counterIds: value.counterIds })) });
  }
  private async read(state: WorkState, subscription: ExternalSubscription): Promise<Checkpoint> {
    if (subscription.provider !== 'mission' || !subscription.checkpointId.startsWith('mission:')) changed();
    const artifact = state.artifacts.find(value => value.sha256 === subscription.checkpointId.slice(8));
    if (!artifact || !visibleArtifact(state, artifact) || artifact.byteLength > 512 * 1024) throw new Error('mission_checkpoint_unavailable');
    const receipt = await this.deps.services.state.receipt(state.id, subscription.checkpointId);
    if (!receipt || receipt.state.id !== state.id || receipt.state.createdAt !== state.createdAt ||
      receipt.state.policy.tenantId !== state.policy.tenantId || receipt.state.policy.principalId !== state.policy.principalId ||
      receipt.state.goal.scope !== state.goal.scope || receipt.state.conversation?.session?.scope.agentId !== this.deps.agentId ||
      !receipt.state.artifacts.some(value => this.digest(value) === this.digest(artifact)) ||
      receipt.digest !== this.digest({ type: 'mission_checkpoint', data: { subscriptionId: subscription.id, artifact } }) ||
      this.digest(receipt.state.subscriptions?.find(value => value.id === subscription.id) ?? null) !== this.digest(subscription)) changed();
    const bytes = await this.deps.services.artifacts.get(artifact, state.policy);
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
    if (bytes.byteLength !== artifact.byteLength || Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') !== artifact.sha256) changed();
    const checkpoint = CheckpointSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (checkpoint.workId !== state.id || checkpoint.createdAt !== state.createdAt || this.identity(checkpoint.rule.id) !== subscription.id ||
      checkpoint.rule.resourceId !== subscription.resourceId || checkpoint.goalRevision !== subscription.goalRevision || checkpoint.generation !== subscription.generation ||
      checkpoint.cursor !== subscription.cursor || checkpoint.status !== subscription.status ||
      checkpoint.goalRevision !== state.goal.revision || checkpoint.generation !== dataGeneration(state)) changed();
    return checkpoint;
  }
  private async save(state: WorkState, input: Checkpoint) {
    this.access(state);
    const checkpoint = CheckpointSchema.parse(input), subscriptionId = this.identity(checkpoint.rule.id);
    const bytes = new TextEncoder().encode(JSON.stringify(checkpoint)); if (bytes.byteLength > 512 * 1024) throw new Error('mission_checkpoint_capacity');
    const artifact = await this.deps.services.artifacts.put(bytes, { tenantId: state.policy.tenantId, labels: [...state.policy.allowedLabels], mediaType: 'application/json' });
    this.access(state);
    const subscription: ExternalSubscription = { id: subscriptionId, provider: 'mission', resourceId: checkpoint.rule.resourceId,
      goalRevision: checkpoint.goalRevision, generation: checkpoint.generation, cursor: checkpoint.cursor, status: checkpoint.status, checkpointId: `mission:${artifact.sha256}` };
    return (await transact(this.deps.services, state.id, subscription.checkpointId, 'mission_checkpoint', asJson({ subscriptionId, artifact }), next => {
      if (this.digest(next) !== this.digest(state)) changed(); this.access(next);
      if (!(next.subscriptions ?? []).some(value => value.id === subscriptionId) && (next.subscriptions?.length ?? 0) >= 16) throw new Error('subscription_capacity');
      next.subscriptions = [...(next.subscriptions ?? []).filter(value => value.id !== subscriptionId), subscription];
      if (!next.artifacts.some(value => value.id === artifact.id)) next.artifacts.push(artifact);
      next.notifications = [...(next.notifications ?? []).filter(value => value.subscriptionId !== subscriptionId),
        ...checkpoint.events.map(event => ({ id: `mission-notice-${this.digest({ subscriptionId, eventId: event.id })}`, subscriptionId,
          provider: 'mission', resourceId: checkpoint.rule.resourceId, referenceId: event.referenceId,
          goalRevision: checkpoint.goalRevision, observedPlanRevision: checkpoint.observedPlanRevision, receivedAt: event.occurredAt }))];
      if (next.notifications.length > 512) throw new Error('notification_capacity');
      // Other idle mission sources must not block an event already received for this work.
      const obligationId = 'mission-wait', prior = next.obligations.find(value => value.id === obligationId);
      const active = next.subscriptions.some(value => value.provider === 'mission' && value.status === 'active');
      const status = !active || next.notifications.some(value => value.provider === 'mission') ? 'satisfied' as const : 'pending' as const;
      if (prior) prior.status = status;
      else next.obligations.push({ id: obligationId, kind: 'response', reason: 'mission_waiting_for_event', status, wakeKey: 'mission', dueAt: null });
      if (checkpoint.pendingRun && !terminal(next)) { next.status = 'ready'; next.statusReason = 'mission_event_received'; }
    }, async () => { const latest = await this.state(state.id); if (this.digest(latest) !== this.digest(state)) changed(); })).state;
  }
  private async retire(state: WorkState, subscription: ExternalSubscription) {
    return (await transact(this.deps.services, state.id, `mission-retire:${subscription.id}:${state.revision}`, 'mission_subscription_closed',
      { subscriptionId: subscription.id }, next => {
        if (this.digest(next) !== this.digest(state)) changed(); this.access(next);
        const selected = next.subscriptions!.find(value => value.id === subscription.id)!; selected.status = 'closed';
        next.notifications = (next.notifications ?? []).filter(value => value.subscriptionId !== subscription.id);
        const waiting = next.obligations.find(value => value.id === 'mission-wait');
        if (waiting) waiting.status = next.subscriptions!.some(value => value.provider === 'mission' && value.status === 'active') &&
          !next.notifications.some(value => value.provider === 'mission') ? 'pending' : 'satisfied';
      }, async () => { if (this.digest(await this.state(state.id)) !== this.digest(state)) changed(); })).state;
  }
  async register(workId: string, input: MissionRule) {
    const rule = MissionRuleSchema.parse(structuredClone(input)), state = await this.state(workId);
    if (terminal(state)) throw new Error('mission_work_closed'); this.source(state, rule.sourceId);
    const prior = state.subscriptions?.find(value => value.id === this.identity(rule.id));
    if (prior) { if (this.digest((await this.read(state, prior)).rule) !== this.digest(rule)) throw new Error('mission_idempotency_conflict'); return state; }
    return this.save(state, { schemaVersion: 1, workId, createdAt: state.createdAt, rule, goalRevision: state.goal.revision, generation: dataGeneration(state),
      cursor: 0, snapshotDigest: null, nextPollAt: this.deps.services.clock.now(), idlePolls: 0, noProgress: 0, resumes: 0,
      pendingRun: false, resumeAt: 0, observedPlanRevision: state.plan?.revision ?? 0, claim: null, progress: this.progress(state), status: 'active', reason: null, seen: [], events: [] });
  }
  async current(state: WorkState): Promise<boolean> {
    try {
      this.access(state);
      if (state.notifications?.some(value => value.provider === 'mission' && !state.subscriptions?.some(subscription =>
        subscription.provider === 'mission' && subscription.status === 'active' && subscription.id === value.subscriptionId))) return false;
      for (const subscription of state.subscriptions ?? []) if (subscription.provider === 'mission' && subscription.status === 'active') {
        const checkpoint = await this.read(state, subscription); this.source(state, checkpoint.rule.sourceId);
        const notices = state.notifications?.filter(value => value.subscriptionId === subscription.id) ?? [];
        if (notices.length !== checkpoint.events.length || notices.some(value => !checkpoint.events.some(event =>
          value.id === `mission-notice-${this.digest({ subscriptionId: subscription.id, eventId: event.id })}` && value.referenceId === event.referenceId &&
          value.observedPlanRevision === checkpoint.observedPlanRevision && value.receivedAt === event.occurredAt))) return false;
      }
      return this.digest(await this.state(state.id)) === this.digest(state);
    } catch { return false; }
  }
  async refresh(workId: string): Promise<WorkState> {
    let state = await this.state(workId); if (terminal(state)) return state;
    for (const id of (state.subscriptions ?? []).filter(value => value.provider === 'mission' && value.status === 'active').map(value => value.id)) {
      state = await this.state(workId);
      const subscription = state.subscriptions!.find(value => value.id === id)!;
      // A changed goal/deletion generation never inherits the old event body or cursor as current input.
      if (subscription.goalRevision !== state.goal.revision || subscription.generation !== dataGeneration(state)) {
        state = await this.retire(state, subscription); continue;
      }
      const checkpoint = await this.read(state, subscription), now = this.deps.services.clock.now();
      if (checkpoint.pendingRun || checkpoint.nextPollAt > now) continue;
      const source = this.source(state, checkpoint.rule.sourceId);
      const authorize = async () => { const latest = await this.state(workId); this.source(latest, checkpoint.rule.sourceId); if (this.digest(latest) !== this.digest(state)) changed(); };
      await authorize();
      let page;
      try {
        page = MissionPageSchema.parse(await source.poll({ resourceId: checkpoint.rule.resourceId, cursor: checkpoint.cursor,
          snapshotDigest: checkpoint.snapshotDigest, now, signal: this.deps.signal, authorize }));
      } catch (error) {
        try {
          await authorize(); checkpoint.idlePolls++; checkpoint.nextPollAt = now + checkpoint.rule.pollIntervalMs;
          checkpoint.reason = 'source_poll_failed';
          if (checkpoint.idlePolls >= checkpoint.rule.maxIdlePolls) checkpoint.status = 'closed';
          await this.save(state, checkpoint);
        } catch (recordError) { throw new AggregateError([error, recordError], 'mission_poll_and_checkpoint_failed', { cause: error }); }
        throw error;
      }
      await authorize();
      const observedAt = this.deps.services.clock.now();
      if (page.cursor < checkpoint.cursor || page.events.length && page.cursor === checkpoint.cursor ||
        new Set(page.events.map(value => value.id)).size !== page.events.length) throw new Error('mission_cursor_invalid');
      const fresh = page.events.filter(event => {
        if (event.occurredAt > observedAt) throw new Error('mission_future_event');
        const seen = checkpoint.seen.find(value => value.id === event.id);
        if (seen && seen.digest !== this.digest(event)) throw new Error('mission_event_identity_conflict');
        return !seen;
      });
      checkpoint.cursor = page.cursor; checkpoint.snapshotDigest = page.snapshotDigest; checkpoint.nextPollAt = observedAt + checkpoint.rule.pollIntervalMs; checkpoint.reason = null;
      checkpoint.idlePolls = fresh.length ? 0 : checkpoint.idlePolls + 1;
      if (checkpoint.seen.length + fresh.length > 512 || checkpoint.idlePolls >= checkpoint.rule.maxIdlePolls) {
        checkpoint.status = 'closed'; checkpoint.reason = checkpoint.idlePolls >= checkpoint.rule.maxIdlePolls ? 'idle_limit' : 'event_capacity';
      } else {
        checkpoint.seen.push(...fresh.map(event => ({ id: event.id, digest: this.digest(event) })));
        checkpoint.events = fresh; checkpoint.pendingRun = fresh.length > 0; checkpoint.resumeAt = now;
        if (fresh.length) checkpoint.observedPlanRevision = state.plan?.revision ?? 0;
      }
      state = await this.save(state, checkpoint);
    }
    return state;
  }
  async readEvents(workId: string, ruleId: string) {
    const state = await this.state(workId), subscription = state.subscriptions?.find(value => value.id === this.identity(ruleId));
    if (!subscription) throw new Error('mission_not_found');
    const checkpoint = await this.read(state, subscription);
    this.source(state, checkpoint.rule.sourceId);
    if (this.digest(await this.state(workId)) !== this.digest(state)) changed();
    return { rule: checkpoint.rule, events: checkpoint.events, cursor: checkpoint.cursor, status: checkpoint.status, reason: checkpoint.reason };
  }
  async list(workId: string) {
    const state = await this.state(workId), rules = [];
    for (const subscription of state.subscriptions ?? []) if (subscription.provider === 'mission' && subscription.status === 'active') {
      const checkpoint = await this.read(state, subscription); this.source(state, checkpoint.rule.sourceId);
      rules.push({ rule: checkpoint.rule, cursor: checkpoint.cursor, pendingRun: checkpoint.pendingRun, nextPollAt: checkpoint.nextPollAt });
    }
    if (this.digest(await this.state(workId)) !== this.digest(state)) changed(); return rules;
  }
  async close(workId: string, ruleId: string) {
    const state = await this.state(workId), subscription = state.subscriptions?.find(value => value.id === this.identity(ruleId));
    if (!subscription) throw new Error('mission_not_found');
    if (subscription.status === 'closed') return state;
    if (subscription.goalRevision !== state.goal.revision || subscription.generation !== dataGeneration(state)) return this.retire(state, subscription);
    const checkpoint = await this.read(state, subscription);
    checkpoint.status = 'closed'; checkpoint.events = []; checkpoint.pendingRun = false; checkpoint.claim = null; checkpoint.reason = 'host_closed';
    return this.save(state, checkpoint);
  }
  async tick(workId: string, workflow: WorkflowRuntime, options: { maxSteps?: number; signal?: AbortSignal } = {}) {
    const signal = options.signal ? AbortSignal.any([this.deps.signal, options.signal]) : this.deps.signal;
    signal.throwIfAborted();
    const state = await this.refresh(workId); if (terminal(state)) return { kind: 'idle' as const, stateRevision: state.revision };
    for (const subscription of state.subscriptions ?? []) if (subscription.provider === 'mission' && subscription.status === 'active') {
      const checkpoint = await this.read(state, subscription), now = this.deps.services.clock.now();
      if (!checkpoint.pendingRun || checkpoint.resumeAt > now || checkpoint.claim && checkpoint.claim.until > now) continue;
      if (checkpoint.resumes >= checkpoint.rule.maxResumes || checkpoint.noProgress >= checkpoint.rule.maxNoProgress) {
        checkpoint.status = 'closed'; checkpoint.reason = 'resume_limit'; checkpoint.events = []; checkpoint.pendingRun = false;
        const closed = await this.save(state, checkpoint); return { kind: 'limited' as const, stateRevision: closed.revision };
      }
      const claimOwner = `${this.#owner}:${this.deps.services.ids.next('claim')}`;
      checkpoint.resumes++; checkpoint.claim = { owner: claimOwner, until: now + 60000 };
      const claimed = await this.save(state, checkpoint);
      const owned = await this.read(claimed, claimed.subscriptions!.find(value => value.id === subscription.id)!);
      if (owned.claim?.owner !== claimOwner) return { kind: 'idle' as const, stateRevision: claimed.revision };
      const onStep = async () => {
        signal.throwIfAborted();
        const latest = await this.state(workId), current = await this.read(latest, latest.subscriptions!.find(value => value.id === subscription.id)!);
        if (current.claim?.owner !== claimOwner) changed();
        if (current.claim.until - this.deps.services.clock.now() < 30000) {
          current.claim.until = this.deps.services.clock.now() + 60000; await this.save(latest, current);
        }
      };
      signal.throwIfAborted();
      const result = await workflow.run(workId, this.#actor, { maxSteps: options.maxSteps ?? 100, expectedGoalRevision: checkpoint.goalRevision, onStep });
      const latest = await this.state(workId), current = await this.read(latest, latest.subscriptions!.find(value => value.id === subscription.id)!);
      if (current.claim?.owner !== claimOwner) changed();
      const continuing = ['continue', 'yield'].includes(result.control.kind) || result.control.kind === 'wait' && result.control.wakeAt !== null;
      const progress = this.progress(latest);
      if (!continuing) current.noProgress = progress === current.progress ? current.noProgress + 1 : 0;
      current.progress = progress; current.claim = null; current.pendingRun = continuing;
      current.resumeAt = result.control.kind === 'wait' && result.control.wakeAt !== null ? result.control.wakeAt :
        this.deps.services.clock.now() + current.rule.pollIntervalMs;
      if (!continuing) current.events = [];
      if (terminal(latest)) { current.status = 'closed'; current.reason = latest.status; current.pendingRun = false; current.events = []; }
      const saved = await this.save(latest, current);
      return { kind: 'ran' as const, result, stateRevision: saved.revision };
    }
    return { kind: 'idle' as const, stateRevision: state.revision };
  }
  async drive(workId: string, workflow: WorkflowRuntime, options: { signal: AbortSignal; maxTicks: number; intervalMs?: number; maxSteps?: number }) {
    if (!Number.isSafeInteger(options.maxTicks) || options.maxTicks < 1 || options.maxTicks > 4096) throw new Error('mission_tick_limit');
    const interval = options.intervalMs ?? 1000;
    if (!Number.isSafeInteger(interval) || interval < 100 || interval > 60000) throw new Error('mission_interval_invalid');
    const signal = AbortSignal.any([this.deps.signal, options.signal]); let ran = 0;
    for (let ticks = 0; ticks < options.maxTicks; ticks++) {
      signal.throwIfAborted(); const result = await this.tick(workId, workflow, options); if (result.kind === 'ran') ran++;
      if (result.kind === 'limited' || ticks + 1 === options.maxTicks) return { ticks: ticks + 1, ran };
      await new Promise<void>((resolve, reject) => {
        const done = () => { signal.removeEventListener('abort', stop); resolve(); };
        const timer = setTimeout(done, interval);
        const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(signal.reason); };
        signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
      });
    }
    return { ticks: options.maxTicks, ran };
  }
}
