import { z } from 'zod';
import { AgentPostgresSelectionSchema } from './agent-profile-contracts.js';
import { LifecycleEntrySchema } from './agent-lifecycle-contracts.js';
import { JsonSchema } from './contracts.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const AgentPostgresBackupSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('secumon-agent-postgres-backup'),
  operationId: z.uuid(), agentId: z.uuid(), originalRoot: z.string().min(1).max(4096),
  createdAt: z.number().int().nonnegative(), releaseDigest: digest.nullable(), selection: AgentPostgresSelectionSchema,
  entries: z.array(LifecycleEntrySchema).max(100000),
  // Its strict wire schema and logical digest are checked by the infrastructure transfer reader.
  transfer: JsonSchema,
  pages: z.array(z.strictObject({ id: z.string().regex(/^page-[0-9]{8}$/), file: z.string().regex(/^page-[0-9]{8}\.json$/),
    bytes: z.number().int().nonnegative().max(4 * 1024 ** 2), sha256: digest })).max(65536),
  digest,
});
export type AgentPostgresBackup = z.infer<typeof AgentPostgresBackupSchema>;
/** Supplied from the host's separately retained current restore policy, never from this archive. */
export const AgentPostgresRestoreFloorSchema = z.strictObject({ agentId: z.uuid(), backupDigest: digest });
export type AgentPostgresRestoreFloor = z.infer<typeof AgentPostgresRestoreFloorSchema>;
export const AgentPostgresRestoreMarkerSchema = z.strictObject({ schemaVersion: z.literal(1),
  kind: z.literal('secumon-postgres-restore'), operationId: z.uuid(), agentId: z.uuid(), backupDigest: digest,
  transferDigest: digest, originalRoot: z.string().min(1), selection: AgentPostgresSelectionSchema, restorationId: z.uuid().optional() });
