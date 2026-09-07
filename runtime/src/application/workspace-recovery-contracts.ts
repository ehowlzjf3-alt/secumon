import { z } from 'zod';
import { WorkspaceCheckpointSchema, WorkspaceFileSchema } from './workspace-contracts.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const WorkspaceRecoveryManifestSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('secumon-workspace-recovery'), operationId: z.uuid(), agentId: z.uuid(),
  workId: z.string().min(1).max(256), checkpointIds: z.array(z.string().min(1).max(256)).min(1).max(128),
  createdAt: z.number().int().nonnegative(),
  restored: z.array(z.strictObject({ checkpoint: WorkspaceCheckpointSchema, file: WorkspaceFileSchema, receiptDigest: digest })).min(1).max(128),
  digest,
});
export type WorkspaceRecoveryManifest = z.infer<typeof WorkspaceRecoveryManifestSchema>;
export const WorkspaceRecoveryRequestSchema = z.strictObject({
  operationId: z.uuid(), workId: z.string().min(1).max(256),
  checkpointIds: z.array(z.string().min(1).max(256)).min(1).max(128), destination: z.string().min(1).max(4096),
});
