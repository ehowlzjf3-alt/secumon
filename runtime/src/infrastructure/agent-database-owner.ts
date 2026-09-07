import { constants, closeSync, fsyncSync, lstatSync, openSync, type Stats } from 'node:fs';
import { basename, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openHostSqliteDatabase, windowsDatabaseExists } from './windows-sqlite.js';
import { AgentProfileError } from '../application/agent-profile-contracts.js';
import { profileErrorCode, syncProfileDirectory } from './agent-profile-files.js';

export type AgentDatabaseKind = 'state' | 'memory' | 'channel';
const waitCell = new Int32Array(new SharedArrayBuffer(4));
function prepareWal(db: DatabaseSync) {
  const deadline = performance.now() + 5000;
  for (;;) {
    try { db.exec('PRAGMA journal_mode=WAL;'); return; }
    catch (error) {
      // A journal-mode transition can return BUSY without invoking SQLite's
      // busy handler when another initializer is holding a read lock.
      const code = (error as { errcode?: number })?.errcode;
      if (typeof code !== 'number' || (code & 0xff) !== 5 || performance.now() >= deadline) throw error;
      Atomics.wait(waitCell, 0, 0, 10);
    }
  }
}
function checkFile(path: string, detachedRetries = 0): Stats | null {
  try {
    const stat = lstatSync(path);
    // SQLite can unlink a sidecar between pathname lookup and stat completion.
    // Re-read its name; never adopt a detached object or relax the main-file check.
    if (detachedRetries > 0 && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 0 && (stat.mode & 0o077) === 0 &&
      (typeof process.getuid !== 'function' || stat.uid === process.getuid())) return checkFile(path, detachedRetries - 1);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 ||
      typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new AgentProfileError('agent_storage_path_unsafe', {
        cause: { file: basename(path), regular: stat.isFile(), symbolicLink: stat.isSymbolicLink(), links: stat.nlink,
          mode: stat.mode & 0o777, owned: typeof process.getuid !== 'function' || stat.uid === process.getuid() },
      });
    return stat;
  } catch (error) { if (profileErrorCode(error) !== 'ENOENT') throw error; return null; }
}
export function agentDatabaseExists(path: string): boolean {
  if (process.platform === 'win32') return windowsDatabaseExists(path);
  let main = checkFile(path);
  const sidecars = ['-wal', '-shm', '-journal'].map(suffix => checkFile(path + suffix, 3));
  // Another initializer may publish the main file before these sidecars are observed.
  if (!main) main = checkFile(path);
  if (!main && sidecars.some(Boolean)) throw new AgentProfileError('agent_storage_owner_missing');
  return main !== null;
}
function checkIdentity(path: string, expected: NonNullable<ReturnType<typeof checkFile>>) {
  const current = checkFile(path);
  if (!current || current.dev !== expected.dev || current.ino !== expected.ino) throw new AgentProfileError('agent_storage_path_unsafe', {
    cause: { file: basename(path), reason: current ? 'main_file_replaced' : 'main_file_missing' },
  });
  agentDatabaseExists(path);
}
function inspectOwner(db: DatabaseSync, agentId: string, kind: AgentDatabaseKind): 'empty' | 'owned' {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_storage_owner'").get();
  if (!table) {
    if (db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) throw new AgentProfileError('agent_storage_owner_missing');
    return 'empty';
  }
  const rows = db.prepare('SELECT singleton, schema_version, agent_id, kind FROM agent_storage_owner LIMIT 2').all(); const owner = rows[0];
  if (rows.length !== 1 || owner?.['singleton'] !== 1 || owner['schema_version'] !== 1 || owner['agent_id'] !== agentId || owner['kind'] !== kind) {
    throw new AgentProfileError('agent_storage_owner_mismatch');
  }
  return 'owned';
}
/** Does not mutate the database schema/owner. SQLite may create WAL coordination sidecars. */
export function inspectAgentDatabaseOwner(path: string, agentId: string, kind: AgentDatabaseKind): 'missing' | 'empty' | 'owned' {
  if (!agentDatabaseExists(path)) return 'missing';
  const identity = process.platform === 'win32' ? null : checkFile(path); if (process.platform !== 'win32' && !identity) throw new AgentProfileError('agent_storage_path_unsafe');
  let db: DatabaseSync | undefined;
  try {
    db = openHostSqliteDatabase(path, { readOnly: true });
    db.exec('PRAGMA busy_timeout=5000; BEGIN;');
    const result = inspectOwner(db, agentId, kind); db.exec('COMMIT'); if (identity) checkIdentity(path, identity); return result;
  } catch (error) {
    const sqliteCode = (error as { errcode?: number })?.errcode;
    if (typeof sqliteCode === 'number' && (sqliteCode & 0xff) === 8) throw new AgentProfileError('agent_storage_recovery_required');
    throw error;
  } finally { db?.close(); }
}
/** The immutable agent state profile must authorize initialization before calling this. */
export function bindAgentDatabase(path: string, agentId: string, kind: AgentDatabaseKind) {
  if (process.platform === 'win32') {
    agentDatabaseExists(path);
    const db = openHostSqliteDatabase(path);
    try {
      db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
      if (inspectOwner(db, agentId, kind) === 'empty') {
        db.exec('CREATE TABLE agent_storage_owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), schema_version INTEGER NOT NULL, agent_id TEXT NOT NULL, kind TEXT NOT NULL)');
        db.prepare('INSERT INTO agent_storage_owner VALUES(1,1,?,?)').run(agentId, kind);
      }
      db.exec('COMMIT'); prepareWal(db);
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    finally { db.close(); }
    return syncProfileDirectory(dirname(path));
  }
  agentDatabaseExists(path);
  try {
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch (error) { if (profileErrorCode(error) !== 'EEXIST') throw error; }
  // Never open/close a raw descriptor for an existing SQLite file: on POSIX
  // that could release locks held by other SQLite connections in this process.
  const identity = checkFile(path); if (!identity) throw new AgentProfileError('agent_storage_path_unsafe');
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
    if (inspectOwner(db, agentId, kind) === 'empty') {
      db.exec('CREATE TABLE agent_storage_owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), schema_version INTEGER NOT NULL, agent_id TEXT NOT NULL, kind TEXT NOT NULL)');
      db.prepare('INSERT INTO agent_storage_owner VALUES(1,1,?,?)').run(agentId, kind);
    }
    checkIdentity(path, identity); db.exec('COMMIT');
    // Finish the mode transition before reusable state/memory/channel adapters
    // open their normal connections. Ownership is already validated and committed.
    prepareWal(db); checkIdentity(path, identity);
  } catch (error) { try { db?.exec('ROLLBACK'); } catch {} throw error; }
  finally { db?.close(); }
  syncProfileDirectory(dirname(path));
}
