import { isAbsolute } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { SqliteRecoveryWorkerRequestSchema, type SqliteRecoveryWorkerRequest } from '../application/agent-sqlite-recovery-validation-contracts.js';
import { openHostSqliteDatabase } from './windows-sqlite.js';
import { agentDatabaseExists } from './agent-database-owner.js';
import { lifecycleExists } from './agent-lifecycle-files.js';
import { serializeBackupError } from './personal-memory-backup.js';
import { validateAgentSqliteRecoveryCandidate } from './agent-sqlite-recovery-validation.js';

/** The parent pins candidate identity for recover, and may pass the published main only for read-only verify. */
function run(request: SqliteRecoveryWorkerRequest) {
  const path = request.candidatePath;
  if (!isAbsolute(path)) throw new Error('agent_sqlite_recovery_candidate_invalid');
  // The parent checks the original journal trailer/super-journal restriction before copying or dispatching.
  if (!agentDatabaseExists(path) || lifecycleExists(path + '-wal') || lifecycleExists(path + '-shm')) throw new Error('agent_sqlite_recovery_candidate_invalid');
  if (request.mode === 'recover') {
    if (!lifecycleExists(path + '-journal')) throw new Error('agent_sqlite_recovery_journal_missing');
    let db: DatabaseSync | undefined, primary: unknown;
    try {
      db = openHostSqliteDatabase(path, { timeout: 5000 });
      db.exec('PRAGMA trusted_schema=OFF; BEGIN;');
      // Reading the main schema makes SQLite perform its ordinary rollback recovery. No DDL or owner binding.
      db.prepare('SELECT name FROM sqlite_master LIMIT 1').get();
      db.exec('COMMIT;');
    } catch (error) { primary = error; }
    try { db?.close(); } catch (error) { if (primary !== undefined) throw new AggregateError([primary, error], 'agent_sqlite_recovery_candidate_close_failed', { cause: primary }); throw error; }
    if (primary !== undefined) throw primary;
  }
  if (lifecycleExists(path + '-wal') || lifecycleExists(path + '-shm')) throw new Error('agent_sqlite_recovery_candidate_invalid');
  return validateAgentSqliteRecoveryCandidate(path, request.validation);
}
let completed = false;
process.once('disconnect', () => { if (!completed) process.exit(1); });
if (!process.connected) process.exit(1);
function reply(value: unknown, code: number) {
  if (!process.connected) process.exit(1);
  process.exitCode = code;
  process.send!(value, error => { if (error) process.exit(1); completed = true; process.disconnect(); });
}
process.once('message', (value: unknown) => {
  let request: SqliteRecoveryWorkerRequest | null = null;
  try { request = SqliteRecoveryWorkerRequestSchema.parse(value); reply({ request, result: run(request) }, 0); }
  catch (error) { reply({ request, error: serializeBackupError(error) }, 1); }
});
