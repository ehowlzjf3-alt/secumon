import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { CommitRequest } from '../application/ports.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { FileJournalStateRepository, JournalStateError, type JournalStage } from '../infrastructure/file-journal-state.js';
import { residentEntryFixture, residentEvent } from './resident-missions-entry-fixture.js';
import { missionBounded, missionGate } from './host-missions-registration-fixture.js';

const options = { timeout: 120000 };
const view = z.object({ cursor: z.number(), pending: z.array(z.unknown()), seen: z.array(z.unknown()), status: z.string(),
  suspended: z.boolean().optional(), claim: z.object({ owner: z.string(), until: z.number() }).nullable() });
function outcome<T>(promise: Promise<T>) { return promise.then(value => ({ kind: 'returned' as const, value }), error => ({ kind: 'rejected' as const, error })); }
function errors(error: unknown): unknown[] { return error instanceof AggregateError ? [error, ...error.errors.flatMap(errors)] : [error]; }

async function fixture(t: TestContext) {
  const f = await residentEntryFixture(t, false, { stateBackend: 'file-journal' }), p = f.current(), driver = f.driver();
  assert.equal(p.stateBackend, 'file-journal'); assert.ok(p.services.state instanceof FileJournalStateRepository);
  const registered = await f.register(), repository = p.services.state, originalCommit = repository.commit.bind(repository);
  const selected = new FileAgentProfileStore(fileURLToPath(new URL('../../', import.meta.url))).inspect(join(f.base, 'first'));
  assert.equal(selected.status, 'ready'); if (selected.status !== 'ready') throw new Error('fixture_profile_not_ready');
  const fault: { armed: JournalStage | null; fired: number; request?: CommitRequest; stage?: JournalStage; error?: unknown } = { armed: null, fired: 0 };
  const cause = new Error('injected_resident_journal_stage');
  // The ordinary profile still reads the same journal. Only its selected commit uses the existing real stage hook.
  const writer = new FileJournalStateRepository(selected.paths.state, { ...repository.options, onCommitStage(stage, identity) {
    const request = fault.request;
    if (!request || fault.armed !== stage || identity.workId !== request.workId || identity.revision !== request.next.revision) return;
    fault.armed = null; fault.stage = stage; fault.fired++; throw cause;
  } });
  repository.commit = async request => {
    if (!fault.armed || request.workId !== registered.workId || !request.events.some(event => event.type === 'resident_checkpoint'))
      return originalCommit(request);
    fault.request = structuredClone(request);
    try { return await writer.commit(request); }
    catch (error) { fault.error = error; throw error; }
  };
  const polls: { entered: ReturnType<typeof missionGate>; release: ReturnType<typeof missionGate>;
    finished: ReturnType<typeof missionGate>; signal?: AbortSignal; left: boolean }[] = [];
  f.pages.first.push([residentEvent('late-original', 'ORIGINAL_NOT_ACCEPTED_AFTER_CONTROL')]);
  f.controls.beforePoll = async (role, signal) => {
    assert.equal(role, 'first'); const poll = polls.find(value => !value.signal); assert.ok(poll);
    poll.signal = signal; poll.entered.release();
    try { await poll.release.promise; } finally { poll.left = true; poll.finished.release(); }
  };
  function hold() {
    const poll = { entered: missionGate(), release: missionGate(), finished: missionGate(), left: false };
    polls.push(poll); return polls.at(-1)!;
  }
  async function record() {
    const state = await p.services.state.get(registered.workId); assert.ok(state);
    const subscription = state.subscriptions!.find(value => value.provider === 'resident-mission'); assert.ok(subscription);
    const artifact = state.artifacts.find(value => subscription.checkpointId === `resident:${value.sha256}`); assert.ok(artifact);
    const receipt = await p.services.state.receipt(state.id, subscription.checkpointId); assert.ok(receipt);
    const bytes = await p.services.artifacts.get(artifact, state.policy);
    return { state, subscription, artifact, receipt, bytes, checkpoint: view.parse(JSON.parse(new TextDecoder().decode(bytes))) };
  }
  async function preserve(original: Awaited<ReturnType<typeof record>>) {
    assert.deepEqual(await p.services.state.receipt(registered.workId, original.subscription.checkpointId), original.receipt);
    assert.deepEqual(await p.services.artifacts.get(original.artifact, original.state.policy), original.bytes);
    const current = await p.services.state.get(registered.workId); assert.ok(current);
    assert.deepEqual(current.budget, original.state.budget); assert.deepEqual(current.attempts, original.state.attempts);
    assert.deepEqual(current.modelCalls, original.state.modelCalls); assert.deepEqual(current.evidence, original.state.evidence);
    assert.equal(f.observed.inputs.first.length + f.observed.inputs.second.length, 0);
    assert.deepEqual(current.notifications, original.state.notifications);
  }
  async function dispose() {
    repository.commit = originalCommit;
    for (const poll of polls) poll.release.release();
    await missionBounded(Promise.all(polls.filter(value => value.signal).map(value => value.finished.promise)));
    await writer.close();
  }
  return { f, p, driver, workId: registered.workId, repository, fault, cause, hold, record, preserve, dispose };
}

for (const action of ['pause', 'stop'] as const) test(`resident command recovery: post-publication ${action} cancels the original poll but preserves the unknown commit error`, options, async t => {
  const h = await fixture(t), raw = h.hold(), running = outcome(h.driver.tick(h.workId));
  try {
    await missionBounded(raw.entered.promise); const original = await h.record(); assert.ok(original.checkpoint.claim);
    h.fault.armed = 'published';
    const controlled = await outcome<unknown>(h.driver[action](h.workId)); assert.equal(controlled.kind, 'rejected');
    if (controlled.kind === 'rejected') { assert.equal(controlled.error, h.fault.error); assert.ok(controlled.error instanceof JournalStateError);
      assert.equal(controlled.error.code, 'journal_commit_unknown'); assert.equal(controlled.error.cause, h.cause); }
    assert.equal(h.fault.fired, 1); assert.equal(h.fault.stage, 'published');
    assert.equal((await missionBounded(running)).kind, 'rejected'); assert.equal(raw.left, false); assert.equal(raw.signal!.aborted, true);
    const saved = await h.record(); assert.equal(saved.checkpoint.claim, null); assert.equal(saved.checkpoint.cursor, 0);
    assert.equal(saved.checkpoint.status, action === 'stop' ? 'closed' : 'active');
    assert.equal(Boolean(saved.checkpoint.suspended), action === 'pause');
    assert.deepEqual(saved.checkpoint.pending, []); assert.deepEqual(saved.checkpoint.seen, []);
    const published = await h.repository.receipt(h.workId, h.fault.request!.commandId); assert.ok(published);
    assert.equal(published.digest, h.fault.request!.commandDigest); assert.deepEqual(published.state, h.fault.request!.next);
    assert.equal((await h.repository.events(h.workId, 0)).filter(value => value.commandId === h.fault.request!.commandId).length, 1);
    await h.driver[action](h.workId); assert.deepEqual((await h.record()).state, saved.state);
    raw.release.release(); await missionBounded(raw.finished.promise); await h.preserve(original);
    assert.deepEqual((await h.record()).state, saved.state); assert.equal(h.f.observed.polls.length, 1);
  } finally { await h.dispose(); await missionBounded(running); }
});

test('resident command recovery: a pre-publication failure neither cancels the poll nor claims a committed control', options, async t => {
  const h = await fixture(t), raw = h.hold(), running = outcome(h.driver.tick(h.workId));
  try {
    await missionBounded(raw.entered.promise); const original = await h.record(), events = await h.repository.events(h.workId, 0);
    h.fault.armed = 'candidate_synced';
    await assert.rejects(h.driver.pause(h.workId), error => error === h.cause);
    assert.equal(h.fault.stage, 'candidate_synced'); assert.equal(h.fault.fired, 1);
    assert.equal(await h.repository.receipt(h.workId, h.fault.request!.commandId), null);
    assert.deepEqual((await h.record()).state, original.state); assert.deepEqual(await h.repository.events(h.workId, 0), events);
    assert.equal(raw.signal!.aborted, false); assert.equal(raw.left, false);
    await h.driver.pause(h.workId); assert.equal((await missionBounded(running)).kind, 'rejected');
    assert.equal(raw.signal!.aborted, true); assert.equal(raw.left, false); await h.preserve(original);
  } finally { await h.dispose(); await missionBounded(running); }
});

test('resident command recovery: a failed receipt lookup preserves both errors and a paused retry recovers the missed cancellation', options, async t => {
  const h = await fixture(t), raw = h.hold(), running = outcome(h.driver.tick(h.workId));
  const receipt = h.repository.receipt.bind(h.repository), lookupError = new Error('original_control_receipt_read_failed'); let lookups = 0;
  try {
    await missionBounded(raw.entered.promise); const original = await h.record(); h.fault.armed = 'published';
    h.repository.receipt = async (workId, commandId) => {
      if (h.fault.fired && commandId === h.fault.request?.commandId) { lookups++; throw lookupError; }
      return receipt(workId, commandId);
    };
    const result = await outcome(h.driver.pause(h.workId)); assert.equal(result.kind, 'rejected');
    if (result.kind === 'rejected') { assert.ok(errors(result.error).includes(h.fault.error)); assert.ok(errors(result.error).includes(lookupError)); }
    h.repository.receipt = receipt;
    assert.equal(lookups, 1); assert.equal(raw.signal!.aborted, false); assert.equal(raw.left, false);
    const saved = await h.record(); assert.equal(saved.checkpoint.suspended, true); assert.equal(saved.checkpoint.claim, null);
    await h.driver.pause(h.workId); assert.equal((await missionBounded(running)).kind, 'rejected');
    assert.equal(raw.signal!.aborted, true); assert.equal(raw.left, false);
    assert.deepEqual((await h.record()).state, saved.state); await h.preserve(original);
    assert.equal((await h.repository.events(h.workId, 0)).filter(value => value.commandId === h.fault.request!.commandId).length, 1);
  } finally { h.repository.receipt = receipt; await h.dispose(); await missionBounded(running); }
});

test('resident command recovery: a receipt lookup delayed across resume cancels only the old revision and preserves the new poll', options, async t => {
  const h = await fixture(t), oldRaw = h.hold(), oldRun = outcome(h.driver.tick(h.workId));
  const receipt = h.repository.receipt.bind(h.repository), entered = missionGate(), release = missionGate();
  let gated = false, newRun: typeof oldRun | undefined;
  let pausing: ReturnType<typeof outcome> | undefined;
  try {
    await missionBounded(oldRaw.entered.promise); const original = await h.record(); h.fault.armed = 'published';
    h.repository.receipt = async (workId, commandId) => {
      const value = await receipt(workId, commandId);
      if (!gated && h.fault.fired && commandId === h.fault.request?.commandId) {
        assert.ok(value); gated = true; entered.release(); await release.promise;
      }
      return value;
    };
    pausing = outcome(h.driver.pause(h.workId)); await missionBounded(entered.promise);
    const paused = await h.record(); assert.equal(paused.checkpoint.suspended, true); assert.equal(oldRaw.signal!.aborted, false);
    await h.driver.resume(h.workId); const newRaw = h.hold(); newRun = outcome(h.driver.tick(h.workId));
    await missionBounded(newRaw.entered.promise); const current = await h.record(); assert.ok(current.checkpoint.claim);
    assert.ok(current.state.revision > h.fault.request!.next.revision);
    release.release(); const recovered = await missionBounded(pausing); assert.equal(recovered.kind, 'rejected');
    if (recovered.kind === 'rejected') assert.equal(recovered.error, h.fault.error);
    assert.equal((await missionBounded(oldRun)).kind, 'rejected'); assert.equal(oldRaw.signal!.aborted, true);
    assert.equal(newRaw.signal!.aborted, false); assert.equal(oldRaw.left, false); assert.equal(newRaw.left, false);
    assert.deepEqual((await h.record()).state, current.state); await h.preserve(original); await h.preserve(paused);
    assert.deepEqual(await receipt(h.workId, h.fault.request!.commandId), paused.receipt);
    // This is an explicit new control, not a replay of the previous call without an intent identifier.
    await h.driver.pause(h.workId); assert.equal((await missionBounded(newRun)).kind, 'rejected');
    assert.equal(newRaw.signal!.aborted, true); assert.equal(h.f.observed.polls.length, 2);
  } finally {
    release.release(); h.repository.receipt = receipt; await h.dispose();
    await missionBounded(Promise.allSettled([oldRun, newRun, pausing]));
  }
});
