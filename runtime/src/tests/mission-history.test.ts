import test from 'node:test';
import assert from 'node:assert/strict';
import type { DomainEvent } from '../domain/model.js';
import { FileJournalStateRepository } from '../infrastructure/file-journal-state.js';
import { event, missionFixture, rule } from './mission-runtime-fixture.js';
import { missionTerminalFixture } from './mission-terminal-recovery-fixture.js';
import { command } from './state-conformance-helpers.js';

type Fixture = Awaited<ReturnType<typeof missionFixture>>;
async function append(f: Fixture, id: string, events: DomainEvent[]) {
  const prior = await f.current(), next = { ...structuredClone(prior), revision: prior.revision + 1 };
  assert.equal((await f.state.commit({ ...command(next, id), events })).kind, 'committed');
}

for (const stateBackend of ['sqlite', 'file-journal'] as const) test(`mission history ${stateBackend}: bounded control pages preserve originals and recheck publication`, { timeout: 90000 }, async t => {
  const f = await missionFixture(t, ['observations'], { stateBackend });
  await append(f, 'older-history', Array.from({ length: 96 }, (_, i) => ({ type: 'fixture_history', at: 1100, data: { i, original: 'x'.repeat(4096) } })));
  await f.missions.register(f.workId, rule());
  f.page('observations', { cursor: 1, snapshotDigest: 'original-page', events: [event()] });
  await f.missions.refresh(f.workId);
  const original = await f.checkpoint();
  await f.bundle.runtime.command(f.workId, 'history-cancel', f.actor, 1, { kind: 'cancel', reason: 'history-cancel' });
  // Uninterpreted fixture records exercise pagination past nonmatching command payloads at one revision.
  await append(f, 'newer-history', [
    ...Array.from({ length: 65 }, (_, i) => ({ type: 'user_command', at: 1100, data: { payload: { fixture: i } } })),
    ...Array.from({ length: 20 }, (_, i) => ({ type: 'fixture_history', at: 1100, data: { i, original: 'y'.repeat(4096) } })),
  ]);
  const basis = await f.current(), readEvents = f.state.events.bind(f.state), originalEvents = await readEvents(f.workId, 0);
  const readPage = f.state.eventPage.bind(f.state), receipt = f.state.receipt.bind(f.state);
  let pages = 0, returned = 0, bytes = 0, publicationReads = 0;
  const journal = f.state instanceof FileJournalStateRepository ? f.state : undefined, beforeMetrics = journal?.metrics();
  f.state.events = async () => { throw new Error('unbounded_mission_history_read'); };
  f.state.eventPage = async (workId, query) => {
    assert.equal(query.afterRevision, original.receipt.state.revision); assert.equal(query.throughRevision, basis.revision);
    assert.equal(query.type, 'user_command'); assert.equal(query.limit, 32);
    const page = await readPage(workId, query); pages++; returned += page.items.length; bytes += Buffer.byteLength(JSON.stringify(page.items));
    return page;
  };
  f.state.receipt = async (workId, commandId) => {
    if (commandId === original.subscription.checkpointId) publicationReads++;
    return receipt(workId, commandId);
  };
  try { await f.missions.refresh(f.workId); }
  finally { f.state.events = readEvents; f.state.eventPage = readPage; f.state.receipt = receipt; }
  const afterMetrics = journal?.metrics(), closed = await f.checkpoint();
  assert.equal(pages, 6); assert.equal(returned, 132, '66 relevant-range events are inspected in each of two independent proofs');
  assert.equal(publicationReads, 2, 'one original publication read per proof, including a fresh read before save');
  assert.ok(bytes < Buffer.byteLength(JSON.stringify(originalEvents)) / 2);
  assert.equal(closed.value.reason, 'cancelled'); assert.deepEqual(closed.value.events, original.value.events);
  assert.deepEqual(closed.value.seen, original.value.seen); assert.equal(closed.value.cursor, original.value.cursor);
  assert.deepEqual((await readEvents(f.workId, 0)).slice(0, originalEvents.length), originalEvents);
  assert.deepEqual(await receipt(f.workId, original.subscription.checkpointId), original.receipt);
  assert.deepEqual(await f.artifacts.get(original.artifact, original.work.policy), original.bytes);
  assert.deepEqual(closed.work.budget, basis.budget); assert.equal(f.sourceCalls.length, 1);
  assert.equal(f.tool.invocations.length + f.planner.inputs.length, 0);
  t.diagnostic(JSON.stringify({ stateBackend, historyEvents: originalEvents.length, fullHistoryBytes: Buffer.byteLength(JSON.stringify(originalEvents)),
    proofPages: pages, proofReturnedEvents: returned, proofReturnedBytes: bytes, publicationReads,
    journalRecordReads: beforeMetrics && afterMetrics ? afterMetrics.recordReads - beforeMetrics.recordReads : null,
    journalRawHashBytes: beforeMetrics && afterMetrics ? afterMetrics.rawHashBytes - beforeMetrics.rawHashBytes : null,
    measurement: 'Node repository reads and returned bytes; not physical disk I/O or model usage' }));
  await f.reopen(); assert.deepEqual(await f.current(), closed.work);
});

test('mission history rereads the control receipt before publishing retirement', async t => {
  const f = await missionFixture(t);
  await f.missions.register(f.workId, rule()); const original = await f.checkpoint();
  await f.bundle.runtime.command(f.workId, 'history-cancel', f.actor, 1, { kind: 'cancel', reason: 'history-cancel' });
  const basis = await f.current(), events = await f.state.events(f.workId, 0), receipt = f.state.receipt.bind(f.state);
  let reads = 0;
  f.state.receipt = async (workId, commandId) => {
    const value = await receipt(workId, commandId);
    if (commandId === 'history-cancel' && ++reads === 2 && value) return { ...value, digest: '0'.repeat(64) };
    return value;
  };
  try { await assert.rejects(f.missions.refresh(f.workId), /mission_state_changed/); }
  finally { f.state.receipt = receipt; }
  assert.equal(reads, 2); assert.deepEqual(await f.current(), basis); assert.deepEqual(await f.state.events(f.workId, 0), events);
  assert.deepEqual(await receipt(f.workId, original.subscription.checkpointId), original.receipt);
  assert.deepEqual(await f.artifacts.get(original.artifact, original.work.policy), original.bytes);
  await f.missions.refresh(f.workId); assert.equal((await f.checkpoint()).value.reason, 'cancelled');
});

test('mission history completion recovery uses bounded original pages with unchanged work results', { timeout: 120000 }, async t => {
  const h = await missionTerminalFixture(t);
  await h.interruptAfterComplete();
  const before = await h.records(), p = h.current(), events = p.services.state.events.bind(p.services.state), readPage = p.services.state.eventPage.bind(p.services.state);
  let pages = 0;
  p.services.state.events = async () => { throw new Error('unbounded_completion_history_read'); };
  p.services.state.eventPage = async (workId, query) => { pages++; assert.equal(query.limit, 32); return readPage(workId, query); };
  try { assert.equal((await p.missions!.tick(h.workId, p.workflow)).kind, 'idle'); }
  finally { p.services.state.events = events; p.services.state.eventPage = readPage; }
  assert.ok(pages > 0);
  for (const checkpoint of await h.checkpoints()) { assert.equal(checkpoint.value.status, 'closed'); assert.equal(checkpoint.value.reason, 'completed'); }
  await h.preserve(before); await h.f.reopen(); assert.equal((await h.current().missions!.tick(h.workId, h.current().workflow)).kind, 'idle');
});
