import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as drain } from 'node:timers/promises';
import type { MissionEventSource, MissionPage } from '../application/mission-contracts.js';
import type { RuntimeServices } from '../application/services.js';
import type { SessionService } from '../application/session-service.js';
import type { UserCommand } from '../application/execution-runtime.js';
import type { WorkState } from '../domain/model.js';
import { executionControl } from '../domain/execution-policy.js';
import { asJson } from '../application/plan-validator.js';
import { bounded, event, gate, missionFixture, rule } from './mission-runtime-fixture.js';
import { initial } from './state-conformance-helpers.js';
import { RESIDENT_RULE, residentEntryFixture, residentEvent } from './resident-missions-entry-fixture.js';

type PollInput = Parameters<MissionEventSource['poll']>[0];
type Services = Pick<RuntimeServices, 'state' | 'artifacts' | 'digester'>;
function observe(pending: Promise<unknown>) {
  return pending.then(value => ({ kind: 'returned' as const, value }), error => ({ kind: 'rejected' as const, error: error as unknown }));
}
function stopped(result: Awaited<ReturnType<typeof observe>>, signal: AbortSignal) {
  assert.equal(result.kind, 'rejected'); assert.ok(result.kind === 'rejected');
  assert.ok(result.error instanceof Error); assert.equal(result.error.name, 'AbortError');
  assert.equal(signal.aborted, true); assert.equal(result.error, signal.reason);
}
function noncooperative(page: MissionPage, failure?: Error) {
  const entered = gate<PollInput>(), release = gate<void>(), finished = gate<void>(); let started = false, settled = false;
  const poll: MissionEventSource['poll'] = async input => {
    started = true; entered.resolve(input);
    try { await release.promise; if (failure) throw failure; return structuredClone(page); }
    finally { settled = true; finished.resolve(); }
  };
  return { entered, release, finished, poll, get started() { return started; }, get settled() { return settled; } };
}

/** Capture originals through real repositories; command and checkpoint receipts remain distinct. */
async function record(services: Services, sessions: SessionService, workId: string) {
  const state = await services.state.get(workId); assert.ok(state);
  const session = state.conversation?.session; assert.ok(session);
  const commandId = 'session-command:' + services.digester.digest(asJson([session.scope, session.input.messageId]));
  const ids = [...new Set(['conversation.accept', commandId, ...(state.subscriptions ?? []).map(value => value.checkpointId)])];
  const receipts = await Promise.all(ids.map(async id => ({ id, value: await services.state.receipt(workId, id) })));
  const originals = await Promise.all(state.artifacts.map(async artifact => ({ artifact, bytes: await services.artifacts.get(artifact, state.policy) })));
  return { state, receipts, originals, input: await sessions.repository.input(session.scope, session.input.messageId),
    events: await services.state.events(workId, 0), deliveries: await services.state.deliveries(workId) };
}
function control(kind: 'pause' | 'cancel' | 'goal' | 'input', state: WorkState): UserCommand {
  return kind === 'goal' ? { kind, goal: { ...state.goal, revision: state.goal.revision + 1, description: 'Review the newly specified original.' },
    expectedControlRevision: executionControl(state).revision } : { kind, reason: 'Explicit user control during an unfinished observation.' };
}

for (const kind of ['pause', 'cancel', 'goal', 'input'] as const) {
  test(`mission poll controls: durable ${kind} aborts before source settlement and discards its late ${kind === 'cancel' || kind === 'input' ? 'error' : 'page'}`, async t => {
    const f = await missionFixture(t), selected = rule(), sessions = f.bundle.sessions!;
    await f.missions.register(f.workId, selected);
    f.page('observations', { cursor: 1, snapshotDigest: 'original-page', events: [event()] });
    await f.missions.refresh(f.workId); const original = await f.checkpoint();
    assert.equal((await f.missions.tick(f.workId, f.bundle.workflow)).kind, 'ran');
    const before = await f.checkpoint();
    assert.equal(before.value.cursor, 1); assert.equal(before.value.seen.length, 1); assert.equal(before.value.pendingRun, false);
    assert.deepEqual(original.value.events, [event()]); assert.equal(f.planner.inputs.length + f.tool.invocations.length, 0);
    f.clock.advance(1000);
    const late = noncooperative({ cursor: 2, snapshotDigest: 'late-page', events: [event('late-event', 2100)] },
      kind === 'cancel' || kind === 'input' ? new Error('late_source_failure') : undefined);
    f.poll('observations', late.poll);
    const pending = observe(kind === 'pause' || kind === 'goal' ? f.missions.tick(f.workId, f.bundle.workflow) : f.missions.refresh(f.workId));
    try {
      const input = await bounded(late.entered.promise); assert.equal(input.cursor, 1); assert.equal(input.snapshotDigest, 'original-page');
      const state = await f.current(), session = state.conversation?.session; assert.ok(session);
      const applied = await sessions.command(f.actor, { sessionId: session.scope.sessionId, workId: state.id, messageId: 'control-' + kind,
        rawText: 'Apply ' + kind + ' to this work now.', expectedGoalRevision: state.goal.revision, command: control(kind, state) });
      assert.equal(applied.input.status, 'applied');
      const afterCommand = await record(f.bundle.services, sessions, f.workId);
      stopped(await bounded(pending), input.signal); assert.equal(late.settled, false);
      await assert.rejects(input.authorize(), error => error === input.signal.reason);
      assert.equal(afterCommand.state.subscriptions?.find(value => value.id === before.subscription.id)?.cursor, 1);
      assert.deepEqual(afterCommand.state.budget, before.work.budget);
      late.release.resolve(); await bounded(late.finished.promise); await drain();
      assert.deepEqual(await record(f.bundle.services, sessions, f.workId), afterCommand);
      assert.deepEqual(await f.state.receipt(f.workId, before.subscription.checkpointId), before.receipt);
      assert.deepEqual(await f.artifacts.get(before.artifact, before.work.policy), before.bytes);
      assert.deepEqual(await f.state.receipt(f.workId, original.subscription.checkpointId), original.receipt);
      assert.deepEqual(await f.artifacts.get(original.artifact, original.work.policy), original.bytes);
      assert.equal(f.sourceCalls.length, 2); assert.equal(f.planner.inputs.length + f.tool.invocations.length, 0);
    } finally { late.release.resolve(); await bounded(pending); if (late.started) await bounded(late.finished.promise); await drain(); }
  });
}

test('mission poll controls: rejected control leaves both polls live and a committed command interrupts only its own work', async t => {
  const f = await missionFixture(t), sessions = f.bundle.sessions!, template = initial(), otherRule = rule('observations', { id: 'other-rule', resourceId: 'other-resource' });
  const session = await sessions.open(f.actor, { channel: 'test', conversationId: 'other-mission-conversation' });
  const accepted = await sessions.accept(f.actor, { sessionId: session.scope.sessionId, rawText: 'Observe the separate original.', request: {
    messageId: 'other-mission-input', goal: template.goal, policy: template.policy, limits: template.budget.limits, completionRequiresDelivery: false,
    binding: { tenantId: f.actor.tenantId, principalId: f.actor.principalId, channel: 'test', conversationId: 'other-mission-conversation', recipientId: f.actor.principalId, destination: 'local' } } });
  assert.notEqual(accepted.workId, f.workId);
  await f.missions.register(f.workId, rule()); await f.missions.register(accepted.workId, otherRule);
  const left = noncooperative({ cursor: 1, snapshotDigest: 'late-left', events: [event('left')] });
  const rightPage = { cursor: 1, snapshotDigest: 'accepted-right', events: [event('right')] };
  const right = noncooperative(rightPage);
  f.poll('observations', input => input.resourceId === otherRule.resourceId ? right.poll(input) : left.poll(input));
  const a = observe(f.missions.refresh(f.workId)), b = observe(f.missions.refresh(accepted.workId));
  try {
    const [leftInput, rightInput] = await bounded(Promise.all([left.entered.promise, right.entered.promise]));
    const originalLeft = await record(f.bundle.services, sessions, f.workId), originalRight = await record(f.bundle.services, sessions, accepted.workId);
    const leftSession = originalLeft.state.conversation?.session; assert.ok(leftSession);
    await assert.rejects(sessions.command(f.actor, { sessionId: leftSession.scope.sessionId, workId: f.workId, messageId: 'stale-pause',
      rawText: 'Pause using an outdated goal basis.', expectedGoalRevision: originalLeft.state.goal.revision + 1, command: control('pause', originalLeft.state) }), /stale_user_command/);
    assert.equal((await sessions.repository.input(leftSession.scope, 'stale-pause'))?.status, 'rejected');
    assert.equal(leftInput.signal.aborted, false); assert.equal(rightInput.signal.aborted, false);
    assert.equal(left.settled || right.settled, false);
    assert.deepEqual(await record(f.bundle.services, sessions, f.workId), originalLeft);
    await sessions.command(f.actor, { sessionId: leftSession.scope.sessionId, workId: f.workId, messageId: 'valid-pause',
      rawText: 'Pause this work only.', expectedGoalRevision: originalLeft.state.goal.revision, command: control('pause', originalLeft.state) });
    const paused = await record(f.bundle.services, sessions, f.workId);
    stopped(await bounded(a), leftInput.signal); assert.equal(left.settled, false);
    assert.equal(rightInput.signal.aborted, false); assert.equal(right.settled, false);
    assert.deepEqual(await record(f.bundle.services, sessions, accepted.workId), originalRight);
    right.release.resolve(); const other = await bounded(b); assert.equal(other.kind, 'returned');
    assert.deepEqual(await f.missions.readEvents(accepted.workId, otherRule.id), { rule: otherRule, events: rightPage.events, cursor: 1, status: 'active', reason: null });
    const savedRight = await record(f.bundle.services, sessions, accepted.workId);
    left.release.resolve(); await bounded(left.finished.promise); await drain();
    assert.deepEqual(await record(f.bundle.services, sessions, f.workId), paused);
    assert.deepEqual(await record(f.bundle.services, sessions, accepted.workId), savedRight);
    assert.equal(rightInput.signal.aborted, false);
    assert.equal(f.sourceCalls.length, 2); assert.equal(f.planner.inputs.length + f.tool.invocations.length, 0);
  } finally {
    left.release.resolve(); right.release.resolve(); await bounded(Promise.all([a, b]));
    for (const source of [left, right]) if (source.started) await bounded(source.finished.promise);
    await drain();
  }
});

test('mission poll controls: the actual profile forwards public pause to its source and reopens the original cursor for explicit resume', { timeout: 120000 }, async t => {
  const f = await residentEntryFixture(t), p = f.current(), page = residentEvent('profile-event', 'PRESERVED_PROFILE_EVENT');
  f.pages.first.push([page]);
  const session = await p.sessions.open(p.actor, { channel: 'test', conversationId: 'resident-conversation' });
  const accepted = await p.turns.accept(p.actor, { sessionId: session.scope.sessionId, messageId: 'controlled-mission', rawText: 'Read the incoming event.',
    mode: 'auto', scope: p.scope, policy: p.policy, limits: p.limits, binding: f.binding('first') });
  assert.ok(p.missions); await p.missions.register(accepted.workId, RESIDENT_RULE);
  const original = await record(p.services, p.sessions, accepted.workId), entered = gate<AbortSignal>(), release = gate<void>(), finished = gate<void>();
  let settled = false;
  f.controls.beforePoll = async (role, signal) => { assert.equal(role, 'first'); entered.resolve(signal);
    try { await release.promise; } finally { settled = true; finished.resolve(); } };
  const pending = observe(p.missions.tick(accepted.workId, p.workflow));
  try {
    const signal = await bounded(entered.promise, 15000);
    await p.sessions.command(p.actor, { sessionId: session.scope.sessionId, workId: accepted.workId, messageId: 'pause-profile-work', rawText: 'Pause before observing the source.',
      expectedGoalRevision: original.state.goal.revision, command: control('pause', original.state) });
    const paused = await record(p.services, p.sessions, accepted.workId);
    stopped(await bounded(pending, 15000), signal); assert.equal(settled, false);
    assert.equal(paused.state.status, 'paused'); assert.equal(paused.state.subscriptions?.[0]?.cursor, 0);
    assert.deepEqual(paused.state.budget, original.state.budget);
    release.resolve(); await bounded(finished.promise); await drain();
    assert.deepEqual(await record(p.services, p.sessions, accepted.workId), paused);
    delete f.controls.beforePoll;
    await f.reopen(); const reopened = f.current(); assert.ok(reopened.missions);
    assert.deepEqual(await record(reopened.services, reopened.sessions, accepted.workId), paused);
    await reopened.sessions.command(reopened.actor, { sessionId: session.scope.sessionId, workId: accepted.workId, messageId: 'resume-profile-work', rawText: 'Resume observation explicitly.',
      expectedGoalRevision: paused.state.goal.revision, command: { kind: 'resume', reason: 'Explicit host resumption.' } });
    await reopened.missions.refresh(accepted.workId);
    assert.deepEqual(await reopened.missions.readEvents(accepted.workId, RESIDENT_RULE.id), { rule: RESIDENT_RULE, events: [page], cursor: 1, status: 'active', reason: null });
    const resumed = await reopened.runtime.state(accepted.workId);
    assert.deepEqual(resumed.budget, original.state.budget); assert.equal(resumed.conversation?.session?.scope.sessionId, session.scope.sessionId);
    for (const value of original.receipts) assert.deepEqual(await reopened.services.state.receipt(accepted.workId, value.id), value.value);
    for (const value of original.originals) assert.deepEqual(await reopened.services.artifacts.get(value.artifact, original.state.policy), value.bytes);
    assert.deepEqual(f.observed.polls, [{ role: 'first', cursor: 0 }, { role: 'first', cursor: 0 }]);
    assert.equal(f.observed.inputs.first.length + f.observed.inputs.second.length, 0); assert.equal(resumed.attempts.length, 0);
  } finally { release.resolve(); await bounded(pending, 15000); await drain(); delete f.controls.beforePoll; }
});

test('mission poll controls: completed observation unregisters and runtime close rejects a new poll before calling its source', async t => {
  const f = await missionFixture(t); await f.missions.register(f.workId, rule());
  await f.missions.refresh(f.workId); const completedSignal = f.sourceCalls[0]?.signal; assert.ok(completedSignal);
  const before = await record(f.bundle.services, f.bundle.sessions!, f.workId);
  assert.equal(completedSignal.aborted, false); f.clock.advance(1000); f.bundle.runtime.beginClose();
  assert.equal(completedSignal.aborted, false, 'the completed refresh no longer owns a runtime cancellation registration');
  const next = await bounded(observe(f.missions.refresh(f.workId)));
  assert.equal(next.kind, 'rejected'); assert.ok(next.kind === 'rejected');
  assert.ok(next.error instanceof Error); assert.equal(next.error.name, 'AbortError');
  await bounded(f.bundle.runtime.finishClose());
  assert.equal(f.sourceCalls.length, 1); assert.deepEqual(await record(f.bundle.services, f.bundle.sessions!, f.workId), before);
  assert.equal(f.planner.inputs.length + f.tool.invocations.length, 0);
});
