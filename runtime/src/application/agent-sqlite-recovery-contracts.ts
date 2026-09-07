import { z } from 'zod';
import { AgentIdentitySchema } from './agent-profile-contracts.js';
import { SqliteRecoveryValidationInputSchema, SqliteRecoveryValidationResultSchema } from './agent-sqlite-recovery-validation-contracts.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.number().int().nonnegative();
export const SQLITE_RECOVERY_PENDING = 'sqlite-recovery-pending.json';
export const SqliteRecoveryKindSchema = z.enum(['state', 'memory', 'channel']);
export type SqliteRecoveryKind = z.infer<typeof SqliteRecoveryKindSchema>;
export const SqliteRecoveryFilePinSchema = z.strictObject({
  identity: z.strictObject({ volume: z.string().min(1).max(256), object: z.string().min(1).max(256) }),
  bytes: z.number().int().nonnegative().max(1024 ** 3), sha256: digest,
});
export type SqliteRecoveryFilePin = z.infer<typeof SqliteRecoveryFilePinSchema>;
export const SqliteRecoveryIntentSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('secumon-sqlite-recovery-intent'), operationId: z.uuid(),
  identity: AgentIdentitySchema, root: z.string().min(1), rootIdentity: SqliteRecoveryFilePinSchema.shape.identity,
  parentIdentity: SqliteRecoveryFilePinSchema.shape.identity, databaseKind: SqliteRecoveryKindSchema,
  relativePath: z.enum(['.secumon/runtime.sqlite', 'memory/memory.sqlite', '.secumon/channel.sqlite']),
  bindingDigest: digest, source: z.strictObject({ main: SqliteRecoveryFilePinSchema, journal: SqliteRecoveryFilePinSchema }),
  validation: SqliteRecoveryValidationInputSchema, createdAt: time, digest,
});
export const SqliteRecoveryPreservedSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('secumon-sqlite-recovery-original'), operationId: z.uuid(),
  intentDigest: digest, directory: z.string().regex(/^original-000[1-4]$/),
  main: SqliteRecoveryFilePinSchema, journal: SqliteRecoveryFilePinSchema, createdAt: time, digest,
});
export const SqliteRecoveryPreparedSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('secumon-sqlite-recovery-prepared'), operationId: z.uuid(),
  intentDigest: digest, preservedDigest: digest, directory: z.string().regex(/^candidate-000[1-4]$/),
  candidate: SqliteRecoveryFilePinSchema, validation: SqliteRecoveryValidationResultSchema, createdAt: time, digest,
});
export const SqliteRecoveryPendingSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('secumon-sqlite-recovery-apply'),
  operationId: z.uuid(), agentId: z.uuid(), preparedDigest: digest,
});
export const SqliteRecoveryCompleteSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('secumon-sqlite-recovery-complete'),
  operationId: z.uuid(), agentId: z.uuid(), preparedDigest: digest, applied: SqliteRecoveryFilePinSchema,
  validation: SqliteRecoveryValidationResultSchema, completedAt: time, digest,
});
export type SqliteRecoveryIntent = z.infer<typeof SqliteRecoveryIntentSchema>;
export type SqliteRecoveryPrepared = z.infer<typeof SqliteRecoveryPreparedSchema>;
export type SqliteRecoveryPending = z.infer<typeof SqliteRecoveryPendingSchema>;
