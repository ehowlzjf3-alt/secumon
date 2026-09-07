import { join } from 'node:path';
import { z } from 'zod';
import { AgentPostgresSelectionSchema, AgentProfileError, type AgentProfileStatus } from '../application/agent-profile-contracts.js';
import { readProfileJson } from './agent-profile-files.js';
import { TransferManifestSchema, validateTransferManifest } from './postgres-transfer.js';
import { sha256 } from './digest.js';
import { LifecycleEntrySchema } from '../application/agent-lifecycle-contracts.js';

type Ready = Extract<AgentProfileStatus, { status: 'ready' }>;
const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const postgresMigrationDigest = (value: unknown) => sha256(JSON.stringify(value));
export const PostgresMigrationOperationSchema = z.strictObject({ schemaVersion: z.literal(1), operationId: z.uuid(), agentId: z.uuid(),
  sourceConfigDigest: hash, sourceSelectionDigest: hash, selection: AgentPostgresSelectionSchema,
  sources: z.array(z.strictObject({ purpose: z.enum(['state', 'knowledge', 'channel']), entries: z.array(LifecycleEntrySchema).max(100000) })).min(1).max(3),
  snapshot: TransferManifestSchema });
export type PostgresMigrationOperation = z.infer<typeof PostgresMigrationOperationSchema>;
export const PostgresMigrationActivationSchema = z.strictObject({ schemaVersion: z.literal(1), operationId: z.uuid(), agentId: z.uuid(),
  operationDigest: hash, snapshotDigest: hash });
export const postgresMigrationPath = (root: string) => join(root, '.secumon', 'postgres-migration.json');
export const postgresActivationPath = (root: string) => join(root, '.secumon', 'postgres-activation.json');
export function readAgentPostgresMigration(profile: Ready): PostgresMigrationOperation | null {
  const operation = readProfileJson(postgresMigrationPath(profile.root), PostgresMigrationOperationSchema, [1], 4 * 1024 * 1024);
  if (!operation) return null;
  validateTransferManifest(operation.snapshot);
  if (operation.agentId !== profile.identity.agentId || operation.snapshot.agentId !== operation.agentId ||
      operation.sourceConfigDigest !== postgresMigrationDigest(profile.config) || operation.snapshot.purposes.some(purpose => purpose === 'board' || !operation.selection.purposes.includes(purpose)))
    throw new AgentProfileError('agent_postgres_migration_profile_changed');
  return operation;
}
export function inspectPostgresMigration(profile: Ready): Pick<Ready, 'effectivePersonalMemory' | 'postgresMigration'> {
  const operation = readAgentPostgresMigration(profile);
  const activation = readProfileJson(postgresActivationPath(profile.root), PostgresMigrationActivationSchema, [1], 65536);
  if (!operation) {
    if (activation) throw new AgentProfileError('agent_postgres_migration_operation_missing');
    return { effectivePersonalMemory: profile.effectivePersonalMemory };
  }
  if (activation && (activation.agentId !== operation.agentId || activation.operationId !== operation.operationId ||
    activation.operationDigest !== postgresMigrationDigest(operation) || activation.snapshotDigest !== operation.snapshot.digest)) throw new AgentProfileError('agent_postgres_migration_activation_invalid');
  return { postgresMigration: { operationId: operation.operationId, phase: activation ? 'activated' : 'pending', selection: operation.selection, snapshotDigest: operation.snapshot.digest },
    effectivePersonalMemory: activation && operation.selection.purposes.includes('knowledge') && profile.effectivePersonalMemory.backend !== 'documents' ?
      { backend: 'postgres', storeId: operation.selection.storeId, registrationId: operation.selection.registrationId } : profile.effectivePersonalMemory };
}
export function effectiveAgentPostgresSelection(profile: Ready) {
  return profile.postgresMigration?.phase === 'activated' ? profile.postgresMigration.selection : profile.config.storage.postgres ?? null;
}
