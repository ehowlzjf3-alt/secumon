import type { Attempt, TaskSpec, WorkState } from './model.js';

/** Internal reservation endings have no dispatch measurement or received result. */
export function isEndedToolReservation(attempt: Attempt): boolean {
  return ['cancelled', 'failed'].includes(attempt.status) &&
    ['reservation_cancelled', 'reservation_expired'].includes(attempt.error?.code ?? '') &&
    (!attempt.execution || attempt.execution.mode === 'not_invoked') &&
    attempt.resultArtifact === null && attempt.resultId === null && !attempt.adopted;
}

export function currentAttempts(state: WorkState, task: TaskSpec): Attempt[] {
  return state.attempts.filter(attempt => attempt.taskId === task.id && attempt.goalRevision === state.goal.revision && attempt.scope === state.goal.scope);
}

export function taskSucceeded(state: WorkState, task: TaskSpec): boolean {
  return currentAttempts(state, task).some(attempt => attempt.status === 'succeeded' && attempt.adopted);
}
