import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';
import { SqliteStateRepository } from '../infrastructure/sqlite-state.js';
import { FileJournalStateRepository, JournalStateError } from '../infrastructure/file-journal-state.js';
import { PostgresStateRepository } from '../infrastructure/postgres-state.js';
import { PostgresStore, type PostgresBinding, type PostgresPool } from '../infrastructure/postgres-store.js';
import { sha256 } from '../infrastructure/digest.js';
import { advance, command, initial } from './state-conformance-helpers.js';

const backends = ['memory', 'sqlite', 'file-journal'] as const;
type Backend = typeof backends[number];
async function fixture(t: TestContext, backend: Backend) {
  const directory = await mkdtemp(join(tmpdir(), 'state-revision-hint-'));
  const store = backend === 'memory' ? new MemoryStateRepository() : backend === 'sqlite' ? new SqliteStateRepository(join(directory, 'state.sqlite')) : new FileJournalStateRepository(join(directory, 'journal'));
  const peers: { close(): Promise<void> }[] = [];
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await store.close(); } };
  t.after(async () => { for (const peer of peers) await peer.close(); await close(); await rm(directory, { recursive: true, force: true }); });
  return { store, directory, close, peers };
}

for (const backend of backends) test(`${backend}: revision hints follow commits within one repository and work without changing original receipts`, async t => {
  const { store, close } = await fixture(t, backend), isolated = (await fixture(t, backend)).store;
  const first = initial('shared-id'), other = initial('other');
  assert.equal(await store.revisionHint(first.id), null);
  assert.equal((await store.commit(command(first, 'first'))).kind, 'committed');
  assert.equal(await store.revisionHint(first.id), 1);
  const original = await store.receipt(first.id, 'first'), second = advance(first);
  assert.equal((await store.commit(command(second, 'second'))).kind, 'committed');
  assert.equal((await store.commit(command(other, 'other-first'))).kind, 'committed');
  assert.equal((await isolated.commit(command(first, 'isolated-first'))).kind, 'committed');
  assert.equal(await store.revisionHint(first.id), 2); assert.equal(await store.revisionHint(other.id), 1);
  assert.equal(await isolated.revisionHint(first.id), 1); assert.equal(await isolated.revisionHint(other.id), null);
  assert.equal(await store.revisionHint('missing'), null);
  assert.deepEqual(await store.receipt(first.id, 'first'), original);
  assert.deepEqual(await store.get(first.id), second);
  for (const invalid of ['', 'x'.repeat(257), null, 4]) await assert.rejects(store.revisionHint(invalid as string), /invalid_state_query/);
  await close(); await assert.rejects(store.revisionHint(first.id));
});

test('sqlite: another connection becomes visible through a single bound scalar read and malformed revisions are rejected', { concurrency: false }, async t => {
  const { store, directory, peers } = await fixture(t, 'sqlite'), writer = new SqliteStateRepository(join(directory, 'state.sqlite'));
  peers.push(writer);
  const first = initial("work'; SELECT ignored --");
  assert.equal((await writer.commit(command(first, 'first'))).kind, 'committed');
  assert.equal(await store.revisionHint(first.id), 1);
  assert.equal((await writer.commit(command(advance(first), 'second'))).kind, 'committed');
  const statements: string[] = [], prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function(sql) { statements.push(sql); return prepare.call(this, sql); };
  try { assert.equal(await store.revisionHint(first.id), 2); }
  finally { DatabaseSync.prototype.prepare = prepare; }
  assert.deepEqual(statements, ['SELECT revision FROM works WHERE id=?']);
  const raw = new DatabaseSync(join(directory, 'state.sqlite'));
  try {
    for (const revision of [0, -1, 1.5, 'invalid']) {
      raw.prepare('UPDATE works SET revision=? WHERE id=?').run(revision, first.id);
      await assert.rejects(store.revisionHint(first.id), /invalid_stored_record/);
    }
    raw.prepare('UPDATE works SET revision=? WHERE id=?').run(2, first.id);
  } finally { raw.close(); }
});

test('journal: repeated filename hints read no record bodies and never promote unverified history into the replay cache', async t => {
  const { store, directory, peers } = await fixture(t, 'file-journal'), writer = store as FileJournalStateRepository;
  let state = initial('history');
  for (let revision = 1; revision <= 8; revision++) {
    if (revision > 1) state = advance(state);
    const request = command(state, `command-${revision}`); request.events[0]!.data['original'] = 'x'.repeat(4096);
    assert.equal((await writer.commit(request)).kind, 'committed');
  }
  const reader = new FileJournalStateRepository(join(directory, 'journal')); peers.push(reader);
  const before = reader.metrics();
  for (let pass = 0; pass < 5; pass++) assert.equal(await reader.revisionHint(state.id), 8);
  state = advance(state); assert.equal((await writer.commit(command(state, 'later-append'))).kind, 'committed');
  assert.equal(await reader.revisionHint(state.id), 9);
  const after = reader.metrics();
  for (const field of ['recordReads', 'recordBytes', 'rawHashCalls', 'rawHashBytes', 'checksumHashCalls', 'checksumHashBytes', 'parsedRecords', 'replayedRecords',
    'discoveryParses', 'cachedWorks', 'cacheHits', 'observedWorks', 'observedRecordIdentities', 'retainedProjectionBytes', 'directorySyncs'] as const) {
    assert.equal(after[field] - before[field], 0, field);
  }
  assert.ok(after.headerReads > before.headerReads); assert.ok(after.metadataChecks > before.metadataChecks);
  const oldest = join(directory, 'journal', sha256(state.id), '0000000000000001.json'), original = await readFile(oldest, 'utf8');
  const changed = original.replace('Compare synthetic records', 'Changed synthetic records'); assert.notEqual(changed, original); assert.equal(changed.length, original.length);
  await writeFile(oldest, changed);
  try {
    assert.equal(await reader.revisionHint(state.id), 9, 'a filename hint does not validate the record body');
    await assert.rejects(reader.get(state.id), (error: unknown) => error instanceof JournalStateError && error.code === 'journal_record_invalid');
    assert.equal(reader.metrics().observedWorks, 0); assert.equal(reader.metrics().cachedWorks, 0);
  } finally { await writeFile(oldest, original); }
  assert.deepEqual(await reader.get(state.id), state);
  t.diagnostic(JSON.stringify({ hintCalls: 6, hintRecordReads: after.recordReads - before.recordReads, hintRawHashBytes: after.rawHashBytes - before.rawHashBytes,
    hintHeaderReads: after.headerReads - before.headerReads, hintMetadataChecks: after.metadataChecks - before.metadataChecks,
    meaning: 'Node reads and application hashes, not physical disk I/O; formal get still validates every original record' }));
});

test('journal: hint rejects unexpected names and changed store identity through the existing file boundary', async t => {
  const { store, directory } = await fixture(t, 'file-journal'), state = initial('history');
  assert.equal((await store.commit(command(state, 'first'))).kind, 'committed');
  const foreign = join(directory, 'journal', sha256(state.id), 'unexpected.txt');
  await writeFile(foreign, 'unrelated');
  try { await assert.rejects(store.revisionHint(state.id), /journal_layout_invalid/); }
  finally { await rm(foreign); }
  const headerPath = join(directory, 'journal', 'format.json'), original = await readFile(headerPath, 'utf8');
  const header = JSON.parse(original) as { storeId: string }; header.storeId = '33333333-3333-4333-8333-333333333333';
  await writeFile(headerPath, JSON.stringify(header));
  try { await assert.rejects(store.revisionHint(state.id), /journal_store_changed/); }
  finally { await writeFile(headerPath, original); }
  assert.equal(await store.revisionHint(state.id), 1);
});

test('postgres recording transport: scalar hints retain binding checks, scope, validation and closed-store behavior', async t => {
  const binding: PostgresBinding = { storeId: '11111111-1111-4111-8111-111111111111', agentId: 'hint-agent', purpose: 'state',
    registrationId: '22222222-2222-4222-8222-222222222222' };
  const workId = "history'; SELECT ignored --", queries: { sql: string; values: unknown[] }[] = [];
  let revision: unknown = '9', maintenance: string | null = null, registrationId = binding.registrationId;
  const pool: PostgresPool = { async connect() { return {
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (sql.includes('SELECT version FROM secumon_pg.installation')) return { rows: [{ version: 2 }], rowCount: 1 };
      if (sql.includes('FROM secumon_pg.bindings')) return { rows: [{ registration_id: registrationId, schema_version: 1, maintenance_id: maintenance }], rowCount: 1 };
      if (sql.includes('SELECT revision FROM secumon_pg.works')) return { rows: values[2] === workId ? [{ revision }] : [], rowCount: values[2] === workId ? 1 : 0 };
      return { rows: [], rowCount: 0 };
    }, release() {},
  }; } };
  const store = new PostgresStateRepository(await PostgresStore.open(pool, binding)); t.after(() => store.close()); queries.length = 0;
  assert.equal(await store.revisionHint(workId), 9);
  const read = queries.find(query => query.sql.includes('FROM secumon_pg.works')); assert.ok(read);
  assert.equal(read.sql, 'SELECT revision FROM secumon_pg.works WHERE store_id=$1 AND agent_id=$2 AND id=$3');
  assert.deepEqual(read.values, [binding.storeId, binding.agentId, workId]);
  assert.ok(queries.some(query => query.sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
  const bindingRead = queries.find(query => query.sql.includes('FROM secumon_pg.bindings')); assert.ok(bindingRead);
  assert.deepEqual(bindingRead.values, [binding.storeId, binding.agentId, 'state']); assert.equal(queries.at(-1)!.sql, 'COMMIT');
  assert.equal(await store.revisionHint('missing'), null);
  for (const invalid of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '01', null]) {
    revision = invalid; await assert.rejects(store.revisionHint(workId), /invalid_stored_record|postgres_invalid_integer/);
  }
  let count = queries.length;
  for (const invalid of ['', 'x'.repeat(257), null, 4]) await assert.rejects(store.revisionHint(invalid as string), /invalid_state_query/);
  assert.equal(queries.length, count, 'invalid ids do not open a transaction');
  queries.length = 0; maintenance = 'maintenance'; await assert.rejects(store.revisionHint(workId), /postgres_store_maintenance/);
  assert.equal(queries.some(query => query.sql.includes('FROM secumon_pg.works')), false);
  queries.length = 0; maintenance = null; registrationId = '33333333-3333-4333-8333-333333333333';
  await assert.rejects(store.revisionHint(workId), /postgres_binding_mismatch/);
  assert.equal(queries.some(query => query.sql.includes('FROM secumon_pg.works')), false);
  await store.close(); count = queries.length; await assert.rejects(store.revisionHint(workId), /postgres_store_closed/); assert.equal(queries.length, count);
});
