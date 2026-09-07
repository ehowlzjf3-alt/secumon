import type { WorkState } from '../domain/model.js';
import type { EffectProofValidator, RuntimeServices } from './services.js';
import { transact } from './work-transactions.js';
import { cancelBudgetReservations } from './budget-delegation.js';

export function requiresEffectProofs(state: WorkState): boolean {
  return state.attempts.some(attempt => attempt.effectReceipt !== undefined) || !!state.computerContinuations?.length || !!state.computerReconciliations?.some(record => record.status === 'settled' || record.proofArtifact !== null);
}

export async function effectProofsCurrent(services: { effects?: Pick<EffectProofValidator, 'current'> | undefined }, state: WorkState): Promise<boolean> {
  if (!requiresEffectProofs(state)) return true;
  if (!services.effects) return false;
  try { return await services.effects.current(state); } catch { return false; }
}

/** Without a proof reader, stored outcomes remain historical claims and cannot discharge the original effect. */
export async function refreshEffectProofs(services: Pick<RuntimeServices, 'state' | 'artifacts' | 'clock' | 'digester' | 'effects'>,
  workId: string): Promise<WorkState> {
  if (services.effects) return services.effects.refresh(workId);
  for (let retry = 0; retry < 8; retry++) {
    const state = await services.state.get(workId); if (!state) throw new Error('work_not_found');
    if (state.attempts.some(attempt => attempt.effectReceipt)) throw new Error('effect_receipt_reader_unavailable');
    const now = services.clock.now();
    const invalid = (state.computerReconciliations ?? []).filter(record => record.status === 'settled' ||
      (['reserved', 'running'].includes(record.status) && record.leaseUntil <= now));
    if (!invalid.length) {
      if (state.computerContinuations?.length) throw new Error('computer_continuation_proof_unavailable');
      return state;
    }
    try {
      return (await transact(services, workId, `effect-proof-unavailable:${state.revision}`, 'effect_proofs_invalidated',
        { expectedRevision: state.revision }, next => {
          if (next.revision !== state.revision) throw new Error('effect_proof_state_changed');
          for (const record of next.computerReconciliations ?? []) {
            if (!invalid.some(value => value.id === record.id)) continue;
            if (record.status === 'reserved') next.budget.reservedToolCalls--;
            record.status = 'failed'; record.finishedAt ??= now; record.reason = 'effect_proof_unavailable';
            const obligation = next.obligations.find(value => value.id === record.obligationId);
            if (obligation) obligation.status = 'pending';
            else next.obligations.push({ id: record.obligationId, kind: 'effect_reconciliation', reason: 'dispatched_effect_requires_reconciliation',
              status: 'pending', wakeKey: null, dueAt: null });
          }
          cancelBudgetReservations(next, now);
        })).state;
    } catch (error) { if (!(error instanceof Error && error.message === 'effect_proof_state_changed')) throw error; }
  }
  throw new Error('effect_proof_contention');
}
