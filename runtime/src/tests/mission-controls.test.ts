import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { UserCommand } from '../application/execution-runtime.js';
import { bounded, event, missionFixture, rule } from './mission-runtime-fixture.js';
import { missionTerminalFixture } from './mission-terminal-recovery-fixture.js';

async function pendingFixture(t: TestContext, sources = ['observations']) {
  const f = await missionFixture(t, sources);
  await f.missions.register(f.workId, rule());
  f.page('observations', { cursor: 1, snapshotDigest: 'control-original', events: [event()] });
  await f.missions.refresh(f.workId);
  return f;
}
type Fixture = Awaited<ReturnType<typeof pendingFixture>>;
async function command(f: Fixture, id: string, kind: 'pause' | 'resume' | 'cancel' | 'goal') {
  const state = await f.current();
  const input: UserCommand = kind === 'goal' ? { kind, goal: { ...state.goal, revision: state.goal.revision + 1 },
    expectedControlRevision: state.executionControl!.revision } : { kind, reason: id };
  return f.bundle.runtime.command(f.workId, id, f.actor, state.goal.revision, input);
}
async function controlOnStep(f: Fixture, kind: 'pause' | 'cancel' | 'goal') {
  const workflow = f.bundle.workflow, run = workflow.run;
  let steps = 0, returned = false;
  let atCommand: Awaited<ReturnType<Fixture['current']>> | undefined;
  workflow.run = async (workId, actor, options = {}) => {
    const result = await run.call(workflow, workId, actor, { ...options, onStep: async () => {
      steps++; assert.equal(steps, 1, 'the old mission must not enter a second workflow step');
      assert.ok((await f.checkpoint()).value.claim, 'a real claimed checkpoint precedes the command');
      atCommand = await command(f, `step-${kind}`, kind);
      await options.onStep?.();
    } });
    returned = true; return result;
  };
  try {
    const result = await bounded(f.missions.tick(f.workId, workflow, { maxSteps: 8 }), 30000);
    assert.equal(result.kind, 'idle'); assert.equal('result' in result, false, 'an interrupted run has no fabricated workflow result');
  } finally { workflow.run = run; }
  assert.equal(steps, 1); assert.equal(returned, false); assert.ok(atCommand);
  const after = await f.current();
  assert.deepEqual(after.attempts, atCommand.attempts); assert.deepEqual(after.modelCalls, atCommand.modelCalls);
  assert.deepEqual(after.budget, atCommand.budget); assert.deepEqual(after.evidence, atCommand.evidence);
  assert.equal(f.tool.invocations.length + f.planner.inputs.length, 0);
  return { after, atCommand, commandReceipt: await f.state.receipt(f.workId, `step-${kind}`) };
}

test('mission control pause releases the actual workflow claim and retains the event until explicit resume', { timeout: 60000 }, async t => {
  const f = await pendingFixture(t), original = await f.checkpoint();
  await controlOnStep(f, 'pause'); const paused = await f.checkpoint();
  assert.equal(paused.work.status, 'paused'); assert.equal(paused.value.status, 'active'); assert.equal(paused.value.claim, null);
  assert.equal(paused.value.pendingRun, true); assert.deepEqual(paused.value.events, original.value.events);
  assert.deepEqual(paused.value.seen, original.value.seen); assert.equal(paused.value.cursor, original.value.cursor);
  assert.equal(paused.value.noProgress, original.value.noProgress); assert.equal(paused.value.resumes, 1);
  assert.equal(paused.work.notifications?.length, 1); const polls = f.sourceCalls.length;
  await f.reopen(); assert.equal((await f.missions.tick(f.workId, f.bundle.workflow)).kind, 'idle');
  assert.deepEqual(await f.current(), paused.work); assert.equal(f.sourceCalls.length, polls);
  await command(f, 'explicit-resume', 'resume'); await f.prepareRead();
  assert.equal((await f.missions.tick(f.workId, f.bundle.workflow, { maxSteps: 16 })).kind, 'ran');
  assert.equal(f.tool.invocations.length, 1); assert.equal(f.planner.inputs.length, 0);
  assert.equal((await f.checkpoint()).value.claim, null); assert.equal(f.sourceCalls.length, polls);
  assert.deepEqual(await f.artifacts.get(original.artifact, original.work.policy), original.bytes);
  assert.deepEqual(await f.state.receipt(f.workId, original.subscription.checkpointId), original.receipt);
});

for (const kind of ['cancel', 'goal'] as const) test(`mission control ${kind} stops the old workflow and closes its original checkpoint without another call`, { timeout: 60000 }, async t => {
  const f = await pendingFixture(t, ['observations', 'new-rule']), original = await f.checkpoint();
  const observed = await controlOnStep(f, kind), closed = await f.checkpoint();
  assert.equal(closed.value.status, 'closed'); assert.equal(closed.value.reason, kind === 'goal' ? 'goal_changed' : 'cancelled');
  assert.equal(closed.value.claim, null); assert.equal(closed.value.pendingRun, false);
  assert.equal(closed.value.goalRevision, 1); assert.equal(closed.subscription.goalRevision, 1);
  assert.deepEqual(closed.value.events, original.value.events); assert.deepEqual(closed.value.seen, original.value.seen);
  assert.equal(closed.value.cursor, original.value.cursor); assert.deepEqual(closed.work.notifications, []);
  assert.equal(closed.work.obligations.find(value => value.id === 'mission-wait')?.status, 'satisfied');
  const polls = f.sourceCalls.length; await f.reopen();
  assert.equal((await f.missions.tick(f.workId, f.bundle.workflow)).kind, 'idle');
  assert.deepEqual(await f.current(), closed.work); assert.equal(f.sourceCalls.length, polls);
  assert.deepEqual(await f.state.receipt(f.workId, `step-${kind}`), observed.commandReceipt);
  assert.deepEqual(await f.artifacts.get(original.artifact, original.work.policy), original.bytes);
  assert.deepEqual(await f.state.receipt(f.workId, original.subscription.checkpointId), original.receipt);
  if (kind === 'goal') {
    await assert.rejects(f.missions.readEvents(f.workId, rule().id), /mission_state_changed/);
    await f.missions.register(f.workId, rule('new-rule'));
    const fresh = await f.checkpoint(rule('new-rule'));
    assert.equal(fresh.value.goalRevision, 2); assert.equal(fresh.value.cursor, 0); assert.deepEqual(fresh.value.events, []);
    assert.deepEqual((await f.missions.readEvents(f.workId, 'new-rule')).events, []);
  }
  assert.equal(f.tool.invocations.length + f.planner.inputs.length, 0);
});

test('mission control idle pause and resume before a goal change closes the old wait while preserving host-closed heads', { timeout: 60000 }, async t => {
  const f = await missionFixture(t, ['observations', 'host-closed', 'new-rule']);
  await f.missions.register(f.workId, rule());
  await f.missions.register(f.workId, rule('host-closed')); await f.missions.close(f.workId, 'host-closed');
  const idle = await f.checkpoint(), hostClosed = await f.checkpoint(rule('host-closed'));
  assert.equal(idle.work.obligations.find(value => value.id === 'mission-wait')?.status, 'pending');
  await command(f, 'idle-pause-one', 'pause'); await f.missions.refresh(f.workId);
  await command(f, 'idle-resume-one', 'resume'); await command(f, 'idle-pause-two', 'pause');
  await f.missions.refresh(f.workId); await command(f, 'idle-resume-two', 'resume');
  await command(f, 'idle-new-goal', 'goal'); await f.reopen();
  assert.equal((await f.missions.tick(f.workId, f.bundle.workflow)).kind, 'idle');
  const closed = await f.checkpoint(), preserved = await f.checkpoint(rule('host-closed'));
  assert.equal(closed.value.status, 'closed'); assert.equal(closed.value.reason, 'goal_changed');
  assert.equal(closed.value.claim, null); assert.deepEqual(closed.value.events, []);
  assert.equal(closed.work.obligations.find(value => value.id === 'mission-wait')?.status, 'satisfied');
  assert.deepEqual(preserved.subscription, hostClosed.subscription); assert.deepEqual(preserved.bytes, hostClosed.bytes);
  assert.deepEqual(preserved.receipt, hostClosed.receipt);
  assert.deepEqual(await f.artifacts.get(idle.artifact, idle.work.policy), idle.bytes);
  assert.deepEqual(await f.state.receipt(f.workId, idle.subscription.checkpointId), idle.receipt);
  await f.missions.register(f.workId, rule('new-rule'));
  assert.equal((await f.checkpoint(rule('new-rule'))).value.goalRevision, 2);
  assert.equal(f.sourceCalls.length + f.tool.invocations.length + f.planner.inputs.length, 0);
});

test('mission control pause preserves exact native read acknowledgments and pages for both rules across reopen', { timeout: 120000 }, async t => {
  const h = await missionTerminalFixture(t), p = h.current(), run = p.workflow.run;
  const before = await h.checkpoints(); let steps = 0;
  let atCommand: Awaited<ReturnType<typeof p.runtime.state>> | undefined;
  p.workflow.run = async (workId, actor, options = {}) => run.call(p.workflow, workId, actor, { ...options, onStep: async () => {
    steps++; assert.equal(steps, 1); const current = await p.runtime.state(workId);
    atCommand = await p.runtime.command(workId, 'pause-after-native-reads', p.actor, current.goal.revision, { kind: 'pause', reason: 'Keep both original pages.' });
    await options.onStep?.();
  } });
  try { assert.equal((await p.missions!.tick(h.workId, p.workflow, { maxSteps: 8 })).kind, 'idle'); }
  finally { p.workflow.run = run; }
  assert.equal(steps, 1); assert.ok(atCommand);
  const paused = await h.checkpoints(), state = await p.runtime.state(h.workId);
  assert.equal(state.status, 'paused'); assert.deepEqual(state.attempts, atCommand.attempts);
  assert.deepEqual(state.modelCalls, atCommand.modelCalls); assert.deepEqual(state.budget, atCommand.budget);
  for (const [index, item] of paused.entries()) {
    assert.equal(item.value.status, 'active'); assert.equal(item.value.claim, null); assert.equal(item.value.pendingRun, true);
    assert.deepEqual(item.value.events, before[index]!.value.events);
    assert.deepEqual(item.value.acknowledgedRead, before[index]!.value.acknowledgedRead);
  }
  const polls = structuredClone(h.f.observed.polls), inputs = structuredClone(h.f.observed.inputs);
  await h.f.reopen(); assert.equal((await h.current().missions!.tick(h.workId, h.current().workflow)).kind, 'idle');
  assert.deepEqual(await h.current().runtime.state(h.workId), state);
  assert.deepEqual(h.f.observed.polls, polls); assert.deepEqual(h.f.observed.inputs, inputs);
  for (const [index, item] of (await h.checkpoints()).entries()) {
    assert.deepEqual(item.bytes, paused[index]!.bytes); assert.deepEqual(item.receipt, paused[index]!.receipt);
  }
});

test('mission control cleanup rejects altered command receipts and current authority without changing original records', { timeout: 60000 }, async t => {
  const f = await pendingFixture(t), original = await f.checkpoint();
  const cancelled = await command(f, 'verified-cancel', 'cancel');
  const events = await f.state.events(f.workId, 0), readReceipt = f.state.receipt.bind(f.state);
  const receipt = await readReceipt(f.workId, 'verified-cancel'); assert.ok(receipt);
  let altered = 0;
  f.state.receipt = async (workId, commandId) => {
    const observed = await readReceipt(workId, commandId);
    if (commandId === 'verified-cancel' && observed) { altered++; return { ...observed, digest: '0'.repeat(64) }; }
    return observed;
  };
  try { await assert.rejects(f.missions.tick(f.workId, f.bundle.workflow), /mission_state_changed/); }
  finally { f.state.receipt = readReceipt; }
  assert.ok(altered > 0); assert.deepEqual(await f.current(), cancelled);
  assert.deepEqual(await f.state.events(f.workId, 0), events); assert.deepEqual(await readReceipt(f.workId, 'verified-cancel'), receipt);
  // A read-only state observation simulates authority loss; no forged control is committed to the repository.
  const get = f.state.get.bind(f.state); let changed = 0;
  f.state.get = async workId => {
    const state = await get(workId);
    if (state && workId === f.workId) { changed++; return { ...state, policy: { ...state.policy, principalId: 'foreign-owner' } }; }
    return state;
  };
  try { await assert.rejects(f.missions.tick(f.workId, f.bundle.workflow), /mission_access_denied|execution_authority_denied/); }
  finally { f.state.get = get; }
  assert.ok(changed > 0); assert.deepEqual(await f.current(), cancelled); assert.deepEqual(await f.state.events(f.workId, 0), events);
  await f.reopen(); assert.equal((await f.missions.tick(f.workId, f.bundle.workflow)).kind, 'idle');
  assert.equal((await f.checkpoint()).value.reason, 'cancelled');
  assert.deepEqual(await f.artifacts.get(original.artifact, original.work.policy), original.bytes);
  assert.deepEqual(await f.state.receipt(f.workId, original.subscription.checkpointId), original.receipt);
  assert.equal(f.sourceCalls.length, 1); assert.equal(f.tool.invocations.length + f.planner.inputs.length, 0);
});
