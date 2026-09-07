import { evaluateCompletion, evaluateResultReadiness } from './completion.js';
import type { TaskSpec, WorkState } from './model.js';
import { hypothesesRequireReview } from './hypotheses.js';
import { effectiveExecutionLimits } from './execution-policy.js';
import { currentAttempts, isEndedToolReservation, taskSucceeded } from './task-status.js';
export { currentAttempts, taskSucceeded } from './task-status.js';

export type Control =
  | { kind: 'continue'; action: 'adopt' | 'recover' | 'dispatch' | 'reserve'; id: string; reason: string }
  | { kind: 'wait'; reason: string; wakeAt: number | null }
  | { kind: 'replan' | 'blocked' | 'complete' | 'cancelled' | 'paused' | 'failed'; reason: string };

export function decide(state: WorkState, now: number, allocationGate?: (task?: TaskSpec) => Control | null): Control {
  const received = state.attempts.find(a => a.status === 'received');
  if (received) return { kind: 'continue', action: 'adopt', id: received.id, reason: 'stored_result_pending' };
  const expired = state.attempts.find(a => ['reserved', 'running'].includes(a.status) && a.leaseUntil <= now);
  if (expired) return { kind: 'continue', action: 'recover', id: expired.id, reason: 'lease_expired' };
  if (state.status === 'cancelled' || state.status === 'paused' || state.status === 'failed') return { kind: state.status, reason: state.statusReason };
  if (state.status === 'blocked') return { kind: 'blocked', reason: state.statusReason };
  if (state.obligations.some(o => o.kind === 'effect_reconciliation' && o.status === 'pending')) return { kind: 'blocked', reason: 'effect_unknown' };
  const model = state.modelCalls.find(c => ['reserved', 'running', 'received'].includes(c.status));
  if (model) return { kind: 'wait', reason: 'model_call_pending', wakeAt: model.leaseUntil };
  const active = state.attempts.find(a => a.status === 'reserved' || a.status === 'running');
  if (active) return active.status === 'reserved' ? { kind: 'continue', action: 'dispatch', id: active.id, reason: 'intent_reserved' } :
    { kind: 'wait', reason: 'attempt_running', wakeAt: Math.min(active.leaseUntil, state.deadlineAt) };
  const notices = state.notifications ?? [], notificationReview = notices.some(value => !state.plan || state.plan.goalRevision !== value.goalRevision || state.plan.revision <= value.observedPlanRevision);
  const sessionReview = state.conversation?.sessionReviewRequired ?? false;
  const memoryReview = state.personalMemoryReviewRequired ?? false;
  const reviewRequired = hypothesesRequireReview(state) || notificationReview || sessionReview || memoryReview;
  if (!notices.length && !reviewRequired && evaluateCompletion(state.goal, state.evidence, state.obligations, state.policy, state.attempts, state).complete) return { kind: 'complete', reason: 'criteria_verified' };
  if (!notices.length && !reviewRequired && evaluateResultReadiness(state.goal, state.evidence, state.obligations, state.policy, state.attempts, state).complete && state.obligations.some(o => o.kind === 'delivery' && o.status === 'pending')) return { kind: 'wait', reason: 'result_delivery_pending', wakeAt: state.deadlineAt };
  if (now >= state.deadlineAt) return { kind: 'blocked', reason: 'deadline_exceeded' };
  if (!notices.length && !reviewRequired && state.obligations.some(o => o.kind === 'budget_reconciliation' && o.status === 'pending') &&
    evaluateResultReadiness(state.goal, state.evidence, state.obligations.filter(o => o.kind !== 'budget_reconciliation'), state.policy, state.attempts, state).complete)
    return { kind: 'wait', reason: 'budget_delegation_pending', wakeAt: state.deadlineAt };
  const pending = state.obligations.filter(o => o.status === 'pending' && o.kind !== 'delivery' && o.kind !== 'budget_reconciliation' && !(o.source && (o.mode === 'actionable' || notices.length)));
  let obligationWait: Control | null = null;
  if (pending.length) {
    if (pending.some(o => o.dueAt !== null && o.dueAt <= now)) return { kind: 'blocked', reason: 'obligation_overdue' };
    if (pending.some(o => o.wakeKey === null && o.dueAt === null)) return { kind: 'blocked', reason: 'obligation_without_wake' };
    const times = pending.flatMap(o => o.dueAt === null ? [] : [o.dueAt]);
    obligationWait = { kind: 'wait', reason: 'pending_obligation', wakeAt: times.length ? Math.min(...times) : null };
    if (reviewRequired || !state.plan || state.plan.goalRevision !== state.goal.revision || !pending.every(o => o.source && o.resumeToolIds?.length)) return obligationWait;
  }
  const gate = allocationGate?.(); if (gate) return gate;
  if (reviewRequired) return { kind: 'replan', reason: memoryReview ? 'personal_memory_requires_review' : sessionReview ? 'session_input_requires_review' : notificationReview ? 'external_notification_requires_review' : 'hypothesis_review_required' };
  const limits = effectiveExecutionLimits(state);
  const replan = (reason: string): Control => state.plan && state.budget.used.replans >= limits.replans ?
    { kind: 'blocked', reason: limits.replans < state.budget.limits.replans ? 'fast_replan_budget_exhausted' : 'replan_budget_exhausted' } : { kind: 'replan', reason };
  if (!state.plan || state.plan.goalRevision !== state.goal.revision)
    return state.goal.responseRequirement ? { kind: 'replan', reason: 'agent_turn_required' } : replan('plan_required');
  const waits: Extract<Control, { kind: 'wait' }>[] = [];
  for (const task of state.plan.tasks) {
    if (obligationWait && !pending.every(o => o.resumeToolIds?.includes(task.toolId))) continue;
    if (taskSucceeded(state, task)) continue;
    if (!task.dependsOn.every(id => taskSucceeded(state, state.plan!.tasks.find(t => t.id === id)!))) continue;
    const attempts = currentAttempts(state, task).filter(a => !isEndedToolReservation(a));
    const last = attempts.at(-1);
    if (attempts.length >= task.maxAttempts || (last && (task.effect === 'write' || last.readProgress || !last.error?.retryable))) continue;
    const taskGate = allocationGate?.(task);
    if (taskGate?.kind === 'wait') { waits.push(taskGate); continue; }
    if (taskGate) return taskGate;
    if (state.budget.used.toolCalls + state.budget.reservedToolCalls >= limits.toolCalls) return { kind: 'blocked', reason: limits.toolCalls < state.budget.limits.toolCalls ? 'fast_tool_budget_exhausted' : 'tool_budget_exhausted' };
    return { kind: 'continue', action: 'reserve', id: task.id, reason: 'task_ready' };
  }
  if (waits.length) return waits.sort((a, b) => (a.wakeAt ?? Infinity) - (b.wakeAt ?? Infinity))[0]!;
  // Producing a response does not change the task graph or consume a replan allowance.
  if (!obligationWait && state.goal.responseRequirement && state.plan.tasks.every(task => taskSucceeded(state, task)) &&
      evaluateResultReadiness(state.goal, state.evidence, state.obligations, state.policy, state.attempts, state).criteria.every(criterion => criterion.met))
    return { kind: 'replan', reason: 'agent_answer_required' };
  return obligationWait ?? replan('plan_cannot_complete_goal');
}
