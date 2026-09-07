import { z } from 'zod';
import type { ExecutionControl, ExecutionPolicy } from '../domain/execution-policy.js';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const mode = z.enum(['auto', 'fast', 'deep']);
const reason = z.string().min(1).max(10000).refine(value => value.trim().length > 0);

export const ExecutionPolicySchema: z.ZodType<ExecutionPolicy> = z.strictObject({
  version: z.string().min(1).max(256).refine(value => value.trim().length > 0),
  fast: z.strictObject({ toolCalls: count, modelCalls: count, replans: count, maxPendingTasks: count, maxHypotheses: count }),
});
export const ExecutionControlSchema: z.ZodType<ExecutionControl> = z.strictObject({
  revision: count.min(1), requestedMode: mode, strategy: z.enum(['direct', 'investigate']), policy: ExecutionPolicySchema,
  pending: z.strictObject({ mode, reason }).nullable(), lastReason: reason,
}).superRefine((value, context) => {
  if ((value.requestedMode === 'fast' && value.strategy !== 'direct') || (value.requestedMode === 'deep' && value.strategy !== 'investigate'))
    context.addIssue({ code: 'custom', path: ['strategy'], message: 'execution_mode_strategy_mismatch' });
});
