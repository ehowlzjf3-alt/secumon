import type { Json, PlanProposal, TaskSpec, WorkState } from '../domain/model.js';
import type { Digester } from './ports.js';
import { PlanProposalSchema, parseContract } from './contracts.js';
import type { ToolContracts } from './tool-contracts.js';
import { accessibleEvidence } from '../domain/completion.js';
import { currentEvidenceIds } from '../domain/hypotheses.js';
import { effectiveExecutionLimits, executionControl, validateExecutionPlan } from '../domain/execution-policy.js';
import { budgetAllocationError } from '../domain/budget-delegation.js';

export function taskDigest(task: TaskSpec, digester: Digester): string {
  return digester.digest({ toolId: task.toolId, toolVersion: task.toolVersion, input: task.input, effect: task.effect,
    ...(task.freshness ? { freshness: task.freshness } : {}), ...(task.readResume ? { readResume: asJson(task.readResume) } : {}),
    ...(task.computerResume ? { computerResume: asJson(task.computerResume) } : {}) });
}
export function asJson(value: unknown): Json { return JSON.parse(JSON.stringify(value)) as Json; }

export function validatePlan(value: unknown, state: WorkState, tools: ToolContracts, digester: Digester, historicalTasks: TaskSpec[] = []): PlanProposal {
  const proposal = parseContract(PlanProposalSchema, value);
  if (proposal.baseStateRevision !== state.revision || proposal.baseGoalRevision !== state.goal.revision ||
    proposal.basePlanRevision !== (state.plan?.revision ?? 0)) throw new Error('stale_plan');
  const tasks = new Map(proposal.tasks.map(task => [task.id, task]));
  if (tasks.size !== proposal.tasks.length) throw new Error('duplicate_task_id');
  const criteria = new Set(state.goal.criteria.map(c => c.id));
  if (criteria.size !== state.goal.criteria.length) throw new Error('duplicate_criterion_id');
  for (const task of tasks.values()) {
    const error = tools.check(task, state.policy);
    if (error) throw new Error(error);
    if (new Set(task.dependsOn).size !== task.dependsOn.length || task.dependsOn.some(id => !tasks.has(id))) throw new Error('invalid_dependency');
    if (task.satisfies.some(id => !criteria.has(id))) throw new Error('unknown_criterion');
    const digest = taskDigest(task, digester);
    const previous = state.plan?.tasks.find(old => old.id === task.id);
    if ((previous && taskDigest(previous, digester) !== digest) || state.attempts.some(a => a.taskId === task.id && a.inputDigest !== digest) ||
      historicalTasks.some(old => old.id === task.id && taskDigest(old, digester) !== digest)) throw new Error('task_id_contract_changed');
  }
  const visiting = new Set<string>(); const visited = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) throw new Error('cyclic_plan');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of tasks.get(id)!.dependsOn) visit(dep);
    visiting.delete(id); visited.add(id);
  }
  for (const id of tasks.keys()) visit(id);
  const hypotheses = new Set<string>();
  const evidence = new Set(accessibleEvidence(state.evidence, state.policy, state.goal.scope).map(e => e.id));
  for (const h of proposal.hypotheses) {
    if (hypotheses.has(h.id)) throw new Error('duplicate_hypothesis_id');
    hypotheses.add(h.id);
    if ([...h.supportIds, ...h.counterIds].some(id => !evidence.has(id))) throw new Error('unknown_hypothesis_evidence');
    if ([h.question, h.claim, h.predictedObservation, h.falsifier, h.reason].some(text => !text.trim())) throw new Error('hypothesis_explanation_required');
    if (new Set([...h.supportIds, ...h.counterIds]).size !== h.supportIds.length + h.counterIds.length) throw new Error('conflicting_hypothesis_relation');
    if ((h.status === 'supported' && (!h.supportIds.length || h.counterIds.length)) || (h.status === 'refuted' && !h.counterIds.length) ||
      (h.status === 'contested' && (!h.supportIds.length || !h.counterIds.length))) throw new Error('hypothesis_status_without_evidence');
  }
  if (state.plan?.goalRevision === state.goal.revision) for (const old of state.hypotheses) {
    const next = proposal.hypotheses.find(h => h.id === old.id);
    if (!next) throw new Error('hypothesis_history_dropped');
    if (next.claim !== old.claim || next.question !== old.question || next.predictedObservation !== old.predictedObservation || next.falsifier !== old.falsifier) throw new Error('hypothesis_id_meaning_changed');
    if ([...old.supportIds, ...old.counterIds].some(id => evidence.has(id) && ![...next.supportIds, ...next.counterIds].includes(id))) throw new Error('hypothesis_evidence_dropped');
  }
  return proposal;
}

export function unchangedPlanTasks(state: WorkState, valid: PlanProposal, digester: Digester): boolean {
  return state.plan?.goalRevision === state.goal.revision && digester.digest(asJson(state.plan.tasks)) === digester.digest(asJson(valid.tasks));
}

export function applyValidatedPlan(state: WorkState, valid: PlanProposal, digester: Digester, preserveUnchanged = false) {
  if (state.personalMemoryReviewRequired) state.personalMemoryReviewRequired = false;
  if (state.conversation?.sessionReviewRequired) state.conversation.sessionReviewRequired = false;
  const selected = validateExecutionPlan(state, valid); const control = executionControl(state);
  if (selected.strategy !== control.strategy) state.executionControl = { ...control, revision: control.revision + 1, strategy: selected.strategy, lastReason: selected.reason };
  const same = preserveUnchanged && unchangedPlanTasks(state, valid, digester);
  const budget = budgetAllocationError(state, !same && state.plan ? { replans: 1 } : {});
  if (budget) throw new Error(budget);
  if (!same) {
    if (state.plan) { if (state.budget.used.replans >= effectiveExecutionLimits(state).replans) throw new Error(effectiveExecutionLimits(state).replans < state.budget.limits.replans ? 'fast_replan_budget_exhausted' : 'replan_budget_exhausted'); state.budget.used.replans++; }
    state.plan = { revision: (state.plan?.revision ?? 0) + 1, goalRevision: state.goal.revision, reason: valid.reason, tasks: valid.tasks };
  }
  state.hypotheses = valid.hypotheses;
  state.hypothesisAssessment = { goalRevision: state.goal.revision, evidenceIds: currentEvidenceIds(state) };
  state.status = 'ready'; state.statusReason = same ? 'hypotheses_assessed' : 'plan_accepted';
  return same ? 'assessment' : 'plan';
}
