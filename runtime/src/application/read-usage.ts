import type { ToolUsage } from '../domain/model.js';
import { ToolUsageSchema } from './contracts.js';

/** Sum one fixed set of original calls. A missing observation never means zero. */
export function sumReadUsage(values: readonly (ToolUsage | null | undefined)[]): ToolUsage {
  const parsed = values.map(value => value == null ? null : ToolUsageSchema.parse(value));
  const total: ToolUsage = { transportCalls: 0, internalOperations: 0, imageBytes: 0, waitMs: 0 };
  for (const key of ['transportCalls', 'internalOperations', 'imageBytes', 'waitMs'] as const) {
    let sum: number | null = 0;
    for (const value of parsed) {
      const amount = value?.[key];
      if (amount === null || amount === undefined) { sum = null; break; }
      sum += amount;
      if (!Number.isSafeInteger(sum)) throw new Error('read_usage_invalid');
    }
    total[key] = sum;
  }
  return total;
}
