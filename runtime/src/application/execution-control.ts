import type { Mode, ProgressSummary, WorkState } from '../domain/model.js';
import { autoExpansionReason, executionControl, type ExecutionControl } from '../domain/execution-policy.js';
import type { RuntimeServices } from './services.js';
import { transact } from './work-transactions.js';
import { refreshEffectProofs } from './effect-proofs.js';

export function executionActive(state: WorkState): boolean {
  return state.attempts.some(a => ['reserved', 'running', 'received'].includes(a.status)) ||
    state.modelCalls.some(c => ['reserved', 'running', 'received'].includes(c.status)) ||
    (state.computerReconciliations?.some(c => ['reserved', 'running', 'received'].includes(c.status)) ?? false);
}
function changed(control: ExecutionControl, mode: Mode, reason: string): ExecutionControl {
  return { ...control, revision: control.revision + 1, requestedMode: mode,
    strategy: mode === 'deep' ? 'investigate' : 'direct', pending: null, lastReason: reason };
}
function unblockMode(state: WorkState) {
  if (state.status === 'blocked' && state.statusReason.startsWith('fast_')) { state.status = 'ready'; state.statusReason = 'execution_mode_changed'; }
}
export function requestExecutionMode(state: WorkState, mode: Mode, reason: string, expectedRevision: number) {
  const prior = executionControl(state);
  if (prior.revision !== expectedRevision) throw new Error('stale_execution_control');
  if (state.status === 'completed') throw new Error('work_terminal');
  state.executionControl = executionActive(state) ? { ...prior, revision: prior.revision + 1, pending: { mode, reason }, lastReason: 'mode_change_pending' } : changed(prior, mode, reason);
  if (!state.executionControl.pending) unblockMode(state);
}
/** Changes strategy only between executions; received replies and effects remain accountable. */
export async function prepareExecutionBoundary(services: Pick<RuntimeServices, 'state' | 'artifacts' | 'clock' | 'digester' | 'effects'>, workId: string): Promise<WorkState> {
  await refreshEffectProofs(services, workId);
  for (let retry = 0; retry < 8; retry++) {
    const state = await services.state.get(workId); if (!state) throw new Error('work_not_found');
    if (executionActive(state) || ['cancelled', 'failed', 'completed'].includes(state.status)) return state;
    const prior = executionControl(state); const reason = prior.pending?.reason ?? autoExpansionReason(state);
    if (!reason) return state;
    try {
      const result = await transact(services, workId, `execution-boundary:${state.revision}`, 'execution_strategy_changed',
        { controlRevision: prior.revision, reason }, next => {
          if (next.revision !== state.revision || executionActive(next)) throw new Error('execution_boundary_changed');
          const control = executionControl(next);
          if (control.pending) { next.executionControl = changed(control, control.pending.mode, control.pending.reason); unblockMode(next); }
          else if (autoExpansionReason(next)) next.executionControl = { ...control, revision: control.revision + 1, strategy: 'investigate', lastReason: reason };
        });
      return result.state;
    } catch (error) { if (!(error instanceof Error && error.message === 'execution_boundary_changed')) throw error; }
  }
  throw new Error('execution_boundary_contention');
}

export function executionBasis(state: WorkState) {
  const control = executionControl(state);
  return { requestedMode: control.requestedMode, strategy: control.strategy, policy: control.policy };
}
export function progressSummary(state: WorkState): ProgressSummary | undefined {
  if (!state.progress) return undefined;
  const { consecutiveUnproductive, productiveSteps, unproductiveSteps, saturated } = state.progress;
  return { consecutiveUnproductive, productiveSteps, unproductiveSteps, saturated };
}
