import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { EventPageQuery, StateRepository } from '../application/ports.js';
import type { StoredEvent } from '../domain/model.js';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';
import { SqliteStateRepository } from '../infrastructure/sqlite-state.js';
import { FileJournalStateRepository, JournalStateError } from '../infrastructure/file-journal-state.js';
import { PostgresStateRepository } from '../infrastructure/postgres-state.js';
import { PostgresStore, type PostgresBinding, type PostgresPool } from '../infrastructure/postgres-store.js';
import { sha256 } from '../infrastructure/digest.js';
import { advance, command, initial } from './state-conformance-helpers.js';

const backends = ['memory', 'sqlite', 'file-journal'] as const;
type Backend = typeof backends[number];
const selectedType = "control'; SELECT ignored --";
async function fixture(t: TestContext, backend: Backend) {
  const directory = await mkdtemp(join(tmpdir(), 'state-event-page-'));
  const store = backend === 'memory' ? new MemoryStateRepository() : backend === 'sqlite' ? new SqliteStateRepository(join(directory, 'state.sqlite')) : new FileJournalStateRepository(join(directory, 'journal'));
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, directory };
}
async function seed(store: StateRepository, workId = 'history', revisions = 8, perRevision = 5, bytes = 1024) {
  let state = initial(workId);
  for (let revision = 1; revision <= revisions; revision++) {
    if (revision > 1) state = advance(state);
    const input = command(state, `command-${revision}`);
    input.events = Array.from({ length: perRevision }, (_, index) => ({ type: index % 2 === 0 ? selectedType : 'ordinary', at: state.updatedAt,
      data: { workId, revision, index, original: 'x'.repeat(bytes) } }));
    assert.equal((await store.commit(input)).kind, 'committed');
  }
  return state;
}
async function remaining(store: StateRepository, query: EventPageQuery) {
  const output: StoredEvent[] = []; let beforeSequence = query.beforeSequence;
  for (let count = 0; count < 100; count++) {
    const page = await store.eventPage('history', { ...query, ...(beforeSequence === undefined ? {} : { beforeSequence }) });
    assert.ok(page.items.length <= query.limit); output.push(...page.items);
    if (page.nextBeforeSequence === null) return output;
    assert.equal(page.nextBeforeSequence, page.items.at(-1)!.sequence);
    if (beforeSequence !== undefined) assert.ok(page.nextBeforeSequence < beforeSequence);
    beforeSequence = page.nextBeforeSequence;
  }
  throw new Error('event_page_did_not_advance');
}

for (const backend of backends) {
  test(`${backend}: original event pages cross same-revision boundaries and remain pinned while new history arrives`, async t => {
    const { store } = await fixture(t, backend), state = await seed(store);
    const original = await store.events('history', 0), originalReceipt = await store.receipt('history', 'command-6');
    const query = { afterRevision: 2, throughRevision: 6, limit: 4 };
    const expected = original.filter(event => event.revision > 2 && event.revision <= 6).toReversed();
    const first = await store.eventPage('history', query);
    assert.deepEqual(first.items, expected.slice(0, 4)); assert.equal(first.nextBeforeSequence, expected[3]!.sequence);
    assert.equal(first.items[0]!.revision, first.items.at(-1)!.revision, 'one revision spans multiple pages');
    assert.equal((await store.commit(command(advance(state), 'later-append'))).kind, 'committed');
    store.events = async () => { throw new Error('unbounded_event_read'); };
    const rest = await remaining(store, { ...query, beforeSequence: first.nextBeforeSequence! });
    assert.deepEqual([...first.items, ...rest], expected);
    assert.equal(new Set([...first.items, ...rest].map(event => event.sequence)).size, expected.length);
    first.items[0]!.data['original'] = 'caller mutation';
    assert.deepEqual((await store.eventPage('history', query)).items, expected.slice(0, 4));
    assert.deepEqual(await store.receipt('history', 'command-6'), originalReceipt);
  });

  test(`${backend}: exact type and work boundaries preserve original bodies with correct final and empty pages`, async t => {
    const { store } = await fixture(t, backend); await seed(store); await seed(store, 'other', 2);
    const originals = await store.events('history', 0), other = await store.events('other', 0);
    const query = { afterRevision: 1, throughRevision: 5, limit: 3, type: selectedType };
    const expected = originals.filter(event => event.revision > 1 && event.revision <= 5 && event.type === selectedType).toReversed();
    store.events = async () => { throw new Error('unbounded_event_read'); };
    assert.deepEqual(await remaining(store, query), expected);
    assert.deepEqual(await store.eventPage('history', { ...query, beforeSequence: expected.at(-3)!.sequence + 1 }), {
      items: expected.slice(-3), nextBeforeSequence: null,
    });
    assert.deepEqual(await store.eventPage('other', { afterRevision: 0, throughRevision: 8, limit: 128 }), { items: other.toReversed(), nextBeforeSequence: null });
    for (const [workId, input] of [
      ['missing', query], ['history', { ...query, type: 'absent' }], ['history', { ...query, throughRevision: 1 }],
      ['history', { ...query, beforeSequence: 1 }], ['history', { afterRevision: 0, throughRevision: 0, limit: 1 }],
    ] as const) assert.deepEqual(await store.eventPage(workId, input), { items: [], nextBeforeSequence: null });
  });

  test(`${backend}: event page validation rejects invalid bounds before reading history`, async t => {
    const { store } = await fixture(t, backend); await seed(store, 'history', 1);
    const query: EventPageQuery = { afterRevision: 0, throughRevision: 1, limit: 1 };
    const invalid = [
      ...[-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 2].map(afterRevision => ({ ...query, afterRevision })),
      ...[-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1].map(throughRevision => ({ ...query, throughRevision })),
      ...[0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1].map(beforeSequence => ({ ...query, beforeSequence })),
      ...[0, -1, 129, 1.5, Number.NaN].map(limit => ({ ...query, limit })),
      ...['', 'x'.repeat(257)].map(type => ({ ...query, type })), { ...query, unexpected: true },
    ];
    for (const input of invalid) await assert.rejects(store.eventPage('history', input), /invalid_state_query/);
    for (const workId of ['', 'x'.repeat(257)]) await assert.rejects(store.eventPage(workId, query), /invalid_state_query/);
    assert.equal((await store.get('history'))?.revision, 1);
  });
}

test('sqlite: event page binds exact type and bounds and limits the original-body SQL query', { concurrency: false }, async t => {
  const { store } = await fixture(t, 'sqlite'); await seed(store);
  const prepare = DatabaseSync.prototype.prepare, sql: string[] = [];
  DatabaseSync.prototype.prepare = function(statement) { sql.push(statement); return prepare.call(this, statement); };
  try {
    const page = await store.eventPage('history', { afterRevision: 2, throughRevision: 6, beforeSequence: 28, type: selectedType, limit: 2 });
    assert.deepEqual(page.items.map(event => event.sequence), [26, 25]); assert.equal(page.nextBeforeSequence, 25);
    assert.ok(page.items.every(event => event.type === selectedType));
  } finally { DatabaseSync.prototype.prepare = prepare; }
  assert.equal(sql.length, 1); assert.match(sql[0]!, /e\.revision>\? AND e\.revision<=\?/);
  assert.match(sql[0]!, /e\.sequence<\?/); assert.match(sql[0]!, /m\.type=\?/);
  assert.match(sql[0]!, /ORDER BY e\.sequence DESC LIMIT \?/); assert.equal(sql[0]!.includes(selectedType), false);
});

test('journal: bounded returned bodies retain full raw-history validation and report its separate read cost', async t => {
  const { store, directory } = await fixture(t, 'file-journal'), journal = store as FileJournalStateRepository;
  await seed(store, 'history', 12, 8, 4096); await store.get('history');
  const before = journal.metrics(), all = await store.events('history', 0), afterAll = journal.metrics();
  const page = await store.eventPage('history', { afterRevision: 0, throughRevision: 12, limit: 2 }), afterPage = journal.metrics();
  const allReturnedBytes = Buffer.byteLength(JSON.stringify(all)), pageReturnedBytes = Buffer.byteLength(JSON.stringify(page.items));
  assert.deepEqual(page.items, all.slice(-2).toReversed()); assert.ok(pageReturnedBytes < allReturnedBytes / 20);
  assert.equal(afterAll.recordReads - before.recordReads, 12); assert.equal(afterPage.recordReads - afterAll.recordReads, 12);
  assert.equal(afterPage.rawHashBytes - afterAll.rawHashBytes, afterAll.rawHashBytes - before.rawHashBytes);
  assert.equal(afterPage.replayedRecords - afterAll.replayedRecords, 0);
  t.diagnostic(JSON.stringify({ allReturnedBytes, pageReturnedBytes,
    allRecordReads: afterAll.recordReads - before.recordReads, pageRecordReads: afterPage.recordReads - afterAll.recordReads,
    allRawHashBytes: afterAll.rawHashBytes - before.rawHashBytes, pageRawHashBytes: afterPage.rawHashBytes - afterAll.rawHashBytes,
    meaning: 'Node reads and hashes; not physical disk I/O or reduced integrity coverage' }));
  const oldest = join(directory, 'journal', sha256('history'), '0000000000000001.json'), saved = await readFile(oldest, 'utf8');
  const changed = saved.replace('Compare synthetic records', 'Changed synthetic records'); assert.equal(changed.length, saved.length);
  await writeFile(oldest, changed);
  try {
    await assert.rejects(store.eventPage('history', { afterRevision: 10, throughRevision: 12, limit: 2 }),
      (error: unknown) => error instanceof JournalStateError && error.code === 'journal_record_invalid');
  } finally { await writeFile(oldest, saved); }
});

test('postgres recording transport: event page preserves scope and binds snapshot, cursor, exact type and lookahead', async t => {
  const binding: PostgresBinding = { storeId: '11111111-1111-4111-8111-111111111111', agentId: 'page-agent', purpose: 'state',
    registrationId: '22222222-2222-4222-8222-222222222222' };
  const selected: StoredEvent[] = [23, 21, 18].map(sequence => ({ workId: 'history', sequence, revision: 5, commandId: 'original-command',
    type: selectedType, at: 1005, data: { original: `body-${sequence}` } }));
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool: PostgresPool = { async connect() { return {
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (sql.includes('SELECT version FROM secumon_pg.installation')) return { rows: [{ version: 2 }], rowCount: 1 };
      if (sql.includes('FROM secumon_pg.bindings')) return { rows: [{ registration_id: binding.registrationId, schema_version: 1, maintenance_id: null }], rowCount: 1 };
      if (sql.includes('SELECT body FROM secumon_pg.events')) return { rows: selected.map(event => ({ body: JSON.stringify(event) })), rowCount: selected.length };
      return { rows: [], rowCount: 0 };
    }, release() {},
  }; } };
  const store = new PostgresStateRepository(await PostgresStore.open(pool, binding)); t.after(() => store.close()); queries.length = 0;
  assert.deepEqual(await store.eventPage('history', { afterRevision: 2, throughRevision: 6, beforeSequence: 24, type: selectedType, limit: 2 }), {
    items: selected.slice(0, 2), nextBeforeSequence: 21,
  });
  const read = queries.find(query => query.sql.includes('SELECT body FROM secumon_pg.events')); assert.ok(read);
  assert.deepEqual(read.values, [binding.storeId, binding.agentId, 'history', 2, 6, 24, selectedType, 3]);
  assert.match(read.sql, /store_id=\$1 AND agent_id=\$2 AND work_id=\$3/);
  assert.match(read.sql, /revision>\$4 AND revision<=\$5/); assert.match(read.sql, /sequence<\$6/);
  assert.match(read.sql, /type=\$7/); assert.match(read.sql, /ORDER BY sequence DESC LIMIT \$8/); assert.equal(read.sql.includes(selectedType), false);
  assert.ok(queries.some(query => query.sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
  assert.ok(queries.some(query => query.sql.includes('FROM secumon_pg.bindings')));
  assert.equal(queries.at(-1)!.sql, 'COMMIT');
  const count = queries.length; await assert.rejects(store.eventPage('history', { afterRevision: 7, throughRevision: 6, limit: 1 }), /invalid_state_query/);
  assert.equal(queries.length, count, 'invalid queries do not open a database transaction');
});
