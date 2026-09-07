import { z } from 'zod';
import { JsonSchema } from './contracts.js';
const id = z.string().min(1).max(160), count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const MissionRuleSchema = z.strictObject({ id, sourceId: id, resourceId: id,
  pollIntervalMs: count.min(1000).max(86400000), maxResumes: count.min(1).max(256),
  maxIdlePolls: count.min(1).max(4096), maxNoProgress: count.min(1).max(16) });
export type MissionRule = z.infer<typeof MissionRuleSchema>;
export const MissionEventSchema = z.strictObject({ id, kind: z.enum(['schedule', 'observation', 'reply']), referenceId: id,
  occurredAt: count, body: JsonSchema });
export type MissionEvent = z.infer<typeof MissionEventSchema>;
export const MissionPageSchema = z.strictObject({ cursor: count, events: z.array(MissionEventSchema).max(32),
  snapshotDigest: z.string().max(256).nullable() });
export type MissionPage = z.infer<typeof MissionPageSchema>;
export interface MissionEventSource {
  readonly id: string; readonly destination: string; readonly labels: readonly string[];
  poll(input: { resourceId: string; cursor: number; snapshotDigest: string | null; now: number; signal: AbortSignal;
    authorize: () => Promise<void> }): Promise<MissionPage>;
}
