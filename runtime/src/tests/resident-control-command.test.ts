import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResidentControlCommand } from '../application/resident-missions.js';
import { asJson } from '../application/plan-validator.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { FileJournalStateRepository } from '../infrastructure/file-journal-state.js';
import { residentEntryFixture, residentEvent } from './resident-missions-entry-fixture.js';
import { missionBounded, missionGate } from './host-missions-registration-fixture.js';

type Fixture = Awaited<ReturnType<typeof residentEntryFixture>>;
const command = (commandId: string, kind: ResidentControlCommand['kind'], expectedControlRevision: number): ResidentControlCommand => ({ commandId, kind, expectedControlRevision });
async function record(f: Fixture, workId: string) {
  const p = f.current(), state = await p.services.state.get(workId); assert.ok(state);
  const subscription = state.subscriptions!.find(value => value.provider === 'resident-mission'); assert.ok(subscription);
  const artifact = state.artifacts.find(value => subscription.checkpointId === `resident:${value.sha256}`); assert.ok(artifact);
  const bytes = await p.services.artifacts.get(artifact, state.policy), body = JSON.parse(new TextDecoder().decode(bytes));
  const receiptId = body.controlPublication ? `resident-control:${p.services.digester.digest(asJson({ agentId: p.agentId, workId, commandId: body.controlPublication.commandId }))}` : subscription.checkpointId;
  const receipt = await p.services.state.receipt(workId, receiptId); assert.ok(receipt);
  assert.deepEqual(receipt.state.subscriptions!.find(value => value.id === subscription.id), subscription);
  return { state, subscription, artifact, bytes, body, receiptId, receipt };
}
async function preserved(f: Fixture, original: Awaited<ReturnType<typeof record>>) {
  assert.deepEqual(await f.current().services.state.receipt(original.state.id, original.receiptId), original.receipt);
  assert.deepEqual(await f.current().services.artifacts.get(original.artifact, original.state.policy), original.bytes);
}
const outcome = <T>(promise: Promise<T>) => promise.then(value => ({ kind: 'returned' as const, value }), error => ({ kind: 'rejected' as const, error }));

for (const stateBackend of ['sqlite', 'file-journal'] as const) test(`resident stable control ${stateBackend}: replay, conflict, stale, stop and legacy publication across reopen`, { timeout: 120000 }, async t => {
  const f = await residentEntryFixture(t, false, { stateBackend }), registered = await f.register(), workId = registered.workId;
  const original = await record(f, workId), pause = command('pause-once', 'pause', 0);
  assert.equal((await f.driver().status(workId)).controlRevision, 0);
  const paused = await f.driver().control(workId, pause, registered.sessionId), pausedRecord = await record(f, workId);
  assert.equal(paused.replayed, false); assert.equal(paused.current.status, 'paused'); assert.equal(paused.appliedControlRevision, 1);
  assert.equal(paused.appliedStateRevision, pausedRecord.state.revision);
  assert.deepEqual(pausedRecord.body.controlPublication, pause);
  assert.equal(await f.current().services.state.receipt(workId, pausedRecord.subscription.checkpointId), null, 'one atomic command receipt, not a second alias write');
  assert.deepEqual((await f.driver().control(workId, pause)).current, paused.current);
  await assert.rejects(f.driver().control(workId, { ...pause, kind: 'resume' }), /resident_control_conflict/);
  await assert.rejects(f.driver().control(workId, command('stale-new-command', 'resume', 0)), /resident_control_stale/);
  const resumed = await f.driver().control(workId, command('resume-once', 'resume', 1));
  assert.equal(resumed.current.status, 'active'); assert.equal(resumed.current.controlRevision, 2);
  const active = await record(f, workId), replay = await f.driver().control(workId, pause);
  assert.equal(replay.replayed, true); assert.equal(replay.appliedControlRevision, 1); assert.equal(replay.appliedStateRevision, paused.appliedStateRevision);
  assert.equal(replay.current.status, 'active'); assert.deepEqual((await record(f, workId)).state, active.state);
  await f.reopen();
  assert.equal((await f.driver().control(workId, pause)).current.status, 'active'); await preserved(f, pausedRecord); await preserved(f, original);
  // An ordinary subsequent observation publishes through the legacy SHA receipt, not through the old control key.
  await f.driver().tick(workId);
  const observed = await record(f, workId); assert.equal(observed.body.controlPublication, undefined);
  assert.equal(observed.receiptId, observed.subscription.checkpointId); await preserved(f, active);
  const current = await f.driver().status(workId), stop = command('stop-once', 'stop', current.controlRevision);
  const stopped = await f.driver().control(workId, stop); assert.equal(stopped.current.status, 'closed');
  const stoppedRecord = await record(f, workId);
  assert.equal((await f.driver().control(workId, stop)).replayed, true);
  assert.equal((await f.driver().control(workId, pause)).current.status, 'closed');
  await assert.rejects(f.driver().control(workId, command('new-after-stop', 'resume', stopped.current.controlRevision)), /resident_mission_closed/);
  await f.reopen(); assert.deepEqual((await record(f, workId)).state, stoppedRecord.state);
  assert.deepEqual(stoppedRecord.state.budget, original.state.budget); assert.deepEqual(stoppedRecord.state.modelCalls, []); assert.deepEqual(stoppedRecord.state.attempts, []);
  assert.equal(f.observed.inputs.first.length, 0); assert.equal(f.observed.polls.length, 1);
});

test('resident stable control: prior pause replay leaves the post-resume poll running and preserves raw events', { timeout: 120000 }, async t => {
  const f = await residentEntryFixture(t), { workId } = await f.register(), oldGate = missionGate(), newGate = missionGate();
  const oldEntered = missionGate(), newEntered = missionGate(); const signals: AbortSignal[] = [];
  f.pages.first.push([residentEvent('original', 'PRESERVE_RAW_EVENT')]);
  f.controls.beforePoll = async (_role, signal) => { signals.push(signal); const first = signals.length === 1;
    (first ? oldEntered : newEntered).release(); await (first ? oldGate : newGate).promise; };
  const first = outcome(f.driver().tick(workId)); let second: typeof first | undefined;
  try {
    await missionBounded(oldEntered.promise); const pause = command('pause-old-poll', 'pause', (await f.driver().status(workId)).controlRevision);
    const paused = await f.driver().control(workId, pause); assert.equal((await missionBounded(first)).kind, 'rejected'); assert.equal(signals[0]!.aborted, true);
    await f.driver().control(workId, command('resume-new-poll', 'resume', paused.current.controlRevision));
    second = outcome(f.driver().tick(workId)); await missionBounded(newEntered.promise);
    const before = await record(f, workId), replay = await f.driver().control(workId, pause);
    assert.equal(replay.current.status, 'active'); assert.equal(signals[1]!.aborted, false);
    assert.deepEqual((await record(f, workId)).state, before.state);
    const next = await f.driver().control(workId, command('new-pause-intent', 'pause', replay.current.controlRevision));
    assert.equal(next.current.status, 'paused'); assert.equal(signals[1]!.aborted, true);
    assert.equal((await missionBounded(second)).kind, 'rejected');
    assert.deepEqual((await record(f, workId)).body.pending, []); assert.equal(f.observed.inputs.first.length, 0);
  } finally { oldGate.release(); newGate.release(); await Promise.allSettled([first, ...(second ? [second] : [])]); }
});

for (const stage of ['candidate_synced', 'published'] as const) test(`resident stable control: actual journal ${stage} failure and exact retry`, { timeout: 120000 }, async t => {
  const f = await residentEntryFixture(t, false, { stateBackend: 'file-journal' }), { workId } = await f.register(), p = f.current();
  const original = await record(f, workId), repository = p.services.state; assert.ok(repository instanceof FileJournalStateRepository);
  const profile = new FileAgentProfileStore(fileURLToPath(new URL('../../', import.meta.url))).inspect(join(f.base, 'first'));
  assert.equal(profile.status, 'ready'); if (profile.status !== 'ready') throw new Error('profile_not_ready');
  let armed = true, observedError: unknown; const cause = new Error('resident-command-stage-failure');
  const writer = new FileJournalStateRepository(profile.paths.state, { ...repository.options, onCommitStage(current, identity) {
    if (armed && current === stage && identity.workId === workId) { armed = false; throw cause; }
  } });
  const commit = repository.commit.bind(repository);
  repository.commit = async request => {
    if (!armed || !request.events.some(value => value.type === 'resident_control')) return commit(request);
    try { return await writer.commit(request); } catch (error) { observedError = error; throw error; }
  };
  const entered = missionGate(), release = missionGate(); let pollSignal: AbortSignal | undefined;
  f.controls.beforePoll = async (_role, signal) => { pollSignal = signal; entered.release(); await release.promise; };
  const run = outcome(f.driver().tick(workId));
  try {
    await missionBounded(entered.promise); const before = await record(f, workId), input = command('retry-exact-pause', 'pause', (await f.driver().status(workId)).controlRevision);
    await assert.rejects(f.driver().control(workId, input), error => error === observedError); assert.equal(armed, false);
    assert.equal(pollSignal!.aborted, stage === 'published');
    if (stage === 'candidate_synced') assert.deepEqual((await record(f, workId)).state, before.state);
    const replay = await f.driver().control(workId, input); assert.equal(replay.replayed, stage === 'published');
    assert.equal(replay.current.status, 'paused'); assert.equal(replay.appliedControlRevision, input.expectedControlRevision + 1);
    assert.equal((await missionBounded(run)).kind, 'rejected'); await preserved(f, original); await preserved(f, before);
    const applied = await record(f, workId); assert.equal(applied.body.cursor, 0); assert.deepEqual(applied.body.pending, []);
    release.release(); await f.reopen();
    assert.equal((await f.driver().control(workId, input)).replayed, true); await preserved(f, applied);
    assert.equal(f.observed.inputs.first.length, 0);
  } finally { release.release(); repository.commit = commit; await writer.close(); await Promise.allSettled([run]); }
});
