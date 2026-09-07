import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { SQLITE_RECOVERY_PENDING, type SqliteRecoveryFilePin, type SqliteRecoveryKind } from '../application/agent-sqlite-recovery-contracts.js';
import type { KnowledgeRecord } from '../domain/knowledge.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';
import { applyAgentSqliteRecovery, prepareAgentSqliteRecovery, readAgentSqliteRecovery } from '../infrastructure/agent-sqlite-recovery.js';
import { sha256 } from '../infrastructure/digest.js';
import { command, delivery, initial, snapshot } from './state-conformance-helpers.js';

type Stores = Awaited<ReturnType<typeof openAgentStores>>;
const worker = fileURLToPath(new URL('./helpers/agent-database-owner-worker.js', import.meta.url));
const rawText = '복구 이전 요청 원문입니다.\n기존 업무와 메모, 세션을 유지합니다.\n';
const payload = 'a'.repeat(8192);

// This POSIX SIGKILL fixture observes real SQLite rollback, not the Windows native durability boundary.
const options = { timeout: 90000, skip: process.platform === 'win32' ? 'POSIX SIGKILL fixture; Windows recovery needs native-platform validation' : false };
function pin(path: string): SqliteRecoveryFilePin {
  const stat = statSync(path, { bigint: true }), bytes = readFileSync(path);
  assert.equal(stat.isFile(), true); assert.equal(stat.nlink, 1n);
  assert.equal(stat.size, BigInt(bytes.length));
  return { identity: { volume: String(stat.dev), object: String(stat.ino) }, bytes: bytes.length, sha256: sha256(bytes) };
}
async function bounded<T>(promise: Promise<T>, ms: number, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(reason)), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function hotRollback(path: string, agentId: string): Promise<void> {
  const child = fork(worker, ['hot-rollback', path, agentId], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8000); });
  const exit: { observed: boolean; code: number | null; signal: NodeJS.Signals | null } = { observed: false, code: null, signal: null };
  child.once('exit', (code, signal) => { exit.observed = true; exit.code = code; exit.signal = signal; });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  const emergency = setTimeout(() => child.kill('SIGKILL'), 15000);
  try {
    const [message] = await once(child, 'message', { signal: AbortSignal.timeout(12000) });
    assert.deepEqual(message, { type: 'uncommitted-write', changes: 128 }, stderr);
    assert.equal(child.kill('SIGKILL'), true);
    await bounded(closed, 5000, 'hot_rollback_child_close_timeout');
    assert.deepEqual(exit, { observed: true, code: null, signal: 'SIGKILL' }, stderr);
  } finally {
    clearTimeout(emergency);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await bounded(closed, 5000, 'hot_rollback_child_cleanup_unconfirmed');
  }
}
async function fixture(t: TestContext, kind: SqliteRecoveryKind) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-sqlite-recovery-'))), engine = join(base, 'engine');
  mkdirSync(engine, { mode: 0o700 });
  const profiles = new FileAgentProfileStore(engine), active = new Set<Stores>();
  t.after(async () => {
    const errors: unknown[] = [];
    try { for (const stores of active) try { await stores.close(); } catch (error) { errors.push(error); } }
    finally { rmSync(base, { recursive: true, force: true }); }
    if (errors.length) throw new AggregateError(errors, 'sqlite_recovery_fixture_cleanup_failed');
  });
  const profile = profiles.initialize(join(base, 'agent'), { stateBackend: 'sqlite', name: '복구 담당' });
  const host = { identityRegistryDirectory: join(base, 'registry') };
  async function open() { const stores = await openAgentStores(profiles, profile.root, undefined, host); active.add(stores); return stores; }
  async function close(stores: Stores) { await stores.close(); active.delete(stores); }
  const stores = await open(), state = initial('preserved-work');
  const artifact = await stores.artifacts.put(Buffer.from(rawText), { tenantId: state.policy.tenantId,
    labels: ['synthetic'], mediaType: 'text/plain; charset=utf-8' });
  state.artifacts.push(artifact);
  const accepted = command(state, 'original-accept', [delivery(state.id)]);
  assert.equal((await stores.state.commit(accepted)).kind, 'committed');
  const originalWork = await snapshot(stores.state, state.id, [accepted.commandId]);
  const note: KnowledgeRecord = { id: 'preserved-note', tenantId: state.policy.tenantId, namespace: state.goal.scope,
    scope: state.goal.scope, authorId: state.policy.principalId, kind: 'experience', title: '복구 전 메모', body: rawText,
    labels: ['synthetic'], revision: 1, contentRevision: 1, status: 'active', visibility: 'private', reviewState: 'private', review: null,
    sources: [{ workId: state.id, evidenceId: 'original-source', ownerId: state.policy.principalId, sourceId: 'fixture',
      sourceVersion: artifact.sha256, generation: 0, observedAt: 1000, recordedAt: 1000, coverage: 'complete', labels: ['synthetic'] }],
    derivedFrom: [], createdAt: 1000, updatedAt: 1000, expiresAt: null };
  assert.equal((await stores.knowledge.commit({ expectedRevision: 0, commandId: 'original-note', commandDigest: sha256(rawText), next: note })).kind, 'committed');
  const originalNote = await stores.knowledge.get(note.tenantId, note.id); assert.ok(originalNote); assert.deepEqual(originalNote, note);
  const session = await stores.sessions.open({ agentId: profile.identity.agentId, tenantId: state.policy.tenantId,
    principalId: state.policy.principalId }, { route: 'test:sqlite-recovery', now: 1000 });
  const received = await stores.sessions.receive({ scope: session.scope, messageId: 'original-input', digest: sha256(rawText),
    text: rawText, payload: { rawText }, kind: 'work', workId: state.id, labels: ['synthetic'], receivedAt: 1000 });
  await stores.sessions.settle(session.scope, received.input.messageId, received.input.digest, { status: 'applied' });
  const originalInput = await stores.sessions.input(session.scope, received.input.messageId);
  const originalSession = await stores.sessions.get(session.scope);
  const originalHistory = await stores.sessions.history(session.scope, state.policy, { limit: 10 });
  assert.equal(originalInput?.text, rawText); assert.deepEqual(originalHistory.entries.map(entry => entry.text), [rawText]);
  await close(stores);
  const path = kind === 'state' ? profile.paths.state : kind === 'memory' ? profile.paths.memory : join(profile.paths.metadata, 'channel.sqlite');
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE crash_fixture(id INTEGER PRIMARY KEY, payload TEXT NOT NULL); BEGIN;');
    const insert = db.prepare('INSERT INTO crash_fixture VALUES(?,?)');
    for (let id = 1; id <= 128; id++) insert.run(id, payload);
    db.exec('COMMIT;');
  } finally { db.close(); }
  const committed = readFileSync(path);
  await hotRollback(path, profile.identity.agentId);
  const main = readFileSync(path), journal = readFileSync(path + '-journal');
  assert.notDeepEqual(main, committed, 'the killed transaction must have spilled uncommitted pages to the main file');
  assert.ok(journal.length > 512); assert.equal(journal.subarray(0, 8).toString('hex'), 'd9d505f920a163d7');
  assert.equal(main[18], 1); assert.equal(main[19], 1);
  assert.equal(existsSync(path + '-wal'), false); assert.equal(existsSync(path + '-shm'), false);
  const source = { main: pin(path), journal: pin(path + '-journal') };
  return { profiles, profile, host, path, source, main, journal, originalWork, originalNote, originalInput,
    originalSession, originalHistory, session, state, artifact, accepted, open, close };
}
function assertRecovered(path: string, agentId: string, kind: SqliteRecoveryKind) {
  assert.equal(existsSync(path + '-journal'), false);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.deepEqual({ ...db.prepare('SELECT agent_id,kind FROM agent_storage_owner').get() }, { agent_id: agentId, kind });
    assert.equal(db.prepare('SELECT count(*) AS count FROM crash_fixture').get()?.['count'], 128);
    assert.equal(db.prepare('SELECT count(*) AS count FROM crash_fixture WHERE payload=?').get(payload)?.['count'], 128);
    assert.equal(db.prepare('SELECT count(*) AS count FROM crash_fixture WHERE payload=?').get('b'.repeat(8192))?.['count'], 0);
    assert.equal(db.prepare('PRAGMA integrity_check(1)').get()?.['integrity_check'], 'ok');
  } finally { db.close(); }
}

for (const kind of ['state', 'memory', 'channel'] as const) {
  test(`${kind}: preserve an actual hot rollback pair, prepare/apply it, and reopen the original agent stores`, options, async t => {
    const f = await fixture(t, kind), operationId = randomUUID();
    const prepared = await prepareAgentSqliteRecovery(f.profiles, f.profile.root, { operationId, kind, offline: true }, f.host);
    assert.equal(prepared.stage, 'prepared'); assert.ok('preparedDigest' in prepared);
    const status = readAgentSqliteRecovery(f.profiles, f.profile.root, operationId);
    assert.equal(status.stage, 'prepared'); assert.ok('intent' in status && status.intent && status.preserved && status.prepared);
    const preserved = status.preserved;
    assert.deepEqual(status.intent.identity, f.profile.identity); assert.equal(status.intent.databaseKind, kind);
    assert.deepEqual(status.intent.source, f.source);
    assert.equal(status.preserved.intentDigest, status.intent.digest);
    assert.equal(status.prepared.preservedDigest, status.preserved.digest);
    assert.equal(prepared.preparedDigest, status.prepared.digest);
    assert.equal(prepared.prepared.validation.agentId, f.profile.identity.agentId);
    assert.equal(prepared.prepared.validation.kind, kind);
    assert.equal(prepared.prepared.validation.schemaVersion, kind === 'state' ? 3 : kind === 'memory' ? 2 : 1);
    assert.equal(prepared.prepared.validation.personalMemoryFence, null);
    assert.deepEqual(readFileSync(f.path), f.main); assert.deepEqual(readFileSync(f.path + '-journal'), f.journal);
    assert.deepEqual(pin(f.path), f.source.main); assert.deepEqual(pin(f.path + '-journal'), f.source.journal);
    const originals = () => {
      assert.deepEqual(readFileSync(prepared.originalPath), f.main);
      assert.deepEqual(readFileSync(prepared.originalPath + '-journal'), f.journal);
      assert.deepEqual(pin(prepared.originalPath), preserved.main);
      assert.deepEqual(pin(prepared.originalPath + '-journal'), preserved.journal);
    };
    originals();
    assert.notDeepEqual(status.preserved.main.identity, f.source.main.identity);
    assert.notDeepEqual(status.preserved.journal.identity, f.source.journal.identity);
    assert.notDeepEqual(prepared.prepared.candidate.identity, f.source.main.identity);
    assertRecovered(prepared.candidatePath, f.profile.identity.agentId, kind);
    assert.deepEqual(pin(prepared.candidatePath), prepared.prepared.candidate);
    const receipts = ['intent.json', 'original.json', 'prepared.json'].map(name => ({ path: join(prepared.directory, name), bytes: readFileSync(join(prepared.directory, name)) }));
    const applied = await applyAgentSqliteRecovery(f.profiles, f.profile.root,
      { operationId, expectedPreparedDigest: prepared.preparedDigest, offline: true }, f.host);
    assert.equal(applied.stage, 'complete'); assert.equal(applied.historical, false); assert.equal(applied.currentDatabaseVerified, true);
    assert.equal(applied.receipt.preparedDigest, prepared.preparedDigest);
    assert.deepEqual(applied.receipt.applied, prepared.prepared.candidate);
    assert.deepEqual(applied.receipt.validation, prepared.prepared.validation);
    assert.deepEqual(pin(f.path), prepared.prepared.candidate);
    assert.equal(existsSync(prepared.candidatePath), false);
    assert.equal(existsSync(join(f.profile.paths.metadata, SQLITE_RECOVERY_PENDING)), false);
    assertRecovered(f.path, f.profile.identity.agentId, kind);
    const retired = () => {
      assert.deepEqual(readFileSync(f.path + `.retired-${operationId}`), f.main);
      assert.deepEqual(readFileSync(f.path + `-journal.retired-${operationId}`), f.journal);
      assert.deepEqual(pin(f.path + `.retired-${operationId}`), f.source.main);
      assert.deepEqual(pin(f.path + `-journal.retired-${operationId}`), f.source.journal);
    };
    originals(); retired();
    const complete = readAgentSqliteRecovery(f.profiles, f.profile.root, operationId);
    assert.equal(complete.stage, 'complete'); assert.ok('complete' in complete);
    assert.equal(complete.currentDatabaseVerified, false, 'status reports historical receipts rather than certifying the current database');
    assert.equal(complete.pending, null); assert.deepEqual(complete.complete, applied.receipt);
    for (const receipt of receipts) assert.deepEqual(readFileSync(receipt.path), receipt.bytes);
    const completeBytes = readFileSync(join(prepared.directory, 'complete.json'));
    const stores = await f.open();
    try {
      stores.assertIdentityCurrent();
      assert.deepEqual(await snapshot(stores.state, f.state.id, [f.accepted.commandId]), f.originalWork);
      assert.deepEqual(await stores.knowledge.get(f.originalNote.tenantId, f.originalNote.id), f.originalNote);
      assert.deepEqual(await stores.sessions.get(f.session.scope), f.originalSession);
      assert.deepEqual(await stores.sessions.input(f.session.scope, 'original-input'), f.originalInput);
      assert.deepEqual(await stores.sessions.history(f.session.scope, f.state.policy, { limit: 10 }), f.originalHistory);
      assert.equal(Buffer.from(await stores.artifacts.get(f.artifact, f.state.policy)).toString('utf8'), rawText);
      assert.equal((await stores.state.commit(f.accepted)).kind, 'duplicate');
      assert.deepEqual(await snapshot(stores.state, f.state.id, [f.accepted.commandId]), f.originalWork);
    } finally { await f.close(stores); }
    assert.deepEqual(readAgentSqliteRecovery(f.profiles, f.profile.root, operationId), complete);
    assert.deepEqual(readFileSync(join(prepared.directory, 'complete.json')), completeBytes);
    for (const receipt of receipts) assert.deepEqual(readFileSync(receipt.path), receipt.bytes);
    originals(); retired();
  });
}
