import { z } from 'zod';
import { authorizedWork } from '../application/work-resources.js';
import type { WorkActor } from '../application/work-resources.js';
import type { AgentTurnService } from '../application/agent-turn-service.js';
import { AcceptRequestSchema } from '../application/conversation-service.js';
import type { SessionScope } from '../domain/session.js';
import { openAgentTurnProfile, type AgentTurnProfile, type AgentTurnProfileOptions } from './agent-turn-profile.js';
import { closeAgentTurnResources } from './host-models.js';
import type { AgentExecutionHost } from './host-tools.js';

const id = z.string().min(1).max(256);
const RouteSchema = z.strictObject({ tenantId: id, principalId: id, conversationId: id, sessionId: id.optional() });
export type KnoxRoute = z.infer<typeof RouteSchema>;
type FollowUp = Omit<Parameters<AgentTurnService['followUp']>[1], 'sessionId'>;
type GoalChange = Omit<Parameters<AgentTurnService['changeGoal']>[1], 'sessionId'>;

/** One authenticated recipient/conversation. The host must route each inbound sender to its own instance. */
export class KnoxConversation {
  readonly #runs = new Map<string, Promise<unknown>>();
  #closing = false;
  constructor(private readonly profile: AgentTurnProfile, private readonly route: KnoxRoute,
    private readonly scope: SessionScope, private readonly destination: string) {}
  private get actor(): WorkActor { return this.profile.actor; }
  private assertOpen() { if (this.#closing) throw new Error('messenger_closed'); }
  private async work(workId: string) {
    this.assertOpen();
    const state = await authorizedWork(this.profile.services.state, workId, this.actor);
    this.assertOpen();
    const scope = state.conversation?.session?.scope;
    if (!scope || scope.agentId !== this.scope.agentId || scope.sessionId !== this.scope.sessionId ||
      scope.tenantId !== this.scope.tenantId || scope.principalId !== this.scope.principalId ||
      !state.conversation?.bindings.some(b => b.channel === 'knox' && b.conversationId === this.route.conversationId &&
        b.destination === this.destination && b.recipientId === this.actor.principalId && b.session?.sessionId === this.scope.sessionId))
      throw new Error('session_work_unavailable');
    return state;
  }
  get sessionId() { return this.scope.sessionId; }

  /** Persist and acknowledge first. The caller can return to its webhook before starting run(). */
  async accept(input: { messageId: string; rawText: string; mode?: 'auto' | 'fast' | 'deep' }) {
    this.assertOpen();
    const result = await this.profile.turns.accept(this.actor, { sessionId: this.sessionId, messageId: input.messageId,
      rawText: input.rawText, mode: input.mode ?? 'auto', scope: this.profile.scope,
      binding: { channel: 'knox', conversationId: this.route.conversationId, destination: this.destination,
        recipientId: this.actor.principalId, tenantId: this.actor.tenantId, principalId: this.actor.principalId },
      policy: this.profile.policy, limits: this.profile.limits });
    await this.profile.outbox.flush(result.workId, this.actor);
    return { workId: result.workId, accepted: result.accepted, sessionId: this.sessionId, goalRevision: result.state.goal.revision };
  }
  async followUp(input: FollowUp) {
    await this.work(input.workId);
    return this.profile.turns.followUp(this.actor, { ...input, sessionId: this.sessionId });
  }
  async changeGoal(input: GoalChange) {
    await this.work(input.workId);
    return this.profile.turns.changeGoal(this.actor, { ...input, sessionId: this.sessionId });
  }
  async control(input: { workId: string; messageId: string; rawText: string; expectedGoalRevision: number;
    kind: 'pause' | 'resume' | 'cancel' }) {
    await this.work(input.workId);
    return this.profile.sessions.command(this.actor, { sessionId: this.sessionId, workId: input.workId,
      messageId: input.messageId, rawText: input.rawText, expectedGoalRevision: input.expectedGoalRevision,
      command: { kind: input.kind, reason: 'messenger_user_command' } });
  }
  async status(workId: string) {
    await this.work(workId);
    return this.profile.workView.read(workId, this.actor, { channel: 'knox', conversationId: this.route.conversationId,
      destination: this.destination, recipientId: this.actor.principalId, allowDiagnostics: false }, { level: 'conversation' });
  }
  async history(options: { limit?: number; cursor?: string } = {}) {
    this.assertOpen();
    return this.profile.sessions.history(this.actor, this.sessionId, this.profile.policy,
      { limit: options.limit ?? 50, ...(options.cursor === undefined ? {} : { cursor: options.cursor }) });
  }
  /** Call only for a newly accepted request or an explicit resume, never automatically on redelivery. */
  async run(workId: string, options: { maxSteps?: number; expectedGoalRevision?: number } = {}) {
    this.assertOpen();
    if (this.#runs.has(workId)) throw new Error('messenger_work_running');
    const pending = this.runSelected(workId, options);
    this.#runs.set(workId, pending);
    try { return await pending; }
    finally { this.#runs.delete(workId); }
  }
  private async runSelected(workId: string, options: { maxSteps?: number; expectedGoalRevision?: number }) {
    const existing = await this.profile.services.state.get(workId);
    this.assertOpen();
    // A rejected target must not apply unrelated pending commands in this session.
    if (existing) await this.work(workId);
    else {
      const pending = (await this.profile.sessions.repository.pending(this.scope, 256)).find(input => input.kind === 'work' && input.workId === workId);
      const request = pending ? AcceptRequestSchema.safeParse(pending.payload) : null;
      const binding = request?.success ? request.data.binding : null;
      if (!binding || binding.channel !== 'knox' || binding.conversationId !== this.route.conversationId || binding.destination !== this.destination ||
        binding.tenantId !== this.actor.tenantId || binding.principalId !== this.actor.principalId || binding.recipientId !== this.actor.principalId)
        throw new Error('work_unavailable');
    }
    this.assertOpen();
    await this.profile.sessions.resume(this.actor, this.sessionId);
    await this.work(workId);
    return this.profile.workflow.run(workId, this.actor, options);
  }
  /** Reconcile the existing outbox; status/history remain read-only. */
  async flush(workId: string) { await this.work(workId); await this.profile.outbox.flush(workId, this.actor); }
  close() { this.#closing = true; return this.profile.close(); }
}

/** Authentication and MCP ownership stay with the embedding host, not message text or agent code. */
export async function openAgentKnox(directory: string, route: KnoxRoute,
  options: AgentTurnProfileOptions, host: AgentExecutionHost) {
  const binding = RouteSchema.parse(route);
  if (!host.knox) throw new Error('knox_registration_required');
  const profile = await openAgentTurnProfile(directory, options, host);
  try {
    if (profile.actor.tenantId !== binding.tenantId || profile.actor.principalId !== binding.principalId || !profile.knoxDestination)
      throw new Error('knox_actor_mismatch');
    const session = await profile.sessions.open(profile.actor, { channel: 'knox', conversationId: binding.conversationId,
      ...(binding.sessionId === undefined ? {} : { sessionId: binding.sessionId }) });
    const conversation = new KnoxConversation(profile, Object.freeze(binding), session.scope, profile.knoxDestination);
    return { conversation, close: () => conversation.close(), modelInfo: profile.modelInfo };
  } catch (error) { await closeAgentTurnResources([profile.close], { error }); throw error; }
}
