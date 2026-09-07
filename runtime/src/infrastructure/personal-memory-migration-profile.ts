import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { AgentProfileStatus } from '../application/agent-profile-contracts.js';
import { AgentProfileError } from '../application/agent-profile-contracts.js';
import { PersonalMemoryMigrationOptionsSchema, PersonalMemorySnapshotSchema, PersonalMemoryImportReceiptSchema,
  PersonalMemoryFenceSchema } from '../application/personal-memory-migration-contracts.js';
import { readProfileBytes, readProfileJson, profileStat, openProfileMutationScope, checkProfileMutationScope, syncProfileDirectory } from './agent-profile-files.js';
import { documentDigest } from './document-knowledge-codec.js';
import { sha256 } from './digest.js';
import { readSqlitePersonalMemoryFence } from './sqlite-personal-memory-migration.js';
import { inspectDocumentKnowledgeImport } from './document-knowledge-import.js';
import { FileMutationFault } from './host-file-mutations.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const migrationProfileFiles = ['config.json', '.secumon/identity.json', '.secumon/setup.json',
  '.secumon/setup-operation.json', '.secumon/personal-memory-profile.json'] as const;
export const MigrationInitialFilesSchema = z.array(z.strictObject({ path: z.enum(migrationProfileFiles), digest: hash,
  bytes: z.number().int().nonnegative().max(512 * 1024) })).length(migrationProfileFiles.length);
export const MigrationOperationSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('sqlite-to-documents'),
  options: PersonalMemoryMigrationOptionsSchema, agentId: z.uuid(), snapshot: PersonalMemorySnapshotSchema,
  initialFiles: MigrationInitialFilesSchema, offlineConfirmed: z.literal(true), effectsReconciled: z.literal(true) });
export type MigrationOperation = z.infer<typeof MigrationOperationSchema>;
export const MigrationActivationSchema = z.strictObject({ schemaVersion: z.literal(1), operationId: z.uuid(),
  agentId: z.uuid(), operationDigest: hash, fence: PersonalMemoryFenceSchema,
  imported: PersonalMemoryImportReceiptSchema, backupDigest: hash });
export type MigrationActivation = z.infer<typeof MigrationActivationSchema>;
export const migrationOperationPath = (root: string) => join(root, '.secumon', 'personal-memory-migration.json');
export const migrationActivationPath = (root: string) => join(root, '.secumon', 'personal-memory-activation.json');
type BaseProfile = Omit<Extract<AgentProfileStatus, { status: 'ready' }>, 'effectivePersonalMemory' | 'personalMemoryMigration'>;
const fail = (code: string): never => { throw new AgentProfileError(code); };

export function migrationInitialFiles(root: string, agentId: string) {
  return migrationProfileFiles.map(path => {
    const bytes = readProfileBytes(join(root, path), 512 * 1024);
    if (!bytes) return fail('agent_migration_initial_profile_missing');
    if (path === '.secumon/personal-memory-profile.json') {
      const assignment = z.strictObject({ schemaVersion: z.literal(1), agentId: z.uuid(), backend: z.literal('sqlite') }).safeParse(JSON.parse(bytes.toString('utf8')));
      if (!assignment.success || assignment.data.agentId !== agentId) return fail('agent_migration_initial_assignment_invalid');
    }
    return { path, digest: sha256(bytes), bytes: bytes.length };
  });
}
export function readMigrationOperation(profile: BaseProfile): MigrationOperation | null {
  const operation = readProfileJson(migrationOperationPath(profile.root), MigrationOperationSchema, [1], 512 * 1024);
  if (!operation) return null;
  const options = operation.options;
  const activation = readProfileJson(migrationActivationPath(profile.root), MigrationActivationSchema);
  const moved = options.directory !== profile.root;
  const activationBound = activation && activation.operationId === options.operationId && activation.agentId === operation.agentId &&
    activation.operationDigest === documentDigest(operation);
  if (profile.config.schemaVersion !== 1 || operation.agentId !== profile.identity.agentId || operation.snapshot.agentId !== operation.agentId ||
    options.directory !== resolve(options.directory) || moved && !activationBound ||
    options.source !== join(options.directory, 'memory', 'memory.sqlite') || options.target !== join(options.directory, 'memory', 'documents') ||
    options.backupDirectory !== resolve(options.backupDirectory) || documentDigest(migrationInitialFiles(profile.root, profile.identity.agentId)) !== documentDigest(operation.initialFiles)) {
    return fail('agent_migration_profile_mismatch');
  }
  if (!profileStat(profile.paths.memory)) return fail('agent_migration_source_missing');
  return operation;
}
export function migrationExpectedFence(operation: MigrationOperation) {
  const { options, snapshot } = operation;
  return PersonalMemoryFenceSchema.parse({ schemaVersion: 1, operationId: options.operationId, agentId: operation.agentId,
    targetStoreId: options.targetStoreId, snapshotDigest: snapshot.snapshotDigest, ownerDigest: snapshot.ownerDigest, workDigest: snapshot.workDigest });
}
export function inspectMigrationSelection(profile: BaseProfile): Pick<Extract<AgentProfileStatus, { status: 'ready' }>, 'effectivePersonalMemory' | 'personalMemoryMigration'> {
  const pg = profile.config.storage.postgres;
  const initial = profile.config.schemaVersion === 2 ? profile.config.storage.personalMemory : pg?.purposes.includes('knowledge') ?
    { backend: 'postgres' as const, storeId: pg.storeId, registrationId: pg.registrationId } : { backend: 'sqlite' as const };
  const operation = readMigrationOperation(profile);
  const activation = readProfileJson(migrationActivationPath(profile.root), MigrationActivationSchema);
  if (!operation) {
    if (activation) return fail('agent_migration_operation_missing');
    return { effectivePersonalMemory: initial };
  }
  if (!activation) return { effectivePersonalMemory: initial, personalMemoryMigration: { operationId: operation.options.operationId, phase: 'pending' } };
  if (activation.operationId !== operation.options.operationId || activation.agentId !== operation.agentId ||
    activation.operationDigest !== documentDigest(operation) || documentDigest(activation.fence) !== documentDigest(migrationExpectedFence(operation)) ||
    activation.imported.operationId !== operation.options.operationId || activation.imported.agentId !== operation.agentId ||
    activation.imported.storeId !== operation.options.targetStoreId || activation.imported.snapshotDigest !== operation.snapshot.snapshotDigest) {
    return fail('agent_migration_activation_invalid');
  }
  const imported = inspectDocumentKnowledgeImport(join(dirname(profile.paths.memory), 'documents'),
    { root: profile.root, agentId: operation.agentId, storeId: operation.options.targetStoreId },
    { operationId: operation.options.operationId, manifestDigest: activation.imported.manifestDigest });
  if (imported !== 'complete') return fail('agent_migration_target_incomplete');
  // A readable activation can survive a failed publisher-side directory fsync. Reconcile before selecting it.
  const scope = openProfileMutationScope(profile.root, []);
  try {
    const current = readProfileJson(migrationActivationPath(profile.root), MigrationActivationSchema, [1], 65536, scope);
    if (documentDigest(current) !== documentDigest(activation)) return fail('agent_migration_activation_invalid');
    try { syncProfileDirectory(profile.paths.metadata, scope); checkProfileMutationScope(scope); }
    catch (error) {
      if (error instanceof FileMutationFault) throw error;
      throw new FileMutationFault('publish', 'migration_activation_barrier', { publication: 'published', created: false,
        fileSynced: false, directorySynced: false, cleanup: 'not_needed' }, [{ stage: 'migration_activation_barrier', error }]);
    }
  } finally { scope.close(); }
  return { effectivePersonalMemory: { backend: 'documents', storeId: operation.options.targetStoreId },
    personalMemoryMigration: { operationId: operation.options.operationId, phase: 'activated' } };
}

/** Executing stores may open SQLite; ordinary profile inspection and cloning remain metadata-only. */
export function assertMigrationExecutionSource(profile: BaseProfile) {
  const current = inspectMigrationSelection(profile);
  if (current.personalMemoryMigration?.phase === 'pending') return fail('agent_migration_resume_required');
  if (current.personalMemoryMigration?.phase === 'activated') {
    const operation = readMigrationOperation(profile);
    if (!operation || documentDigest(readSqlitePersonalMemoryFence(profile.paths.memory, profile.identity.agentId)) !== documentDigest(migrationExpectedFence(operation))) {
      return fail('agent_migration_fence_mismatch');
    }
  }
  if (current.effectivePersonalMemory.backend === 'sqlite' && profileStat(profile.paths.memory) &&
    readSqlitePersonalMemoryFence(profile.paths.memory, profile.identity.agentId)) return fail('agent_migration_operation_missing');
  return current;
}
