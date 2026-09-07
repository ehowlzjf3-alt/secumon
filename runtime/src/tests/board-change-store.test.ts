import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdir, unlink } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { boardChangePage } from '../application/board-change-contracts.js';
import type { BoardCommit } from '../application/board-ports.js';
import type { BoardChange, BoardState } from '../domain/board.js';
import { sha256 } from '../infrastructure/digest.js';
import { boardRequestFixture as fixture } from './helpers/board-request-fixture.js';

const query = { afterRevision: 0, maxEvents: 64, maxBytes: 65536 };
function closed(prior: BoardState, id: string): BoardCommit {
  return { expectedRevision: prior.revision, commandId: id, commandDigest: sha256(id), disposition: 'not_applied',
    next: { ...structuredClone(prior), revision: prior.revision + 1 } };
}

for (const adapter of ['sqlite', 'file-journal'] as const) {
  test(`${adapter}: board transitions, receipts and event cursors persist together and duplicates do not add events`, async t => {
    const h = await fixture(t, adapter); await h.offer();
    const page = await h.repository.changes!('tenant-a', 'board', query);
    assert.deepEqual(page.events.map(value => value.revision), [1, 2, 3, 4]);
    assert.deepEqual(page.events.at(-1)!.requestIds, ['request']); assert.deepEqual(page.events.at(-1)!.roleIds, ['role-a', 'role-b']);
    assert.doesNotMatch(JSON.stringify(page), /Please examine|Cited answer|original-documents/);
    const command = closed((await h.repository.get('tenant-a', 'board'))!, 'close-unapplied');
    assert.equal((await h.repository.commit(command)).kind, 'not_applied');
    assert.equal((await h.repository.commit(command)).kind, 'not_applied');
    assert.equal((await h.repository.receipt('tenant-a', 'board', command.commandId))!.revision, 5);
    await h.reopen();
    const last = await h.repository.changes!('tenant-a', 'board', { ...query, afterRevision: 4 });
    assert.equal(last.events.length, 1); assert.deepEqual(last.events[0]!.requestIds, []); assert.equal(last.throughRevision, 5);
    const first = await h.repository.changes!('tenant-a', 'board', { ...query, maxEvents: 2 }); assert.equal(first.more, true); assert.equal(first.throughRevision, 2);
    const second = await h.repository.changes!('tenant-a', 'board', { ...query, afterRevision: first.throughRevision });
    assert.deepEqual(second.events.map(value => value.revision), [3, 4, 5]); assert.equal(second.more, false);
    await assert.rejects(h.repository.changes!('tenant-a', 'board', { ...query, afterRevision: 6 }), /board_event_cursor_ahead/);
    await assert.rejects(h.repository.changes!('foreign', 'board', query), /board_events_unavailable/);
  });

  test(`${adapter}: an event burst coalesces only after a complete current request scan`, async t => {
    const h = await fixture(t, adapter); const prior = await h.bundle('b').boardWatch!.register('work-b', 'board'); await h.offer();
    for (let index = 0; index < 40; index++) await h.repository.commit(closed((await h.repository.get('tenant-a', 'board'))!, `noop-${index}`));
    const page = await h.repository.changes!('tenant-a', 'board', { ...query, afterRevision: prior.subscriptions![0]!.cursor, maxEvents: 32 });
    assert.equal(page.more, true);
    const current = await h.bundle('b').boardWatch!.refresh('work-b');
    assert.equal(current.notifications?.length, 1); assert.equal(current.notifications![0]!.referenceId, 'request');
    assert.equal(current.subscriptions![0]!.cursor, page.headRevision); assert.equal(current.budget.used.modelCalls + current.budget.used.toolCalls, 0);
    assert.equal((await h.bundle('b').boardWatch!.refresh('work-b')).revision, current.revision);
  });

  test(`${adapter}: missing event history under an established root is rejected rather than silently skipped`, async t => {
    const h = await fixture(t, adapter); await h.offer();
    if (adapter === 'sqlite') {
      const db = new DatabaseSync(join(h.directory, 'board.sqlite'));
      try { db.exec('DELETE FROM board_events_v1 WHERE revision=3'); } finally { db.close(); }
    } else {
      const files = (await readdir(join(h.directory, 'boards'))).filter(value => value.endsWith('-00000003.json'));
      assert.equal(files.length, 1); await unlink(join(h.directory, 'boards', files[0]!));
    }
    await assert.rejects(h.repository.changes!('tenant-a', 'board', query), /board_event_gap|board_journal_gap/);
  });

  test(`${adapter}: an owned worker killed after commit leaves one event and the same command receipt`, { timeout: 60000 }, async t => {
    const h = await fixture(t, adapter), command = closed((await h.repository.get('tenant-a', 'board'))!, 'worker-close');
    const child = fork(new URL('./helpers/board-worker.js', import.meta.url), [adapter, h.directory], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const reply = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('board_worker_reply_timeout')), 40000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('message', value => { clearTimeout(timer); resolve(value); });
    });
    child.send(command); assert.equal((await reply as { kind: string }).kind, 'not_applied');
    const exited = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('board_worker_exit_timeout')), 10000);
      child.once('exit', (_code, signal) => { clearTimeout(timer); if (signal === 'SIGKILL') resolve(); else reject(new Error('board_worker_wrong_signal')); });
    });
    child.kill('SIGKILL'); await exited; await h.reopen();
    const page = await h.repository.changes!('tenant-a', 'board', { ...query, afterRevision: command.expectedRevision });
    assert.equal(page.events.length, 1); assert.equal(page.events[0]!.revision, command.next.revision);
    assert.equal((await h.repository.receipt('tenant-a', 'board', command.commandId))!.revision, command.next.revision);
    assert.equal((await h.repository.commit(command)).kind, 'not_applied');
    assert.deepEqual(await h.repository.changes!('tenant-a', 'board', { ...query, afterRevision: command.expectedRevision }), page);
  });
}

test('sqlite: a pre-event database declares a rescan boundary and recovers current offers without fabricating past events', async t => {
  const h = await fixture(t, 'sqlite'); await h.bundle('b').boardWatch!.register('work-b', 'board'); await h.offer();
  const db = new DatabaseSync(join(h.directory, 'board.sqlite'));
  try { db.exec('DROP TABLE board_events_v1; DROP TABLE board_event_roots_v1;'); } finally { db.close(); }
  await h.reopen(); const page = await h.repository.changes!('tenant-a', 'board', query);
  assert.equal(page.resyncRequired, true); assert.equal(page.historyAfterRevision, 4); assert.deepEqual(page.events, []);
  const current = await h.bundle('b').boardWatch!.refresh('work-b');
  assert.equal(current.notifications?.length, 1); assert.equal(current.subscriptions![0]!.cursor, 4);
});

test('event pagination applies its byte limit to the final cursor including a digit boundary', () => {
  const event: BoardChange = { revision: 10, at: 1100, requestIds: [...Array.from({ length: 5 }, () => 'x'.repeat(160)), 'x'], roleIds: [] };
  const candidate = { headRevision: 10, throughRevision: 10, historyAfterRevision: 0, resyncRequired: false, more: false, events: [event] };
  const padding = 1025 - Buffer.byteLength(JSON.stringify(candidate)); assert.ok(padding >= 0 && padding < 160);
  event.requestIds[5] = 'x'.repeat(padding + 1); assert.equal(Buffer.byteLength(JSON.stringify(candidate)), 1025);
  assert.throws(() => boardChangePage({ afterRevision: 9, maxEvents: 1, maxBytes: 1024 }, 10, 0, [event]), /board_event_too_large/);
  event.requestIds[5] = event.requestIds[5]!.slice(1);
  const page = boardChangePage({ afterRevision: 9, maxEvents: 1, maxBytes: 1024 }, 10, 0, [event]);
  assert.equal(Buffer.byteLength(JSON.stringify(page)), 1024); assert.equal(page.throughRevision, 10);
});
