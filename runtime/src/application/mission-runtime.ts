import { z } from 'zod';
import type { ArtifactRef, WorkState } from '../domain/model.js';
import type { ExternalSubscription } from '../domain/external-events.js';
import { dataGeneration, visibleArtifact } from '../domain/data-lifecycle.js';
import { MissionEventSchema, MissionPageSchema, MissionRuleSchema, type MissionEventSource, type MissionRule } from './mission-contracts.js';
import type { RuntimeServices } from './services.js';
import { WorkResources, type WorkActor } from './work-resources.js';
import type { WorkflowRuntime } from './workflow-runtime.js';
import { assertExecutionAuthority, executionAuthoritySignal } from './execution-authority.js';
import { asJson, taskDigest } from './plan-validator.js';
import { transact } from './work-transactions.js';
import { frozen } from './resource-contracts.js';
import type { ToolContracts } from './tool-contracts.js';
import { collaborationToolKind } from './collaboration-tool-identity.js';
import { ArtifactSchema } from './contracts.js';
import { UserCommandSchema } from './execution-runtime.js';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), hash = z.string().regex(/^[a-f0-9]{64}$/);
const CheckpointSchema = z.strictObject({ schemaVersion: z.literal(1), workId: z.string(), createdAt: count,
  rule: MissionRuleSchema, goalRevision: count.positive(), generation: count, cursor: count, snapshotDigest: z.string().max(256).nullable(),
  nextPollAt: count, idlePolls: count, noProgress: count, resumes: count, pendingRun: z.boolean(), resumeAt: count,
  observedPlanRevision: count,
  acknowledgedRead: z.strictObject({ attemptId: z.string().min(1).max(256), resultId: z.string().min(1).max(256) }).optional(),
  claim: z.strictObject({ owner: z.string(), until: count }).nullable(), progress: hash,
  status: z.enum(['active', 'closed']), reason: z.string().max(256).nullable(),
  seen: z.array(z.strictObject({ id: z.string(), digest: hash })).max(512), events: z.array(MissionEventSchema).max(32) });
type Checkpoint = z.infer<typeof CheckpointSchema>;
type CompletionPin = { commandId: string; receiptDigest: string };
const ClosurePayloadSchema = z.strictObject({ subscriptionId: z.string(), artifact: ArtifactSchema });
const ControlPayloadSchema = z.object({ actor: z.object({ tenantId: z.string(), principalId: z.string() }),
  expectedGoalRevision: count.positive(), command: UserCommandSchema });
type Dependencies = { services: RuntimeServices; actor: WorkActor; agentId: string; scope: string; signal: AbortSignal;
  sources: readonly MissionEventSource[]; contracts?: ToolContracts };
const terminal = (state: WorkState) => ['cancelled', 'paused', 'failed', 'completed', 'blocked'].includes(state.status);
function changed(): never { throw new Error('mission_state_changed'); }

/** Stop observing a poll on cancellation while retaining handlers for its eventual result or error. */
function pollUntilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (done: () => void) => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', abort); done();
    };
    const abort = () => finish(() => reject(signal.reason));
    signal.addEventListener('abort', abort, { once: true });
    void pending.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    if (signal.aborted) abort();
  });
}

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
  private signal(signal?: AbortSignal) {
    return executionAuthoritySignal(this.deps.services, signal ? AbortSignal.any([this.deps.signal, signal]) : this.deps.signal);
  }
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
  /** Validate the original publication under today's visibility, without treating an old goal as current input. */
  private async readPublication(state: WorkState, subscription: ExternalSubscription): Promise<Checkpoint> {
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
      checkpoint.cursor !== subscription.cursor || checkpoint.status !== subscription.status) changed();
    return checkpoint;
  }
  private async read(state: WorkState, subscription: ExternalSubscription): Promise<Checkpoint> {
    const checkpoint = await this.readPublication(state, subscription);
    if (checkpoint.goalRevision !== state.goal.revision || checkpoint.generation !== dataGeneration(state)) changed();
    return checkpoint;
  }
  /** A control receipt may retire its exact prior head; it does not authorize importing that body into a new goal. */
  private async controlProof(state: WorkState, subscription: ExternalSubscription, signal: AbortSignal) {
    signal.throwIfAborted(); this.access(state);
    const publication = await this.deps.services.state.receipt(state.id, subscription.checkpointId);
    const original = publication?.state.subscriptions?.find(value => value.id === subscription.id);
    if (!publication || !original || original.status !== 'active' ||
      this.digest({ ...original, status: subscription.status }) !== this.digest(subscription)) changed();
    const checkpoint = await this.readPublication(state, original);
    if (checkpoint.generation !== dataGeneration(state) || dataGeneration(publication.state) !== dataGeneration(state) ||
      this.digest(publication.state.policy) !== this.digest(state.policy) ||
      this.digest(publication.state.conversation?.session?.scope ?? null) !== this.digest(state.conversation?.session?.scope ?? null)) changed();
    this.source(state, checkpoint.rule.sourceId);
    const events = await this.deps.services.state.events(state.id, 0);
    for (const event of events.toReversed()) {
      if (event.type !== 'user_command' || event.revision <= publication.state.revision) continue;
      const parsed = ControlPayloadSchema.safeParse(event.data.payload); if (!parsed.success) continue;
      const { actor, expectedGoalRevision, command } = parsed.data;
      if (expectedGoalRevision !== checkpoint.goalRevision ||
        !(command.kind === 'goal' || command.kind === 'cancel' || command.kind === 'pause')) continue;
      if ((command.kind === 'pause') !== (subscription.status === 'active')) continue;
      const receipt = await this.deps.services.state.receipt(state.id, event.commandId);
      const controlled = receipt?.state, selected = controlled?.subscriptions?.find(value => value.id === subscription.id);
      // Ignore commands for another checkpoint, including a pause before this driver acquired its claim.
      if (!selected || selected.checkpointId !== subscription.checkpointId) continue;
      const closing = command.kind !== 'pause';
      if (!receipt || !controlled || event.workId !== state.id || event.revision !== controlled.revision || event.at !== controlled.updatedAt ||
        event.revision > state.revision || this.digest(event.data) !== this.digest({ payload: event.data.payload }) ||
        receipt.digest !== this.digest({ type: 'user_command', data: event.data.payload }) ||
        controlled.id !== state.id || controlled.createdAt !== state.createdAt ||
        actor.tenantId !== state.policy.tenantId || actor.principalId !== state.policy.principalId ||
        this.digest(controlled.policy) !== this.digest(state.policy) || dataGeneration(controlled) !== dataGeneration(state) ||
        this.digest(controlled.conversation?.session?.scope ?? null) !== this.digest(state.conversation?.session?.scope ?? null) ||
        controlled.goal.scope !== state.goal.scope ||
        this.digest(selected) !== this.digest({ ...original, status: closing ? 'closed' : 'active' })) changed();
      if (command.kind === 'goal') {
        if (subscription.status !== 'closed' || command.goal.revision !== checkpoint.goalRevision + 1 ||
          this.digest(controlled.goal) !== this.digest(command.goal) || controlled.status !== 'ready' || controlled.statusReason !== 'goal_changed' ||
          state.goal.revision < controlled.goal.revision) changed();
      } else if (this.digest(controlled.goal) !== this.digest(publication.state.goal) ||
        this.digest(state.goal) !== this.digest(controlled.goal) || controlled.status !== (closing ? 'cancelled' : 'paused') ||
        state.status !== controlled.status || controlled.statusReason !== command.reason || state.statusReason !== command.reason ||
        subscription.status !== (closing ? 'closed' : 'active')) changed();
      signal.throwIfAborted();
      return { checkpoint, reason: command.kind === 'goal' ? 'goal_changed' : closing ? 'cancelled' : 'paused',
        proof: this.digest({ publication, commandId: event.commandId, event, receipt }) };
    }
    return changed();
  }
  private async settleControls(state: WorkState, signal: AbortSignal) {
    if (state.status === 'completed') return state;
    for (const id of (state.subscriptions ?? []).filter(value => value.provider === 'mission' &&
      (state.status === 'paused' && value.status === 'active' || value.status === 'closed' &&
        (state.status === 'cancelled' || value.goalRevision !== state.goal.revision))).map(value => value.id)) {
      const subscription = state.subscriptions!.find(value => value.id === id)!;
      const publication = await this.deps.services.state.receipt(state.id, subscription.checkpointId);
      const original = publication?.state.subscriptions?.find(value => value.id === id);
      if (!original) changed();
      // A host-closed or already retired head remains byte-for-byte historical.
      if (original.status === 'closed') continue;
      if (state.status === 'paused' && !(await this.read(state, subscription)).claim) continue;
      const basis = state, proof = await this.controlProof(basis, subscription, signal);
      const checkpoint = { ...proof.checkpoint, claim: null };
      if (proof.reason !== 'paused') { checkpoint.status = 'closed'; checkpoint.reason = proof.reason; checkpoint.pendingRun = false; }
      state = await this.save(basis, checkpoint, signal, async () => {
        if ((await this.controlProof(basis, subscription, signal)).proof !== proof.proof) changed();
      });
    }
    return state;
  }
  private completedBody(checkpoint: Checkpoint): Checkpoint {
    return { ...structuredClone(checkpoint), status: 'closed', reason: 'completed', claim: null, pendingRun: false };
  }
  private completedSubscription(checkpoint: Checkpoint, artifact: ArtifactRef): ExternalSubscription {
    return { id: this.identity(checkpoint.rule.id), provider: 'mission', resourceId: checkpoint.rule.resourceId,
      goalRevision: checkpoint.goalRevision, generation: checkpoint.generation, cursor: checkpoint.cursor,
      status: 'closed', checkpointId: `mission:${artifact.sha256}` };
  }
  /** The same narrow transition is used for publication and full-state replay of prior publications. */
  private applyCompletedBody(state: WorkState, checkpoint: Checkpoint, artifact: ArtifactRef) {
    const subscription = this.completedSubscription(checkpoint, artifact);
    state.subscriptions = [...(state.subscriptions ?? []).filter(value => value.id !== subscription.id), subscription];
    const existing = state.artifacts.find(value => value.id === artifact.id);
    if (existing && this.digest(existing) !== this.digest(artifact)) changed();
    if (!existing) state.artifacts.push(artifact);
    state.notifications = (state.notifications ?? []).filter(value => value.provider !== 'mission' || value.subscriptionId !== subscription.id);
    const waiting = state.obligations.find(value => value.id === 'mission-wait');
    if (!waiting) changed(); waiting.status = 'satisfied';
  }
  /** Only original completion plus an ordered chain of exact mission closures can authorize recovery. */
  private async completedProof(state: WorkState, signal: AbortSignal, pin?: CompletionPin) {
    signal.throwIfAborted(); this.access(state);
    if (state.status !== 'completed' || state.statusReason !== 'criteria_verified') changed();
    const events = await this.deps.services.state.events(state.id, 0);
    const index = events.findLastIndex(value => value.type === 'control_selected' &&
      (pin ? value.commandId === pin.commandId : this.digest(value.data) === this.digest({ payload: { kind: 'complete', reason: 'criteria_verified' } })));
    const event = events[index]; if (!event) changed();
    const commandId = event.commandId;
    const receipt = await this.deps.services.state.receipt(state.id, commandId);
    if (!receipt || commandId !== `control:${receipt.state.revision - 1}` || receipt.state.revision > state.revision ||
      event.workId !== state.id || event.revision !== receipt.state.revision || event.at !== receipt.state.updatedAt ||
      this.digest(event.data) !== this.digest({ payload: { kind: 'complete', reason: 'criteria_verified' } }) ||
      receipt.digest !== this.digest({ type: 'control_selected', data: { kind: 'complete', reason: 'criteria_verified' } }) ||
      pin && pin.receiptDigest !== this.digest(receipt) ||
      receipt.state.status !== state.status || receipt.state.statusReason !== state.statusReason || receipt.state.id !== state.id ||
      receipt.state.createdAt !== state.createdAt || this.digest(receipt.state.policy) !== this.digest(state.policy) ||
      this.digest(receipt.state.goal) !== this.digest(state.goal) || dataGeneration(receipt.state) !== dataGeneration(state) ||
      this.digest(receipt.state.executionControl ?? null) !== this.digest(state.executionControl ?? null) ||
      this.digest(receipt.state.conversation?.session ?? null) !== this.digest(state.conversation?.session ?? null)) changed();
    const entries = new Map<string, { original: Checkpoint; closed: boolean }>();
    for (const subscription of receipt.state.subscriptions ?? []) {
      if (subscription.provider !== 'mission') continue;
      if (subscription.status !== 'closed') changed();
      // Historical retired rules remain historical; completion never imports them into the current goal or data generation.
      if (subscription.goalRevision !== state.goal.revision || subscription.generation !== dataGeneration(state)) continue;
      const original = await this.deps.services.state.receipt(state.id, subscription.checkpointId);
      const prior = original?.state.subscriptions?.find(value => value.id === subscription.id);
      if (!prior || original!.state.revision >= receipt.state.revision ||
        this.digest({ ...prior, status: 'closed' }) !== this.digest(subscription)) changed();
      // The exact original subscription permits reading the pre-completion body privately. Public reads stay strict.
      const checkpoint = await this.read(state, prior);
      if (prior.status === 'closed') continue;
      if (checkpoint.events.length && !checkpoint.acknowledgedRead) changed();
      this.source(state, checkpoint.rule.sourceId);
      if (entries.has(subscription.id)) changed();
      entries.set(subscription.id, { original: checkpoint, closed: false });
    }
    let reconstructed = structuredClone(receipt.state), sequence = event.sequence;
    for (const closure of events.slice(index + 1)) {
      const parsed = ClosurePayloadSchema.safeParse(closure.data.payload);
      if (closure.type !== 'mission_checkpoint' || !parsed.success || closure.workId !== state.id ||
        closure.sequence !== sequence + 1 || closure.revision !== reconstructed.revision + 1 ||
        this.digest(closure.data) !== this.digest({ payload: parsed.data })) changed();
      const { subscriptionId, artifact } = parsed.data, entry = entries.get(subscriptionId);
      if (!entry || entry.closed || closure.commandId !== `mission:${artifact.sha256}` ||
        !state.artifacts.some(value => this.digest(value) === this.digest(artifact))) changed();
      const closed = this.completedBody(entry.original), subscription = this.completedSubscription(closed, artifact);
      if (this.digest(await this.read(state, subscription)) !== this.digest(closed)) changed();
      const published = await this.deps.services.state.receipt(state.id, closure.commandId);
      if (!published || published.digest !== this.digest({ type: 'mission_checkpoint', data: parsed.data })) changed();
      this.applyCompletedBody(reconstructed, closed, artifact);
      reconstructed.revision++; reconstructed.updatedAt = closure.at;
      if (this.digest(reconstructed) !== this.digest(published.state)) changed();
      entry.closed = true; sequence = closure.sequence;
    }
    if (this.digest(reconstructed) !== this.digest(state)) changed();
    signal.throwIfAborted(); const latest = await this.state(state.id); signal.throwIfAborted();
    if (this.digest(latest) !== this.digest(state)) changed();
    return { commandId, receiptDigest: this.digest(receipt), entries };
  }
  private async completedCheckpoint(state: WorkState, subscriptionId: string, claimOwner: string, signal: AbortSignal, pin?: CompletionPin) {
    const proof = await this.completedProof(state, signal, pin), checkpoint = proof.entries.get(subscriptionId)?.original;
    if (!checkpoint || checkpoint.claim?.owner !== claimOwner || !checkpoint.pendingRun) changed();
    return { commandId: proof.commandId, receiptDigest: proof.receiptDigest };
  }
  private async finishCompleted(workId: string, signal: AbortSignal, expected?: CompletionPin) {
    let pin = expected;
    // At most 16 subscriptions; allow bounded competing publications without following a different completion.
    for (let retry = 0; retry < 32; retry++) {
      const state = await this.state(workId); signal.throwIfAborted();
      if (state.status !== 'completed') changed();
      try {
        const proof = await this.completedProof(state, signal, pin);
        pin ??= { commandId: proof.commandId, receiptDigest: proof.receiptDigest };
        const entry = [...proof.entries.values()].find(value => !value.closed);
        if (!entry) return state;
        const checkpoint = this.completedBody(entry.original), subscriptionId = this.identity(checkpoint.rule.id);
        const bytes = new TextEncoder().encode(JSON.stringify(checkpoint));
        if (bytes.byteLength > 512 * 1024) throw new Error('mission_checkpoint_capacity');
        const artifact = await this.deps.services.artifacts.put(bytes,
          { tenantId: state.policy.tenantId, labels: [...state.policy.allowedLabels], mediaType: 'application/json' });
        signal.throwIfAborted(); this.access(state);
        await transact(this.deps.services, workId, `mission:${artifact.sha256}`, 'mission_checkpoint', asJson({ subscriptionId, artifact }), next => {
          signal.throwIfAborted(); this.access(next); if (this.digest(next) !== this.digest(state)) changed();
          this.applyCompletedBody(next, checkpoint, artifact);
        }, async () => { await this.completedProof(state, signal, pin); });
        // The next iteration checks the real head even when transact returned a duplicate without beforeCommit.
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'mission_state_changed') throw error;
        const latest = await this.state(workId); signal.throwIfAborted();
        if (latest.revision === state.revision || latest.status !== 'completed' ||
          this.digest(latest.goal) !== this.digest(state.goal) || this.digest(latest.policy) !== this.digest(state.policy) ||
          dataGeneration(latest) !== dataGeneration(state) ||
          this.digest(latest.conversation?.session ?? null) !== this.digest(state.conversation?.session ?? null)) throw error;
      }
    }
    throw new Error('mission_state_changed');
  }
  private async save(state: WorkState, input: Checkpoint, signal = this.deps.signal, validate?: () => Promise<void>) {
    signal.throwIfAborted(); this.access(state);
    const checkpoint = CheckpointSchema.parse(input), subscriptionId = this.identity(checkpoint.rule.id);
    let processing = checkpoint.status === 'active' && checkpoint.pendingRun;
    for (const other of state.subscriptions ?? []) if (!processing && other.provider === 'mission' && other.status === 'active' && other.id !== subscriptionId)
      processing = (await this.read(state, other)).pendingRun;
    signal.throwIfAborted();
    const bytes = new TextEncoder().encode(JSON.stringify(checkpoint)); if (bytes.byteLength > 512 * 1024) throw new Error('mission_checkpoint_capacity');
    const artifact = await this.deps.services.artifacts.put(bytes, { tenantId: state.policy.tenantId, labels: [...state.policy.allowedLabels], mediaType: 'application/json' });
    signal.throwIfAborted(); this.access(state);
    const subscription: ExternalSubscription = { id: subscriptionId, provider: 'mission', resourceId: checkpoint.rule.resourceId,
      goalRevision: checkpoint.goalRevision, generation: checkpoint.generation, cursor: checkpoint.cursor, status: checkpoint.status, checkpointId: `mission:${artifact.sha256}` };
    return (await transact(this.deps.services, state.id, subscription.checkpointId, 'mission_checkpoint', asJson({ subscriptionId, artifact }), next => {
      signal.throwIfAborted(); if (this.digest(next) !== this.digest(state)) changed(); this.access(next);
      if (!(next.subscriptions ?? []).some(value => value.id === subscriptionId) && (next.subscriptions?.length ?? 0) >= 16) throw new Error('subscription_capacity');
      next.subscriptions = [...(next.subscriptions ?? []).filter(value => value.id !== subscriptionId), subscription];
      if (!next.artifacts.some(value => value.id === artifact.id)) next.artifacts.push(artifact);
      next.notifications = [...(next.notifications ?? []).filter(value => value.provider !== 'mission' || value.subscriptionId !== subscriptionId),
        ...(checkpoint.status === 'closed' || checkpoint.acknowledgedRead ? [] : checkpoint.events).map(event => ({ id: `mission-notice-${this.digest({ subscriptionId, eventId: event.id })}`, subscriptionId,
          provider: 'mission', resourceId: checkpoint.rule.resourceId, referenceId: event.referenceId,
          goalRevision: checkpoint.goalRevision, observedPlanRevision: checkpoint.observedPlanRevision, receivedAt: event.occurredAt }))];
      if (next.notifications.length > 512) throw new Error('notification_capacity');
      // Other idle mission sources must not block an event already received for this work.
      const obligationId = 'mission-wait', prior = next.obligations.find(value => value.id === obligationId);
      const active = next.subscriptions.some(value => value.provider === 'mission' && value.status === 'active');
      const status = !active || processing || next.notifications.some(value => value.provider === 'mission') ? 'satisfied' as const : 'pending' as const;
      if (prior) prior.status = status;
      else next.obligations.push({ id: obligationId, kind: 'response', reason: 'mission_waiting_for_event', status, wakeKey: 'mission', dueAt: null });
      if (checkpoint.pendingRun && !terminal(next)) { next.status = 'ready'; next.statusReason = 'mission_event_received'; }
    }, async () => {
      signal.throwIfAborted(); await validate?.(); const latest = await this.state(state.id); signal.throwIfAborted();
      if (this.digest(latest) !== this.digest(state)) changed();
    })).state;
  }
  private async readAcknowledgement(state: WorkState, subscription: ExternalSubscription, attemptId: string, signal: AbortSignal) {
    const contracts = this.deps.contracts, attempt = state.attempts.find(value => value.id === attemptId);
    const entry = contracts?.get('mission.events', '1');
    if (!contracts || collaborationToolKind(entry?.tool) !== 'mission' || !attempt || attempt.toolId !== 'mission.events' || attempt.toolVersion !== '1' ||
      attempt.status !== 'succeeded' || !attempt.adopted || attempt.error || attempt.effect !== 'read' || attempt.effectState !== 'none' ||
      attempt.reuse || attempt.execution?.mode !== 'invoked' || !attempt.resultArtifact || attempt.resultArtifact.byteLength > 512 * 1024 ||
      attempt.goalRevision !== state.goal.revision || attempt.scope !== state.goal.scope || !attempt.contractDigest ||
      attempt.contractDigest !== this.digest(entry!.tool.definition)) return null;
    const checkpoint = await this.read(state, subscription);
    const resources = new WorkResources(this.deps.services.state, this.deps.services.artifacts, contracts, this.deps.services.digester,
      this.deps.services.knowledge, undefined, this.deps.services.effects, this.deps.services.inputs);
    const { materialized: { task, result } } = await resources.resultWithDependencies(state.id, this.#actor, attempt.id, 65536);
    const request = z.strictObject({ ruleId: z.string(), maxBytes: count.min(512).max(262144) }).safeParse(task.input);
    if (!request.success || request.data.ruleId !== checkpoint.rule.id || contracts.check(task, state.policy) ||
      taskDigest(task, this.deps.services.digester) !== attempt.inputDigest || result.status !== 'success' || result.coverage !== 'complete' ||
      result.effectState !== 'none' || result.error || result.reuse || result.evidence.length || result.artifacts.length || result.cursor !== null ||
      this.digest(result.output) !== this.digest({ kind: 'unreviewed_mission_events', rule: checkpoint.rule, events: checkpoint.events,
        cursor: checkpoint.cursor, status: checkpoint.status, reason: checkpoint.reason })) return null;
    const received = await this.deps.services.state.receipt(state.id, `receive:${attempt.id}`);
    const adopted = await this.deps.services.state.receipt(state.id, `adopt:${attempt.id}`);
    if (!received || received.state.id !== state.id || received.digest !== this.digest({ type: 'result_received', data: { attemptId: attempt.id, artifactId: attempt.resultArtifact.id } }) ||
      this.digest(received.state.attempts.find(value => value.id === attempt.id)?.resultArtifact ?? null) !== this.digest(attempt.resultArtifact) ||
      !adopted || adopted.state.id !== state.id || adopted.digest !== this.digest({ type: 'result_settled', data: { attemptId: attempt.id, resultId: result.resultId } }) ||
      this.digest(adopted.state.attempts.find(value => value.id === attempt.id) ?? null) !== this.digest(attempt)) return null;
    signal.throwIfAborted(); const latest = await this.state(state.id); signal.throwIfAborted();
    if (this.digest(latest) !== this.digest(state) || contracts.get('mission.events', '1') !== entry) changed();
    return { entry, acknowledgement: { attemptId: attempt.id, resultId: result.resultId } };
  }
  private async acknowledgeReads(state: WorkState, signal: AbortSignal) {
    if (!this.deps.contracts) return state;
    for (const id of (state.subscriptions ?? []).filter(value => value.provider === 'mission' && value.status === 'active').map(value => value.id)) {
      const subscription = state.subscriptions!.find(value => value.id === id)!;
      if (subscription.goalRevision !== state.goal.revision || subscription.generation !== dataGeneration(state)) continue;
      const checkpoint = await this.read(state, subscription);
      if (!checkpoint.pendingRun || !checkpoint.events.length || checkpoint.acknowledgedRead) continue;
      for (const attempt of state.attempts) {
        const proof = await this.readAcknowledgement(state, subscription, attempt.id, signal); if (!proof) continue;
        const basis = state;
        checkpoint.acknowledgedRead = proof.acknowledgement;
        state = await this.save(basis, checkpoint, signal, async () => {
          const current = await this.readAcknowledgement(basis, subscription, attempt.id, signal);
          if (!current || current.entry !== proof.entry || this.digest(current.acknowledgement) !== this.digest(proof.acknowledgement)) changed();
        });
        break;
      }
    }
    return state;
  }
  private async retire(state: WorkState, subscription: ExternalSubscription, signal = this.deps.signal) {
    signal.throwIfAborted();
    return (await transact(this.deps.services, state.id, `mission-retire:${subscription.id}:${state.revision}`, 'mission_subscription_closed',
      { subscriptionId: subscription.id }, next => {
        signal.throwIfAborted(); if (this.digest(next) !== this.digest(state)) changed(); this.access(next);
        const selected = next.subscriptions!.find(value => value.id === subscription.id)!; selected.status = 'closed';
        next.notifications = (next.notifications ?? []).filter(value => value.subscriptionId !== subscription.id);
        const waiting = next.obligations.find(value => value.id === 'mission-wait');
        if (waiting) waiting.status = next.subscriptions!.some(value => value.provider === 'mission' && value.status === 'active') &&
          !next.notifications.some(value => value.provider === 'mission') ? 'pending' : 'satisfied';
      }, async () => { signal.throwIfAborted(); const latest = await this.state(state.id); signal.throwIfAborted(); if (this.digest(latest) !== this.digest(state)) changed(); })).state;
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
        const notices = state.notifications?.filter(value => value.provider === 'mission' && value.subscriptionId === subscription.id) ?? [];
        const events = checkpoint.acknowledgedRead ? [] : checkpoint.events;
        if (notices.length !== events.length || notices.some(value => !events.some(event =>
          value.id === `mission-notice-${this.digest({ subscriptionId: subscription.id, eventId: event.id })}` && value.referenceId === event.referenceId &&
          value.observedPlanRevision === checkpoint.observedPlanRevision && value.receivedAt === event.occurredAt))) return false;
      }
      return this.digest(await this.state(state.id)) === this.digest(state);
    } catch { return false; }
  }
  async refresh(workId: string, options: { signal?: AbortSignal } = {}): Promise<WorkState> {
    const signal = this.signal(options.signal); signal.throwIfAborted();
    let state = await this.settleControls(await this.state(workId), signal); signal.throwIfAborted(); if (terminal(state)) return state;
    state = await this.acknowledgeReads(state, signal);
    for (const id of (state.subscriptions ?? []).filter(value => value.provider === 'mission' && value.status === 'active').map(value => value.id)) {
      state = await this.state(workId); signal.throwIfAborted();
      const subscription = state.subscriptions!.find(value => value.id === id)!;
      if (subscription.status !== 'active' || terminal(state)) return this.settleControls(state, signal);
      // A changed goal/deletion generation never inherits the old event body or cursor as current input.
      if (subscription.goalRevision !== state.goal.revision || subscription.generation !== dataGeneration(state)) {
        state = await this.retire(state, subscription, signal); continue;
      }
      const checkpoint = await this.read(state, subscription), now = this.deps.services.clock.now();
      signal.throwIfAborted();
      if (checkpoint.pendingRun || checkpoint.nextPollAt > now) continue;
      const source = this.source(state, checkpoint.rule.sourceId);
      const authorize = async () => { signal.throwIfAborted(); const latest = await this.state(workId); signal.throwIfAborted(); this.source(latest, checkpoint.rule.sourceId); if (this.digest(latest) !== this.digest(state)) changed(); };
      await authorize();
      let page;
      try {
        signal.throwIfAborted();
        const observed = await pollUntilAborted(source.poll({ resourceId: checkpoint.rule.resourceId, cursor: checkpoint.cursor,
          snapshotDigest: checkpoint.snapshotDigest, now, signal, authorize }), signal);
        signal.throwIfAborted(); page = MissionPageSchema.parse(observed);
      } catch (error) {
        // An interrupted observation is not a completed failed poll and must not advance its checkpoint.
        if (signal.aborted) throw error;
        try {
          await authorize(); checkpoint.idlePolls++; checkpoint.nextPollAt = now + checkpoint.rule.pollIntervalMs;
          checkpoint.reason = 'source_poll_failed';
          if (checkpoint.idlePolls >= checkpoint.rule.maxIdlePolls) checkpoint.status = 'closed';
          await this.save(state, checkpoint, signal);
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
      delete checkpoint.acknowledgedRead;
      checkpoint.idlePolls = fresh.length ? 0 : checkpoint.idlePolls + 1;
      if (checkpoint.seen.length + fresh.length > 512 || checkpoint.idlePolls >= checkpoint.rule.maxIdlePolls) {
        checkpoint.status = 'closed'; checkpoint.reason = checkpoint.idlePolls >= checkpoint.rule.maxIdlePolls ? 'idle_limit' : 'event_capacity';
      } else {
        checkpoint.seen.push(...fresh.map(event => ({ id: event.id, digest: this.digest(event) })));
        checkpoint.events = fresh; checkpoint.pendingRun = fresh.length > 0; checkpoint.resumeAt = now;
        if (fresh.length) checkpoint.observedPlanRevision = state.plan?.revision ?? 0;
      }
      state = await this.save(state, checkpoint, signal);
    }
    signal.throwIfAborted();
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
    checkpoint.status = 'closed'; checkpoint.events = []; delete checkpoint.acknowledgedRead; checkpoint.pendingRun = false; checkpoint.claim = null; checkpoint.reason = 'host_closed';
    return this.save(state, checkpoint);
  }
  async tick(workId: string, workflow: WorkflowRuntime, options: { maxSteps?: number; signal?: AbortSignal } = {}) {
    const signal = this.signal(options.signal);
    signal.throwIfAborted();
    const state = await this.refresh(workId, { signal }); signal.throwIfAborted();
    if (state.status === 'completed') return { kind: 'idle' as const, stateRevision: (await this.finishCompleted(workId, signal)).revision };
    if (terminal(state)) return { kind: 'idle' as const, stateRevision: state.revision };
    for (const subscription of state.subscriptions ?? []) if (subscription.provider === 'mission' && subscription.status === 'active') {
      const checkpoint = await this.read(state, subscription), now = this.deps.services.clock.now();
      signal.throwIfAborted();
      if (!checkpoint.pendingRun || checkpoint.resumeAt > now || checkpoint.claim && checkpoint.claim.until > now) continue;
      if (checkpoint.resumes >= checkpoint.rule.maxResumes || checkpoint.noProgress >= checkpoint.rule.maxNoProgress) {
        checkpoint.status = 'closed'; checkpoint.reason = 'resume_limit'; checkpoint.events = []; delete checkpoint.acknowledgedRead; checkpoint.pendingRun = false;
        const closed = await this.save(state, checkpoint, signal); return { kind: 'limited' as const, stateRevision: closed.revision };
      }
      const claimOwner = `${this.#owner}:${this.deps.services.ids.next('claim')}`;
      checkpoint.resumes++; checkpoint.claim = { owner: claimOwner, until: now + 60000 };
      const claimed = await this.save(state, checkpoint, signal);
      const owned = await this.read(claimed, claimed.subscriptions!.find(value => value.id === subscription.id)!);
      if (owned.claim?.owner !== claimOwner) return { kind: 'idle' as const, stateRevision: claimed.revision };
      let completion: CompletionPin | null = null;
      const stopped = new Error('mission_control_interrupted');
      const stopForControl = async (observed: WorkState) => {
        if (observed.status !== 'paused' && observed.status !== 'cancelled' && observed.goal.revision === checkpoint.goalRevision) return false;
        await this.settleControls(observed, signal); return true;
      };
      const onStep = async () => {
        signal.throwIfAborted();
        const observed = await this.state(workId);
        if (await stopForControl(observed)) throw stopped;
        if (observed.status === 'completed') {
          completion = await this.completedCheckpoint(observed, subscription.id, claimOwner, signal, completion ?? undefined); return;
        }
        if (completion) changed();
        const latest = await this.acknowledgeReads(observed, signal), current = await this.read(latest, latest.subscriptions!.find(value => value.id === subscription.id)!);
        signal.throwIfAborted();
        if (current.claim?.owner !== claimOwner) changed();
        if (current.claim.until - this.deps.services.clock.now() < 30000) {
          current.claim.until = this.deps.services.clock.now() + 60000; await this.save(latest, current, signal);
        }
      };
      signal.throwIfAborted();
      let result: Awaited<ReturnType<WorkflowRuntime['run']>>;
      try {
        if (await stopForControl(await this.state(workId))) throw stopped;
        result = await workflow.run(workId, this.#actor, { maxSteps: options.maxSteps ?? 100, expectedGoalRevision: checkpoint.goalRevision, onStep });
      } catch (error) {
        // Only our own onStep stop has no workflow result. Provider/worker exceptions retain their original identity.
        if (error !== stopped) throw error;
        return { kind: 'idle' as const, stateRevision: (await this.state(workId)).revision };
      }
      signal.throwIfAborted();
      const latest = await this.state(workId);
      if (await stopForControl(latest)) return { kind: 'idle' as const, stateRevision: (await this.state(workId)).revision };
      // Publish all remaining closures only after workflow.run returns its final snapshot.
      const closed = completion as CompletionPin | null;
      if (latest.status === 'completed') {
        if (!closed || result.control.kind !== 'complete') changed();
        const saved = await this.finishCompleted(workId, signal, closed);
        return { kind: 'ran' as const, result, stateRevision: saved.revision };
      }
      if (closed) changed();
      const current = await this.read(latest, latest.subscriptions!.find(value => value.id === subscription.id)!);
      if (current.claim?.owner !== claimOwner) changed();
      const continuing = ['continue', 'yield'].includes(result.control.kind) || result.control.kind === 'wait' && result.control.wakeAt !== null;
      const progress = this.progress(latest);
      if (!continuing) current.noProgress = progress === current.progress ? current.noProgress + 1 : 0;
      current.progress = progress; current.claim = null; current.pendingRun = continuing;
      current.resumeAt = result.control.kind === 'wait' && result.control.wakeAt !== null ? result.control.wakeAt :
        this.deps.services.clock.now() + current.rule.pollIntervalMs;
      if (!continuing) { current.events = []; delete current.acknowledgedRead; }
      if (terminal(latest)) { current.status = 'closed'; current.reason = latest.status; current.pendingRun = false; current.events = []; delete current.acknowledgedRead; }
      const saved = await this.save(latest, current, signal);
      return { kind: 'ran' as const, result, stateRevision: saved.revision };
    }
    return { kind: 'idle' as const, stateRevision: state.revision };
  }
  async drive(workId: string, workflow: WorkflowRuntime, options: { signal: AbortSignal; maxTicks: number; intervalMs?: number; maxSteps?: number }) {
    if (!Number.isSafeInteger(options.maxTicks) || options.maxTicks < 1 || options.maxTicks > 4096) throw new Error('mission_tick_limit');
    const interval = options.intervalMs ?? 1000;
    if (!Number.isSafeInteger(interval) || interval < 100 || interval > 60000) throw new Error('mission_interval_invalid');
    const signal = this.signal(options.signal); let ran = 0;
    for (let ticks = 0; ticks < options.maxTicks; ticks++) {
      signal.throwIfAborted(); const result = await this.tick(workId, workflow, { ...options, signal }); signal.throwIfAborted(); if (result.kind === 'ran') ran++;
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
