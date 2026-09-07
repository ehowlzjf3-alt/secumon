import { z } from 'zod';
import type { ProgressFailure, ProgressPolicy, WorkProgress } from '../domain/work-progress.js';
import { validWorkProgress } from '../domain/work-progress.js';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const key = z.string().min(1).max(512);
export const ProgressPolicySchema: z.ZodType<ProgressPolicy> = z.strictObject({ maxUnproductiveSteps: count.min(1).max(10000),
  maxRepeatedFailures: count.min(1).max(10000), retryWindowMs: count.min(1), backoffMs: count, maxTrackedEntries: count.min(1).max(10000) })
  .refine(policy => policy.backoffMs <= policy.retryWindowMs, 'progress_backoff_exceeds_retry_window');
export const ProgressFailureSchema: z.ZodType<ProgressFailure> = z.strictObject({ key, count: count.min(1), firstAt: count, lastAt: count, nextEligibleAt: count, deadlineAt: count });
export const WorkProgressSchema: z.ZodType<WorkProgress> = z.strictObject({ schemaVersion: z.literal(1), goalRevision: count.min(1), policy: ProgressPolicySchema,
  processed: z.array(key).max(10000), knownKeys: z.array(key).max(10000), consecutiveUnproductive: count, productiveSteps: count, unproductiveSteps: count,
  failures: z.array(ProgressFailureSchema).max(10000), saturated: z.boolean() }).refine(validWorkProgress, 'progress_state_invalid');
