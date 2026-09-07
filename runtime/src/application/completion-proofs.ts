import type { WorkState } from '../domain/model.js';
import type { EffectProofValidator, ReadCoverageProofValidator, ExternalObligationValidator, ExternalNotificationValidator } from './services.js';
import { effectProofsCurrent, requiresEffectProofs } from './effect-proofs.js';
import { externalObligationsCurrent, externalNotificationsCurrent } from './control-proofs.js';

type Services = { effects?: Pick<EffectProofValidator, 'current'> | undefined; readCoverage?: ReadCoverageProofValidator | undefined;
  obligations?: ExternalObligationValidator | undefined; notifications?: ExternalNotificationValidator | undefined };
export function requiresCompletionProofs(state: WorkState): boolean {
  return requiresEffectProofs(state) || state.obligations.some(obligation => obligation.source) || state.goal.criteria.some(criterion => criterion.requireCollection !== undefined) ||
    !!state.notifications?.length || !!state.subscriptions?.some(value => value.status === 'active');
}
export async function completionProofsCurrent(services: Services, state: WorkState): Promise<boolean> {
  return await dataProofsCurrent(services, state) && await externalObligationsCurrent(services, state) && await externalNotificationsCurrent(services, state);
}
export async function dataProofsCurrent(services: Services, state: WorkState): Promise<boolean> {
  if (!(await effectProofsCurrent(services, state))) return false;
  if (!state.goal.criteria.some(criterion => criterion.requireCollection !== undefined)) return true;
  if (!services.readCoverage) return false;
  try { return await services.readCoverage.current(state); } catch { return false; }
}
