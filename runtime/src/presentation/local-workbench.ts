import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { localHistoryPolicy, type LocalProfile } from './local-profile.js';
import { WebAcceptSchema, WebAttachSchema, WebCommandSchema, type WebAcceptInput, type WebAcceptResult, type WebAttachInput, type WebAttachResult,
  WebInputSchema, type WebInput, type WebConversation, type WebCommandInput, type WebCommandResult, type WorkbenchConfig, type WorkCard, type WorkList } from './web-contracts.js';
import type { WorkViewLevel, WorkViewResult } from '../domain/work-view.js';
import type { ConversationBinding } from '../domain/conversation.js';
import type { Delivery, Goal, Json, Policy, TaskSpec, WorkState } from '../domain/model.js';
import { allowsDisclosure, disclosureLabels } from '../domain/disclosure.js';
import { dataGeneration } from '../domain/data-lifecycle.js';
import { newWork } from '../application/new-work.js';
import { ConversationBindingSchema, parseContract } from '../application/contracts.js';
import { asJson } from '../application/plan-validator.js';
import { transact } from '../application/work-transactions.js';
import type { WorkActor } from '../application/work-resources.js';
import { RESOURCE_TOOL_IDS } from '../application/resource-tools.js';
import { KNOWLEDGE_TOOL_IDS } from '../application/knowledge-tools.js';
import type { SessionRecord } from '../domain/session.js';
import type { UserCommand } from '../application/execution-runtime.js';
import { WebCompactSchema, type WebCompactInput, type WebCompactResult } from './web-contracts.js';
import { localCompactStatus, requestLocalCompact } from './local-compact.js';
import { forgetPersonal, getPersonal, recallPersonal, rememberPersonal, revisePersonal, searchPersonal,
  PersonalRememberSchema, PersonalReviseSchema, PersonalRecallSchema, type PersonalRememberInput, type PersonalReviseInput,
  type PersonalForgetInput, type PersonalRecallInput } from './local-personal-memory.js';
import { MemoryDraftCreateSchema, MemoryDraftApplySchema, MemoryDraftResumeSchema,
  type MemoryDraftCreateInput, type MemoryDraftApplyInput, type MemoryDraftResumeInput } from '../application/personal-memory-draft-contracts.js';
import { createMemoryDraft, applyMemoryDraft, resumeMemoryDraft, memoryDraftStatus } from './local-memory-drafts.js';
import type { AgentTurnProfile } from './agent-turn-profile.js';
import { WebGeneralRequestSchema, type WebGeneralRequest } from './web-contracts.js';
import type { WebGoalBasis } from './web-contracts.js';

export type LocalWorkbenchProfile = LocalProfile & { general?: AgentTurnProfile };
export function agentTurnWorkbenchProfile(profile: AgentTurnProfile): LocalWorkbenchProfile {
  return { ...profile, scenarios: [], general: profile };
}
const fixedActor: WorkActor = { tenantId: 'synthetic', principalId: 'learner' };
const idSchema = z.string().min(1).max(256);
const scopeOf = (input: unknown, schema: z.ZodType) => { const parsed = schema.safeParse(input); if (!parsed.success) throw new Error('web_request_invalid'); return parsed.data; };
type Running = { digest: string; promise: Promise<WebCommandResult> };
type Coordination = { commands: Map<string, Running>; runs: Map<string, string> };
const coordinators = new WeakMap<object, Coordination>();
function coordination(profile: LocalWorkbenchProfile): Coordination {
  let value = coordinators.get(profile.services.state);
  if (!value) { value = { commands: new Map(), runs: new Map() }; coordinators.set(profile.services.state, value); }
  return value;
}

/** Host-composed local workbench; general turns and explicit fixture work share the existing lifecycle. */
export class LocalWorkbench {
  readonly #profile: LocalWorkbenchProfile;
  readonly #actor: WorkActor;
  readonly #conversationId: string;
  readonly #coordination: Coordination;
  readonly #pending = new Set<Promise<unknown>>();
  readonly #listCursors = new Map<string, { cursor: string; expiresAt: number }>();
  readonly #sessionOptions: { sessionId?: string; newSession?: boolean };
  #session: Promise<SessionRecord | null> | null = null;
  #selectedSession: SessionRecord | null = null;
  #draining = false;
  constructor(profile: LocalWorkbenchProfile, actor: WorkActor = fixedActor, conversationId = 'web', sessionOptions: { sessionId?: string; newSession?: boolean } = {}) {
    idSchema.parse(conversationId); idSchema.parse(actor.tenantId); idSchema.parse(actor.principalId);
    this.#profile = profile; this.#actor = structuredClone(actor); this.#conversationId = conversationId; this.#coordination = coordination(profile); this.#sessionOptions = { ...sessionOptions };
  }
  private session() {
    this.#session ??= this.#profile.sessions ? this.#profile.sessions.open(this.#actor, { channel: 'web', conversationId: this.#conversationId, ...this.#sessionOptions })
      .then(session => { this.#selectedSession = session; return session; }) : Promise.resolve(null);
    return this.#session;
  }
  async initializeSession() { const session = await this.session(); if (session) await this.#profile.sessions!.resume(this.#actor, session.scope.sessionId); }
  private digest(value: unknown) { return this.#profile.services.digester.digest(asJson(value)); }
  private route() { return { channel: 'web' as const, conversationId: this.#conversationId, destination: 'local', recipientId: this.#actor.principalId, allowDiagnostics: true }; }
  private binding(): ConversationBinding {
    const input = { channel: 'web' as const, conversationId: this.#conversationId, destination: 'local', recipientId: this.#actor.principalId,
      tenantId: this.#actor.tenantId, principalId: this.#actor.principalId };
    return parseContract(ConversationBindingSchema, { ...input, id: `binding-${this.digest(input)}` });
  }
  private assertState(state: WorkState, requireBinding = true) {
    if (this.#profile.sessions && (!this.#selectedSession || this.digest(state.conversation?.session?.scope ?? null) !== this.digest(this.#selectedSession.scope))) throw new Error('session_work_unavailable');
    const policy: Policy = structuredClone(state.policy);
    if (policy.tenantId !== this.#actor.tenantId || policy.principalId !== this.#actor.principalId) throw new Error('work_view_denied');
    policy.allowedLabels = policy.allowedLabels.filter(label => this.#actor.allowedLabels === undefined || this.#actor.allowedLabels.includes(label));
    policy.allowedDestinations = policy.allowedDestinations.filter(destination => this.#actor.allowedDestinations === undefined || this.#actor.allowedDestinations.includes(destination));
    const binding = this.binding();
    const sameRoute = (value: ConversationBinding) => value.channel === binding.channel && value.conversationId === binding.conversationId && value.destination === binding.destination &&
      value.recipientId === binding.recipientId && value.tenantId === binding.tenantId && value.principalId === binding.principalId;
    if (!allowsDisclosure(policy, 'local', 'screen', disclosureLabels(state)) || (requireBinding && !state.conversation?.bindings.some(sameRoute))) throw new Error('work_view_denied');
  }
  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#draining) return Promise.reject(new Error('web_workbench_draining'));
    const pending = operation(); this.#pending.add(pending);
    void pending.finally(() => this.#pending.delete(pending)).catch(() => {});
    return pending;
  }
  config(): WorkbenchConfig {
    if (this.#profile.general) return { profile: this.#profile.general.provider === 'registered' ? 'local-registered' : 'local-synthetic', generalRequests: true, conversationId: this.#conversationId,
      persistentSession: { agentId: this.#profile.general.agentId, ...(this.#selectedSession ? { sessionId: this.#selectedSession.scope.sessionId } : {}) },
      memoryDrafts: Boolean(this.#profile.memoryDrafts), personalMemoryBackend: this.#profile.general.personalMemoryBackend,
      scenarios: [], modes: ['auto', 'fast', 'deep'], allowDiagnostics: true,
      model: this.#profile.general.provider === 'registered' ? 'registered-agent-turn' : 'synthetic-agent-turn', modelInfo: this.#profile.general.modelInfo,
      compactProvider: this.#profile.compactProvider, deliveryMeaning: 'local-channel-storage', pageSize: 20 };
    return { profile: 'local-synthetic', conversationId: this.#conversationId, ...(this.#profile.agentId ? { persistentSession: {
      agentId: this.#profile.agentId, ...(this.#selectedSession ? { sessionId: this.#selectedSession.scope.sessionId } : {}) } } : {}),
      memoryDrafts: Boolean(this.#profile.memoryDrafts), ...(this.#profile.personalMemoryBackend ? { personalMemoryBackend: this.#profile.personalMemoryBackend } : {}), scenarios: [
      { id: 'documents-simple', title: '문서 근거 확인', description: '합성 문서에서 현행 보존기간을 확인합니다.' },
      { id: 'observations-simple', title: '관측 범위 확인', description: '합성 관측의 수집 완료 여부를 확인합니다.' },
      { id: 'documents-question', title: '질문에 답한 뒤 문서 확인', description: '답변 저장으로 문서 선택을 확인한 뒤 명시 실행하는 합성 예제입니다.' },
    ], modes: ['auto', 'fast', 'deep'], allowDiagnostics: true, model: 'disabled', compactProvider: this.#profile.compactProvider, deliveryMeaning: 'local-channel-storage', pageSize: 20 };
  }
  async compactStatus(workId: string) {
    scopeOf(workId, idSchema); await this.session(); this.assertState(await this.#profile.runtime.state(workId));
    const status = await localCompactStatus(this.#profile, this.#actor, workId);
    this.assertState(await this.#profile.runtime.state(workId));
    return status;
  }
  async memorySearch(query: string) { return searchPersonal(this.#profile, this.#actor, query); }
  async memoryGet(id: string) { return getPersonal(this.#profile, this.#actor, id); }
  memoryDraftCreate(value: MemoryDraftCreateInput) { return this.track(() => createMemoryDraft(this.#profile, this.#actor, MemoryDraftCreateSchema.parse(value))); }
  memoryDraftApply(value: MemoryDraftApplyInput) { return this.track(async () => {
    const input = MemoryDraftApplySchema.parse(value), session = await this.session();
    if (!session || session.scope.sessionId !== input.sessionId) throw new Error('session_work_unavailable');
    this.assertState(await this.#profile.runtime.state(input.workId), false);
    return applyMemoryDraft(this.#profile, this.#actor, input);
  }); }
  memoryDraftResume(value: MemoryDraftResumeInput) { return this.track(async () => {
    const input = MemoryDraftResumeSchema.parse(value), session = await this.session();
    if (!session || session.scope.sessionId !== input.sessionId) throw new Error('session_work_unavailable');
    return resumeMemoryDraft(this.#profile, this.#actor, input);
  }); }
  async memoryDraftStatus(value: MemoryDraftResumeInput) {
    const input = MemoryDraftResumeSchema.parse(value), session = await this.session();
    if (!session || session.scope.sessionId !== input.sessionId) throw new Error('session_work_unavailable');
    return memoryDraftStatus(this.#profile, this.#actor, input);
  }
  memoryRemember(value: PersonalRememberInput) { return this.track(async () => {
    const input = PersonalRememberSchema.parse(value);
    if (input.source.kind === 'new_input') { await this.session(); this.assertState(await this.#profile.runtime.state(input.source.workId)); }
    return rememberPersonal(this.#profile, this.#actor, input);
  }); }
  memoryRevise(value: PersonalReviseInput) { return this.track(async () => {
    const input = PersonalReviseSchema.parse(value);
    if (input.source.kind === 'new_input') { await this.session(); this.assertState(await this.#profile.runtime.state(input.source.workId)); }
    return revisePersonal(this.#profile, this.#actor, input);
  }); }
  memoryForget(value: PersonalForgetInput) { return this.track(() => forgetPersonal(this.#profile, this.#actor, value)); }
  async memorySelected(workId: string) {
    scopeOf(workId, idSchema); await this.session(); if (!this.#profile.personalMemories) throw new Error('personal_memory_unavailable');
    const before = await this.#profile.runtime.state(workId); this.assertState(before);
    await this.#profile.personalKnowledge(this.#actor);
    const result = await this.#profile.personalMemories.selected(workId, this.#actor);
    const after = await this.#profile.runtime.state(workId); this.assertState(after);
    if (after.revision !== result.stateRevision || before.goal.revision !== after.goal.revision) throw new Error('personal_memory_selection_stale');
    return { ...result, workId, goalRevision: after.goal.revision };
  }
  memoryRecall(workId: string, value: PersonalRecallInput) { return this.track(async () => {
    scopeOf(workId, idSchema); const input = PersonalRecallSchema.parse(value); await this.session();
    this.assertState(await this.#profile.runtime.state(workId));
    const result = await recallPersonal(this.#profile, this.#actor, workId, input);
    this.assertState(await this.#profile.runtime.state(workId)); return result;
  }); }
  compact(workId: string, value: WebCompactInput): Promise<WebCompactResult> { return this.track(async () => {
    const input = scopeOf(value, WebCompactSchema) as WebCompactInput;
    await this.view(workId);
    const result = await requestLocalCompact(this.#profile, this.#actor, workId, input);
    this.assertState(await this.#profile.runtime.state(workId));
    return result;
  }); }
  async history(cursor?: string): Promise<WebConversation> {
    if (cursor !== undefined) scopeOf(cursor, idSchema);
    const session = await this.session(); if (!session || !this.#profile.sessions) throw new Error('session_unavailable');
    const policy = this.#profile.general ? structuredClone(this.#profile.general.policy) : localHistoryPolicy(this.#profile, this.#actor);
    if (this.#actor.allowedLabels) policy.allowedLabels = policy.allowedLabels.filter(label => this.#actor.allowedLabels!.includes(label));
    if (this.#actor.allowedDestinations) policy.allowedDestinations = policy.allowedDestinations.filter(destination => this.#actor.allowedDestinations!.includes(destination));
    return { sessionId: session.scope.sessionId, ...await this.#profile.sessions.history(this.#actor, session.scope.sessionId, policy, { limit: 50, ...(cursor === undefined ? {} : { cursor }) }) };
  }
  input(workId: string, value: WebInput): Promise<WebCommandResult> { return this.track(async () => {
    const input = scopeOf(value, WebInputSchema) as WebInput; await this.view(workId);
    const state = await this.#profile.runtime.state(workId); this.assertState(state);
    const sessionId = state.conversation?.session?.scope.sessionId;
    if (!sessionId || !this.#profile.sessions) throw new Error('session_unavailable');
    const accepted = await this.#profile.sessions.input(this.#actor, { sessionId, messageId: input.requestId, workId, rawText: input.rawText, expectedGoalRevision: input.expectedGoalRevision });
    return { workId, accepted: true, duplicate: !accepted.created, view: await this.view(workId) };
  }); }
  async view(workId: string, level: WorkViewLevel = 'conversation', cursor?: string): Promise<WorkViewResult> {
    scopeOf(workId, idSchema);
    if (this.#profile.sessions) { await this.session(); this.assertState(await this.#profile.runtime.state(workId)); }
    const result = await this.#profile.workView.read(workId, this.#actor, this.route(), { level, ...(cursor === undefined ? {} : { cursor }) });
    if (this.#profile.sessions) this.assertState(await this.#profile.runtime.state(workId));
    return result;
  }
  async list(cursor?: string): Promise<WorkList> {
    if (cursor !== undefined) scopeOf(cursor, idSchema);
    const now = this.#profile.services.clock.now();
    for (const [token, saved] of this.#listCursors) if (saved.expiresAt <= now) this.#listCursors.delete(token);
    const saved = cursor === undefined ? undefined : this.#listCursors.get(cursor);
    if (cursor !== undefined && !saved) throw new Error('web_list_cursor_invalid');
    const page = await this.#profile.conversation.listPage(this.#actor, 'web', this.#conversationId, { limit: 20, ...(saved ? { cursor: saved.cursor } : {}) });
    const cards = new Map<string, { cursor: string; item: WorkCard }>();
    const card = (value: Extract<WorkViewResult, { kind: 'snapshot' }>) => {
      const { workId, title, goalRevision, mode, progress, reply } = value.view;
      return { cursor: value.cursor, item: { workId, title, goalRevision, mode, progress, reply } };
    };
    for (const workId of page.workIds) {
      try {
        const value = await this.view(workId); if (value.kind !== 'snapshot') throw new Error('web_view_unavailable');
        cards.set(workId, card(value));
      } catch (error) { if (!(error instanceof Error && ['work_view_denied', 'work_view_knowledge_changed', 'session_work_unavailable'].includes(error.message))) throw error; }
    }
    for (let retry = 0; retry < 3; retry++) {
      let changed = false;
      for (const [workId, saved] of cards) {
        try { const value = await this.view(workId, 'conversation', saved.cursor); if (value.kind === 'snapshot') { cards.set(workId, card(value)); changed = true; } }
        catch (error) { if (!(error instanceof Error && ['work_view_denied', 'work_view_knowledge_changed', 'session_work_unavailable'].includes(error.message))) throw error;
          cards.delete(workId); changed = true; }
      }
      if (!changed) {
        let nextCursor: string | null = null;
        if (page.nextCursor !== null) {
          while (this.#listCursors.size >= 128) this.#listCursors.delete(this.#listCursors.keys().next().value!);
          nextCursor = `wl2:${randomUUID()}`;
          this.#listCursors.set(nextCursor, { cursor: page.nextCursor, expiresAt: this.#profile.services.clock.now() + 900000 });
        }
        return { items: [...cards.values()].map(value => value.item), nextCursor };
      }
    }
    throw new Error('web_list_contention');
  }
  accept(value: WebAcceptInput): Promise<WebAcceptResult> { return this.track(async () => {
    if (this.#profile.general) throw new Error('web_request_invalid');
    const input = scopeOf(value, WebAcceptSchema) as WebAcceptInput;
    const scenarioId = input.scenarioId === 'documents-question' ? 'documents-simple' : input.scenarioId;
    const scenario = this.#profile.scenarios.find(candidate => candidate.id === scenarioId && candidate.synthetic && candidate.complexity === 'simple');
    if (!scenario) throw new Error('web_scenario_unavailable');
    const policy: Policy = { ...structuredClone(scenario.policy), tenantId: this.#actor.tenantId, principalId: this.#actor.principalId, allowedTools: [...scenario.policy.allowedTools, ...RESOURCE_TOOL_IDS, ...KNOWLEDGE_TOOL_IDS],
      disclosure: { revision: this.#profile.sessions ? 'local-web-session-v1' : 'local-web-v1',
        destinations: [{ destination: 'local', surfaces: ['tool', 'channel', 'screen', 'log', ...(this.#profile.sessions ? ['model' as const] : [])], allowedLabels: [...scenario.policy.allowedLabels] }],
        maxReleasesPerWork: 20, maxReleasedBytesPerWork: 1048576 } };
    const binding = this.binding(); const workId = `work-${this.digest({ binding: binding.id, messageId: input.requestId })}`;
    const goal: Goal = { ...structuredClone(scenario.goal), mode: input.mode, description: input.title ?? scenario.goal.description };
    if (this.#profile.sessions) {
      if (input.rawText === undefined) throw new Error('session_text_required');
      const session = await this.session(); if (!session) throw new Error('session_unavailable');
      const { id: _bindingId, ...route } = binding;
      const accepted = await this.#profile.sessions.accept(this.#actor, { sessionId: session.scope.sessionId, rawText: input.rawText,
        request: { messageId: input.requestId, binding: route, goal, policy,
          limits: { toolCalls: 30, modelCalls: 5, tokens: 10000, replans: 5, wallTimeMs: 3600000 }, completionRequiresDelivery: true,
          ...(input.scenarioId === 'documents-question' ? { initialQuestions: [{ id: 'document-selection-g1', reason: '현행 문서 선택을 확인해 주세요. 이 합성 예제에서는 답변 저장을 누르면 현행 문서를 선택한 것으로 처리합니다.' }] } : {}) } });
      await this.view(accepted.workId);
      await this.#profile.outbox.flush(accepted.workId, this.#actor);
      return { workId: accepted.workId, accepted: accepted.accepted, sessionId: session.scope.sessionId };
    }
    const state = newWork({ id: workId, goal, policy, now: this.#profile.services.clock.now(),
      limits: { toolCalls: 30, modelCalls: 5, tokens: 10000, replans: 5, wallTimeMs: 3600000 } });
    state.conversation = { bindings: [binding], primaryBindingId: binding.id, completionRequiresDelivery: true, result: null };
    state.obligations.push({ id: `response-delivery:${goal.revision}`, kind: 'delivery', reason: 'result_delivery_required', status: 'pending', wakeKey: `response-delivery:${goal.revision}`, dueAt: state.deadlineAt });
    const delivery = (kind: Delivery['kind'], id: string, text: string, labels: string[], obligationIds: string[]): Delivery => ({ id, workId, goalRevision: goal.revision, destination: 'local', kind, text,
      status: 'pending', externalId: null, dispatch: null, context: { binding, labels, sourceRevision: state.revision, dataGeneration: dataGeneration(state), responseId: null, evidenceIds: [], evidenceDigest: null, obligationIds, artifact: null } });
    const deliveries = [delivery('ack', 'ack', `[${workId}] 요청을 접수했습니다.`, [], [])];
    if (input.scenarioId === 'documents-question') {
      const obligation = { id: 'document-selection-g1', kind: 'response' as const, reason: '현행 문서 선택을 확인해 주세요. 이 합성 예제에서는 답변 저장을 누르면 현행 문서를 선택한 것으로 처리합니다.', status: 'pending' as const, wakeKey: 'document-selection-g1', dueAt: null };
      state.obligations.push(obligation); state.status = 'waiting'; state.statusReason = 'pending_obligation';
      const pending = [obligation]; const questionId = `question-${this.digest({ goalRevision: goal.revision, dataGeneration: dataGeneration(state), bindingId: binding.id, pending })}`;
      deliveries.push(delivery('question', questionId, `[${workId} · 목표 ${goal.revision}] 추가 확인이 필요합니다.\n- ${obligation.reason} (${obligation.id})`, disclosureLabels(state), [obligation.id]));
    }
    this.assertState(state);
    const committed = await this.#profile.services.state.commit({ workId, expectedRevision: 0, commandId: 'conversation.accept',
      commandDigest: this.digest({ kind: 'local-web-accept', actor: this.#actor, conversationId: this.#conversationId, input }), next: state,
      events: [{ type: 'web_request_accepted', at: state.createdAt, data: asJson({ requestId: input.requestId, scenarioId: input.scenarioId }) as Record<string, Json> }], deliveries });
    if (committed.kind === 'conflict' || committed.kind === 'idempotency_conflict') throw new Error('idempotency_conflict');
    await this.view(workId);
    if (committed.kind === 'committed') await this.#profile.outbox.flush(workId, this.#actor);
    return { workId, accepted: committed.kind === 'committed' };
  }); }
  generalAccept(value: WebGeneralRequest): Promise<WebAcceptResult> { return this.track(async () => {
    const input = WebGeneralRequestSchema.parse(value), profile = this.#profile.general;
    if (!profile) throw new Error('agent_turn_provider_unavailable');
    const session = await this.session(); if (!session) throw new Error('session_unavailable');
    const { id: _id, ...binding } = this.binding();
    const accepted = await profile.turns.accept(profile.actor, { sessionId: session.scope.sessionId, messageId: input.requestId,
      rawText: input.rawText, mode: input.mode, scope: profile.scope, policy: profile.policy, limits: profile.limits, binding });
    await this.view(accepted.workId); await this.#profile.outbox.flush(accepted.workId, this.#actor);
    return { workId: accepted.workId, accepted: accepted.accepted, sessionId: session.scope.sessionId };
  }); }
  attach(value: WebAttachInput): Promise<WebAttachResult> { return this.track(async () => {
    if (this.#profile.sessions) throw new Error('session_attach_unsupported');
    const input = scopeOf(value, WebAttachSchema) as WebAttachInput; const current = await this.#profile.runtime.state(input.workId); this.assertState(current, false);
    const binding = this.binding(); const already = current.conversation?.bindings.some(known => this.digest(known) === this.digest(binding)) ?? false;
    const result = await transact(this.#profile.services, input.workId, `web-attach:${this.digest({ actor: this.#actor, conversationId: this.#conversationId, requestId: input.requestId })}`,
      'web_attachment_requested', asJson({ actor: this.#actor, conversationId: this.#conversationId, input }), state => {
        this.assertState(state, false); if (!state.conversation) throw new Error('work_view_denied');
        if (!state.conversation.bindings.some(known => this.digest(known) === this.digest(binding))) state.conversation.bindings.push(binding);
      });
    return { workId: input.workId, attached: result.committed && !already, duplicate: !result.committed, view: await this.view(input.workId) };
  }); }
  command(workId: string, value: WebCommandInput): Promise<WebCommandResult> { return this.track(async () => {
    scopeOf(workId, idSchema); const input = scopeOf(value, WebCommandSchema) as WebCommandInput;
    await this.view(workId);
    const commandId = `web-command:${this.digest({ actor: this.#actor, conversationId: this.#conversationId, requestId: input.requestId })}`;
    const key = `${workId}:${commandId}`; const digest = this.digest(input); const active = this.#coordination.commands.get(key);
    if (active) { if (active.digest !== digest) throw new Error('idempotency_conflict'); await active.promise;
      return { workId, accepted: true, duplicate: true, view: await this.view(workId) }; }
    const promise = this.perform(workId, commandId, input); this.#coordination.commands.set(key, { digest, promise });
    try { return await promise; } finally { this.#coordination.commands.delete(key); }
  }); }
  goalBasis(workId: string): Promise<WebGoalBasis> { return this.track(async () => {
    scopeOf(workId, idSchema); await this.view(workId);
    const general = this.#profile.general; if (!general || !this.#selectedSession) throw new Error('agent_goal_change_unavailable');
    const result = await general.turns.goalChangeBasis(this.#actor, { workId, sessionId: this.#selectedSession.scope.sessionId });
    const current = await this.#profile.runtime.state(workId); this.assertState(current);
    if (result.expectedGoalRevision !== current.goal.revision || this.digest(result.expectedInput) !== this.digest(current.conversation?.session?.input))
      throw new Error('stale_session_input');
    return result;
  }); }
  private async fixturePlan(workId: string, expectedGoalRevision: number) {
    if (this.#profile.general) return;
    const state = await this.#profile.runtime.state(workId); this.assertState(state);
    if (state.goal.revision !== expectedGoalRevision) throw new Error('stale_user_command');
    if (state.plan?.goalRevision === state.goal.revision || state.attempts.some(attempt => ['reserved', 'running', 'received'].includes(attempt.status))) return;
    if (['cancelled', 'paused', 'failed', 'completed'].includes(state.status)) return;
    const scenario = this.#profile.scenarios.find(candidate => candidate.goal.scope === state.goal.scope && candidate.synthetic && candidate.complexity === 'simple');
    if (!scenario) throw new Error('web_scenario_unavailable');
    const checkpoint = scenario.checkpoints.find(candidate => candidate.expectedComplete);
    const evidenceIds = checkpoint?.evidenceIds.length ? checkpoint.evidenceIds : scenario.evidence.filter(evidence => evidence.coverage === 'complete' && evidence.status === 'accepted').map(evidence => evidence.id);
    const tasks: TaskSpec[] = [{ id: `synthetic-source-g${state.goal.revision}`, description: '합성 예제의 지정 원본 조회', toolId: 'fixture.read', toolVersion: '1', input: { evidenceIds }, dependsOn: [], effect: 'read', maxAttempts: 2, satisfies: state.goal.criteria.map(criterion => criterion.id) }];
    await this.#profile.runtime.submitPlan(workId, `demo-plan:${state.goal.revision}:${state.plan?.revision ?? 0}`, { baseStateRevision: state.revision, baseGoalRevision: state.goal.revision, basePlanRevision: state.plan?.revision ?? 0,
      reason: '명시적 합성 예제 계획; 모델 추론 아님', tasks, hypotheses: [] });
  }
  private async sessionCommand(workId: string, commandId: string, input: WebCommandInput,
    apply: () => Promise<{ created: boolean }>): Promise<boolean> {
    const sessions = this.#profile.sessions;
    const state = await this.#profile.runtime.state(workId); this.assertState(state);
    const scope = state.conversation?.session?.scope;
    if (!sessions || !scope) throw new Error('session_unavailable');
    const data = asJson({ actor: this.#actor, conversationId: this.#conversationId, input });
    const receipt = await this.#profile.services.state.receipt(workId, commandId);
    if (receipt && receipt.digest !== this.digest({ type: 'web_session_command_requested', data })) throw new Error('idempotency_conflict');
    if (!receipt && await sessions.repository.input(scope, commandId)) {
      // Before shared Web receipts, the immutable inbox carried this identity. Its original
      // command still validates retries; do not overwrite it with a different Web intent.
      return !(await apply()).created;
    }
    // Use the same CAS receipt key as run/legacy commands. The full original is durable before
    // session intake; a retry after this commit continues the existing command, never inference.
    const intent = await transact(this.#profile.services, workId, commandId, 'web_session_command_requested', data,
      current => { this.assertState(current); });
    const result = await apply();
    return !intent.committed || !result.created;
  }
  private async perform(workId: string, commandId: string, input: WebCommandInput): Promise<WebCommandResult> {
    if (input.kind === 'request-goal') {
      const general = this.#profile.general; if (!general || !this.#selectedSession) throw new Error('agent_goal_change_unavailable');
      const current = await this.#profile.runtime.state(workId); this.assertState(current);
      const sessionId = this.#selectedSession.scope.sessionId;
      const duplicate = await this.sessionCommand(workId, commandId, input, () => general.turns.changeGoal(this.#actor, { sessionId, workId,
        messageId: commandId, rawText: input.rawText, expectedGoalRevision: input.expectedGoalRevision,
          expectedControlRevision: input.expectedControlRevision, expectedInput: input.expectedInput, mode: input.mode }));
      await this.#profile.workflow.reconcileUsage(workId, this.#actor);
      return { workId, accepted: true, duplicate, view: await this.view(workId) };
    }
    const receipt = await this.#profile.services.state.receipt(workId, commandId);
    if (input.kind === 'run') {
      const data = asJson({ actor: this.#actor, conversationId: this.#conversationId, input });
      if (receipt) {
        if (receipt.digest !== this.digest({ type: 'web_run_requested', data })) throw new Error('idempotency_conflict');
        return { workId, accepted: true, duplicate: true, view: await this.view(workId) };
      }
      if (this.#profile.sessions && this.#selectedSession &&
        await this.#profile.sessions.repository.input(this.#selectedSession.scope, commandId)) throw new Error('idempotency_conflict');
      if (this.#coordination.runs.has(workId)) throw new Error('web_run_in_progress');
      if (this.#coordination.runs.size >= 4) throw new Error('web_run_capacity');
      this.#coordination.runs.set(workId, commandId);
      try {
        const intent = await transact(this.#profile.services, workId, commandId, 'web_run_requested', data, state => {
          this.assertState(state); if (state.goal.revision !== input.expectedGoalRevision) throw new Error('stale_user_command');
          if (['cancelled', 'failed', 'completed'].includes(state.status)) throw new Error('work_terminal');
          if (state.status === 'paused') throw new Error('web_work_paused');
        });
        if (!intent.committed) return { workId, accepted: true, duplicate: true, view: await this.view(workId) };
        await this.fixturePlan(workId, input.expectedGoalRevision);
        const current = await this.#profile.runtime.state(workId); this.assertState(current);
        if (current.goal.revision !== input.expectedGoalRevision) throw new Error('stale_user_command');
        await this.#profile.workflow.run(workId, this.#actor, { maxSteps: 40, expectedGoalRevision: input.expectedGoalRevision });
        return { workId, accepted: true, duplicate: false, view: await this.view(workId) };
      } finally { this.#coordination.runs.delete(workId); }
    }
    let duplicate = Boolean(receipt);
    const dispatch = async (command: UserCommand) => {
      const state = await this.#profile.runtime.state(workId); this.assertState(state);
      const sessionId = state.conversation?.session?.scope.sessionId;
      if (sessionId && this.#profile.sessions) {
        const rawText = input.rawText;
        if (!rawText) throw new Error('session_text_required');
        const sessions = this.#profile.sessions;
        duplicate = await this.sessionCommand(workId, commandId, input, () => sessions.command(this.#actor,
          { sessionId, messageId: commandId, workId, rawText, expectedGoalRevision: input.expectedGoalRevision, command }));
        return;
      }
      return this.#profile.runtime.command(workId, commandId, this.#actor, input.expectedGoalRevision, command);
    };
    if (input.kind === 'goal') {
      if (this.#profile.general) throw new Error('web_request_invalid');
      const allowed = this.#profile.scenarios.some(scenario => scenario.synthetic && scenario.complexity === 'simple' && scenario.goal.scope === input.goal.scope);
      if (!allowed) throw new Error('web_scenario_unavailable');
      await dispatch({ kind: 'goal', goal: input.goal, expectedControlRevision: input.expectedControlRevision });
    } else if (input.kind === 'mode') await dispatch(
      { kind: 'mode', mode: input.mode, reason: input.reason, expectedControlRevision: input.expectedControlRevision });
    else if (input.kind === 'resolve') {
      if (!receipt && !this.#profile.sessions) { const view = await this.view(workId); if (view.kind !== 'snapshot' || !view.view.questions?.some(question => question.id === input.obligationId)) throw new Error('obligation_not_resolvable'); }
      await dispatch({ kind: 'resolve', obligationId: input.obligationId, reason: input.reason });
    } else await dispatch({ kind: input.kind, reason: input.reason ?? `user_requested_${input.kind}` });
    await this.#profile.workflow.reconcileUsage(workId, this.#actor);
    return { workId, accepted: true, duplicate, view: await this.view(workId) };
  }
  async drain(): Promise<void> {
    this.#draining = true;
    this.#listCursors.clear();
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
    await Promise.all(this.#profile.runtime.pendingExecutions().map(attemptId => this.#profile.runtime.settlePending(attemptId)));
    await this.#profile.compactPlanning?.settlePending();
  }
}
