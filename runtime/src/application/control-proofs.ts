import type { WorkState } from '../domain/model.js';
import type { EffectProofValidator, ExternalObligationValidator, ExternalNotificationValidator } from './services.js';
import { effectProofsCurrent, requiresEffectProofs } from './effect-proofs.js';

type Services = { effects?: Pick<EffectProofValidator, 'current'> | undefined; obligations?: ExternalObligationValidator | undefined; notifications?: ExternalNotificationValidator | undefined };
export function requiresControlProofs(state: WorkState): boolean {
  return requiresEffectProofs(state) || state.obligations.some(obligation => obligation.source !== undefined) ||
    !!state.notifications?.length || !!state.subscriptions?.some(value => value.status === 'active');
}
export async function externalNotificationsCurrent(services: Services, state: WorkState): Promise<boolean> {
  if (!state.notifications?.length && !state.subscriptions?.some(value => value.status === 'active')) return true;
  try { return !!services.notifications && await services.notifications.current(state); } catch { return false; }
}
export async function externalObligationsCurrent(services: Services, state: WorkState): Promise<boolean> {
  try { return services.obligations ? await services.obligations.current(state) : !state.obligations.some(obligation => obligation.source); }
  catch { return false; }
}
/** Live coordination constrains decisions, but is not a source-data dependency. */
export async function controlProofsCurrent(services: Services, state: WorkState): Promise<boolean> {
  return await effectProofsCurrent(services, state) && await externalObligationsCurrent(services, state) && await externalNotificationsCurrent(services, state);
}
