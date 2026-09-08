import { ResidentMissions, type ResidentMission, type ResidentMissionDependencies, type ResidentDriveOptions } from '../application/resident-missions.js';
import type { MissionRule } from '../application/mission-contracts.js';
import type { Policy, Limits } from '../domain/model.js';
import type { AgentTurnRequest } from '../application/agent-turn-service.js';
import { frozen } from '../application/resource-contracts.js';

export interface HostResidentMissionDefaults {
  readonly binding: AgentTurnRequest['binding']; readonly policy: Policy; readonly limits: Limits;
  readonly mode?: ResidentMission['mode'];
}
/** Host composition seam. Sources are borrowed from OpenedHostMissions; its owner still closes them. */
export function createHostResidentMissions(dependencies: ResidentMissionDependencies, defaults: HostResidentMissionDefaults) {
  const selected = frozen(structuredClone(defaults)), actor = frozen(structuredClone(dependencies.actor));
  const lifetime = new AbortController(); const signal = AbortSignal.any([dependencies.signal, lifetime.signal]);
  const driver = new ResidentMissions({ ...dependencies, actor, signal, cleanupSignal: dependencies.cleanupSignal ?? dependencies.signal });
  const active = new Set<Promise<unknown>>(); let closing: Promise<void> | undefined;
  function track<T>(action: () => Promise<T>): Promise<T> {
    signal.throwIfAborted(); const operation = Promise.resolve().then(action); active.add(operation);
    void operation.then(() => active.delete(operation), () => active.delete(operation)); return operation;
  }
  return Object.freeze({
    register(input: { rule: MissionRule; instruction: string; sessionId?: string }) { return track(async () => {
      signal.throwIfAborted();
      const session = await dependencies.sessions.open(actor, { channel: selected.binding.channel, conversationId: selected.binding.conversationId,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }) });
      return driver.register({ rule: input.rule, instruction: input.instruction, sessionId: session.scope.sessionId, binding: selected.binding,
        policy: selected.policy, limits: selected.limits, mode: selected.mode ?? 'auto' });
    }); },
    status(workId: string) { return track(() => driver.status(workId)); },
    pause(workId: string) { return track(() => driver.pause(workId)); },
    resume(workId: string) { return track(() => driver.resume(workId)); },
    tick(workId: string, options?: Parameters<ResidentMissions['tick']>[1]) { return track(() => driver.tick(workId, options)); },
    drive(workId: string, options: Omit<ResidentDriveOptions, 'signal'> & { signal?: AbortSignal } = {}) {
      return track(() => driver.drive(workId, { ...options, signal: options.signal ?? signal }));
    },
    stop(workId: string) { return track(() => driver.close(workId)); },
    close() { lifetime.abort(); return closing ??= Promise.allSettled([...active]).then(() => undefined); },
  });
}
