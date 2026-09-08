import type { StateRepository } from './ports.js';

export interface ObservationControlWatch {
  state: Pick<StateRepository, 'revisionHint'>;
  workId: string;
  basisRevision: number;
  signal: AbortSignal;
  /** Owned by this observation only; aborting it must not interrupt newer observations. */
  controller: AbortController;
  /** Recheck current authority and the exact observation basis using the authoritative store. */
  authorize(): Promise<void>;
}
export interface ObservationWatchTiming { intervalMs?: number; revalidateMs?: number }

/** A hint only schedules an authoritative check. No watcher publishes a command or marks one applied. */
export function observePendingPoll<T>(watch: ObservationControlWatch, poll: (signal: AbortSignal) => Promise<T>, timing: ObservationWatchTiming = {}): Promise<T> {
  const interval = timing.intervalMs ?? 250, revalidate = timing.revalidateMs ?? 5000;
  if (!Number.isSafeInteger(watch.basisRevision) || watch.basisRevision < 1 || !Number.isSafeInteger(interval) || interval < 1 || interval > 60000 ||
    !Number.isSafeInteger(revalidate) || revalidate < interval || revalidate > 60000) throw new Error('invalid_observation_watch');
  const signal = AbortSignal.any([watch.signal, watch.controller.signal]);
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let active = true, timer: ReturnType<typeof setTimeout> | undefined, checkedAt = performance.now();
    const finish = (done: () => void) => {
      if (!active) return;
      active = false; clearTimeout(timer); signal.removeEventListener('abort', aborted); done();
    };
    const aborted = () => finish(() => reject(signal.reason));
    const schedule = () => { if (active) timer = setTimeout(() => { void check(); }, interval); };
    const check = async () => {
      try {
        if (!active) return;
        const hint = watch.state.revisionHint;
        const revision = hint ? await hint.call(watch.state, watch.workId) : undefined;
        if (!active) return;
        if (hint && revision !== null && (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1)) throw new Error('invalid_state_revision_hint');
        if (!hint || revision !== watch.basisRevision || performance.now() - checkedAt >= revalidate) {
          await watch.authorize();
          if (!active) return;
          checkedAt = performance.now();
        }
      } catch (error) {
        // A completed/cancelled poll cannot be interrupted by a late storage response from its former watcher.
        if (active) watch.controller.abort(error);
      } finally { schedule(); }
    };
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) { aborted(); return; }
    schedule();
    try {
      // Keep handlers on the original operation even when its source ignores cancellation.
      void poll(signal).then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    } catch (error) { finish(() => reject(error)); }
  });
}
