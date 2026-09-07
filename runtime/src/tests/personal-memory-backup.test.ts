import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bindAgentDatabase } from '../infrastructure/agent-database-owner.js';
import { SqliteKnowledgeRepository } from '../infrastructure/sqlite-knowledge.js';
import { createOrResumePersonalMemoryBackup, PersonalMemoryBackupFault, type PersonalMemoryBackupOptions } from '../infrastructure/personal-memory-backup.js';
import { inspectPersonalMemorySnapshot, fenceSqlitePersonalMemory } from '../infrastructure/sqlite-personal-memory-migration.js';
import { FileBoundaryFault, hostMetadataFiles } from '../infrastructure/host-metadata-files.js';
import { ownerScope, personalRecord, correctedRecord, legacyRecord, storageCommand } from './personal-knowledge-storage-helpers.js';

async function fixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'personal-memory-backup-'))), sourceDirectory = join(base, 'source');
  mkdirSync(sourceDirectory, { mode: 0o700 }); const path = join(sourceDirectory, 'memory.sqlite'), agentId = randomUUID();
  bindAgentDatabase(path, agentId, 'memory'); const repository = new SqliteKnowledgeRepository(path, { mode: 'agent', agentId });
  let closed = false; const close = async () => { if (!closed) { closed = true; await repository.close(); } };
  t.after(async () => { try { await close(); } finally { rmSync(base, { recursive: true, force: true }); } });
  const first = personalRecord(agentId), corrected = correctedRecord(first), scope = ownerScope(agentId);
  await repository.commit(storageCommand(first, 'first', scope)); await repository.commit(storageCommand(corrected, 'correct', scope));
  await repository.commit(storageCommand(legacyRecord(), 'work-first', { agentId, partition: 'work' }));
  const db = new DatabaseSync(path, { readOnly: true }); let snapshot: ReturnType<typeof inspectPersonalMemorySnapshot>;
  try { db.exec('BEGIN;'); snapshot = inspectPersonalMemorySnapshot(db, agentId); } finally { db.close(); }
  const options: PersonalMemoryBackupOptions = { operationId: randomUUID(), agentId, sourcePath: path, operationDirectory: join(base, 'operation'),
    forbiddenRoots: [], expectedSnapshotDigest: snapshot.snapshotDigest, expectedOwnerDigest: snapshot.ownerDigest, expectedWorkDigest: snapshot.workDigest };
  return { base, path, agentId, repository, snapshot, options, corrected, scope, close };
}
function contains(error: unknown, wanted: unknown): boolean {
  if (error === wanted) return true;
  const value = error as { cause?: unknown; errors?: { error: unknown }[] };
  return value?.cause !== undefined && contains(value.cause, wanted) || !!value?.errors?.some(item => contains(item.error, wanted));
}
function messages(error: unknown): string {
  const value = error as { message?: string; cause?: unknown; errors?: { error: unknown }[] };
  return [value?.message ?? '', value?.cause ? messages(value.cause) : '', ...(value?.errors ?? []).map(item => messages(item.error))].join('\n');
}

test('dedicated backup worker preserves the pinned personal receipts and work data, publishes completion last and reuses the same identity', async t => {
  const f = await fixture(t), before = await f.repository.get('tenant-a', f.corrected.id, f.scope);
  const result = await createOrResumePersonalMemoryBackup(f.options);
  assert.equal(result.snapshot.snapshotDigest, f.snapshot.snapshotDigest); assert.equal(result.snapshot.workDigest, f.snapshot.workDigest);
  assert.equal(result.snapshot.ownerDigest, f.snapshot.ownerDigest); assert.equal(result.snapshot.namespaces[0]!.receipts, 2);
  assert.equal(result.byteLength, statSync(result.backupPath).size); assert.equal(statSync(result.backupPath).nlink, 1);
  assert.equal(statSync(result.backupPath).mode & 0o777, 0o600); assert.equal(statSync(f.options.operationDirectory).mode & 0o777, 0o700);
  const backup = new DatabaseSync(result.backupPath, { readOnly: true });
  try { backup.exec('BEGIN;'); assert.deepEqual(inspectPersonalMemorySnapshot(backup, f.agentId), { ...result.snapshot,
    pageSize: result.pageSize, pageCount: result.pageCount, sqliteVersion: result.sqliteVersion }); }
  finally { backup.close(); }
  const names = readdirSync(f.options.operationDirectory), receipt = readFileSync(join(f.options.operationDirectory, 'backup-complete.json'));
  assert.deepEqual(await createOrResumePersonalMemoryBackup(f.options), result);
  assert.deepEqual(readdirSync(f.options.operationDirectory), names); assert.deepEqual(readFileSync(join(f.options.operationDirectory, 'backup-complete.json')), receipt);
  assert.deepEqual(await f.repository.get('tenant-a', f.corrected.id, f.scope), before);
});

test('same operation rejects a changed fixed work fingerprint before publication and preserves its incomplete candidate', async t => {
  const f = await fixture(t), options = { ...f.options, expectedWorkDigest: '0'.repeat(64) };
  await assert.rejects(createOrResumePersonalMemoryBackup(options), error => {
    assert.ok(error instanceof PersonalMemoryBackupFault); assert.equal(error.publication, 'not_published');
    assert.match(messages(error), /snapshot_changed/); return true;
  });
  const attempts = readdirSync(options.operationDirectory).filter(name => name.startsWith('backup-attempt-')); assert.equal(attempts.length, 1);
  assert.ok(existsSync(join(options.operationDirectory, attempts[0]!, 'candidate.sqlite')));
  assert.equal(existsSync(join(options.operationDirectory, 'backup.sqlite')), false); assert.equal(existsSync(join(options.operationDirectory, 'backup-complete.json')), false);
  await assert.rejects(createOrResumePersonalMemoryBackup(f.options), error => /intent_conflict/.test(messages(error)));
  assert.deepEqual(readdirSync(options.operationDirectory).filter(name => name.startsWith('backup-attempt-')), attempts);
});

test('link succeeds then reports EIO: original and cleanup errors survive and same operation repairs the exact two-link candidate', async t => {
  const f = await fixture(t), link = fs.linkSync, unlink = fs.unlinkSync;
  const linkError = Object.assign(new Error('injected-link-after-effect'), { code: 'EIO' });
  const cleanupError = Object.assign(new Error('injected-candidate-cleanup'), { code: 'EACCES' });
  let linked = false;
  Reflect.set(fs, 'linkSync', ((from, to) => { link(from, to); if (String(to) === join(f.options.operationDirectory, 'backup.sqlite')) { linked = true; throw linkError; } }) as typeof fs.linkSync);
  Reflect.set(fs, 'unlinkSync', ((path) => { if (linked && String(path).endsWith('/candidate.sqlite')) throw cleanupError; unlink(path); }) as typeof fs.unlinkSync);
  syncBuiltinESMExports();
  try {
    await assert.rejects(createOrResumePersonalMemoryBackup(f.options), error => {
      assert.ok(error instanceof PersonalMemoryBackupFault); assert.equal(error.publication, 'published');
      assert.ok(contains(error, linkError)); assert.ok(contains(error, cleanupError)); return true;
    });
  } finally { Reflect.set(fs, 'linkSync', link); Reflect.set(fs, 'unlinkSync', unlink); syncBuiltinESMExports(); }
  const finalPath = join(f.options.operationDirectory, 'backup.sqlite'), identity = statSync(finalPath).ino;
  assert.equal(statSync(finalPath).nlink, 2); assert.equal(existsSync(join(f.options.operationDirectory, 'backup-complete.json')), false);
  const attempts = readdirSync(f.options.operationDirectory).filter(name => name.startsWith('backup-attempt-'));
  const resumed = await createOrResumePersonalMemoryBackup(f.options);
  assert.equal(resumed.identity.object, String(identity)); assert.equal(statSync(finalPath).nlink, 1);
  assert.deepEqual(readdirSync(f.options.operationDirectory).filter(name => name.startsWith('backup-attempt-')), attempts);
});

test('post-link directory sync failure retains sync operation and original EIO, then resume repairs the barrier without another snapshot', async t => {
  const f = await fixture(t), files = hostMetadataFiles(), sync = files.syncDirectory.bind(files);
  const injected = Object.assign(new Error('injected-backup-parent-fsync'), { code: 'EIO' }); let failed = false;
  files.syncDirectory = (directory, observer) => {
    if (!failed && existsSync(join(f.options.operationDirectory, 'backup.sqlite'))) {
      failed = true; throw new FileBoundaryFault('io', 'sync', injected);
    }
    sync(directory, observer);
  };
  try { await assert.rejects(createOrResumePersonalMemoryBackup(f.options), error => {
    assert.ok(error instanceof PersonalMemoryBackupFault); assert.equal(error.publication, 'published'); assert.ok(contains(error, injected));
    assert.ok(error.errors.some(item => item.error instanceof FileBoundaryFault && item.error.operation === 'sync')); return true;
  }); } finally { files.syncDirectory = sync; }
  assert.equal(failed, true); const names = readdirSync(f.options.operationDirectory).filter(name => name.startsWith('backup-attempt-'));
  assert.equal(existsSync(join(f.options.operationDirectory, 'backup-complete.json')), false);
  await createOrResumePersonalMemoryBackup(f.options);
  assert.deepEqual(readdirSync(f.options.operationDirectory).filter(name => name.startsWith('backup-attempt-')), names);
});

test('completed receipt rejects a byte-identical replacement inode and does not overwrite or adopt it', async t => {
  const f = await fixture(t), result = await createOrResumePersonalMemoryBackup(f.options);
  const original = join(f.options.operationDirectory, 'kept-original.sqlite'); renameSync(result.backupPath, original);
  const bytes = readFileSync(original); writeFileSync(result.backupPath, bytes, { mode: 0o600, flag: 'wx' });
  const replacement = statSync(result.backupPath).ino;
  await assert.rejects(createOrResumePersonalMemoryBackup(f.options), error => /file_changed/.test(messages(error)));
  assert.equal(statSync(result.backupPath).ino, replacement); assert.deepEqual(readFileSync(result.backupPath), bytes);
  assert.equal(existsSync(original), true);
});

test('completed backup can resume after the source migration fence advances schema, without taking a new source snapshot', async t => {
  const f = await fixture(t), result = await createOrResumePersonalMemoryBackup(f.options);
  await f.close();
  fenceSqlitePersonalMemory(f.path, { schemaVersion: 1, operationId: f.options.operationId, agentId: f.agentId, targetStoreId: randomUUID(),
    snapshotDigest: f.snapshot.snapshotDigest, ownerDigest: f.snapshot.ownerDigest, workDigest: f.snapshot.workDigest });
  const source = new DatabaseSync(f.path, { readOnly: true });
  try { assert.equal(source.prepare('SELECT version FROM knowledge_schema').get()!['version'], 3); } finally { source.close(); }
  assert.deepEqual(await createOrResumePersonalMemoryBackup(f.options), result);
});

test('dedicated backup worker exits when its supervising IPC connection disappears and cannot publish a canonical file', async () => {
  const child = fork(new URL('../infrastructure/personal-memory-backup-worker.js', import.meta.url), [], {
    execPath: process.execPath, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let timedOut = false;
  const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    // Node 24 may omit close after an explicit parent IPC disconnect; exit reports the reaped process.
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    child.disconnect();
  });
  assert.equal(timedOut, false); assert.equal(result.code, 1); assert.equal(result.signal, null);
  assert.throws(() => process.kill(child.pid!, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH');
});

test('actual supervisor SIGKILL during native backup preserves the source and incomplete candidate, and the orphan worker exits before resume', async t => {
  const f = await fixture(t), marker = join(f.base, 'kill-observation'); mkdirSync(marker, { mode: 0o700 });
  const optionsPath = join(marker, 'options.json'); writeFileSync(optionsPath, JSON.stringify(f.options), { mode: 0o600, flag: 'wx' });
  const helper = new URL('./helpers/personal-memory-backup-kill-worker.js', import.meta.url);
  const supervisor = fork(fileURLToPath(helper), ['supervisor', optionsPath], { execPath: process.execPath, execArgv: [],
    env: { ...process.env, NODE_OPTIONS: `--import=${helper.href}`, SECUMON_BACKUP_TEST_MARKER: marker },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let output = '', timedOut = false;
  supervisor.stderr!.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(-8192); });
  const exited = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    const timer = setTimeout(() => { timedOut = true; supervisor.kill('SIGKILL'); }, 10_000);
    supervisor.once('error', error => { clearTimeout(timer); reject(error); });
    supervisor.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  const started = JSON.parse(readFileSync(join(marker, 'worker-start.json'), 'utf8')) as { pid: number; parent: number };
  let alive = true; const deadline = performance.now() + 5000;
  try {
    while (performance.now() < deadline) {
      try { process.kill(started.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; alive = false; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  } finally { if (alive) { try { process.kill(started.pid, 'SIGKILL'); } catch {} } }
  assert.equal(alive, false, 'the known worker process must actually be gone');
  assert.equal(timedOut, false, output); assert.deepEqual(exited, { code: null, signal: 'SIGKILL' }, output);
  assert.equal(started.parent, supervisor.pid);
  const phase = JSON.parse(readFileSync(join(marker, 'backup-in-progress.json'), 'utf8')) as {
    pid: number; candidatePath: string; remainingPages: number; totalPages: number; configuredRate: number; sourceTransaction: boolean };
  assert.equal(phase.pid, started.pid); assert.ok(phase.remainingPages > 0); assert.ok(phase.totalPages > phase.remainingPages);
  assert.equal(phase.configuredRate, 256); assert.equal(phase.sourceTransaction, true);
  assert.deepEqual(JSON.parse(readFileSync(join(marker, 'worker-exit.json'), 'utf8')), { pid: started.pid, code: 1 });
  assert.ok(existsSync(phase.candidatePath)); assert.equal(existsSync(join(f.options.operationDirectory, 'backup.sqlite')), false);
  assert.equal(existsSync(join(f.options.operationDirectory, 'backup-complete.json')), false);
  const source = new DatabaseSync(f.path, { readOnly: true });
  try { source.exec('BEGIN;'); assert.deepEqual(inspectPersonalMemorySnapshot(source, f.agentId), f.snapshot); } finally { source.close(); }
  const preserved = statSync(phase.candidatePath).ino;
  const resumed = await createOrResumePersonalMemoryBackup(f.options);
  assert.equal(resumed.snapshot.snapshotDigest, f.snapshot.snapshotDigest); assert.equal(statSync(phase.candidatePath).ino, preserved);
  assert.equal(readdirSync(f.options.operationDirectory).filter(name => name.startsWith('backup-attempt-')).length, 2);
});

test('backup scope cannot overlap its source parent and bounded failed attempts cannot silently allocate a fifth candidate', async t => {
  const f = await fixture(t);
  await assert.rejects(createOrResumePersonalMemoryBackup({ ...f.options, operationDirectory: join(f.base, 'source', 'nested-backup') }));
  assert.equal(existsSync(join(f.base, 'source', 'nested-backup')), false);
  const bad = { ...f.options, expectedSnapshotDigest: '0'.repeat(64) };
  await assert.rejects(createOrResumePersonalMemoryBackup(bad));
  for (let i = 0; i < 3; i++) mkdirSync(join(f.options.operationDirectory, `backup-attempt-${randomUUID()}`), { mode: 0o700 });
  const before = readdirSync(f.options.operationDirectory);
  await assert.rejects(createOrResumePersonalMemoryBackup(bad), error => /attempt_limit/.test(messages(error)));
  assert.deepEqual(readdirSync(f.options.operationDirectory), before);
});
