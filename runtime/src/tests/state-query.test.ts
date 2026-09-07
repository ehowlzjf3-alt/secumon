import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { ConversationWorkQuery, StateRepository } from '../application/ports.js';
import type { WorkState } from '../domain/model.js';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';
import { SqliteStateRepository } from '../infrastructure/sqlite-state.js';
import { FileJournalStateRepository, JournalStateError } from '../infrastructure/file-journal-state.js';
import { sha256 } from '../infrastructure/digest.js';
import { advance, command, initial } from './state-conformance-helpers.js';

const backends = ['memory', 'sqlite', 'file-journal'] as const;
type Backend = typeof backends[number];
const query: ConversationWorkQuery = { tenantId: 'tenant-a', principalId: 'person-a', channel: 'test', conversationId: 'chat', limit: 2 };
function bound(id: string): WorkState {
  const state = initial(id);
  const binding = { id: 'binding', tenantId: query.tenantId, principalId: query.principalId, channel: 'test' as const,
    conversationId: query.conversationId, recipientId: query.principalId, destination: 'local' };
  state.conversation = { bindings: [binding, { ...binding, id: 'alias' }], primaryBindingId: binding.id, completionRequiresDelivery: true, result: null };
  return state;
}
async function fixture(t: TestContext, backend: Backend) {
  const directory = await mkdtemp(join(tmpdir(), 'state-query-'));
  const store = backend === 'memory' ? new MemoryStateRepository() : backend === 'sqlite' ? new SqliteStateRepository(join(directory, 'state.sqlite')) : new FileJournalStateRepository(join(directory, 'journal'));
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, directory };
}
async function collect(store: StateRepository, input: ConversationWorkQuery) {
  const ids: string[] = []; const cursors = new Set<string>(); let cursor: string | null = null;
  for (let count = 0; count < 100; count++) {
    const page = await store.conversationWorkPage({ ...input, ...(cursor === null ? {} : { cursor }) });
    assert.ok(page.workIds.length <= input.limit); ids.push(...page.workIds);
    if (page.nextCursor === null) return ids;
    assert.ok(!cursors.has(page.nextCursor)); cursors.add(page.nextCursor); cursor = page.nextCursor;
  }
  throw new Error('page_did_not_advance');
}
const journalError = (expected: string) => (error: unknown) => error instanceof JournalStateError && error.code === expected;
const recordPath = (root: string, workId: string, revision: number) => join(root, sha256(workId), `${String(revision).padStart(16, '0')}.json`);

for (const backend of backends) {
  test(`${backend}: recent metadata is bounded at the requested revision and omits payloads without changing state`, async t => {
    const { store } = await fixture(t, backend); let state = bound('history');
    for (let revision = 1; revision <= 12; revision++) {
      if (revision > 1) state = advance(state);
      const input = command(state, `command-${revision}`);
      input.events = Array.from({ length: 6 }, (_, index) => ({ type: `event-${index}`, at: state.updatedAt + index, data: { marker: 'PRIVATE_EVENT_BODY', body: 'x'.repeat(1024) } }));
      await store.commit(input);
    }
    const before = await store.get(state.id); const events = await store.events(state.id, 0);
    store.events = async () => { throw new Error('unbounded_events_called'); };
    const result = await store.recentEventMetadata(state.id, { throughRevision: 9, limit: 50 });
    assert.deepEqual(result, { items: events.slice(4, 54).map(({ sequence, revision, type, at }) => ({ sequence, revision, type, at })), omittedCount: 4 });
    assert.equal(JSON.stringify(result).includes('PRIVATE_EVENT_BODY'), false);
    assert.deepEqual(await store.recentEventMetadata(state.id, { throughRevision: 0, limit: 1 }), { items: [], omittedCount: 0 });
    assert.deepEqual(await store.recentEventMetadata('missing', { throughRevision: 99, limit: 1 }), { items: [], omittedCount: 0 });
    result.items[0]!.type = 'mutated';
    assert.equal((await store.recentEventMetadata(state.id, { throughRevision: 9, limit: 50 })).items[0]!.type, 'event-4');
    assert.deepEqual(await store.get(state.id), before);
  });

  test(`${backend}: pages progress once per matching work across Unicode IDs and isolate the complete binding scope`, async t => {
    const { store } = await fixture(t, backend);
    const ids = ['alpha', 'zulu', '\uE000', '\u{1F600}', '가나다', '\u0001'.repeat(256), 'foreign-tenant', 'foreign-principal', 'foreign-channel', 'foreign-chat', 'foreign-binding'];
    for (const id of ids) {
      const state = bound(id);
      if (id === 'foreign-tenant') state.policy.tenantId = 'tenant-b';
      if (id === 'foreign-principal') state.policy.principalId = 'person-b';
      if (id === 'foreign-channel') state.conversation!.bindings.forEach(binding => { binding.channel = 'knox'; });
      if (id === 'foreign-chat') state.conversation!.bindings.forEach(binding => { binding.conversationId = 'other-chat'; });
      if (id === 'foreign-binding') state.conversation!.bindings.forEach(binding => { binding.tenantId = 'tenant-b'; });
      await store.commit(command(state, 'accept'));
    }
    store.workIdsForConversation = async () => { throw new Error('unbounded_list_called'); };
    assert.deepEqual((await collect(store, { ...query, limit: 1 })).sort(), ids.slice(0, 6).sort());
    const first = await store.conversationWorkPage(query); assert.notEqual(first.nextCursor, null);
    assert.deepEqual(await store.conversationWorkPage(query), first);
    for (const change of [{ tenantId: 'other' }, { principalId: 'other' }, { channel: 'cli' }, { conversationId: 'other' }]) {
      await assert.rejects(store.conversationWorkPage({ ...query, ...change, cursor: first.nextCursor! }), /invalid_state_query/);
    }
    assert.deepEqual(await collect(store, { ...query, tenantId: 'missing' }), []);
    const changed = advance((await store.get('alpha'))!); changed.conversation = null;
    await store.commit(command(changed, 'remove-binding'));
    assert.deepEqual((await collect(store, query)).sort(), ids.slice(1, 6).sort());
    const edited = advance((await store.get('zulu'))!); edited.policy.principalId = 'person-b';
    await store.commit(command(edited, 'change-owner'));
    assert.deepEqual((await collect(store, query)).sort(), ids.slice(2, 6).sort());
  });

  test(`${backend}: query limits, malformed cursors and empty repositories have a defined result`, async t => {
    const { store } = await fixture(t, backend);
    assert.deepEqual(await store.conversationWorkPage(query), { workIds: [], nextCursor: null });
    for (const limit of [0, -1, 21, 1.5, Number.NaN]) await assert.rejects(store.conversationWorkPage({ ...query, limit }), /invalid_state_query/);
    for (const limit of [0, -1, 51, 1.5, Number.NaN]) await assert.rejects(store.recentEventMetadata('work', { limit, throughRevision: 0 }), /invalid_state_query/);
    for (const throughRevision of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(store.recentEventMetadata('work', { limit: 1, throughRevision }), /invalid_state_query/);
    for (const cursor of ['', 'forged', 'x'.repeat(4097)]) await assert.rejects(store.conversationWorkPage({ ...query, cursor }), /invalid_state_query/);
  });
}

test('journal: each page inspects only its directory budget and a foreign-only page still advances', async t => {
  const { store, directory } = await fixture(t, 'file-journal'); const journal = store as FileJournalStateRepository;
  const ids = Array.from({ length: 9 }, (_, index) => `candidate-${index}`).sort((a, b) => sha256(a).localeCompare(sha256(b)));
  for (const [index, id] of ids.entries()) { const state = bound(id); if (index < 2) state.policy.tenantId = 'foreign'; await store.commit(command(state, 'accept')); }
  const before = journal.metrics(); const first = await store.conversationWorkPage(query); const after = journal.metrics();
  assert.deepEqual(first.workIds, []); assert.notEqual(first.nextCursor, null); assert.equal(after.inspectedWorks - before.inspectedWorks, 2);
  assert.equal(after.recordReads - before.recordReads, 2); assert.deepEqual((await collect(store, { ...query, cursor: first.nextCursor! })).sort(), ids.slice(2).sort());
  const other = new FileJournalStateRepository(join(directory, 'journal'));
  t.after(() => other.close());
  const selected = ids.at(-1)!; const changed = advance((await other.get(selected))!); changed.conversation = null;
  await other.commit(command(changed, 'detach'));
  assert.deepEqual((await collect(store, query)).sort(), ids.slice(2, -1).sort());
});

test('journal: cold, warm and external append distinguish body hashing from parsed and replayed records', async t => {
  const { store, directory } = await fixture(t, 'file-journal'); let state = bound('history');
  for (let revision = 1; revision <= 8; revision++) { if (revision > 1) state = advance(state); const input = command(state, `command-${revision}`); input.events[0]!.data['body'] = 'x'.repeat(4096); await store.commit(input); }
  const reader = new FileJournalStateRepository(join(directory, 'journal')); t.after(() => reader.close());
  const before = reader.metrics(); await reader.recentEventMetadata(state.id, { throughRevision: 8, limit: 3 }); const cold = reader.metrics();
  await reader.recentEventMetadata(state.id, { throughRevision: 8, limit: 3 }); const warm = reader.metrics();
  assert.equal(cold.replayedRecords - before.replayedRecords, 8); assert.equal(cold.recordReads - before.recordReads, 8);
  assert.equal(warm.replayedRecords - cold.replayedRecords, 0); assert.equal(warm.parsedRecords - cold.parsedRecords, 0);
  assert.equal(warm.recordBytes - cold.recordBytes, cold.recordBytes - before.recordBytes);
  assert.equal(warm.rawHashBytes - cold.rawHashBytes, cold.rawHashBytes - before.rawHashBytes); assert.equal(warm.cacheHits - cold.cacheHits, 8);
  state = advance(state); await store.commit(command(state, 'external-append'));
  assert.equal((await reader.get(state.id))?.revision, 9); const appended = reader.metrics();
  assert.equal(appended.replayedRecords - warm.replayedRecords, 1); assert.equal(appended.parsedRecords - warm.parsedRecords, 1); assert.equal(appended.recordReads - warm.recordReads, 9);
  const returned = (await reader.get(state.id))!; returned.goal.description = 'caller mutation';
  const receipt = (await reader.receipt(state.id, 'command-1'))!; receipt.state.goal.description = 'receipt mutation';
  const events = await reader.events(state.id, 0); events[0]!.data['body'] = 'event mutation';
  assert.deepEqual(await reader.get(state.id), state); assert.equal((await reader.events(state.id, 0))[0]!.data['body'], 'x'.repeat(4096));
});

for (const mutation of ['same-length', 'middle-delete', 'tail-delete', 'replacement', 'symlink', 'mode', 'header'] as const) {
  test(`journal: a warm query rejects ${mutation} after caching the complete history`, async t => {
    const { store, directory } = await fixture(t, 'file-journal'); const root = join(directory, 'journal'); let state = bound('history');
    for (let revision = 1; revision <= 3; revision++) { if (revision > 1) state = advance(state); await store.commit(command(state, `command-${revision}`)); }
    await store.get(state.id); const warm = (store as FileJournalStateRepository).metrics(); assert.equal(warm.observedRecordIdentities, 3);
    const path = recordPath(root, state.id, mutation === 'tail-delete' ? 3 : mutation === 'middle-delete' ? 2 : 1);
    if (mutation === 'same-length') {
      const stat = fs.statSync(path); const text = fs.readFileSync(path, 'utf8'); const changed = text.replace('Compare synthetic records', 'Changed synthetic records');
      assert.equal(Buffer.byteLength(changed), Buffer.byteLength(text)); fs.writeFileSync(path, changed); fs.utimesSync(path, stat.atime, stat.mtime);
    } else if (mutation === 'middle-delete' || mutation === 'tail-delete') fs.unlinkSync(path);
    else if (mutation === 'replacement') { const body = fs.readFileSync(path); fs.renameSync(path, `${path}.saved`); fs.writeFileSync(path, body, { mode: 0o600 }); fs.unlinkSync(`${path}.saved`); }
    else if (mutation === 'symlink') { const saved = join(directory, 'saved-record'); fs.renameSync(path, saved); fs.symlinkSync(saved, path); }
    else if (mutation === 'mode') fs.chmodSync(path, 0o640);
    else { const header = join(root, 'format.json'); const value = JSON.parse(fs.readFileSync(header, 'utf8')); value.storeId = '00000000-0000-4000-8000-000000000000'; fs.writeFileSync(header, JSON.stringify(value)); }
    const expected = mutation.endsWith('delete') ? 'journal_history_gap' : mutation === 'same-length' ? 'journal_record_invalid' : mutation === 'header' ? 'journal_store_changed' : 'journal_record_unavailable';
    await assert.rejects(store.recentEventMetadata(state.id, { throughRevision: 3, limit: 2 }), journalError(expected));
    await assert.rejects(store.conversationWorkPage(query), journalError(expected));
  });
}

test('journal: a warm read still fails when the directory durability fence fails', { concurrency: false }, async t => {
  const { store } = await fixture(t, 'file-journal'); await store.commit(command(bound('work'), 'accept')); await store.get('work');
  const original = fs.fsyncSync;
  fs.fsyncSync = (fd => { if (fs.fstatSync(fd).isDirectory()) throw new Error('injected_directory_sync_failure'); original(fd); }) as typeof fs.fsyncSync;
  syncBuiltinESMExports();
  try {
    await assert.rejects(store.recentEventMetadata('work', { throughRevision: 1, limit: 1 }), /injected_directory_sync_failure/);
    await assert.rejects(store.conversationWorkPage(query), /injected_directory_sync_failure/);
  } finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
  assert.equal((await store.get('work'))?.revision, 1);
});

test('journal: pending-link cleanup retries a warm read once even when timestamps stay unchanged', { concurrency: false }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'journal-link-query-')); const root = join(directory, 'journal');
  let reached!: () => void; let release!: () => void; const reachedGate = new Promise<void>(resolve => { reached = resolve; }); const releaseGate = new Promise<void>(resolve => { release = resolve; });
  const writer = new FileJournalStateRepository(root, { onCommitStage(stage) { if (stage === 'published') { reached(); return releaseGate; } } });
  const pending = writer.commit(command(bound('work'), 'accept')); await reachedGate;
  const reader = new FileJournalStateRepository(root);
  t.after(async () => { release(); await pending; await reader.close(); await writer.close(); await rm(directory, { recursive: true, force: true }); });
  await reader.get('work'); const folder = join(root, sha256('work')); const target = recordPath(root, 'work', 1); const inode = fs.statSync(target).ino;
  const candidate = fs.readdirSync(folder).find(name => name.endsWith('.pending')); assert.ok(candidate);
  const before = reader.metrics(); const original = fs.readFileSync; let injected = false;
  const originalFstat = fs.fstatSync; const originalLstat = fs.lstatSync; const lstatDescriptor = Object.getOwnPropertyDescriptor(fs, 'lstatSync')!;
  const initialStat = fs.statSync(target, { bigint: true });
  const keepTimestamps = (stat: fs.Stats | fs.BigIntStats | undefined) => {
    if (stat && stat.ino.toString() === initialStat.ino.toString() && 'ctimeNs' in stat) {
      Object.assign(stat, { mtimeNs: initialStat.mtimeNs, ctimeNs: initialStat.ctimeNs });
    }
    return stat;
  };
  fs.fstatSync = ((...args: Parameters<typeof fs.fstatSync>) => keepTimestamps(Reflect.apply(originalFstat, fs, args))) as typeof fs.fstatSync;
  Object.defineProperty(fs, 'lstatSync', { ...lstatDescriptor,
    value: ((...args: Parameters<typeof fs.lstatSync>) => keepTimestamps(Reflect.apply(originalLstat, fs, args))) as typeof fs.lstatSync });
  fs.readFileSync = ((path, ...args) => {
    const bytes = original(path, ...args);
    if (typeof path === 'number' && fs.fstatSync(path).ino === inode && !injected) {
      injected = true; assert.equal(fs.fstatSync(path).nlink, 2);
      fs.unlinkSync(join(folder, candidate)); assert.equal(fs.fstatSync(path).nlink, 1);
    }
    return bytes;
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try { assert.equal((await reader.get('work'))?.revision, 1); }
  finally { fs.readFileSync = original; fs.fstatSync = originalFstat; Object.defineProperty(fs, 'lstatSync', lstatDescriptor); syncBuiltinESMExports(); }
  const after = reader.metrics(); assert.equal(injected, true); assert.equal(after.recordReads - before.recordReads, 2);
  assert.equal(after.cacheHits - before.cacheHits, 1); assert.equal(after.replayedRecords - before.replayedRecords, 0);
  release(); await pending;
});

test('journal: repeated record changes exhaust the bounded read retry and fail closed', { concurrency: false }, async t => {
  const { store, directory } = await fixture(t, 'file-journal'); await store.commit(command(bound('work'), 'accept')); await store.get('work');
  const target = recordPath(join(directory, 'journal'), 'work', 1); const initialStat = fs.statSync(target); const inode = initialStat.ino; const original = fs.readFileSync; let changedReads = 0;
  fs.readFileSync = ((path, ...args) => {
    const bytes = original(path, ...args);
    if (typeof path === 'number' && fs.fstatSync(path).ino === inode) {
      changedReads++; fs.writeFileSync(target, bytes);
      // A same-tick rewrite need not change the filesystem timestamp; make each injected mutation observable.
      fs.utimesSync(target, new Date(), new Date(initialStat.mtimeMs + changedReads * 2000));
    }
    return bytes;
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try { await assert.rejects(store.recentEventMetadata('work', { throughRevision: 1, limit: 1 }), journalError('journal_record_unavailable')); }
  finally { fs.readFileSync = original; syncBuiltinESMExports(); }
  assert.equal(changedReads, 2); assert.equal((await store.get('work'))?.revision, 1);
});

test('journal: cache accounting includes historical receipt snapshots and eviction releases record identities', async t => {
  const { store, directory } = await fixture(t, 'file-journal'); const root = join(directory, 'journal');
  for (const id of ['work-a', 'work-b']) await store.commit(command(bound(id), 'accept'));
  const measuring = new FileJournalStateRepository(root); await measuring.get('work-a'); const size = measuring.metrics().retainedProjectionBytes; await measuring.close();
  const reader = new FileJournalStateRepository(root, { maxCacheBytes: size + 64 }); t.after(() => reader.close());
  await reader.get('work-a'); await reader.get('work-b');
  assert.equal(reader.metrics().cacheEvictions, 1); assert.equal(reader.metrics().cachedWorks, 1); assert.equal(reader.metrics().observedRecordIdentities, 1);
  assert.ok(reader.metrics().retainedProjectionBytes <= size + 64);
  const path = recordPath(root, 'work-a', 1); const bytes = fs.readFileSync(path); fs.renameSync(path, `${path}.saved`); fs.writeFileSync(path, bytes, { mode: 0o600 }); fs.unlinkSync(`${path}.saved`);
  const before = reader.metrics(); assert.equal((await reader.get('work-a'))?.id, 'work-a');
  assert.equal(reader.metrics().replayedRecords - before.replayedRecords, 1);
  await reader.get('work-b'); const record = JSON.parse(fs.readFileSync(path, 'utf8')); record.request.next.statusReason = 'tampered'; fs.writeFileSync(path, JSON.stringify(record));
  await assert.rejects(reader.get('work-a'), journalError('journal_record_invalid'));
  const uncached = new FileJournalStateRepository(root, { maxCacheBytes: 0 });
  await uncached.get('work-b'); await uncached.get('work-b'); assert.equal(uncached.metrics().cachedWorks, 0); assert.equal(uncached.metrics().observedRecordIdentities, 0);
  await uncached.close(); assert.equal(uncached.metrics().observedWorks, 0); assert.equal(uncached.metrics().observedDirectories, 0);
  await assert.rejects(uncached.recentEventMetadata('work-b', { throughRevision: 1, limit: 1 }), journalError('store_closed'));
  await assert.rejects(uncached.conversationWorkPage(query), journalError('store_closed'));
});

test('journal: a delayed older commit acknowledgement cannot lower a newer observed head with caching disabled', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'journal-head-query-')); const root = join(directory, 'journal');
  let reached!: () => void; let release!: () => void; const reachedGate = new Promise<void>(resolve => { reached = resolve; }); const releaseGate = new Promise<void>(resolve => { release = resolve; });
  const writer = new FileJournalStateRepository(root, { maxCacheBytes: 0, onCommitStage(stage, identity) { if (stage === 'directory_synced' && identity.revision === 2) { reached(); return releaseGate; } } });
  const other = new FileJournalStateRepository(root);
  t.after(async () => { release(); await writer.close(); await other.close(); await rm(directory, { recursive: true, force: true }); });
  const first = bound('work'); await writer.commit(command(first, 'one')); const second = advance(first);
  const pending = writer.commit(command(second, 'two')); await reachedGate;
  const third = advance(second); await other.commit(command(third, 'three')); assert.equal((await writer.get('work'))?.revision, 3);
  release(); await pending; fs.unlinkSync(recordPath(root, 'work', 3));
  await assert.rejects(writer.get('work'), journalError('journal_history_gap'));
});

function legacyDatabase(path: string, state: WorkState) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE works(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,status TEXT NOT NULL,deadline_at INTEGER NOT NULL,body TEXT NOT NULL);
    CREATE TABLE events(work_id TEXT NOT NULL REFERENCES works(id),sequence INTEGER NOT NULL,revision INTEGER NOT NULL,command_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(work_id,sequence));
    CREATE TABLE receipts(work_id TEXT NOT NULL REFERENCES works(id),command_id TEXT NOT NULL,digest TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(work_id,command_id));
    CREATE TABLE deliveries(work_id TEXT NOT NULL REFERENCES works(id),id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(work_id,id)); PRAGMA user_version=1;`);
  legacyWrite(db, state, 'accept'); return db;
}
function legacyWrite(db: DatabaseSync, state: WorkState, commandId: string) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const body = JSON.stringify(state);
    db.prepare('INSERT INTO works VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,status=excluded.status,deadline_at=excluded.deadline_at,body=excluded.body').run(state.id, state.revision, state.status, state.deadlineAt, body);
    const event = { workId: state.id, sequence: state.revision, revision: state.revision, commandId, type: 'legacy-event', at: state.updatedAt, data: { private: 'LEGACY_PAYLOAD' } };
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(state.id, event.sequence, state.revision, commandId, JSON.stringify(event));
    db.prepare('INSERT INTO receipts VALUES(?,?,?,?)').run(state.id, commandId, `digest:${commandId}`, body); db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

test('sqlite: transactional migration backfills query indexes and an already open legacy writer keeps them current', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'state-query-migration-')); const path = join(directory, 'state.sqlite'); const initialState = bound('legacy');
  const oldWriter = legacyDatabase(path, initialState); const store = new SqliteStateRepository(path);
  t.after(async () => { await store.close(); oldWriter.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal(oldWriter.prepare('PRAGMA user_version').get()?.['user_version'], 3);
  assert.deepEqual((await store.conversationWorkPage(query)).workIds, ['legacy']);
  assert.deepEqual(await store.recentEventMetadata('legacy', { throughRevision: 1, limit: 2 }), { items: [{ sequence: 1, revision: 1, type: 'legacy-event', at: 1000 }], omittedCount: 0 });
  const next = advance(initialState); next.conversation!.bindings.forEach(binding => { binding.conversationId = 'moved'; }); legacyWrite(oldWriter, next, 'old-writer-append');
  assert.deepEqual(await store.get('legacy'), next); assert.deepEqual((await store.conversationWorkPage(query)).workIds, []);
  assert.deepEqual((await store.conversationWorkPage({ ...query, conversationId: 'moved' })).workIds, ['legacy']);
  assert.deepEqual(await store.recentEventMetadata('legacy', { throughRevision: 2, limit: 1 }), { items: [{ sequence: 2, revision: 2, type: 'legacy-event', at: 1001 }], omittedCount: 1 });
  const reopened = new SqliteStateRepository(path); try { assert.deepEqual(await reopened.get('legacy'), next); assert.deepEqual((await reopened.conversationWorkPage({ ...query, conversationId: 'moved' })).workIds, ['legacy']); } finally { await reopened.close(); }
});

test('sqlite: migration failure rolls back schema and leaves the legacy records unchanged', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'state-query-rollback-')); const path = join(directory, 'state.sqlite'); const old = legacyDatabase(path, bound('legacy'));
  t.after(async () => { old.close(); await rm(directory, { recursive: true, force: true }); });
  old.prepare('UPDATE events SET body=?').run('invalid-json');
  assert.throws(() => new SqliteStateRepository(path));
  assert.equal(old.prepare('PRAGMA user_version').get()?.['user_version'], 1);
  assert.equal(old.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name IN ('event_metadata','conversation_work')").get()?.['count'], 0);
  assert.equal(old.prepare('SELECT body FROM events').get()?.['body'], 'invalid-json'); assert.equal(old.prepare('SELECT COUNT(*) AS count FROM receipts').get()?.['count'], 1);
});

test('sqlite: reopening an intermediate v2 store rebuilds stale indexes and replaces old triggers transactionally', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'state-query-v2-')); const path = join(directory, 'state.sqlite');
  const seed = new SqliteStateRepository(path); const first = bound('work'); await seed.commit(command(first, 'accept')); await seed.close();
  const old = new DatabaseSync(path); t.after(async () => { old.close(); await rm(directory, { recursive: true, force: true }); });
  old.exec('DROP TRIGGER works_query_update; CREATE TRIGGER works_query_update AFTER UPDATE ON works BEGIN SELECT 1; END; PRAGMA user_version=2;');
  const changed = advance(first); changed.conversation!.bindings.forEach(binding => { binding.conversationId = 'moved'; }); legacyWrite(old, changed, 'v2-stale-write');
  old.exec('DELETE FROM event_metadata');
  assert.deepEqual(old.prepare('SELECT conversation_id FROM conversation_work').all().map(row => row['conversation_id']), ['chat']);
  const store = new SqliteStateRepository(path);
  try {
    assert.equal(old.prepare('PRAGMA user_version').get()?.['user_version'], 3);
    assert.deepEqual(await store.get('work'), changed); assert.deepEqual((await store.conversationWorkPage(query)).workIds, []);
    assert.deepEqual((await store.conversationWorkPage({ ...query, conversationId: 'moved' })).workIds, ['work']);
    assert.equal((await store.recentEventMetadata('work', { throughRevision: 2, limit: 50 })).items.length, 2);
    const third = advance(changed); third.conversation!.bindings.forEach(binding => { binding.conversationId = 'current'; });
    assert.equal((await store.commit(command(third, 'v3-write'))).kind, 'committed');
    assert.deepEqual((await store.conversationWorkPage({ ...query, conversationId: 'current' })).workIds, ['work']);
    assert.deepEqual((await store.conversationWorkPage({ ...query, conversationId: 'moved' })).workIds, []);
  } finally { await store.close(); }
});

test('sqlite: a failed index write rolls back canonical state, events, receipt and binding changes together', async t => {
  const { store, directory } = await fixture(t, 'sqlite'); const first = bound('work'); await store.commit(command(first, 'accept'));
  const injector = new DatabaseSync(join(directory, 'state.sqlite')); t.after(() => injector.close());
  injector.exec("CREATE TRIGGER fail_query BEFORE INSERT ON event_metadata WHEN NEW.revision=2 BEGIN SELECT RAISE(ABORT,'injected_query_failure'); END");
  const next = advance(first); next.conversation!.bindings.forEach(binding => { binding.conversationId = 'moved'; });
  await assert.rejects(store.commit(command(next, 'failed')), /injected_query_failure/);
  assert.deepEqual(await store.get('work'), first); assert.equal(await store.receipt('work', 'failed'), null);
  assert.deepEqual((await store.conversationWorkPage(query)).workIds, ['work']); assert.deepEqual((await store.conversationWorkPage({ ...query, conversationId: 'moved' })).workIds, []);
  assert.equal((await store.recentEventMetadata('work', { throughRevision: 2, limit: 50 })).items.length, 1); assert.equal((await store.events('work', 0)).length, 1);
});

test('sqlite: bounded query SQL selects metadata and IDs without loading event or work bodies', { concurrency: false }, async t => {
  const { store } = await fixture(t, 'sqlite'); await store.commit(command(bound('work'), 'accept'));
  const prepare = DatabaseSync.prototype.prepare; const statements: string[] = [];
  DatabaseSync.prototype.prepare = function(sql) { statements.push(sql); return prepare.call(this, sql); };
  try { await store.recentEventMetadata('work', { throughRevision: 1, limit: 1 }); await store.conversationWorkPage(query); }
  finally { DatabaseSync.prototype.prepare = prepare; }
  assert.ok(statements.length >= 2); assert.equal(statements.some(sql => /\bbody\b/i.test(sql)), false); assert.ok(statements.every(sql => /\bLIMIT\b/i.test(sql)));
});
