import { z } from 'zod';
import type { Policy, WorkState } from '../domain/model.js';
import type { AppliedSessionInput, SessionContext, SessionInbox, SessionScope } from '../domain/session.js';
import { artifactBlocked } from '../domain/data-lifecycle.js';
import { AcceptRequestSchema, ConversationService, type AcceptRequest } from './conversation-service.js';
import { PolicySchema, parseContract } from './contracts.js';
import type { SessionContextDraft, SessionContextProvider, SessionRepository } from './session-ports.js';
import { SessionScopeSchema } from './session-contracts.js';
import type { RuntimeServices } from './services.js';
import { asJson } from './plan-validator.js';
import { authorizedWork, type WorkActor } from './work-resources.js';
import { UserCommandSchema, type ExecutionRuntime, type UserCommand } from './execution-runtime.js';
import { SessionCompactor } from './session-compactor.js';
import type { SessionCompactLimits, SessionSummaryRef } from '../domain/session-compact.js';
import type { SessionCompactSource } from './session-compact-ports.js';
import { disclosureLabels } from '../domain/disclosure.js';

const id = z.string().min(1).max(256);
const TextSchema = z.string().min(1).max(64000);
const OpenSchema = z.strictObject({ channel: z.enum(['cli', 'web', 'knox', 'test', 'peer']), conversationId: id, sessionId: id.optional(), newSession: z.boolean().optional() });
const RequestSchema = z.strictObject({ sessionId: id, rawText: TextSchema, request: AcceptRequestSchema });
const CommandSchema = z.strictObject({ sessionId: id, messageId: id, workId: id, rawText: TextSchema, expectedGoalRevision: z.number().int().positive(), command: UserCommandSchema });
type SessionInputRequest = { sessionId: string; messageId: string; workId: string; rawText: string; expectedGoalRevision: number };
type Services = Pick<RuntimeServices, 'state' | 'artifacts' | 'clock' | 'digester' | 'knowledge' | 'effects' | 'planner'>;

/** Durable intake joins two stores with stable command receipts; neither store owns the other. */
export class SessionService implements SessionContextProvider, SessionCompactSource {
  readonly compactor: SessionCompactor;
  #commands: Pick<ExecutionRuntime, 'command'> | undefined;
  constructor(readonly services: Services, readonly repository: SessionRepository, readonly agentId: string, readonly conversation: ConversationService, compact: Partial<SessionCompactLimits> = {}) {
    id.parse(agentId);
    this.compactor = new SessionCompactor(services, repository, state => this.applied(state), compact);
  }
  bindCommands(commands: Pick<ExecutionRuntime, 'command'>) {
    if (this.#commands) throw new Error('session_commands_already_bound');
    this.#commands = commands;
  }
  private digest(value: unknown) { return this.services.digester.digest(asJson(value)); }
  private scope(actor: WorkActor, sessionId: string): SessionScope {
    return SessionScopeSchema.parse({ tenantId: actor.tenantId, principalId: actor.principalId, agentId: this.agentId, sessionId });
  }
  async open(actor: WorkActor, value: z.infer<typeof OpenSchema>) {
    const options = OpenSchema.parse(value);
    return this.repository.open({ tenantId: actor.tenantId, principalId: actor.principalId, agentId: this.agentId }, {
      route: this.digest({ channel: options.channel, conversationId: options.conversationId }), now: this.services.clock.now(),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }), ...(options.newSession === undefined ? {} : { newSession: options.newSession }),
    });
  }
  private workId(request: AcceptRequest, scope: SessionScope) {
    const binding = `binding-${this.digest({ ...request.binding, session: scope })}`;
    return `work-${this.digest({ binding, messageId: request.messageId })}`;
  }
  async accept(actor: WorkActor, value: z.infer<typeof RequestSchema>) {
    const { sessionId, rawText, request } = RequestSchema.parse(value); const scope = this.scope(actor, sessionId);
    if (request.binding.session || request.policy.tenantId !== actor.tenantId || request.policy.principalId !== actor.principalId ||
      request.binding.tenantId !== actor.tenantId || request.binding.principalId !== actor.principalId || request.binding.recipientId !== actor.principalId ||
      !request.policy.allowedDestinations.includes(request.binding.destination) || request.goal.revision !== 1) throw new Error('request_not_authorized');
    if (actor.allowedLabels && request.policy.allowedLabels.some(label => !actor.allowedLabels!.includes(label)) ||
      actor.allowedDestinations && request.policy.allowedDestinations.some(destination => !actor.allowedDestinations!.includes(destination))) throw new Error('request_not_authorized');
    const questions = request.initialQuestions ?? [];
    if (new Set(questions.map(question => question.id)).size !== questions.length || questions.some(question => question.id === 'response-delivery:1')) throw new Error('initial_question_conflict');
    await this.repository.get(scope);
    const payload = asJson(request); const workId = this.workId(request, scope);
    const stored = await this.repository.receive({ scope, messageId: request.messageId, digest: this.digest({ scope, text: rawText, payload, kind: 'work', workId }),
      text: rawText, payload, kind: 'work', workId, labels: request.policy.allowedLabels, receivedAt: this.services.clock.now() });
    await this.resume(actor, sessionId);
    const settled = await this.repository.input(scope, request.messageId);
    if (settled?.status !== 'applied') throw new Error(settled?.rejection ?? 'session_input_pending');
    return { workId, accepted: stored.created, state: await authorizedWork(this.services.state, workId, actor), sessionId, sequence: stored.input.sequence };
  }
  private basis(input: SessionInbox): AppliedSessionInput { return { scope: input.scope, input: { messageId: input.messageId, sequence: input.sequence, digest: input.digest } }; }
  private async applyPending(actor: WorkActor, scope: SessionScope, input: SessionInbox) {
    if (input.kind === 'work') {
      const request = parseContract(AcceptRequestSchema, input.payload);
      if (input.workId !== this.workId(request, scope) || request.messageId !== input.messageId ||
        input.digest !== this.digest({ scope, text: input.text, payload: input.payload, kind: input.kind, workId: input.workId })) throw new Error('session_intake_invalid');
      const accepted = await this.conversation.accept(actor, request, this.basis(input));
      if (accepted.workId !== input.workId) throw new Error('session_work_identity_conflict');
    } else {
      const payload = z.strictObject({ expectedGoalRevision: z.number().int().positive(), command: UserCommandSchema }).parse(input.payload);
      if (!this.#commands) throw new Error('session_command_handler_unavailable');
      if (input.digest !== this.digest({ scope, text: input.text, payload: input.payload, kind: input.kind, workId: input.workId })) throw new Error('session_intake_invalid');
      this.assertBound(await authorizedWork(this.services.state, input.workId, actor), scope);
      try {
        await this.#commands.command(input.workId, `session-command:${this.digest([scope, input.messageId])}`, actor, payload.expectedGoalRevision, payload.command, this.basis(input));
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (!['stale_user_command', 'work_terminal', 'stale_execution_control', 'stale_session_input', 'stale_work_policy', 'obligation_not_resolvable', 'work_not_resumable', 'invalid_wait_obligation', 'invalid_goal_revision_or_criteria'].includes(code)) throw error;
        await this.repository.settle(scope, input.messageId, input.digest, { status: 'rejected', reason: code });
        return;
      }
    }
    await this.repository.settle(scope, input.messageId, input.digest, { status: 'applied' });
  }
  async resume(actor: WorkActor, sessionId: string) {
    const scope = this.scope(actor, sessionId); await this.repository.get(scope);
    // Bounded recovery reports pending capacity; it never silently drops an inbox tail.
    const pending = await this.repository.pending(scope, 256);
    for (const input of pending) await this.applyPending(actor, scope, input);
    if ((await this.repository.pending(scope, 1)).length) throw new Error('session_recovery_capacity');
  }
  async input(actor: WorkActor, value: SessionInputRequest) {
    return this.command(actor, { ...value, command: { kind: 'input', reason: 'session_input_received' } });
  }
  /** Apply this input only; an earlier pending intake requires explicit ordinary session recovery. */
  async inputOnly(actor: WorkActor, value: SessionInputRequest) {
    return this.receiveCommand(actor, { ...value, command: { kind: 'input', reason: 'session_input_received' } }, true);
  }
  async command(actor: WorkActor, value: SessionInputRequest & { command: UserCommand }) {
    return this.receiveCommand(actor, value, false);
  }
  /** Authorized intake metadata; builders must consult the original receipt before deriving a retry payload. */
  async commandContext(actor: WorkActor, value: { sessionId: string; workId: string; messageId?: string }) {
    const input = z.strictObject({ sessionId: id, workId: id, messageId: id.optional() }).parse(value);
    const scope = this.scope(actor, input.sessionId);
    const state = await authorizedWork(this.services.state, input.workId, actor); this.assertBound(state, scope);
    const source = await this.services.state.get(input.workId);
    if (!source || source.revision !== state.revision) throw new Error('stale_session_input');
    if (disclosureLabels(source).some(label => !state.policy.allowedLabels.includes(label))) throw new Error('session_work_unavailable');
    await this.repository.get(scope);
    const receipt = input.messageId === undefined ? null : await this.repository.input(scope, input.messageId);
    if (receipt?.labels.some(label => !state.policy.allowedLabels.includes(label))) throw new Error('session_work_unavailable');
    return { state, scope, receipt };
  }
  private async receiveCommand(actor: WorkActor, value: SessionInputRequest & { command: UserCommand }, only: boolean) {
    const input = CommandSchema.parse(value);
    const scope = this.scope(actor, input.sessionId); const state = await authorizedWork(this.services.state, input.workId, actor); this.assertBound(state, scope);
    if (only && !(await this.repository.input(scope, input.messageId)) && (await this.repository.pending(scope, 1)).length) throw new Error('session_input_pending');
    const payload = asJson({ expectedGoalRevision: input.expectedGoalRevision, command: input.command }); const kind = input.command.kind === 'input' ? 'input' : 'command';
    const result = await this.repository.receive({ scope, messageId: input.messageId, digest: this.digest({ scope, text: input.rawText, payload, kind, workId: input.workId }),
      kind, workId: input.workId, text: input.rawText, payload, labels: state.policy.allowedLabels, receivedAt: this.services.clock.now() });
    if (only) {
      if (result.input.status === 'pending') {
        const first = (await this.repository.pending(scope, 1))[0];
        if (first?.messageId === input.messageId) {
          if (first.kind !== 'input' || first.digest !== result.input.digest || first.workId !== input.workId) throw new Error('session_intake_invalid');
          await this.applyPending(actor, scope, first);
        }
        // A concurrent recovery may already have settled this input. Re-read its receipt below;
        // never progress another work or command to make this request appear successful.
      }
    } else await this.resume(actor, input.sessionId);
    const receipt = await this.repository.input(scope, input.messageId);
    if (receipt?.status !== 'applied') throw new Error(receipt?.rejection ?? 'session_input_pending');
    return { ...result, input: receipt, workId: input.workId };
  }
  async history(actor: WorkActor, sessionId: string, value: Policy, options: { limit: number; cursor?: string }) {
    const policy = parseContract(PolicySchema, value);
    if (policy.tenantId !== actor.tenantId || policy.principalId !== actor.principalId ||
      actor.allowedLabels && policy.allowedLabels.some(label => !actor.allowedLabels!.includes(label)) ||
      actor.allowedDestinations && policy.allowedDestinations.some(destination => !actor.allowedDestinations!.includes(destination))) throw new Error('session_unavailable');
    const scope = this.scope(actor, sessionId); const page = await this.repository.history(scope, policy, options);
    const entries = [];
    for (const entry of page.entries) {
      const receipt = entry.role === 'user' ? await this.repository.input(scope, entry.sourceId) : null;
      // A received request may not yet have a work record; its receipt still belongs in the UI.
      if (receipt && receipt.status !== 'applied') { entries.push(entry); continue; }
      const source = await this.services.state.get(entry.workId);
      if (!source || source.policy.tenantId !== actor.tenantId || source.policy.principalId !== actor.principalId ||
        this.digest(source.conversation?.session?.scope ?? null) !== this.digest(scope)) throw new Error('session_source_unavailable');
      if (entry.labels.some(label => !source.policy.allowedLabels.includes(label))) continue;
      if (entry.artifact && (artifactBlocked(source, entry.artifact) || !(await this.services.artifacts.exists(entry.artifact)))) continue;
      entries.push(entry);
    }
    return { entries, nextCursor: page.nextCursor };
  }
  private assertBound(state: WorkState, scope: SessionScope) {
    if (scope.agentId !== this.agentId || scope.tenantId !== state.policy.tenantId || scope.principalId !== state.policy.principalId ||
      this.digest(state.conversation?.session?.scope ?? null) !== this.digest(scope) || !state.conversation?.bindings.some(binding =>
        this.digest(binding.session ?? null) === this.digest(scope))) throw new Error('session_work_unavailable');
  }
  private async applied(state: WorkState) {
    const basis = state.conversation?.session;
    if (!basis) {
      if (state.conversation?.bindings.some(binding => binding.session)) throw new Error('session_work_unavailable');
      return null;
    }
    this.assertBound(state, basis.scope); await this.repository.get(basis.scope);
    const input = await this.repository.input(basis.scope, basis.input.messageId);
    if (!input || input.status !== 'applied' || input.workId !== state.id || this.digest(this.basis(input)) !== this.digest(basis)) throw new Error('session_input_unavailable');
    const pending = await this.repository.pending(basis.scope, 256);
    if (pending.length === 256 || pending.some(item => item.workId === state.id)) throw new Error('session_input_pending');
    return basis;
  }
  context(state: WorkState) { return this.compactor.context(state); }
  inspectContext(state: WorkState) { return this.compactor.inspectContext(state); }
  draftCurrent(state: WorkState, draft: SessionContextDraft, signal?: AbortSignal) { return this.compactor.draftCurrent(state, draft, signal); }
  materializeContext(state: WorkState, draft: SessionContextDraft) { return this.compactor.materializeContext(state, draft); }
  current(state: WorkState, context?: SessionContext, signal?: AbortSignal) { return this.compactor.current(state, context, signal); }
  prepareCompact(...args: Parameters<SessionCompactSource['prepareCompact']>) { return this.compactor.prepareCompact(...args); }
  compactInputCurrent(...args: Parameters<SessionCompactSource['compactInputCurrent']>) { return this.compactor.compactInputCurrent(...args); }
  publishCompact(...args: Parameters<SessionCompactSource['publishCompact']>) { return this.compactor.publishCompact(...args); }
  compactPublication(...args: Parameters<SessionCompactSource['compactPublication']>) { return this.compactor.compactPublication(...args); }
  /** Metadata only: polling neither scans transcript originals nor prepares a model call. */
  async compactStatus(actor: WorkActor, sessionId: string): Promise<SessionSummaryRef | null> {
    const scope = this.scope(actor, sessionId); const session = await this.repository.get(scope);
    let record = await this.repository.summaryHead(scope);
    for (let n = 0; record && n < 32; n++) {
      const creator = await this.services.state.get(record.workId);
      const call = creator?.modelCalls.find(item => item.id === record!.callId);
      if (creator && creator.policy.tenantId === actor.tenantId && creator.policy.principalId === actor.principalId &&
        this.digest(creator.conversation?.session?.scope ?? null) === this.digest(scope) &&
        call?.status === 'accepted' && call.purpose === 'session_compact' && call.compactInputDigest === record.inputDigest) return record.ref;
      record = await this.repository.summaryBefore(scope, session.lastSequence, record.ref.policyDigest,
        { throughSequence: record.ref.throughSequence, revision: record.ref.revision });
    }
    return null;
  }
}
