import { z } from 'zod';
import type { ArtifactRef, Delivery, Evidence, Policy, WorkState } from '../domain/model.js';
import type { ConversationBinding } from '../domain/conversation.js';
import type { WorkView, WorkViewAccess, WorkViewOptions, WorkViewResult } from '../domain/work-view.js';
import { allowsDisclosure, disclosureLabels } from '../domain/disclosure.js';
import { artifactBlocked, dataGeneration } from '../domain/data-lifecycle.js';
import { accessibleEvidence } from '../domain/completion.js';
import { executionControl } from '../domain/execution-policy.js';
import { hypothesesRequireReview } from '../domain/hypotheses.js';
import type { ArtifactStore, Digester, StateRepository } from './ports.js';
import type { EffectProofValidator, ExternalObligationValidator, ExternalNotificationValidator, KnowledgeValidator, ReadCoverageProofValidator, WorkInputValidator } from './services.js';
import type { WorkActor } from './work-resources.js';
import { asJson } from './plan-validator.js';
import { resultProof, renderResult } from './conversation-service.js';
import { knowledgeInputsCurrent } from './knowledge-validity.js';
import { completionProofsCurrent as effectProofsCurrent } from './completion-proofs.js';
import { generatedAnswerCurrent, readGeneratedAnswer, responseText, type GeneratedAnswerServices } from './generated-answer.js';

export interface WorkViewServices extends Pick<GeneratedAnswerServices, 'sessions' | 'personalMemories' | 'generatedAnswers'> {
  state: Pick<StateRepository, 'get' | 'deliveries' | 'recentEventMetadata'>;
  artifacts: Pick<ArtifactStore, 'get'>;
  digester: Digester;
  knowledge?: KnowledgeValidator | undefined;
  inputs?: WorkInputValidator | undefined;
  effects?: Pick<EffectProofValidator, 'current'> | undefined;
  obligations?: ExternalObligationValidator | undefined;
  notifications?: ExternalNotificationValidator | undefined;
  readCoverage?: ReadCoverageProofValidator | undefined;
}
const id = z.string().min(1).max(256);
const actorSchema = z.object({ tenantId: id, principalId: id, allowedLabels: z.array(id).max(10000).optional(),
  allowedTools: z.array(id).max(10000).optional(), allowedDestinations: z.array(id).max(10000).optional(), allowWrites: z.boolean().optional() });
const accessSchema = z.strictObject({ channel: z.enum(['cli', 'web', 'knox', 'test', 'peer']), conversationId: id, destination: id, recipientId: id, allowDiagnostics: z.boolean() });
const optionsSchema = z.strictObject({ level: z.enum(['conversation', 'details', 'diagnostics']), cursor: z.string().max(256).optional() });
const LIMIT = 20;
const QUESTION_LIMIT = 10;
function text(value: string, length: number, singleLine = false): string {
  const safe = value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, '');
  const valueChars = Array.from(singleLine ? safe.replace(/\s+/g, ' ').trim() : safe);
  return valueChars.length > length ? `${valueChars.slice(0, length - 1).join('')}…` : valueChars.join('');
}
function effectivePolicy(policy: Policy, actor: WorkActor): Policy {
  const next = structuredClone(policy);
  for (const key of ['allowedLabels', 'allowedTools', 'allowedDestinations'] as const) next[key] = next[key].filter(value => actor[key] === undefined || actor[key]!.includes(value));
  next.allowWrites &&= actor.allowWrites !== false;
  return next;
}
type Authorized = { raw: WorkState; state: WorkState; binding: ConversationBinding; primary: ConversationBinding; labels: string[] };

/** A current, explicitly disclosed projection. Its ports contain no execution or mutation operations. */
export class WorkViewService {
  constructor(readonly services: WorkViewServices) {}
  private digest(value: unknown) { return this.services.digester.digest(asJson(value)); }
  private async authorized(workId: string, actor: WorkActor, access: WorkViewAccess, options: WorkViewOptions): Promise<Authorized> {
    const stored = await this.services.state.get(workId);
    if (!stored || stored.policy.tenantId !== actor.tenantId || stored.policy.principalId !== actor.principalId) throw new Error('work_view_denied');
    const raw = structuredClone(stored); const state = structuredClone(raw); state.policy = effectivePolicy(raw.policy, actor);
    const bindings = state.conversation?.bindings.filter(binding => binding.channel === access.channel && binding.conversationId === access.conversationId &&
      binding.destination === access.destination && binding.recipientId === access.recipientId && binding.recipientId === actor.principalId &&
      binding.tenantId === actor.tenantId && binding.principalId === actor.principalId) ?? [];
    const primary = state.conversation?.bindings.find(binding => binding.id === state.conversation?.primaryBindingId);
    const labels = disclosureLabels(raw);
    if (bindings.length !== 1 || !primary || primary.tenantId !== actor.tenantId || primary.principalId !== actor.principalId ||
      !allowsDisclosure(state.policy, access.destination, 'screen', labels)) throw new Error('work_view_denied');
    if (options.level === 'diagnostics' && (!access.allowDiagnostics || !allowsDisclosure(state.policy, access.destination, 'log', labels))) throw new Error('work_view_diagnostics_denied');
    return { raw, state, labels, binding: bindings[0]!, primary };
  }
  private async knowledgeCurrent(state: WorkState) {
    try { if (await knowledgeInputsCurrent(this.services, state)) return; } catch { /* Fixed error: validators can contain private source identifiers. */ }
    throw new Error('work_view_knowledge_changed');
  }
  private async project(current: Authorized, access: WorkViewAccess, options: WorkViewOptions): Promise<WorkView> {
    const { state, labels, binding, primary } = current;
    await this.knowledgeCurrent(state);
    const deliveries = await this.services.state.deliveries(state.id);
    const visible = accessibleEvidence(state.evidence, state.policy, state.goal.scope);
    const records = new Map(visible.map(record => [record.id, record]));
    const artifacts = new Map<string, Promise<Uint8Array | null>>();
    const artifact = (ref: ArtifactRef): Promise<Uint8Array | null> => {
      const key = this.digest(ref); let read = artifacts.get(key);
      if (!read) { read = (async () => {
        if (artifactBlocked(state, ref) || ref.tenantId !== state.policy.tenantId || !ref.labels.every(label => state.policy.allowedLabels.includes(label))) return null;
        try { const bytes = await this.services.artifacts.get(ref, state.policy); return bytes.byteLength === ref.byteLength ? bytes : null; } catch { return null; }
      })(); artifacts.set(key, read); }
      return read;
    };
    const valid = new Map<string, Promise<boolean>>();
    const evidenceValid = (record: Evidence): Promise<boolean> => {
      let check = valid.get(record.id);
      if (!check) { check = (async () => {
        if (!records.has(record.id) || (record.artifact && !await artifact(record.artifact))) return false;
        for (const parentId of record.derivedFrom) { const parent = records.get(parentId); if (!parent || !await evidenceValid(parent)) return false; }
        return true;
      })(); valid.set(record.id, check); }
      return check;
    };
    const reviewRequired = hypothesesRequireReview(state) || (state.hypotheses.length > 0 && !(await Promise.all(visible.map(evidenceValid))).every(Boolean));
    const proof = resultProof(state);
    const proofValid = (await Promise.all(proof.evidence.map(evidenceValid))).every(Boolean);
    const activeAttempts = state.attempts.filter(attempt => ['reserved', 'running', 'received'].includes(attempt.status)).length;
    const activeModels = state.modelCalls.filter(call => ['reserved', 'running', 'received'].includes(call.status)).length;
    const canRespond = !['cancelled', 'paused', 'failed', 'blocked'].includes(state.status) && activeAttempts === 0 && activeModels === 0;
    const answer = state.goal.responseRequirement ? await readGeneratedAnswer(this.services, state) : null;
    const analysisReady = proof.readiness.complete && proofValid && !reviewRequired &&
      (!state.goal.responseRequirement || answer !== null) && await effectProofsCurrent(this.services, current.raw);
    const pending = state.obligations.filter(obligation => !obligation.source && obligation.status === 'pending' && ['response', 'evidence'].includes(obligation.kind));
    const registeredDelivery = (delivery: Delivery) => {
      const context = delivery.context;
      return delivery.workId === state.id && delivery.status !== 'superseded' && context &&
        context.sourceRevision <= state.revision && delivery.destination === context.binding.destination &&
        state.conversation!.bindings.some(known => this.digest(known) === this.digest(context.binding)) &&
        context.binding.tenantId === state.policy.tenantId && context.binding.principalId === state.policy.principalId &&
        allowsDisclosure(state.policy, access.destination, 'screen', [...new Set([...labels, ...context.labels])]);
    };
    const currentDelivery = (delivery: Delivery) => registeredDelivery(delivery) && delivery.goalRevision === state.goal.revision &&
      (delivery.context?.dataGeneration ?? 0) === dataGeneration(state);
    const messages: WorkView['messages'] = [];
    const questions: NonNullable<WorkView['questions']> = [];
    const append = (delivery: Delivery, body: string) => messages.push({ id: text(delivery.id, 256, true), kind: delivery.kind, text: text(body, 12000), deliveryStatus: delivery.status });
    const ack = deliveries.find(delivery => delivery.id === 'ack' && delivery.kind === 'ack' && registeredDelivery(delivery));
    if (ack) append(ack, `[${text(state.id, 256, true)}] 요청을 접수했습니다.`);
    const response = state.conversation!.result;
    const resultDelivery = response ? deliveries.find(delivery => delivery.id === response.id && delivery.kind === 'result') : undefined;
    let resultReady = false;
    if (canRespond && analysisReady && response && resultDelivery && currentDelivery(resultDelivery) && response.goalRevision === state.goal.revision &&
      response.sourceRevision <= state.revision && response.evidenceDigest === this.digest(proof.evidence) && this.digest(response.evidenceIds) === this.digest(proof.ids) &&
      resultDelivery.context?.responseId === response.id && resultDelivery.context.evidenceDigest === response.evidenceDigest &&
      response.generatedAnswerDigest === answer?.answerDigest && resultDelivery.context.generatedAnswerDigest === response.generatedAnswerDigest &&
      this.digest(resultDelivery.context.evidenceIds) === this.digest(proof.ids) && this.digest(resultDelivery.context.artifact) === this.digest(response.artifact) &&
      allowsDisclosure(state.policy, access.destination, 'screen', [...new Set([...labels, ...response.labels])])) {
      if (answer) {
        if (this.digest(response.artifact) === this.digest(state.generatedAnswer?.artifact) &&
          resultDelivery.text === responseText(answer.text, response.artifact)) { resultReady = true; append(resultDelivery, answer.text); }
      } else {
        const bytes = await artifact(response.artifact);
        if (bytes) try {
          const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          if (body === renderResult(state, proof.evidence)) { resultReady = true; append(resultDelivery, body); }
        } catch { /* Invalid response bytes are withheld; the work is not modified. */ }
      }
    }
    if (!resultReady && pending.length && !['cancelled', 'paused', 'failed', 'completed'].includes(state.status) && !activeAttempts && !activeModels) {
      const questionId = `question-${this.digest({ goalRevision: state.goal.revision, dataGeneration: dataGeneration(state), bindingId: primary.id, pending })}`;
      const question = deliveries.find(delivery => delivery.kind === 'question' && delivery.id === questionId && currentDelivery(delivery) &&
        this.digest(delivery.context!.obligationIds) === this.digest(pending.map(obligation => obligation.id)));
      // Questions may embed retained observations, so unavailable current originals also withhold the body.
      if (question && (await Promise.all(visible.map(evidenceValid))).every(Boolean) && (!question.context!.artifact || await artifact(question.context!.artifact))) {
        append(question, `[${text(state.id, 256, true)} · 목표 ${state.goal.revision}] 추가 확인이 필요합니다.\n${pending.slice(0, QUESTION_LIMIT).map(obligation => `- ${text(obligation.reason, 512, true)} (${text(obligation.id, 256, true)})`).join('\n')}${pending.length > QUESTION_LIMIT ? '\n… 나머지 질문을 줄여 표시했습니다.' : ''}`);
        for (const obligation of pending.slice(0, QUESTION_LIMIT)) if (text(obligation.id, 256, true) === obligation.id) questions.push({ id: obligation.id, reason: text(obligation.reason, 512, true) });
      }
    }
    if (!resultReady && ['failed', 'blocked'].includes(state.status) && !messages.some(message => message.kind === 'question')) {
      const failureId = `failure-${this.digest({ goalRevision: state.goal.revision, dataGeneration: dataGeneration(state), reason: state.statusReason })}`;
      const failure = deliveries.find(delivery => delivery.kind === 'failure' && delivery.id === failureId && currentDelivery(delivery));
      if (failure) append(failure, `[${text(state.id, 256, true)}] 작업을 진행할 수 없습니다. 상태 조회에서 제한 사유를 확인해 주세요.`);
    }
    const control = executionControl(state);
    const view: WorkView = { schemaVersion: 1, workId: text(state.id, 256, true), revision: state.revision, goalRevision: state.goal.revision, level: options.level,
      title: text(state.goal.description, 160, true), mode: { requested: control.requestedMode, strategy: control.strategy, pending: control.pending?.mode ?? null, revision: control.revision },
      reply: { channel: primary.channel, observingPrimary: binding.id === primary.id },
      progress: { status: state.status, reason: text(state.statusReason, 256, true), updatedAt: state.updatedAt, activeAttempts, activeModels, analysisReady, resultReady,
        resultDelivery: resultReady ? resultDelivery!.status : response ? 'unavailable' : 'not_prepared', pendingQuestions: pending.length }, messages, questions };
    if (options.level !== 'conversation') {
      const plan = state.plan?.goalRevision === state.goal.revision ? state.plan : null;
      const cards: NonNullable<WorkView['details']>['evidence'] = [];
      for (const record of visible) { if (cards.length === LIMIT) break; if (await evidenceValid(record)) cards.push({ id: text(record.id, 256, true), sourceId: text(record.sourceId, 256, true),
        locator: text(record.locator, 256, true), observedAt: record.observedAt, coverage: record.coverage }); }
      const goal = { revision: state.goal.revision, description: text(state.goal.description, 2000), scope: text(state.goal.scope, 256, true), mode: state.goal.mode,
        criteria: state.goal.criteria.slice(0, LIMIT).map(criterion => ({ ...criterion, id: text(criterion.id, 256, true), description: text(criterion.description, 512), key: text(criterion.key, 256, true),
          equals: typeof criterion.equals === 'string' ? text(criterion.equals, 512) : criterion.equals })) };
      view.details = { goal: { ...goal, editable: this.digest(goal) === this.digest(state.goal) },
        plan: plan ? { revision: plan.revision, reason: text(plan.reason, 512), tasks: plan.tasks.slice(0, LIMIT).map(task => ({ id: text(task.id, 256, true), description: text(task.description, 512),
          toolId: text(task.toolId, 256, true), status: state.attempts.filter(attempt => attempt.goalRevision === state.goal.revision && attempt.planRevision === plan.revision && attempt.taskId === task.id).at(-1)?.status ?? 'not_started' })) } : null,
        hypotheses: state.hypotheses.slice(0, LIMIT).map(hypothesis => ({ id: text(hypothesis.id, 256, true), question: text(hypothesis.question, 512), claim: text(hypothesis.claim, 512),
          reviewRequired, status: reviewRequired ? null : hypothesis.status, supportCount: reviewRequired ? null : hypothesis.supportIds.length,
          counterCount: reviewRequired ? null : hypothesis.counterIds.length })), evidence: cards,
        omitted: { tasks: Math.max(0, (plan?.tasks.length ?? 0) - LIMIT), hypotheses: Math.max(0, state.hypotheses.length - LIMIT), evidence: Math.max(0, visible.length - cards.length) } };
    }
    if (options.level === 'diagnostics') {
      const events = await this.services.state.recentEventMetadata(state.id, { throughRevision: state.revision, limit: 50 });
      view.diagnostics = { events: events.items.map(event => ({ sequence: event.sequence, revision: event.revision, type: text(event.type, 128, true), at: event.at })),
        omittedEvents: events.omittedCount };
    }
    await this.knowledgeCurrent(state);
    if (!(await effectProofsCurrent(this.services, current.raw)) ||
      (view.progress.analysisReady && !(await generatedAnswerCurrent(this.services, state, answer?.answerDigest)))) {
      view.progress.analysisReady = false; view.progress.resultReady = false;
      view.progress.resultDelivery = response ? 'unavailable' : 'not_prepared';
      view.messages = view.messages.filter(message => message.kind !== 'result');
    }
    return view;
  }
  async read(workId: string, actorInput: WorkActor, accessInput: WorkViewAccess, optionsInput: WorkViewOptions): Promise<WorkViewResult> {
    let actor: WorkActor; let access: WorkViewAccess; let options: WorkViewOptions;
    try {
      id.parse(workId); const parsed = actorSchema.parse(actorInput);
      actor = { tenantId: parsed.tenantId, principalId: parsed.principalId,
        ...(parsed.allowedLabels === undefined ? {} : { allowedLabels: parsed.allowedLabels }),
        ...(parsed.allowedTools === undefined ? {} : { allowedTools: parsed.allowedTools }),
        ...(parsed.allowedDestinations === undefined ? {} : { allowedDestinations: parsed.allowedDestinations }),
        ...(parsed.allowWrites === undefined ? {} : { allowWrites: parsed.allowWrites }) };
      access = accessSchema.parse(accessInput); options = optionsSchema.parse(optionsInput);
    }
    catch { throw new Error('work_view_invalid_request'); }
    for (let retry = 0; retry < 8; retry++) {
      const before = await this.authorized(workId, actor, access, options);
      const view = await this.project(before, access, options);
      const checked = await this.authorized(workId, actor, access, options);
      if (this.digest(before.raw) !== this.digest(checked.raw)) continue;
      // Artifacts and knowledge have lifetimes outside a work revision. A cursor never skips this second validation.
      const confirmed = await this.project(checked, access, options);
      if (this.digest(view) !== this.digest(confirmed)) continue;
      const final = await this.authorized(workId, actor, access, options);
      if (this.digest(checked.raw) !== this.digest(final.raw)) continue;
      if (confirmed.progress.analysisReady && !(await effectProofsCurrent(this.services, final.raw))) continue;
      if (confirmed.progress.analysisReady && !(await generatedAnswerCurrent(this.services, final.state))) continue;
      const cursor = `wv1:${this.digest({ workId, actor, policy: final.state.policy, labels: final.labels, access, level: options.level, view: confirmed })}`;
      return options.cursor === cursor ? { kind: 'unchanged', cursor } : { kind: 'snapshot', cursor, view: confirmed };
    }
    throw new Error('work_view_contention');
  }
}
