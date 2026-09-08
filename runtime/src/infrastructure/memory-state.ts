import type { CommitRequest, CommitResult, ConversationWorkQuery, EventPageQuery, RecentEventMetadataQuery, StateRepository } from '../application/ports.js';
import { validateCommit, validateStateTransition } from '../application/store-contract.js';
import { matchesConversation, selectEventPage, selectRecentEventMetadata, validateConversationQuery, validateEventPageQuery, validateRecentEventQuery } from '../application/state-query.js';
import type { Delivery, StoredEvent, WorkState } from '../domain/model.js';
import { decodeStateQueryCursor, encodeStateQueryCursor } from './state-query-cursor.js';

export class MemoryStateRepository implements StateRepository {
  #states = new Map<string, WorkState>();
  #events = new Map<string, StoredEvent[]>();
  #deliveries = new Map<string, Map<string, Delivery>>();
  #receipts = new Map<string, Map<string, { digest: string; state: WorkState }>>();
  #closed = false;
  #check() { if (this.#closed) throw new Error('store_closed'); }
  async get(workId: string) { this.#check(); return structuredClone(this.#states.get(workId) ?? null); }
  async revisionHint(workId: string): Promise<number | null> {
    this.#check();
    if (typeof workId !== 'string' || !workId.length || workId.length > 256) throw new Error('invalid_state_query');
    return this.#states.get(workId)?.revision ?? null;
  }
  async receipt(workId: string, commandId: string) { this.#check(); return structuredClone(this.#receipts.get(workId)?.get(commandId) ?? null); }
  async commit(request: CommitRequest): Promise<CommitResult> {
    this.#check();
    const input = validateCommit(request);
    const receipt = this.#receipts.get(input.workId)?.get(input.commandId);
    if (receipt) return receipt.digest === input.commandDigest ? { kind: 'duplicate', state: structuredClone(receipt.state) } : { kind: 'idempotency_conflict' };
    const actualRevision = this.#states.get(input.workId)?.revision ?? 0;
    if (actualRevision !== input.expectedRevision) return { kind: 'conflict', actualRevision };
    validateStateTransition(this.#states.get(input.workId) ?? null, input.next);
    const nextEvents = [...(this.#events.get(input.workId) ?? [])];
    for (const event of input.events) nextEvents.push({ ...event, workId: input.workId, revision: input.next.revision, commandId: input.commandId, sequence: nextEvents.length + 1 });
    const deliveries = new Map(this.#deliveries.get(input.workId));
    for (const delivery of input.deliveries) deliveries.set(delivery.id, delivery);
    const receipts = new Map(this.#receipts.get(input.workId));
    receipts.set(input.commandId, { digest: input.commandDigest, state: input.next });
    this.#states.set(input.workId, input.next);
    this.#events.set(input.workId, nextEvents);
    this.#deliveries.set(input.workId, deliveries);
    this.#receipts.set(input.workId, receipts);
    return { kind: 'committed', state: structuredClone(input.next) };
  }
  async events(workId: string, afterSequence: number) { this.#check(); return structuredClone((this.#events.get(workId) ?? []).filter(e => e.sequence > afterSequence)); }
  async eventPage(workId: string, input: EventPageQuery) {
    this.#check(); const query = validateEventPageQuery(workId, input);
    return structuredClone(selectEventPage(this.#events.get(workId) ?? [], query));
  }
  async recentEventMetadata(workId: string, query: RecentEventMetadataQuery) {
    this.#check(); return selectRecentEventMetadata(this.#events.get(workId) ?? [], validateRecentEventQuery(workId, query));
  }
  async deliveries(workId: string) { this.#check(); return structuredClone([...(this.#deliveries.get(workId)?.values() ?? [])].sort((a, b) => a.id.localeCompare(b.id))); }
  async workIdsForConversation(tenantId: string, principalId: string, channel: string, conversationId: string) {
    this.#check(); return [...this.#states.values()].filter(s => s.policy.tenantId === tenantId && s.policy.principalId === principalId &&
      s.conversation?.bindings.some(b => b.channel === channel && b.conversationId === conversationId && b.tenantId === tenantId && b.principalId === principalId)).map(s => s.id).sort();
  }
  async conversationWorkPage(input: ConversationWorkQuery) {
    this.#check(); const query = validateConversationQuery(input); const after = decodeStateQueryCursor('memory-v1', query);
    const candidates: string[] = [];
    for (const state of this.#states.values()) {
      if ((after !== null && state.id <= after) || !matchesConversation(state, query)) continue;
      candidates.push(state.id); candidates.sort(); if (candidates.length > query.limit + 1) candidates.pop();
    }
    const workIds = candidates.slice(0, query.limit);
    return { workIds, nextCursor: candidates.length > query.limit ? encodeStateQueryCursor('memory-v1', query, workIds.at(-1)!) : null };
  }
  async runnable(now: number) {
    this.#check();
    return [...this.#states.values()].filter(s => ['ready', 'running'].includes(s.status) ||
      s.attempts.some(a => a.status === 'received' || (['reserved', 'running'].includes(a.status) && a.leaseUntil <= now)) ||
      s.modelCalls.some(c => c.status === 'received' || (['reserved', 'running'].includes(c.status) && (c.expired || c.leaseUntil <= now))) ||
      (s.status === 'waiting' && (s.deadlineAt <= now || (s.retryWakeAt != null && s.retryWakeAt <= now) || s.obligations.some(o => o.status === 'pending' && o.dueAt !== null && o.dueAt <= now)))).map(s => s.id).sort();
  }
  async close() { this.#closed = true; }
}
