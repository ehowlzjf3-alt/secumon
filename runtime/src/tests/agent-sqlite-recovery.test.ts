import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { SQLITE_RECOVERY_PENDING, SqliteRecoveryPendingSchema, type SqliteRecoveryFilePin, type SqliteRecoveryKind } from '../application/agent-sqlite-recovery-contracts.js';
import type { AgentSetupOptions } from '../application/agent-profile-contracts.js';
import type { KnowledgeRecord } from '../domain/knowledge.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';
import { applyAgentSqliteRecovery, prepareAgentSqliteRecovery, readAgentSqliteRecovery } from '../infrastructure/agent-sqlite-recovery.js';
import { SqliteRecoveryWorkerFault } from '../infrastructure/agent-sqlite-recovery-process.js';
import { fenceSqlitePersonalMemory, inspectPersonalMemorySnapshot, sqlitePersonalMemoryFence } from '../infrastructure/sqlite-personal-memory-migration.js';
import { acquireAgentMaintenance, recoverAgentLifecycleLeases } from '../infrastructure/agent-lifecycle-lease.js';
import { openProfileMutationScope, publishProfileJson, syncProfileDirectory } from '../infrastructure/agent-profile-files.js';
import { sha256 } from '../infrastructure/digest.js';
import { advance, command, delivery, initial, snapshot } from './state-conformance-helpers.js';
import type { ApplyCrashPhase } from './helpers/agent-sqlite-recovery-apply-worker.js';
import type { PrepareCopyPhase } from './helpers/agent-sqlite-recovery-prepare-worker.js';

type Stores = Awaited<ReturnType<typeof openAgentStores>>;
const worker = fileURLToPath(new URL('./helpers/agent-database-owner-worker.js', import.meta.url));
const applyWorker = fileURLToPath(new URL('./helpers/agent-sqlite-recovery-apply-worker.js', import.meta.url));
const prepareWorker = fileURLToPath(new URL('./helpers/agent-sqlite-recovery-prepare-worker.js', import.meta.url));
const rawText = '복구 이전 요청 원문입니다.\n기존 업무와 메모, 세션을 유지합니다.\n';
const payload = 'a'.repeat(8192);

// This POSIX SIGKILL fixture observes real SQLite rollback, not the Windows native durability boundary.
const options = { timeout: 90000, skip: process.platform === 'win32' ? 'POSIX SIGKILL fixture; Windows recovery needs native-platform validation' : false };
function pin(path: string, expectedLinks = 1n): SqliteRecoveryFilePin {
  const stat = statSync(path, { bigint: true }), bytes = readFileSync(path);
  assert.equal(stat.isFile(), true); assert.equal(stat.nlink, expectedLinks);
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
async function fixture(t: TestContext, kind: SqliteRecoveryKind,
  beforeHot?: (db: DatabaseSync, context: { path: string; agentId: string; documentStoreId: string | null }) => void,
  personalMemory: 'sqlite' | 'documents' = 'sqlite') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-sqlite-recovery-'))), engine = join(base, 'engine');
  mkdirSync(engine, { mode: 0o700 });
  const profiles = new FileAgentProfileStore(engine), active = new Set<Stores>();
  t.after(async () => {
    const errors: unknown[] = [];
    try { for (const stores of active) try { await stores.close(); } catch (error) { errors.push(error); } }
    finally { rmSync(base, { recursive: true, force: true }); }
    if (errors.length) throw new AggregateError(errors, 'sqlite_recovery_fixture_cleanup_failed');
  });
  const profile = profiles.initialize(join(base, 'agent'), { stateBackend: 'sqlite', name: '복구 담당',
    ...(personalMemory === 'documents' ? { personalMemory } : {}) });
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
    beforeHot?.(db, { path, agentId: profile.identity.agentId,
      documentStoreId: profile.config.schemaVersion === 2 ? profile.config.storage.personalMemory.storeId : null });
    assert.equal(db.isTransaction, false, 'fixture changes must be committed before the separate hot transaction');
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

async function preparedFixture(t: TestContext) {
  const f = await fixture(t, 'state'), operationId = randomUUID();
  const prepared = await prepareAgentSqliteRecovery(f.profiles, f.profile.root, { operationId, kind: 'state', offline: true }, f.host);
  assert.equal(prepared.stage, 'prepared'); assert.ok('preparedDigest' in prepared);
  const preservedPaths = [prepared.originalPath, prepared.originalPath + '-journal',
    ...['intent.json', 'original.json', 'prepared.json'].map(name => join(prepared.directory, name))];
  return { ...f, operationId, prepared, preservedPaths,
    apply: () => applyAgentSqliteRecovery(f.profiles, f.profile.root,
      { operationId, expectedPreparedDigest: prepared.preparedDigest, offline: true }, f.host) };
}
function unchangedFiles(paths: readonly string[]) {
  const before = paths.map(path => ({ path, pin: pin(path), bytes: readFileSync(path) }));
  return () => { for (const file of before) {
    assert.deepEqual(pin(file.path), file.pin, file.path);
    assert.deepEqual(readFileSync(file.path), file.bytes, file.path);
  } };
}

test('apply rejects a different prepared digest before changing the hot pair, candidate, or recovery receipts', options, async t => {
  const f = await preparedFixture(t);
  const unchanged = unchangedFiles([f.path, f.path + '-journal', f.prepared.candidatePath, ...f.preservedPaths]);
  const status = readAgentSqliteRecovery(f.profiles, f.profile.root, f.operationId);
  const expectedPreparedDigest = (f.prepared.preparedDigest[0] === '0' ? '1' : '0') + f.prepared.preparedDigest.slice(1);
  await assert.rejects(applyAgentSqliteRecovery(f.profiles, f.profile.root,
    { operationId: f.operationId, expectedPreparedDigest, offline: true }, f.host), { message: 'sqlite_recovery_prepared_digest_mismatch' });
  unchanged();
  assert.deepEqual(readAgentSqliteRecovery(f.profiles, f.profile.root, f.operationId), status);
  for (const path of [join(f.profile.paths.metadata, SQLITE_RECOVERY_PENDING), join(f.profile.paths.metadata, 'lifecycle-maintenance.json'),
    join(f.prepared.directory, 'complete.json'), f.path + `.retired-${f.operationId}`, f.path + `-journal.retired-${f.operationId}`]) {
    assert.equal(existsSync(path), false, path);
  }
});

test('a published pending recovery blocks normal stores and other operations until its exact prepared operation resumes', options, async t => {
  const f = await preparedFixture(t), pendingPath = join(f.profile.paths.metadata, SQLITE_RECOVERY_PENDING);
  const pending = SqliteRecoveryPendingSchema.parse({ schemaVersion: 1, kind: 'secumon-sqlite-recovery-apply',
    operationId: f.operationId, agentId: f.profile.identity.agentId, preparedDigest: f.prepared.preparedDigest });
  // Reproduce the durable apply boundary after publishing pending and before retiring either source file.
  const maintenance = acquireAgentMaintenance(f.profile.root, true);
  try {
    const scope = openProfileMutationScope(f.profile.root, f.profiles.engineDirectories);
    try {
      assert.equal(publishProfileJson(pendingPath, pending, scope), true);
      syncProfileDirectory(f.profile.paths.metadata, scope); scope.check();
    } finally { scope.close(); }
  } finally { maintenance.close(); }
  assert.equal(existsSync(join(f.profile.paths.metadata, 'lifecycle-maintenance.json')), false);
  const unchanged = unchangedFiles([pendingPath, f.path, f.path + '-journal', f.prepared.candidatePath, ...f.preservedPaths]);
  const status = readAgentSqliteRecovery(f.profiles, f.profile.root, f.operationId);
  assert.equal(status.stage, 'pending'); assert.deepEqual(status.pending, pending);
  await assert.rejects(f.open(), { message: 'agent_sqlite_recovery_resume_required' }); unchanged();
  const otherOperation = randomUUID();
  await assert.rejects(prepareAgentSqliteRecovery(f.profiles, f.profile.root,
    { operationId: otherOperation, kind: 'state', offline: true }, f.host), { message: 'agent_sqlite_recovery_resume_required' }); unchanged();
  await assert.rejects(applyAgentSqliteRecovery(f.profiles, f.profile.root,
    { operationId: otherOperation, expectedPreparedDigest: f.prepared.preparedDigest, offline: true }, f.host),
  { message: 'agent_sqlite_recovery_resume_required' }); unchanged();
  assert.equal(existsSync(join(f.profile.paths.metadata, 'sqlite-recovery', otherOperation)), false);
  assert.deepEqual(readAgentSqliteRecovery(f.profiles, f.profile.root, f.operationId), status);
  const applied = await f.apply();
  assert.equal(applied.historical, false); assert.equal(applied.currentDatabaseVerified, true);
  assert.equal(existsSync(pendingPath), false); assert.deepEqual(pin(f.path), f.prepared.prepared.candidate);
  assert.deepEqual(pin(f.path + `.retired-${f.operationId}`), f.source.main);
  assert.deepEqual(pin(f.path + `-journal.retired-${f.operationId}`), f.source.journal);
  const stores = await f.open();
  try { assert.deepEqual(await snapshot(stores.state, f.state.id, [f.accepted.commandId]), f.originalWork); }
  finally { await f.close(stores); }
});

test('status and repeated completed apply preserve a later normal database commit and report only historical recovery', options, async t => {
  const f = await preparedFixture(t), applied = await f.apply();
  assert.equal(applied.historical, false); assert.equal(applied.currentDatabaseVerified, true);
  const historicalStatus = readAgentSqliteRecovery(f.profiles, f.profile.root, f.operationId);
  assert.equal(historicalStatus.stage, 'complete'); assert.ok('complete' in historicalStatus);
  assert.equal(historicalStatus.currentDatabaseVerified, false);
  const unchangedRecovery = unchangedFiles([...f.preservedPaths, join(f.prepared.directory, 'complete.json'),
    f.path + `.retired-${f.operationId}`, f.path + `-journal.retired-${f.operationId}`]);
  const next = advance(f.state, 'normal_commit_after_sqlite_recovery'), followup = command(next, 'after-recovery-commit');
  const commandIds = [f.accepted.commandId, followup.commandId];
  let continued: Awaited<ReturnType<typeof snapshot>> | undefined;
  const stores = await f.open();
  try {
    assert.deepEqual(await stores.state.get(f.state.id), f.originalWork.state);
    assert.equal((await stores.state.commit(followup)).kind, 'committed');
    continued = await snapshot(stores.state, f.state.id, commandIds);
    assert.deepEqual(continued.state, next);
    assert.deepEqual(continued.state?.budget, f.originalWork.state?.budget);
    assert.deepEqual(continued.receipts[f.accepted.commandId], f.originalWork.receipts[f.accepted.commandId]);
    assert.ok(continued.receipts[followup.commandId]);
  } finally { await f.close(stores); }
  assert.ok(continued);
  const current = pin(f.path);
  assert.notEqual(current.sha256, applied.receipt.applied.sha256, 'a real store commit changes the recovered database');
  const unchangedCurrent = unchangedFiles([f.path]);
  assert.deepEqual(readAgentSqliteRecovery(f.profiles, f.profile.root, f.operationId), historicalStatus);
  unchangedCurrent(); unchangedRecovery();
  const repeated = await f.apply();
  assert.deepEqual(repeated, { stage: 'complete', historical: true, receipt: applied.receipt, currentDatabaseVerified: false });
  unchangedCurrent(); unchangedRecovery();
  assert.equal(existsSync(f.prepared.candidatePath), false);
  assert.equal(existsSync(join(f.profile.paths.metadata, SQLITE_RECOVERY_PENDING)), false);
  const reopened = await f.open();
  try {
    assert.deepEqual(await snapshot(reopened.state, f.state.id, commandIds), continued);
    assert.equal((await reopened.state.commit(followup)).kind, 'duplicate');
    assert.deepEqual(await snapshot(reopened.state, f.state.id, commandIds), continued);
  } finally { await f.close(reopened); }
  unchangedRecovery();
  assert.deepEqual(readAgentSqliteRecovery(f.profiles, f.profile.root, f.operationId), historicalStatus);
});

function validatorRejected(message: string) {
  return (error: unknown) => {
    assert.ok(error instanceof SqliteRecoveryWorkerFault);
    const failures = error.failures.filter(failure => failure.stage === 'worker');
    assert.equal(failures.length, 1); assert.ok(failures[0]!.error instanceof Error);
    assert.equal(failures[0]!.error.message, message, 'preserve the specific candidate-validation rejection');
    assert.equal(error.workerExit.observed, true); assert.equal(error.workerExit.closed, true);
    assert.equal(error.workerExit.code, 1); assert.equal(error.workerExit.signal, null);
    return true;
  };
}
function assertPreservedRejection(f: Awaited<ReturnType<typeof fixture>>, operationId: string) {
  const status = readAgentSqliteRecovery(f.profiles, f.profile.root, operationId);
  assert.equal(status.stage, 'preserved'); assert.ok('preserved' in status && status.preserved && status.intent);
  assert.equal(status.prepared, null); assert.equal(status.complete, null); assert.equal(status.pending, null);
  assert.deepEqual(status.intent.source, f.source);
  const original = join(status.directory, status.preserved.directory, basename(f.path));
  assert.deepEqual(readFileSync(original), f.main); assert.deepEqual(readFileSync(original + '-journal'), f.journal);
  assert.deepEqual(pin(original), status.preserved.main); assert.deepEqual(pin(original + '-journal'), status.preserved.journal);
  assert.equal(existsSync(join(f.profile.paths.metadata, 'lifecycle-maintenance.json')), false);
  assert.equal(existsSync(f.path + `.retired-${operationId}`), false);
  assert.equal(existsSync(f.path + `-journal.retired-${operationId}`), false);
}

test('prepare rejects a foreign database owner without adopting or changing the original hot rollback pair', options, async t => {
  const foreignOwner = randomUUID();
  const f = await fixture(t, 'state', db => {
    assert.equal(db.prepare('UPDATE agent_storage_owner SET agent_id=? WHERE singleton=1').run(foreignOwner).changes, 1);
    assert.equal(db.prepare('SELECT agent_id FROM agent_storage_owner').get()?.['agent_id'], foreignOwner);
  });
  assert.notEqual(foreignOwner, f.profile.identity.agentId);
  const unchanged = unchangedFiles([f.path, f.path + '-journal']), operationId = randomUUID();
  await assert.rejects(prepareAgentSqliteRecovery(f.profiles, f.profile.root,
    { operationId, kind: 'state', offline: true }, f.host), validatorRejected('agent_storage_owner_mismatch'));
  unchanged(); assertPreservedRejection(f, operationId);
});

test('prepare rejects a missing required state table without repairing the schema or changing the original hot pair', options, async t => {
  const f = await fixture(t, 'state', db => {
    db.exec('DROP TABLE deliveries;');
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='deliveries'").get(), undefined);
    assert.equal(db.prepare('PRAGMA user_version').get()?.['user_version'], 3);
  });
  const unchanged = unchangedFiles([f.path, f.path + '-journal']), operationId = randomUUID();
  await assert.rejects(prepareAgentSqliteRecovery(f.profiles, f.profile.root,
    { operationId, kind: 'state', offline: true }, f.host), validatorRejected('agent_sqlite_recovery_schema_invalid'));
  unchanged(); assertPreservedRejection(f, operationId);
});

test('prepare rejects WAL or SHM mixed with a hot rollback pair while preserving every original file', options, async t => {
  for (const suffix of ['-wal', '-shm']) {
    const f = await fixture(t, 'state'), operationId = randomUUID(), sidecar = f.path + suffix;
    // Presence alone forbids this layout; do not open the hot database to manufacture WAL content.
    writeFileSync(sidecar, Buffer.from(`preserve mixed ${suffix} sidecar\n`), { flag: 'wx', mode: 0o600 });
    const unchanged = unchangedFiles([f.path, f.path + '-journal', sidecar]);
    await assert.rejects(prepareAgentSqliteRecovery(f.profiles, f.profile.root,
      { operationId, kind: 'state', offline: true }, f.host), { message: 'sqlite_recovery_journal_mode_unsupported' });
    unchanged();
    const status = readAgentSqliteRecovery(f.profiles, f.profile.root, operationId);
    assert.equal(status.stage, 'preparing'); assert.ok('intent' in status);
    assert.equal(status.intent, null); assert.equal(status.preserved, null); assert.equal(status.prepared, null);
    assert.equal(status.complete, null); assert.equal(status.pending, null);
    assert.equal(existsSync(join(f.profile.paths.metadata, 'lifecycle-maintenance.json')), false);
    assert.equal(existsSync(f.path + `.retired-${operationId}`), false);
    assert.equal(existsSync(f.path + `-journal.retired-${operationId}`), false);
  }
});

async function interruptApply(f: Awaited<ReturnType<typeof preparedFixture>>, phase: ApplyCrashPhase) {
  const engine = f.profiles.engineDirectories[0]; assert.ok(engine);
  const child = fork(applyWorker, [engine, f.profile.root, f.host.identityRegistryDirectory,
    f.operationId, f.prepared.preparedDigest, phase], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8000); });
  const exit: { observed: boolean; code: number | null; signal: NodeJS.Signals | null } = { observed: false, code: null, signal: null };
  child.once('exit', (code, signal) => { exit.observed = true; exit.code = code; exit.signal = signal; });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  const emergency = setTimeout(() => child.kill('SIGKILL'), 30000);
  try {
    const [message] = await once(child, 'message', { signal: AbortSignal.timeout(25000) });
    const source = phase === 'main-retired-link' ? f.path : phase === 'journal-retired' ? f.path + '-journal' :
      phase === 'candidate-published-link' ? f.prepared.candidatePath : null;
    const target = phase === 'main-retired-link' ? f.path + `.retired-${f.operationId}` : phase === 'journal-retired' ?
      f.path + `-journal.retired-${f.operationId}` : phase === 'candidate-published-link' ? f.path : join(f.prepared.directory, 'complete.json');
    assert.deepEqual(message, { type: 'apply-boundary', phase, operationId: f.operationId,
      preparedDigest: f.prepared.preparedDigest, pid: child.pid, source, target,
      publication: phase === 'complete-published' ? { publication: 'published', created: true, fileSynced: true,
        directorySynced: true, cleanup: 'removed', published: true } : null }, stderr);
    assert.equal(child.kill('SIGKILL'), true);
    await bounded(closed, 5000, 'sqlite_recovery_apply_child_close_timeout');
    assert.deepEqual(exit, { observed: true, code: null, signal: 'SIGKILL' }, stderr);
    assert.ok(child.pid); return child.pid;
  } finally {
    clearTimeout(emergency);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await bounded(closed, 5000, 'sqlite_recovery_apply_child_cleanup_unconfirmed');
  }
}

for (const phase of ['candidate-published-link', 'complete-published', 'main-retired-link', 'journal-retired'] as const) {
  test(`actual apply interruption at ${phase} retains pending and resumes the same candidate after dead-lease recovery`, options, async t => {
    const f = await preparedFixture(t), originalRecovery = unchangedFiles(f.preservedPaths);
    const childPid = await interruptApply(f, phase);
    const retiredMain = f.path + `.retired-${f.operationId}`, retiredJournal = f.path + `-journal.retired-${f.operationId}`;
    const pendingPath = join(f.profile.paths.metadata, SQLITE_RECOVERY_PENDING), pendingBytes = readFileSync(pendingPath);
    const pending = SqliteRecoveryPendingSchema.parse(JSON.parse(pendingBytes.toString('utf8')));
    assert.deepEqual(pending, { schemaVersion: 1, kind: 'secumon-sqlite-recovery-apply', operationId: f.operationId,
      agentId: f.profile.identity.agentId, preparedDigest: f.prepared.preparedDigest });
    const maintenancePath = join(f.profile.paths.metadata, 'lifecycle-maintenance.json');
    assert.equal((JSON.parse(readFileSync(maintenancePath, 'utf8')) as { pid?: number }).pid, childPid);
    const assertInterruptedFiles = () => {
      assert.deepEqual(pin(retiredMain, phase === 'main-retired-link' ? 2n : 1n), f.source.main);
      if (phase === 'main-retired-link') {
        assert.deepEqual(pin(f.path, 2n), f.source.main);
        assert.deepEqual(pin(f.path + '-journal'), f.source.journal); assert.equal(existsSync(retiredJournal), false);
      } else {
        assert.equal(existsSync(f.path + '-journal'), false); assert.deepEqual(pin(retiredJournal), f.source.journal);
        if (phase === 'journal-retired') assert.equal(existsSync(f.path), false);
        else assert.deepEqual(pin(f.path, phase === 'candidate-published-link' ? 2n : 1n), f.prepared.prepared.candidate);
      }
      if (phase === 'complete-published') assert.equal(existsSync(f.prepared.candidatePath), false);
      else assert.deepEqual(pin(f.prepared.candidatePath, phase === 'candidate-published-link' ? 2n : 1n), f.prepared.prepared.candidate);
      originalRecovery(); assert.deepEqual(readFileSync(pendingPath), pendingBytes);
    };
    assertInterruptedFiles();
    const completePath = join(f.prepared.directory, 'complete.json');
    const completedReceipt = phase === 'complete-published' ? readFileSync(completePath) : null;
    assert.equal(existsSync(completePath), completedReceipt !== null);
    assert.deepEqual(recoverAgentLifecycleLeases(f.profile.root, true), { recovered: 1 });
    assert.equal(existsSync(maintenancePath), false); assertInterruptedFiles();
    await assert.rejects(f.open(), { message: 'agent_sqlite_recovery_resume_required' }); assertInterruptedFiles();
    const interruptedStatus = readAgentSqliteRecovery(f.profiles, f.profile.root, f.operationId);
    assert.equal(interruptedStatus.stage, completedReceipt ? 'complete' : 'pending');
    assert.deepEqual(interruptedStatus.pending, pending);
    const resumed = await f.apply();
    assert.equal(resumed.historical, false); assert.equal(resumed.currentDatabaseVerified, true);
    assert.deepEqual(resumed.receipt.applied, f.prepared.prepared.candidate);
    assert.equal(resumed.receipt.preparedDigest, f.prepared.preparedDigest);
    assert.equal(existsSync(pendingPath), false); assert.equal(existsSync(maintenancePath), false);
    assert.equal(existsSync(f.prepared.candidatePath), false);
    assert.deepEqual(pin(f.path), f.prepared.prepared.candidate);
    assert.deepEqual(pin(retiredMain), f.source.main); assert.deepEqual(pin(retiredJournal), f.source.journal);
    originalRecovery(); assertRecovered(f.path, f.profile.identity.agentId, 'state');
    if (completedReceipt) assert.deepEqual(readFileSync(completePath), completedReceipt, 'resume preserves the already published completion receipt');
    const finalStatus = readAgentSqliteRecovery(f.profiles, f.profile.root, f.operationId);
    assert.equal(finalStatus.stage, 'complete'); assert.ok('complete' in finalStatus);
    assert.equal(finalStatus.pending, null); assert.deepEqual(finalStatus.complete, resumed.receipt);
    const stores = await f.open();
    try {
      assert.deepEqual(await snapshot(stores.state, f.state.id, [f.accepted.commandId]), f.originalWork);
      assert.deepEqual(await stores.knowledge.get(f.originalNote.tenantId, f.originalNote.id), f.originalNote);
      assert.deepEqual(await stores.sessions.input(f.session.scope, 'original-input'), f.originalInput);
    } finally { await f.close(stores); }
    originalRecovery();
  });
}

async function interruptPrepare(f: Awaited<ReturnType<typeof fixture>>, operationId: string, phase: PrepareCopyPhase, attempt: number) {
  const engine = f.profiles.engineDirectories[0]; assert.ok(engine);
  const folder = join(f.profile.paths.metadata, 'sqlite-recovery', operationId);
  const target = join(folder, `${phase}-${String(attempt).padStart(4, '0')}`, basename(f.path));
  const child = fork(prepareWorker, [engine, f.profile.root, f.host.identityRegistryDirectory, operationId, phase, String(attempt)],
    { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8000); });
  const exit: { observed: boolean; code: number | null; signal: NodeJS.Signals | null } = { observed: false, code: null, signal: null };
  child.once('exit', (code, signal) => { exit.observed = true; exit.code = code; exit.signal = signal; });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  const emergency = setTimeout(() => child.kill('SIGKILL'), 30000);
  try {
    const [message] = await once(child, 'message', { signal: AbortSignal.timeout(25000) });
    assert.ok(message && Number.isSafeInteger(message.written) && message.written > 0 && message.written < f.main.length);
    assert.deepEqual(message, { type: 'prepare-copy', phase, attempt, operationId, target, pid: child.pid,
      written: message.written, bytes: message.written }, stderr);
    assert.equal(child.kill('SIGKILL'), true);
    await bounded(closed, 5000, 'sqlite_recovery_prepare_child_close_timeout');
    assert.deepEqual(exit, { observed: true, code: null, signal: 'SIGKILL' }, stderr);
    assert.equal(pin(target).bytes, message.written);
    assert.deepEqual(readFileSync(target), f.main.subarray(0, message.written), 'the retained partial file contains the actual original prefix');
  } finally {
    clearTimeout(emergency);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await bounded(closed, 5000, 'sqlite_recovery_prepare_child_cleanup_unconfirmed');
  }
  assert.equal(existsSync(target + '-journal'), false);
  const status = readAgentSqliteRecovery(f.profiles, f.profile.root, operationId);
  assert.equal(status.stage, phase === 'original' ? 'preparing' : 'preserved');
  assert.ok('intent' in status && status.intent); assert.deepEqual(status.intent.source, f.source);
  assert.equal(status.prepared, null); assert.equal(status.complete, null); assert.equal(status.pending, null);
  const paths = [f.path, f.path + '-journal', target, join(folder, 'intent.json')];
  if (phase === 'candidate') {
    assert.ok(status.preserved);
    const original = join(folder, status.preserved.directory, basename(f.path));
    assert.deepEqual(readFileSync(original), f.main); assert.deepEqual(readFileSync(original + '-journal'), f.journal);
    paths.push(original, original + '-journal', join(folder, 'original.json'));
  } else assert.equal(status.preserved, null);
  const unchanged = unchangedFiles(paths), leasePath = join(f.profile.paths.metadata, 'lifecycle-maintenance.json');
  assert.equal((JSON.parse(readFileSync(leasePath, 'utf8')) as { pid?: number }).pid, child.pid);
  assert.deepEqual(recoverAgentLifecycleLeases(f.profile.root, true), { recovered: 1 });
  assert.equal(existsSync(leasePath), false); unchanged();
  return { target, folder, intentDigest: status.intent.digest, unchanged };
}

for (const phase of ['original', 'candidate'] as const) {
  test(`prepare ${phase} copy interruption preserves the partial attempt and retries the same ID in a new directory`, options, async t => {
    const f = await fixture(t, 'state'), operationId = randomUUID();
    const interrupted = await interruptPrepare(f, operationId, phase, 1);
    const prepared = await prepareAgentSqliteRecovery(f.profiles, f.profile.root, { operationId, kind: 'state', offline: true }, f.host);
    assert.equal(prepared.stage, 'prepared'); assert.ok('preparedDigest' in prepared);
    interrupted.unchanged();
    const status = readAgentSqliteRecovery(f.profiles, f.profile.root, operationId);
    assert.ok('preserved' in status && status.preserved && status.intent);
    assert.equal(status.intent.digest, interrupted.intentDigest);
    assert.equal(status.preserved.directory, phase === 'original' ? 'original-0002' : 'original-0001');
    assert.equal(prepared.prepared.directory, phase === 'candidate' ? 'candidate-0002' : 'candidate-0001');
    assertRecovered(prepared.candidatePath, f.profile.identity.agentId, 'state');
    const names = readdirSync(interrupted.folder).sort();
    assert.deepEqual(await prepareAgentSqliteRecovery(f.profiles, f.profile.root,
      { operationId, kind: 'state', offline: true }, f.host), prepared);
    assert.deepEqual(readdirSync(interrupted.folder).sort(), names); interrupted.unchanged();
  });

  test(`prepare ${phase} copy attempt limit preserves all four interrupted directories and refuses a fifth`, options, async t => {
    const f = await fixture(t, 'state'), operationId = randomUUID(), retained: Array<() => void> = [];
    let last: Awaited<ReturnType<typeof interruptPrepare>> | undefined;
    for (let attempt = 1; attempt <= 4; attempt++) {
      last = await interruptPrepare(f, operationId, phase, attempt); retained.push(last.unchanged);
      for (const unchanged of retained) unchanged();
    }
    assert.ok(last);
    const names = readdirSync(last.folder).sort();
    assert.deepEqual(names.filter(name => name.startsWith(phase + '-')), [1, 2, 3, 4].map(n => `${phase}-000${n}`));
    const before = readAgentSqliteRecovery(f.profiles, f.profile.root, operationId);
    await assert.rejects(prepareAgentSqliteRecovery(f.profiles, f.profile.root,
      { operationId, kind: 'state', offline: true }, f.host), { message: 'sqlite_recovery_attempt_limit' });
    for (const unchanged of retained) unchanged();
    assert.deepEqual(readdirSync(last.folder).sort(), names);
    assert.deepEqual(readAgentSqliteRecovery(f.profiles, f.profile.root, operationId), before);
    assert.equal(existsSync(join(last.folder, `${phase}-0005`)), false);
    assert.equal(existsSync(join(f.profile.paths.metadata, 'lifecycle-maintenance.json')), false);
    assert.equal(existsSync(join(f.profile.paths.metadata, SQLITE_RECOVERY_PENDING)), false);
  });
}

test('documents recovery rejects a valid personal-memory fence belonging to another document store', options, async t => {
  let expectedFence: ReturnType<typeof fenceSqlitePersonalMemory> | undefined;
  const f = await fixture(t, 'memory', (db, context) => {
    assert.ok(context.documentStoreId);
    db.exec('BEGIN;'); const source = inspectPersonalMemorySnapshot(db, context.agentId); db.exec('COMMIT;');
    const targetStoreId = randomUUID(); assert.notEqual(targetStoreId, context.documentStoreId);
    expectedFence = { schemaVersion: 1, operationId: randomUUID(), agentId: context.agentId, targetStoreId,
      snapshotDigest: source.snapshotDigest, ownerDigest: source.ownerDigest, workDigest: source.workDigest };
    assert.deepEqual(fenceSqlitePersonalMemory(context.path, expectedFence), expectedFence);
    assert.deepEqual(sqlitePersonalMemoryFence(db, context.agentId), expectedFence, 'the fixture fence itself is valid before the hot transaction');
  }, 'documents');
  assert.ok(expectedFence); assert.equal(f.profile.config.schemaVersion, 2);
  const unchanged = unchangedFiles([f.path, f.path + '-journal']), operationId = randomUUID();
  await assert.rejects(prepareAgentSqliteRecovery(f.profiles, f.profile.root,
    { operationId, kind: 'memory', offline: true }, f.host), validatorRejected('agent_sqlite_recovery_memory_fence_mismatch'));
  unchanged(); assertPreservedRejection(f, operationId);
  const status = readAgentSqliteRecovery(f.profiles, f.profile.root, operationId);
  assert.ok('intent' in status && status.intent);
  assert.equal(status.intent.validation.personalMemory?.backend, 'documents');
});

test('prepare rejects super-journal names and rollback trailers while preserving the original files', options, async t => {
  for (const form of ['name', 'trailer'] as const) {
    const f = await fixture(t, 'state'), operationId = randomUUID();
    const dependency = form === 'name' ? f.path + '-mj-fixture' : join(dirname(f.profile.root), 'external-super-journal');
    writeFileSync(dependency, 'preserve the external journal dependency\n', { flag: 'wx', mode: 0o600 });
    if (form === 'trailer') {
      const filename = Buffer.from(dependency), footer = Buffer.alloc(16), pageMarker = Buffer.alloc(4);
      const encodedPageSize = f.main.readUInt16BE(16), pageSize = encodedPageSize === 1 ? 65536 : encodedPageSize;
      pageMarker.writeUInt32BE(0x40000000 / pageSize + 1);
      footer.writeUInt32BE(filename.length, 0); footer.writeUInt32BE(filename.reduce((sum, byte) => (sum + byte) >>> 0, 0), 4);
      Buffer.from('d9d505f920a163d7', 'hex').copy(footer, 8);
      appendFileSync(f.path + '-journal', Buffer.concat([pageMarker, filename, footer]));
    }
    const unchanged = unchangedFiles([f.path, f.path + '-journal', dependency]);
    await assert.rejects(prepareAgentSqliteRecovery(f.profiles, f.profile.root, { operationId, kind: 'state', offline: true }, f.host),
      { message: form === 'name' ? 'sqlite_recovery_journal_mode_unsupported' : 'sqlite_recovery_super_journal_unsupported' });
    unchanged();
    const status = readAgentSqliteRecovery(f.profiles, f.profile.root, operationId);
    assert.equal(status.stage, 'preparing'); assert.ok('intent' in status);
    assert.equal(status.intent, null); assert.equal(status.preserved, null); assert.equal(status.prepared, null); assert.equal(status.complete, null);
    assert.deepEqual(readdirSync(status.directory), []);
    assert.equal(existsSync(join(f.profile.paths.metadata, 'lifecycle-maintenance.json')), false);
  }
});

for (const missing of ['table', 'row'] as const) {
  test(`prepare rejects a missing owner ${missing} without binding or changing the original hot rollback pair`, options, async t => {
    const f = await fixture(t, 'state', db => {
      if (missing === 'table') {
        db.exec('DROP TABLE agent_storage_owner;');
        assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='agent_storage_owner'").get(), undefined);
      } else {
        assert.equal(db.prepare('DELETE FROM agent_storage_owner WHERE singleton=1').run().changes, 1);
        assert.equal(db.prepare('SELECT count(*) AS count FROM agent_storage_owner').get()?.['count'], 0);
      }
    });
    const unchanged = unchangedFiles([f.path, f.path + '-journal']), operationId = randomUUID();
    await assert.rejects(prepareAgentSqliteRecovery(f.profiles, f.profile.root,
      { operationId, kind: 'state', offline: true }, f.host),
    validatorRejected(missing === 'table' ? 'agent_storage_owner_missing' : 'agent_storage_owner_mismatch'));
    unchanged(); assertPreservedRejection(f, operationId);
  });
}

for (const selection of ['file-journal', 'postgres-state', 'postgres-memory', 'postgres-channel'] as const) {
  test(`prepare rejects ${selection} selection before adopting a leftover local rollback pair`, options, async t => {
    const kind: SqliteRecoveryKind = selection === 'postgres-memory' ? 'memory' : selection === 'postgres-channel' ? 'channel' : 'state';
    const f = await fixture(t, kind), purpose = kind === 'memory' ? 'knowledge' : kind;
    const setup: AgentSetupOptions = selection === 'file-journal' ? { stateBackend: 'file-journal' } : {
      postgres: { storeId: randomUUID(), registrationId: randomUUID(), purposes: [purpose] },
    };
    // Persist a real selection using setup only. No PostgreSQL pool, endpoint, or physical-store open is supplied.
    const selected = f.profiles.initialize(join(dirname(f.profile.root), 'selected-agent'), setup);
    assert.equal(selected.status, 'ready');
    if (selection === 'file-journal') assert.equal(selected.config.storage.state, 'file-journal');
    else assert.deepEqual(selected.config.storage.postgres, setup.postgres);
    const path = kind === 'state' ? join(selected.paths.metadata, 'runtime.sqlite') :
      kind === 'memory' ? selected.paths.memory : join(selected.paths.metadata, 'channel.sqlite');
    // These leftover bytes belong to the other temporary agent. Selection must reject them before owner inspection or rollback.
    writeFileSync(path, f.main, { flag: 'wx', mode: 0o600 });
    writeFileSync(path + '-journal', f.journal, { flag: 'wx', mode: 0o600 });
    assert.notEqual(selected.identity.agentId, f.profile.identity.agentId);
    const unchanged = unchangedFiles([f.path, f.path + '-journal', path, path + '-journal',
      join(selected.root, 'config.json'), ...['identity.json', 'setup.json', 'setup-operation.json'].map(name => join(selected.paths.metadata, name))]);
    const operationId = randomUUID(), before = readAgentSqliteRecovery(f.profiles, selected.root, operationId);
    assert.deepEqual(before, { operationId, stage: 'not_started', pending: null });
    await assert.rejects(prepareAgentSqliteRecovery(f.profiles, selected.root,
      { operationId, kind, offline: true }, f.host), { message: 'sqlite_recovery_local_database_not_selected' });
    unchanged(); assert.deepEqual(readAgentSqliteRecovery(f.profiles, selected.root, operationId), before);
    assert.equal(existsSync(join(selected.paths.metadata, 'sqlite-recovery')), false);
    assert.equal(existsSync(join(selected.paths.metadata, 'lifecycle-maintenance.json')), false);
    assert.equal(existsSync(join(selected.paths.metadata, SQLITE_RECOVERY_PENDING)), false);
    assert.equal(existsSync(path + '-wal'), false); assert.equal(existsSync(path + '-shm'), false);
    if (selection === 'file-journal') assert.equal(existsSync(selected.paths.state), false);
  });
}

for (const file of ['main', 'journal'] as const) {
  for (const change of ['same-bytes replacement', 'same-inode content mutation'] as const) {
    test(`same-operation prepare rejects original ${file} ${change} while retaining all interrupted recovery files`, options, async t => {
      const f = await fixture(t, 'state'), operationId = randomUUID();
      const interrupted = await interruptPrepare(f, operationId, 'candidate', 1);
      const before = readAgentSqliteRecovery(f.profiles, f.profile.root, operationId);
      assert.equal(before.stage, 'preserved'); assert.ok('preserved' in before && before.preserved && before.intent);
      const original = join(interrupted.folder, before.preserved.directory, basename(f.path));
      const recoveryUnchanged = unchangedFiles([interrupted.target, original, original + '-journal',
        join(interrupted.folder, 'intent.json'), join(interrupted.folder, 'original.json')]);
      const names = readdirSync(interrupted.folder).sort(), path = file === 'main' ? f.path : f.path + '-journal';
      const expected = f.source[file], bytes = readFileSync(path), heldOriginal = path + '.fixture-original';
      if (change === 'same-bytes replacement') {
        const mode = statSync(path).mode & 0o777;
        renameSync(path, heldOriginal);
        writeFileSync(path, bytes, { flag: 'wx', mode });
        assert.deepEqual(pin(heldOriginal), expected);
        assert.notDeepEqual(pin(path).identity, expected.identity);
        assert.equal(pin(path).sha256, expected.sha256);
      } else {
        // Keep file length, mode, and inode unchanged; alter a byte beyond the rollback/database header.
        assert.ok(bytes.length > 512);
        bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
        writeFileSync(path, bytes, { flag: 'r+' });
        assert.deepEqual(pin(path).identity, expected.identity);
        assert.equal(pin(path).bytes, expected.bytes); assert.notEqual(pin(path).sha256, expected.sha256);
      }
      const sourceUnchanged = unchangedFiles([f.path, f.path + '-journal', ...(change === 'same-bytes replacement' ? [heldOriginal] : [])]);
      await assert.rejects(prepareAgentSqliteRecovery(f.profiles, f.profile.root,
        { operationId, kind: 'state', offline: true }, f.host), { message: 'sqlite_recovery_file_changed' });
      sourceUnchanged(); recoveryUnchanged();
      assert.deepEqual(readAgentSqliteRecovery(f.profiles, f.profile.root, operationId), before);
      assert.deepEqual(readdirSync(interrupted.folder).sort(), names);
      assert.equal(existsSync(join(interrupted.folder, 'candidate-0002')), false);
      assert.equal(existsSync(join(f.profile.paths.metadata, SQLITE_RECOVERY_PENDING)), false);
      assert.equal(existsSync(join(f.profile.paths.metadata, 'lifecycle-maintenance.json')), false);
      assert.equal(existsSync(f.path + `.retired-${operationId}`), false);
      assert.equal(existsSync(f.path + `-journal.retired-${operationId}`), false);
    });
  }
}

test('same-operation prepare rejects a different kind while preserving both databases and prepared receipts', options, async t => {
  const f = await preparedFixture(t), memory = f.profile.paths.memory;
  assert.notEqual(memory, f.path); assert.equal(existsSync(memory), true);
  const unchanged = unchangedFiles([f.path, f.path + '-journal', memory, f.prepared.candidatePath, ...f.preservedPaths]);
  const status = readAgentSqliteRecovery(f.profiles, f.profile.root, f.operationId);
  const names = readdirSync(f.prepared.directory).sort();
  await assert.rejects(prepareAgentSqliteRecovery(f.profiles, f.profile.root,
    { operationId: f.operationId, kind: 'memory', offline: true }, f.host), { message: 'sqlite_recovery_kind_mismatch' });
  unchanged(); assert.deepEqual(readAgentSqliteRecovery(f.profiles, f.profile.root, f.operationId), status);
  assert.deepEqual(readdirSync(f.prepared.directory).sort(), names);
  assert.equal(existsSync(join(f.prepared.directory, 'complete.json')), false);
  assert.equal(existsSync(join(f.profile.paths.metadata, SQLITE_RECOVERY_PENDING)), false);
  assert.equal(existsSync(join(f.profile.paths.metadata, 'lifecycle-maintenance.json')), false);
  assert.equal(existsSync(f.path + `.retired-${f.operationId}`), false);
  assert.equal(existsSync(f.path + `-journal.retired-${f.operationId}`), false);
});
