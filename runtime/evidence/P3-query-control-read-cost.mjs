import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';

// Standalone local observation only. Root runs this against its final emitted build.
const runtimeRoot = resolve(process.argv[2] ?? '/Users/seunghanee/Documents/secumon/runtime');
const output = join(runtimeRoot, 'evidence', 'P3-query-control-read-cost.json');
try { await access(output); throw new Error('output_already_exists_preserve_prior_evidence'); }
catch (error) { if (error?.code !== 'ENOENT') throw error; }
const implementationPaths = ['infrastructure/file-journal-state.js', 'infrastructure/sqlite-state.js',
  'application/new-work.js', 'application/state-query.js', 'application/store-contract.js'];
const imported = await Promise.all(implementationPaths.slice(0, 3).map(path => import(pathToFileURL(join(runtimeRoot, 'dist', path)).href)));
const [{ FileJournalStateRepository }, { SqliteStateRepository }, { newWork }] = imported;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const digest = value => sha256(JSON.stringify(value));
const bodyMarker = 'GENERATED_SYNTHETIC_EVENT_BODY_ONLY';
const body = bodyMarker.repeat(64);
const owner = { tenantId: 'query-cost-fixture', principalId: 'local-observer' };
const route = conversationId => ({ ...owner, channel: 'test', conversationId, limit: 20 });
const directory = await mkdtemp(join(tmpdir(), 'secumon-p3-query-cost-'));
const open = new Set();
const retain = store => { open.add(store); return store; };
async function close(store) { await store.close(); open.delete(store); }
function initial(workId, conversationId) {
  const state = newWork({ id: workId, now: 1000,
    goal: { revision: 1, description: 'Observe generated local query data', scope: 'synthetic-query-cost', mode: 'auto',
      criteria: [{ id: 'ready', description: 'Generated input is present', key: 'ready', operator: 'present', equals: null,
        minIndependentSources: 1, requireCompleteCoverage: true }] },
    policy: { ...owner, allowedLabels: ['synthetic'], allowedTools: [], allowedDestinations: ['local'], allowWrites: false },
    limits: { toolCalls: 0, modelCalls: 0, tokens: 0, replans: 0, wallTimeMs: 1000000 } });
  state.conversation = { bindings: [{ id: 'local-binding', ...owner, channel: 'test', conversationId, recipientId: owner.principalId, destination: 'local' }],
    primaryBindingId: 'local-binding', completionRequiresDelivery: false, result: null };
  return state;
}
function commitRequest(state) {
  const commandId = `fixture-revision-${state.revision}`;
  return { workId: state.id, expectedRevision: state.revision - 1, commandId, commandDigest: digest({ workId: state.id, commandId }), next: state,
    events: [{ type: 'synthetic_query_tick', at: state.updatedAt, data: { generatedBody: body, revision: state.revision } }], deliveries: [] };
}
async function append(store, state) {
  const next = { ...structuredClone(state), revision: state.revision + 1, updatedAt: state.updatedAt + 1, statusReason: `synthetic-revision-${state.revision + 1}` };
  assert.equal((await store.commit(commitRequest(next))).kind, 'committed'); return next;
}
async function seed(store, workId, revisions, conversationId = 'history') {
  let state = initial(workId, conversationId); assert.equal((await store.commit(commitRequest(state))).kind, 'committed');
  while (state.revision < revisions) state = await append(store, state);
  return state;
}
function expectedMetadata(revision, limit = 5) {
  const first = Math.max(1, revision - limit + 1);
  return { items: Array.from({ length: revision - first + 1 }, (_, index) => {
    const sequence = first + index; return { sequence, revision: sequence, type: 'synthetic_query_tick', at: 999 + sequence };
  }), omittedCount: Math.max(0, revision - limit) };
}
function numericDelta(before, after) { return Object.fromEntries(Object.keys(after).map(key => [key, after[key] - (before[key] ?? 0)])); }
function summarized(value) {
  if (value?.schemaVersion === 1 && value?.goal) return { kind: 'state', revision: value.revision, sha256: digest(value) };
  if (Array.isArray(value?.items)) return { kind: 'event-metadata', items: value.items, omittedCount: value.omittedCount, sha256: digest(value),
    eventBodyMarkerPresent: JSON.stringify(value).includes(bodyMarker) };
  return { kind: 'conversation-page', workIds: value.workIds, returnedCount: value.workIds.length, hasNext: value.nextCursor !== null,
    cursorSha256: value.nextCursor === null ? null : sha256(value.nextCursor) };
}
async function measure(store, name, operation, expected) {
  const before = store.metrics(); const started = performance.now(); const value = await operation(); const elapsedMs = performance.now() - started;
  const after = store.metrics(); if (expected !== undefined) assert.deepEqual(value, expected);
  return { name, elapsedMs, delta: numericDelta(before, after), gaugesAfter: { retainedProjectionBytes: after.retainedProjectionBytes,
    cachedWorks: after.cachedWorks, observedRecordIdentities: after.observedRecordIdentities }, result: summarized(value), value };
}
function observedOnly(measurement) { const { value, ...observation } = measurement; return observation; }

async function historyCosts(revisions) {
  const path = join(directory, `journal-history-${revisions}`); const workId = `history-${revisions}`;
  const writer = retain(new FileJournalStateRepository(path)); let expectedState = await seed(writer, workId, revisions); await close(writer);
  const stateReader = retain(new FileJournalStateRepository(path)); const metadataReader = retain(new FileJournalStateRepository(path));
  const rows = [];
  const stateRead = async (store, phase, expected = expectedState) => {
    const row = await measure(store, `${phase}:get`, () => store.get(workId), expected); rows.push(observedOnly(row)); return row;
  };
  const metadataRead = async (store, phase, throughRevision = expectedState.revision) => {
    const row = await measure(store, `${phase}:recentEventMetadata`, () => store.recentEventMetadata(workId, { throughRevision, limit: 5 }), expectedMetadata(throughRevision));
    assert.equal(row.result.eventBodyMarkerPresent, false); rows.push(observedOnly(row)); return row;
  };
  const coldState = await stateRead(stateReader, 'cold'); const warmState = await stateRead(stateReader, 'warm');
  const coldMetadata = await metadataRead(metadataReader, 'cold'); const warmMetadata = await metadataRead(metadataReader, 'warm');
  assert.equal(coldState.delta.parsedRecords, revisions); assert.equal(coldMetadata.delta.parsedRecords, revisions);
  for (const row of [warmState, warmMetadata]) { assert.equal(row.delta.parsedRecords, 0); assert.equal(row.delta.replayedRecords, 0);
    assert.equal(row.delta.recordReads, revisions); assert.equal(row.delta.rawHashCalls, revisions); assert.ok(row.delta.recordBytes > 0); }
  const otherWriter = retain(new FileJournalStateRepository(path)); expectedState = await append(otherWriter, expectedState); await close(otherWriter);
  const appendedState = await stateRead(stateReader, 'other-instance-append'); const appendedMetadata = await metadataRead(metadataReader, 'other-instance-append');
  for (const row of [appendedState, appendedMetadata]) { assert.equal(row.delta.parsedRecords, 1); assert.equal(row.delta.replayedRecords, 1);
    assert.equal(row.delta.recordReads, revisions + 1); }
  await metadataRead(metadataReader, 'pinned-old-revision-after-append', revisions);
  await close(stateReader); await close(metadataReader);
  const reopenedState = retain(new FileJournalStateRepository(path)); const reopenedMetadata = retain(new FileJournalStateRepository(path));
  const reopenedGet = await stateRead(reopenedState, 'reopen'); const reopenedTail = await metadataRead(reopenedMetadata, 'reopen');
  assert.equal(reopenedGet.delta.parsedRecords, revisions + 1); assert.equal(reopenedTail.delta.parsedRecords, revisions + 1);
  await close(reopenedState); await close(reopenedMetadata);
  return { seededRevisions: revisions, appendedRevisions: 1, eventsPerRevision: 1, generatedEventBodyBytes: Buffer.byteLength(body),
    metadataLimit: 5, equivalenceAssertionsPassed: true, observations: rows };
}

const pageIds = Array.from({ length: 45 }, (_, index) => `page-work-${String(index).padStart(2, '0')}`);
const hashOrderedIds = [...pageIds].sort((a, b) => sha256(a).localeCompare(sha256(b)));
async function journalPages(sparse) {
  const path = join(directory, sparse ? 'journal-pages-sparse' : 'journal-pages-all'); const writer = retain(new FileJournalStateRepository(path));
  const expected = sparse ? hashOrderedIds.slice(40) : pageIds;
  for (const workId of pageIds) await seed(writer, workId, 1, expected.includes(workId) ? 'selected' : 'other');
  await close(writer); const reader = retain(new FileJournalStateRepository(path));
  let cursor; const pages = []; const all = [];
  for (let index = 0; index < 3; index++) {
    const query = { ...route('selected'), ...(cursor === undefined ? {} : { cursor }) };
    const page = await measure(reader, `page-${index + 1}`, () => reader.conversationWorkPage(query));
    assert.equal(page.delta.inspectedWorks, index < 2 ? 20 : 5); assert.equal(page.value.nextCursor !== null, index < 2);
    assert.equal(page.value.workIds.length, sparse && index < 2 ? 0 : index < 2 ? 20 : 5);
    all.push(...page.value.workIds); pages.push(observedOnly(page)); cursor = page.value.nextCursor;
  }
  assert.equal(cursor, null); assert.equal(new Set(all).size, all.length); assert.deepEqual([...all].sort(), [...expected].sort());
  const repeated = await measure(reader, 'warm-first-page', () => reader.conversationWorkPage(route('selected')));
  assert.equal(repeated.delta.inspectedWorks, 20); assert.deepEqual(summarized(repeated.value), pages[0].result);
  assert.equal(repeated.delta.parsedRecords, 0); pages.push(observedOnly(repeated)); await close(reader);
  const reopened = retain(new FileJournalStateRepository(path)); const first = await measure(reopened, 'reopened-first-page', () => reopened.conversationWorkPage(route('selected')));
  assert.equal(first.delta.inspectedWorks, 20); assert.deepEqual(summarized(first.value), pages[0].result); pages.push(observedOnly(first)); await close(reopened);
  return { totalWorks: 45, matchingWorks: expected.length, requestedCandidateLimit: 20, order: 'sha256(workId), adapter cursor order',
    sparse, allMatchingIdsRecoveredWithoutDuplication: true, emptyPageWithContinuation: sparse, observations: pages };
}

async function sqliteCosts() {
  const path = join(directory, 'query-cost.sqlite'); const store = retain(new SqliteStateRepository(path));
  const expectedState = await seed(store, 'sqlite-history', 64);
  for (const workId of pageIds) await seed(store, `all-${workId}`, 1, 'all-selected');
  for (const workId of pageIds) await seed(store, `sparse-${workId}`, 1, hashOrderedIds.slice(40).includes(workId) ? 'sparse-selected' : 'other');
  const originalPrepare = DatabaseSync.prototype.prepare; let capture = null;
  DatabaseSync.prototype.prepare = function(sql) {
    const statement = Reflect.apply(originalPrepare, this, [sql]); const entries = capture; if (!entries) return statement;
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target); if (typeof value !== 'function') return value;
      if (key !== 'get' && key !== 'all') return value.bind(target);
      return (...parameters) => {
        const result = Reflect.apply(value, target, parameters); const rows = key === 'all' ? result : result === undefined ? [] : [result];
        entries.push({ sql, method: key, parameters, returnedRows: rows.length, returnedColumnNames: [...new Set(rows.flatMap(row => Object.keys(row)))],
          returnedResultJsonBytes: Buffer.byteLength(JSON.stringify(result ?? null)) }); return result;
      };
    } });
  };
  async function traced(name, operation) {
    const trace = []; capture = trace; const started = performance.now();
    try { const value = await operation(); return { name, elapsedMs: performance.now() - started, preparedStatements: trace, result: summarized(value), value }; }
    finally { capture = null; }
  }
  let rows;
  try {
    const tail = await traced('metadata-tail-through-revision-64', () => store.recentEventMetadata('sqlite-history', { throughRevision: 64, limit: 5 }));
    assert.deepEqual(tail.value, expectedMetadata(64)); assert.equal(tail.result.eventBodyMarkerPresent, false);
    const pinned = await traced('metadata-tail-through-revision-32', () => store.recentEventMetadata('sqlite-history', { throughRevision: 32, limit: 5 })); assert.deepEqual(pinned.value, expectedMetadata(32));
    const first = await traced('conversation-all-first-page', () => store.conversationWorkPage(route('all-selected')));
    assert.equal(first.value.workIds.length, 20); assert.ok(first.value.nextCursor);
    const second = await traced('conversation-all-second-page', () => store.conversationWorkPage({ ...route('all-selected'), cursor: first.value.nextCursor }));
    assert.equal(second.value.workIds.length, 20); assert.ok(second.value.nextCursor);
    const third = await traced('conversation-all-third-page', () => store.conversationWorkPage({ ...route('all-selected'), cursor: second.value.nextCursor }));
    assert.equal(third.value.workIds.length, 5); assert.equal(third.value.nextCursor, null);
    assert.deepEqual([...first.value.workIds, ...second.value.workIds, ...third.value.workIds].sort(), pageIds.map(id => `all-${id}`).sort());
    const sparse = await traced('conversation-sparse-first-page', () => store.conversationWorkPage(route('sparse-selected')));
    assert.equal(sparse.value.workIds.length, 5); assert.equal(sparse.value.nextCursor, null); assert.deepEqual([...sparse.value.workIds].sort(), hashOrderedIds.slice(40).map(id => `sparse-${id}`).sort());
    assert.deepEqual(await store.get('sqlite-history'), expectedState);
    rows = [tail, pinned, first, second, third, sparse];
  } finally { capture = null; DatabaseSync.prototype.prepare = originalPrepare; }
  const planner = new DatabaseSync(path, { readOnly: true });
  try {
    for (const row of rows) for (const statement of row.preparedStatements) {
      assert.doesNotMatch(statement.sql, /\bbody\b|\bjson_extract\b|\bjson_each\b|select\s+\*/i);
      assert.equal(statement.returnedColumnNames.includes('body'), false);
      statement.explainQueryPlan = planner.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).all(...statement.parameters).map(result => ({
        id: Number(result.id), parent: Number(result.parent), detail: String(result.detail),
      }));
      assert.ok(statement.explainQueryPlan.some(plan => /SEARCH .*USING (?:COVERING )?INDEX/i.test(plan.detail)), 'bounded query must use an observed indexed search plan');
      statement.selectsFullStateOrEventBody = false;
    }
  } finally { planner.close(); }
  await close(store);
  return { fixtureWorks: 91, historyRevisions: 64, requestedMetadataLimit: 5, conversationLimit: 20,
    equivalenceAssertionsPassed: true, capturedRepositoryQueriesOnly: true, observations: rows.map(observedOnly),
    observationsAre: 'prepare/get/all calls, returned rows/JSON bytes, and EXPLAIN QUERY PLAN; not disk reads, cache misses, CPU profiles, or production latency' };
}

const report = { schemaVersion: 1, status: 'running', observedAt: new Date().toISOString(), profile: 'generated-local-synthetic-query-cost',
  node: { version: process.version, platform: process.platform, arch: process.arch },
  scriptSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
  implementationSha256: Object.fromEntries(await Promise.all(implementationPaths.map(async path => [path, sha256(await readFile(join(runtimeRoot, 'dist', path)))]))),
  realModelInvoked: false, externalServiceInvoked: false, productionDataRead: false,
  fileJournal: { histories: [], conversationPages: [] }, sqlite: null,
  notes: [
    'All records and event payloads are generated in a new temporary directory; no user or company source data is read.',
    'Cold and reopen mean a new repository instance with no retained projection, not a cold operating-system filesystem cache.',
    'Metric deltas exclude construction, fixture writes and other writer operations. elapsedMs is one local observation, not a latency benchmark or percentile.',
    'File-journal recordReads/recordBytes count application readFileSync bytes; they are not physical storage I/O. Warm reads still read and hash historical records to detect mutation.',
    'Warm reuse reduces JSON parse, checksum reconstruction and projection replay. It does not establish constant-cost full-history integrity checking.',
    'inspectedWorks bounds candidate replay per page; directory enumeration and directory/record metadata checks remain separately measured and can depend on total stored works.',
    'retainedProjectionBytes/cachedWorks/observedRecordIdentities are gauges. Serialized projection bytes are not a process heap or memory cap.',
    'Journal candidate pages can be empty with a non-null continuation; SQLite indexed matching pages have different ordering and page fullness. The recovered matching set must remain equal.',
    'SQLite traces establish no full state/event body column in these bounded repository queries and observed index plan selection; they do not measure SQLite physical I/O.',
    'This script measures repository query paths, not complete Web render/SSE costs, source disclosure revalidation, distributed throughput, or actual model quality.',
  ], fixtureCleanup: 'pending' };
try {
  for (const revisions of [32, 64]) report.fileJournal.histories.push(await historyCosts(revisions));
  for (const sparse of [false, true]) report.fileJournal.conversationPages.push(await journalPages(sparse));
  report.sqlite = await sqliteCosts(); report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = { name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 2000) }; process.exitCode = 1;
} finally {
  for (const store of open) { try { await store.close(); } catch {} }
  await rm(directory, { recursive: true, force: true }); report.fixtureCleanup = 'removed';
}
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
process.stdout.write(JSON.stringify({ status: report.status, output, journalHistoryCases: report.fileJournal.histories.length,
  journalPagingCases: report.fileJournal.conversationPages.length, sqliteObserved: report.sqlite !== null }) + '\n');
