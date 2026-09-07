import type { Limits, Mode, PlanProposal, TaskSpec, WorkState } from './model.js';
import { accessibleEvidence, evaluateResultReadiness } from './completion.js';
import { hypothesesRequireReview } from './hypotheses.js';

export interface ExecutionPolicy {
  version: string;
  fast: { toolCalls: number; modelCalls: number; replans: number; maxPendingTasks: number; maxHypotheses: number };
}
export interface ExecutionControl {
  revision: number;
  requestedMode: Mode;
  strategy: 'direct' | 'investigate';
  policy: ExecutionPolicy;
  pending: { mode: Mode; reason: string } | null;
  lastReason: string;
}
export interface ExecutionPlanDecision { strategy: ExecutionControl['strategy']; reason: string }

type ControlledWork = WorkState & { executionControl?: ExecutionControl | undefined };
const defaultPolicy: ExecutionPolicy = { version: 'local-v1', fast: { toolCalls: 2, modelCalls: 2, replans: 0, maxPendingTasks: 1, maxHypotheses: 0 } };

function checkedPolicy(policy: ExecutionPolicy): ExecutionPolicy {
  if (!policy || typeof policy.version !== 'string' || !policy.version.trim() || policy.version.length > 256 || !policy.fast ||
      ['toolCalls', 'modelCalls', 'replans', 'maxPendingTasks', 'maxHypotheses'].some(key => {
        const value = policy.fast[key as keyof ExecutionPolicy['fast']];
        return !Number.isSafeInteger(value) || value < 0;
      })) throw new Error('invalid_execution_policy');
  return { version: policy.version, fast: { ...policy.fast } };
}

export function newExecutionControl(mode: Mode, policy: ExecutionPolicy = defaultPolicy): ExecutionControl {
  if (!['auto', 'fast', 'deep'].includes(mode)) throw new Error('invalid_execution_mode');
  return { revision: 1, requestedMode: mode, strategy: mode === 'deep' ? 'investigate' : 'direct',
    policy: checkedPolicy(policy), pending: null, lastReason: `mode_${mode}` };
}

/** A pending request takes effect only when the runtime commits its safe boundary. */
export function executionControl(state: ControlledWork): ExecutionControl {
  return state.executionControl ? structuredClone(state.executionControl) : newExecutionControl(state.goal.mode);
}

/** Absolute work limits: callers compare all usage plus reservations against these values. */
export function effectiveExecutionLimits(state: ControlledWork): Limits {
  const control = executionControl(state); const limits = { ...state.budget.limits };
  if (control.requestedMode === 'fast') {
    limits.toolCalls = Math.min(limits.toolCalls, control.policy.fast.toolCalls);
    limits.modelCalls = Math.min(limits.modelCalls, control.policy.fast.modelCalls);
    limits.replans = Math.min(limits.replans, control.policy.fast.replans);
  }
  return limits;
}

function taskSucceeded(state: WorkState, task: TaskSpec): boolean {
  return state.attempts.some(attempt => attempt.taskId === task.id && attempt.goalRevision === state.goal.revision &&
    attempt.scope === state.goal.scope && attempt.status === 'succeeded' && attempt.adopted);
}

/** The application validates current revisions, task identities and authority before this policy. */
export function validateExecutionPlan(state: ControlledWork, proposal: PlanProposal): ExecutionPlanDecision {
  const control = executionControl(state);
  const pending = proposal.tasks.filter(task => !taskSucceeded(state, task)).length;
  const tooManyTasks = pending > control.policy.fast.maxPendingTasks;
  const tooManyHypotheses = proposal.hypotheses.length > control.policy.fast.maxHypotheses;
  if (control.requestedMode === 'fast') {
    const existing = new Set(state.hypotheses.map(hypothesis => hypothesis.id));
    const newHypotheses = proposal.hypotheses.filter(hypothesis => !existing.has(hypothesis.id)).length;
    if (tooManyTasks || newHypotheses > control.policy.fast.maxHypotheses) throw new Error('fast_scope_exceeded');
    return { strategy: 'direct', reason: 'fast_plan' };
  }
  if (control.requestedMode === 'deep') return { strategy: 'investigate', reason: 'deep_plan' };
  if (control.strategy === 'investigate') return { strategy: 'investigate', reason: 'investigation_retained' };
  if (tooManyHypotheses) return { strategy: 'investigate', reason: 'plan_hypotheses_expanded' };
  if (tooManyTasks) return { strategy: 'investigate', reason: 'plan_scope_expanded' };
  return { strategy: 'direct', reason: 'direct_plan' };
}

/** Errors and waiting alone are not evidence that a larger investigation can help. */
export function autoExpansionReason(state: ControlledWork): string | null {
  const control = executionControl(state);
  if (control.requestedMode !== 'auto' || control.strategy !== 'direct' || control.pending !== null ||
      !['ready', 'running'].includes(state.status) ||
      state.obligations.some(obligation => obligation.status === 'pending' && obligation.kind !== 'delivery') ||
      state.attempts.some(attempt => ['reserved', 'running', 'received'].includes(attempt.status)) ||
      state.modelCalls.some(call => ['reserved', 'running', 'received'].includes(call.status))) return null;
  const readiness = evaluateResultReadiness(state.goal, state.evidence, state.obligations, state.policy, state.attempts, state);
  if (readiness.complete && !hypothesesRequireReview(state)) return null;
  const remaining = readiness.criteria.filter(criterion => !criterion.met);
  if (remaining.some(criterion => criterion.reasons.includes('unresolved_counterevidence'))) return 'counterevidence_requires_investigation';
  if (state.hypotheses.length && (remaining.length > 0 || hypothesesRequireReview(state))) return 'hypotheses_require_investigation';
  if (!remaining.length) return null;
  const keys = new Set(state.goal.criteria.filter(criterion => remaining.some(value => value.id === criterion.id)).map(criterion => criterion.key));
  const assessment = state.hypothesisAssessment;
  const assessed = new Set(assessment?.goalRevision === state.goal.revision ? assessment.evidenceIds : []);
  if (accessibleEvidence(state.evidence, state.policy, state.goal.scope).some(evidence => !assessed.has(evidence.id) &&
      Object.keys(evidence.facts).some(key => keys.has(key)))) return 'new_evidence_incomplete';
  return null;
}
