import type { ArtifactRef, Attempt, CompletionCheck, Evidence, Goal, Obligation, Policy, WorkState } from './model.js';
import { evidenceView } from './evidence-access.js';
import { collectionCoverageCandidates } from './read-coverage.js';
import { dataGeneration, visibleArtifact } from './data-lifecycle.js';
import { hypothesesRequireReview } from './hypotheses.js';
import { taskSucceeded } from './task-status.js';

export function accessibleEvidence(evidence: Evidence[], policy: Policy, scope: string): Evidence[] {
  return evidenceView(evidence, policy, scope, 'current');
}

export function historicalEvidence(evidence: Evidence[], policy: Policy, scope: string): Evidence[] {
  return evidenceView(evidence, policy, scope, 'historical');
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort(), b = [...right].sort();
  return new Set(a).size === a.length && a.length === b.length && a.every((id, index) => id === b[index]);
}

function sameArtifact(left: ArtifactRef, right: ArtifactRef): boolean {
  return left.id === right.id && left.sha256 === right.sha256 && left.byteLength === right.byteLength &&
    left.mediaType === right.mediaType && left.tenantId === right.tenantId && sameIds(left.labels, right.labels);
}

/** Artifact bytes, the saved model packet and its semantic basis are checked by the application. */
function responseBlockers(goal: Goal, current: Evidence[], state?: WorkState): string[] {
  if (!state) return ['generated_answer_state_required'];
  const answer = state.generatedAnswer;
  if (!answer) return ['generated_answer_required'];
  const blockers: string[] = [];
  const input = state.conversation?.session;
  if (state.goal.revision !== goal.revision || answer.goalRevision !== goal.revision ||
      answer.planRevision !== (state.plan?.revision ?? 0) || answer.dataGeneration !== dataGeneration(state))
    blockers.push('generated_answer_stale');
  if (!input || answer.input.scope.tenantId !== input.scope.tenantId || answer.input.scope.agentId !== input.scope.agentId ||
      answer.input.scope.principalId !== input.scope.principalId || answer.input.scope.sessionId !== input.scope.sessionId ||
      answer.input.input.messageId !== input.input.messageId || answer.input.input.sequence !== input.input.sequence ||
      answer.input.input.digest !== input.input.digest) blockers.push('generated_answer_input_changed');
  const currentIds = current.map(value => value.id);
  if (!sameIds(answer.observedEvidenceIds, currentIds)) blockers.push('generated_answer_evidence_changed');
  if (new Set(answer.evidenceIds).size !== answer.evidenceIds.length || answer.evidenceIds.some(id => !currentIds.includes(id)))
    blockers.push('generated_answer_evidence_unavailable');
  const calls = state.modelCalls.filter(value => value.id === answer.callId);
  const call = calls.length === 1 ? calls[0] : undefined;
  if (!call || call.purpose !== 'agent_turn' || call.status !== 'accepted' || call.goalRevision !== answer.goalRevision ||
      call.basePlanRevision !== answer.planRevision || !sameArtifact(call.inputArtifact, answer.inputArtifact))
    blockers.push('generated_answer_call_unaccepted');
  if (!visibleArtifact(state, answer.artifact) || !visibleArtifact(state, answer.inputArtifact)) blockers.push('generated_answer_artifact_unavailable');
  if (answer.assessment.type !== 'model_self_review' || answer.assessment.verdict !== 'satisfied' || answer.assessment.missing.length)
    blockers.push('generated_answer_assessment_incomplete');
  if (state.modelCalls.some(value => ['reserved', 'running', 'received'].includes(value.status))) blockers.push('model_call_pending');
  if (state.attempts.some(value => ['reserved', 'running', 'received'].includes(value.status))) blockers.push('attempt_pending');
  if (state.plan?.goalRevision === goal.revision && state.plan.tasks.some(task => !taskSucceeded(state, task))) blockers.push('response_plan_incomplete');
  if (state.conversation?.sessionReviewRequired) blockers.push('session_input_requires_review');
  if (state.personalMemoryReviewRequired) blockers.push('personal_memory_requires_review');
  if (state.notifications?.length) blockers.push('external_notification_requires_review');
  if (hypothesesRequireReview(state)) blockers.push('hypothesis_review_required');
  return blockers;
}

export function evaluateCompletion(goal: Goal, evidence: Evidence[], obligations: Obligation[], policy: Policy,
  attempts: readonly Attempt[] = [], state?: WorkState): CompletionCheck {
  const current = accessibleEvidence(evidence, policy, goal.scope);
  const criteria = goal.criteria.map(c => {
    const applicable = current.filter(e => Object.hasOwn(e.facts, c.key));
    const matching = applicable.filter(e => (c.operator === 'present' || e.facts[c.key] === c.equals) && (!c.requireCompleteCoverage || e.coverage === 'complete'));
    const conflicts = c.operator === 'equals' ? applicable.filter(e => e.facts[c.key] !== c.equals) :
      (new Set(applicable.map(e => e.facts[c.key])).size > 1 ? applicable : []);
    const independent = new Set(matching.filter(e => e.derivedFrom.length === 0).map(e => e.lineageId));
    const reasons: string[] = [];
    if (independent.size < c.minIndependentSources) reasons.push('insufficient_independent_evidence');
    if (conflicts.length) reasons.push('unresolved_counterevidence');
    if (c.requireCollection && collectionCoverageCandidates(goal, policy, attempts, c.requireCollection).length === 0)
      reasons.push('collection_coverage_required');
    return { id: c.id, met: reasons.length === 0, evidenceIds: matching.map(e => e.id), reasons };
  });
  const blockers = obligations.filter(o => o.status === 'pending').map(o => `pending_obligation:${o.id}`);
  if (goal.responseRequirement) blockers.push(...responseBlockers(goal, current, state));
  else if (criteria.length === 0) blockers.push('no_completion_criteria');
  return { complete: criteria.every(c => c.met) && blockers.length === 0, criteria, blockers };
}

export function evaluateResultReadiness(goal: Goal, evidence: Evidence[], obligations: Obligation[], policy: Policy,
  attempts: readonly Attempt[] = [], state?: WorkState): CompletionCheck {
  return evaluateCompletion(goal, evidence, obligations.filter(o => o.kind !== 'delivery'), policy, attempts, state);
}
