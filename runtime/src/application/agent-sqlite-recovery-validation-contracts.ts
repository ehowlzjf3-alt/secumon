import { z } from 'zod';
import { PersonalMemoryFenceSchema } from './personal-memory-migration-contracts.js';

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const SqliteRecoveryValidationInputSchema = z.strictObject({
  agentId: z.uuid(), kind: z.enum(['state', 'memory', 'channel']),
  personalMemory: z.discriminatedUnion('backend', [
    z.strictObject({ backend: z.literal('sqlite') }),
    z.strictObject({ backend: z.literal('documents'), storeId: z.uuid(), migrationOperationId: z.uuid().optional(), expectedFence: PersonalMemoryFenceSchema.optional() }),
  ]).optional(),
}).superRefine((input, context) => {
  if ((input.kind === 'memory') !== (input.personalMemory !== undefined)) context.addIssue({ code: 'custom', message: 'memory selection required only for memory database' });
  const selection = input.personalMemory;
  if (selection?.backend === 'documents' && selection.expectedFence &&
    (selection.expectedFence.agentId !== input.agentId || selection.expectedFence.targetStoreId !== selection.storeId ||
      selection.migrationOperationId !== undefined && selection.expectedFence.operationId !== selection.migrationOperationId)) {
    context.addIssue({ code: 'custom', message: 'memory fence binding mismatch' });
  }
});
export type SqliteRecoveryValidationInput = z.infer<typeof SqliteRecoveryValidationInputSchema>;
export const SqliteRecoveryValidationResultSchema = z.strictObject({
  agentId: z.uuid(), kind: z.enum(['state', 'memory', 'channel']), schemaVersion: positive,
  pageSize: positive, pageCount: positive, sqliteVersion: z.string().min(1).max(128),
  schemaDigest: z.string().regex(/^[a-f0-9]{64}$/), personalMemoryFence: PersonalMemoryFenceSchema.nullable(),
}).superRefine((result, context) => {
  if (!(result.kind === 'channel' ? result.schemaVersion === 1 : [1, 2, 3].includes(result.schemaVersion)) ||
    result.personalMemoryFence !== null && (result.kind !== 'memory' || result.schemaVersion !== 3 || result.personalMemoryFence.agentId !== result.agentId) ||
    result.kind === 'memory' && result.schemaVersion === 3 && result.personalMemoryFence === null) {
    context.addIssue({ code: 'custom', message: 'recovery report binding mismatch' });
  }
});
export type SqliteRecoveryValidationResult = z.infer<typeof SqliteRecoveryValidationResultSchema>;
export const SqliteRecoveryWorkerRequestSchema = z.strictObject({
  mode: z.enum(['recover', 'verify']), candidatePath: z.string().min(1).max(4096), validation: SqliteRecoveryValidationInputSchema,
});
export type SqliteRecoveryWorkerRequest = z.infer<typeof SqliteRecoveryWorkerRequestSchema>;
export interface SqliteRecoveryWorkerError {
  name: string; message: string; code?: string | undefined; errcode?: number | undefined;
  cause?: SqliteRecoveryWorkerError | undefined; errors?: Array<{ stage: string; error: SqliteRecoveryWorkerError }> | undefined;
}
export const SqliteRecoveryWorkerErrorSchema: z.ZodType<SqliteRecoveryWorkerError> = z.lazy(() => z.strictObject({
  name: z.string().max(256), message: z.string().max(4096), code: z.string().max(256).optional(), errcode: z.number().finite().optional(),
  cause: SqliteRecoveryWorkerErrorSchema.optional(),
  errors: z.array(z.strictObject({ stage: z.string().max(256), error: SqliteRecoveryWorkerErrorSchema })).max(12).optional(),
}));
export const SqliteRecoveryWorkerReplySchema = z.union([
  z.strictObject({ request: SqliteRecoveryWorkerRequestSchema, result: SqliteRecoveryValidationResultSchema }),
  z.strictObject({ request: SqliteRecoveryWorkerRequestSchema.nullable(), error: SqliteRecoveryWorkerErrorSchema }),
]);
export type SqliteRecoveryWorkerReply = z.infer<typeof SqliteRecoveryWorkerReplySchema>;
