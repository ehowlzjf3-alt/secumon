import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay, setImmediate as drain } from 'node:timers/promises';
import { observePendingPoll, type ObservationControlWatch } from '../application/observation-control-watch.js';

function gate<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([pending, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('observation_watch_test_timeout')), 2000);
  })]); } finally { clearTimeout(timer); }
}
function outcome<T>(pending: Promise<T>) {
  return pending.then(value => ({ kind: 'returned' as const, value }), error => ({ kind: 'rejected' as const, error: error as unknown }));
}
function base(overrides: Partial<ObservationControlWatch> = {}): ObservationControlWatch {
  return { state: { revisionHint: async () => 1 }, workId: 'observed-work', basisRevision: 1,
    signal: new AbortController().signal, controller: new AbortController(), authorize: async () => undefined, ...overrides };
}
const timing = { intervalMs: 5, revalidateMs: 15 };

test('observation watch removes its timer after source success or failure without changing the original result', { timeout: 10000 }, async () => {
  for (const fail of [false, true]) {
    const source = gate<object>(), hinted = gate<void>(), marker = { page: 'original' }, failure = new Error('source_failed');
    let hints = 0, checks = 0;
    const watch = base({ state: { revisionHint: async () => { hints++; hinted.resolve(); return 1; } }, authorize: async () => { checks++; } });
    const pending = outcome(observePendingPoll(watch, () => source.promise, timing));
    try {
      await bounded(hinted.promise); if (fail) source.reject(failure); else source.resolve(marker);
      const result = await bounded(pending);
      if (fail) { assert.equal(result.kind, 'rejected'); if (result.kind === 'rejected') assert.strictEqual(result.error, failure); }
      else { assert.equal(result.kind, 'returned'); if (result.kind === 'returned') assert.strictEqual(result.value, marker); }
      const finished = { hints, checks }; await delay(30);
      assert.deepEqual({ hints, checks }, finished); assert.equal(watch.controller.signal.aborted, false);
    } finally { watch.controller.abort(); source.resolve(marker); await pending; }
  }
});

test('observation watch returns parent cancellation before a noncooperative source settles and consumes its late success or failure', { timeout: 10000 }, async () => {
  for (const failLate of [false, true]) {
    const source = gate<string>(), entered = gate<void>(), parent = new AbortController();
    const cancelled = new Error('caller_cancelled'), lateFailure = new Error('late_source_failure');
    let rawFinished = false, hints = 0; let pollSignal: AbortSignal | undefined;
    const watch = base({ signal: parent.signal, state: { revisionHint: async () => { hints++; return 1; } } });
    const pending = outcome(observePendingPoll(watch, async signal => {
      pollSignal = signal; entered.resolve(); try { return await source.promise; } finally { rawFinished = true; }
    }, timing));
    try {
      await entered.promise; parent.abort(cancelled);
      const result = await bounded(pending); assert.equal(result.kind, 'rejected');
      if (result.kind === 'rejected') assert.strictEqual(result.error, cancelled);
      assert.strictEqual(pollSignal?.reason, cancelled); assert.equal(rawFinished, false);
      const stoppedHints = hints;
      if (failLate) source.reject(lateFailure); else source.resolve('late-page');
      await drain(); await delay(20);
      assert.equal(rawFinished, true); assert.equal(hints, stoppedHints); assert.equal(watch.controller.signal.aborted, false);
      assert.strictEqual(await pending, result);
    } finally { parent.abort(); source.resolve('cleanup'); await pending; }
  }
});

test('observation watch serializes slow hint reads and ignores their late failure after completion without aborting a newer poll', { timeout: 10000 }, async () => {
  const oldHint = gate<number | null>(), hintEntered = gate<void>(), nextHintEntered = gate<void>();
  const oldSource = gate<string>(), newSource = gate<string>(); let reads = 0, inFlight = 0, maximum = 0, checks = 0;
  const state: ObservationControlWatch['state'] = { revisionHint: async function(workId) {
    assert.strictEqual(this, state); assert.equal(workId, 'observed-work'); reads++; inFlight++; maximum = Math.max(maximum, inFlight);
    try {
      if (reads === 1) { hintEntered.resolve(); return await oldHint.promise; }
      nextHintEntered.resolve(); return 1;
    } finally { inFlight--; }
  } };
  const oldWatch = base({ state, authorize: async () => { checks++; } });
  const oldPending = outcome(observePendingPoll(oldWatch, () => oldSource.promise, timing));
  const newWatch = base({ state }); let newPending: ReturnType<typeof outcome<string>> | undefined;
  try {
    await bounded(hintEntered.promise); await delay(30);
    assert.equal(reads, 1); assert.equal(maximum, 1); assert.equal(inFlight, 1);
    oldSource.resolve('old-complete'); assert.deepEqual(await bounded(oldPending), { kind: 'returned', value: 'old-complete' });
    newPending = outcome(observePendingPoll(newWatch, () => newSource.promise, timing));
    await bounded(nextHintEntered.promise); oldHint.reject(new Error('old_storage_failure')); await drain();
    assert.equal(oldWatch.controller.signal.aborted, false); assert.equal(newWatch.controller.signal.aborted, false); assert.equal(checks, 0);
    newSource.resolve('new-complete'); assert.deepEqual(await bounded(newPending), { kind: 'returned', value: 'new-complete' });
    const finishedReads = reads; await delay(25); assert.equal(reads, finishedReads); assert.equal(inFlight, 0);
  } finally { oldWatch.controller.abort(); newWatch.controller.abort(); oldHint.resolve(1); oldSource.resolve('cleanup'); newSource.resolve('cleanup');
    await oldPending; if (newPending) await newPending; }
});

test('observation watch treats a missing or changed revision hint only as a reason to authorize, not as an applied control', { timeout: 10000 }, async () => {
  const source = gate<object>(), authorizedTwice = gate<void>(), marker = { page: 'still-authorized' };
  let hints = 0, checks = 0;
  const watch = base({ state: { revisionHint: async () => ++hints === 1 ? null : 7 },
    authorize: async () => { if (++checks === 2) authorizedTwice.resolve(); } });
  const pending = outcome(observePendingPoll(watch, () => source.promise, { intervalMs: 5, revalidateMs: 60000 }));
  try {
    await bounded(authorizedTwice.promise); assert.ok(hints >= 2); assert.equal(watch.controller.signal.aborted, false);
    source.resolve(marker); const result = await bounded(pending); assert.equal(result.kind, 'returned');
    if (result.kind === 'returned') assert.strictEqual(result.value, marker);
  } finally { watch.controller.abort(); source.resolve(marker); await pending; }
});

test('observation watch periodically reauthorizes even an unchanged hint and preserves the authoritative failure', { timeout: 10000 }, async () => {
  const source = gate<string>(), failure = new Error('current_authority_revoked');
  let checks = 0, hints = 0; const checkedAt: number[] = [], started = performance.now();
  const watch = base({ state: { revisionHint: async () => { hints++; return 1; } }, authorize: async () => {
    checkedAt.push(performance.now()); if (++checks === 2) throw failure;
  } });
  const pending = outcome(observePendingPoll(watch, () => source.promise, { intervalMs: 5, revalidateMs: 30 }));
  try {
    const result = await bounded(pending); assert.equal(result.kind, 'rejected');
    if (result.kind === 'rejected') assert.strictEqual(result.error, failure);
    assert.strictEqual(watch.controller.signal.reason, failure); assert.equal(checks, 2); assert.ok(hints >= checks);
    assert.ok(checkedAt[0]! - started >= 30); assert.ok(checkedAt[1]! - checkedAt[0]! >= 30);
    const stopped = { checks, hints }; await delay(25); assert.deepEqual({ checks, hints }, stopped);
  } finally { watch.controller.abort(); source.resolve('late'); await pending; }
});

test('observation watch falls back to full authorization when the store has no hint method and ignores late authorization after source completion', { timeout: 10000 }, async () => {
  const source = gate<string>(), authorization = gate<void>(), entered = gate<void>(); let checks = 0;
  const watch = base({ state: {}, authorize: async () => { checks++; entered.resolve(); await authorization.promise; } });
  const pending = outcome(observePendingPoll(watch, () => source.promise, { intervalMs: 5, revalidateMs: 60000 }));
  try {
    await bounded(entered.promise); await delay(20); assert.equal(checks, 1);
    source.resolve('complete'); assert.deepEqual(await bounded(pending), { kind: 'returned', value: 'complete' });
    authorization.reject(new Error('late_authorization_failure')); await drain(); await delay(20);
    assert.equal(checks, 1); assert.equal(watch.controller.signal.aborted, false);
  } finally { watch.controller.abort(); authorization.resolve(); source.resolve('cleanup'); await pending; }
});

test('observation watch rejects invalid revision hints and preserves original storage errors without inventing authorization', { timeout: 10000 }, async () => {
  const storageError = Object.freeze({ code: 'original_storage_io', errno: 5 });
  for (const invalid of [true, false]) {
    const source = gate<string>(); let authorizations = 0;
    const watch = base({ state: { revisionHint: async () => { if (invalid) return 0; throw storageError; } },
      authorize: async () => { authorizations++; } });
    const pending = outcome(observePendingPoll(watch, () => source.promise, timing));
    try {
      const result = await bounded(pending); assert.equal(result.kind, 'rejected'); assert.equal(authorizations, 0);
      if (result.kind === 'rejected') {
        assert.strictEqual(watch.controller.signal.reason, result.error);
        if (invalid) { assert.ok(result.error instanceof Error); assert.equal(result.error.message, 'invalid_state_revision_hint'); }
        else assert.strictEqual(result.error, storageError);
      }
    } finally { watch.controller.abort(); source.resolve('late'); await pending; }
  }
});

test('observation watch starts no source or storage operation when already cancelled or configured with invalid timing', () => {
  let sources = 0, hints = 0, checks = 0;
  for (const own of [false, true]) {
    const parent = new AbortController(), controller = new AbortController(), reason = new Error('already_cancelled');
    (own ? controller : parent).abort(reason);
    const watch = base({ signal: parent.signal, controller, state: { revisionHint: async () => { hints++; return 1; } }, authorize: async () => { checks++; } });
    assert.throws(() => observePendingPoll(watch, async () => { sources++; return 'unused'; }, timing), error => error === reason);
  }
  assert.throws(() => observePendingPoll(base(), async () => { sources++; return 'unused'; }, { intervalMs: 10, revalidateMs: 5 }), /invalid_observation_watch/);
  assert.deepEqual({ sources, hints, checks }, { sources: 0, hints: 0, checks: 0 });
});
