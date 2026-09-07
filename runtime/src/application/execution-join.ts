import type { Attempt, WorkState } from '../domain/model.js';
import type { Clock, StateRepository } from './ports.js';

export interface ExecutionJoinDriver {
  readonly owner: string;
  execute(workId: string, attemptId: string): Promise<void>;
}
type Observation = {
  workId: string;
  attemptId: string;
  revision: number;
  status: Attempt['status'];
  effectState: Attempt['effectState'];
  dispatched: boolean;
  hasResultArtifact: boolean;
  leaseUntil: number;
  deadlineAt: number;
};
type WaitReason = 'running_without_local_flight' | 'different_owner' | 'lease_expired' | 'work_inactive' | 'dispatch_not_started';
type Outcome = (Observation & { kind: 'settled' }) | (Observation & { kind: 'waiting'; reason: WaitReason });
export type ExecutionJoinResult = (Outcome | { kind: 'detached'; workId: string; attemptId: string; reason: 'caller_aborted' }) & { joined: boolean };
type Snapshot = { state: WorkState; attempt: Attempt; dispatched: boolean };

/** Internal execution coordination, not an actor-authorized resource API. Only callers of this facade share local waits. */
export class ExecutionJoin {
  #flights = new Map<string, Promise<Outcome>>();
  constructor(readonly services: { state: StateRepository; clock: Clock }, readonly driver: ExecutionJoinDriver) {
    if (!driver.owner) throw new Error('invalid_execution_join_owner');
  }
  private async snapshot(workId: string, attemptId: string): Promise<Snapshot> {
    for (let retry = 0; retry < 8; retry++) {
      const state = await this.services.state.get(workId); if (!state) throw new Error('work_not_found');
      const attempt = state.attempts.find(a => a.id === attemptId); if (!attempt) throw new Error('attempt_not_found');
      const receipt = await this.services.state.receipt(workId, `dispatch:${attemptId}`);
      const latest = await this.services.state.get(workId);
      if (!latest || latest.revision !== state.revision) continue;
      return { state, attempt, dispatched: receipt !== null };
    }
    throw new Error('execution_join_state_changed');
  }
  private observe({ state, attempt, dispatched }: Snapshot): Outcome {
    const observation: Observation = { workId: state.id, attemptId: attempt.id, revision: state.revision, status: attempt.status, effectState: attempt.effectState,
      dispatched, hasResultArtifact: attempt.resultArtifact !== null, leaseUntil: attempt.leaseUntil, deadlineAt: state.deadlineAt };
    // "settled" describes execution only; received results still need adoption and unknown effects still need reconciliation.
    if (attempt.status !== 'reserved' && attempt.status !== 'running') return Object.freeze({ ...observation, kind: 'settled' });
    const reason: WaitReason = this.services.clock.now() >= Math.min(attempt.leaseUntil, state.deadlineAt) ? 'lease_expired' :
      ['paused', 'cancelled', 'failed', 'completed', 'blocked'].includes(state.status) ? 'work_inactive' : attempt.owner !== this.driver.owner ? 'different_owner' :
      attempt.status === 'running' ? 'running_without_local_flight' : 'dispatch_not_started';
    return Object.freeze({ ...observation, kind: 'waiting', reason });
  }
  private async run(workId: string, attemptId: string): Promise<Outcome> {
    const before = await this.snapshot(workId, attemptId); const observation = this.observe(before);
    if (observation.kind !== 'waiting' || observation.reason !== 'dispatch_not_started') return observation;
    try { await this.driver.execute(workId, attemptId); }
    catch (error) {
      if (!(error instanceof Error) || !['attempt_not_dispatchable', 'attempt_expired', 'task_not_ready'].includes(error.message)) throw error;
    }
    return this.observe(await this.snapshot(workId, attemptId));
  }
  execute(workId: string, attemptId: string, signal?: AbortSignal): Promise<ExecutionJoinResult> {
    if (!workId || !attemptId) return Promise.reject(new Error('invalid_execution_join_identity'));
    let joined = false;
    const detached = () => Object.freeze({ kind: 'detached' as const, workId, attemptId, reason: 'caller_aborted' as const, joined });
    if (signal?.aborted) return Promise.resolve(detached());
    const key = JSON.stringify([workId, attemptId]); let flight = this.#flights.get(key);
    joined = flight !== undefined;
    if (!flight) {
      flight = this.run(workId, attemptId); this.#flights.set(key, flight);
      const clear = () => { if (this.#flights.get(key) === flight) this.#flights.delete(key); };
      void flight.then(clear, clear);
    }
    const pending = flight.then(value => Object.freeze({ ...value, joined }));
    if (!signal) return pending;
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); resolve(detached()); };
      signal.addEventListener('abort', abort, { once: true });
      void pending.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
      if (signal.aborted) abort();
    });
  }
}
