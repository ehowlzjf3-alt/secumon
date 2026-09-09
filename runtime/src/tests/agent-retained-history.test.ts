import test from 'node:test';
import assert from 'node:assert/strict';
import { retainedHistoryRestoreFixture, retainedMissionHead, retainedWork } from './agent-retained-history-fixture.js';

for (const backend of ['sqlite', 'file-journal'] as const) test(`${backend}: full agent backup restores pruned command receipts and event segments before original replay and redelivery`,
  { timeout: 120000 }, async t => {
    const h = await retainedHistoryRestoreFixture(t, backend), p = h.current(), residentId = h.resident.state.id, missionId = h.mission.state.id;
    assert.deepEqual(await retainedWork(p, residentId), h.resident);
    assert.deepEqual(await retainedWork(p, missionId), h.mission);
    assert.deepEqual(Array.from(await p.services.artifacts.get(h.archived, p.policy)), Array.from(h.archiveBytes));
    assert.equal(h.resident.state.artifacts.some(value => value.id === h.pausePublication.artifact.id), false);
    assert.equal(h.mission.state.artifacts.some(value => value.id === h.anchor.artifact.id), false);
    assert.equal((await h.f.driver().status(residentId)).status, 'closed');
    const receipt = p.services.state.receipt.bind(p.services.state); let originalLookups = 0;
    p.services.state.receipt = async (workId, commandId) => {
      if (workId === residentId && commandId === h.pausePublication.commandId) originalLookups++;
      return receipt(workId, commandId);
    };
    try {
      const replay = await h.f.driver().control(residentId, h.pause);
      assert.equal(replay.replayed, true); assert.equal(replay.current.status, 'closed');
      assert.equal(replay.appliedControlRevision, h.paused.appliedControlRevision); assert.equal(replay.appliedStateRevision, h.paused.appliedStateRevision);
      assert.equal(originalLookups, 1);
    } finally { p.services.state.receipt = receipt; }
    assert.deepEqual(await retainedWork(p, residentId), h.resident); assert.deepEqual(h.counts(), h.beforeCounts);

    assert.ok(p.missions); h.advance(); h.f.pages.first[43] = [h.originals[0]!];
    const before = await retainedMissionHead(p, missionId);
    assert.deepEqual((await p.missions.readEvents(missionId, h.rule.id)).events, []);
    await p.missions.refresh(missionId); const duplicate = await retainedMissionHead(p, missionId);
    assert.equal(duplicate.body.cursor, 44); assert.deepEqual(duplicate.body.events, []); assert.equal(duplicate.body.pendingRun, false);
    assert.deepEqual(duplicate.body.seen, before.body.seen); assert.deepEqual(duplicate.body.seenHistory, before.body.seenHistory);
    assert.deepEqual(duplicate.state.budget, h.mission.state.budget); assert.deepEqual(duplicate.state.attempts, h.mission.state.attempts);
    assert.deepEqual(duplicate.state.modelCalls, h.mission.state.modelCalls); assert.deepEqual(duplicate.state.notifications, []);
    assert.deepEqual(h.counts(), { ...h.beforeCounts, polls: h.beforeCounts.polls + 1 });

    h.advance(); h.f.pages.first[44] = [{ ...h.originals[0]!, body: { text: 'Conflicting redelivery must not replace the original.' } }];
    const stable = await retainedWork(p, missionId);
    assert.deepEqual(stable.events.slice(h.mission.events.length).map(event => event.type), ['mission_checkpoint']);
    await assert.rejects(p.missions.refresh(missionId), /mission_event_identity_conflict/);
    assert.deepEqual(await retainedWork(p, missionId), stable);
    for (const original of [h.resident, h.mission]) {
      const state = await p.runtime.state(original.state.id);
      assert.deepEqual((await p.services.state.events(state.id, 0)).slice(0, original.events.length), original.events);
      for (const item of original.receipts) assert.deepEqual(await p.services.state.receipt(state.id, item.commandId), item.receipt);
      for (const item of original.publications) assert.deepEqual(Array.from(await p.services.artifacts.get(item.artifact, state.policy)), item.bytes);
    }
    assert.deepEqual(h.counts(), { ...h.beforeCounts, polls: h.beforeCounts.polls + 2 }); h.preservation();
    t.diagnostic(JSON.stringify({ ...h.metrics, currentResidentArtifactRefs: h.resident.state.artifacts.length,
      currentMissionArtifactRefs: h.mission.state.artifacts.length, historicEventDigests: 512, actualIntakeEvents: 32,
      postRestoreSourcePolls: 2, newModelCalls: 0, duplicateUsageRecords: 0,
      measurement: 'Local synthetic fixture file bytes, entry counts and elapsed milliseconds; not operational capacity, physical I/O or external-service reconciliation.' }));
  });
