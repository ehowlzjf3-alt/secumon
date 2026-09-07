import { z } from 'zod';
import type { ReadCall, ReadCheckpoint } from '../domain/read-checkpoint.js';
import { ArtifactSchema, GoalSchema, PolicySchema } from './contracts.js';
import { KnowledgeDependencySchema } from './knowledge-contracts.js';
import { ReadCollectionStateSchema, ReadKeySchema, ReadLimitsSchema, ReadRequestSchema } from './read-collection-contracts.js';

const id = z.string().min(1).max(256);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const phase = z.enum(['running', 'partial', 'complete']);

export const ReadCallSchema: z.ZodType<ReadCall> = z.strictObject({ request: ReadRequestSchema, attemptId: id,
  status: z.enum(['intent', 'accepted', 'deferred', 'rejected', 'unknown']), response: ArtifactSchema.nullable(),
  dispatchedAt: count, receivedAt: count.nullable(), errorCode: id.nullable(),
}).superRefine((call, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (call.receivedAt !== null && call.receivedAt < call.dispatchedAt) invalid('read_call_time_invalid');
  if (call.status === 'intent' && (call.response !== null || call.receivedAt !== null || call.errorCode !== null)) invalid('read_call_intent_has_result');
  if (call.status === 'accepted' && (call.response === null || call.receivedAt === null || call.errorCode !== null)) invalid('read_call_accepted_result_required');
  if (call.status === 'deferred' && (call.response === null || call.receivedAt === null || call.errorCode !== 'read_rate_limited')) invalid('read_call_deferral_required');
  if (call.status === 'rejected' && (call.receivedAt === null || call.errorCode === null)) invalid('read_call_rejection_required');
  if (call.status === 'unknown' && call.errorCode === null) invalid('read_call_unknown_reason_required');
});

/** Checks structural consistency; authoritative state, raw responses and source custody require separate verification. */
export const ReadCheckpointSchema: z.ZodType<ReadCheckpoint> = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('read_checkpoint'),
  operationId: id, workId: id, rootAttemptId: id, attemptId: id, goal: GoalSchema, policy: PolicySchema,
  lifecycleGeneration: count, toolId: id, toolVersion: id, queryDigest: digest, contractDigest: digest,
  limits: ReadLimitsSchema, collection: ReadCollectionStateSchema, calls: z.array(ReadCallSchema).max(10000),
  parent: z.strictObject({ attemptId: id, checkpoint: ArtifactSchema }).nullable(), artifacts: z.array(ArtifactSchema).max(10000),
  knowledgeDependencies: z.array(KnowledgeDependencySchema).max(50), phase, stopReason: z.string().min(1).max(10000).nullable(),
  createdAt: count, updatedAt: count, retryAt: count.nullable().optional(), coverageManifest: z.array(ReadKeySchema).max(10000).optional(),
}).superRefine((checkpoint, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (checkpoint.updatedAt < checkpoint.createdAt || checkpoint.calls.some(call =>
    call.dispatchedAt < checkpoint.createdAt || call.dispatchedAt > checkpoint.updatedAt ||
    (call.receivedAt !== null && call.receivedAt > checkpoint.updatedAt))) invalid('read_checkpoint_time_invalid');
  if (checkpoint.calls.length > checkpoint.limits.maxCalls) invalid('read_checkpoint_call_limit');
  const requestIds = checkpoint.calls.map(call => call.request.requestId);
  if (new Set(requestIds).size !== requestIds.length) invalid('read_checkpoint_duplicate_request');
  const accepted = checkpoint.calls.filter(call => call.status === 'accepted').map(call => call.request.requestId);
  if (accepted.length !== checkpoint.collection.calls || accepted.length !== checkpoint.collection.acceptedRequestIds.length ||
    accepted.some((value, index) => value !== checkpoint.collection.acceptedRequestIds[index])) invalid('read_checkpoint_accepted_history_mismatch');
  if (checkpoint.collection.pages.length + (checkpoint.collection.pending ? 1 : 0) > checkpoint.limits.maxPages) invalid('read_checkpoint_page_limit');
  const declaredItems = checkpoint.collection.pages.reduce((n, page) => n + page.expected.length, 0) + (checkpoint.collection.pending?.expected.length ?? 0);
  if (declaredItems > checkpoint.limits.maxItems) invalid('read_checkpoint_item_limit');
  if ((checkpoint.phase === 'complete') !== checkpoint.collection.exhausted ||
    (checkpoint.phase === 'complete' && checkpoint.collection.pending !== null)) invalid('read_checkpoint_phase_mismatch');
  if (checkpoint.phase === 'complete' && checkpoint.retryAt != null) invalid('read_checkpoint_complete_cannot_wait');
  if ((checkpoint.phase === 'partial') !== (checkpoint.stopReason !== null)) invalid('read_checkpoint_stop_reason_mismatch');
  const intents = checkpoint.calls.filter(call => call.status === 'intent');
  if (intents.length > 1 || (intents.length === 1 && (checkpoint.phase !== 'running' || checkpoint.calls.at(-1)?.status !== 'intent')))
    invalid('read_checkpoint_intent_position_invalid');
});

export { ReadResumeSchema, ReadProgressSchema, ReadCollectionProofSchema } from './contracts.js';
