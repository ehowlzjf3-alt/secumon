import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

// One synthetic fixture only. The same file is a dedicated SQLite worker.
// No product code, build output, existing database, model or network is changed.
const scriptPath = fileURLToPath(import.meta.url);
const runtimeRoot = fileURLToPath(new URL('../', import.meta.url));
const outputPath = scriptPath.replace(/\.mjs$/, '.json');
const logPath = scriptPath.replace(/\.mjs$/, '.log');
const expectedPinPath = join(runtimeRoot, 'evidence/C03-drafts-linux-nas-20260907/build-pin.json');
const hash = value => createHash('sha256').update(value).digest('hex');
const errorInfo = (error, depth = 0) => ({
  name: error?.name ?? 'Error', message: error?.message ?? String(error), stack: error?.stack ?? null,
  code: error?.code ?? null, errcode: error?.errcode ?? null, errstr: error?.errstr ?? null,
  cause: depth < 3 && error?.cause !== undefined ? errorInfo(error.cause, depth + 1) : null,
});

async function reserveEmpty(path) {
  const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await file.sync(); } finally { await file.close(); }
  const identity = await lstat(path);
  assert.ok(identity.isFile() && identity.nlink === 1);
  assert.equal(identity.mode & 0o777, 0o600);
  return { dev: identity.dev, ino: identity.ino };
}

async function worker(directory) {
  process.umask(0o077);
  const { DatabaseSync, backup } = await import('node:sqlite');
  const started = performance.now();
  const result = {
    kind: 'one-synthetic-WAL-read-snapshot-backup', status: 'running', pid: process.pid,
    node: process.version, platform: process.platform, arch: process.arch,
    fixtureCount: 1, rate: 1, sourceRawFdReads: 0, sourceApiCallsWhileBackupPending: 0,
    candidateApiCallsWhileBackupPending: 0, progress: [], stages: [], connectionsOpened: 0, connectionsClosed: 0,
    apiExclusionBasis: 'controlled sequential worker code; no concurrent source/candidate calls or instrumentation during backup',
    backupSettled: false, sourceAndCandidateDistinct: true, cleanupErrors: [],
  };
  let writer, reader, candidateReader;
  function stage(name) {
    const entry = { name, elapsedMs: performance.now() - started };
    result.stages.push(entry); process.send?.({ type: 'stage', ...entry });
  }
  function connect(path, options) { const db = new DatabaseSync(path, options); result.connectionsOpened++; return db; }
  function close(db) {
    if (!db) return;
    try { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); result.connectionsClosed++; }
    catch (error) { result.cleanupErrors.push(errorInfo(error)); }
  }
  const plainRows = db => db.prepare('SELECT id, label, payload FROM probe_rows ORDER BY id').all()
    .map(row => ({ id: row.id, label: row.label, payload: row.payload }));
  const digest = (owner, rows) => hash(JSON.stringify({ schemaVersion: 1, owner, rows }));
  try {
    assert.equal(process.version, 'v24.20.0');
    const directoryStat = await lstat(directory);
    assert.ok(directoryStat.isDirectory() && !directoryStat.isSymbolicLink());
    assert.equal(directoryStat.mode & 0o777, 0o700);
    const sourcePath = join(directory, 'synthetic-source.sqlite');
    const candidatePath = join(directory, 'new-backup-candidate.sqlite');
    const sourceIdentity = await reserveEmpty(sourcePath);
    const candidateIdentity = await reserveEmpty(candidatePath);
    writer = connect(sourcePath, { timeout: 1000 });
    assert.equal(writer.prepare('PRAGMA journal_mode=WAL').get().journal_mode, 'wal');
    writer.exec('PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0; CREATE TABLE probe_owner(id INTEGER PRIMARY KEY, marker TEXT NOT NULL); CREATE TABLE probe_rows(id INTEGER PRIMARY KEY, label TEXT NOT NULL, payload TEXT NOT NULL); BEGIN IMMEDIATE;');
    writer.prepare('INSERT INTO probe_owner VALUES(1,?)').run('C03 migration backup synthetic probe; no user data');
    const insert = writer.prepare('INSERT INTO probe_rows VALUES(?,?,?)');
    for (let id = 1; id <= 6; id++) insert.run(id, `snapshot-row-${id}`, `SYNTHETIC-${id}:` + String(id).repeat(2048));
    writer.exec('COMMIT');
    stage('synthetic_source_created_in_wal');
    reader = connect(sourcePath, { readOnly: true, timeout: 1000 });
    reader.exec('BEGIN');
    const owner = reader.prepare('SELECT marker FROM probe_owner WHERE id=1').get().marker;
    const snapshotRows = plainRows(reader);
    const snapshotDigest = digest(owner, snapshotRows);
    result.sqliteVersion = reader.prepare('SELECT sqlite_version() AS version').get().version;
    result.snapshot = { rowIds: snapshotRows.map(row => row.id), rowCount: snapshotRows.length, logicalDigest: snapshotDigest };
    result.pageSize = reader.prepare('PRAGMA page_size').get().page_size;
    result.snapshotPages = reader.prepare('PRAGMA page_count').get().page_count;
    assert.ok(reader.isTransaction);
    assert.equal(snapshotRows.length, 6);
    stage('readonly_BEGIN_and_main_read_fixed_snapshot');
    writer.exec('BEGIN IMMEDIATE');
    insert.run(7, 'newer-writer-commit', 'SYNTHETIC-LATER:' + 'N'.repeat(2048));
    writer.exec('COMMIT');
    result.walBytesBeforeBackup = (await lstat(sourcePath + '-wal')).size;
    assert.ok(result.walBytesBeforeBackup > 0);
    stage('other_connection_committed_new_row');
    const backupStarted = performance.now();
    stage('same_readonly_handle_backup_started');
    // No source/candidate SQLite or raw-fd API is called until this await settles.
    let pages;
    try {
      pages = await backup(reader, candidatePath, {
        rate: 1,
        progress(info) { result.progress.push({ totalPages: info.totalPages, remainingPages: info.remainingPages }); },
      });
    } finally { result.backupSettled = true; }
    result.backupElapsedMs = performance.now() - backupStarted;
    result.returnedPages = pages;
    result.progressCallbacks = result.progress.length;
    result.finalCallbackRemainingPages = result.progress.at(-1)?.remainingPages ?? null;
    assert.equal(pages, result.snapshotPages);
    assert.ok(result.progress.length > 0, 'fixture must span multiple batches');
    assert.ok(result.progress.every(item => item.remainingPages > 0));
    result.finalPageCompletionObservedBy = 'resolved backup Promise and returned page count; not a progress callback';
    stage('backup_promise_resolved');
    assert.equal(digest(owner, plainRows(reader)), snapshotDigest);
    reader.exec('COMMIT'); close(reader); reader = undefined;
    candidateReader = connect(candidatePath, { readOnly: true, timeout: 1000 });
    const backupOwner = candidateReader.prepare('SELECT marker FROM probe_owner WHERE id=1').get().marker;
    const backupRows = plainRows(candidateReader);
    const backupDigest = digest(backupOwner, backupRows);
    const latestRows = plainRows(writer);
    const latestDigest = digest(owner, latestRows);
    assert.equal(candidateReader.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(backupRows, snapshotRows);
    assert.equal(backupOwner, owner);
    assert.equal(backupDigest, snapshotDigest);
    assert.deepEqual(latestRows.map(row => row.id), [1, 2, 3, 4, 5, 6, 7]);
    assert.notEqual(latestDigest, snapshotDigest);
    result.backup = { rowIds: backupRows.map(row => row.id), rowCount: backupRows.length, logicalDigest: backupDigest, integrityCheck: 'ok' };
    result.latestSource = { rowIds: latestRows.map(row => row.id), rowCount: latestRows.length, logicalDigest: latestDigest };
    result.assertions = { backupEqualsFixedSnapshot: true, latestSourceHasNewCommit: true, snapshotAndLatestDigestsDiffer: true };
    close(candidateReader); candidateReader = undefined;
    close(writer); writer = undefined;
    const sourceStat = await lstat(sourcePath), candidateStat = await lstat(candidatePath);
    assert.deepEqual({ dev: sourceStat.dev, ino: sourceStat.ino }, sourceIdentity);
    assert.deepEqual({ dev: candidateStat.dev, ino: candidateStat.ino }, candidateIdentity);
    assert.equal(sourceStat.mode & 0o777, 0o600); assert.equal(candidateStat.mode & 0o777, 0o600);
    result.fileBytesAfterSqliteClose = { sourceMain: sourceStat.size, backupCandidate: candidateStat.size };
    result.fileModes = { sourceMain: '0600', backupCandidate: '0600', fixtureDirectory: '0700' };
    assert.equal(candidateStat.size, pages * result.pageSize);
    stage('closed_connections_and_verified_backup_snapshot');
    result.status = 'passed';
  } catch (error) { result.status = 'failed'; result.error = errorInfo(error); }
  finally {
    close(candidateReader); close(reader); close(writer);
    if (result.cleanupErrors.length) result.status = 'failed';
    result.elapsedMs = performance.now() - started;
  }
  process.send?.({ type: 'result', result });
  process.exitCode = result.status === 'passed' ? 0 : 1;
  process.disconnect?.();
}

async function parent() {
  assert.equal(process.argv.length, 2, 'no rerun/fixture options; worker is internal');
  assert.equal(process.version, 'v24.20.0');
  const output = await open(outputPath, 'wx', 0o600);
  const log = await open(logPath, 'wx', 0o600);
  const started = performance.now(), logLines = [];
  const report = {
    schemaVersion: 1, kind: 'C03-D3-preimplementation-backup-snapshot-probe', status: 'running', startedAt: new Date().toISOString(),
    scriptPath, scriptSha256: hash(await readFile(scriptPath)), environment: { node: process.version, execPath: process.execPath, platform: process.platform, arch: process.arch },
    maxFixtures: 1, fixturesExecuted: 0, automaticRetries: 0, timeoutMs: 15000,
    sourceBuildPinIsContextOnly: true, D2VerificationResult: false, productImplementationVerified: false,
    existingDatabasesOpened: false, rawSourceCopied: false, modelOrExternalServiceCalled: false, nasUsed: false,
    cleanup: { workerExitObserved: false, fixtureDirectoryRemoved: false, errors: [] },
    limitations: [
      'One local synthetic WAL database, one later writer commit, one fixed read snapshot and one backup call; no repeated benchmark.',
      'Uses Node24.20.0 backup rate 1 to observe multiple batches, not the proposed production default 256.',
      'Does not test the 256MiB limit, a production owner/fence/importer, backup publication, recovery after SIGKILL, Windows or real-model behavior.',
      'The current source/build pin is recorded for provenance. No D2 test is run and this observation is not a D2 result.',
    ],
  };
  let fixtureDirectory, fixtureIdentity, child;
  try {
    const { verifyEvaluationBuild } = await import('../dist/infrastructure/local-evaluation.js');
    report.expectedPin = JSON.parse(await readFile(expectedPinPath, 'utf8'));
    report.buildBefore = await verifyEvaluationBuild(runtimeRoot);
    assert.deepEqual(report.buildBefore, report.expectedPin);
    fixtureDirectory = await mkdtemp(join(tmpdir(), 'secumon-C03-backup-synthetic-'));
    await chmod(fixtureDirectory, 0o700); fixtureIdentity = await lstat(fixtureDirectory);
    report.fixtureDirectory = fixtureDirectory;
    report.fixturesExecuted = 1;
    const outcome = await new Promise((resolve, reject) => {
      child = spawn(process.execPath, [scriptPath, '--worker', fixtureDirectory], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { TZ: 'UTC', LANG: 'C.UTF-8' } });
      report.workerPid = child.pid;
      let result;
      const timer = setTimeout(() => { report.timedOut = true; logLines.push('Parent deadline reached; SIGKILL requested.'); child.kill('SIGKILL'); }, report.timeoutMs);
      child.stdout.on('data', chunk => logLines.push('stdout: ' + chunk.toString('utf8')));
      child.stderr.on('data', chunk => logLines.push('stderr: ' + chunk.toString('utf8')));
      child.on('message', message => {
        if (message?.type === 'result') result = message.result;
        else if (message?.type === 'stage') logLines.push(JSON.stringify(message));
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => {
        clearTimeout(timer); report.cleanup.workerExitObserved = true; report.workerExit = { code, signal };
        resolve({ code, signal, result });
      });
    });
    report.worker = outcome.result ?? null;
    assert.equal(report.timedOut ?? false, false, 'worker exceeded the one-shot deadline');
    assert.equal(outcome.code, 0, 'worker did not exit successfully; inspect worker.error and log');
    assert.equal(outcome.result?.status, 'passed');
    assert.equal(outcome.result.connectionsOpened, outcome.result.connectionsClosed);
    report.buildAfter = await verifyEvaluationBuild(runtimeRoot);
    assert.deepEqual(report.buildAfter, report.buildBefore);
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.error = errorInfo(error); logLines.push(JSON.stringify({ error: report.error })); }
  finally {
    if (child && !report.cleanup.workerExitObserved && child.pid) {
      child.kill('SIGKILL');
      await new Promise(resolve => child.once('close', () => { report.cleanup.workerExitObserved = true; resolve(); }));
    }
    if (fixtureDirectory) {
      try {
        const current = await lstat(fixtureDirectory);
        assert.ok(current.isDirectory() && current.dev === fixtureIdentity.dev && current.ino === fixtureIdentity.ino, 'refuse cleanup of replaced fixture root');
        await rm(fixtureDirectory, { recursive: true, force: false, maxRetries: 0 });
        try { await lstat(fixtureDirectory); throw new Error('fixture root remains after cleanup'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        report.cleanup.fixtureDirectoryRemoved = true;
      } catch (error) { report.cleanup.errors.push(errorInfo(error)); report.status = 'failed'; }
    }
    report.completedAt = new Date().toISOString(); report.elapsedMs = performance.now() - started;
    logLines.push(JSON.stringify({ status: report.status, workerExit: report.workerExit, cleanup: report.cleanup, elapsedMs: report.elapsedMs }));
    const logText = logLines.join('\n') + '\n'; report.logSha256 = hash(logText);
    await log.writeFile(logText); await log.sync(); await log.close();
    await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.sync(); await output.close();
  }
  process.stdout.write(JSON.stringify({ status: report.status, outputPath, logPath, cleanup: report.cleanup }) + '\n');
  process.exitCode = report.status === 'passed' ? 0 : 1;
}

if (process.argv[2] === '--worker' && process.argv.length === 4 && process.send) await worker(process.argv[3]);
else await parent();
