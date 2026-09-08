import { z } from 'zod';
import type { TaskSpec, ToolResult } from '../domain/model.js';
import { MissionEventSchema, MissionRuleSchema } from './mission-contracts.js';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const input = z.strictObject({ ruleId: z.string().min(1).max(160).optional(), maxBytes: count.min(512).max(262144) });
const list = z.strictObject({ kind: z.literal('mission_rules'), rules: z.array(z.strictObject({ rule: MissionRuleSchema,
  cursor: count, pendingRun: z.boolean(), nextPollAt: count })).max(16) });
const events = z.strictObject({ kind: z.literal('unreviewed_mission_events'), rule: MissionRuleSchema,
  events: z.array(MissionEventSchema).max(32), cursor: count, status: z.enum(['active', 'closed']), reason: z.string().max(256).nullable() });

/** Native, adopted event reads provide preparation only; polling metadata is not independent evidence. */
export function missionProgressKeys(task: TaskSpec, result: ToolResult, key: (kind: string, value: unknown) => string): string[] {
  if (task.toolId !== 'mission.events' || task.toolVersion !== '1' || result.status !== 'success' || result.coverage !== 'complete' ||
    result.artifacts.length || result.evidence.length || result.cursor !== null) return [];
  const request = input.safeParse(task.input); if (!request.success) return [];
  const ruleKey = (rule: z.infer<typeof MissionRuleSchema>) => key('mission-rule', rule);
  if (request.data.ruleId === undefined) {
    const page = list.safeParse(result.output); if (!page.success) return [];
    return [...new Set(page.data.rules.map(value => ruleKey(value.rule)))];
  }
  const page = events.safeParse(result.output);
  if (!page.success || page.data.rule.id !== request.data.ruleId) return [];
  // Keep the source body intact. Reissued envelope IDs, cursor and receipt times cannot credit the same content again.
  return [...new Set([ruleKey(page.data.rule), ...page.data.events.map(({ id: _id, occurredAt: _time, ...event }) =>
    key('mission-event', { rule: page.data.rule, event })),
    ...(page.data.status === 'closed' ? [key('mission-closed', { rule: page.data.rule, reason: page.data.reason })] : [])])];
}
