import test from 'node:test';
import assert from 'node:assert/strict';
import type { A2aCall, A2aPeer, A2aTask } from '../application/a2a-contracts.js';
import type { Json } from '../domain/model.js';
import { a2aReplyMissionSource, observationMissionSource, scheduledMissionSource } from '../infrastructure/mission-sources.js';
import { missionBounded, missionGate, missionPoll } from './host-missions-registration-fixture.js';

test('mission sources: a schedule emits only the latest due event with skipped intervals and stays empty on repeat or reopen', async () => {
  const options = { id: 'timer', resourceId: 'observed-resource', firstAt: 1000, intervalMs: 1000 }, source = scheduledMissionSource(options);
  options.firstAt = 999999;
  assert.deepEqual(await source.poll(missionPoll({ now: 999 })), { cursor: 0, snapshotDigest: null, events: [] });
  const first = await source.poll(missionPoll({ now: 6000 }));
  assert.deepEqual(first, { cursor: 6, snapshotDigest: null, events: [{ id: 'schedule:6', kind: 'schedule', referenceId: 'observed-resource',
    occurredAt: 6000, body: { kind: 'scheduled_observation', due: 6, skippedIntervals: 5 } }] });
  assert.deepEqual(await source.poll(missionPoll({ cursor: first.cursor, now: 6999 })), { cursor: 6, snapshotDigest: null, events: [] });
  const later = await source.poll(missionPoll({ cursor: first.cursor, now: 9000 }));
  assert.equal(later.events.length, 1); assert.equal(later.cursor, 9);
  assert.deepEqual(later.events[0]!.body, { kind: 'scheduled_observation', due: 9, skippedIntervals: 2 });
  const reopened = scheduledMissionSource({ ...options, firstAt: 1000 });
  assert.deepEqual(await reopened.poll(missionPoll({ cursor: later.cursor, now: 9000 })), { cursor: 9, snapshotDigest: null, events: [] });
});

test('mission sources: schedule options resource binding and current authorization reject invalid polls without a wake event', async () => {
  assert.throws(() => scheduledMissionSource({ id: 'timer', resourceId: 'observed-resource', firstAt: 0, intervalMs: 999 }));
  const source = scheduledMissionSource({ id: 'timer', resourceId: 'observed-resource', firstAt: 0, intervalMs: 1000 });
  await assert.rejects(source.poll(missionPoll({ resourceId: 'another-resource' })), /mission_resource_unavailable/);
  const denial = new Error('current_schedule_authority_denied'); let checks = 0;
  await assert.rejects(source.poll(missionPoll({ authorize: async () => { checks++; throw denial; } })), error => error === denial);
  const stopped = new AbortController(); stopped.abort(denial);
  await assert.rejects(source.poll(missionPoll({ signal: stopped.signal, authorize: async () => { checks++; } })), error => error === denial);
  assert.equal(checks, 1); assert.deepEqual(source.labels, []); assert.equal(source.destination, 'local');
});

test('mission sources: observation snapshots preserve full originals while equal content repeats are empty and changed bodies or versions emit once', async () => {
  let observation: { version: string; body: Json } = { version: 'v1', body: { text: 'Original body.', nested: { value: 1 } } }, reads = 0;
  const raw = { id: 'observations', resourceId: 'observed-resource', destination: 'local', labels: ['internal'],
    async read() { assert.equal(this, raw); reads++; return structuredClone(observation); } };
  const source = observationMissionSource(raw); raw.read = async () => { assert.fail('replacement callback'); }; raw.labels.push('later-private');
  const first = await source.poll(missionPoll()), saved = structuredClone(first);
  assert.equal(first.events.length, 1); assert.match(first.snapshotDigest!, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.events[0]!.body, { kind: 'unreviewed_observation', ...observation });
  assert.deepEqual(source.labels, ['internal']); assert.equal(Object.isFrozen(source.labels), true);
  assert.deepEqual(await source.poll(missionPoll({ cursor: first.cursor, snapshotDigest: first.snapshotDigest })),
    { cursor: first.cursor, snapshotDigest: first.snapshotDigest, events: [] });
  observation.body = { text: 'Changed body.', nested: { value: 2 } };
  const changed = await source.poll(missionPoll({ cursor: first.cursor, snapshotDigest: first.snapshotDigest }));
  assert.equal(changed.cursor, first.cursor + 1); assert.notEqual(changed.events[0]!.id, first.events[0]!.id);
  assert.deepEqual(changed.events[0]!.body, { kind: 'unreviewed_observation', ...observation });
  observation.version = 'v2';
  const versioned = await source.poll(missionPoll({ cursor: changed.cursor, snapshotDigest: changed.snapshotDigest }));
  assert.equal(versioned.events.length, 1); assert.notEqual(versioned.snapshotDigest, changed.snapshotDigest);
  assert.deepEqual(first, saved); assert.equal(reads, 4);
});

test('mission sources: observation reads require the bound resource and current authority both before and after a delayed original', { timeout: 10000 }, async () => {
  const entered = missionGate(), release = missionGate(); let reads = 0, permitted = true;
  const denial = new Error('observation_authority_revoked');
  const source = observationMissionSource({ id: 'observations', resourceId: 'observed-resource', destination: 'local', labels: ['internal'],
    async read() { reads++; entered.release(); await release.promise; return { version: 'v1', body: 'protected original' }; } });
  const authorize = async () => { if (!permitted) throw denial; };
  await assert.rejects(source.poll(missionPoll({ resourceId: 'foreign-resource', authorize })), /mission_resource_unavailable/);
  permitted = false; await assert.rejects(source.poll(missionPoll({ authorize })), error => error === denial); assert.equal(reads, 0);
  permitted = true;
  const pending = source.poll(missionPoll({ authorize })).then(value => ({ value }), error => ({ error }));
  try {
    await missionBounded(entered.promise); permitted = false; release.release();
    const result = await missionBounded(pending); assert.ok('error' in result); assert.equal(result.error, denial); assert.equal(reads, 1);
  } finally { release.release(); await missionBounded(pending); }
});

test('mission sources: A2A replies retain source task request identity and whole reply snapshots while equal polls emit nothing', async () => {
  let reply: A2aTask = { id: 'remote-task', contextId: 'remote-context', status: { state: 'TASK_STATE_WORKING' } };
  const calls: Array<{ taskId: string; call: A2aCall }> = [];
  const peer: A2aPeer = { id: 'remote-peer', protocolVersion: '1.0', destination: 'local', labels: ['internal'],
    async get(taskId, call) { assert.equal(this, peer); calls.push({ taskId, call }); await call.authorize?.(); return structuredClone(reply); },
    async send() { assert.fail('poll cannot send a new task'); }, async cancel() { assert.fail('poll cannot cancel a task'); }, async close() {} };
  const source = a2aReplyMissionSource(peer, 'selected-replies'); peer.get = async () => { assert.fail('replacement peer callback'); };
  let checks = 0; const authorize = async () => { checks++; };
  const first = await source.poll(missionPoll({ resourceId: 'remote-task', authorize })), original = structuredClone(first);
  const repeatInput = missionPoll({ resourceId: 'remote-task', cursor: first.cursor, snapshotDigest: first.snapshotDigest, authorize });
  const repeat = await source.poll(repeatInput); assert.equal(repeat.events.length, 0); assert.equal(repeat.cursor, first.cursor);
  await source.poll(repeatInput); assert.equal(calls[1]!.call.requestId, calls[2]!.call.requestId);
  reply = { ...reply, status: { state: 'TASK_STATE_COMPLETED', timestamp: '2026-09-08T00:00:00Z' },
    artifacts: [{ artifactId: 'reply-body', parts: [{ text: 'Remote completed is still unreviewed input.' }] }] };
  const changed = await source.poll(repeatInput);
  assert.equal(changed.cursor, first.cursor + 1); assert.equal(changed.events[0]!.referenceId, 'remote-task');
  assert.deepEqual(changed.events[0]!.body, { kind: 'unreviewed_a2a_task', task: reply });
  assert.equal(changed.events[0]!.occurredAt, Date.parse(reply.status.timestamp!)); assert.deepEqual(first, original);
  assert.equal(source.id, 'selected-replies'); assert.deepEqual(source.labels, ['internal']);
  assert.ok(calls.every(value => value.taskId === 'remote-task' && /^[a-f0-9]{64}$/.test(value.call.requestId)));
  assert.equal(checks, 4);
});
