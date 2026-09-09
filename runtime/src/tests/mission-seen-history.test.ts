import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { asJson } from '../application/plan-validator.js';
import { transact } from '../application/work-transactions.js';
import { event, missionFixture, rule } from './mission-runtime-fixture.js';
import { DEFAULT_PROGRESS_POLICY } from '../domain/work-progress.js';

type Fixture = Awaited<ReturnType<typeof missionFixture>>;
type Original = Awaited<ReturnType<Fixture['checkpoint']>>;
const historyView = z.object({ seenHistory: z.strictObject({ checkpointId: z.string(), revision: z.number().int().positive() }).optional() });
const historyOf = (original: Original) => historyView.parse(JSON.parse(new TextDecoder().decode(original.bytes))).seenHistory;

async function preserved(f: Fixture, originals: readonly Original[]) {
  for (const original of originals) {
    assert.deepEqual(await f.state.receipt(f.workId, original.subscription.checkpointId), original.receipt);
    assert.deepEqual(await f.artifacts.get(original.artifact, original.work.policy), original.bytes);
  }
}

/** Boundary setup only: a legacy segment is published through actual artifact/receipt ports, not 512 claimed executions or read ACKs. */
async function rotated(t: TestContext) {
  const f = await missionFixture(t);
  await f.edit(state => { state.dataLifecycle = { generation: 1, blockedArtifactIds: [], changes: [] }; });
  await f.missions.register(f.workId, rule());
  const initial = await f.checkpoint(), history = Array.from({ length: 512 }, (_, index) => event(`historic-${index}`));
  const completeBody: Record<string, unknown> = JSON.parse(new TextDecoder().decode(initial.bytes));
  const value = { ...completeBody, cursor: 42, snapshotDigest: 'legacy-segment', nextPollAt: f.clock.now(),
    seen: history.map(original => ({ id: original.id, digest: f.bundle.services.digester.digest(asJson(original)) })), events: [] };
  const archived = await f.artifacts.put(new TextEncoder().encode(JSON.stringify({ kind: 'fixture_segment_originals', events: history })),
    { tenantId: initial.work.policy.tenantId, labels: [...initial.work.policy.allowedLabels], mediaType: 'application/json' });
  const artifact = await f.artifacts.put(new TextEncoder().encode(JSON.stringify(value)),
    { tenantId: initial.work.policy.tenantId, labels: [...initial.work.policy.allowedLabels], mediaType: 'application/json' });
  const subscription = { ...initial.subscription, cursor: value.cursor, checkpointId: `mission:${artifact.sha256}` };
  await transact(f.bundle.services, f.workId, subscription.checkpointId, 'mission_checkpoint', asJson({ subscriptionId: subscription.id, artifact }), next => {
    next.subscriptions = next.subscriptions!.map(prior => prior.id === subscription.id ? subscription : prior);
    next.artifacts.push(archived, artifact);
  });
  const anchor = await f.checkpoint();
  const fresh = Array.from({ length: 32 }, (_, index) => event(`new-segment-${index}`));
  f.page('observations', { cursor: 43, snapshotDigest: 'new-segment', events: fresh });
  await f.missions.refresh(f.workId); const admitted = await f.checkpoint();
  assert.deepEqual(historyOf(admitted), { checkpointId: anchor.subscription.checkpointId, revision: anchor.receipt.state.revision });
  assert.deepEqual(admitted.value.events, fresh); assert.equal(admitted.value.seen.length, 32);
  // Use the existing real no-planner workflow settlement; this is not a native mission.events ACK test.
  assert.equal((await f.missions.tick(f.workId, f.bundle.workflow)).kind, 'ran');
  assert.equal((await f.checkpoint()).value.pendingRun, false);
  f.clock.advance(1000); await f.reopen();
  return { f, history, anchor, admitted };
}

test('mission seen history admits 544 same-goal originals through actual workflow pages and deduplicates the oldest page after reopen', { timeout: 180000 }, async t => {
  const f = await missionFixture(t), selected = rule('observations', { maxResumes: 64, maxNoProgress: 16 });
  await f.edit(state => {
    // The actual read supplies one independent source; requiring two keeps this same goal incomplete without resetting completed state.
    state.goal.criteria[0]!.minIndependentSources = 2;
    state.budget.limits.toolCalls = 64; state.budget.limits.replans = 64; state.budget.limits.wallTimeMs = 3600000;
    // This capacity fixture deliberately repeats one read; retain productivity accounting with a finite fixture-only allowance.
    state.progress = { schemaVersion: 1, goalRevision: state.goal.revision,
      policy: { ...DEFAULT_PROGRESS_POLICY, maxUnproductiveSteps: 32 }, processed: [], knownKeys: [],
      consecutiveUnproductive: 0, productiveSteps: 0, unproductiveSteps: 0, failures: [], saturated: false };
  });
  await f.missions.register(f.workId, selected);
  const waitId = 'fixture-next-source-page', workflow = f.bundle.workflow, run = workflow.run.bind(workflow);
  let selectedRead: string | null = null, waitPublished = false;
  // The fixture host waits for the next external page after a real adopted read. The actual workflow still reserves, executes and adopts it.
  workflow.run = (workId, actor, options = {}) => run(workId, actor, { ...options, onStep: async () => {
    if (selectedRead && !waitPublished && (await f.current()).attempts.some(attempt => attempt.taskId === selectedRead && attempt.adopted)) {
      await f.edit(state => {
        const prior = state.obligations.find(item => item.id === waitId);
        if (prior) prior.status = 'pending';
        else state.obligations.push({ id: waitId, kind: 'response', reason: 'Wait for the next source page.', status: 'pending',
          wakeKey: 'fixture-source-page', dueAt: null });
      });
      waitPublished = true;
    }
    await options.onStep?.();
  } });
  const initial = await f.checkpoint(selected), admitted: Original[] = [], settled: Original[] = [];
  const originals = Array.from({ length: 544 }, (_, index) => event(`same-goal-${index}`));
  for (let page = 0; page < 17; page++) {
    if (page) f.clock.advance(1000);
    const entries = originals.slice(page * 32, (page + 1) * 32);
    f.page('observations', { cursor: page + 1, snapshotDigest: `same-goal-page-${page + 1}`, events: entries });
    await f.missions.refresh(f.workId);
    const received = await f.checkpoint(selected); admitted.push(received);
    assert.deepEqual(received.value.events, entries); assert.equal(received.value.cursor, page + 1);
    assert.equal(received.value.status, 'active'); assert.equal(received.value.pendingRun, true);
    assert.ok(received.value.seen.length <= 512); assert.ok(received.bytes.byteLength <= 128 * 1024);
    if (page < 16) assert.equal(historyOf(received), undefined);
    else assert.deepEqual(historyOf(received), { checkpointId: settled[15]!.subscription.checkpointId, revision: settled[15]!.receipt.state.revision });
    if (received.work.obligations.some(item => item.id === waitId && item.status === 'pending'))
      await f.edit(state => { state.obligations.find(item => item.id === waitId)!.status = 'satisfied'; });
    selectedRead = await f.prepareRead(); waitPublished = false;
    const outcome = await f.missions.tick(f.workId, workflow, { maxSteps: 16 });
    assert.equal(outcome.kind, 'ran'); assert.equal(waitPublished, true, JSON.stringify({ page, outcome }));
    if (outcome.kind === 'ran') assert.deepEqual(outcome.result.control, { kind: 'wait', reason: 'pending_obligation', wakeAt: null });
    const finished = await f.checkpoint(selected); settled.push(finished);
    assert.equal(finished.work.status, 'waiting'); assert.equal(finished.value.pendingRun, false);
    assert.equal(finished.value.claim, null); assert.equal(finished.value.status, 'active');
    assert.deepEqual(finished.work.goal, initial.work.goal);
  }
  const last = settled.at(-1)!;
  assert.equal(last.value.seen.length, 32); assert.equal(f.sourceCalls.length, 17);
  assert.equal(last.work.budget.used.modelCalls, 0); assert.equal(f.planner.inputs.length, 0);
  assert.ok(last.work.progress!.unproductiveSteps > 0); assert.equal(last.work.progress!.policy.maxUnproductiveSteps, 32);
  assert.equal(f.tool.invocations.length, 17); assert.equal(last.work.budget.used.toolCalls, 17);
  assert.deepEqual(last.work.evidence.map(item => item.id), ['independent']);
  const missionHeads = new Set([initial, ...admitted, ...settled].map(item => item.artifact.id));
  assert.deepEqual(last.work.artifacts.filter(ref => missionHeads.has(ref.id)), [last.artifact], 'only the current mission head remains in the current artifact projection');
  await preserved(f, [initial, ...admitted, ...settled]);
  await f.reopen(); assert.deepEqual((await f.checkpoint(selected)).bytes, last.bytes);
  f.clock.advance(1000);
  f.page('observations', { cursor: 18, snapshotDigest: 'old-original-redelivery', events: originals.slice(0, 32) });
  await f.missions.refresh(f.workId); const duplicate = await f.checkpoint(selected);
  assert.equal(duplicate.value.cursor, 18); assert.equal(duplicate.value.pendingRun, false);
  assert.deepEqual(duplicate.value.events, []); assert.deepEqual(duplicate.value.seen, last.value.seen);
  assert.deepEqual(historyOf(duplicate), historyOf(last)); assert.deepEqual(duplicate.work.notifications, []);
  await f.reopen(); f.clock.advance(1000);
  const before = await f.current(), beforeEvents = await f.state.events(f.workId, 0);
  f.page('observations', { cursor: 19, snapshotDigest: 'old-original-conflict', events: [{ ...originals[0]!, body: { changed: true } }] });
  await assert.rejects(f.missions.refresh(f.workId), /mission_event_identity_conflict/);
  assert.deepEqual(await f.current(), before); assert.deepEqual(await f.state.events(f.workId, 0), beforeEvents);
  await preserved(f, admitted);
  t.diagnostic(JSON.stringify({ acceptedUniqueEvents: 544, sourcePages: 17, checkpointBytes: last.bytes.byteLength,
    currentSeen: last.value.seen.length, anchoredSegments: 1, modelCalls: 0, localReadCalls: f.tool.invocations.length }));
});

test('mission seen history refuses a missing retained receipt after reopen without advancing the source cursor', { timeout: 60000 }, async t => {
  const { f, history, anchor, admitted } = await rotated(t), before = await f.current(), beforeEvents = await f.state.events(f.workId, 0);
  assert.equal(before.artifacts.some(ref => ref.id === anchor.artifact.id), false, 'the anchor is located through its original receipt, not the current artifact projection');
  const receipt = f.state.receipt.bind(f.state); let attempted = 0;
  f.state.receipt = async (workId, commandId) => {
    if (workId === f.workId && commandId === anchor.subscription.checkpointId) { attempted++; return null; }
    return receipt(workId, commandId);
  };
  f.page('observations', { cursor: 44, snapshotDigest: 'unknown-old-identity', events: [history[0]!] });
  try { await assert.rejects(f.missions.refresh(f.workId), /mission_state_changed|mission_checkpoint_unavailable/); }
  finally { f.state.receipt = receipt; }
  assert.ok(attempted > 0); assert.deepEqual(await f.current(), before);
  assert.deepEqual(await f.state.events(f.workId, 0), beforeEvents); await preserved(f, [anchor, admitted]);
  assert.equal(f.planner.inputs.length + f.tool.invocations.length, 0);
});

test('mission seen history applies the current artifact restriction to retained segments without treating their IDs as fresh', { timeout: 60000 }, async t => {
  const { f, history, anchor, admitted } = await rotated(t);
  await f.edit(state => {
    assert.ok(state.dataLifecycle); assert.equal(state.dataLifecycle.generation, 1);
    state.dataLifecycle.blockedArtifactIds = [anchor.artifact.id];
  });
  const before = await f.current(), beforeEvents = await f.state.events(f.workId, 0);
  f.page('observations', { cursor: 44, snapshotDigest: 'blocked-old-identity', events: [history[0]!] });
  await assert.rejects(f.missions.refresh(f.workId), /mission_state_changed|mission_checkpoint_unavailable|artifact_access_denied/);
  assert.deepEqual(await f.current(), before); assert.deepEqual(await f.state.events(f.workId, 0), beforeEvents);
  await preserved(f, [anchor, admitted]); assert.equal(f.planner.inputs.length + f.tool.invocations.length, 0);
});
