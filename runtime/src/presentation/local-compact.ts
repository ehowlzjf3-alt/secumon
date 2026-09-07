import { authorizedWork, type WorkActor } from '../application/work-resources.js';
import type { LocalProfile } from './local-profile.js';
import type { WebCompactInput, WebCompactResult, WebCompactStatus } from './web-contracts.js';

/** Reads references and the recorded call state, without compiling context or invoking a provider. */
export async function localCompactStatus(profile: LocalProfile, actor: WorkActor, workId: string): Promise<WebCompactStatus> {
  const state = await authorizedWork(profile.services.state, workId, actor);
  const scope = state.conversation?.session?.scope;
  if (!profile.sessions || !scope || scope.agentId !== profile.agentId) throw new Error('session_work_unavailable');
  const summary = await profile.sessions.compactStatus(actor, scope.sessionId);
  const call = state.modelCalls.filter(value => value.purpose === 'session_compact').at(-1);
  const stage: WebCompactStatus['stage'] = call ? ({ reserved: 'queued', running: 'running', received: 'validating', accepted: 'ready',
    rejected: 'failed', unknown: 'unknown', cancelled: 'cancelled' } as const)[call.status] :
    state.statusReason.startsWith('session_compact_') || state.statusReason === 'session_context_capacity' ? 'needed' : 'idle';
  return { workId, sessionId: scope.sessionId, stateRevision: state.revision, stage, provider: profile.compactProvider, summary,
    reason: call ? safeReason(call.reason) : safeReason(state.statusReason),
    call: call ? { id: call.id, status: call.status, requestId: call.compactRequestId ?? null, inputTokens: call.inputTokens, outputTokens: call.outputTokens } : null,
    originalHistoryPreserved: true };
}
function safeReason(value: string) { return /^[a-z][a-z0-9_]{0,90}$/.test(value) ? value : null; }

/** Advances only this compact reservation; it never starts ordinary planning or tools. */
export async function requestLocalCompact(profile: LocalProfile, actor: WorkActor, workId: string, input: WebCompactInput): Promise<WebCompactResult> {
  await localCompactStatus(profile, actor, workId);
  const planning = profile.compactPlanning;
  if (!planning || !profile.services.planner.compact) throw new Error('session_compact_unavailable');
  const call = await planning.requestCompact(workId, { force: true, requestId: input.requestId, expectedGoalRevision: input.expectedGoalRevision });
  for (let step = 0; call && step < 4; step++) {
    const state = await authorizedWork(profile.services.state, workId, actor);
    if (!state.modelCalls.some(value => value.id === call.id && ['reserved', 'running', 'received'].includes(value.status))) break;
    const result = await planning.compactStep(workId, { auto: false });
    if (!result || result.kind !== 'continue') break;
  }
  return { requestId: input.requestId, callId: call?.id ?? null, status: await localCompactStatus(profile, actor, workId) };
}
