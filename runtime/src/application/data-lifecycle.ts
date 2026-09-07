import { z } from 'zod';
import type { DataLifecycle, WorkState } from '../domain/model.js';
import { dataGeneration } from '../domain/data-lifecycle.js';
import { deliveryObligationId } from '../domain/conversation.js';
import { EvidenceSchema, parseContract } from './contracts.js';
import { validateEvidenceRecords } from './evidence-intake.js';
import type { RuntimeServices } from './services.js';
import { authorizedWork, type WorkActor } from './work-resources.js';
import { asJson } from './plan-validator.js';
import { transact } from './work-transactions.js';

const id = z.string().min(1).max(256);
const ChangeSchema = z.strictObject({ action: z.enum(['retract', 'correct', 'restrict', 'delete']), evidenceIds: z.array(id).min(1).max(1000),
  expectedGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), reason: z.string().min(1).max(1000), replacement: EvidenceSchema.nullable() });
export type DataChange = z.infer<typeof ChangeSchema>;
function affected(state: WorkState, ids: string[]) {
  const found = new Set(ids); let changed = true;
  while (changed) { changed = false; for (const e of state.evidence) if (!found.has(e.id) && e.derivedFrom.some(id => found.has(id))) { found.add(e.id); changed = true; } }
  return found;
}
function allArtifacts(state: WorkState) {
  return [...state.artifacts, ...state.evidence.flatMap(e => e.artifact ? [e.artifact] : []), ...state.attempts.flatMap(a => [...(a.resultArtifact ? [a.resultArtifact] : []), ...(a.inputDependencies ?? []).map(value => value.artifact), ...(a.effectReceipt ? [a.effectReceipt.artifact] : []), ...(a.readProgress ? [a.readProgress.head] : []), ...(a.computerUse ? [a.computerUse.head] : [])]),
    ...(state.computerReconciliations ?? []).flatMap(record => [record.sourceHead, record.requestArtifact,
      ...(record.sourceResultArtifact ? [record.sourceResultArtifact] : []), ...(record.responseArtifact ? [record.responseArtifact] : []), ...(record.proofArtifact ? [record.proofArtifact] : [])]),
    ...state.modelCalls.flatMap(c => [c.inputArtifact, ...(c.replyArtifact ? [c.replyArtifact] : [])]), ...(state.workspaceCheckpoints?.map(c => c.artifact) ?? []),
    ...(state.conversation?.result ? [state.conversation.result.artifact] : []), ...(state.contextHead ? [state.contextHead.artifact] : [])];
}
function clearDerivedState(state: WorkState, accessChanged: boolean, now: number) {
  state.contextHead = null;
  for (const subscription of state.subscriptions ?? []) subscription.status = 'closed';
  if (state.notifications) state.notifications = [];
  state.plan = null;
  state.hypothesisAssessment = null;
  if (accessChanged) state.hypotheses = [];
  for (const attempt of state.attempts) {
    attempt.adopted = false;
    if (attempt.status === 'reserved') { attempt.status = 'cancelled'; attempt.finishedAt = now; state.budget.reservedToolCalls--; }
    else if (attempt.status === 'received') attempt.status = attempt.effectState === 'unknown' ? 'unknown' : 'failed';
    if (attempt.status === 'running') attempt.leaseUntil = Math.min(attempt.leaseUntil, now);
    if (attempt.effect === 'write' && (attempt.status === 'running' || attempt.effectState === 'unknown')) {
      const id = `effect:${attempt.id}`;
      const obligation = state.obligations.find(o => o.id === id);
      if (obligation) obligation.status = 'pending';
      else state.obligations.push({ id, kind: 'effect_reconciliation', reason: 'dispatched_effect_requires_reconciliation', status: 'pending', wakeKey: null, dueAt: null });
    }
    if (accessChanged && attempt.error) attempt.error = { code: 'data_access_changed', retryable: false };
  }
  for (const record of state.computerReconciliations ?? []) {
    const obligation = state.obligations.find(value => value.id === record.obligationId);
    if (obligation) obligation.status = 'pending';
    else state.obligations.push({ id: record.obligationId, kind: 'effect_reconciliation', reason: 'dispatched_effect_requires_reconciliation',
      status: 'pending', wakeKey: null, dueAt: null });
    if (record.status === 'failed') continue;
    if (record.status === 'reserved') state.budget.reservedToolCalls--;
    record.status = 'failed'; record.finishedAt ??= now; record.reason = 'data_lifecycle_changed';
  }
  for (const call of state.modelCalls) {
    if (call.status === 'reserved') { call.status = 'cancelled'; call.usageStatus = 'not_called'; call.finishedAt = now; state.budget.reservedModelCalls--; state.budget.reservedTokens -= call.tokenReservation; }
    else if (call.status === 'received') call.status = 'rejected';
    if (call.status === 'running') call.leaseUntil = Math.min(call.leaseUntil, now);
    call.expired = true; call.reason = 'data_lifecycle_changed';
  }
  if (state.conversation) {
    state.conversation.result = null;
    if (state.conversation.completionRequiresDelivery) {
      const existing = state.obligations.find(o => o.id === deliveryObligationId(state.goal.revision));
      if (existing) existing.status = 'pending';
    }
  }
  if (accessChanged) for (const o of state.obligations) o.reason = o.kind === 'effect_reconciliation' ? 'dispatched_effect_requires_reconciliation' : 'data_access_changed_review_required';
  if (!['cancelled', 'failed', 'paused'].includes(state.status)) { state.status = accessChanged ? 'blocked' : 'ready'; state.statusReason = accessChanged ? 'data_access_changed' : 'evidence_review_required'; }
}

/** Quarantine copied inputs before their custody is removed or replaced. */
export function quarantineKnowledge(state: WorkState, now: number) {
  const lifecycle = state.dataLifecycle ?? { generation: 0, blockedArtifactIds: [], changes: [] };
  lifecycle.blockedArtifactIds = [...new Set([...lifecycle.blockedArtifactIds, ...allArtifacts(state).map(ref => ref.id)])].sort();
  lifecycle.generation++;
  lifecycle.changes.push({ id: `knowledge-invalid:${state.revision}`, action: 'dependency_changed', principalId: state.policy.principalId, at: now,
    evidenceIds: state.evidence.map(e => e.id), replacementId: null, reason: 'knowledge_dependency_changed', purge: 'not_requested' });
  // Field-level memory lineage is unavailable; current copies are conservatively quarantined.
  for (const evidence of state.evidence) {
    evidence.status = 'retracted';
    if (evidence.access !== 'deleted') evidence.access = 'restricted';
    evidence.facts = {}; evidence.locator = 'content_unavailable';
  }
  state.dataLifecycle = lifecycle; clearDerivedState(state, true, now);
  for (const attempt of state.attempts) { delete attempt.knowledgeDependencies; delete attempt.inputDependencies; }
  if (state.personalMemorySelection) { delete state.personalMemorySelection; state.personalMemoryReviewRequired = true; }
  const id = `data-review:${lifecycle.generation}`;
  state.obligations.push({ id, kind: 'evidence', reason: 'knowledge_dependency_changed_review_required', status: 'pending', wakeKey: id, dueAt: state.deadlineAt });
}

export class DataLifecycleService {
  constructor(readonly services: Pick<RuntimeServices, 'state' | 'artifacts' | 'clock' | 'digester'>, readonly onChange?: (workId: string) => void) {}
  async invalidateKnowledge(workId: string, expectedRevision: number) {
    const result = await transact(this.services, workId, `knowledge-invalid:${expectedRevision}`, 'knowledge_dependencies_invalidated', { expectedRevision }, state => {
      if (state.revision !== expectedRevision) throw new Error('knowledge_state_changed');
      quarantineKnowledge(state, this.services.clock.now());
    });
    if (result.committed) this.onChange?.(workId);
    return result.state;
  }
  async change(workId: string, actor: WorkActor, commandId: string, input: DataChange) {
    parseContract(id, commandId); const change = parseContract(ChangeSchema, input);
    await authorizedWork(this.services.state, workId, actor);
    if (actor.allowWrites === false) throw new Error('data_change_not_authorized');
    if (change.action === 'correct' ? !change.replacement || change.evidenceIds.length !== 1 : change.replacement !== null) throw new Error('invalid_data_change');
    if (new Set(change.evidenceIds).size !== change.evidenceIds.length) throw new Error('duplicate_evidence_ids');
    const data = asJson({ actor: { tenantId: actor.tenantId, principalId: actor.principalId }, action: change.action, evidenceIds: change.evidenceIds,
      expectedGeneration: change.expectedGeneration, reason: change.reason, replacementDigest: change.replacement ? this.services.digester.digest(asJson(change.replacement)) : null });
    const result = await transact(this.services, workId, `data-change:${commandId}`, 'data_lifecycle_changed', data, state => {
      if (state.policy.tenantId !== actor.tenantId || state.policy.principalId !== actor.principalId || actor.allowWrites === false) throw new Error('data_change_not_authorized');
      if (dataGeneration(state) !== change.expectedGeneration) throw new Error('stale_data_generation');
      const original = change.evidenceIds.map(id => state.evidence.find(e => e.id === id));
      if (original.some(e => !e || e.tenantId !== state.policy.tenantId || e.scope !== state.goal.scope ||
        e.labels.some(l => !state.policy.allowedLabels.includes(l) || (actor.allowedLabels !== undefined && !actor.allowedLabels.includes(l))))) throw new Error('evidence_unavailable');
      if (original.some(e => e?.access === 'deleted') && change.action !== 'delete') throw new Error('deleted_evidence_cannot_be_restored');
      if (change.replacement) {
        const replacement = change.replacement; const prior = original[0]!;
        if (replacement.id === prior.id || state.evidence.some(e => e.id === replacement.id) || replacement.status !== 'accepted' || (replacement.access ?? 'available') !== 'available' ||
          !replacement.supersedes.includes(prior.id) || replacement.supersedes.length !== 1 || prior.access === 'deleted' || prior.access === 'restricted') throw new Error('invalid_evidence_correction');
        validateEvidenceRecords([replacement], state.goal.scope, state, this.services.digester);
      }
      const ids = affected(state, change.evidenceIds); const accessChanged = change.action === 'restrict' || change.action === 'delete';
      const lifecycle: DataLifecycle = state.dataLifecycle ?? { generation: 0, blockedArtifactIds: [], changes: [] };
      if (accessChanged) lifecycle.blockedArtifactIds = [...new Set([...lifecycle.blockedArtifactIds, ...allArtifacts(state).map(ref => ref.id)])].sort();
      for (const evidence of state.evidence) if (ids.has(evidence.id)) {
        evidence.status = 'retracted';
        if (accessChanged) { evidence.access = change.action === 'delete' ? 'deleted' : 'restricted'; evidence.facts = {}; evidence.locator = 'content_unavailable'; }
      }
      if (change.replacement) state.evidence.push(structuredClone(change.replacement));
      lifecycle.generation++;
      lifecycle.changes.push({ id: commandId, action: change.action, principalId: actor.principalId, at: this.services.clock.now(), evidenceIds: [...ids].sort(),
        replacementId: change.replacement?.id ?? null, reason: change.reason, purge: change.action === 'delete' ? 'pending_retention_review' : 'not_requested' });
      state.dataLifecycle = lifecycle;
      clearDerivedState(state, accessChanged, this.services.clock.now());
      const reviewId = `data-review:${lifecycle.generation}`;
      state.obligations.push({ id: reviewId, kind: 'evidence', reason: 'changed_evidence_requires_review', status: 'pending', wakeKey: reviewId, dueAt: state.deadlineAt });
    });
    if (result.committed) this.onChange?.(workId);
    return { generation: dataGeneration(result.state), changed: result.committed, access: change.action === 'delete' || change.action === 'restrict' ? 'blocked' : 'historical_review_available',
      purge: change.action === 'delete' ? 'pending_retention_review' : 'not_requested' };
  }
}
