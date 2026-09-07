import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStateRepository } from '../infrastructure/sqlite-state.js';
import { newWork } from '../application/new-work.js';
import { validateScenario } from '../application/fixtures.js';
import type { CommitRequest, CommitResult } from '../application/ports.js';
import type { Delivery, WorkState } from '../domain/model.js';

const scenario = validateScenario(JSON.parse(readFileSync(new URL('../../fixtures/documents-simple.json', import.meta.url), 'utf8')));
const initial = () => newWork({ id: 'work-1', goal: scenario.goal, policy: scenario.policy, limits: { toolCalls: 10, modelCalls: 2, tokens: 1000, replans: 2, wallTimeMs: 60_000 }, now: 1000 });
const ack = (): Delivery => ({ id: 'ack-1', workId: 'work-1', goalRevision: 1, destination: 'local', kind: 'ack', text: '요청을 받았습니다.', status: 'pending', externalId: null });
const command = (next: WorkState, id: string, deliveries: Delivery[] = []): CommitRequest => ({ workId: next.id, expectedRevision: next.revision - 1, commandId: id, commandDigest: `digest:${id}`, next, events: [{ type: 'state_changed', at: next.updatedAt, data: { status: next.status } }], deliveries });

async function child(path: string) {
  const worker = fork(new URL('./storage-worker.js', import.meta.url), [path], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  await once(worker, 'message', { signal: AbortSignal.timeout(10_000) });
  return worker;
}

test('one atomic commit stores state, events, outbox and idempotency receipt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-state-'));
  const store = new SqliteStateRepository(join(dir, 'state.sqlite'));
  try {
    const input = command(initial(), 'accept', [ack()]);
    assert.equal((await store.commit(input)).kind, 'committed');
    assert.equal((await store.commit(input)).kind, 'duplicate');
    assert.equal((await store.commit({ ...input, commandDigest: 'different' })).kind, 'idempotency_conflict');
    assert.equal((await store.events('work-1', 0)).length, 1);
    assert.equal((await store.deliveries('work-1')).length, 1);
    assert.deepEqual(await store.get('work-1'), initial());
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('injected failure between state and event writes rolls back every record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-rollback-')); const path = join(dir, 'state.sqlite');
  const store = new SqliteStateRepository(path);
  try {
    await store.commit(command(initial(), 'accept', [ack()]));
    const injector = new DatabaseSync(path);
    injector.exec("CREATE TRIGGER fail_event BEFORE INSERT ON events WHEN NEW.command_id='fault' BEGIN SELECT RAISE(ABORT,'test_injected_failure'); END;");
    injector.close();
    const next = { ...initial(), revision: 2, updatedAt: 1001, status: 'waiting' as const };
    await assert.rejects(store.commit(command(next, 'fault', [{ ...ack(), id: 'question-1', kind: 'question' }])), /test_injected_failure/);
    assert.equal((await store.get('work-1'))?.revision, 1);
    assert.equal((await store.events('work-1', 0)).length, 1);
    assert.equal((await store.deliveries('work-1')).length, 1);
    assert.equal((await store.commit(command(next, 'normal'))).kind, 'committed');
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('waiting state and wake obligation survive process termination after commit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-restart-')); const path = join(dir, 'state.sqlite');
  try {
    const waiting = { ...initial(), status: 'waiting' as const, obligations: [{ id: 'reply', kind: 'response' as const, reason: 'await synthetic reply', status: 'pending' as const, wakeKey: 'reply-1', dueAt: 2000 }] };
    const writer = await child(path);
    const writerExit = once(writer, 'exit');
    const written = once(writer, 'message');
    writer.send({ operation: 'commit', request: command(waiting, 'wait'), crashAfterCommit: true });
    assert.equal((await written)[0].result.kind, 'committed');
    const [, signal] = await writerExit;
    assert.equal(signal, 'SIGKILL');
    const reader = await child(path);
    const read = once(reader, 'message');
    const readerExit = once(reader, 'exit');
    reader.send({ operation: 'read', workId: 'work-1' });
    assert.deepEqual((await read)[0].state, waiting);
    await readerExit;
    const reopened = new SqliteStateRepository(path);
    try { assert.deepEqual(await reopened.runnable(1500), []); assert.deepEqual(await reopened.runnable(2000), ['work-1']); }
    finally { await reopened.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('two independent processes cannot commit from the same stale revision', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-race-')); const path = join(dir, 'state.sqlite');
  const store = new SqliteStateRepository(path);
  try {
    await store.commit(command(initial(), 'accept'));
    const left = await child(path); const right = await child(path);
    const replies = [once(left, 'message'), once(right, 'message')];
    const exits = [once(left, 'exit'), once(right, 'exit')];
    left.send({ operation: 'commit', request: command({ ...initial(), revision: 2, statusReason: 'left' }, 'left') });
    right.send({ operation: 'commit', request: command({ ...initial(), revision: 2, statusReason: 'right' }, 'right') });
    const kinds = (await Promise.all(replies)).map(r => (r[0].result as CommitResult).kind).sort();
    await Promise.all(exits);
    assert.deepEqual(kinds, ['committed', 'conflict']);
    assert.equal((await store.get('work-1'))?.revision, 2);
    assert.equal((await store.events('work-1', 0)).length, 2);
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});
