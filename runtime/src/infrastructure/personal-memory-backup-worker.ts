import type { DatabaseSync } from 'node:sqlite';
import { basename, dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { PersonalMemorySnapshotSchema } from '../application/personal-memory-migration-contracts.js';
import { agentDatabaseExists } from './agent-database-owner.js';
import { hostFileMutations } from './host-file-mutations.js';
import { hostMetadataFiles, sameFileIdentity, completeMetadataPublication } from './host-metadata-files.js';
import { openHostSqliteDatabase, hostBackupSqliteDatabase } from './windows-sqlite.js';
import { inspectPersonalMemorySnapshot } from './sqlite-personal-memory-migration.js';
import { assertKnowledgeStoreOwner } from './sqlite-knowledge-owner.js';
import { assertBackupSnapshot, backupFileIdentity, backupFileSize, backupWorkerRequestSchema, hashAndSyncBackup,
  personalMemoryBackupLimits, PersonalMemoryBackupFault, serializeBackupError, type BackupWorkerRequest,
  type PersonalMemoryBackupFailure } from './personal-memory-backup.js';

function capacity(pages: number, size: number) {
  if (!Number.isSafeInteger(pages) || pages < 0 || !Number.isSafeInteger(size) || size <= 0 ||
    BigInt(pages) * BigInt(size) > BigInt(personalMemoryBackupLimits.bytes)) throw new Error('personal_memory_backup_capacity');
}
async function run(request: BackupWorkerRequest) {
  const errors: PersonalMemoryBackupFailure[] = [], started = performance.now();
  const root = resolve(request.operationDirectory), target = resolve(request.targetPath);
  if (target !== join(root, 'backup.sqlite') && !(basename(target) === 'candidate.sqlite' && dirname(dirname(target)) === root &&
    /^backup-attempt-[a-f0-9-]{36}$/.test(basename(dirname(target))))) throw new Error('personal_memory_backup_target_invalid');
  if (request.mode === 'create' && (target === join(root, 'backup.sqlite') || request.expected)) throw new Error('personal_memory_backup_target_invalid');
  if (request.mode === 'verify' && !request.expected) throw new Error('personal_memory_backup_expected_missing');
  const scope = hostFileMutations().openScope({ root, forbiddenRoots: [...request.forbiddenRoots, dirname(request.intent.sourcePath)] });
  let sourceScope: ReturnType<ReturnType<typeof hostFileMutations>['openScope']> | undefined;
  let source: DatabaseSync | undefined, normalized: DatabaseSync | undefined, inspection: DatabaseSync | undefined;
  let stage = 'open', result: unknown;
  const deadline = () => { if (performance.now() - started > personalMemoryBackupLimits.workerMs) throw new Error('personal_memory_backup_deadline'); };
  try {
    const directory = scope.directory(root, 'private'), targetDirectory = scope.directory(dirname(target), 'private');
    if (!directory || !targetDirectory || !sameFileIdentity(directory.identity, request.operationIdentity) ||
      !sameFileIdentity(targetDirectory.identity, request.targetDirectoryIdentity)) throw new Error('personal_memory_backup_directory_changed');
    const guard = () => { scope.check(); backupFileIdentity(target, request.targetIdentity); deadline(); };
    guard();
    sourceScope = hostFileMutations().openScope({ root: dirname(request.intent.sourcePath), forbiddenRoots: request.forbiddenRoots });
    const sourceDirectory = sourceScope.directory(dirname(request.intent.sourcePath), 'private');
    if (!sourceDirectory || !sameFileIdentity(sourceDirectory.identity, request.intent.sourceDirectoryIdentity)) throw new Error('personal_memory_backup_source_changed');
    backupFileIdentity(request.intent.sourcePath, request.intent.sourceIdentity);
    if (!agentDatabaseExists(request.intent.sourcePath)) throw new Error('personal_memory_backup_source_missing');
    source = openHostSqliteDatabase(request.intent.sourcePath, { readOnly: true, timeout: 5000 }); source.exec('BEGIN;');
    if (request.mode === 'create') {
      if (backupFileSize(target) !== 0) throw new Error('personal_memory_backup_candidate_not_empty');
      stage = 'source_snapshot';
      // The inspector's first real owner read fixes main; no SQLite or raw-source operations occur during await backup.
      const before = inspectPersonalMemorySnapshot(source, request.intent.agentId); assertBackupSnapshot(before, request.intent);
      capacity(before.pageCount, before.pageSize); sourceScope.check(); backupFileIdentity(request.intent.sourcePath, request.intent.sourceIdentity); guard();
      stage = 'backup';
      const pages = await hostBackupSqliteDatabase(source, target, { source: 'main', target: 'main', rate: personalMemoryBackupLimits.rate,
        progress: value => { capacity(value.totalPages, before.pageSize); deadline(); } });
      capacity(pages, before.pageSize); deadline();
      stage = 'source_close'; const closing = source; source = undefined; closing.close();
      sourceScope.check(); backupFileIdentity(request.intent.sourcePath, request.intent.sourceIdentity); guard();
      if (backupFileSize(target) > personalMemoryBackupLimits.bytes) throw new Error('personal_memory_backup_capacity');
      stage = 'normalize'; normalized = openHostSqliteDatabase(target, { timeout: 5000 });
      normalized.exec('PRAGMA journal_mode=DELETE;'); const closingNormalized = normalized; normalized = undefined; closingNormalized.close();
      guard();
    } else {
      // A later migration fence may advance schema to 3. Reuse checks ownership, not a new schema-2 source snapshot.
      stage = 'source_owner'; assertKnowledgeStoreOwner(source, { mode: 'agent', agentId: request.intent.agentId });
      const closing = source; source = undefined; closing.close();
      sourceScope.check(); backupFileIdentity(request.intent.sourcePath, request.intent.sourceIdentity);
    }
    stage = 'candidate_snapshot';
    if (!agentDatabaseExists(target)) throw new Error('personal_memory_backup_candidate_missing');
    inspection = openHostSqliteDatabase(target, { readOnly: true, timeout: 5000 }); inspection.exec('BEGIN;');
    const inspected = inspectPersonalMemorySnapshot(inspection, request.intent.agentId); assertBackupSnapshot(inspected, request.intent);
    capacity(inspected.pageCount, inspected.pageSize);
    const rows = inspection.prepare('PRAGMA integrity_check;').iterate(); let checks = 0;
    for (const row of rows) { if (++checks > 1 || row['integrity_check'] !== 'ok') throw new Error('personal_memory_backup_integrity'); deadline(); }
    if (checks !== 1) throw new Error('personal_memory_backup_integrity');
    stage = 'candidate_close'; const closingInspection = inspection; inspection = undefined; closingInspection.close();
    guard(); stage = 'hash_sync';
    const hashed = hashAndSyncBackup(target, request.targetIdentity, guard, started + personalMemoryBackupLimits.workerMs);
    completeMetadataPublication(hostMetadataFiles(), targetDirectory); guard();
    const { pageSize, pageCount, sqliteVersion, ...snapshot } = inspected;
    result = { snapshot: PersonalMemorySnapshotSchema.parse(snapshot), ...hashed, identity: request.targetIdentity,
      pageSize, pageCount, sqliteVersion, nodeVersion: process.version };
    if (request.expected && !isDeepStrictEqual(result, request.expected)) throw new Error('personal_memory_backup_verified_changed');
  } catch (error) {
    const sqliteCode = (error as { errcode?: number })?.errcode;
    errors.push({ stage, error: typeof sqliteCode === 'number' && (sqliteCode & 0xff) === 8 ?
      Object.assign(new Error('agent_storage_recovery_required', { cause: error }), { code: 'agent_storage_recovery_required' }) : error });
  }
  // backup() has settled before this cleanup. A parent deadline terminates the isolated process instead.
  for (const [name, db] of [['inspection', inspection], ['normalized', normalized], ['source', source]] as const) {
    try { db?.close(); } catch (error) { errors.push({ stage: `${name}_close`, error }); }
  }
  try { sourceScope?.close(); } catch (error) { errors.push({ stage: 'source_scope_close', error }); }
  try { scope.close(); } catch (error) { errors.push({ stage: 'scope_close', error }); }
  if (errors.length) throw new PersonalMemoryBackupFault(stage, 'not_published', errors);
  return result;
}
let completed = false;
// This process only writes its private candidate. Lost supervision terminates even a pending native backup job.
process.once('disconnect', () => { if (!completed) process.exit(1); });
if (!process.connected) process.exit(1);
function reply(value: unknown, code: number) {
  if (!process.connected) process.exit(1);
  process.exitCode = code;
  process.send!(value, error => { if (error) process.exit(1); completed = true; process.disconnect(); });
}
process.once('message', (value: unknown) => {
  void (async () => {
    try { reply({ result: await run(backupWorkerRequestSchema.parse(value)) }, 0); }
    catch (error) { reply({ error: serializeBackupError(error) }, 1); }
  })();
});
