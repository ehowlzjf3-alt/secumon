import { z } from 'zod';
import { LifecycleEntrySchema } from './agent-lifecycle-contracts.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const path = z.string().min(1).max(4096);
const entries = z.array(LifecycleEntrySchema).max(100000);
export const AGENT_RESTORE_RECOVERY_MANIFEST = 'recovery.json';
export const AgentRestoreRecoveryInputSchema = z.strictObject({
  directory: path, backupDirectory: path, destination: path,
  expectedBackupDigest: digest, expectedHeadDigest: digest, operationId: z.uuid(), offline: z.boolean(),
});
export const AgentRestoreRecoveryManifestSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('secumon-agent-restore-recovery'),
  operationId: z.uuid(), agentId: z.uuid(), targetRoot: path, createdAt: z.number().int().nonnegative(),
  prior: z.strictObject({
    identityHeadDigest: digest, completionDigest: digest, restorationId: z.uuid().nullable(), entries, digest,
  }),
  selectedBackup: z.strictObject({ digest, originalRoot: path, entries, treeDigest: digest }),
  comparison: z.strictObject({
    added: z.array(path).max(100000), removed: z.array(path).max(100000), changed: z.array(path).max(100000),
    unchanged: z.number().int().nonnegative().max(100000),
  }),
  activation: z.literal('not_applied'), digest,
});
export type AgentRestoreRecoveryInput = z.infer<typeof AgentRestoreRecoveryInputSchema>;
export type AgentRestoreRecoveryManifest = z.infer<typeof AgentRestoreRecoveryManifestSchema>;
export interface AgentRestoreRecoveryInspection { directory: string; manifest: AgentRestoreRecoveryManifest }
