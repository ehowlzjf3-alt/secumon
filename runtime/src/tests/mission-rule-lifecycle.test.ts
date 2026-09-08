import test from 'node:test';
import assert from 'node:assert/strict';
import { MissionRuntime } from '../application/mission-runtime.js';
import type { ExternalSubscription } from '../domain/external-events.js';
import { event, missionFixture, rule } from './mission-runtime-fixture.js';

type Fixture = Awaited<ReturnType<typeof missionFixture>>;

async function nextGoal(f: Fixture, commandId: string) {
  const state = await f.current();
  return f.bundle.runtime.command(f.workId, commandId, f.actor, state.goal.revision, {
    kind: 'goal', goal: { ...state.goal, revision: state.goal.revision + 1 },
    expectedControlRevision: state.executionControl!.revision,
  });
}

async function history(f: Fixture) {
  const state = await f.current(), events = await f.state.events(f.workId, 0);
  const receipts = await Promise.all(events.map(async value => {
    const receipt = await f.state.receipt(f.workId, value.commandId); assert.ok(receipt);
    return { commandId: value.commandId, receipt };
  }));
  const checkpoints = await Promise.all(events.filter(value => value.type === 'mission_checkpoint').map(async value => {
    const receipt = await f.state.receipt(f.workId, value.commandId); assert.ok(receipt);
    const artifact = receipt.state.artifacts.find(ref => value.commandId === `mission:${ref.sha256}`); assert.ok(artifact);
    return { commandId: value.commandId, receipt, artifact, bytes: await f.artifacts.get(artifact, receipt.state.policy) };
  }));
  return { state, events, receipts, checkpoints };
}

async function assertHistoryPreserved(f: Fixture, original: Awaited<ReturnType<typeof history>>) {
  const current = await f.current(), events = await f.state.events(f.workId, 0);
  assert.deepEqual(events.slice(0, original.events.length), original.events);
  for (const publication of original.receipts) assert.deepEqual(await f.state.receipt(f.workId, publication.commandId), publication.receipt);
  for (const checkpoint of original.checkpoints) {
    assert.deepEqual(await f.state.receipt(f.workId, checkpoint.commandId), checkpoint.receipt);
    assert.deepEqual(current.artifacts.find(value => value.id === checkpoint.artifact.id), checkpoint.artifact);
    assert.deepEqual(await f.artifacts.get(checkpoint.artifact, checkpoint.receipt.state.policy), checkpoint.bytes);
  }
}

for (const stateBackend of ['sqlite', 'file-journal'] as const) {
  test(`mission rule lifecycle: the same ID starts a fresh goal directly after its real goal command (${stateBackend})`, { timeout: 60000 }, async t => {
    const f = await missionFixture(t, ['observations'], { stateBackend }), selected = rule();
    await f.missions.register(f.workId, selected);
    f.page('observations', { cursor: 3, snapshotDigest: 'old-goal-original', events: [event()] });
    await f.missions.refresh(f.workId);
    const old = await f.checkpoint(), original = await history(f), polls = f.sourceCalls.length;
    assert.equal(old.value.events.length, 1); assert.equal(old.value.pendingRun, true);
    await nextGoal(f, 'reuse-rule-in-next-goal');
    await assert.rejects(f.missions.readEvents(f.workId, selected.id), /mission_state_changed/);

    // The real goal command closed the old projection; registration does not require publishing an old-goal body.
    const replacement = { ...selected, resourceId: 'new-goal-resource', maxResumes: 2 };
    await f.missions.register(f.workId, replacement);
    const fresh = await f.checkpoint(replacement);
    assert.equal(fresh.subscription.id, old.subscription.id);
    assert.notEqual(fresh.subscription.checkpointId, old.subscription.checkpointId);
    assert.equal(fresh.value.goalRevision, 2); assert.equal(fresh.value.generation, old.value.generation);
    assert.equal(fresh.value.cursor, 0); assert.equal(fresh.value.snapshotDigest, null);
    assert.deepEqual(fresh.value.events, []); assert.deepEqual(fresh.value.seen, []);
    assert.equal(fresh.value.pendingRun, false); assert.equal(fresh.value.claim, null);
    assert.equal(fresh.value.resumes, 0); assert.equal(fresh.value.noProgress, 0); assert.equal(fresh.value.idlePolls, 0);
    assert.equal(Object.hasOwn(JSON.parse(new TextDecoder().decode(fresh.bytes)), 'acknowledgedRead'), false);
    assert.equal(fresh.value.status, 'active'); assert.equal(fresh.value.reason, null);
    assert.equal(fresh.work.subscriptions?.length, 1); assert.deepEqual(fresh.work.notifications, []);
    assert.equal(fresh.work.obligations.find(value => value.id === 'mission-wait')?.status, 'pending');
    assert.equal(f.sourceCalls.length, polls); assert.equal(f.tool.invocations.length + f.planner.inputs.length, 0);
    assert.deepEqual(fresh.work.budget, original.state.budget); assert.deepEqual(fresh.work.attempts, original.state.attempts);
    assert.equal(await f.missions.current(fresh.work), true);
    await assertHistoryPreserved(f, original);
    await f.reopen();
    assert.deepEqual((await f.checkpoint(replacement)).bytes, fresh.bytes);
    assert.deepEqual(await f.missions.readEvents(f.workId, selected.id), { rule: replacement, events: [], cursor: 0, status: 'active', reason: null });
    assert.deepEqual(await f.missions.register(f.workId, replacement), fresh.work);
    await assertHistoryPreserved(f, original);
  });
}

test('mission rule lifecycle: current-goal retries preserve host closure and reject definition or generation changes', { timeout: 60000 }, async t => {
  const f = await missionFixture(t, ['observations'], { stateBackend: 'file-journal' }), selected = rule();
  const task = await f.prepareRead(), attempt = await f.bundle.runtime.reserve(f.workId, task);
  await f.bundle.runtime.execute(f.workId, attempt.id); await f.bundle.runtime.adopt(f.workId, attempt.id);
  const registered = await f.missions.register(f.workId, selected), original = await history(f);
  assert.deepEqual(await f.missions.register(f.workId, selected), registered);
  await assert.rejects(f.missions.register(f.workId, { ...selected, resourceId: 'conflicting-current-resource' }), /mission_idempotency_conflict/);
  assert.deepEqual(await f.current(), registered);
  const closed = await f.missions.close(f.workId, selected.id), closedHead = await f.checkpoint();
  assert.equal(closedHead.value.reason, 'host_closed');
  assert.deepEqual(await f.missions.register(f.workId, selected), closed);
  await assert.rejects(f.missions.register(f.workId, { ...selected, maxResumes: 2 }), /mission_idempotency_conflict/);
  assert.deepEqual(await f.current(), closed);
  await f.reopen();
  assert.deepEqual(await f.missions.register(f.workId, selected), closed);
  assert.deepEqual((await f.checkpoint()).bytes, closedHead.bytes);

  await f.bundle.dataLifecycle.change(f.workId, { ...f.actor, allowWrites: true }, 'same-goal-original-restricted', {
    action: 'restrict', evidenceIds: ['independent'], expectedGeneration: 0, reason: 'Explicit current-goal original restriction', replacement: null,
  });
  const restricted = await f.current(), restrictedEvents = await f.state.events(f.workId, 0);
  assert.equal(restricted.goal.revision, registered.goal.revision); assert.equal(restricted.dataLifecycle?.generation, 1);
  assert.equal(restricted.status, 'blocked'); assert.equal(restricted.statusReason, 'data_access_changed');
  await assert.rejects(f.missions.register(f.workId, selected), /mission_work_closed/);
  assert.deepEqual(await f.current(), restricted); assert.deepEqual(await f.state.events(f.workId, 0), restrictedEvents);
  await f.bundle.runtime.command(f.workId, 'resume-after-restriction', f.actor, restricted.goal.revision, { kind: 'resume', reason: 'Explicitly review after restriction' });
  const resumed = await f.current(), resumedEvents = await f.state.events(f.workId, 0);
  assert.equal(resumed.status, 'ready'); assert.equal(resumed.dataLifecycle?.generation, 1);
  await assert.rejects(f.missions.register(f.workId, selected), /mission_state_changed|mission_checkpoint_unavailable/);
  assert.deepEqual(await f.current(), resumed); assert.deepEqual(await f.state.events(f.workId, 0), resumedEvents);
  assert.deepEqual(await f.state.receipt(f.workId, closedHead.subscription.checkpointId), closedHead.receipt);
  assert.deepEqual(await f.artifacts.get(closedHead.artifact, closed.policy), closedHead.bytes);
  await assertHistoryPreserved(f, original);
  assert.equal(f.sourceCalls.length, 0); assert.equal(f.planner.inputs.length, 0); assert.equal(f.tool.invocations.length, 1);
});

test('mission rule lifecycle: more than sixteen historical IDs retain their originals without consuming the new goal slots', { timeout: 60000 }, async t => {
  const f = await missionFixture(t), first = Array.from({ length: 8 }, (_, index) => rule(`old-${index}`, { sourceId: 'observations' }));
  const second = Array.from({ length: 9 }, (_, index) => rule(`new-${index}`, { sourceId: 'observations' }));
  for (const selected of first) await f.missions.register(f.workId, selected);
  const old = await history(f); assert.equal(old.state.subscriptions?.length, 8);
  const goalState = await nextGoal(f, 'replace-eight-historical-rules');
  const goalReceipt = await f.state.receipt(f.workId, 'replace-eight-historical-rules'); assert.ok(goalReceipt);
  assert.deepEqual(goalReceipt.state, goalState);
  assert.deepEqual(goalReceipt.state.subscriptions, old.state.subscriptions!.map(value => ({ ...value, status: 'closed' })));
  for (const selected of second) await f.missions.register(f.workId, selected);
  const current = await f.current(), all = await history(f);
  assert.equal(new Set([...first, ...second].map(value => value.id)).size, 17);
  assert.equal(current.subscriptions?.length, 9);
  assert.ok(current.subscriptions?.every(value => value.provider === 'mission' && value.status === 'active' && value.goalRevision === 2));
  assert.deepEqual((await f.missions.list(f.workId)).map(value => value.rule), second);
  // The eight original heads and nine new heads remain; the goal receipt records the old closed slots.
  assert.equal(all.checkpoints.length, 17);
  assert.deepEqual(await f.state.receipt(f.workId, 'replace-eight-historical-rules'), goalReceipt);
  await assertHistoryPreserved(f, old);
  await f.reopen();
  assert.deepEqual(await f.current(), current); assert.equal(await f.missions.current(current), true);
  for (const selected of second) assert.deepEqual(await f.missions.register(f.workId, selected), current);
  await assertHistoryPreserved(f, all);
  assert.equal(f.sourceCalls.length + f.tool.invocations.length + f.planner.inputs.length, 0);
});

test('mission rule lifecycle: a new goal can register after its historical source is removed', { timeout: 60000 }, async t => {
  const f = await missionFixture(t, ['old-source', 'new-source']);
  const selected = rule('old-rule', { sourceId: 'old-source' });
  await f.missions.register(f.workId, selected);
  f.page('old-source', { cursor: 1, snapshotDigest: 'removed-source-original', events: [event()] });
  await f.missions.refresh(f.workId);
  const old = await f.checkpoint(selected);
  await nextGoal(f, 'replace-removed-source');
  const original = await history(f), calls = f.sourceCalls.length;
  const source = f.sources.find(value => value.id === 'new-source'); assert.ok(source);
  const replacement = new MissionRuntime({ services: f.bundle.services, actor: f.actor, agentId: 'mission-agent',
    scope: original.state.goal.scope, signal: f.lifetime.signal, sources: [source] });
  assert.deepEqual(replacement.sources.map(value => value.id), ['new-source']);
  const freshRule = rule('new-rule', { sourceId: 'new-source' });
  await replacement.register(f.workId, freshRule);
  const fresh = await f.checkpoint(freshRule);
  assert.equal(fresh.work.subscriptions?.length, 1); assert.equal(fresh.value.goalRevision, 2);
  assert.equal(fresh.value.cursor, 0); assert.deepEqual(fresh.value.events, []);
  assert.deepEqual(await replacement.readEvents(f.workId, freshRule.id), { rule: freshRule, events: [], cursor: 0, status: 'active', reason: null });
  assert.equal(await replacement.current(fresh.work), true);
  assert.equal(f.sourceCalls.length, calls);
  assert.equal(f.sourceCalls.filter(value => value.sourceId === 'old-source').length, 1);
  assert.equal(f.sourceCalls.filter(value => value.sourceId === 'new-source').length, 0);
  assert.deepEqual(await f.artifacts.get(old.artifact, old.work.policy), old.bytes);
  await assertHistoryPreserved(f, original);
  assert.equal(f.tool.invocations.length + f.planner.inputs.length, 0);
});

test('mission rule lifecycle: current-goal capacity remains sixteen and foreign closed subscriptions are not pruned', { timeout: 60000 }, async t => {
  const f = await missionFixture(t);
  for (let index = 0; index < 16; index++) await f.missions.register(f.workId, rule(`current-${index}`, { sourceId: 'observations' }));
  const full = await history(f);
  await assert.rejects(f.missions.register(f.workId, rule('current-overflow', { sourceId: 'observations' })), /subscription_capacity/);
  assert.deepEqual(await f.current(), full.state); assert.deepEqual(await f.state.events(f.workId, 0), full.events);
  await assertHistoryPreserved(f, full);

  const other = await missionFixture(t, ['observations'], { stateBackend: 'file-journal' });
  const foreign: ExternalSubscription = { id: 'other-provider-closed', provider: 'other-provider', resourceId: 'other-resource',
    goalRevision: 1, generation: 0, cursor: 7, status: 'closed', checkpointId: 'other-checkpoint-preserved' };
  // Seed only another provider's registered projection; mission publications below use the real API.
  await other.edit(state => { state.subscriptions = [foreign]; });
  await other.missions.register(other.workId, rule('old-mission', { sourceId: 'observations' }));
  const original = await history(other);
  await nextGoal(other, 'keep-other-provider-history');
  await other.missions.register(other.workId, rule('new-mission', { sourceId: 'observations' }));
  const current = await other.current();
  assert.equal(current.subscriptions?.length, 2);
  assert.deepEqual(current.subscriptions?.find(value => value.provider === foreign.provider), foreign);
  assert.ok(current.subscriptions?.some(value => value.provider === 'mission' && value.goalRevision === 2 && value.status === 'active'));
  await assertHistoryPreserved(other, original);
  await other.reopen(); assert.deepEqual(await other.current(), current);
  assert.deepEqual((await other.missions.list(other.workId)).map(value => value.rule.id), ['new-mission']);
  assert.equal(f.sourceCalls.length + other.sourceCalls.length + f.planner.inputs.length + other.planner.inputs.length +
    f.tool.invocations.length + other.tool.invocations.length, 0);
});
