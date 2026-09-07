import { ExternalSubscriptionsSchema } from './external-event-contracts.js';
import { z } from 'zod';
import type { ResumePacket } from '../domain/recovery.js';
import { ArtifactSchema, AttemptSchema, BudgetSchema, ComputerContinuationsSchema, ComputerReconciliationsSchema, ContextPacketSchema, ConversationStateSchema, DataLifecycleSchema, EvidenceSchema, ModelCallSchema, ProgressSummarySchema, WorkspaceCheckpointSchema } from './contracts.js';
import { ExecutionControlSchema } from './execution-policy-contracts.js';
import { DeliverySchema } from './store-contract.js';
import { BudgetSummarySchema } from './budget-delegation-contracts.js';

const id = z.string().min(1).max(256);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const ResumePacketSchema: z.ZodType<ResumePacket> = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('runtime_resume'), builderRevision: z.literal('1'), workId: id, stateRevision: count.min(1), eventCursor: count.min(1), stateDigest: hash, toolDigest: hash,
  context: ContextPacketSchema,
  runtime: z.strictObject({ subscriptions: ExternalSubscriptionsSchema.optional(), status: z.enum(['ready', 'running', 'waiting', 'blocked', 'paused', 'cancelled', 'failed', 'completed']), statusReason: z.string().max(100000),
    executionControl: ExecutionControlSchema.optional(), progress: ProgressSummarySchema.optional(), retryWakeAt: count.nullable().optional(),
    delegation: BudgetSummarySchema.optional(), computerReconciliations: ComputerReconciliationsSchema.optional(),
    computerContinuations: ComputerContinuationsSchema.optional(),
    budget: BudgetSchema, deadlineAt: count, attempts: z.array(AttemptSchema), modelCalls: z.array(ModelCallSchema.extend({ inputArtifact: ArtifactSchema.nullable() })),
    hypothesisAssessment: z.strictObject({ goalRevision: count.min(1), evidenceIds: z.array(id) }).nullable(), artifacts: z.array(ArtifactSchema), conversation: ConversationStateSchema.nullable(),
    dataLifecycle: DataLifecycleSchema.optional(), workspaceCheckpoints: z.array(WorkspaceCheckpointSchema).optional() }),
  evidenceIndex: z.array(z.custom<ResumePacket['evidenceIndex'][number]>((value: unknown) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || 'facts' in value) return false;
    return EvidenceSchema.safeParse({ ...value, facts: {} }).success;
  })),
  deliveries: z.array(z.custom<ResumePacket['deliveries'][number]>((value: unknown) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || 'text' in value) return false;
    return DeliverySchema.safeParse({ ...value, text: '' }).success;
  })),
});
