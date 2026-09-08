import test from 'node:test';
import assert from 'node:assert/strict';
import type { WebResidentMissionCommandResult, WebResidentMissionStatus } from '../presentation/web-contracts.js';
import type { ResidentCommandPersistence, ResidentCommandTicket } from '../presentation/web/resident-command-store.js';
import { BrowserResidentMissionControls } from '../presentation/web/resident-missions.js';

function ticket(workId: string, commandId: string, revision = 4): ResidentCommandTicket {
  return { workId, command: { commandId, expectedControlRevision: revision, kind: 'pause' } };
}
function status(workId: string, revision = 4): WebResidentMissionStatus {
  return { workId, sessionId: 'event-session', rule: { id: 'rule', sourceId: 'source', resourceId: 'resource', pollIntervalMs: 1000,
    maxResumes: 8, maxIdlePolls: 16, maxNoProgress: 3 }, status: 'active', reason: null, cursor: 2, nextPollAt: 1000,
    events: [{ id: 'seen', digest: 'a'.repeat(64), workId: 'past-event-work' }], pending: [{ eventId: 'waiting', workId: null }],
    controlRevision: revision, stateRevision: revision + 10 };
}
function receipt(saved: ResidentCommandTicket, revision = 5): WebResidentMissionCommandResult {
  return { commandId: saved.command.commandId, replayed: true, appliedControlRevision: saved.command.expectedControlRevision + 1,
    appliedStateRevision: saved.command.expectedControlRevision + 11, current: status(saved.workId, revision) };
}
function persistence(initial: readonly ResidentCommandTicket[] = []) {
  let durable: readonly ResidentCommandTicket[] = structuredClone(initial), saves = 0, failure: Error | null = null;
  let onSave: (() => void) | null = null;
  const store: ResidentCommandPersistence = {
    load() { return Object.freeze(durable.map(value => Object.freeze({ workId: value.workId, command: Object.freeze({ ...value.command }) }))); },
    save(tickets) { saves++; onSave?.(); if (failure) throw failure; durable = structuredClone(tickets); },
  };
  return { store, snapshot: () => structuredClone(durable), get saves() { return saves; },
    failWrites(error: Error | null) { failure = error; }, beforeSave(callback: (() => void) | null) { onSave = callback; } };
}

test('resident command recovery restores the same command identity and basis without restoring a trusted status view', () => {
  const saved = persistence(), original = new BrowserResidentMissionControls(saved.store);
  original.receive('controller-a', status('controller-a'));
  const first = original.prepare('controller-a', 'pause', () => 'original-id');
  const durable = saved.snapshot(), writes = saved.saves, restored = new BrowserResidentMissionControls(saved.store);
  assert.equal(restored.view('controller-a'), null); assert.deepEqual(restored.listPending(), [first]);
  const retry = restored.prepare('controller-a', 'pause', () => { throw new Error('must_not_allocate_a_retry_id'); });
  assert.deepEqual(retry, first); assert.deepEqual(saved.snapshot(), durable); assert.equal(saved.saves, writes);
  assert.ok(Object.isFrozen(retry)); assert.ok(Object.isFrozen(retry.command));
  assert.throws(() => restored.prepare('controller-a', 'stop', () => 'wrong-id'), /resident_command_pending/);
});

test('resident command recovery keeps durable requests through status refresh, view invalidation and authentication clear', () => {
  const first = ticket('controller-a', 'first'), second = ticket('controller-b', 'second', 8);
  const saved = persistence([first, second]), controls = new BrowserResidentMissionControls(saved.store);
  controls.receive('controller-a', status('controller-a', 12)); controls.invalidate('controller-a'); controls.clear();
  assert.deepEqual(controls.listPending(), []); assert.equal(controls.view('controller-a'), null); assert.equal(saved.saves, 0);
  assert.deepEqual(saved.snapshot(), [first, second]);
  const restored = new BrowserResidentMissionControls(saved.store);
  assert.deepEqual(restored.listPending(), [first, second]); assert.equal(restored.view('controller-a'), null);
  assert.equal(restored.pending('controller-a')?.command.expectedControlRevision, 4);
});

test('resident command recovery exposes no sendable new command if persistence fails before prepare completes', () => {
  const existing = ticket('controller-a', 'already-pending'), saved = persistence([existing]);
  const controls = new BrowserResidentMissionControls(saved.store), failure = new Error('storage_write_failed');
  controls.receive('controller-b', status('controller-b', 9));
  saved.beforeSave(() => { assert.equal(controls.pending('controller-b'), null); assert.deepEqual(controls.listPending(), [existing]); });
  saved.failWrites(failure); let dispatched = 0;
  assert.throws(() => { controls.prepare('controller-b', 'pause', () => 'not-sent'); dispatched++; }, error => error === failure);
  assert.equal(dispatched, 0); assert.equal(controls.pending('controller-b'), null);
  assert.deepEqual(controls.listPending(), [existing]); assert.deepEqual(saved.snapshot(), [existing]);
  saved.beforeSave(null); saved.failWrites(null);
  const pending = controls.prepare('controller-b', 'pause', () => 'durably-prepared');
  assert.deepEqual(saved.snapshot(), [existing, pending]); assert.strictEqual(controls.pending('controller-b'), pending);
});

test('resident command recovery retains the original ticket when a confirmed result cannot be removed from persistence', () => {
  const first = ticket('controller-a', 'first'), second = ticket('controller-b', 'second');
  const saved = persistence([first, second]), controls = new BrowserResidentMissionControls(saved.store), failure = new Error('delete_failed');
  const restored = controls.pending('controller-a'); assert.ok(restored);
  saved.beforeSave(() => { assert.strictEqual(controls.pending('controller-a'), restored); }); saved.failWrites(failure);
  assert.throws(() => controls.complete(restored, receipt(restored)), error => error === failure);
  assert.strictEqual(controls.pending('controller-a'), restored); assert.deepEqual(saved.snapshot(), [first, second]);
  assert.strictEqual(controls.prepare('controller-a', 'pause', () => { throw new Error('new_id_for_existing_request'); }), restored);
  saved.beforeSave(null); saved.failWrites(null);
  const fresh = new BrowserResidentMissionControls(saved.store), retry = fresh.pending('controller-a'); assert.ok(retry);
  const current = fresh.complete(retry, receipt(retry, 10));
  assert.equal(current.controlRevision, 10); assert.equal(fresh.pending('controller-a'), null);
  assert.deepEqual(saved.snapshot(), [second]); assert.deepEqual(fresh.listPending(), [second]);
});

test('resident command recovery preserves an unresolved or failed-to-delete stale request while retaining other controllers', () => {
  const first = ticket('controller-a', 'first'), second = ticket('controller-b', 'second');
  const saved = persistence([first, second]), controls = new BrowserResidentMissionControls(saved.store);
  const restored = controls.pending('controller-a'); assert.ok(restored);
  for (const code of [null, 'resident_mission_changed', 'journal_commit_unknown', 'resident_access_denied'])
    assert.equal(controls.reject(restored, code), false);
  assert.equal(saved.saves, 0); assert.deepEqual(saved.snapshot(), [first, second]);
  const failure = new Error('stale_receipt_delete_failed'); saved.failWrites(failure);
  assert.throws(() => controls.reject(restored, 'resident_control_stale'), error => error === failure);
  assert.strictEqual(controls.pending('controller-a'), restored); assert.deepEqual(saved.snapshot(), [first, second]);
  saved.failWrites(null); assert.equal(controls.reject(restored, 'resident_control_stale'), true);
  assert.equal(controls.view('controller-a'), null); assert.deepEqual(controls.listPending(), [second]);
  assert.deepEqual(new BrowserResidentMissionControls(saved.store).listPending(), [second]);
  controls.receive('controller-a', status('controller-a', 15));
  const next = controls.prepare('controller-a', 'pause', () => 'after-confirmed-rejection');
  assert.equal(next.command.expectedControlRevision, 15);
  assert.deepEqual(new Map(saved.snapshot().map(value => [value.workId, value])), new Map([second, next].map(value => [value.workId, value])));
});

test('resident command recovery does not delete a restored request for another receipt or an older status response', () => {
  const first = ticket('controller-a', 'first'), second = ticket('controller-b', 'second');
  const saved = persistence([first, second]), controls = new BrowserResidentMissionControls(saved.store);
  const restored = controls.pending('controller-a'); assert.ok(restored); controls.receive('controller-a', status('controller-a', 9));
  for (const result of [{ ...receipt(restored, 9), commandId: 'different' },
    { ...receipt(restored, 9), current: status('controller-b', 9) }, receipt(restored, 5)]) {
    assert.throws(() => controls.complete(restored, result), /resident_response_mismatch|resident_view_invalid/);
    assert.strictEqual(controls.pending('controller-a'), restored); assert.deepEqual(saved.snapshot(), [first, second]);
    assert.equal(saved.saves, 0);
  }
  controls.complete(restored, receipt(restored, 9)); assert.deepEqual(saved.snapshot(), [second]);
  assert.deepEqual(new BrowserResidentMissionControls(saved.store).listPending(), [second]);
});
