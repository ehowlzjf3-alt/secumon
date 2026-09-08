import test from 'node:test';
import assert from 'node:assert/strict';
import type { WebResidentMissionCommandResult, WebResidentMissionStatus } from '../presentation/web-contracts.js';
import { BrowserResidentMissionControls } from '../presentation/web/resident-missions.js';

function status(workId = 'controller-a', revision = 0, state: WebResidentMissionStatus['status'] = 'active'): WebResidentMissionStatus {
  return { workId, sessionId: 'event-session', rule: { id: 'rule', sourceId: 'source', resourceId: 'resource', pollIntervalMs: 1000,
    maxResumes: 8, maxIdlePolls: 16, maxNoProgress: 3 }, status: state, reason: null, cursor: 2, nextPollAt: 1000,
    events: [{ id: 'seen-event', digest: 'a'.repeat(64), workId: 'old-event-work' }], pending: [{ eventId: 'new-event', workId: null }],
    controlRevision: revision, stateRevision: revision + 10 };
}

test('resident web controls keep a lost-response command through fresh status reads and controller switches', () => {
  const controls = new BrowserResidentMissionControls(); let generated = 0; const next = () => `command-${++generated}`;
  controls.receive('controller-a', status());
  const original = controls.prepare('controller-a', 'pause', next);
  assert.equal(controls.reject(original, null), false);
  controls.receive('controller-a', status('controller-a', 3));
  controls.receive('controller-b', status('controller-b', 6, 'paused'));
  const other = controls.prepare('controller-b', 'resume', next);
  const retry = controls.prepare('controller-a', 'pause', next);
  assert.strictEqual(retry, original); assert.equal(generated, 2);
  assert.deepEqual(retry.command, { commandId: 'command-1', expectedControlRevision: 0, kind: 'pause' });
  assert.throws(() => controls.prepare('controller-a', 'stop', next), /resident_command_pending/);
  const current = controls.complete(retry, { commandId: original.command.commandId, replayed: true, appliedControlRevision: 1,
    appliedStateRevision: 11, current: status('controller-a', 3) });
  assert.equal(current.status, 'active', 'an old pause receipt does not overwrite the newer current state');
  assert.equal(controls.pending('controller-a'), null); assert.strictEqual(controls.pending('controller-b'), other);
});

test('resident web controls distinguish an unresolved response from a confirmed rejection before a new command', () => {
  const controls = new BrowserResidentMissionControls(); controls.receive('controller-a', status());
  const command = controls.prepare('controller-a', 'pause', () => 'first');
  for (const code of ['resident_mission_changed', 'resident_access_denied', 'mission_source_unavailable', 'journal_commit_unknown']) {
    assert.equal(controls.reject(command, code), false); assert.strictEqual(controls.pending('controller-a'), command);
  }
  const good: WebResidentMissionCommandResult = { commandId: 'first', replayed: false, appliedControlRevision: 1,
    appliedStateRevision: 11, current: status('controller-a', 1, 'paused') };
  for (const result of [{ ...good, commandId: 'other' }, { ...good, current: status('controller-b', 1, 'paused') },
    { ...good, appliedControlRevision: 2 }]) {
    assert.throws(() => controls.complete(command, result), /resident_response_mismatch|resident_view_invalid/);
    assert.strictEqual(controls.pending('controller-a'), command); assert.equal(controls.view('controller-a')?.controlRevision, 0);
  }
  assert.equal(controls.reject(command, 'resident_control_stale'), true);
  assert.equal(controls.pending('controller-a'), null); assert.equal(controls.view('controller-a'), null);
  assert.throws(() => controls.prepare('controller-a', 'pause', () => 'too-early'), /resident_view_required/);
  controls.receive('controller-a', status('controller-a', 4));
  assert.equal(controls.prepare('controller-a', 'pause', () => 'second').command.expectedControlRevision, 4);
});

test('resident web controls retain only display summaries and discard protected state when the connection expires', () => {
  const controls = new BrowserResidentMissionControls(), source = status();
  controls.receive(source.workId, source); const ticket = controls.prepare(source.workId, 'pause', () => 'request');
  source.pending.push({ eventId: 'external-change', workId: 'another-work' }); source.status = 'closed';
  assert.deepEqual(controls.view('controller-a'), { workId: 'controller-a', status: 'active', controlRevision: 0,
    stateRevision: 10, nextPollAt: 1000, pendingCount: 1 });
  assert.ok(Object.isFrozen(ticket)); assert.ok(Object.isFrozen(ticket.command));
  controls.receive('closed', status('closed', 8, 'closed'));
  for (const kind of ['pause', 'resume', 'stop'] as const) assert.throws(() => controls.prepare('closed', kind, () => 'no-command'), /resident_view_required/);
  controls.clear(); assert.equal(controls.view('controller-a'), null); assert.equal(controls.pending('controller-a'), null);
  assert.throws(() => controls.complete(ticket, { commandId: 'request', replayed: false, appliedControlRevision: 1,
    appliedStateRevision: 11, current: status('controller-a', 1, 'paused') }), /resident_response_mismatch/);
  assert.equal(controls.view('controller-a'), null);
});
