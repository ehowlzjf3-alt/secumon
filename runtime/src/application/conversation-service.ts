import { z } from 'zod';
import { accessibleEvidence, evaluateResultReadiness } from '../domain/completion.js';
import { hypothesesRequireReview } from '../domain/hypotheses.js';
import { dataGeneration, artifactBlocked } from '../domain/data-lifecycle.js';
import { knowledgeInputsCurrent, refreshKnowledge } from './knowledge-state.js';
import { refreshEffectProofs } from './effect-proofs.js';
import { completionProofsCurrent as effectProofsCurrent } from './completion-proofs.js';
import { deliveryObligationId, type ConversationBinding, type PreparedResponse } from '../domain/conversation.js';
import type { Delivery, Evidence, WorkState } from '../domain/model.js';
import { BudgetSchema, ConversationBindingSchema, GoalSchema, PolicySchema, parseContract } from './contracts.js';
import type { RuntimeServices } from './services.js';
import { newWork } from './new-work.js';
import { budgetSummary, totalExposure } from '../domain/budget-delegation.js';
import { authorizedWork, type WorkActor } from './work-resources.js';
import { asJson } from './plan-validator.js';
import { transact } from './work-transactions.js';
import { effectiveExecutionLimits, executionControl } from '../domain/execution-policy.js';
import { progressSummary } from './execution-control.js';
import { allowsDisclosure, disclosureLabels } from '../domain/disclosure.js';
import type { AppliedSessionInput } from '../domain/session.js';
import { sessionInputsCurrent } from './session-context.js';
import { generatedAnswerCurrent, generatedAnswerDigest, readGeneratedAnswer, responseText, type GeneratedAnswerServices } from './generated-answer.js';

export const BindingInputSchema = ConversationBindingSchema.omit({ id: true });
export const AcceptRequestSchema = z.strictObject({ messageId: z.string().min(1).max(256), binding: BindingInputSchema, goal: GoalSchema,
  policy: PolicySchema, limits: BudgetSchema.shape.limits, completionRequiresDelivery: z.boolean(),
  initialQuestions: z.array(z.strictObject({ id: z.string().min(1).max(256), reason: z.string().min(1).max(10000) })).max(32).optional() });
export type AcceptRequest = z.infer<typeof AcceptRequestSchema>;
export function assertOwner(state: WorkState, actor: WorkActor) {
  if (state.policy.tenantId !== actor.tenantId || state.policy.principalId !== actor.principalId) throw new Error('work_unavailable');
}
export function resultProof(state: WorkState) {
  const readiness = evaluateResultReadiness(state.goal, state.evidence, state.obligations, state.policy, state.attempts, state);
  if (hypothesesRequireReview(state)) readiness.blockers.push('hypothesis_review_required');
  if (state.conversation?.sessionReviewRequired) readiness.blockers.push('session_input_requires_review');
  if (state.personalMemoryReviewRequired) readiness.blockers.push('personal_memory_requires_review');
  if (pendingModels(state)) readiness.blockers.push('model_call_pending');
  if (state.notifications?.length) readiness.blockers.push('external_notifications_pending');
  if (pendingReconciliations(state)) readiness.blockers.push('computer_reconciliation_pending');
  if (readiness.blockers.length) readiness.complete = false;
  const current = new Map(accessibleEvidence(state.evidence, state.policy, state.goal.scope).map(e => [e.id, e]));
  const ids = [...new Set([...readiness.criteria.flatMap(c => c.evidenceIds),
    ...(state.goal.responseRequirement ? state.generatedAnswer?.evidenceIds.filter(id => current.has(id)) ?? [] : [])])].sort();
  return { readiness, evidence: ids.map(id => current.get(id)!), ids };
}
function pendingModels(state: WorkState) { return state.modelCalls.some(call => ['reserved', 'running', 'received'].includes(call.status)); }
function pendingReconciliations(state: WorkState) { return state.computerReconciliations?.some(call => ['reserved', 'running', 'received'].includes(call.status)) ?? false; }
function printable(value: string) { return value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ''); }
function displayTime(value: number) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? String(value) : date.toISOString(); }
export function renderResult(state: WorkState, evidence: Evidence[]): string {
  const lines = state.goal.criteria.map(c => {
    const matching = evidence.filter(e => Object.hasOwn(e.facts, c.key));
    const values = [...new Set(matching.map(e => JSON.stringify(e.facts[c.key])))];
    return `- ${printable(c.description || c.key)}: ${values.map(v => printable(v)).join(', ')} (근거: ${matching.map(e => printable(e.id)).join(', ')})`;
  });
  return `[${state.id} · 목표 ${state.goal.revision}] 확인 결과\n${lines.join('\n')}\n\n출처\n${evidence.map(e => `- ${printable(e.id)}: ${printable(e.locator)} · 관측 ${displayTime(e.observedAt)}`).join('\n')}`;
}

export class ConversationService {
  constructor(readonly services: GeneratedAnswerServices & Pick<RuntimeServices, 'state' | 'artifacts' | 'clock' | 'effects'>) {}
  private binding(input: z.infer<typeof BindingInputSchema>, policy: WorkState['policy']): ConversationBinding {
    const value = parseContract(BindingInputSchema, input);
    if (value.tenantId !== policy.tenantId || value.principalId !== policy.principalId || value.recipientId !== policy.principalId || !policy.allowedDestinations.includes(value.destination)) throw new Error('conversation_route_not_authorized');
    return { ...value, id: `binding-${this.services.digester.digest(asJson(value))}` };
  }
  private delivery(state: WorkState, binding: ConversationBinding, kind: Delivery['kind'], id: string, text: string, extra: Partial<NonNullable<Delivery['context']>> = {}): Delivery {
    return { id, workId: state.id, goalRevision: state.goal.revision, destination: binding.destination, kind, text, status: 'pending', externalId: null, dispatch: null,
      context: { binding, sourceRevision: state.revision, dataGeneration: dataGeneration(state), labels: [], responseId: null, evidenceIds: [], evidenceDigest: null, obligationIds: [], artifact: null, ...extra } };
  }
  async accept(actor: WorkActor, value: AcceptRequest, session?: AppliedSessionInput) {
    const input = parseContract(AcceptRequestSchema, value);
    if (input.binding.session || session && (session.scope.tenantId !== actor.tenantId || session.scope.principalId !== actor.principalId)) throw new Error('session_route_not_authorized');
    if (actor.tenantId !== input.policy.tenantId || actor.principalId !== input.policy.principalId) throw new Error('request_not_authorized');
    if (input.goal.revision !== 1) throw new Error('initial_goal_revision_required');
    const binding = this.binding({ ...input.binding, ...(session ? { session: session.scope } : {}) }, input.policy);
    const workId = `work-${this.services.digester.digest(asJson({ binding: binding.id, messageId: input.messageId }))}`;
    const digest = this.services.digester.digest(asJson(session ? { input, session } : input));
    const state = newWork({ id: workId, goal: input.goal, policy: input.policy, limits: input.limits, now: this.services.clock.now() });
    state.conversation = { bindings: [binding], primaryBindingId: binding.id, completionRequiresDelivery: input.completionRequiresDelivery, result: null, ...(session ? { session } : {}) };
    if (input.completionRequiresDelivery) state.obligations.push({ id: deliveryObligationId(state.goal.revision), kind: 'delivery', reason: 'result_delivery_required', status: 'pending', wakeKey: deliveryObligationId(state.goal.revision), dueAt: state.deadlineAt });
    const ack = this.delivery(state, binding, 'ack', 'ack', `[${workId}] 요청을 접수했습니다.`);
    const deliveries = [ack];
    for (const question of input.initialQuestions ?? []) {
      if (state.obligations.some(obligation => obligation.id === question.id)) throw new Error('initial_question_conflict');
      state.obligations.push({ ...question, kind: 'response', status: 'pending', wakeKey: question.id, dueAt: null });
      state.status = 'waiting'; state.statusReason = 'pending_obligation';
      deliveries.push(this.delivery(state, binding, 'question', `initial-question:${question.id}`,
        `[${workId} · 목표 ${state.goal.revision}] 추가 확인이 필요합니다.\n- ${printable(question.reason)} (${printable(question.id)})`, { labels: disclosureLabels(state), obligationIds: [question.id] }));
    }
    const result = await this.services.state.commit({ workId, expectedRevision: 0, commandId: 'conversation.accept', commandDigest: digest, next: state,
      events: [{ type: 'request_accepted', at: state.createdAt, data: { messageId: input.messageId, bindingId: binding.id } }], deliveries });
    if (result.kind === 'idempotency_conflict' || result.kind === 'conflict') throw new Error('request_identity_conflict');
    return { workId, accepted: result.kind === 'committed', state: (await this.services.state.get(workId))! };
  }
  async attach(workId: string, actor: WorkActor, input: z.infer<typeof BindingInputSchema>) {
    const current = await authorizedWork(this.services.state, workId, actor); const binding = this.binding(input, current.policy);
    return (await transact(this.services, workId, `attach:${binding.id}`, 'conversation_attached', asJson(binding), state => {
      assertOwner(state, actor); this.binding(input, state.policy);
      if (!state.conversation) throw new Error('conversation_missing');
      if (!state.conversation.bindings.some(b => b.id === binding.id)) state.conversation.bindings.push(binding);
    })).state;
  }
  async list(actor: WorkActor, channel: string, conversationId: string) {
    return this.services.state.workIdsForConversation(actor.tenantId, actor.principalId, channel, conversationId);
  }
  async listPage(actor: WorkActor, channel: string, conversationId: string, options: { cursor?: string; limit: number }) {
    return this.services.state.conversationWorkPage({ tenantId: actor.tenantId, principalId: actor.principalId, channel, conversationId,
      limit: options.limit, ...(options.cursor === undefined ? {} : { cursor: options.cursor }) });
  }
  private primary(state: WorkState) {
    const binding = state.conversation?.bindings.find(b => b.id === state.conversation?.primaryBindingId);
    if (!binding) throw new Error('conversation_missing');
    const { id: _id, ...input } = binding; this.binding(input, state.policy); return binding;
  }
  async prepare(workId: string, actor: WorkActor): Promise<Delivery | null> {
    await authorizedWork(this.services.state, workId, actor);
    await refreshKnowledge(this.services, workId);
    await refreshEffectProofs(this.services, workId);
    const state = await authorizedWork(this.services.state, workId, actor);
    if (!(await sessionInputsCurrent(this.services, state))) throw new Error('session_input_pending');
    if (!state.conversation || state.status === 'cancelled' || state.status === 'paused' || pendingModels(state) || pendingReconciliations(state) || state.attempts.some(a => ['reserved', 'running', 'received'].includes(a.status))) return null;
    if (!(await effectProofsCurrent(this.services, state))) throw new Error('response_state_changed');
    const binding = this.primary(state);
    if (!allowsDisclosure(state.policy, binding.destination, 'channel', disclosureLabels(state))) throw new Error('channel_disclosure_denied');
    const proof = resultProof(state);
    const pending = state.obligations.filter(o => !o.source && o.status === 'pending' && ['response', 'evidence'].includes(o.kind));
    let delivery: Delivery; let response: PreparedResponse | null = null;
    if (proof.readiness.complete && !['failed', 'blocked'].includes(state.status)) {
      const answer = state.goal.responseRequirement ? await readGeneratedAnswer(this.services, state) : null;
      if (state.goal.responseRequirement && !answer) throw new Error('response_state_changed');
      const evidenceDigest = this.services.digester.digest(asJson(proof.evidence));
      const id = `result-${this.services.digester.digest({ goalRevision: state.goal.revision, dataGeneration: dataGeneration(state), evidenceDigest, bindingId: binding.id,
        ...(answer ? { generatedAnswerDigest: answer.answerDigest } : {}) })}`;
      const existing = (await this.services.state.deliveries(workId)).find(d => d.id === id);
      if (existing && !(existing.status === 'superseded' && !existing.dispatch)) return null;
      const text = answer?.text ?? renderResult(state, proof.evidence); const labels = disclosureLabels(state);
      const artifact = answer ? state.generatedAnswer!.artifact : await this.services.artifacts.put(new TextEncoder().encode(text), { tenantId: state.policy.tenantId, labels, mediaType: 'text/plain' });
      response = { id, goalRevision: state.goal.revision, sourceRevision: state.revision, evidenceIds: proof.ids, evidenceDigest, artifact, labels,
        ...(answer ? { generatedAnswerDigest: answer.answerDigest } : {}) };
      const summary = responseText(text, artifact);
      delivery = this.delivery(state, binding, 'result', id, summary, { labels, responseId: id, evidenceIds: proof.ids, evidenceDigest, artifact,
        ...(answer ? { generatedAnswerDigest: answer.answerDigest } : {}),
        obligationIds: state.conversation.completionRequiresDelivery ? [deliveryObligationId(state.goal.revision)] : [] });
    } else if (pending.length && state.status !== 'failed') {
      const id = `question-${this.services.digester.digest(asJson({ goalRevision: state.goal.revision, dataGeneration: dataGeneration(state), bindingId: binding.id, pending }))}`;
      if ((await this.services.state.deliveries(workId)).some(d => d.id === id)) return null;
      const text = `[${workId} · 목표 ${state.goal.revision}] 추가 확인이 필요합니다.\n${pending.map(o => `- ${printable(o.reason)} (${printable(o.id)})`).join('\n')}`;
      const labels = disclosureLabels(state);
      const artifact = text.length > 12000 ? await this.services.artifacts.put(new TextEncoder().encode(text), { tenantId: state.policy.tenantId, labels, mediaType: 'text/plain' }) : null;
      const summary = artifact ? `${text.slice(0, 11000)}\n… 질문 일부를 줄여 표시했습니다. 전체 질문 산출물: ${artifact.id}` : text;
      delivery = this.delivery(state, binding, 'question', id, summary, { labels, obligationIds: pending.map(o => o.id), artifact });
    } else if (state.status === 'failed' || state.status === 'blocked') {
      const id = `failure-${this.services.digester.digest({ goalRevision: state.goal.revision, dataGeneration: dataGeneration(state), reason: state.statusReason })}`;
      if ((await this.services.state.deliveries(workId)).some(d => d.id === id)) return null;
      delivery = this.delivery(state, binding, 'failure', id, `[${workId}] 작업을 진행할 수 없습니다. 상태 조회에서 제한 사유를 확인해 주세요.`);
    } else return null;
    if (!(await knowledgeInputsCurrent(this.services, state))) { await refreshKnowledge(this.services, workId); throw new Error('response_state_changed'); }
    if (!(await effectProofsCurrent(this.services, state))) { await refreshEffectProofs(this.services, workId); throw new Error('response_state_changed'); }
    if (response && !(await generatedAnswerCurrent(this.services, state, response.generatedAnswerDigest))) throw new Error('response_state_changed');
    const created = await transact(this.services, workId, `prepare:${delivery.id}:${state.revision}`, 'response_prepared', { responseId: delivery.id, kind: delivery.kind }, next => {
      assertOwner(next, actor); if (next.revision !== state.revision) throw new Error('response_state_changed');
      if (delivery.context?.artifact && !next.artifacts.some(a => a.id === delivery.context!.artifact!.id)) next.artifacts.push(delivery.context.artifact);
      if (response) {
        next.conversation!.result = response;
        if (!next.artifacts.some(a => a.id === response.artifact.id)) next.artifacts.push(response.artifact);
        if (next.conversation!.completionRequiresDelivery) {
          const obligation = next.obligations.find(o => o.id === deliveryObligationId(next.goal.revision)); if (obligation) obligation.status = 'pending';
        }
      }
      return [delivery];
    }, async () => {
      if (!(await effectProofsCurrent(this.services, state))) throw new Error('response_state_changed');
      if (response && !(await generatedAnswerCurrent(this.services, state, response.generatedAnswerDigest))) throw new Error('response_state_changed');
    });
    if (created.committed) {
      await refreshKnowledge(this.services, workId);
      const current = await refreshEffectProofs(this.services, workId);
      if (dataGeneration(current) !== dataGeneration(state) || !(await effectProofsCurrent(this.services, current)) ||
        (response && (!resultProof(current).readiness.complete || !(await generatedAnswerCurrent(this.services, current, response.generatedAnswerDigest))))) throw new Error('response_state_changed');
    }
    return created.committed ? delivery : null;
  }
  async snapshot(workId: string, actor: WorkActor) {
    for (let retry = 0; retry < 8; retry++) {
    const state = await authorizedWork(this.services.state, workId, actor); const deliveries = await this.services.state.deliveries(workId);
    const proof = resultProof(state); const response = state.conversation?.result;
    if (!(await knowledgeInputsCurrent(this.services, state))) { proof.readiness.complete = false; proof.readiness.blockers.push('knowledge_dependency_changed'); }
    if (!(await effectProofsCurrent(this.services, state))) { proof.readiness.complete = false; proof.readiness.blockers.push('effect_proof_unavailable'); }
    const answerCurrent = await generatedAnswerCurrent(this.services, state);
    if (!answerCurrent) { proof.readiness.complete = false; proof.readiness.blockers.push('generated_answer_changed'); }
    const currentDelivery = response ? deliveries.find(d => d.id === response.id) : undefined;
    let resultReady = Boolean(response && response.goalRevision === state.goal.revision && proof.readiness.complete && response.labels.every(l => state.policy.allowedLabels.includes(l)) &&
      response.evidenceDigest === this.services.digester.digest(asJson(proof.evidence)) && !artifactBlocked(state, response.artifact) && await this.services.artifacts.exists(response.artifact));
    if (resultReady && response?.generatedAnswerDigest !== generatedAnswerDigest(this.services, state)) resultReady = false;
    if (resultReady && state.goal.responseRequirement && response && this.services.digester.digest(asJson(response.artifact)) !==
      this.services.digester.digest(asJson(state.generatedAnswer?.artifact))) resultReady = false;
    if (!(await knowledgeInputsCurrent(this.services, state))) { resultReady = false; proof.readiness.complete = false; }
    if (!(await effectProofsCurrent(this.services, state))) { resultReady = false; proof.readiness.complete = false; }
    if ((await authorizedWork(this.services.state, workId, actor)).revision !== state.revision) continue;
    const control = executionControl(state); const limits = effectiveExecutionLimits(state); const usage = totalExposure(state);
    return { workId: state.id, goalRevision: state.goal.revision, revision: state.revision, status: state.status, reason: state.statusReason,
      execution: { revision: control.revision, requestedMode: control.requestedMode, strategy: control.strategy, pending: control.pending, lastReason: control.lastReason,
        limits, remaining: { toolCalls: Math.max(0, limits.toolCalls - usage.toolCalls), modelCalls: Math.max(0, limits.modelCalls - usage.modelCalls),
          tokens: Math.max(0, limits.tokens - usage.tokens), replans: Math.max(0, limits.replans - usage.replans) },
        ...(state.budgetParent || state.budgetGrants?.length ? { delegation: budgetSummary(state) } : {}),
        reserved: { toolCalls: state.budget.reservedToolCalls, modelCalls: state.budget.reservedModelCalls, tokens: state.budget.reservedTokens },
        deadlineAt: state.deadlineAt, retryWakeAt: state.retryWakeAt ?? null,
        activeModels: state.modelCalls.filter(c => ['reserved', 'running', 'received'].includes(c.status)).length, progress: progressSummary(state),
        unmetCriteria: proof.readiness.criteria.filter(c => !c.met).map(c => ({ id: c.id, reasons: c.reasons })) },
      analysisReady: proof.readiness.complete, resultReady, resultDelivery: currentDelivery?.status ?? 'not_prepared',
      pendingQuestions: state.obligations.filter(o => !o.source && o.status === 'pending' && ['response', 'evidence'].includes(o.kind)).map(o => ({ id: o.id, reason: o.reason })),
      activeAttempts: state.attempts.filter(a => ['reserved', 'running', 'received'].includes(a.status)).length,
      unresolvedEffects: state.obligations.filter(o => o.kind === 'effect_reconciliation' && o.status === 'pending').length,
      unresolvedDeliveries: deliveries.filter(d => d.status === 'unknown' || d.status === 'sending').length,
      usage: state.budget.used, conversationIds: state.conversation?.bindings.map(b => b.conversationId) ?? [] };
    }
    throw new Error('conversation_snapshot_contention');
  }
}
