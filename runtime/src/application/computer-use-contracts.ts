import { z } from 'zod';
import type { ComputerActInput, ComputerAction, ComputerCheckpoint, ComputerCheckpointV1, ComputerCheckpointV2, ComputerCheckpointStep, ComputerCondition, ComputerDriverIdentity, ComputerInputAssurance,
  ComputerElement, ComputerLease, ComputerLineage, ComputerLimits, ComputerObservationRecord, ComputerObserveInput, ComputerSelector, ComputerStep, ComputerView } from '../domain/computer-use.js';
import type { Json } from '../domain/model.js';
import type { ComputerActionResult, ComputerObservationResult, ComputerWaitResult } from './computer-use-ports.js';
import { ArtifactSchema, ComputerContinuationClaimSchema, ToolUsageSchema } from './contracts.js';
import { COMPUTER_INPUT_ASSURANCES } from '../domain/computer-use.js';

const id = z.string().min(1).max(256);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive = count.min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const value = z.string().max(8192);
const scalar = z.union([value, z.number().finite(), z.boolean(), z.null()]);
const bytes = (input: unknown) => new TextEncoder().encode(JSON.stringify(input)).byteLength;

export const ComputerDriverIdentitySchema: z.ZodType<ComputerDriverIdentity> = z.strictObject({ id, version: id });
export const ComputerInputAssuranceSchema: z.ZodType<ComputerInputAssurance> = z.enum(COMPUTER_INPUT_ASSURANCES);
export const ComputerElementSchema: z.ZodType<ComputerElement> = z.strictObject({ ref: id, role: z.string().min(1).max(128),
  name: z.string().max(1024), value: value.nullable(), visible: z.boolean(), enabled: z.boolean() });
export const ComputerViewSchema: z.ZodType<ComputerView> = z.strictObject({ sessionId: id, epoch: positive, surfaceId: id,
  revision: count, focusRevision: count, observedAt: count, elements: z.array(ComputerElementSchema).max(40),
  facts: z.record(id, scalar), partial: z.boolean(), omittedCount: count,
}).superRefine((view, context) => {
  if (new Set(view.elements.map(element => element.ref)).size !== view.elements.length) context.addIssue({ code: 'custom', message: 'computer_duplicate_refs' });
  if (!view.partial && view.omittedCount !== 0) context.addIssue({ code: 'custom', message: 'computer_omission_unreported' });
  if (Object.keys(view.facts).length > 100 || bytes(view) > 32768) context.addIssue({ code: 'custom', message: 'computer_view_too_large' });
});
export const ComputerSelectorSchema: z.ZodType<ComputerSelector> = z.strictObject({ role: z.string().min(1).max(128), name: z.string().min(1).max(1024) });
export const ComputerActionSchema: z.ZodType<ComputerAction> = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('fill'), target: ComputerSelectorSchema, value }),
  z.strictObject({ kind: z.literal('click'), target: ComputerSelectorSchema }),
]);
export const ComputerConditionSchema: z.ZodType<ComputerCondition> = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('element_value'), target: ComputerSelectorSchema, value }),
  z.strictObject({ kind: z.literal('fact_equals'), key: id, value: scalar }),
]);
export const ComputerStepSchema: z.ZodType<ComputerStep> = z.strictObject({ action: ComputerActionSchema, condition: ComputerConditionSchema });
export const ComputerLimitsSchema: z.ZodType<ComputerLimits> = z.strictObject({ maxSteps: positive.max(3), maxObservations: positive.max(12),
  maxElements: positive.max(40), maxViewBytes: positive.max(32768), maxDurationMs: positive.max(30000), pollIntervalMs: positive.max(1000) });
export const ComputerObserveInputSchema: z.ZodType<ComputerObserveInput> = z.strictObject({});
export const ComputerActInputSchema: z.ZodType<ComputerActInput> = z.strictObject({ observationId: id, steps: z.array(ComputerStepSchema).min(1).max(3), timeoutMs: positive.max(30000) });
export const ComputerLeaseSchema: z.ZodType<ComputerLease> = z.strictObject({ sessionId: id, epoch: positive, surfaceId: id, fence: positive,
  workId: id, attemptId: id, expiresAt: count });
export const ComputerObservationResultSchema: z.ZodType<ComputerObservationResult> = z.strictObject({ view: ComputerViewSchema, usage: ToolUsageSchema });
export const ComputerActionResultSchema: z.ZodType<ComputerActionResult> = z.strictObject({ operationId: id,
  status: z.enum(['applied', 'not_applied', 'unknown']), reason: id.nullable(), usage: ToolUsageSchema });
export const ComputerWaitResultSchema: z.ZodType<ComputerWaitResult> = z.strictObject({ status: z.enum(['changed', 'timeout', 'interrupted']), usage: ToolUsageSchema });
export const ComputerObservationRecordSchema: z.ZodType<ComputerObservationRecord> = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('computer_observation'),
  workId: id, attemptId: id, goalRevision: positive, scope: id, policyDigest: hash, lifecycleGeneration: count,
  driver: ComputerDriverIdentitySchema, view: ComputerViewSchema, usage: ToolUsageSchema });
export const ComputerCheckpointStepSchema: z.ZodType<ComputerCheckpointStep> = z.strictObject({ index: count.max(2), operationId: id,
  action: ComputerActionSchema, condition: ComputerConditionSchema, before: ArtifactSchema, after: ArtifactSchema.nullable(),
  status: z.enum(['intent', 'applied', 'not_applied', 'unknown']), verified: z.boolean(), errorCode: id.nullable(),
}).superRefine((step, context) => {
  if (step.verified && (step.status !== 'applied' || step.after === null)) context.addIssue({ code: 'custom', message: 'computer_verification_without_applied_observation' });
  if (step.status === 'intent' && (step.after !== null || step.verified || step.errorCode !== null)) context.addIssue({ code: 'custom', message: 'computer_intent_already_settled' });
});
const checkpointFields = { kind: z.literal('computer_checkpoint'),
  workId: id, attemptId: id, goalRevision: positive, scope: id, policyDigest: hash, lifecycleGeneration: count, taskDigest: hash, contractDigest: hash,
  driver: ComputerDriverIdentitySchema, sessionId: id, epoch: positive, deadlineAt: count,
  initialObservation: ArtifactSchema, latestObservation: ArtifactSchema, steps: z.array(ComputerCheckpointStepSchema).max(3),
  phase: z.enum(['running', 'complete', 'partial', 'unknown']), stopReason: id.nullable(), usage: ToolUsageSchema,
};
export const ComputerCheckpointV1Schema: z.ZodType<ComputerCheckpointV1> = z.strictObject({ schemaVersion: z.literal(1), ...checkpointFields }).superRefine((checkpoint, context) => {
  if (checkpoint.steps.some((step, index) => step.index !== index) || new Set(checkpoint.steps.map(step => step.operationId)).size !== checkpoint.steps.length)
    context.addIssue({ code: 'custom', message: 'computer_step_identity_invalid' });
  if (checkpoint.steps.some((step, index) => step.status === 'intent' && index !== checkpoint.steps.length - 1))
    context.addIssue({ code: 'custom', message: 'computer_unsettled_step_not_last' });
  if (checkpoint.phase === 'complete' && (!checkpoint.steps.length || checkpoint.stopReason !== null || checkpoint.steps.some(step => step.status !== 'applied' || !step.verified || step.after === null)))
    context.addIssue({ code: 'custom', message: 'computer_completion_unverified' });
});

export const ComputerLineageSchema: z.ZodType<ComputerLineage> = z.strictObject({ rootAttemptId: id, actionDeadlineAt: count,
  maxObservations: positive.max(12), maxInputAttempts: positive.max(6), maxSuccessors: positive.max(8), depth: count.max(8),
  observationsUsed: count.max(12), inputAttemptsUsed: count.max(6),
}).superRefine((lineage, context) => {
  if (lineage.depth > lineage.maxSuccessors || lineage.observationsUsed > lineage.maxObservations || lineage.inputAttemptsUsed > lineage.maxInputAttempts)
    context.addIssue({ code: 'custom', message: 'computer_lineage_limit_exceeded' });
});

export const ComputerCheckpointV2Schema: z.ZodType<ComputerCheckpointV2> = z.strictObject({ schemaVersion: z.literal(2), ...checkpointFields,
  lineage: ComputerLineageSchema, entryObservation: ArtifactSchema.nullable(),
  continuation: z.strictObject({ claim: ComputerContinuationClaimSchema, inheritedObservation: ArtifactSchema.nullable() }).nullable(),
}).superRefine((checkpoint, context) => {
  const fail = (message: string) => context.addIssue({ code: 'custom', message });
  const { lineage, continuation, entryObservation, steps } = checkpoint; const claim = continuation?.claim;
  const initialInputs = claim?.inputAttemptsUsed ?? 0; const initialObservations = claim?.observationsUsed ?? 0;
  if (lineage.inputAttemptsUsed !== initialInputs + steps.length || lineage.observationsUsed < initialObservations)
    fail('computer_lineage_usage_mismatch');
  if (!claim) {
    if (lineage.rootAttemptId !== checkpoint.attemptId || lineage.depth !== 0 || checkpoint.deadlineAt !== lineage.actionDeadlineAt)
      fail('computer_root_lineage_mismatch');
  } else {
    if (claim.successorAttemptId !== checkpoint.attemptId || claim.successorTaskDigest !== checkpoint.taskDigest ||
        claim.contractDigest !== checkpoint.contractDigest || claim.goalRevision !== checkpoint.goalRevision || claim.scope !== checkpoint.scope ||
        claim.policyDigest !== checkpoint.policyDigest || claim.generation !== checkpoint.lifecycleGeneration ||
        lineage.rootAttemptId !== claim.rootAttemptId || lineage.actionDeadlineAt !== claim.actionDeadlineAt ||
        lineage.maxObservations !== claim.maxObservations || lineage.maxInputAttempts !== claim.maxInputAttempts ||
        lineage.maxSuccessors !== claim.maxSuccessors || lineage.depth !== claim.depth) fail('computer_continuation_lineage_mismatch');
    if (claim.mode === 'verify' ? steps.length !== 0 : checkpoint.deadlineAt > lineage.actionDeadlineAt || steps.length > claim.totalSteps - claim.nextStep)
      fail('computer_continuation_steps_invalid');
  }
  if (steps.some((step, index) => step.index !== index) || new Set(steps.map(step => step.operationId)).size !== steps.length)
    fail('computer_step_identity_invalid');
  if (steps.some((step, index) => step.status === 'intent' && index !== steps.length - 1)) fail('computer_unsettled_step_not_last');
  if (entryObservation === null) {
    if (steps.length || continuation?.inheritedObservation || JSON.stringify(checkpoint.initialObservation) !== JSON.stringify(checkpoint.latestObservation))
      fail('computer_entry_observation_missing');
  } else if (lineage.observationsUsed <= initialObservations) fail('computer_observation_not_reserved');
  if (claim && steps.length && continuation!.inheritedObservation === null) fail('computer_inherited_observation_missing');
  if (checkpoint.phase === 'complete') {
    if (entryObservation === null || checkpoint.stopReason !== null || steps.some(step => step.status !== 'applied' || !step.verified || step.after === null))
      fail('computer_completion_unverified');
    if (!steps.length && (!claim || claim.mode !== 'verify' || claim.nextStep !== claim.totalSteps || continuation!.inheritedObservation === null))
      fail('computer_completion_unverified');
    if (claim?.mode === 'continue' && steps.length !== claim.totalSteps - claim.nextStep) fail('computer_completion_unverified');
  }
});

export const ComputerCheckpointSchema: z.ZodType<ComputerCheckpoint> = z.union([ComputerCheckpointV1Schema, ComputerCheckpointV2Schema]);

export class ComputerContractError extends Error { constructor(readonly code: string) { super(code); } }

/** Structural validation and bounded monotonic observations do not establish a live session lease or authorize an action. */
export function validateView(input: unknown, limits: Pick<ComputerLimits, 'maxElements' | 'maxViewBytes'>, previous?: ComputerView): ComputerView {
  if (!Number.isSafeInteger(limits.maxElements) || limits.maxElements < 1 || limits.maxElements > 40 ||
    !Number.isSafeInteger(limits.maxViewBytes) || limits.maxViewBytes < 1 || limits.maxViewBytes > 32768) throw new ComputerContractError('computer_limits_invalid');
  const parsed = ComputerViewSchema.safeParse(input);
  if (!parsed.success) throw new ComputerContractError('computer_view_invalid');
  const view = parsed.data;
  if (view.elements.length > limits.maxElements || bytes(view) > limits.maxViewBytes) throw new ComputerContractError('computer_view_too_large');
  if (previous && (view.sessionId !== previous.sessionId || view.epoch !== previous.epoch || view.surfaceId !== previous.surfaceId ||
    view.revision < previous.revision || view.focusRevision < previous.focusRevision || view.observedAt < previous.observedAt)) throw new ComputerContractError('computer_view_changed');
  return view;
}

/** A partial observation cannot prove that an omitted matching target does not exist. */
export function selectTarget(view: ComputerView, selector: ComputerSelector): ComputerElement {
  if (view.partial) throw new ComputerContractError('computer_view_partial');
  const parsed = ComputerSelectorSchema.safeParse(selector); if (!parsed.success) throw new ComputerContractError('computer_selector_invalid');
  const matches = view.elements.filter(element => element.role === parsed.data.role && element.name === parsed.data.name);
  if (!matches.length) throw new ComputerContractError('computer_target_missing');
  if (matches.length !== 1) throw new ComputerContractError('computer_target_ambiguous');
  const target = matches[0]!;
  if (!target.visible || !target.enabled) throw new ComputerContractError('computer_target_unavailable');
  return { ...target };
}

export function conditionMatches(view: ComputerView, condition: ComputerCondition): boolean {
  const parsed = ComputerConditionSchema.safeParse(condition); if (!parsed.success) throw new ComputerContractError('computer_condition_invalid');
  const expected = parsed.data;
  if (expected.kind === 'fact_equals') return Object.hasOwn(view.facts, expected.key) && view.facts[expected.key] === expected.value;
  if (view.partial) return false;
  const matches = view.elements.filter(element => element.role === expected.target.role && element.name === expected.target.name);
  return matches.length === 1 && matches[0]!.visible && matches[0]!.value === expected.value;
}

const selectorJson = { type: 'object', additionalProperties: false, required: ['role', 'name'], properties: {
  role: { type: 'string', minLength: 1, maxLength: 128 }, name: { type: 'string', minLength: 1, maxLength: 1024 } } };
const valueJson = { type: 'string', maxLength: 8192 };
const actionJson = { oneOf: [
  { type: 'object', additionalProperties: false, required: ['kind', 'target', 'value'], properties: { kind: { const: 'fill' }, target: selectorJson, value: valueJson } },
  { type: 'object', additionalProperties: false, required: ['kind', 'target'], properties: { kind: { const: 'click' }, target: selectorJson } },
] };
const conditionJson = { oneOf: [
  { type: 'object', additionalProperties: false, required: ['kind', 'target', 'value'], properties: { kind: { const: 'element_value' }, target: selectorJson, value: valueJson } },
  { type: 'object', additionalProperties: false, required: ['kind', 'key', 'value'], properties: { kind: { const: 'fact_equals' }, key: { type: 'string', minLength: 1, maxLength: 256 },
    value: { anyOf: [valueJson, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] } } },
] };
export const COMPUTER_OBSERVE_INPUT_SCHEMA: Json = { type: 'object', additionalProperties: false, properties: {} };
export const COMPUTER_ACT_INPUT_SCHEMA: Json = { type: 'object', additionalProperties: false, required: ['observationId', 'steps', 'timeoutMs'], properties: {
  observationId: { type: 'string', minLength: 1, maxLength: 256 }, timeoutMs: { type: 'integer', minimum: 1, maximum: 30000 },
  steps: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['action', 'condition'], properties: { action: actionJson, condition: conditionJson } } },
} };
