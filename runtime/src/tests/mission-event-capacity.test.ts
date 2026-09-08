import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { asJson } from '../application/plan-validator.js';
import { transact } from '../application/work-transactions.js';
import { event, missionFixture, rule } from './mission-runtime-fixture.js';

type Backend = 'sqlite' | 'file-journal';
type Fixture = Awaited<ReturnType<typeof missionFixture>>;
const backends = ['sqlite', 'file-journal'] as const;

async function records(f: Fixture) {
  const state = await f.current(), events = await f.state.events(f.workId, 0);
  const receipts = await Promise.all(events.map(async original => {
    const receipt = await f.state.receipt(f.workId, original.commandId); assert.ok(receipt);
    return { commandId: original.commandId, receipt };
  }));
  const artifacts = await Promise.all(state.artifacts.map(async ref => ({ ref, bytes: await f.artifacts.get(ref, state.policy) })));
  return { state, events, receipts, artifacts };
}
async function preserve(f: Fixture, original: Awaited<ReturnType<typeof records>>) {
  const state = await f.current(), events = await f.state.events(f.workId, 0);
  assert.deepEqual(events.slice(0, original.events.length), original.events);
  for (const item of original.receipts) assert.deepEqual(await f.state.receipt(f.workId, item.commandId), item.receipt);
  for (const item of original.artifacts) {
    assert.deepEqual(state.artifacts.find(ref => ref.id === item.ref.id), item.ref);
    assert.deepEqual(await f.artifacts.get(item.ref, state.policy), item.bytes);
  }
  assert.deepEqual(state.goal, original.state.goal); assert.deepEqual(state.policy, original.state.policy);
  assert.deepEqual(state.budget, original.state.budget); assert.deepEqual(state.attempts, original.state.attempts);
  assert.deepEqual(state.modelCalls, original.state.modelCalls); assert.deepEqual(state.evidence, original.state.evidence);
  assert.equal(f.planner.inputs.length + f.tool.invocations.length, 0);
}

/** Bounded setup, not 512 executed intakes or an ACK-authority test. Publish a copied valid checkpoint through real artifact/receipt ports. */
async function seeded(t: TestContext, stateBackend: Backend, size: 511 | 512) {
  const f = await missionFixture(t, ['observations'], { stateBackend });
  await f.missions.register(f.workId, rule());
  const initial = await f.checkpoint();
  const history = Array.from({ length: size }, (_, index) => ({ ...event(`capacity-original-${index}`), body: { original: index } }));
  const historyBytes = new TextEncoder().encode(JSON.stringify({ kind: 'fixture_capacity_history', events: history }));
  const archivedOriginal = await f.artifacts.put(historyBytes, { tenantId: initial.work.policy.tenantId,
    labels: [...initial.work.policy.allowedLabels], mediaType: 'application/json' });
  const seen = history.map(original => ({ id: original.id, digest: f.bundle.services.digester.digest(asJson(original)) }));
  // The fixture's assertion view omits fields such as progress; copy the complete original publication too.
  const originalBody: Record<string, unknown> = JSON.parse(new TextDecoder().decode(initial.bytes));
  const value = { ...originalBody, ...initial.value, cursor: 42, snapshotDigest: 'capacity-original-snapshot', nextPollAt: f.clock.now(),
    idlePolls: 2, seen, events: [history.at(-1)!], pendingRun: false,
    // Preservation marker only. Actual adopted-read issuance/authority stays covered by mission-read-ack.test.ts.
    acknowledgedRead: { attemptId: 'fixture-capacity-ack-attempt', resultId: 'fixture-capacity-ack-result' } };
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const artifact = await f.artifacts.put(bytes, { tenantId: initial.work.policy.tenantId,
    labels: [...initial.work.policy.allowedLabels], mediaType: 'application/json' });
  const subscription = { ...initial.subscription, cursor: value.cursor, checkpointId: `mission:${artifact.sha256}` };
  await transact(f.bundle.services, f.workId, subscription.checkpointId, 'mission_checkpoint',
    asJson({ subscriptionId: subscription.id, artifact }), next => {
      next.subscriptions = next.subscriptions!.map(prior => prior.id === subscription.id ? subscription : prior);
      next.artifacts.push(archivedOriginal, artifact);
    });
  assert.equal(await f.missions.current(await f.current()), true, 'the seeded original is readable through normal publication validation');
  assert.ok(Buffer.from((await f.checkpoint()).bytes).equals(bytes), 'stored original bytes match the seeded checkpoint');
  assert.equal(f.sourceCalls.length, 0);
  return { f, history, value, original: await records(f), checkpoint: await f.checkpoint() };
}

for (const backend of backends) test(`mission event capacity ${backend}: an unadmitted page preserves the prior cursor, original body and ACK across reopen`, { timeout: 60000 }, async t => {
  const { f, value, original, checkpoint } = await seeded(t, backend, 512);
  const fresh = { ...event('capacity-unadmitted'), body: { original: 'not admitted at capacity' } };
  const page = { cursor: value.cursor + 1, snapshotDigest: 'unadmitted-snapshot', events: [fresh] };
  f.page('observations', page);
  await f.missions.refresh(f.workId);
  const closed = await f.checkpoint(), expected = { ...value, status: 'closed', reason: 'event_capacity' };
  assert.deepEqual(JSON.parse(new TextDecoder().decode(closed.bytes)), expected);
  assert.equal(closed.subscription.cursor, checkpoint.subscription.cursor); assert.equal(closed.subscription.status, 'closed');
  assert.equal(closed.work.revision, original.state.revision + 1);
  assert.deepEqual(closed.work.notifications, []);
  assert.equal(closed.work.obligations.find(item => item.id === 'mission-wait')?.status, 'satisfied');
  assert.deepEqual(await f.missions.readEvents(f.workId, rule().id), {
    rule: rule(), events: value.events, cursor: value.cursor, status: 'closed', reason: 'event_capacity',
  });
  assert.equal(closed.work.artifacts.length, original.state.artifacts.length + 1, 'only the closed checkpoint is published, not a claimed intake of the new page');
  assert.equal(f.sourceCalls.length, 1); assert.equal(f.sourceCalls[0]!.cursor, value.cursor);
  assert.deepEqual(page.events, [fresh]);
  await preserve(f, original);
  await f.reopen();
  assert.deepEqual(await f.current(), closed.work); assert.deepEqual((await f.checkpoint()).bytes, closed.bytes);
  assert.deepEqual(await f.state.receipt(f.workId, closed.subscription.checkpointId), closed.receipt);
  assert.deepEqual(await f.missions.register(f.workId, rule()), closed.work, 'capacity closure is not implicitly resumed in the same goal');
  assert.deepEqual(await f.missions.refresh(f.workId), closed.work); assert.equal(f.sourceCalls.length, 1);
  await preserve(f, original);
});

test('mission event capacity: both backends accept exact duplicate pages at 512 and reject changed original IDs', { timeout: 120000 }, async t => {
  for (const backend of backends) {
    const { f, history, value, original } = await seeded(t, backend, 512), repeated = history[0]!;
    f.page('observations', { cursor: value.cursor + 1, snapshotDigest: 'duplicate-snapshot', events: [repeated] });
    await f.missions.refresh(f.workId);
    const accepted = await f.checkpoint(), body = JSON.parse(new TextDecoder().decode(accepted.bytes));
    assert.equal(accepted.value.status, 'active'); assert.equal(accepted.value.reason, null);
    assert.equal(accepted.value.cursor, value.cursor + 1); assert.equal(accepted.value.snapshotDigest, 'duplicate-snapshot');
    assert.deepEqual(accepted.value.seen, value.seen); assert.deepEqual(accepted.value.events, []);
    assert.equal(accepted.value.pendingRun, false); assert.equal(accepted.value.idlePolls, value.idlePolls + 1);
    assert.equal(Object.hasOwn(body, 'acknowledgedRead'), false);
    assert.deepEqual(accepted.work.notifications, []); await preserve(f, original);
    await f.reopen(); f.clock.advance(1000);
    const beforeConflict = await records(f);
    f.page('observations', { cursor: value.cursor + 2, snapshotDigest: 'changed-original-snapshot',
      events: [{ ...repeated, body: { original: 'changed bytes' } }] });
    await assert.rejects(f.missions.refresh(f.workId), /mission_event_identity_conflict/);
    assert.deepEqual(await records(f), beforeConflict);
    assert.equal(f.sourceCalls.length, 2); await preserve(f, original);
    t.diagnostic(JSON.stringify({ backend, boundary: '512-duplicate-and-conflict', polls: f.sourceCalls.length, modelCalls: 0, toolCalls: 0 }));
  }
});

test('mission event capacity: both backends admit the one fresh event that reaches exactly 512', { timeout: 120000 }, async t => {
  for (const backend of backends) {
    const { f, value, original } = await seeded(t, backend, 511), fresh = event('capacity-exact-last');
    f.page('observations', { cursor: value.cursor + 1, snapshotDigest: 'exact-capacity-snapshot', events: [fresh] });
    await f.missions.refresh(f.workId);
    const admitted = await f.checkpoint(), body = JSON.parse(new TextDecoder().decode(admitted.bytes));
    assert.equal(admitted.value.status, 'active'); assert.equal(admitted.value.reason, null);
    assert.equal(admitted.value.cursor, value.cursor + 1); assert.equal(admitted.value.snapshotDigest, 'exact-capacity-snapshot');
    assert.equal(admitted.value.seen.length, 512); assert.deepEqual(admitted.value.seen.slice(0, 511), value.seen);
    assert.deepEqual(admitted.value.seen.at(-1), { id: fresh.id, digest: f.bundle.services.digester.digest(asJson(fresh)) });
    assert.deepEqual(admitted.value.events, [fresh]); assert.equal(admitted.value.pendingRun, true);
    assert.equal(admitted.value.idlePolls, 0); assert.equal(Object.hasOwn(body, 'acknowledgedRead'), false);
    assert.ok(admitted.work.notifications); assert.equal(admitted.work.notifications.length, 1);
    assert.equal(admitted.work.notifications[0]!.referenceId, fresh.referenceId);
    assert.equal(f.sourceCalls.length, 1); await preserve(f, original);
    await f.reopen(); assert.deepEqual(await f.current(), admitted.work);
    assert.deepEqual((await f.missions.readEvents(f.workId, rule().id)).events, [fresh]);
    await preserve(f, original);
    t.diagnostic(JSON.stringify({ backend, boundary: '511-to-512', polls: f.sourceCalls.length, modelCalls: 0, toolCalls: 0 }));
  }
});
