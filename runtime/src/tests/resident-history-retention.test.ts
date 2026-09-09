import test from 'node:test';
import assert from 'node:assert/strict';
import { ArtifactSchema } from '../application/contracts.js';
import { asJson } from '../application/plan-validator.js';
import { transact } from '../application/work-transactions.js';
import { ResidentMissions, type ResidentControlCommand } from '../application/resident-missions.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { residentEntryFixture } from './resident-missions-entry-fixture.js';

type Fixture = Awaited<ReturnType<typeof residentEntryFixture>>;
const control = (commandId: string, kind: ResidentControlCommand['kind'], expectedControlRevision: number): ResidentControlCommand =>
  ({ commandId, kind, expectedControlRevision });
async function records(f: Fixture, workId: string) {
  const p = f.current(), state = await p.runtime.state(workId), events = await p.services.state.events(workId, 0);
  const receipts = await Promise.all(events.map(async event => {
    const receipt = await p.services.state.receipt(workId, event.commandId); assert.ok(receipt);
    return { commandId: event.commandId, receipt };
  }));
  const checkpoints = await Promise.all(events.filter(event => ['resident_checkpoint', 'resident_control'].includes(event.type)).map(async event => {
    const payload = event.data['payload']; assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload));
    const artifact = ArtifactSchema.parse(payload['artifact']);
    const receipt = receipts.find(value => value.commandId === event.commandId)!.receipt;
    assert.ok(receipt.state.artifacts.some(ref => ref.id === artifact.id));
    return { artifact, bytes: await p.services.artifacts.get(artifact, state.policy), receiptId: event.commandId };
  }));
  return { state, events, receipts, checkpoints };
}
async function preserved(f: Fixture, original: Awaited<ReturnType<typeof records>>) {
  const p = f.current(), state = await p.runtime.state(original.state.id);
  assert.deepEqual((await p.services.state.events(state.id, 0)).slice(0, original.events.length), original.events);
  for (const item of original.receipts) assert.deepEqual(await p.services.state.receipt(state.id, item.commandId), item.receipt);
  for (const item of original.checkpoints) assert.deepEqual(await p.services.artifacts.get(item.artifact, state.policy), item.bytes);
  assert.deepEqual(state.budget, original.state.budget); assert.deepEqual(state.attempts, original.state.attempts);
  assert.deepEqual(state.modelCalls, original.state.modelCalls); assert.deepEqual(state.evidence, original.state.evidence);
  assert.equal(f.observed.inputs.first.length + f.observed.inputs.second.length + f.observed.compacts.length, 0);
}
async function currentHead(f: Fixture, workId: string) {
  const p = f.current(), state = await p.runtime.state(workId);
  const subscription = state.subscriptions?.find(value => value.provider === 'resident-mission'); assert.ok(subscription);
  const artifact = state.artifacts.find(value => subscription.checkpointId === `resident:${value.sha256}`); assert.ok(artifact);
  return { state, subscription, artifact };
}

for (const backend of ['sqlite', 'file-journal'] as const) test(`resident history retention ${backend}: normal empty polls keep current refs bounded and retain every original publication`, { timeout: 120000 }, async t => {
  const f = await residentEntryFixture(t, false, { stateBackend: backend }), registered = await f.register(), p = f.current();
  const original = await records(f, registered.workId), initial = await currentHead(f, registered.workId);
  assert.ok(p.services.artifacts instanceof FileArtifactStore); const artifacts = p.services.artifacts;
  const commit = p.services.state.commit.bind(p.services.state);
  const writes: { refs: number; requestBytes: number; stateBytes: number }[] = [];
  const costs: ReturnType<FileArtifactStore['metrics']>[] = [];
  p.services.state.commit = async request => {
    const result = await commit(request);
    if (request.workId === registered.workId && result.kind === 'committed') writes.push({ refs: request.next.artifacts.length,
      requestBytes: Buffer.byteLength(JSON.stringify(request)), stateBytes: Buffer.byteLength(JSON.stringify(request.next)) });
    return result;
  };
  try {
    // Seven is below the unchanged fixture maxIdlePolls=8; the normal source remains registered and active.
    for (let index = 0; index < 7; index++) {
      await f.due(registered.workId); artifacts.resetMetrics();
      assert.equal((await f.driver().tick(registered.workId)).kind, 'wait'); costs.push(artifacts.metrics());
      assert.equal((await f.driver().status(registered.workId)).status, 'active');
      assert.equal((await currentHead(f, registered.workId)).state.artifacts.length, initial.state.artifacts.length);
    }
  } finally { p.services.state.commit = commit; }
  assert.equal(f.observed.polls.length, 7); assert.ok(writes.length >= 14);
  assert.ok(writes.every(write => write.refs === initial.state.artifacts.length));
  assert.ok(costs.at(-1)!.existsCalls <= costs[0]!.existsCalls + 2, 'later polls do not recheck a growing list of historical artifact bodies');
  const retained = await records(f, registered.workId), head = await currentHead(f, registered.workId);
  assert.ok(retained.checkpoints.length >= 15); assert.notEqual(head.artifact.id, initial.artifact.id);
  assert.equal(retained.state.artifacts.some(ref => ref.id === initial.artifact.id), false);
  assert.ok(retained.checkpoints.every(item => item.artifact.id === head.artifact.id || !retained.state.artifacts.some(ref => ref.id === item.artifact.id)));
  await preserved(f, original); await f.reopen(); assert.deepEqual(await f.current().runtime.state(registered.workId), retained.state);
  await preserved(f, retained);
  t.diagnostic(JSON.stringify({ backend, polls: 7, committedPublications: writes.length, currentArtifactRefs: retained.state.artifacts.length,
    retainedCheckpointObjects: retained.checkpoints.length, minRequestBytes: Math.min(...writes.map(write => write.requestBytes)),
    maxRequestBytes: Math.max(...writes.map(write => write.requestBytes)), serializedReceiptStateBytes: retained.receipts.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item.receipt.state)), 0),
    firstPollExistsCalls: costs[0]!.existsCalls, lastPollExistsCalls: costs.at(-1)!.existsCalls,
    firstPollHashBytes: costs[0]!.hashBytes, lastPollHashBytes: costs.at(-1)!.hashBytes,
    measurement: 'Actual Node artifact counters and serialized committed request/receipt states; not physical disk I/O, archive deletion or bounded journal replay.' }));
});

test('resident history retention: a pruned historical control replays from its exact receipt after later commands and reopen', { timeout: 120000 }, async t => {
  const f = await residentEntryFixture(t), registered = await f.register();
  const pause = control('retained-original-pause', 'pause', 0), applied = await f.driver().control(registered.workId, pause);
  const paused = await records(f, registered.workId), old = await currentHead(f, registered.workId);
  const resumed = await f.driver().control(registered.workId, control('retained-resume', 'resume', applied.current.controlRevision));
  await f.driver().control(registered.workId, control('retained-stop', 'stop', resumed.current.controlRevision));
  const before = await records(f, registered.workId);
  assert.equal(before.state.artifacts.some(ref => ref.id === old.artifact.id), false); await f.reopen();
  const p = f.current(), receipt = p.services.state.receipt.bind(p.services.state);
  const originalId = paused.events.find(event => event.revision === applied.appliedStateRevision)!.commandId;
  let originalLookups = 0;
  p.services.state.receipt = async (workId, commandId) => { if (commandId === originalId) originalLookups++; return receipt(workId, commandId); };
  try {
    const replay = await f.driver().control(registered.workId, pause);
    assert.equal(replay.replayed, true); assert.equal(replay.current.status, 'closed');
    assert.equal(replay.appliedStateRevision, applied.appliedStateRevision); assert.equal(replay.appliedControlRevision, applied.appliedControlRevision);
    assert.equal(originalLookups, 1, 'historical materialization reuses the already selected command receipt');
  } finally { p.services.state.receipt = receipt; }
  assert.deepEqual(await records(f, registered.workId), before); await preserved(f, paused);
  assert.equal(f.observed.polls.length, 0);
});

test('resident history retention: historical lookup respects current blocked refs and actor policy while current heads require current membership', { timeout: 120000 }, async t => {
  const f = await residentEntryFixture(t), registered = await f.register(), pause = control('restricted-old-pause', 'pause', 0);
  const applied = await f.driver().control(registered.workId, pause), old = await currentHead(f, registered.workId);
  await f.driver().control(registered.workId, control('restricted-resume', 'resume', applied.current.controlRevision));
  const before = await records(f, registered.workId), head = await currentHead(f, registered.workId), p = f.current();
  assert.equal(head.state.artifacts.some(ref => ref.id === old.artifact.id), false);
  const get = p.services.state.get.bind(p.services.state);
  try {
    // Read-boundary projections exercise visibility and membership refusal without rewriting durable originals.
    p.services.state.get = async workId => {
      const value = await get(workId); if (!value || workId !== registered.workId) return value;
      return { ...value, dataLifecycle: { generation: value.dataLifecycle?.generation ?? 0,
        blockedArtifactIds: [...(value.dataLifecycle?.blockedArtifactIds ?? []), old.artifact.id], changes: value.dataLifecycle?.changes ?? [] } };
    };
    await assert.rejects(f.driver().control(registered.workId, pause), /resident_checkpoint_unavailable/);
    p.services.state.get = async workId => {
      const value = await get(workId); return value && workId === registered.workId ? { ...value, artifacts: value.artifacts.filter(ref => ref.id !== head.artifact.id) } : value;
    };
    await assert.rejects(f.driver().status(registered.workId), /resident_checkpoint_unavailable/);
  } finally { p.services.state.get = get; }
  assert.ok(p.missions);
  const denied = new ResidentMissions({ services: p.services, sessions: p.sessions, workflow: p.workflow, agentId: p.agentId, scope: p.scope,
    actor: { ...p.executionActor, allowedLabels: [] }, sources: p.missions.sources, signal: new AbortController().signal });
  await assert.rejects(denied.control(registered.workId, pause), /resident_access_denied/);
  assert.deepEqual(await records(f, registered.workId), before); await preserved(f, before); assert.equal(f.observed.polls.length, 0);
});

test('resident history retention: another current structure and unrelated artifacts keep their original references', { timeout: 120000 }, async t => {
  const f = await residentEntryFixture(t), registered = await f.register(), original = await currentHead(f, registered.workId), p = f.current();
  const unrelatedBytes = new TextEncoder().encode('Unrelated original retained independently of observation heads.');
  const unrelated = await p.services.artifacts.put(unrelatedBytes, { tenantId: p.policy.tenantId, labels: [...p.policy.allowedLabels], mediaType: 'text/plain' });
  // A structural host fixture reference only; it does not claim an actual board/source proof or create an event input.
  const other = { ...original.subscription, id: 'fixture-shared-head-owner', provider: 'fixture-owner', resourceId: 'fixture-shared-original' };
  await transact(p.services, registered.workId, 'fixture-independent-current-reference', 'fixture_retention_reference', asJson({ artifact: unrelated }), next => {
    next.artifacts.push(unrelated); next.subscriptions!.push(other);
  });
  const before = await records(f, registered.workId);
  const paused = await f.driver().control(registered.workId, control('shared-head-pause', 'pause', 0));
  const first = await currentHead(f, registered.workId);
  assert.ok(first.state.artifacts.some(ref => ref.id === original.artifact.id)); assert.ok(first.state.artifacts.some(ref => ref.id === unrelated.id));
  await f.driver().control(registered.workId, control('shared-head-resume', 'resume', paused.current.controlRevision));
  const second = await currentHead(f, registered.workId);
  assert.equal(second.state.artifacts.some(ref => ref.id === first.artifact.id), false, 'the unshared next head can still be replaced');
  assert.ok(second.state.artifacts.some(ref => ref.id === original.artifact.id)); assert.ok(second.state.artifacts.some(ref => ref.id === unrelated.id));
  assert.deepEqual(second.state.subscriptions?.find(value => value.id === other.id), other);
  assert.equal(Buffer.from(await p.services.artifacts.get(unrelated, p.policy)).equals(unrelatedBytes), true);
  await preserved(f, before); await f.reopen(); assert.deepEqual(await f.current().runtime.state(registered.workId), second.state);
  await preserved(f, before); assert.equal(f.observed.polls.length, 0);
});
