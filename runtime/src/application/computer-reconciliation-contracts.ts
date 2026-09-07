import { z } from 'zod';
import { ArtifactSchema } from './contracts.js';
import { ComputerDriverIdentitySchema, ComputerLeaseSchema } from './computer-use-contracts.js';
import { ComputerOperationIdentitySchema, ComputerOperationLookupResultSchema } from './computer-operation-contracts.js';

const id = z.string().min(1).max(256);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const ReconciliationActorSchema = z.strictObject({ tenantId: id, principalId: id,
  allowedLabels: z.array(id).max(10000).optional(), allowedTools: z.array(id).max(10000).optional(),
  allowedDestinations: z.array(id).max(10000).optional(), allowWrites: z.boolean().optional() });
export const ComputerReconciliationInputSchema = z.strictObject({ attemptId: id, checkpointId: id });
export const ComputerReconciliationIntentSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('computer_reconciliation_intent'),
  workId: id, reconciliationId: id, actor: ReconciliationActorSchema, sourceAttemptId: id, sourceHead: ArtifactSchema,
  sourceResultArtifact: ArtifactSchema.nullable(), identity: ComputerOperationIdentitySchema, stepIndex: count.max(2),
  driver: ComputerDriverIdentitySchema, contractDigest: digest, goalRevision: count.min(1), policyDigest: digest, generation: count,
  originalDeadlineAt: count, readDeadlineAt: count, createdAt: count });
export const ComputerReconciliationResponseSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('computer_reconciliation_response'),
  workId: id, reconciliationId: id, request: ArtifactSchema, lease: ComputerLeaseSchema, respondedAt: count,
  result: ComputerOperationLookupResultSchema });
export const ComputerReconciliationProofSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('computer_reconciliation_proof'),
  workId: id, reconciliationId: id, sourceAttemptId: id, sourceHead: ArtifactSchema, request: ArtifactSchema, response: ArtifactSchema,
  operationId: id, stepIndex: count.max(2), outcome: z.enum(['applied', 'not_applied']), effectState: z.enum(['none', 'confirmed']),
  confirmedAt: count });
export type ComputerReconciliationIntent = z.infer<typeof ComputerReconciliationIntentSchema>;
export type ComputerReconciliationResponse = z.infer<typeof ComputerReconciliationResponseSchema>;
