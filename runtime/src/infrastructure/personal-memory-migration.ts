import { lstatSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { openHostSqliteDatabase } from './windows-sqlite.js';
import { windowsPathInfo, windowsProfileContains, windowsCanonicalPath } from './windows-profile-files.js';
import type { AgentProfileStore, AgentProfileStatus } from '../application/agent-profile-contracts.js';
import { PersonalMemoryMigrationError, PersonalMemoryMigrationOptionsSchema, PersonalMemorySnapshotSchema,
  type PersonalMemoryMigrationOptions, type PersonalMemorySnapshotReader } from '../application/personal-memory-migration-contracts.js';
import { preflightKnowledgeStore } from './sqlite-knowledge-owner.js';
import { agentDatabaseExists } from './agent-database-owner.js';
import { personalMemorySnapshotReader, fenceSqlitePersonalMemory, readSqlitePersonalMemoryFence } from './sqlite-personal-memory-migration.js';
import { previewDocumentKnowledgeImport, importDocumentKnowledgeSnapshot } from './document-knowledge-import.js';
import { createOrResumePersonalMemoryBackup } from './personal-memory-backup.js';
import { documentDigest } from './document-knowledge-codec.js';
import { openProfileMutationScope, checkProfileMutationScope, profileDirectory, profileStat, publishProfileBytes,
  publishProfileJson, readProfileBytes, readProfileJson, syncProfileDirectory } from './agent-profile-files.js';
import { MigrationOperationSchema, MigrationActivationSchema, migrationOperationPath, migrationActivationPath,
  migrationInitialFiles, migrationExpectedFence, readMigrationOperation, type MigrationOperation } from './personal-memory-migration-profile.js';
import { sha256 } from './digest.js';

type ReadyProfile = Extract<AgentProfileStatus, { status: 'ready' }>;
const fail = (code: string): never => { throw new PersonalMemoryMigrationError(code); };
function contains(parent: string, child: string) {
  if (process.platform === 'win32') return windowsProfileContains(parent, child);
  const part = relative(parent, child); return part === '' || !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`);
}
function sameLocation(left: string, right: string) {
  return process.platform === 'win32' ?
    join(windowsCanonicalPath(dirname(left)), basename(left)).toUpperCase() === join(windowsCanonicalPath(dirname(right)), basename(right)).toUpperCase() : left === right;
}
function exists(path: string) { return process.platform === 'win32' ? windowsPathInfo(path, true) !== null : profileStat(path) !== null; }
function ready(profiles: AgentProfileStore, directory: string) {
  const profile = profiles.inspect(directory); if (profile.status !== 'ready') return fail('agent_migration_profile_not_ready');
  return profile;
}
function inputs(profiles: AgentProfileStore, raw: PersonalMemoryMigrationOptions, forbiddenRoots: readonly string[]) {
  const parsed = PersonalMemoryMigrationOptionsSchema.safeParse(raw);
  if (!parsed.success) return fail('agent_migration_options_invalid');
  const profile = ready(profiles, parsed.data.directory);
  if (profile.config.storage.postgres?.purposes.includes('knowledge')) return fail('agent_migration_source_backend_invalid');
  const options = { ...parsed.data, directory: profile.root, source: resolve(parsed.data.source), target: resolve(parsed.data.target),
    backupDirectory: resolve(parsed.data.backupDirectory) };
  if (profile.config.schemaVersion !== 1) return fail('agent_migration_source_backend_invalid');
  if (!sameLocation(options.source, profile.paths.memory) || !sameLocation(options.target, join(dirname(profile.paths.memory), 'documents'))) return fail('agent_migration_path_mismatch');
  options.source = profile.paths.memory;
  options.target = join(dirname(profile.paths.memory), 'documents');
  if ([profile.root, ...forbiddenRoots.map(path => resolve(path))].some(path => contains(path, options.backupDirectory) || contains(options.backupDirectory, path))) {
    return fail('agent_migration_backup_overlap');
  }
  if (!agentDatabaseExists(options.source)) return fail('agent_migration_source_missing');
  // Check the supplied backup parent without creating it or accepting a symlink alias.
  const backupScope = openProfileMutationScope(options.backupDirectory, [profile.root, ...forbiddenRoots]);
  try { checkProfileMutationScope(backupScope); } finally { backupScope.close(); }
  return { profile, options };
}
function withSnapshot<T>(path: string, agentId: string, action: (reader: PersonalMemorySnapshotReader) => T): T {
  preflightKnowledgeStore(path, { mode: 'agent', agentId });
  const before = process.platform === 'win32' ? null : lstatSync(path);
  const db = openHostSqliteDatabase(path, { readOnly: true, timeout: 5000 });
  let primary: { error: unknown } | undefined;
  try {
    db.exec('BEGIN'); const reader = personalMemorySnapshotReader(db, agentId);
    const result = action(reader);
    if (before) {
      const after = lstatSync(path);
      if (!agentDatabaseExists(path) || after.dev !== before.dev || after.ino !== before.ino) return fail('agent_migration_source_changed');
    }
    db.exec('COMMIT'); return result;
  } catch (error) { primary = { error }; throw error; }
  finally { try { db.close(); } catch (close) {
    if (primary && process.platform === 'win32') throw new AggregateError([primary.error, close], 'personal_memory_snapshot_close_failed', { cause: primary.error });
    throw close;
  } }
}
function same(actual: unknown, expected: unknown, code: string) { if (documentDigest(actual) !== documentDigest(expected)) fail(code); }
function initialCopies(profile: ReadyProfile, operation: MigrationOperation, forbiddenRoots: readonly string[]) {
  const scope = openProfileMutationScope(profile.root, forbiddenRoots);
  try {
    const path = join(profile.paths.metadata, 'migration-source-profile'); profileDirectory(path, true, true, scope);
    for (const entry of operation.initialFiles) {
      const bytes = readProfileBytes(join(profile.root, entry.path), 512 * 1024, true, scope);
      if (!bytes || bytes.length !== entry.bytes || sha256(bytes) !== entry.digest) fail('agent_migration_profile_mismatch');
      const target = join(path, entry.path.replaceAll('/', '--'));
      publishProfileBytes(target, bytes!, false, scope);
      const saved = readProfileBytes(target, 512 * 1024, true, scope);
      if (!saved || sha256(saved) !== entry.digest) fail('agent_migration_profile_copy_invalid');
    }
    syncProfileDirectory(path, scope); syncProfileDirectory(profile.paths.metadata, scope); checkProfileMutationScope(scope);
  } finally { scope.close(); }
}
export function previewPersonalMemoryMigration(profiles: AgentProfileStore, raw: PersonalMemoryMigrationOptions, forbiddenRoots: readonly string[]) {
  const { profile, options } = inputs(profiles, raw, forbiddenRoots);
  if (readMigrationOperation(profile) || exists(options.target) || exists(options.backupDirectory) ||
    exists(join(profile.paths.metadata, 'document-memory-ready.json'))) return fail('agent_migration_preview_target_exists');
  const initialFiles = migrationInitialFiles(profile.root, profile.identity.agentId);
  return withSnapshot(options.source, profile.identity.agentId, reader => {
    const capacity = previewDocumentKnowledgeImport(reader, { operationId: options.operationId, agentId: profile.identity.agentId,
      storeId: options.targetStoreId, backupDigest: '0'.repeat(64) });
    const snapshot = PersonalMemorySnapshotSchema.parse(reader.snapshot);
    return { phase: 'preview' as const, options, snapshot, initialFiles,
      capacity: { namespaceCount: capacity.namespaceCount, recordCount: capacity.recordCount, receiptCount: capacity.receiptCount, bytes: capacity.bytes },
      prerequisites: { offlineRequired: true, effectsReconciliationRequired: true },
      preservation: { latestRecords: true, allStoredReceipts: true, historicalBodiesAvailable: false,
        workMemory: 'unchanged', conversation: 'unchanged', workState: 'unchanged' } };
  });
}
export function personalMemoryMigrationStatus(profiles: AgentProfileStore, directory: string, operationId?: string) {
  const profile = ready(profiles, directory); const operation = readMigrationOperation(profile);
  if (!operation) {
    if (operationId) return fail('agent_migration_operation_missing');
    return { phase: 'not_started' as const, effectivePersonalMemory: profile.effectivePersonalMemory };
  }
  if (operationId !== undefined && operation.options.operationId !== operationId) return fail('agent_migration_operation_conflict');
  const activation = readProfileJson(migrationActivationPath(profile.root), MigrationActivationSchema);
  const fence = readSqlitePersonalMemoryFence(profile.paths.memory, operation.agentId);
  if (fence && documentDigest(fence) !== documentDigest(migrationExpectedFence(operation)) || activation && !fence) return fail('agent_migration_fence_mismatch');
  return { phase: activation ? 'activated' as const : fence ? 'fenced' as const : 'preparing' as const,
    operationId: operation.options.operationId, options: operation.options, snapshot: operation.snapshot,
    locations: { source: profile.paths.memory, target: join(dirname(profile.paths.memory), 'documents'), backupDirectory: operation.options.backupDirectory },
    effectivePersonalMemory: profile.effectivePersonalMemory, activation };
}
export async function applyPersonalMemoryMigration(profiles: AgentProfileStore, raw: PersonalMemoryMigrationOptions,
  confirmation: { expectedSnapshotDigest: string; offlineConfirmed: boolean; effectsReconciled: boolean }, forbiddenRoots: readonly string[]) {
  if (!confirmation.offlineConfirmed || !confirmation.effectsReconciled) return fail('agent_migration_offline_confirmation_required');
  const { profile, options } = inputs(profiles, raw, forbiddenRoots);
  const existing = readMigrationOperation(profile);
  if (existing) {
    same(existing.options, options, 'agent_migration_operation_conflict');
    if (existing.snapshot.snapshotDigest !== confirmation.expectedSnapshotDigest) return fail('agent_migration_snapshot_changed');
  } else {
    const preview = previewPersonalMemoryMigration(profiles, options, forbiddenRoots);
    if (preview.snapshot.snapshotDigest !== confirmation.expectedSnapshotDigest) return fail('agent_migration_snapshot_changed');
    const operation = MigrationOperationSchema.parse({ schemaVersion: 1, kind: 'sqlite-to-documents', options,
      agentId: profile.identity.agentId, snapshot: preview.snapshot, initialFiles: preview.initialFiles, offlineConfirmed: true, effectsReconciled: true });
    const scope = openProfileMutationScope(profile.root, forbiddenRoots);
    try {
      publishProfileJson(migrationOperationPath(profile.root), operation, scope);
      same(readMigrationOperation(profile), operation, 'agent_migration_operation_conflict');
      syncProfileDirectory(profile.paths.metadata, scope); checkProfileMutationScope(scope);
    } finally { scope.close(); }
  }
  return resumePersonalMemoryMigration(profiles, profile.root, options.operationId, forbiddenRoots);
}
export async function resumePersonalMemoryMigration(profiles: AgentProfileStore, directory: string, operationId: string, forbiddenRoots: readonly string[]) {
  const profile = ready(profiles, directory); const operation = readMigrationOperation(profile);
  if (!operation) return fail('agent_migration_operation_missing');
  if (operation.options.operationId !== operationId) return fail('agent_migration_operation_conflict');
  if (profile.personalMemoryMigration?.phase === 'activated') return personalMemoryMigrationStatus(profiles, directory, operationId);
  initialCopies(profile, operation, forbiddenRoots);
  const { options, snapshot } = operation;
  const backup = await createOrResumePersonalMemoryBackup({ operationId, agentId: operation.agentId, sourcePath: options.source,
    operationDirectory: options.backupDirectory, forbiddenRoots: [...forbiddenRoots],
    expectedSnapshotDigest: snapshot.snapshotDigest, expectedOwnerDigest: snapshot.ownerDigest, expectedWorkDigest: snapshot.workDigest });
  same(backup.snapshot, snapshot, 'agent_migration_backup_snapshot_mismatch');
  const importing = { operationId, agentId: operation.agentId, storeId: options.targetStoreId, backupDigest: backup.sha256 };
  // Revalidate capacity and exact seed bytes before irreversibly retiring source personal writes.
  const planned = withSnapshot(backup.backupPath, operation.agentId, reader => {
    same(reader.snapshot, snapshot, 'agent_migration_backup_snapshot_mismatch');
    return previewDocumentKnowledgeImport(reader, importing);
  });
  const expectedFence = migrationExpectedFence(operation);
  const fence = fenceSqlitePersonalMemory(options.source, expectedFence);
  same(fence, expectedFence, 'agent_migration_fence_mismatch');
  const imported = withSnapshot(backup.backupPath, operation.agentId, reader => {
    same(reader.snapshot, snapshot, 'agent_migration_backup_snapshot_mismatch');
    return importDocumentKnowledgeSnapshot(options.target,
      { root: profile.root, agentId: operation.agentId, storeId: options.targetStoreId }, reader, { ...importing, expectedManifestDigest: planned.manifestDigest });
  });
  same(imported, planned, 'agent_migration_import_mismatch');
  const activation = MigrationActivationSchema.parse({ schemaVersion: 1, operationId, agentId: operation.agentId,
    operationDigest: documentDigest(operation), fence, imported, backupDigest: backup.sha256 });
  const scope = openProfileMutationScope(profile.root, forbiddenRoots);
  try {
    same(readMigrationOperation(profile), operation, 'agent_migration_operation_conflict');
    same(readSqlitePersonalMemoryFence(options.source, operation.agentId), expectedFence, 'agent_migration_fence_mismatch');
    publishProfileJson(migrationActivationPath(profile.root), activation, scope);
    same(readProfileJson(migrationActivationPath(profile.root), MigrationActivationSchema, [1], 65536, scope), activation, 'agent_migration_activation_invalid');
    syncProfileDirectory(profile.paths.metadata, scope); checkProfileMutationScope(scope);
  } finally { scope.close(); }
  return personalMemoryMigrationStatus(profiles, directory, operationId);
}
