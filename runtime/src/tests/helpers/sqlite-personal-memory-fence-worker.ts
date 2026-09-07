import { DatabaseSync } from 'node:sqlite';
import { fenceSqlitePersonalMemory } from '../../infrastructure/sqlite-personal-memory-migration.js';
import { PersonalMemoryFenceSchema } from '../../application/personal-memory-migration-contracts.js';

const [phase, path, input] = process.argv.slice(2);
if (!path || !input || (phase !== 'before-commit' && phase !== 'after-commit')) throw new Error('invalid_fence_worker_arguments');
const expected = PersonalMemoryFenceSchema.parse(JSON.parse(input));
const original = DatabaseSync.prototype.exec; let installing = false;
function checkpoint(db: DatabaseSync): never {
  if (!process.send) throw new Error('fence_worker_ipc_required');
  process.send({ checkpoint: phase, transactionOpen: db.isTransaction,
    version: db.prepare('SELECT version FROM knowledge_schema').get()?.['version'] });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error('fence_worker_resumed_without_termination');
}
DatabaseSync.prototype.exec = function (sql: string) {
  if (sql.startsWith('CREATE TABLE knowledge_personal_migration(')) installing = true;
  if (installing && sql === 'COMMIT') {
    if (phase === 'before-commit') checkpoint(this);
    original.call(this, sql); checkpoint(this);
  }
  return original.call(this, sql);
};
try { fenceSqlitePersonalMemory(path, expected); throw new Error('fence_checkpoint_not_reached'); }
finally { DatabaseSync.prototype.exec = original; }
