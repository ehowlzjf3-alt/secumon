import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { setImmediate as drain } from 'node:timers/promises';
import type { MissionEventSource, MissionPage } from '../application/mission-contracts.js';
import type { RuntimeServices } from '../application/services.js';
import type { SessionService } from '../application/session-service.js';
import type { UserCommand } from '../application/execution-runtime.js';
import type { WorkState } from '../domain/model.js';
import { executionControl } from '../domain/execution-policy.js';
import { asJson } from '../application/plan-validator.js';
import { JournalStateError, type JournalOptions, type JournalStage } from '../infrastructure/file-journal-state.js';
import { sha256 } from '../infrastructure/digest.js';
import { bounded, event, gate, missionFixture, rule } from './mission-runtime-fixture.js';
import { RESIDENT_RULE, residentEntryFixture, residentEvent } from './resident-missions-entry-fixture.js';

type PollInput = Parameters<MissionEventSource['poll']>[0];
type Services = Pick<RuntimeServices, 'state' | 'artifacts' | 'digester'>;
const wait = <T>(pending: Promise<T>) => bounded(pending, 15000);
function observe(pending: Promise<unknown>) {
  return pending.then(value => ({ kind: 'returned' as const, value }), error => ({ kind: 'rejected' as const, error: error as unknown }));
}
function unknown(result: Awaited<ReturnType<typeof observe>>, cause: Error) {
  assert.ok(result.kind === 'rejected'); assert.ok(result.error instanceof JournalStateError);
  assert.equal(result.error.code, 'journal_commit_unknown'); assert.equal(result.error.cause, cause);
}
function stopped(result: Awaited<ReturnType<typeof observe>>, signal: AbortSignal) {
  assert.ok(result.kind === 'rejected'); assert.ok(result.error instanceof Error);
  assert.equal(result.error.name, 'AbortError'); assert.equal(signal.aborted, true); assert.equal(result.error, signal.reason);
}
function noncooperative(page: MissionPage, failure?: Error) {
  const entered = gate<PollInput>(), release = gate<void>(), finished = gate<void>(); let started = false, settled = false;
  const poll: MissionEventSource['poll'] = async input => {
    started = true; entered.resolve(input);
    try { await release.promise; if (failure) throw failure; return structuredClone(page); }
    finally { settled = true; finished.resolve(); }
  };
  return { entered, release, finished, poll, get started() { return started; }, get settled() { return settled; } };
}
function journalFault(stage: JournalStage) {
  const failure = new Error('injected_command_' + stage); let target: { workId: string; revision: number } | null = null, injections = 0;
  const options: JournalOptions = { onCommitStage(current, identity) {
    if (current !== stage || !target || injections || identity.workId !== target.workId || identity.revision !== target.revision) return;
    injections++; throw failure;
  } };
  return { options, failure, arm(work: WorkState) { target = { workId: work.id, revision: work.revision + 1 }; }, get injections() { return injections; } };
}
function recordPath(root: string, workId: string, revision: number) {
  return join(fs.realpathSync(root), sha256(workId), String(revision).padStart(16, '0') + '.json');
}
async function record(services: Services, sessions: SessionService, workId: string, commandId: string) {
  const state = await services.state.get(workId); assert.ok(state);
  const session = state.conversation?.session; assert.ok(session);
  const ids = [...new Set(['conversation.accept', commandId, ...(state.subscriptions ?? []).map(value => value.checkpointId)])];
  return { state, receipts: await Promise.all(ids.map(async id => ({ id, value: await services.state.receipt(workId, id) }))),
    originals: await Promise.all(state.artifacts.map(async artifact => ({ artifact, bytes: await services.artifacts.get(artifact, state.policy) }))),
    input: await sessions.repository.input(session.scope, session.input.messageId),
    events: await services.state.events(workId, 0), deliveries: await services.state.deliveries(workId) };
}
function commandInput(services: Services, state: WorkState, messageId: string, kind: 'pause' | 'cancel' | 'goal' | 'input') {
  const session = state.conversation?.session; assert.ok(session);
  const command: UserCommand = kind === 'goal' ? { kind, goal: { ...state.goal, revision: state.goal.revision + 1, description: 'Review the revised original question.' },
    expectedControlRevision: executionControl(state).revision } : { kind, reason: 'Explicit control during an unfinished observation.' };
  const value = { sessionId: session.scope.sessionId, messageId, workId: state.id, rawText: 'Apply ' + kind + ' to this work.', expectedGoalRevision: state.goal.revision, command };
  return { value, scope: session.scope, commandId: 'session-command:' + services.digester.digest(asJson([session.scope, messageId])) };
}
async function seeded(t: TestContext, options: JournalOptions = {}) {
  const f = await missionFixture(t, ['observations'], { stateBackend: 'file-journal', journalOptions: options });
  await f.missions.register(f.workId, rule());
  f.page('observations', { cursor: 1, snapshotDigest: 'original-page', events: [event()] });
  await f.missions.refresh(f.workId); const original = await f.checkpoint();
  assert.equal((await f.missions.tick(f.workId, f.bundle.workflow)).kind, 'ran');
  const before = await f.checkpoint(); assert.equal(before.value.cursor, 1); assert.equal(before.value.pendingRun, false);
  assert.equal(before.value.seen.length, 1); assert.deepEqual(original.value.events, [event()]);
  assert.equal(f.planner.inputs.length + f.tool.invocations.length, 0); f.clock.advance(1000);
  return { f, original, before };
}

for (const kind of ['pause', 'cancel', 'goal', 'input'] as const) {
  test(`mission command recovery: published ${kind} preserves its unknown error and recovers the original pending input`, { timeout: 60000 }, async t => {
    const fault = journalFault('published'), { f, original, before } = await seeded(t, fault.options), sessions = f.bundle.sessions!;
    const late = noncooperative({ cursor: 2, snapshotDigest: 'late-page', events: [event('late', 2100)] },
      kind === 'cancel' || kind === 'input' ? new Error('late_source_failure') : undefined);
    f.poll('observations', late.poll);
    const pending = observe(f.missions.refresh(f.workId)), request = commandInput(f.bundle.services, before.work, 'unknown-' + kind, kind);
    const originalRepository = f.state, readReceipt = originalRepository.receipt.bind(originalRepository); let receiptFailures = 0;
    // Only the first proof read after a real publication fails; the stored receipt itself remains intact.
    if (kind === 'pause') originalRepository.receipt = async (workId, commandId) => {
      if (fault.injections && !receiptFailures && workId === f.workId && commandId === request.commandId) {
        receiptFailures++; throw new Error('receipt_temporarily_unavailable');
      }
      return readReceipt(workId, commandId);
    };
    try {
      const input = await wait(late.entered.promise); assert.equal(input.cursor, 1); fault.arm(await f.current());
      unknown(await observe(sessions.command(f.actor, request.value)), fault.failure); assert.equal(fault.injections, 1);
      originalRepository.receipt = readReceipt;
      const published = await f.current(), receipt = await f.state.receipt(f.workId, request.commandId); assert.ok(receipt);
      assert.equal(published.revision, before.work.revision + 1); assert.equal(receipt.state.revision, published.revision);
      assert.deepEqual(receipt.state, published);
      assert.equal(receipt.digest, f.bundle.services.digester.digest(asJson({ type: 'user_command', data: { actor: f.actor,
        expectedGoalRevision: request.value.expectedGoalRevision, command: request.value.command, sessionInput: published.conversation!.session! } })));
      const target = recordPath(join(f.directory, 'journal'), f.workId, published.revision), raw = fs.readFileSync(target);
      const pendingInput = await sessions.repository.input(request.scope, request.value.messageId); assert.ok(pendingInput);
      assert.equal(pendingInput.status, 'pending'); assert.equal(pendingInput.text, request.value.rawText);
      assert.deepEqual(pendingInput.payload, { expectedGoalRevision: request.value.expectedGoalRevision, command: request.value.command });
      if (kind === 'pause') {
        assert.equal(receiptFailures, 1); assert.equal(input.signal.aborted, false); assert.equal(late.settled, false);
      } else { stopped(await wait(pending), input.signal); assert.equal(late.settled, false); }
      await sessions.resume(f.actor, request.scope.sessionId);
      stopped(await wait(pending), input.signal); assert.equal(late.settled, false);
      const applied = await sessions.repository.input(request.scope, request.value.messageId); assert.ok(applied);
      assert.equal(applied.status, 'applied');
      for (const key of ['scope', 'messageId', 'sequence', 'digest', 'text', 'payload', 'workId'] as const) assert.deepEqual(applied[key], pendingInput[key]);
      const recovered = await record(f.bundle.services, sessions, f.workId, request.commandId);
      assert.deepEqual(recovered.state, published); assert.deepEqual(recovered.state.budget, before.work.budget);
      assert.equal(recovered.events.filter(value => value.commandId === request.commandId).length, 1);
      late.release.resolve(); await wait(late.finished.promise); await drain();
      assert.deepEqual(await record(f.bundle.services, sessions, f.workId, request.commandId), recovered);
      assert.deepEqual(fs.readFileSync(target), raw);
      assert.deepEqual(await f.state.receipt(f.workId, original.subscription.checkpointId), original.receipt);
      assert.deepEqual(await f.artifacts.get(original.artifact, original.work.policy), original.bytes);
      await f.reopen();
      assert.deepEqual(await record(f.bundle.services, f.bundle.sessions!, f.workId, request.commandId), recovered);
      await f.bundle.sessions!.resume(f.actor, request.scope.sessionId);
      assert.deepEqual(await record(f.bundle.services, f.bundle.sessions!, f.workId, request.commandId), recovered);
      assert.deepEqual(fs.readFileSync(target), raw); assert.equal(fault.injections, 1);
      assert.equal(f.sourceCalls.length, 2); assert.equal(f.planner.inputs.length + f.tool.invocations.length, 0);
    } finally {
      // The old repository may already be closed after reopen; restoring its method does not perform I/O.
      originalRepository.receipt = readReceipt;
      late.release.resolve(); await wait(pending); if (late.started) await wait(late.finished.promise); await drain();
    }
  });
}

test('mission command recovery: failure before publication cannot cancel a poll, but retrying the original pending input can', { timeout: 60000 }, async t => {
  const fault = journalFault('candidate_synced'), { f, before } = await seeded(t, fault.options), sessions = f.bundle.sessions!;
  const request = commandInput(f.bundle.services, before.work, 'before-publication', 'pause');
  const previous = await record(f.bundle.services, sessions, f.workId, request.commandId);
  const late = noncooperative({ cursor: 2, snapshotDigest: 'discarded', events: [event('late', 2100)] }); f.poll('observations', late.poll);
  const pending = observe(f.missions.refresh(f.workId));
  try {
    const input = await wait(late.entered.promise); fault.arm(await f.current());
    const failed = await observe(sessions.command(f.actor, request.value)); assert.ok(failed.kind === 'rejected'); assert.equal(failed.error, fault.failure);
    assert.equal(fault.injections, 1); assert.equal(input.signal.aborted, false); assert.equal(late.settled, false);
    assert.equal(await f.state.receipt(f.workId, request.commandId), null);
    assert.equal(fs.existsSync(recordPath(join(f.directory, 'journal'), f.workId, before.work.revision + 1)), false);
    assert.deepEqual(await record(f.bundle.services, sessions, f.workId, request.commandId), previous);
    const originalInput = await sessions.repository.input(request.scope, request.value.messageId); assert.equal(originalInput?.status, 'pending');
    await sessions.resume(f.actor, request.scope.sessionId); stopped(await wait(pending), input.signal); assert.equal(late.settled, false);
    const applied = await sessions.repository.input(request.scope, request.value.messageId); assert.equal(applied?.status, 'applied');
    assert.equal(applied?.digest, originalInput?.digest); assert.equal(applied?.sequence, originalInput?.sequence);
    const recovered = await record(f.bundle.services, sessions, f.workId, request.commandId);
    assert.equal(recovered.state.revision, before.work.revision + 1); assert.equal(recovered.events.filter(value => value.commandId === request.commandId).length, 1);
    late.release.resolve(); await wait(late.finished.promise); await drain();
    assert.deepEqual(await record(f.bundle.services, sessions, f.workId, request.commandId), recovered);
    assert.equal(f.sourceCalls.length, 2); assert.equal(f.planner.inputs.length + f.tool.invocations.length, 0);
  } finally { late.release.resolve(); await wait(pending); if (late.started) await wait(late.finished.promise); await drain(); }
});

test('mission command recovery: replaying an old original or conflicting payload cannot cancel a later poll after explicit resume', { timeout: 60000 }, async t => {
  const { f, before } = await seeded(t), sessions = f.bundle.sessions!, request = commandInput(f.bundle.services, before.work, 'original-pause', 'pause');
  const first = noncooperative({ cursor: 2, snapshotDigest: 'discarded-first', events: [event('first-late', 2100)] }); f.poll('observations', first.poll);
  const a = observe(f.missions.refresh(f.workId)); let second: ReturnType<typeof noncooperative> | undefined, b: ReturnType<typeof observe> | undefined;
  try {
    const firstInput = await wait(first.entered.promise); await sessions.command(f.actor, request.value);
    stopped(await wait(a), firstInput.signal);
    const receipt = await f.state.receipt(f.workId, request.commandId); assert.ok(receipt); const originalInput = receipt.state.conversation?.session; assert.ok(originalInput);
    first.release.resolve(); await wait(first.finished.promise); await drain();
    await sessions.command(f.actor, { sessionId: request.scope.sessionId, workId: f.workId, messageId: 'explicit-resume', rawText: 'Continue observing.',
      expectedGoalRevision: receipt.state.goal.revision, command: { kind: 'resume', reason: 'Explicit resumption after confirmed pause.' } });
    second = noncooperative({ cursor: 2, snapshotDigest: 'new-page', events: [event('new-event', 2100)] }); f.poll('observations', second.poll);
    b = observe(f.missions.refresh(f.workId)); const secondInput = await wait(second.entered.promise);
    const beforeReplay = await record(f.bundle.services, sessions, f.workId, request.commandId);
    assert.ok(beforeReplay.state.revision > receipt.state.revision);
    // An applied inbox alone would skip runtime.command. Replay the exact original contract through its public API.
    const replayed = await f.bundle.runtime.command(f.workId, request.commandId, f.actor, request.value.expectedGoalRevision, request.value.command, originalInput);
    assert.deepEqual(replayed, beforeReplay.state); assert.equal(secondInput.signal.aborted, false); assert.equal(second.settled, false);
    assert.ok(request.value.command.kind === 'pause');
    await assert.rejects(f.bundle.runtime.command(f.workId, request.commandId, f.actor, request.value.expectedGoalRevision,
      { ...request.value.command, reason: 'Different payload with the same original command id.' }, originalInput), /idempotency_conflict/);
    assert.equal(secondInput.signal.aborted, false); assert.equal(second.settled, false);
    assert.deepEqual(await record(f.bundle.services, sessions, f.workId, request.commandId), beforeReplay);
    second.release.resolve(); assert.equal((await wait(b)).kind, 'returned');
    assert.deepEqual(await f.missions.readEvents(f.workId, rule().id), { rule: rule(), events: [event('new-event', 2100)], cursor: 2, status: 'active', reason: null });
    assert.deepEqual(await f.state.receipt(f.workId, request.commandId), receipt);
    assert.equal(f.sourceCalls.length, 3); assert.equal(f.planner.inputs.length + f.tool.invocations.length, 0);
  } finally {
    first.release.resolve(); second?.release.resolve(); await wait(a); if (b) await wait(b);
    for (const source of [first, second]) if (source?.started) await wait(source.finished.promise);
    await drain();
  }
});

/** Like journal-sync-boundary-worker: actual link first, then one EIO on the exact work directory's fsync. */
async function failPublishedSync(target: string, failure: Error, action: () => Promise<unknown>) {
  const owner = fs.lstatSync(dirname(target), { bigint: true }), link = fs.linkSync, sync = fs.fsyncSync, stat = fs.fstatSync;
  let publications = 0, failures = 0;
  fs.linkSync = (source, destination) => { link(source, destination); if (destination === target) publications++; };
  fs.fsyncSync = descriptor => {
    if (publications && !failures) {
      const current = stat(descriptor, { bigint: true });
      if (current.isDirectory() && current.dev === owner.dev && current.ino === owner.ino) { failures++; throw failure; }
    }
    sync(descriptor);
  };
  syncBuiltinESMExports();
  try { return { result: await observe(action()), publications, failures }; }
  finally { fs.linkSync = link; fs.fsyncSync = sync; syncBuiltinESMExports(); }
}

test('mission command recovery: an actual profile recovers a published fsync failure through its pending session input and reopens without execution',
  { timeout: 120000, concurrency: false, skip: process.platform === 'win32' ? 'This fault targets the POSIX journal namespace fsync boundary.' : false }, async t => {
    const f = await residentEntryFixture(t, false, { stateBackend: 'file-journal' }), p = f.current(); assert.equal(p.stateBackend, 'file-journal');
    const page = residentEvent('after-recovery', 'PRESERVED_PROFILE_SOURCE'); f.pages.first.push([page]);
    const session = await p.sessions.open(p.actor, { channel: 'test', conversationId: 'resident-conversation' });
    const accepted = await p.turns.accept(p.actor, { sessionId: session.scope.sessionId, messageId: 'profile-observation', rawText: 'Read the incoming original.',
      mode: 'auto', scope: p.scope, policy: p.policy, limits: p.limits, binding: f.binding('first') });
    assert.ok(p.missions); await p.missions.register(accepted.workId, RESIDENT_RULE);
    const before = await p.runtime.state(accepted.workId), request = commandInput(p.services, before, 'profile-unknown-pause', 'pause');
    const entered = gate<AbortSignal>(), release = gate<void>(), finished = gate<void>(); let started = false, settled = false;
    f.controls.beforePoll = async (role, signal) => { assert.equal(role, 'first'); started = true; entered.resolve(signal);
      try { await release.promise; } finally { settled = true; finished.resolve(); } };
    const pending = observe(p.missions.tick(accepted.workId, p.workflow));
    try {
      const signal = await wait(entered.promise), target = recordPath(join(f.base, 'first', '.secumon', 'state-journal'), accepted.workId, before.revision + 1);
      const failure = Object.assign(new Error('injected_profile_journal_sync_failure'), { code: 'EIO' });
      const injected = await failPublishedSync(target, failure, () => p.sessions.command(p.actor, request.value));
      assert.equal(injected.publications, 1); assert.equal(injected.failures, 1); unknown(injected.result, failure);
      const raw = fs.readFileSync(target), receipt = await p.services.state.receipt(accepted.workId, request.commandId); assert.ok(receipt);
      assert.equal(receipt.state.revision, before.revision + 1); assert.equal(receipt.state.status, 'paused');
      const inbox = await p.sessions.repository.input(request.scope, request.value.messageId); assert.equal(inbox?.status, 'pending');
      stopped(await wait(pending), signal); assert.equal(settled, false);
      await p.sessions.resume(p.actor, request.scope.sessionId);
      const applied = await p.sessions.repository.input(request.scope, request.value.messageId); assert.equal(applied?.status, 'applied');
      assert.equal(applied?.digest, inbox?.digest); assert.equal(applied?.sequence, inbox?.sequence);
      const recovered = await record(p.services, p.sessions, accepted.workId, request.commandId);
      assert.deepEqual(recovered.state, receipt.state); assert.deepEqual(recovered.state.budget, before.budget);
      assert.equal(recovered.events.filter(value => value.commandId === request.commandId).length, 1);
      release.resolve(); await wait(finished.promise); await drain(); delete f.controls.beforePoll;
      assert.deepEqual(await record(p.services, p.sessions, accepted.workId, request.commandId), recovered);
      await f.reopen(); const reopened = f.current(); assert.ok(reopened.missions);
      assert.deepEqual(await record(reopened.services, reopened.sessions, accepted.workId, request.commandId), recovered);
      await reopened.sessions.resume(reopened.actor, request.scope.sessionId);
      assert.deepEqual(await record(reopened.services, reopened.sessions, accepted.workId, request.commandId), recovered);
      await reopened.sessions.command(reopened.actor, { sessionId: request.scope.sessionId, workId: accepted.workId, messageId: 'profile-explicit-resume', rawText: 'Resume observation.',
        expectedGoalRevision: recovered.state.goal.revision, command: { kind: 'resume', reason: 'Explicitly resume after receipt recovery.' } });
      await reopened.missions.refresh(accepted.workId);
      assert.deepEqual(await reopened.missions.readEvents(accepted.workId, RESIDENT_RULE.id), { rule: RESIDENT_RULE, events: [page], cursor: 1, status: 'active', reason: null });
      assert.deepEqual(fs.readFileSync(target), raw); assert.deepEqual(await reopened.services.state.receipt(accepted.workId, request.commandId), receipt);
      const resumed = await reopened.runtime.state(accepted.workId);
      assert.deepEqual(resumed.budget, before.budget); assert.equal(resumed.attempts.length, 0);
      assert.equal(resumed.conversation?.session?.scope.sessionId, request.scope.sessionId);
      assert.equal(f.observed.inputs.first.length + f.observed.inputs.second.length, 0);
      assert.deepEqual(f.observed.polls, [{ role: 'first', cursor: 0 }, { role: 'first', cursor: 0 }]);
    } finally { release.resolve(); await wait(pending); if (started) await wait(finished.promise); await drain(); delete f.controls.beforePoll; }
  });
