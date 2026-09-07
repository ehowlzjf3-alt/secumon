import type { Delivery, WorkState } from '../domain/model.js';
import { dataGeneration, artifactBlocked } from '../domain/data-lifecycle.js';
import { refreshKnowledge, knowledgeInputsCurrent } from './knowledge-state.js';
import type { RuntimeServices } from './services.js';
import { authorizedWork, type WorkActor } from './work-resources.js';
import { assertOwner, resultProof } from './conversation-service.js';
import { asJson } from './plan-validator.js';
import { transact } from './work-transactions.js';
import { allowsDisclosure, disclosureLabels } from '../domain/disclosure.js';
import { refreshEffectProofs } from './effect-proofs.js';
import { completionProofsCurrent as effectProofsCurrent, requiresCompletionProofs as requiresEffectProofs } from './completion-proofs.js';
import { sessionInputsCurrent } from './session-context.js';
import { generatedAnswerDigest, generatedDeliveryCurrent, type GeneratedAnswerServices } from './generated-answer.js';
import { assertExecutionAuthority, executionAuthorityCurrent } from './execution-authority.js';

type Outcome = { status: 'delivered'; externalId: string } | { status: 'unknown' | 'retryable_error' | 'absent' };
export class OutboxDispatcher {
  constructor(readonly services: GeneratedAnswerServices & Pick<RuntimeServices, 'state' | 'artifacts' | 'clock' | 'sink' | 'effects' | 'obligations' | 'notifications' | 'executionAuthority'>, readonly owner: string, readonly leaseMs = 30000, readonly maxAttempts = 3) {
    if (!owner || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) throw new Error('invalid_dispatcher_configuration');
  }
  private valid(state: WorkState, d: Delivery, actor: WorkActor): boolean {
    if (!executionAuthorityCurrent(this.services, state)) return false;
    const context = d.context; const binding = context?.binding;
    if (!context || !binding || state.policy.tenantId !== binding.tenantId || state.policy.principalId !== binding.principalId || binding.recipientId !== state.policy.principalId ||
      !state.policy.allowedDestinations.includes(d.destination) || d.destination !== binding.destination ||
      !context.labels.every(l => state.policy.allowedLabels.includes(l) && (actor.allowedLabels === undefined || actor.allowedLabels.includes(l))) ||
      (actor.allowedDestinations !== undefined && !actor.allowedDestinations.includes(d.destination)) ||
      !state.conversation?.bindings.some(b => this.services.digester.digest(asJson(b)) === this.services.digester.digest(asJson(binding)))) return false;
    if (!allowsDisclosure(state.policy, d.destination, 'channel', [...disclosureLabels(state), ...context.labels])) return false;
    if (d.kind === 'ack') return true;
    if ((context.dataGeneration ?? 0) !== dataGeneration(state) || (context.artifact && artifactBlocked(state, context.artifact))) return false;
    if (d.goalRevision !== state.goal.revision || ['cancelled', 'paused'].includes(state.status)) return false;
    if (d.kind === 'question') return context.obligationIds.length > 0 && context.obligationIds.every(id => state.obligations.some(o => o.id === id && o.status === 'pending'));
    if (d.kind === 'failure') return ['failed', 'blocked'].includes(state.status);
    const proof = resultProof(state);
    return state.status !== 'failed' && state.conversation.result?.id === context.responseId && proof.readiness.complete &&
      context.generatedAnswerDigest === generatedAnswerDigest(this.services, state) &&
      state.conversation.result?.generatedAnswerDigest === context.generatedAnswerDigest &&
      context.evidenceDigest === this.services.digester.digest(asJson(proof.evidence));
  }
  private async snapshot(workId: string, actor: WorkActor) {
    for (let n = 0; n < 8; n++) {
      const state = await authorizedWork(this.services.state, workId, actor); const deliveries = await this.services.state.deliveries(workId);
      if ((await this.services.state.get(workId))?.revision === state.revision) return { state, deliveries };
    }
    throw new Error('outbox_contention');
  }
  private async effectCurrent(workId: string, state: WorkState): Promise<boolean> {
    if (!requiresEffectProofs(state)) return true;
    // Proofs pin stored policy; valid() separately enforces the actor's narrower channel authority.
    const original = await this.services.state.get(workId);
    if (!original || original.revision !== state.revision || original.policy.tenantId !== state.policy.tenantId ||
      original.policy.principalId !== state.policy.principalId) return false;
    if (await effectProofsCurrent(this.services, original)) return true;
    await refreshEffectProofs(this.services, workId); return false;
  }
  private async update(workId: string, actor: WorkActor, state: WorkState, delivery: Delivery, command: string, type: string, editState?: (next: WorkState) => void) {
    return transact(this.services, workId, command, type, { deliveryId: delivery.id, status: delivery.status, externalId: delivery.externalId, attempt: delivery.dispatch?.attempts ?? 0, owner: delivery.dispatch?.owner ?? null }, next => {
      assertOwner(next, actor); if (next.revision !== state.revision) throw new Error('outbox_state_changed');
      editState?.(next); return [delivery];
    }, requiresEffectProofs(state) ? async () => {
      const current = await authorizedWork(this.services.state, workId, actor);
      if (current.revision !== state.revision) throw new Error('outbox_state_changed');
      const original = await this.services.state.get(workId);
      if (!original || original.revision !== current.revision) throw new Error('outbox_state_changed');
      assertOwner(original, actor);
      if (!(await effectProofsCurrent(this.services, original))) throw new Error('outbox_effect_proof_changed');
    } : undefined);
  }
  private async bounded(call: () => Promise<Outcome>): Promise<Outcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([call(), new Promise<Outcome>(resolve => { timer = setTimeout(() => resolve({ status: 'unknown' }), this.leaseMs); })]);
    } catch { return { status: 'unknown' }; }
    finally { if (timer) clearTimeout(timer); }
  }
  private async settle(workId: string, actor: WorkActor, deliveryId: string, outcome: Outcome, attemptNumber: number) {
    for (let n = 0; n < 8; n++) {
      const { state, deliveries } = await this.snapshot(workId, actor); const d = deliveries.find(item => item.id === deliveryId);
      if (!d || d.status === 'delivered' || ['superseded', 'failed'].includes(d.status) || (d.dispatch?.attempts ?? 0) !== attemptNumber) return;
      if (!(await this.effectCurrent(workId, state))) return;
      const status: Delivery['status'] = outcome.status === 'delivered' ? 'delivered' : outcome.status === 'retryable_error' || outcome.status === 'absent' ?
        (attemptNumber >= this.maxAttempts ? 'failed' : 'pending') : 'unknown';
      const next: Delivery = { ...d, status, externalId: outcome.status === 'delivered' ? outcome.externalId : null,
        dispatch: { owner: this.owner, leaseUntil: 0, attempts: attemptNumber, lastError: outcome.status === 'delivered' ? null : outcome.status } };
      const answerCurrent = status !== 'delivered' || d.kind !== 'result' || await generatedDeliveryCurrent(this.services, state, d);
      try {
        await this.update(workId, actor, state, next, `delivery-settle:${d.id}:${attemptNumber}:${status}:${state.revision}`, 'delivery_settled', work => {
          if (status === 'delivered' && d.kind === 'result' && answerCurrent && this.valid(work, d, actor)) {
            for (const o of work.obligations) if (o.kind === 'delivery' && d.context!.obligationIds.includes(o.id)) o.status = 'satisfied';
            if (work.status === 'waiting' && work.statusReason === 'result_delivery_pending') { work.status = 'ready'; work.statusReason = 'result_delivered'; }
          }
        }); return;
      } catch (error) {
        if (error instanceof Error && error.message === 'outbox_effect_proof_changed') { await refreshEffectProofs(this.services, workId); return; }
        if (!(error instanceof Error && error.message === 'outbox_state_changed')) throw error;
      }
    }
    throw new Error('outbox_contention');
  }
  async flush(workId: string, actor: WorkActor, maxActions = 20) {
    if (!Number.isSafeInteger(maxActions) || maxActions < 1 || maxActions > 100) throw new Error('invalid_outbox_limit');
    await authorizedWork(this.services.state, workId, actor);
    if (this.services.executionAuthority) {
      const original = await this.services.state.get(workId);
      if (!original) throw new Error('work_unavailable');
      assertExecutionAuthority(this.services, original);
    }
    await refreshKnowledge(this.services, workId);
    const visited = new Set<string>();
    for (let action = 0; action < maxActions; action++) {
      const { state, deliveries } = await this.snapshot(workId, actor);
      if (!(await this.effectCurrent(workId, state))) break;
      const priority = { ack: 0, question: 1, result: 2, failure: 3 };
      const d = deliveries.filter(item => !['delivered', 'failed', 'superseded'].includes(item.status) && !visited.has(item.id))
        .sort((a, b) => priority[a.kind] - priority[b.kind] || a.id.localeCompare(b.id, 'en'))[0];
      if (!d) break; visited.add(d.id);
      if (!(await sessionInputsCurrent(this.services, state))) break;
      if (state.status === 'paused' && d.kind !== 'ack') continue;
      if (!this.valid(state, d, actor) || !(await generatedDeliveryCurrent(this.services, state, d))) {
        // A revoked or obsolete response may already have reached its recipient.
        if (d.status === 'sending' || d.status === 'unknown') continue;
        try { await this.update(workId, actor, state, { ...d, status: 'superseded' }, `delivery-obsolete:${d.id}`, 'delivery_superseded'); }
        catch (error) { if (!(error instanceof Error && error.message === 'outbox_state_changed')) throw error; }
        continue;
      }
      if (d.context?.artifact && !(await this.services.artifacts.exists(d.context.artifact))) {
        await this.update(workId, actor, state, { ...d, status: 'failed' }, `delivery-missing:${d.id}`, 'delivery_artifact_missing'); continue;
      }
      if (d.status === 'sending' || d.status === 'unknown') {
        if (d.status === 'sending' && (d.dispatch?.leaseUntil ?? 0) > this.services.clock.now()) continue;
        const latest = await authorizedWork(this.services.state, workId, actor);
        if (!this.valid(latest, d, actor)) continue;
        if (!(await knowledgeInputsCurrent(this.services, latest))) { await refreshKnowledge(this.services, workId); continue; }
        const checked = await authorizedWork(this.services.state, workId, actor);
        if (checked.revision !== latest.revision || !this.valid(checked, d, actor)) continue;
        if (!(await this.effectCurrent(workId, checked))) continue;
        if (!(await generatedDeliveryCurrent(this.services, checked, d))) continue;
        const final = this.services.executionAuthority ? await this.services.state.get(workId) : checked;
        if (!final || final.revision !== checked.revision) continue;
        assertExecutionAuthority(this.services, final);
        let receipt = await this.bounded(async () => this.services.sink.lookup?.(d) ?? { status: 'unknown' });
        if (receipt.status === 'absent' && !(this.services.sink.canRetryAbsent?.(d) ?? this.services.sink.capabilities?.idempotentSend)) receipt = { status: 'unknown' };
        await this.settle(workId, actor, d.id, receipt, d.dispatch?.attempts ?? 0);
        continue;
      }
      const attempts = (d.dispatch?.attempts ?? 0) + 1;
      if (attempts > this.maxAttempts) { await this.update(workId, actor, state, { ...d, status: 'failed' }, `delivery-exhausted:${d.id}`, 'delivery_attempts_exhausted'); continue; }
      const sending: Delivery = { ...d, status: 'sending', dispatch: { owner: this.owner, leaseUntil: this.services.clock.now() + this.leaseMs, attempts, lastError: null } };
      try {
        const claim = await this.update(workId, actor, state, sending, `delivery-claim:${d.id}:${attempts}`, 'delivery_claimed');
        if (!claim.committed) continue;
      } catch (error) {
        if (error instanceof Error && error.message === 'outbox_effect_proof_changed') { await refreshEffectProofs(this.services, workId); break; }
        if (error instanceof Error && ['outbox_state_changed', 'idempotency_conflict'].includes(error.message)) continue;
        throw error;
      }
      const latest = await authorizedWork(this.services.state, workId, actor);
      if (!this.valid(latest, sending, actor)) { await this.settle(workId, actor, d.id, { status: 'absent' }, attempts); continue; }
      if (!(await knowledgeInputsCurrent(this.services, latest))) { await refreshKnowledge(this.services, workId); await this.settle(workId, actor, d.id, { status: 'absent' }, attempts); continue; }
      const checked = await authorizedWork(this.services.state, workId, actor);
      if (checked.revision !== latest.revision || !this.valid(checked, sending, actor)) { await this.settle(workId, actor, d.id, { status: 'absent' }, attempts); continue; }
      if (!(await this.effectCurrent(workId, checked))) continue;
      if (!(await sessionInputsCurrent(this.services, checked))) continue;
      if (!(await generatedDeliveryCurrent(this.services, checked, sending))) { await this.settle(workId, actor, d.id, { status: 'absent' }, attempts); continue; }
      const final = this.services.executionAuthority ? await this.services.state.get(workId) : checked;
      if (!final || final.revision !== checked.revision) { await this.settle(workId, actor, d.id, { status: 'absent' }, attempts); continue; }
      assertExecutionAuthority(this.services, final);
      const outcome = await this.bounded(() => this.services.sink.send(sending));
      await this.settle(workId, actor, d.id, outcome, attempts);
    }
    return (await this.snapshot(workId, actor)).deliveries.map(d => ({ id: d.id, kind: d.kind, status: d.status, attempts: d.dispatch?.attempts ?? 0 }));
  }
}
