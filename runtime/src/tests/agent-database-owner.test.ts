import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AgentProfileError } from '../application/agent-profile-contracts.js';
import { bindAgentDatabase, inspectAgentDatabaseOwner } from '../infrastructure/agent-database-owner.js';

const execute = promisify(execFile);
const worker = fileURLToPath(new URL('./helpers/agent-database-owner-worker.js', import.meta.url));
const detachedSidecarOptions = { skip: process.platform === 'win32' ? 'POSIX lstat race; Windows uses its separate database guard' : false };
function fixture(owned: boolean | 'missing' = true) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'agent-database-owner-')));
  const path = join(directory, 'state.sqlite'); const agentId = randomUUID();
  if (owned === true) bindAgentDatabase(path, agentId, 'state');
  else if (owned === false) writeFileSync(path, '', { mode: 0o600 });
  return { directory, path, agentId, close: () => rmSync(directory, { recursive: true, force: true }) };
}
async function run(operation: string, f: ReturnType<typeof fixture>, kind = 'state') {
  const result = await execute(process.execPath, [worker, operation, f.path, f.agentId, kind], { timeout: 15000, maxBuffer: 1024 * 1024 });
  return JSON.parse(result.stdout);
}
function bytes(directory: string) {
  return readdirSync(directory).sort().map(name => ({ name, bytes: readFileSync(join(directory, name)) }));
}

test('owner inspection preserves another connection write reservation against an external process', { timeout: 30000 }, async () => {
  const f = fixture(); const db = new DatabaseSync(f.path);
  try {
    db.exec('PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE;');
    const before = await run('probe-lock', f); assert.equal(before.acquired, false); assert.equal(before.sqliteCode & 0xff, 5);
    assert.equal(inspectAgentDatabaseOwner(f.path, f.agentId, 'state'), 'owned');
    assert.equal(db.isTransaction, true);
    const after = await run('probe-lock', f); assert.equal(after.acquired, false); assert.equal(after.sqliteCode & 0xff, 5);
    db.exec('ROLLBACK;'); assert.equal((await run('probe-lock', f)).acquired, true);
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK;'); db.close(); f.close();
  }
});

test('actual termination leaves a hot rollback journal that ownership inspection refuses without changing original bytes', { timeout: 30000 }, async () => {
  const f = fixture(); const db = new DatabaseSync(f.path);
  try {
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE crash_fixture(id INTEGER PRIMARY KEY, payload TEXT NOT NULL); BEGIN;');
    const insert = db.prepare('INSERT INTO crash_fixture VALUES(?,?)');
    for (let id = 1; id <= 128; id++) insert.run(id, 'a'.repeat(8192));
    db.exec('COMMIT;');
  } finally { db.close(); }
  const committed = readFileSync(f.path);
  const child = fork(worker, ['hot-rollback', f.path, f.agentId], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8000); });
  const exited = once(child, 'exit'); const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  try {
    const [message] = await once(child, 'message', { signal: AbortSignal.timeout(12000) });
    assert.deepEqual(message, { type: 'uncommitted-write', changes: 128 }, stderr);
    assert.equal(child.kill('SIGKILL'), true); const [, signal] = await exited; assert.equal(signal, 'SIGKILL', stderr);
    const journal = readFileSync(f.path + '-journal');
    assert.ok(journal.length > 512); assert.equal(journal.subarray(0, 8).toString('hex'), 'd9d505f920a163d7');
    assert.notDeepEqual(readFileSync(f.path), committed, 'Cache spill must have written uncommitted pages before termination');
    const interrupted = bytes(f.directory);
    for (const agentId of [f.agentId, randomUUID()]) {
      assert.throws(() => inspectAgentDatabaseOwner(f.path, agentId, 'state'),
        error => error instanceof AgentProfileError && error.code === 'agent_storage_recovery_required');
      assert.deepEqual(bytes(f.directory), interrupted);
    }
    // This test owns the fixture and deliberately performs writable recovery only after the refusal checks.
    const recovered = new DatabaseSync(f.path);
    try {
      assert.equal(recovered.prepare('SELECT count(*) AS count FROM crash_fixture WHERE payload=?').get('a'.repeat(8192))?.['count'], 128);
      assert.equal(recovered.prepare('SELECT agent_id FROM agent_storage_owner').get()?.['agent_id'], f.agentId);
    } finally { recovered.close(); }
    assert.equal(inspectAgentDatabaseOwner(f.path, f.agentId, 'state'), 'owned');
  } finally {
    clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    f.close();
  }
});

test('owner inspection uses one snapshot when another process commits the first owner between schema reads', { timeout: 30000 }, async () => {
  const f = fixture(false); const db = new DatabaseSync(f.path);
  try { db.exec('PRAGMA journal_mode=WAL;'); } finally { db.close(); }
  try {
    assert.deepEqual(await run('snapshot', f), { before: 'empty', after: 'owned', writerCommitted: true });
    assert.equal(inspectAgentDatabaseOwner(f.path, f.agentId, 'state'), 'owned');
  } finally { f.close(); }
});

test('owner inspection accepts an owned database published after its first missing-main observation', async () => {
  for (const kind of ['state', 'memory', 'channel']) {
    const f = fixture('missing');
    try {
      const result = await run('presence-owned', f, kind);
      assert.equal(result.injections, 1); assert.equal(result.mainInitiallyMissing, true);
      assert.ok(result.before.some((entry: { name: string }) => entry.name === 'state.sqlite-wal'));
      assert.equal(result.failure, null, JSON.stringify(result)); assert.equal(result.result, 'owned');
      assert.deepEqual(result.after, result.before); assert.deepEqual(result.owner, { agent_id: f.agentId, kind });
    } finally { f.close(); }
  }
});

test('a foreign owner published after a missing-main observation is rejected without adoption', async () => {
  const f = fixture('missing');
  try {
    const result = await run('presence-foreign', f);
    assert.equal(result.injections, 1); assert.equal(result.mainInitiallyMissing, true);
    assert.equal(result.failure?.code, 'agent_storage_owner_mismatch'); assert.equal(result.result, null);
    assert.notEqual(result.owner.agent_id, f.agentId); assert.deepEqual(result.after, result.before);
  } finally { f.close(); }
});

test('unowned application data published after a missing-main observation is preserved and rejected', async () => {
  const f = fixture('missing');
  try {
    const result = await run('presence-unowned', f);
    assert.equal(result.injections, 1); assert.equal(result.mainInitiallyMissing, true);
    assert.equal(result.failure?.code, 'agent_storage_owner_missing'); assert.equal(result.result, null);
    assert.equal(result.owner, null); assert.equal(result.payload, 'preserve'); assert.deepEqual(result.after, result.before);
  } finally { f.close(); }
});

test('an orphan sidecar without a main database is rejected without creating or changing files', async () => {
  const f = fixture('missing');
  try {
    const result = await run('presence-orphan', f);
    assert.equal(result.failure?.code, 'agent_storage_owner_missing'); assert.equal(result.result, null);
    assert.equal(result.mainExistsAfter, false); assert.equal(result.injections, 0); assert.deepEqual(result.after, result.before);
  } finally { f.close(); }
});

test('owner inspection rejects removal of its observed main file without recreating it', async () => {
  const f = fixture();
  try {
    const result = await run('presence-removed', f);
    assert.equal(result.injections, 1); assert.equal(result.failure?.code, 'agent_storage_path_unsafe');
    assert.equal(result.result, null); assert.equal(result.mainExistsAfter, false); assert.deepEqual(result.after, result.before);
  } finally { f.close(); }
});

test('a detached private rollback journal is rechecked as absent before accepting the unchanged owner', detachedSidecarOptions, async () => {
  const f = fixture();
  try {
    const result = await run('sidecar-unlinked-absent', f);
    assert.deepEqual(result.observed, { regular: true, symbolicLink: false, links: 0, mode: 0o600, owned: true });
    assert.equal(result.zeroObservations, 1);
    assert.deepEqual(result.observations.slice(0, 2), [{ kind: 'detached', links: 0, mode: 0o600 }, { kind: 'missing' }]);
    assert.equal(result.failure, null, JSON.stringify(result)); assert.equal(result.result, 'owned');
    assert.equal(result.sidecarExistsAfter, false); assert.deepEqual(result.after, result.before);
    assert.deepEqual(result.originalAfter, result.originalBefore); assert.ok(result.originalBefore.bytes > 0);
  } finally { f.close(); }
});

test('a detached journal replaced by an unsafe file is rejected without modifying either original', detachedSidecarOptions, async () => {
  const f = fixture();
  try {
    const result = await run('sidecar-unlinked-unsafe', f);
    assert.equal(result.observed.links, 0); assert.equal(result.zeroObservations, 1);
    assert.deepEqual(result.observations, [{ kind: 'detached', links: 0, mode: 0o600 }, { kind: 'present', links: 1, mode: 0o644 }]);
    assert.equal(result.failure?.code, 'agent_storage_path_unsafe'); assert.equal(result.result, null);
    assert.equal(result.sidecarExistsAfter, true); assert.deepEqual(result.after, result.before);
    assert.deepEqual(result.originalAfter, result.originalBefore);
    assert.throws(() => inspectAgentDatabaseOwner(f.path, f.agentId, 'state'), /agent_storage_path_unsafe/);
  } finally { f.close(); }
});

test('persistent detached journal observations fail after bounded rechecks while preserving all originals', detachedSidecarOptions, async () => {
  const f = fixture();
  try {
    const result = await run('sidecar-unlinked-persistent', f);
    assert.equal(result.observed.links, 0); assert.ok(result.zeroObservations >= 1 && result.zeroObservations <= 4, JSON.stringify(result));
    assert.equal(result.observations.length, result.zeroObservations);
    assert.equal(result.failure?.code, 'agent_storage_path_unsafe'); assert.equal(result.result, null);
    assert.equal(result.sidecarExistsAfter, false); assert.deepEqual(result.after, result.before);
    assert.deepEqual(result.originalAfter, result.originalBefore);
    assert.equal(inspectAgentDatabaseOwner(f.path, f.agentId, 'state'), 'owned');
  } finally { f.close(); }
});
