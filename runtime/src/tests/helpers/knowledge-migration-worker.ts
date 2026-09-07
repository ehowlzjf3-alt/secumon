import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { SqliteKnowledgeRepository } from '../../infrastructure/sqlite-knowledge.js';

const [phase, path, agentId] = process.argv.slice(2);
if (!path || !agentId || !['copied', 'committed'].includes(phase ?? '') || !process.send) throw new Error('invalid_knowledge_migration_worker');
const originalPrepare = DatabaseSync.prototype.prepare; const originalExec = DatabaseSync.prototype.exec;
let migrationStarted = false; let stopped = false;
function checkpoint(db: DatabaseSync): never {
  stopped = true;
  const row = db.prepare('SELECT body FROM knowledge_records_v2').get();
  process.send!({ checkpoint: phase, transactionOpen: db.isTransaction,
    version: db.prepare('SELECT version FROM knowledge_schema').get()?.['version'],
    copiedRecords: db.prepare('SELECT count(*) AS n FROM knowledge_records_v2').get()?.['n'],
    bodyDigest: createHash('sha256').update(String(row?.['body'])).digest('hex') });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error('migration_worker_resumed_without_termination');
}
// Real SQLite executes all statements. Only the point after copying or committing is held for a parent-issued SIGKILL.
DatabaseSync.prototype.prepare = function (sql: string) {
  const statement = originalPrepare.call(this, sql); const db = this;
  if (sql.startsWith('INSERT INTO knowledge_records_v2(')) {
    const originalRun = statement.run;
    Reflect.set(statement, 'run', (...args: unknown[]) => {
      const result = Reflect.apply(originalRun, statement, args); migrationStarted = true;
      if (phase === 'copied' && !stopped) checkpoint(db);
      return result;
    });
  }
  return statement;
};
DatabaseSync.prototype.exec = function (sql: string) {
  const result = originalExec.call(this, sql);
  if (phase === 'committed' && migrationStarted && !stopped && sql === 'COMMIT;') checkpoint(this);
  return result;
};
new SqliteKnowledgeRepository(path, { mode: 'agent', agentId });
throw new Error('knowledge_migration_checkpoint_not_reached');
