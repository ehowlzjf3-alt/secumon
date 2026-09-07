import { z } from 'zod';
import type { BoardChange, BoardChangePage, BoardChangeQuery } from '../domain/board.js';
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const BoardChangeSchema: z.ZodType<BoardChange> = z.strictObject({ revision: revision.positive(), at: revision,
  requestIds: z.array(z.string().min(1).max(160)).max(256), roleIds: z.array(z.string().min(1).max(160)).max(64) });
export const BoardChangeQuerySchema: z.ZodType<BoardChangeQuery> = z.strictObject({ afterRevision: revision,
  maxEvents: revision.min(1).max(64), maxBytes: revision.min(1024).max(262144) });
export function boardChangePage(query: BoardChangeQuery, headRevision: number, historyAfterRevision: number, candidates: BoardChange[]): BoardChangePage {
  const args = BoardChangeQuerySchema.parse(query);
  if (args.afterRevision > headRevision) throw new Error('board_event_cursor_ahead');
  const page: BoardChangePage = { headRevision, throughRevision: args.afterRevision, historyAfterRevision,
    resyncRequired: args.afterRevision < historyAfterRevision, more: false, events: [] };
  if (page.resyncRequired) { page.throughRevision = headRevision; return page; }
  for (const raw of candidates) {
    const event = BoardChangeSchema.parse(raw);
    if (event.revision !== page.throughRevision + 1 || event.revision > headRevision) throw new Error('board_event_gap');
    if (page.events.length === args.maxEvents) { page.more = true; break; }
    const previousRevision = page.throughRevision;
    page.events.push(event); page.throughRevision = event.revision;
    if (new TextEncoder().encode(JSON.stringify(page)).byteLength > args.maxBytes) {
      page.events.pop(); page.throughRevision = previousRevision;
      if (!page.events.length) throw new Error('board_event_too_large'); page.more = true; break;
    }
  }
  if (!page.more && page.throughRevision !== headRevision) throw new Error('board_event_gap');
  return page;
}
