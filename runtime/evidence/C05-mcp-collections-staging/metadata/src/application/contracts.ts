import { z } from 'zod';
import { ExternalSubscriptionsSchema, ExternalNotificationsSchema } from './external-event-contracts.js';
import type { ArtifactRef, ContextPacket, Evidence, Goal, Json, PlanProposal, Policy, ToolResult, WorkState } from '../domain/model.js';
import type { ContextObservation } from '../domain/context.js';
import type { ComputerReconciliation } from '../domain/computer-reconciliation.js';
import type { ComputerContinuationClaim, ComputerResume } from '../domain/computer-continuation.js';
import { KnowledgeDependencySchema } from './knowledge-contracts.js';
import { ExecutionControlSchema } from './execution-policy-contracts.js';
import { WorkProgressSchema } from './work-progress-contracts.js';
import { BudgetParentSchema, BudgetGrantsSchema, BudgetSummarySchema } from './budget-delegation-contracts.js';
import { DisclosurePolicySchema, DisclosureRecordSchema } from './disclosure-contracts.js';
import { AppliedSessionInputSchema, SessionContextSchema, SessionScopeSchema } from './session-contracts.js';
import { PersonalMemoryContextSchema, PersonalMemorySelectionSchema } from './personal-memory-contracts.js';
import { AnswerAssessmentSchema, ResponseRequirementSchema } from './agent-turn-base-contracts.js';
import type { GeneratedAnswer } from '../domain/agent-turn.js';

const id = z.string().min(1).max(256);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const revision = count.min(1);
const text = z.string().max(100_000);
const ids = z.array(id).max(10_000);
const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export const JsonSchema: z.ZodType<Json> = z.lazy(() => z.union([scalar, z.array(JsonSchema), z.record(z.string(), JsonSchema)]));
export const CriterionSchema = z.strictObject({ id, description: text, key: id, operator: z.enum(['equals', 'present']), equals: scalar, minIndependentSources: count.min(1), requireCompleteCoverage: z.boolean(),
  requireCollection: z.strictObject({ queryDigest: z.string().regex(/^[a-f0-9]{64}$/), snapshot: id.optional() }).optional() });
export const GoalSchema: z.ZodType<Goal> = z.strictObject({ revision, description: text.min(1), scope: id, mode: z.enum(['auto', 'fast', 'deep']),
  criteria: z.array(CriterionSchema).max(100), responseRequirement: ResponseRequirementSchema.optional() })
  .refine(goal => goal.criteria.length > 0 || goal.responseRequirement !== undefined, 'completion_requirement_required');
export const PolicySchema: z.ZodType<Policy> = z.strictObject({ tenantId: id, principalId: id, allowedTools: ids, allowedLabels: ids, allowedDestinations: ids, allowWrites: z.boolean(), disclosure: DisclosurePolicySchema.optional() });
export const ArtifactSchema: z.ZodType<ArtifactRef> = z.strictObject({ id, sha256: z.string().regex(/^[0-9a-f]{64}$/), byteLength: count, mediaType: id, tenantId: id, labels: ids });
export const GeneratedAnswerSchema: z.ZodType<GeneratedAnswer> = z.strictObject({ id, callId: id, goalRevision: revision, planRevision: count,
  dataGeneration: count, input: AppliedSessionInputSchema, inputArtifact: ArtifactSchema,
  promptDigest: z.string().regex(/^[a-f0-9]{64}$/), basisDigest: z.string().regex(/^[a-f0-9]{64}$/), artifact: ArtifactSchema,
  evidenceIds: ids, observedEvidenceIds: ids, assessment: AnswerAssessmentSchema, createdAt: count });
export const ReadResumeSchema = z.strictObject({ attemptId: id, checkpointId: id });
export const ComputerResumeSchema: z.ZodType<ComputerResume> = z.strictObject({ attemptId: id, checkpointId: id,
  reconciliation: z.strictObject({ id, proofId: id }).nullable() });
export const ComputerContinuationClaimSchema: z.ZodType<ComputerContinuationClaim> = z.strictObject({
  sourceAttemptId: id, sourceHead: ArtifactSchema, sourceResultArtifact: ArtifactSchema.nullable(), successorAttemptId: id,
  successorTaskDigest: z.string().regex(/^[0-9a-f]{64}$/), mode: z.enum(['continue', 'verify']),
  reconciliation: z.strictObject({ id, proofArtifact: ArtifactSchema }).nullable(), rootAttemptId: id,
  sourceContractDigest: z.string().regex(/^[0-9a-f]{64}$/), contractDigest: z.string().regex(/^[0-9a-f]{64}$/),
  goalRevision: revision, scope: id, policyDigest: z.string().regex(/^[0-9a-f]{64}$/), generation: count, createdAt: count, actionDeadlineAt: count,
  maxObservations: count.min(1).max(12), maxInputAttempts: count.min(1).max(6), maxSuccessors: count.min(1).max(8), depth: count.min(1).max(8),
  observationsUsed: count.max(12), inputAttemptsUsed: count.max(6), nextStep: count.max(3), totalSteps: count.min(1).max(3),
}).superRefine((claim, context) => {
  if (claim.sourceAttemptId === claim.successorAttemptId || claim.depth > claim.maxSuccessors || claim.observationsUsed > claim.maxObservations ||
      claim.inputAttemptsUsed > claim.maxInputAttempts || claim.nextStep > claim.totalSteps)
    context.addIssue({ code: 'custom', message: 'computer_continuation_bounds_invalid' });
  if (claim.mode === 'continue' ? claim.nextStep === claim.totalSteps || claim.createdAt >= claim.actionDeadlineAt : claim.nextStep !== claim.totalSteps)
    context.addIssue({ code: 'custom', message: 'computer_continuation_mode_invalid' });
});
export const ComputerContinuationsSchema = z.array(ComputerContinuationClaimSchema).max(1000).superRefine((claims, context) => {
  if (new Set(claims.map(claim => claim.sourceAttemptId)).size !== claims.length || new Set(claims.map(claim => claim.successorAttemptId)).size !== claims.length)
    context.addIssue({ code: 'custom', message: 'computer_continuation_duplicate' });
});
export const ReadCollectionProofSchema = z.strictObject({ operationId: id, checkpoint: ArtifactSchema });
export const ReadProgressSchema = z.strictObject({ operationId: id, head: ArtifactSchema, callCount: count.max(10000), remainingCalls: count.max(10000),
  completedPages: count.max(1000), completedItems: count.max(10000), pendingItems: count.max(1000), unknownCalls: count.max(10000),
  phase: z.enum(['running', 'partial', 'complete']), successorAttemptId: id.nullable(), retryAt: count.nullable().optional(),
  coverage: z.strictObject({ queryDigest: z.string().regex(/^[a-f0-9]{64}$/), snapshot: id.nullable(), expectedItems: count.max(10000),
    completedItems: count.max(10000), complete: z.boolean() }).optional(),
  queryDigest: z.string().regex(/^[0-9a-f]{64}$/).optional() }).superRefine((v, ctx) => {
    if (v.callCount + v.remainingCalls > 10000 || v.unknownCalls > v.callCount || v.completedItems + v.pendingItems > 10000 ||
      (v.phase === 'complete' && v.pendingItems !== 0)) ctx.addIssue({ code: 'custom', message: 'read_progress_counts_invalid' });
    if ((v.retryAt !== undefined) !== (v.queryDigest !== undefined) || v.phase === 'complete' && v.retryAt != null)
      ctx.addIssue({ code: 'custom', message: 'read_progress_retry_invalid' });
  });
export const ContextHeadSchema = z.strictObject({ artifact: ArtifactSchema, basisRevision: revision, cycle: revision });
export const ContextMetricsSchema = z.strictObject({ baselinePacketBytes: count, baselineToolBytes: count, packetBytes: count, toolBytes: count, envelopeBytes: count,
  requestBytes: count, estimatedTokens: count, estimateMethod: id, outputTokenReservation: count, sourceReads: count, extraModelCalls: z.literal(0), evictions: count, reloads: count });
export const ConversationBindingSchema = z.strictObject({ id, channel: z.enum(['cli', 'web', 'knox', 'test']), conversationId: id, recipientId: id, destination: id, tenantId: id, principalId: id, session: SessionScopeSchema.optional() });
export const PreparedResponseSchema = z.strictObject({ id, goalRevision: revision, sourceRevision: revision, evidenceIds: ids, evidenceDigest: id, artifact: ArtifactSchema, labels: ids,
  generatedAnswerDigest: z.string().regex(/^[a-f0-9]{64}$/).optional() });
export const ConversationStateSchema = z.strictObject({ bindings: z.array(ConversationBindingSchema).min(1).max(100), primaryBindingId: id,
  completionRequiresDelivery: z.boolean(), result: PreparedResponseSchema.nullable(), session: AppliedSessionInputSchema.optional(), sessionReviewRequired: z.boolean().optional() });
export const EvidenceSchema: z.ZodType<Evidence> = z.strictObject({
  id, tenantId: id, scope: id, sourceId: id, lineageId: id, locator: text.min(1), observedAt: count, recordedAt: count, labels: ids,
  coverage: z.enum(['complete', 'partial', 'unknown']), status: z.enum(['accepted', 'retracted']), supersedes: ids, derivedFrom: ids,
  access: z.enum(['available', 'restricted', 'deleted']).optional(),
  facts: z.record(z.string(), scalar), artifact: ArtifactSchema.nullable(),
});
export const HypothesisSchema = z.strictObject({ id, question: text, claim: text, predictedObservation: text, falsifier: text,
  status: z.enum(['open', 'supported', 'contested', 'refuted', 'inconclusive']), supportIds: ids, counterIds: ids, reason: text });
export const ObligationSchema = z.strictObject({ id, kind: z.enum(['response', 'evidence', 'effect_reconciliation', 'delivery', 'budget_reconciliation']), reason: text,
  status: z.enum(['pending', 'satisfied', 'waived']), wakeKey: id.nullable(), dueAt: count.nullable(), mode: z.enum(['actionable', 'waiting']).optional(),
  source: z.strictObject({ provider: id, resourceId: id, externalId: id, role: z.enum(['requester', 'assignee']), goalRevision: revision, attemptId: id }).optional(), resumeToolIds: ids.optional() });
export const TaskSchema = z.strictObject({ id, description: text, dependsOn: ids, toolId: id, toolVersion: id, input: z.record(z.string(), JsonSchema),
  effect: z.enum(['read', 'write']), freshness: z.enum(['fresh', 'allow_reuse']).optional(), readResume: ReadResumeSchema.optional(),
  computerResume: ComputerResumeSchema.optional(), maxAttempts: count.min(1).max(100), satisfies: ids })
  .refine(task => !(task.readResume && task.computerResume), 'computer_resume_conflict');
export const PlanSchema = z.strictObject({ revision, goalRevision: revision, reason: text, tasks: z.array(TaskSchema).max(1000) });
export const PlanProposalSchema: z.ZodType<PlanProposal> = z.strictObject({ baseStateRevision: revision, baseGoalRevision: revision, basePlanRevision: count,
  reason: text.min(1), tasks: z.array(TaskSchema).max(1000), hypotheses: z.array(HypothesisSchema) });
export const ToolUsageSchema = z.strictObject({ transportCalls: count.nullable(), internalOperations: count.nullable(), imageBytes: count.nullable(), waitMs: count.nullable() });
export const ToolReuseOriginSchema = z.strictObject({ attemptId: id, resultId: id, resultArtifact: ArtifactSchema, observedAt: count, cacheKey: z.string().regex(/^[0-9a-f]{64}$/) });
export const ToolExecutionSchema = z.strictObject({ mode: z.enum(['invoked', 'reused', 'not_invoked', 'unreported']),
  implementationCalls: z.union([z.literal(0), z.literal(1), z.null()]), usage: ToolUsageSchema }).superRefine((v, ctx) => {
  if (v.implementationCalls !== (v.mode === 'invoked' ? 1 : v.mode === 'unreported' ? null : 0)) ctx.addIssue({ code: 'custom', message: 'execution_count_mismatch' });
  if (['reused', 'not_invoked'].includes(v.mode) && Object.values(v.usage).some(n => n !== 0)) ctx.addIssue({ code: 'custom', message: 'uninvoked_usage_must_be_zero' });
});
export const ComputerReconciliationSchema: z.ZodType<ComputerReconciliation> = z.strictObject({
  id, sourceAttemptId: id, obligationId: id, sourceHead: ArtifactSchema, sourceResultArtifact: ArtifactSchema.nullable(),
  requestArtifact: ArtifactSchema, responseArtifact: ArtifactSchema.nullable(), proofArtifact: ArtifactSchema.nullable(),
  operationId: id, stepIndex: count.max(2), goalRevision: revision, policyDigest: z.string().regex(/^[0-9a-f]{64}$/),
  generation: count, contractDigest: z.string().regex(/^[0-9a-f]{64}$/), driver: z.strictObject({ id, version: id }),
  owner: id, leaseUntil: count, createdAt: count, dispatchedAt: count.nullable(), finishedAt: count.nullable(),
  status: z.enum(['reserved', 'running', 'received', 'settled', 'failed']), execution: ToolExecutionSchema,
  reason: id.nullable(), outcome: z.enum(['applied', 'not_applied', 'unknown']).nullable(), effectState: z.enum(['none', 'confirmed', 'unknown']),
}).superRefine((value, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (value.leaseUntil < value.createdAt || value.dispatchedAt !== null && (value.dispatchedAt < value.createdAt || value.dispatchedAt > value.leaseUntil) ||
      value.finishedAt !== null && (value.finishedAt < value.createdAt || value.dispatchedAt !== null && value.finishedAt < value.dispatchedAt)) fail('computer_reconciliation_timestamps_invalid');
  if (value.status === 'reserved' && (value.dispatchedAt !== null || value.finishedAt !== null || value.responseArtifact !== null ||
      value.proofArtifact !== null || value.outcome !== null || value.effectState !== 'unknown')) fail('computer_reconciliation_reserved_invalid');
  if (value.status === 'running' && (value.dispatchedAt === null || value.finishedAt !== null || value.responseArtifact !== null ||
      value.proofArtifact !== null || value.outcome !== null || value.effectState !== 'unknown')) fail('computer_reconciliation_running_invalid');
  if (value.status === 'received' && (value.dispatchedAt === null || value.finishedAt === null || value.responseArtifact === null ||
      value.proofArtifact !== null || value.outcome === null)) fail('computer_reconciliation_received_invalid');
  const known = value.outcome === 'applied' || value.outcome === 'not_applied';
  if (value.status === 'settled' && (value.dispatchedAt === null || value.finishedAt === null || value.responseArtifact === null ||
      value.proofArtifact === null || !known || value.effectState === 'unknown')) fail('computer_reconciliation_settled_invalid');
  if (value.status === 'failed' && (value.finishedAt === null || value.reason === null)) fail('computer_reconciliation_failed_invalid');
  if (value.responseArtifact !== null && (value.dispatchedAt === null || value.finishedAt === null || value.outcome === null) ||
      value.proofArtifact !== null && (value.responseArtifact === null || !known || value.effectState === 'unknown')) fail('computer_reconciliation_proof_invalid');
  if (known && value.responseArtifact === null || value.effectState !== 'unknown' && !known ||
      value.outcome === 'applied' && value.effectState === 'none') fail('computer_reconciliation_claim_invalid');
});
export const ComputerReconciliationsSchema = z.array(ComputerReconciliationSchema).max(1000).superRefine((records, ctx) => {
  if (new Set(records.map(record => record.id)).size !== records.length) ctx.addIssue({ code: 'custom', message: 'computer_reconciliation_duplicate' });
});
export const InputDependencySchema = z.strictObject({ provider: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), workId: id, artifact: ArtifactSchema });
export const EffectReceiptSchema = z.strictObject({ provider: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), operationId: id,
  outcome: z.enum(['applied', 'not_applied']), origin: z.enum(['execution', 'reconciliation']), artifact: ArtifactSchema, observedAt: count });
export const AttemptSchema = z.strictObject({ id, taskId: id, planRevision: revision, goalRevision: revision, toolId: id, toolVersion: id, inputDigest: id, scope: id,
  contractDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(), reuse: ToolReuseOriginSchema.optional(), execution: ToolExecutionSchema.optional(),
  readProgress: ReadProgressSchema.optional(),
  computerUse: z.strictObject({ head: ArtifactSchema, phase: z.enum(['running', 'complete', 'partial', 'unknown']), completedSteps: count.max(3), pendingOperationId: id.nullable() }).optional(),
  effect: z.enum(['read', 'write']), effectState: z.enum(['none', 'confirmed', 'unknown']), status: z.enum(['reserved', 'running', 'received', 'succeeded', 'partial', 'failed', 'cancelled', 'unknown']),
  owner: id, leaseUntil: count, startedAt: count, finishedAt: count.nullable(), resultId: id.nullable(), resultArtifact: ArtifactSchema.nullable(), adopted: z.boolean(),
  knowledgeDependencies: z.array(KnowledgeDependencySchema).max(50).optional(), inputDependencies: z.array(InputDependencySchema).max(50).optional(), effectReceipt: EffectReceiptSchema.optional(),
  error: z.strictObject({ code: id, retryable: z.boolean() }).nullable() });
export const ModelCallSchema = z.strictObject({ id, provider: id, model: id, adapterRevision: id, destination: id, owner: id, goalRevision: revision,
  inputProfileDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  personalMemoryDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  purpose: z.enum(['planning', 'session_compact', 'agent_turn']).optional(), compactInputDigest: id.optional(), compactRequestId: id.optional(),
  agentTurnPromptDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  baseStateRevision: revision, basePlanRevision: count, semanticDigest: id, semanticVersion: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(), failureKey: id.optional(), inputArtifact: ArtifactSchema, replyArtifact: ArtifactSchema.nullable(),
  inputEstimate: count, maxOutputTokens: count.min(1), tokenReservation: count, inputTokens: count.nullable(), outputTokens: count.nullable(),
  usageStatus: z.enum(['reserved', 'reported', 'unknown', 'not_called']), status: z.enum(['reserved', 'running', 'received', 'accepted', 'rejected', 'unknown', 'cancelled']),
  startedAt: count, leaseUntil: count, finishedAt: count.nullable(), expired: z.boolean(), outcome: z.enum(['ok', 'refused', 'truncated', 'invalid', 'error', 'cancelled']).nullable(), reason: text,
  contextMetrics: ContextMetricsSchema.optional() });
export const ToolResultSchema: z.ZodType<ToolResult> = z.strictObject({ resultId: id, attemptId: id, status: z.enum(['success', 'partial', 'error', 'cancelled']),
  effectState: z.enum(['none', 'confirmed', 'unknown']), evidence: z.array(EvidenceSchema), artifacts: z.array(ArtifactSchema), output: JsonSchema,
  error: z.strictObject({ code: id, retryable: z.boolean() }).nullable(), cursor: text.nullable(), coverage: z.enum(['complete', 'partial', 'unknown']),
  knowledgeDependencies: z.array(KnowledgeDependencySchema).max(50).optional(),
  inputDependencies: z.array(InputDependencySchema).max(50).optional(),
  effectReceipt: EffectReceiptSchema.optional(),
  reuse: ToolReuseOriginSchema.optional(), usage: ToolUsageSchema.optional(), collection: ReadCollectionProofSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.status === 'error' && value.error === null) ctx.addIssue({ code: 'custom', message: 'error_status_requires_error' });
  if (value.status === 'success' && (value.error !== null || value.coverage !== 'complete')) ctx.addIssue({ code: 'custom', message: 'success_requires_complete_coverage_without_error' });
});
export const BudgetSchema = z.strictObject({ limits: z.strictObject({ toolCalls: count, modelCalls: count, tokens: count, replans: count, wallTimeMs: count.min(1) }),
  used: z.strictObject({ toolCalls: count, modelCalls: count, tokens: count, replans: count, unmeasuredModelCalls: count }), reservedToolCalls: count, reservedModelCalls: count, reservedTokens: count });
export const ProgressSummarySchema = z.strictObject({ consecutiveUnproductive: count, productiveSteps: count, unproductiveSteps: count, saturated: z.boolean() });
export const DataLifecycleSchema = z.strictObject({ generation: revision, blockedArtifactIds: ids, changes: z.array(z.strictObject({ id,
  action: z.enum(['retract', 'correct', 'restrict', 'delete', 'dependency_changed']), principalId: id, at: count, evidenceIds: ids,
  replacementId: id.nullable(), reason: text, purge: z.enum(['not_requested', 'pending_retention_review']) })).max(10000) });
export const WorkspaceCheckpointSchema = z.strictObject({ id, workId: id, attemptId: id, path: text.min(1), artifact: ArtifactSchema,
  sourceEvidenceIds: ids, lifecycleGeneration: count, createdAt: count });
export const WorkStateSchema: z.ZodType<WorkState> = z.strictObject({ schemaVersion: z.literal(1), id, revision, goal: GoalSchema, policy: PolicySchema,
  generatedAnswer: GeneratedAnswerSchema.optional(),
  personalMemorySelection: PersonalMemorySelectionSchema.optional(), personalMemoryReviewRequired: z.boolean().optional(),
  subscriptions: ExternalSubscriptionsSchema.optional(), notifications: ExternalNotificationsSchema.optional(),
  computerContinuations: ComputerContinuationsSchema.optional(),
  computerReconciliations: ComputerReconciliationsSchema.optional(),
  disclosures: z.array(DisclosureRecordSchema).max(10000).optional(),
  disclosureLabels: ids.optional(),
  executionControl: ExecutionControlSchema.optional(), progress: WorkProgressSchema.optional(),
  retryWakeAt: count.nullable().optional(),
  budgetParent: BudgetParentSchema.optional(), budgetGrants: BudgetGrantsSchema.optional(),
  contextHead: ContextHeadSchema.nullable().optional(),
  status: z.enum(['ready', 'running', 'waiting', 'blocked', 'paused', 'cancelled', 'failed', 'completed']), statusReason: text, budget: BudgetSchema,
  plan: PlanSchema.nullable(), attempts: z.array(AttemptSchema), modelCalls: z.array(ModelCallSchema).default([]), evidence: z.array(EvidenceSchema), hypotheses: z.array(HypothesisSchema),
  hypothesisAssessment: z.strictObject({ goalRevision: revision, evidenceIds: ids }).nullable().default(null), obligations: z.array(ObligationSchema), artifacts: z.array(ArtifactSchema),
  conversation: ConversationStateSchema.nullable().default(null),
  dataLifecycle: DataLifecycleSchema.optional(),
  workspaceCheckpoints: z.array(WorkspaceCheckpointSchema).max(10000).optional(),
  createdAt: count, updatedAt: count, deadlineAt: count,
});
export const ContextObservationSchema: z.ZodType<ContextObservation> = z.strictObject({ attemptId: id, taskId: id, toolId: id, toolVersion: id,
  inputDigest: z.string().regex(/^[0-9a-f]{64}$/), resultId: id, resultArtifact: ArtifactSchema,
  reuse: ToolReuseOriginSchema.optional(),
  sourceContracts: z.array(z.strictObject({ id, version: id, digest: z.string().regex(/^[0-9a-f]{64}$/) })).min(1).max(128).optional(),
  status: z.enum(['success', 'partial', 'error', 'cancelled']), coverage: z.enum(['complete', 'partial', 'unknown']), representation: z.enum(['full', 'reference']),
  input: z.record(z.string(), JsonSchema).optional(), output: JsonSchema.optional(), historical: z.boolean() }).superRefine((value, ctx) => {
  if (value.representation === 'full' ? value.input === undefined || value.output === undefined : value.input !== undefined || value.output !== undefined)
    ctx.addIssue({ code: 'custom', message: 'context_observation_pair_required' });
});
export const ContextPacketSchema: z.ZodType<ContextPacket> = z.strictObject({ schemaVersion: z.literal(1), workId: id, stateRevision: revision,
  personalMemory: PersonalMemoryContextSchema.optional(),
  session: SessionContextSchema.optional(),
  notifications: ExternalNotificationsSchema.optional(),
  computerContinuations: ComputerContinuationsSchema.optional(),
  computerReconciliations: ComputerReconciliationsSchema.optional(),
  disclosureLabels: ids.optional(),
  readCollections: z.array(z.strictObject({ attemptId: id, taskId: id, attemptStatus: AttemptSchema.shape.status, progress: ReadProgressSchema,
    resumeMode: z.literal('stored_complete').optional() })).max(1000).optional(),
  goal: GoalSchema, policy: PolicySchema, plan: PlanSchema.nullable(), hypotheses: z.array(HypothesisSchema), obligations: z.array(ObligationSchema), evidence: z.array(EvidenceSchema), activeToolIds: ids, purpose: z.enum(['plan', 'assess', 'respond']),
  planningFeedback: z.array(z.strictObject({ callId: id, reason: text })).max(10).default([]),
  retrievedKnowledge: z.strictObject({ entries: z.array(z.strictObject({ attemptId: id, toolId: id, output: JsonSchema })).max(8), omitted: count,
    interpretation: z.literal('prior_observations_not_fresh_evidence') }).optional(),
  toolObservations: z.array(ContextObservationSchema).max(1000).optional(),
  evidenceReferences: z.array(z.strictObject({ id, sourceId: id, locator: text, observedAt: count, coverage: z.enum(['complete', 'partial', 'unknown']), status: z.enum(['accepted', 'retracted']) })).max(1000).optional(),
  activeGuidance: z.array(z.strictObject({ id, version: id, sha256: z.string().regex(/^[0-9a-f]{64}$/), manifestDigest: z.string().regex(/^[0-9a-f]{64}$/), artifact: ArtifactSchema, rules: z.array(text), body: text.optional() })).max(1000).optional(),
  contextView: z.strictObject({ policyTools: z.literal('active_subset'), planTasks: z.literal('frontier'), omitted: z.strictObject({ tools: count, evidence: count, attempts: count, tasks: count, results: count }), discoveryToolIds: ids }).optional(),
  execution: z.strictObject({ budget: BudgetSchema, deadlineAt: count, attempts: z.array(AttemptSchema), hypothesisAssessment: z.strictObject({ goalRevision: revision, evidenceIds: ids }).nullable(),
    control: ExecutionControlSchema.optional(), progress: ProgressSummarySchema.optional(), delegation: BudgetSummarySchema.optional() }).optional() });

export class ContractError extends Error {
  readonly code = 'invalid_contract';
  readonly paths: string[];
  constructor(paths: string[]) { super('invalid_contract'); this.paths = paths; }
}
export function parseContract<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ContractError(result.error.issues.map(i => i.path.join('.')));
  return result.data;
}
