import type { WorkState } from '../domain/model.js';
import type { AppliedSessionInput, SessionContext } from '../domain/session.js';
import { SessionContextSchema } from './session-contracts.js';
import type { RuntimeServices } from './services.js';

type Services = Pick<RuntimeServices, 'sessions'>;
const bound = (state: WorkState) => !!state.conversation?.session || !!state.conversation?.bindings.some(binding => binding.session);
export function sameSessionInput(left: AppliedSessionInput | undefined, right: AppliedSessionInput | undefined): boolean {
  if (!left || !right) return left === right;
  return left.scope.tenantId === right.scope.tenantId && left.scope.agentId === right.scope.agentId &&
    left.scope.principalId === right.scope.principalId && left.scope.sessionId === right.scope.sessionId &&
    left.input.messageId === right.input.messageId && left.input.sequence === right.input.sequence && left.input.digest === right.input.digest;
}
export async function sessionInputsCurrent(services: Services, state: WorkState, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  if (!bound(state)) return true;
  try { return !!state.conversation?.session && !!services.sessions && await services.sessions.current(state, undefined, signal) && !signal?.aborted; }
  catch { return false; }
}
/** Missing session text is not a legacy packet when the work has an applied session input. */
export async function sessionContextCurrent(services: Services, state: WorkState, context: SessionContext | undefined, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  if (!bound(state)) return context === undefined;
  if (!context || !state.conversation?.session || !services.sessions) return false;
  try {
    const parsed = SessionContextSchema.parse(context);
    return sameSessionInput(parsed.basis, state.conversation.session) &&
      parsed.basis.scope.tenantId === state.policy.tenantId && parsed.basis.scope.principalId === state.policy.principalId &&
      await services.sessions.current(state, parsed, signal) && !signal?.aborted;
  } catch { return false; }
}
export async function readSessionContext(services: Services, state: WorkState): Promise<SessionContext | undefined> {
  if (!bound(state)) return undefined;
  if (!state.conversation?.session || !services.sessions) throw new Error('session_context_unavailable');
  const context = SessionContextSchema.parse(await services.sessions.context(state));
  if (!(await sessionContextCurrent(services, state, context))) throw new Error('session_context_changed');
  return context;
}
