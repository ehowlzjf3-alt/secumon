import { z } from 'zod';
import { AgentHostDirectoryIdentitySchema } from './agent-host-identity-contracts.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const path = z.string().min(1).max(4096);
export const AGENT_RESTORE_RECOVERY_PENDING = '.secumon-restore-recovery-pending.json';
export const AgentRestoreRecoveryApplyInputSchema = z.strictObject({
  recoveryDirectory: path, expectedDigest: digest, offline: z.boolean(),
});
export const AgentRestoreRecoveryApplyIntentSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('secumon-restore-recovery-application'),
  operationId: z.uuid(), agentId: z.uuid(), recoveryDirectory: path, recoveryDigest: digest,
  root: path, retiredDirectory: path, operationDirectory: path,
  originalIdentity: AgentHostDirectoryIdentitySchema, previousHeadDigest: digest, backupDigest: digest, digest,
});
export const AgentRestoreRecoveryApplyPendingSchema = z.strictObject({
  schemaVersion: z.literal(1), operationId: z.uuid(), recoveryDigest: digest, intentDigest: digest,
});
export const AgentRestoreRecoveryApplyCompleteSchema = z.strictObject({
  schemaVersion: z.literal(1), operationId: z.uuid(), agentId: z.uuid(), intentDigest: digest,
  restorationId: z.uuid(), identityHeadDigest: digest, rootIdentity: AgentHostDirectoryIdentitySchema, digest,
});
export const AgentRestoreRecoveryPartialSchema = z.strictObject({
  schemaVersion: z.literal(1), intentDigest: digest, restorationId: z.uuid(),
  rootIdentity: AgentHostDirectoryIdentitySchema, destination: path, digest,
});
export type AgentRestoreRecoveryApplyInput = z.infer<typeof AgentRestoreRecoveryApplyInputSchema>;
export type AgentRestoreRecoveryApplyIntent = z.infer<typeof AgentRestoreRecoveryApplyIntentSchema>;
export type AgentRestoreRecoveryApplyComplete = z.infer<typeof AgentRestoreRecoveryApplyCompleteSchema>;
export type AgentRestoreRecoveryApplyProgress = 'original_preserved' | 'restored' | 'identity_rebound';
