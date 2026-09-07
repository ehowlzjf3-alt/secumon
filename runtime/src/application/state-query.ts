import { z } from 'zod';
import type { ConversationWorkQuery, RecentEventMetadata, RecentEventMetadataQuery } from './ports.js';
import type { StoredEvent, WorkState } from '../domain/model.js';

const id = z.string().min(1).max(256);
const recentSchema = z.strictObject({ throughRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), limit: z.number().int().min(1).max(50) });
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
