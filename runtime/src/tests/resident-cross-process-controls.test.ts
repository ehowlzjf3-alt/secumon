import test from 'node:test';
import assert from 'node:assert/strict';
import type { HeldPoll, ResidentControl } from './helpers/resident-cross-process-fixture.js';
import { gate, within, residentProcessFixture, residentProcessRecord, preservedProcessRecord } from './helpers/resident-cross-process-fixture.js';

function observation(backend: string, phase: string, poll: HeldPoll, child: { startedAt: number; closedAt: number }, observedAt = performance.now()) {
  assert.ok(poll.abortedAt !== null);
  console.log(JSON.stringify({ kind: 'resident_cross_process_observation', backend, phase,
    childDurationMs: child.closedAt - child.startedAt, abortAfterChildCloseMs: poll.abortedAt - child.closedAt,
    observationCompletedAfterChildCloseMs: observedAt - child.closedAt, rawReleased: poll.released }));
}

for (const backend of ['sqlite', 'file-journal'] as const) {
  test(`resident cross-process ${backend}: actual CLI pause stops the parent and an old replay preserves its new poll`, { timeout: 180000 }, async t => {
    const f = await residentProcessFixture(t, backend), agent = await f.open('agent'), target = await agent.register('primary');
    const original = await residentProcessRecord(target), repository = target.profile.services.state;
    const hint = repository.revisionHint; assert.ok(hint);
    let hints = 0, replayReturned = false, afterReplay = 0;
    const checkedReplay = gate<void>();
    repository.revisionHint = async workId => {
      const value = await hint.call(repository, workId);
      if (workId === target.workId) { hints++; if (replayReturned && ++afterReplay >= 2) checkedReplay.resolve(); }
      return value;
    };
    const running: Promise<unknown>[] = [];
    try {
      await f.call(target, ['status']); await target.driver.status(target.workId);
      assert.equal(hints, 0, 'read/control entry points do not start an observation watcher');
      const first = agent.start(target); running.push(first.result); const old = await within(first.entered);
      const pause = ['pause', '--command-id', 'process-pause-original', '--control-revision', '0'];
      const paused = await f.call<ResidentControl>(target, pause);
      assert.equal(paused.value.current.status, 'paused'); assert.equal(paused.value.replayed, false);
      const firstResult = await within(first.result, 5000);
      assert.equal(firstResult.kind, 'rejected'); assert.equal(old.input.signal.aborted, true);
      assert.equal(old.released, false); assert.equal(old.settledAt, null);
      observation(backend, 'pause', old, paused.process);
      await preservedProcessRecord(target, original);
      const resumed = await f.call<ResidentControl>(target, ['resume', '--command-id', 'process-resume-new', '--control-revision', String(paused.value.current.controlRevision)]);
      assert.equal(resumed.value.current.status, 'active');
      const second = agent.start(target); running.push(second.result); const fresh = await within(second.entered);
      let newPollFinished = false; void second.result.then(() => { newPollFinished = true; });
      const beforeReplay = await residentProcessRecord(target), replay = await f.call<ResidentControl>(target, pause);
      assert.equal(replay.value.replayed, true); assert.equal(replay.value.appliedStateRevision, paused.value.appliedStateRevision);
      assert.equal(replay.value.current.status, 'active'); replayReturned = true;
      await within(checkedReplay.promise, 5000);
      assert.equal(fresh.input.signal.aborted, false); assert.equal(newPollFinished, false);
      assert.equal(fresh.released, false); assert.deepEqual(await residentProcessRecord(target), beforeReplay);
      const stopped = await f.call<ResidentControl>(target, ['stop', '--command-id', 'process-stop-final', '--control-revision', String(resumed.value.current.controlRevision)]);
      assert.equal(stopped.value.current.status, 'closed'); assert.equal((await within(second.result, 5000)).kind, 'rejected');
      observation(backend, 'stop', fresh, stopped.process);
      const final = await residentProcessRecord(target);
      const artifact = final.originals.find(value => final.state.subscriptions?.some(sub => sub.checkpointId === `resident:${value.artifact.sha256}`)); assert.ok(artifact);
      const checkpoint = JSON.parse(new TextDecoder().decode(artifact.bytes));
      assert.equal(checkpoint.cursor, 0); assert.deepEqual(checkpoint.pending, []); assert.deepEqual(checkpoint.seen, []); assert.equal(checkpoint.claim, null);
      assert.equal(agent.entry.observation.closes, 0, 'child profile cleanup does not close the parent source');
      await preservedProcessRecord(target, original);
    } finally {
      repository.revisionHint = hint;
      try { await within(target.driver.close()); }
      finally { for (const poll of agent.held) poll.release(); await within(Promise.allSettled(running)); }
    }
  });

  test(`resident cross-process ${backend}: pause and resume finish in children before the parent reads their durable change`, { timeout: 180000 }, async t => {
    const f = await residentProcessFixture(t, backend), agent = await f.open('agent'), target = await agent.register('fast-controls');
    const original = await residentProcessRecord(target), repository = target.profile.services.state;
    const hint = repository.revisionHint; assert.ok(hint);
    const entered = gate<void>(), release = gate<void>(); let gated = false, hintReads = 0;
    repository.revisionHint = async workId => {
      if (workId === target.workId) {
        hintReads++;
        if (!gated) { gated = true; entered.resolve(); await release.promise; }
      }
      return hint.call(repository, workId);
    };
    const pending = agent.start(target);
    try {
      const poll = await within(pending.entered); await within(entered.promise, 5000);
      const paused = await f.call<ResidentControl>(target, ['pause', '--command-id', 'fast-pause', '--control-revision', '0']);
      const resumed = await f.call<ResidentControl>(target, ['resume', '--command-id', 'fast-resume', '--control-revision', String(paused.value.current.controlRevision)]);
      assert.equal(paused.process.code, 0); assert.equal(resumed.process.code, 0);
      assert.equal(resumed.value.current.status, 'active'); assert.equal(hintReads, 1);
      assert.equal(poll.input.signal.aborted, false); assert.equal(poll.released, false);
      const afterChildren = await residentProcessRecord(target), releaseAt = performance.now();
      release.resolve();
      assert.equal((await within(pending.result, 5000)).kind, 'rejected'); assert.equal(poll.input.signal.aborted, true);
      assert.equal(poll.released, false); assert.equal(poll.settledAt, null);
      assert.deepEqual(await residentProcessRecord(target), afterChildren, 'observation cancellation does not synthesize another durable command');
      observation(backend, 'pause-resume-after-child-exit', poll, resumed.process);
      console.log(JSON.stringify({ kind: 'resident_cross_process_hint_release', backend, releaseToAbortMs: poll.abortedAt! - releaseAt,
        childClosedBeforeRelease: resumed.process.closedAt <= releaseAt, hintReads }));
      assert.ok(poll.abortedAt! >= resumed.process.closedAt);
      await preservedProcessRecord(target, original);
    } finally {
      release.resolve(); repository.revisionHint = hint;
      try { await within(target.driver.close()); }
      finally { for (const poll of agent.held) poll.release(); await within(Promise.allSettled([pending.result])); }
    }
  });

  test(`resident cross-process ${backend}: child control and wrong selection leave other sessions and agents observing`, { timeout: 180000 }, async t => {
    const f = await residentProcessFixture(t, backend), agent = await f.open('agent'), otherAgent = await f.open('other-agent');
    const primary = await agent.register('primary'), sameAgent = await agent.register('other-session', true), foreignAgent = await otherAgent.register('primary');
    assert.notEqual(primary.sessionId, sameAgent.sessionId); assert.notEqual(primary.profile.agentId, foreignAgent.profile.agentId);
    assert.equal(primary.profile.actor.principalId, foreignAgent.profile.actor.principalId);
    const one = agent.start(primary), two = agent.start(sameAgent), three = otherAgent.start(foreignAgent);
    const source = await within(one.entered), sibling = await within(two.entered), foreign = await within(three.entered);
    const beforeSibling = await residentProcessRecord(sameAgent), beforeForeign = await residentProcessRecord(foreignAgent);
    const beforePrimary = await residentProcessRecord(primary);
    const siblingRepository = sameAgent.profile.services.state, foreignRepository = foreignAgent.profile.services.state;
    const siblingHint = siblingRepository.revisionHint, foreignHint = foreignRepository.revisionHint; assert.ok(siblingHint); assert.ok(foreignHint);
    const checked = [gate<void>(), gate<void>()] as const; let childFinished = false; const counts: [number, number] = [0, 0];
    siblingRepository.revisionHint = async workId => {
      const value = await siblingHint.call(siblingRepository, workId);
      if (childFinished && workId === sameAgent.workId && ++counts[0] >= 2) checked[0].resolve(); return value;
    };
    foreignRepository.revisionHint = async workId => {
      const value = await foreignHint.call(foreignRepository, workId);
      if (childFinished && workId === foreignAgent.workId && ++counts[1] >= 2) checked[1].resolve(); return value;
    };
    try {
      const pause = ['pause', '--command-id', 'isolated-pause', '--control-revision', '0'];
      await f.failure(primary, pause, 'resident_selection_mismatch', { sessionId: sameAgent.sessionId });
      await f.failure(primary, pause, 'work_not_found', { directory: foreignAgent.directory });
      assert.deepEqual(await residentProcessRecord(primary), beforePrimary); assert.equal(source.input.signal.aborted, false);
      const applied = await f.call<ResidentControl>(primary, pause); assert.equal(applied.value.current.status, 'paused'); childFinished = true;
      assert.equal((await within(one.result, 5000)).kind, 'rejected');
      await within(Promise.all(checked.map(value => value.promise)), 5000);
      assert.equal(sibling.input.signal.aborted, false); assert.equal(foreign.input.signal.aborted, false);
      assert.equal(sibling.released, false); assert.equal(foreign.released, false);
      assert.deepEqual(await residentProcessRecord(sameAgent), beforeSibling); assert.deepEqual(await residentProcessRecord(foreignAgent), beforeForeign);
      assert.equal(agent.entry.observation.closes + otherAgent.entry.observation.closes, 0);
      observation(backend, 'isolated-pause', source, applied.process);
    } finally {
      siblingRepository.revisionHint = siblingHint; foreignRepository.revisionHint = foreignHint;
      try { await within(Promise.all([primary.driver.close(), sameAgent.driver.close(), foreignAgent.driver.close()])); }
      finally {
        for (const poll of [...agent.held, ...otherAgent.held]) poll.release();
        await within(Promise.allSettled([one.result, two.result, three.result]));
      }
    }
  });
}
