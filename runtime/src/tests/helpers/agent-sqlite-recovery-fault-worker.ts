import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { FileAgentProfileStore } from '../../infrastructure/file-agent-profile.js';
import { prepareAgentSqliteRecovery } from '../../infrastructure/agent-sqlite-recovery.js';
import { SqliteRecoveryWorkerFault } from '../../infrastructure/agent-sqlite-recovery-process.js';
import { serializeBackupError } from '../../infrastructure/personal-memory-backup.js';

const [mode, engine, directory, registry, operationId] = process.argv.slice(2);
assert.ok(process.platform !== 'win32');
const productWorker = new URL('../../infrastructure/agent-sqlite-recovery-worker.js', import.meta.url);

if (mode === 'candidate-close' || mode === 'validation-close') {
  assert.ok(process.connected, 'the real supervisor must supply the candidate request over IPC');
  const prepare = DatabaseSync.prototype.prepare, close = DatabaseSync.prototype.close;
  const armed = new WeakSet<DatabaseSync>();
  DatabaseSync.prototype.prepare = function (sql: string) {
    if (sql === (mode === 'candidate-close' ? 'SELECT name FROM sqlite_master LIMIT 1' : 'PRAGMA user_version')) armed.add(this);
    return prepare.call(this, sql);
  };
  DatabaseSync.prototype.close = function () {
    const inject = armed.delete(this);
    close.call(this);
    if (inject) {
      // Release the real SQLite connection first. This is an injected close-reporting fault, not an OS close failure.
      assert.equal(this.isOpen, false);
      throw Object.assign(new Error(`fixture_${mode}_after_release`), { code: 'TEST_SQLITE_CLOSE_AFTER_RELEASE' });
    }
  };
  await import(productWorker.href);
} else {
  assert.equal(mode, 'unobserved-management');
  assert.ok(engine && directory && registry && operationId);
  const primary = Object.assign(new Error('fixture_worker_observation_fault'), { code: 'TEST_WORKER_OBSERVATION' });
  // No validator process is spawned in this mode. Only the manager is a real process; missing exit/close events are injected.
  class UnobservedChild extends EventEmitter {
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    connected = true;
    kills = 0;
    send(_value: unknown, callback: (error: Error | null) => void) {
      callback(null); queueMicrotask(() => this.emit('error', primary)); return true;
    }
    kill() { this.kills++; return true; }
    disconnect() { this.connected = false; }
    unref() { return this; }
  }
  const child = new UnobservedChild(), originalFork = childProcess.fork;
  let calls = 0, observed: SqliteRecoveryWorkerFault | undefined;
  Reflect.set(childProcess, 'fork', (path: unknown) => {
    assert.equal(String(path), productWorker.href); assert.equal(++calls, 1); return child;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(prepareAgentSqliteRecovery(new FileAgentProfileStore(engine), directory,
      { operationId, kind: 'state', offline: true }, { identityRegistryDirectory: registry }), error => {
      assert.ok(error instanceof SqliteRecoveryWorkerFault); observed = error;
      assert.equal(error.cause, primary);
      assert.deepEqual(error.workerExit, { observed: false, code: null, signal: null, pid: null, closed: false });
      return true;
    });
    assert.ok(observed); assert.equal(calls, 1); assert.equal(child.kills, 2);
    process.stdout.write(JSON.stringify({ mode, managerPid: process.pid, simulatedChild: true,
      failure: serializeBackupError(observed), workerExit: observed.workerExit,
      failures: observed.failures.map(item => ({ stage: item.stage, error: serializeBackupError(item.error) })) }) + '\n');
  } finally {
    Reflect.set(childProcess, 'fork', originalFork); syncBuiltinESMExports();
    child.stdout.destroy(); child.stderr.destroy();
  }
}
