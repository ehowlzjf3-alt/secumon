import test from 'node:test';
import assert from 'node:assert/strict';
import { MissionRuntime } from '../application/mission-runtime.js';
import { bounded, event, gate, missionFixture, rule } from './mission-runtime-fixture.js';

test('mission registration is durable and requires the original checkpoint receipt and bytes after reopen', async t => {
  const f = await missionFixture(t), selected = rule();
  const registered = await f.missions.register(f.workId, selected), original = await f.checkpoint();
  assert.equal((await f.missions.register(f.workId, selected)).revision, registered.revision);
  await assert.rejects(f.missions.register(f.workId, rule('observations', { maxResumes: 2 })), /mission_idempotency_conflict/);
  await f.reopen();
  assert.deepEqual(await f.missions.readEvents(f.workId, selected.id), { rule: selected, events: [], cursor: 0, status: 'active', reason: null });
  assert.deepEqual((await f.checkpoint()).receipt, original.receipt);
  assert.equal(await f.missions.current(await f.current()), true);
  const receipt = f.state.receipt.bind(f.state);
  f.state.receipt = (workId, commandId) => commandId === original.subscription.checkpointId ? Promise.resolve(null) : receipt(workId, commandId);
  try {
    assert.equal(await f.missions.current(await f.current()), false);
    await assert.rejects(f.missions.readEvents(f.workId, selected.id), /mission_state_changed/);
  } finally { f.state.receipt = receipt; }
  const get = f.artifacts.get.bind(f.artifacts);
  f.artifacts.get = async (ref, policy) => { const bytes = await get(ref, policy); if (ref.id === original.artifact.id) { const altered = new Uint8Array(bytes); altered[0] = altered[0]! ^ 1; return altered; } return bytes; };
  try {
    assert.equal(await f.missions.current(await f.current()), false);
    await assert.rejects(f.missions.readEvents(f.workId, selected.id), /mission_state_changed/);
  } finally { f.artifacts.get = get; }
  assert.deepEqual((await f.checkpoint()).bytes, original.bytes);
  assert.equal(f.planner.inputs.length + f.tool.invocations.length, 0);
});

test('empty mission polls respect the fake clock and finite drive without model or tool activity', async t => {
  const f = await missionFixture(t), selected = rule('observations', { maxIdlePolls: 3 });
  await f.missions.register(f.workId, selected);
  await f.missions.refresh(f.workId);
  const first = await f.checkpoint(selected);
  assert.equal(first.value.idlePolls, 1); assert.equal(first.value.nextPollAt, 2100);
  const driven = await bounded(f.missions.drive(f.workId, f.bundle.workflow, { signal: new AbortController().signal, maxTicks: 2, intervalMs: 100 }));
  assert.deepEqual(driven, { ticks: 2, ran: 0 }); assert.equal(f.sourceCalls.length, 1);
  assert.equal((await f.current()).revision, first.work.revision);
  f.clock.advance(1000); await f.missions.refresh(f.workId);
  f.clock.advance(1000); await f.missions.refresh(f.workId);
  const closed = await f.checkpoint(selected);
  assert.equal(closed.value.status, 'closed'); assert.equal(closed.value.reason, 'idle_limit');
  assert.equal(f.sourceCalls.length, 3); assert.deepEqual(closed.value.events, []);
  assert.equal(closed.work.budget.used.modelCalls + closed.work.budget.used.toolCalls, 0);
  assert.equal(f.planner.inputs.length + f.tool.invocations.length, 0);
  assert.deepEqual(closed.work.goal, first.work.goal); assert.deepEqual(closed.work.evidence, []);
});

test('a mission event wakes the actual workflow for an explicit original read without promoting the event body to evidence', async t => {
  const f = await missionFixture(t); await f.missions.register(f.workId, rule());
  f.page('observations', { cursor: 1, snapshotDigest: 'snapshot-one', events: [event()] });
  const notified = await f.missions.refresh(f.workId), original = await f.checkpoint();
  assert.deepEqual((await f.missions.readEvents(f.workId, rule().id)).events, [event()]);
  assert.equal(notified.notifications?.length, 1); assert.deepEqual(notified.evidence, []);
  assert.equal(notified.obligations.find(value => value.id === 'mission-wait')?.status, 'satisfied');
  // The host explicitly reviews the notification with a new plan; no synthetic model decision is substituted.
  await f.prepareRead();
  const outcome = await f.missions.tick(f.workId, f.bundle.workflow, { maxSteps: 16 });
  assert.equal(outcome.kind, 'ran'); assert.equal(f.tool.invocations.length, 1); assert.equal(f.planner.inputs.length, 0);
  const after = await f.checkpoint();
  assert.equal(after.work.budget.used.toolCalls, 1); assert.equal(after.work.budget.used.modelCalls, 0);
  assert.deepEqual(after.work.evidence.map(value => value.id), ['independent']);
  assert.equal(after.value.resumes, 1); assert.equal(after.value.noProgress, 0);
  assert.equal(after.value.pendingRun, false); assert.equal(after.value.claim, null);
  assert.deepEqual(after.value.events, []); assert.deepEqual(after.work.notifications, []);
  assert.equal((await f.missions.tick(f.workId, f.bundle.workflow)).kind, 'idle');
  assert.equal(f.sourceCalls.length, 1); assert.equal(f.tool.invocations.length, 1);
  assert.deepEqual(await f.artifacts.get(original.artifact, original.work.policy), original.bytes);
  assert.deepEqual(await f.state.receipt(f.workId, original.subscription.checkpointId), original.receipt);
});

test('source failure preserves the cursor and original events, exact redelivery is deduplicated, and changed event bytes conflict', async t => {
  const f = await missionFixture(t); await f.missions.register(f.workId, rule());
  f.page('observations', { cursor: 1, snapshotDigest: 'snapshot-one', events: [event()] });
  await f.missions.refresh(f.workId); const original = await f.checkpoint();
  assert.equal((await f.missions.tick(f.workId, f.bundle.workflow)).kind, 'ran');
  f.clock.advance(1000); const failure = new Error('synthetic_source_failure');
  f.poll('observations', async () => { throw failure; });
  await assert.rejects(f.missions.refresh(f.workId), error => error === failure);
  const failed = await f.checkpoint();
  assert.equal(failed.value.cursor, 1); assert.equal(failed.value.snapshotDigest, 'snapshot-one');
  assert.equal(failed.value.reason, 'source_poll_failed'); assert.deepEqual(failed.value.seen, original.value.seen);
  f.clock.advance(1000); f.page('observations', { cursor: 2, snapshotDigest: 'snapshot-two', events: [event()] });
  await f.missions.refresh(f.workId); const duplicate = await f.checkpoint();
  assert.equal(duplicate.value.cursor, 2); assert.equal(duplicate.value.pendingRun, false);
  assert.deepEqual(duplicate.value.seen, original.value.seen); assert.deepEqual(duplicate.work.notifications, []);
  assert.equal((await f.missions.tick(f.workId, f.bundle.workflow)).kind, 'idle');
  f.clock.advance(1000); f.page('observations', { cursor: 3, snapshotDigest: 'snapshot-three', events: [{ ...event(), body: { changed: true } }] });
  await assert.rejects(f.missions.refresh(f.workId), /mission_event_identity_conflict/);
  assert.deepEqual(await f.current(), duplicate.work);
  assert.deepEqual(await f.artifacts.get(original.artifact, original.work.policy), original.bytes);
  assert.equal(f.planner.inputs.length + f.tool.invocations.length, 0);
});

test('an empty second mission rule does not suppress another rule event or its actual workflow read', async t => {
  const f = await missionFixture(t, ['fresh', 'empty']), fresh = rule('fresh'), empty = rule('empty');
  await f.missions.register(f.workId, fresh); await f.missions.register(f.workId, empty);
  f.page('fresh', { cursor: 1, snapshotDigest: 'fresh-snapshot', events: [event()] });
  const notified = await f.missions.refresh(f.workId);
  assert.deepEqual(f.sourceCalls.map(value => value.sourceId), ['fresh', 'empty']);
  assert.equal(notified.notifications?.length, 1);
  assert.equal(notified.obligations.find(value => value.id === 'mission-wait')?.status, 'satisfied');
  assert.equal((await f.checkpoint(fresh)).value.pendingRun, true); assert.equal((await f.checkpoint(empty)).value.pendingRun, false);
  await f.prepareRead(); assert.equal((await f.missions.tick(f.workId, f.bundle.workflow, { maxSteps: 16 })).kind, 'ran');
  assert.equal(f.tool.invocations.length, 1); assert.equal(f.planner.inputs.length, 0);
  assert.deepEqual((await f.current()).evidence.map(value => value.id), ['independent']);
});

test('mission owner, narrowed source access and revoked host authority remain enforced across asynchronous reads', async t => {
  const f = await missionFixture(t);
  const foreign = new MissionRuntime({ services: f.bundle.services, actor: { ...f.actor, principalId: 'other-person' },
    agentId: 'mission-agent', scope: 'fixture', signal: f.lifetime.signal, sources: f.sources });
  await assert.rejects(foreign.register(f.workId, rule()), /mission_access_denied/);
  await f.missions.register(f.workId, rule()); const original = await f.checkpoint();
  const entered = gate<void>(), release = gate<void>();
  f.poll('observations', async () => { entered.resolve(); await release.promise; return { cursor: 1, snapshotDigest: 'late', events: [event()] }; });
  const pending = f.missions.refresh(f.workId); const rejected = assert.rejects(pending, /mission_source_unavailable/);
  try { await bounded(entered.promise); await f.edit(state => { state.policy.allowedLabels = []; }); }
  finally { release.resolve(); }
  await bounded(rejected);
  const narrowed = await f.current(); assert.equal(narrowed.subscriptions![0]!.cursor, 0); assert.deepEqual(narrowed.notifications, []);
  assert.deepEqual(await f.artifacts.get(original.artifact, original.work.policy), original.bytes);

  const h = await missionFixture(t); await h.missions.register(h.workId, rule()); const checkpoint = await h.checkpoint();
  const get = h.artifacts.get.bind(h.artifacts);
  h.artifacts.get = async (ref, policy) => { const bytes = await get(ref, policy); if (ref.id === checkpoint.artifact.id) h.host.abort(); return bytes; };
  try { await assert.rejects(h.missions.readEvents(h.workId, rule().id), /execution_authority_denied/); }
  finally { h.artifacts.get = get; }
  assert.equal(await h.missions.current(await h.current()), false);
  assert.equal(f.planner.inputs.length + h.planner.inputs.length + f.tool.invocations.length + h.tool.invocations.length, 0);
});

test('goal and data generation changes retire mission input while retaining its historical originals', async t => {
  for (const change of ['goal', 'generation'] as const) {
    const f = await missionFixture(t);
    const task = await f.prepareRead(), attempt = await f.bundle.runtime.reserve(f.workId, task);
    await f.bundle.runtime.execute(f.workId, attempt.id); await f.bundle.runtime.adopt(f.workId, attempt.id);
    await f.missions.register(f.workId, rule()); f.page('observations', { cursor: 1, snapshotDigest: 'original', events: [event()] });
    await f.missions.refresh(f.workId); const original = await f.checkpoint();
    if (change === 'goal') await f.bundle.runtime.command(f.workId, 'change-goal', f.actor, 1, {
      kind: 'goal', goal: { ...original.work.goal, revision: 2 }, expectedControlRevision: original.work.executionControl!.revision });
    else await f.bundle.dataLifecycle.change(f.workId, { ...f.actor, allowWrites: true }, 'restrict-original', {
      action: 'restrict', evidenceIds: ['independent'], expectedGeneration: 0, reason: 'Explicit original access change', replacement: null });
    const retired = await f.missions.refresh(f.workId);
    assert.equal(retired.subscriptions![0]!.status, 'closed'); assert.deepEqual(retired.notifications, []);
    assert.equal(f.sourceCalls.length, 1); assert.equal(f.tool.invocations.length, 1); assert.equal(f.planner.inputs.length, 0);
    await assert.rejects(f.missions.readEvents(f.workId, rule().id), /mission_state_changed|mission_checkpoint_unavailable/);
    assert.deepEqual(await f.artifacts.get(original.artifact, original.work.policy), original.bytes);
    assert.deepEqual(await f.state.receipt(f.workId, original.subscription.checkpointId), original.receipt);
    assert.equal(change === 'goal' ? retired.goal.revision : retired.dataLifecycle?.generation, change === 'goal' ? 2 : 1);
  }
});

test('a durable mission claim excludes a second driver and caller abort reaches an in-flight source poll', async t => {
  const f = await missionFixture(t); await f.missions.register(f.workId, rule());
  f.page('observations', { cursor: 1, snapshotDigest: 'claimed', events: [event()] }); await f.missions.refresh(f.workId);
  const entered = gate<void>(), release = gate<void>(), run = f.bundle.workflow.run.bind(f.bundle.workflow); let runs = 0;
  f.bundle.workflow.run = async (...args) => { runs++; entered.resolve(); await release.promise; return run(...args); };
  const pending = f.missions.tick(f.workId, f.bundle.workflow);
  try {
    await bounded(entered.promise); assert.ok((await f.checkpoint()).value.claim);
    assert.equal((await f.makeDriver().tick(f.workId, f.bundle.workflow)).kind, 'idle'); assert.equal(runs, 1);
  } finally { release.resolve(); f.bundle.workflow.run = run; }
  assert.equal((await bounded(pending)).kind, 'ran'); assert.equal((await f.checkpoint()).value.claim, null);
  assert.equal((await f.checkpoint()).value.resumes, 1);

  const h = await missionFixture(t); await h.missions.register(h.workId, rule());
  const polling = gate<void>(), unblock = gate<void>(), stop = new AbortController(), reason = new Error('caller_stopped_poll');
  h.poll('observations', async input => {
    const aborted = gate<void>(), abort = () => aborted.resolve(); input.signal.addEventListener('abort', abort, { once: true });
    try { polling.resolve(); if (input.signal.aborted) abort(); await Promise.race([unblock.promise, aborted.promise]); input.signal.throwIfAborted();
      return { cursor: input.cursor, snapshotDigest: input.snapshotDigest, events: [] }; }
    finally { input.signal.removeEventListener('abort', abort); }
  });
  // Attach both handlers immediately; cleanup releases the source even when the product fails to forward cancellation.
  const stopped = h.missions.tick(h.workId, h.bundle.workflow, { signal: stop.signal }).then(
    result => ({ kind: 'returned' as const, result }), error => ({ kind: 'rejected' as const, error }));
  try {
    await bounded(polling.promise); stop.abort(reason);
    const result = await bounded(stopped, 250); assert.equal(result.kind, 'rejected');
    if (result.kind === 'rejected') assert.equal(result.error, reason);
    assert.equal(h.sourceCalls[0]!.signal.aborted, true);
    assert.equal((await h.current()).subscriptions![0]!.cursor, 0); assert.deepEqual((await h.current()).notifications, []);
    assert.equal(h.planner.inputs.length + h.tool.invocations.length, 0);
  } finally { unblock.resolve(); await bounded(stopped); }
});

test('tick and drive cancel noncooperative polls without a late event or failure checkpoint', async t => {
  for (const entry of ['tick', 'drive'] as const) {
    const f = await missionFixture(t); await f.missions.register(f.workId, rule());
    const original = await f.checkpoint(), originalEvents = await f.state.events(f.workId, 0);
    const entered = gate<void>(), release = gate<void>(), finished = gate<void>(), stop = new AbortController();
    const reason = new Error(`stop_${entry}`), lateError = new Error('late_source_error');
    const authorize = gate<() => Promise<void>>();
    f.poll('observations', async input => {
      authorize.resolve(input.authorize); entered.resolve();
      try {
        await release.promise;
        if (entry === 'drive') throw lateError;
        return { cursor: 1, snapshotDigest: 'too-late', events: [event()] };
      } finally { finished.resolve(); }
    });
    const call = entry === 'tick' ? f.missions.tick(f.workId, f.bundle.workflow, { signal: stop.signal }) :
      f.missions.drive(f.workId, f.bundle.workflow, { signal: stop.signal, maxTicks: 2, intervalMs: 100 });
    const outcome = call.then(() => ({ kind: 'returned' as const }), error => ({ kind: 'rejected' as const, error }));
    try {
      await bounded(entered.promise); stop.abort(reason);
      const stopped = await bounded(outcome, 250); assert.equal(stopped.kind, 'rejected');
      if (stopped.kind === 'rejected') assert.equal(stopped.error, reason);
      assert.equal(f.sourceCalls[0]!.signal.aborted, true);
      await assert.rejects((await authorize.promise)(), error => error === reason);
      assert.deepEqual(await f.current(), original.work);
    } finally {
      release.resolve(); await bounded(finished.promise); await bounded(outcome);
      // Drain the late promise continuations, including rejection observation, before checking stored originals.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.deepEqual(await f.current(), original.work);
    assert.deepEqual(await f.state.events(f.workId, 0), originalEvents);
    assert.deepEqual((await f.checkpoint()).receipt, original.receipt);
    assert.deepEqual((await f.checkpoint()).bytes, original.bytes);
    assert.equal(f.sourceCalls.length, 1); assert.equal(f.planner.inputs.length + f.tool.invocations.length, 0);
  }
});
