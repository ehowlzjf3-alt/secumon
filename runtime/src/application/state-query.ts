import { z } from 'zod';
import type { ConversationWorkQuery, EventPage, EventPageQuery, RecentEventMetadata, RecentEventMetadataQuery } from './ports.js';
import type { StoredEvent, WorkState } from '../domain/model.js';

const id = z.string().min(1).max(256);
const recentSchema = z.strictObject({ throughRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), limit: z.number().int().min(1).max(50) });
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const eventPageSchema = z.strictObject({ afterRevision: revision, throughRevision: revision,
  beforeSequence: revision.positive().optional(), limit: z.number().int().min(1).max(128), type: id.optional() })
  .refine(value => value.afterRevision <= value.throughRevision);
export function validateEventPageQuery(workId: string, query: EventPageQuery): EventPageQuery {
  const parsed = eventPageSchema.safeParse(query);
  if (!id.safeParse(workId).success || !parsed.success) throw new Error('invalid_state_query');
  const { beforeSequence, type, ...required } = parsed.data;
  return { ...required, ...(beforeSequence === undefined ? {} : { beforeSequence }), ...(type === undefined ? {} : { type }) };
}
/** Rows are already ordered newest first and contain at most one lookahead beyond the requested page. */
export function eventPageFromRows(rows: readonly StoredEvent[], limit: number): EventPage {
  const items = rows.slice(0, limit);
  return { items, nextBeforeSequence: rows.length > limit ? items.at(-1)!.sequence : null };
}
/** The immutable projection remains intact; callers clone only the selected original page. */
export function selectEventPage(events: readonly StoredEvent[], query: EventPageQuery): EventPage {
  let low = 0; let high = events.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2), event = events[middle]!;
    if (event.revision <= query.throughRevision && (query.beforeSequence === undefined || event.sequence < query.beforeSequence)) low = middle + 1;
    else high = middle;
  }
  const selected: StoredEvent[] = [];
  for (let index = low - 1; index >= 0; index--) {
    const event = events[index]!; if (event.revision <= query.afterRevision) break;
    if (query.type !== undefined && event.type !== query.type) continue;
    selected.push(event); if (selected.length > query.limit) break;
  }
  return eventPageFromRows(selected, query.limit);
}
const pageSchema = z.strictObject({ tenantId: id, principalId: id, channel: id, conversationId: id, cursor: z.string().min(1).max(4096).optional(), limit: z.number().int().min(1).max(20) });
export function validateRecentEventQuery(workId: string, query: RecentEventMetadataQuery): RecentEventMetadataQuery {
  const parsed = recentSchema.safeParse(query);
  if (!id.safeParse(workId).success || !parsed.success) throw new Error('invalid_state_query');
  return parsed.data;
}
export function validateConversationQuery(query: ConversationWorkQuery): ConversationWorkQuery {
  const parsed = pageSchema.safeParse(query); if (!parsed.success) throw new Error('invalid_state_query');
  const { cursor, ...rest } = parsed.data; return cursor === undefined ? rest : { ...rest, cursor };
}
export function matchesConversation(state: WorkState, query: ConversationWorkQuery): boolean {
  return state.policy.tenantId === query.tenantId && state.policy.principalId === query.principalId && !!state.conversation?.bindings.some(binding =>
    binding.channel === query.channel && binding.conversationId === query.conversationId && binding.tenantId === query.tenantId && binding.principalId === query.principalId);
}
export function selectRecentEventMetadata(events: readonly StoredEvent[], query: RecentEventMetadataQuery): RecentEventMetadata {
  let low = 0; let high = events.length;
  while (low < high) { const middle = Math.floor((low + high) / 2); if (events[middle]!.revision <= query.throughRevision) low = middle + 1; else high = middle; }
  const start = Math.max(0, low - query.limit);
  return { items: events.slice(start, low).map(({ sequence, revision, type, at }) => ({ sequence, revision, type, at })), omittedCount: start };
}
