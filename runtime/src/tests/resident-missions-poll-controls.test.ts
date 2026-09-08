import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { AgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { missionBounded, missionGate, missionRegistrationFixture, missionRegistrationProbe,
  type MissionPoll } from './host-missions-registration-fixture.js';

const rawCheckpoint = z.object({ cursor: z.number(), snapshotDigest: z.string().nullable(), nextPollAt: z.number(), idlePolls: z.number(),
  status: z.enum(['active', 'closed']), suspended: z.boolean().optional(), controlRevision: z.number().optional(),
  claim: z.object({ owner: z.string(), until: z.number() }).nullable(), seen: z.array(z.unknown()), pending: z.array(z.unknown()) });
async function record(profile: AgentTurnProfile, workId: string) {
  const state = await profile.services.state.get(workId); assert.ok(state);
  const subscription = state.subscriptions?.find(value => value.provider === 'resident-mission'); assert.ok(subscription);
  const artifact = state.artifacts.find(value => subscription.checkpointId === `resident:${value.sha256}`); assert.ok(artifact);
  const receipt = await profile.services.state.receipt(workId, subscription.checkpointId); assert.ok(receipt);
  assert.deepEqual(receipt.state.subscriptions?.find(value => value.id === subscription.id), subscription);
  const bytes = await profile.services.artifacts.get(artifact, state.policy);
  return { state, subscription, artifact, receipt, bytes, value: rawCheckpoint.parse(JSON.parse(new TextDecoder().decode(bytes))) };
}
async function preserved(profile: AgentTurnProfile, original: Awaited<ReturnType<typeof record>>) {
  assert.deepEqual(await profile.services.state.receipt(original.state.id, original.subscription.checkpointId), original.receipt);
  assert.deepEqual(await profile.services.artifacts.get(original.artifact, original.state.policy), original.bytes);
}
function outcome<T>(promise: Promise<T>) { return promise.then(value => ({ kind: 'returned' as const, value }), error => ({ kind: 'rejected' as const, error })); }

async function fixture(t: TestContext) {
  const base = missionRegistrationFixture(t), probe = missionRegistrationProbe();
  const gates = new Map<string, { entered: ReturnType<typeof missionGate>; release: ReturnType<typeof missionGate>;
    finished: ReturnType<typeof missionGate>; request?: MissionPoll; settled: boolean; error?: Error }>();
  function hold(resourceId: string, error?: Error) {
    const value = { entered: missionGate(), release: missionGate(), finished: missionGate(), settled: false, ...(error ? { error } : {}) };
    gates.set(resourceId, value); return gates.get(resourceId)!;
  }
  // This is the real registered raw callback. It deliberately ignores abort until the test releases it.
  const poll = probe.source.poll;
  probe.source.poll = async function (input) {
    try { return await poll.call(probe.source, input); }
    finally { const gate = gates.get(input.resourceId); if (gate) { gate.settled = true; gate.finished.release(); } }
  };
  probe.controls.beforePoll = async () => {
    const request = probe.requests.at(-1); assert.ok(request); const gate = gates.get(request.resourceId); assert.ok(gate);
    gate.request = request; gate.entered.release(); await gate.release.promise; if (gate.error) throw gate.error;
  };
  const profile = await base.open(probe.registration);
  assert.ok(profile.services.workCancellation, 'the ordinary profile must use the real ExecutionRuntime cancellation registry');
  const defaults = { binding: { ...profile.executionActor, channel: 'test' as const, conversationId: 'resident-poll-controls',
    recipientId: profile.actor.principalId, destination: 'local' }, policy: profile.policy, limits: profile.limits };
  const driver = profile.createResidentMissions(defaults);
  async function register(id: string) {
    return driver.register({ rule: { id, sourceId: 'observations', resourceId: id,
      pollIntervalMs: 1000, maxResumes: 4, maxIdlePolls: 4, maxNoProgress: 3 }, instruction: 'Keep the original observation without adding authority.' });
  }
  function noExecution() { assert.equal(base.entry.observed.modelInputs.length, 0); assert.equal(base.entry.observed.reads, 0); }
  async function releaseAll() {
    for (const gate of gates.values()) gate.release.release();
    await missionBounded(Promise.all([...gates.values()].filter(value => value.request).map(value => value.finished.promise)));
  }
  return { base, probe, profile, driver, defaults, hold, register, noExecution, releaseAll };
}

for (const action of ['pause', 'stop'] as const) test(`resident poll control ${action} ends before raw release and leaves another controller on the same source running`, { timeout: 30000 }, async t => {
  const h = await fixture(t), one = await h.register('first-controller'), two = await h.register('second-controller');
  const first = h.hold('first-controller'), second = h.hold('second-controller');
  const original = await record(h.profile, one.workId), otherOriginal = await record(h.profile, two.workId);
  const oneRun = outcome(h.driver.tick(one.workId)), twoRun = outcome(h.driver.tick(two.workId)); let otherEnded = false;
  void twoRun.then(() => { otherEnded = true; });
  try {
    await missionBounded(Promise.all([first.entered.promise, second.entered.promise]));
    const otherClaim = await record(h.profile, two.workId); assert.ok(otherClaim.value.claim);
    await h.driver[action](one.workId);
    const result = await missionBounded(oneRun); assert.equal(result.kind, 'rejected');
    if (result.kind === 'rejected') assert.match(String(result.error), /resident_mission_changed/);
    assert.equal(first.settled, false); assert.equal(first.request!.signal.aborted, true);
    assert.equal(second.request!.signal.aborted, false); assert.equal(otherEnded, false);
    assert.deepEqual((await record(h.profile, two.workId)).state, otherClaim.state);
    const controlled = await record(h.profile, one.workId);
    assert.equal(controlled.value.claim, null); assert.equal(controlled.value.cursor, 0);
    assert.equal(controlled.value.status, action === 'stop' ? 'closed' : 'active');
    assert.equal(Boolean(controlled.value.suspended), action === 'pause');
    assert.deepEqual(controlled.value.pending, []); assert.deepEqual(controlled.value.seen, []);
    assert.equal(controlled.value.idlePolls, 0); assert.equal(controlled.value.snapshotDigest, null);
    assert.deepEqual(controlled.state.budget, original.state.budget); h.noExecution(); assert.equal(h.probe.counts.closes, 0);
    first.release.release(); await missionBounded(first.finished.promise);
    assert.deepEqual((await record(h.profile, one.workId)).state, controlled.state);
    await preserved(h.profile, original); await preserved(h.profile, otherOriginal);
    await h.driver.stop(two.workId); const ended = await missionBounded(twoRun); assert.equal(ended.kind, 'rejected');
    assert.equal(second.settled, false); assert.equal(second.request!.signal.aborted, true);
    assert.equal(h.probe.counts.polls, 2); h.noExecution();
  } finally { await h.releaseAll(); await missionBounded(Promise.allSettled([oneRun, twoRun])); }
});

test('resident poll control drive caller abort releases its claim while the owner remains live', { timeout: 30000 }, async t => {
  const h = await fixture(t), registered = await h.register('caller-abort'), gate = h.hold('caller-abort');
  const original = await record(h.profile, registered.workId), stop = new AbortController(), reason = new Error('explicit_drive_stop');
  const running = outcome(h.driver.drive(registered.workId, { signal: stop.signal, maxTicks: 2 }));
  try {
    await missionBounded(gate.entered.promise); const claimed = await record(h.profile, registered.workId); assert.ok(claimed.value.claim);
    stop.abort(reason); const result = await missionBounded(running); assert.equal(result.kind, 'returned');
    if (result.kind === 'returned') { assert.equal(result.value.kind, 'aborted'); assert.equal(result.value.reason, reason); }
    assert.equal(gate.settled, false); assert.equal(gate.request!.signal.aborted, true);
    const released = await record(h.profile, registered.workId);
    assert.deepEqual(released.value, { ...claimed.value, claim: null, controlRevision: (claimed.value.controlRevision ?? 0) + 1 });
    assert.deepEqual(released.state.budget, original.state.budget); assert.equal((await h.driver.status(registered.workId)).status, 'active');
    assert.equal(h.probe.counts.closes, 0); h.noExecution();
    gate.release.release(); await missionBounded(gate.finished.promise);
    assert.deepEqual((await record(h.profile, registered.workId)).state, released.state); await preserved(h.profile, claimed);
    await preserved(h.profile, original);
  } finally { await h.releaseAll(); await missionBounded(running); }
});

test('resident poll control driver close releases only its own claim and leaves late raw rejection to the source owner drain', { timeout: 30000 }, async t => {
  const h = await fixture(t), registered = await h.register('driver-close'), gate = h.hold('driver-close', new Error('late_raw_failure'));
  const original = await record(h.profile, registered.workId), running = outcome(h.driver.tick(registered.workId));
  let ownerClose: Promise<void> | undefined;
  try {
    await missionBounded(gate.entered.promise); const claimed = await record(h.profile, registered.workId); assert.ok(claimed.value.claim);
    const close = h.driver.close(); assert.equal(h.driver.close(), close); await missionBounded(close);
    assert.equal((await missionBounded(running)).kind, 'rejected'); assert.equal(gate.settled, false);
    assert.equal(gate.request!.signal.aborted, true); assert.equal(h.probe.counts.closes, 0);
    assert.throws(() => h.driver.tick(registered.workId));
    const released = await record(h.profile, registered.workId);
    assert.deepEqual(released.value, { ...claimed.value, claim: null, controlRevision: (claimed.value.controlRevision ?? 0) + 1 });
    await preserved(h.profile, original); await preserved(h.profile, claimed); h.noExecution();
    const otherDriver = h.profile.createResidentMissions(h.defaults);
    assert.equal((await otherDriver.status(registered.workId)).status, 'active');
    const ownerEntered = missionGate(); h.probe.controls.beforeClose = async () => { ownerEntered.release(); };
    let ownerFinished = false; ownerClose = h.profile.close(); void ownerClose.then(() => { ownerFinished = true; });
    await missionBounded(ownerEntered.promise); assert.equal(h.probe.counts.closes, 1);
    assert.equal(ownerFinished, false, 'the original source owner must still drain the unresolved raw promise');
    assert.deepEqual((await record(h.profile, registered.workId)).state, released.state);
    gate.release.release(); await missionBounded(ownerClose); assert.equal(gate.settled, true);
    assert.equal(h.probe.counts.closes, 1); h.noExecution();
    const reopened = await h.base.open(missionRegistrationProbe().registration);
    assert.deepEqual((await record(reopened, registered.workId)).state, released.state); await preserved(reopened, original);
  } finally { await h.releaseAll(); await missionBounded(Promise.allSettled([running, ownerClose])); }
});

test('resident poll control profile authority closure preserves the original claim without an unauthorized cleanup write', { timeout: 30000 }, async t => {
  const h = await fixture(t), registered = await h.register('profile-close'), gate = h.hold('profile-close');
  const running = outcome(h.driver.tick(registered.workId)); let closing: Promise<void> | undefined;
  try {
    await missionBounded(gate.entered.promise); const claimed = await record(h.profile, registered.workId); assert.ok(claimed.value.claim);
    const events = await h.profile.services.state.events(registered.workId, 0), ownerEntered = missionGate();
    h.probe.controls.beforeClose = async () => { ownerEntered.release(); };
    closing = h.profile.close(); assert.equal(h.profile.close(), closing);
    assert.equal((await missionBounded(running)).kind, 'rejected'); await missionBounded(ownerEntered.promise);
    assert.equal(gate.settled, false); assert.equal(gate.request!.signal.aborted, true);
    assert.deepEqual((await record(h.profile, registered.workId)).state, claimed.state);
    assert.deepEqual(await h.profile.services.state.events(registered.workId, 0), events);
    gate.release.release(); await missionBounded(closing); assert.equal(h.probe.counts.closes, 1); h.noExecution();
    const reopened = await h.base.open(missionRegistrationProbe().registration);
    const retained = await record(reopened, registered.workId);
    assert.deepEqual(retained.state, claimed.state); assert.deepEqual(retained.receipt, claimed.receipt); assert.deepEqual(retained.bytes, claimed.bytes);
  } finally { await h.releaseAll(); await missionBounded(Promise.allSettled([running, closing])); }
});
