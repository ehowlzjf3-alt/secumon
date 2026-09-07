import { decide, type Control } from '../domain/control.js';
import type { TaskSpec, WorkState } from '../domain/model.js';
import type { Digester } from './ports.js';
import { asJson, taskDigest } from './plan-validator.js';
import { progressGate } from './work-progress.js';
import { accessibleEvidence } from '../domain/completion.js';
import { visibleArtifact } from '../domain/data-lifecycle.js';
import { budgetAllocationError } from '../domain/budget-delegation.js';
import { readWaitControl } from './read-waits.js';
import { personalMemoryDigest } from './personal-memory-context.js';

export function taskFailureKey(state: WorkState, task: TaskSpec, digester: Digester): string {
  return `task:${digester.digest({ tenantId: state.policy.tenantId, scope: state.goal.scope, task: taskDigest(task, digester) })}`;
}
export function modelFailureKey(state: WorkState, identity: { provider: string; model: string; revision: string }, destination: string, digester: Digester,
  compactInputDigest?: string): string {
  const evidence = accessibleEvidence(state.evidence, state.policy, state.goal.scope)
    .filter(value => value.derivedFrom.length === 0 && (!value.artifact || visibleArtifact(state, value.artifact)))
    .map(value => digester.digest(asJson({ lineage: value.lineageId, facts: value.facts, coverage: value.coverage, source: value.artifact?.sha256 ?? null }))).sort();
  const criteria = state.goal.criteria.map(value => digester.digest(asJson({ key: value.key, operator: value.operator, equals: value.equals,
    minIndependentSources: value.minIndependentSources, requireCompleteCoverage: value.requireCompleteCoverage }))).sort();
  return `model:${digester.digest(asJson({ tenantId: state.policy.tenantId, scope: state.goal.scope, criteria, evidence: [...new Set(evidence)], identity, destination,
    ...(compactInputDigest ? { purpose: 'session_compact', compactInputDigest } : {}),
    ...(state.conversation?.session ? { session: state.conversation.session } : {}),
    ...(state.personalMemorySelection ? { personalMemoryDigest: personalMemoryDigest({ digester }, state) } : {}),
    ...(state.notifications?.length ? { notifications: state.notifications.map(value => value.id).sort() } : {}) }))}`;
}
export function decideExecution(state: WorkState, now: number, digester: Digester,
  checkExecution?: (task: TaskSpec) => string | null): Control {
  const collectionWait = readWaitControl(state, now, digester);
  const control = decide(state, now, task => {
    const budget = budgetAllocationError(state, task ? { toolCalls: 1 } : {});
    if (budget) return { kind: 'blocked', reason: budget };
    const gate = progressGate(state, now, task ? taskFailureKey(state, task, digester) : null);
    if (gate) return gate;
    if (task) {
      const waiting = readWaitControl(state, now, digester, task); if (waiting) return waiting;
      if (checkExecution?.(task) === 'tool_connection_required') return { kind: 'wait', reason: 'connection_required', wakeAt: null };
    }
    if (!task && !collectionWait && state.retryWakeAt != null && now < state.retryWakeAt)
      return { kind: 'wait', reason: 'retry_backoff', wakeAt: state.retryWakeAt };
    return null;
  });
  if (control.kind === 'continue' && control.action === 'dispatch') {
    const attempt = state.attempts.find(value => value.id === control.id)!;
    const task = state.plan?.tasks.find(value => value.id === attempt.taskId);
    if (task && attempt.goalRevision === state.goal.revision && attempt.scope === state.goal.scope &&
        attempt.inputDigest === taskDigest(task, digester) && checkExecution?.(task) === 'tool_connection_required')
      return { kind: 'wait', reason: 'connection_required', wakeAt: Math.min(attempt.leaseUntil, state.deadlineAt) };
  }
  return control.kind === 'replan' && collectionWait ? collectionWait : control;
}
