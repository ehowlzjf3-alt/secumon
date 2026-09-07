import type { CommitRequest, CommitResult, ConversationWorkQuery, RecentEventMetadataQuery, StateRepository } from '../application/ports.js';
import { WorkStateSchema, parseContract } from '../application/contracts.js';
import { DeliverySchema, StoredEventSchema, validateCommit, validateStateTransition } from '../application/store-contract.js';
import { validateConversationQuery, validateRecentEventQuery } from '../application/state-query.js';
import type { StoredEvent } from '../domain/model.js';
import { decodeStateQueryCursor, encodeStateQueryCursor } from './state-query-cursor.js';
import { PostgresStore, postgresInteger, postgresJson } from './postgres-store.js';
import { sha256 } from './digest.js';

export const POSTGRES_STATE_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS secumon_pg.works(store_id text NOT NULL,agent_id text NOT NULL,id text NOT NULL COLLATE "C",revision bigint NOT NULL,
    status text NOT NULL,deadline_at bigint NOT NULL,body text NOT NULL,PRIMARY KEY(store_id,agent_id,id))`,
  `CREATE TABLE IF NOT EXISTS secumon_pg.events(store_id text NOT NULL,agent_id text NOT NULL,work_id text NOT NULL,sequence bigint NOT NULL,
    revision bigint NOT NULL,type text NOT NULL,at bigint NOT NULL,command_id text NOT NULL,body text NOT NULL,PRIMARY KEY(store_id,agent_id,work_id,sequence),
    FOREIGN KEY(store_id,agent_id,work_id) REFERENCES secumon_pg.works(store_id,agent_id,id))`,
  `CREATE INDEX IF NOT EXISTS events_revision ON secumon_pg.events(store_id,agent_id,work_id,revision,sequence)`,
  `CREATE TABLE IF NOT EXISTS secumon_pg.state_receipts(store_id text NOT NULL,agent_id text NOT NULL,work_id text NOT NULL,command_id text NOT NULL,
    digest text NOT NULL,body text NOT NULL,PRIMARY KEY(store_id,agent_id,work_id,command_id),FOREIGN KEY(store_id,agent_id,work_id) REFERENCES secumon_pg.works(store_id,agent_id,id))`,
  `CREATE TABLE IF NOT EXISTS secumon_pg.deliveries(store_id text NOT NULL,agent_id text NOT NULL,work_id text NOT NULL,id text NOT NULL COLLATE "C",
    body text NOT NULL,PRIMARY KEY(store_id,agent_id,work_id,id),FOREIGN KEY(store_id,agent_id,work_id) REFERENCES secumon_pg.works(store_id,agent_id,id))`,
  `CREATE TABLE IF NOT EXISTS secumon_pg.conversation_work(store_id text NOT NULL,agent_id text NOT NULL,tenant_id text NOT NULL,principal_id text NOT NULL,
    channel text NOT NULL,conversation_id text NOT NULL,work_id text NOT NULL COLLATE "C",PRIMARY KEY(store_id,agent_id,tenant_id,principal_id,channel,conversation_id,work_id),
    FOREIGN KEY(store_id,agent_id,work_id) REFERENCES secumon_pg.works(store_id,agent_id,id))`,
  `CREATE INDEX IF NOT EXISTS works_status ON secumon_pg.works(store_id,agent_id,status)`,
];
const state = (value: unknown) => parseContract(WorkStateSchema, postgresJson(value));
const where = 'store_id=$1 AND agent_id=$2 AND work_id=$3';
export class PostgresStateRepository implements StateRepository {
  readonly #cursor: string;
  constructor(private readonly store: PostgresStore) {
    if (store.binding.purpose !== 'state') throw new Error('postgres_state_binding_required');
    this.#cursor = `postgres-v1-${sha256(JSON.stringify(store.binding))}`;
  }
  async get(workId: string) {
    return this.store.read(async c => {
      const row = (await c.query('SELECT body FROM secumon_pg.works WHERE store_id=$1 AND agent_id=$2 AND id=$3', [...this.store.key, workId])).rows[0];
      const value = row ? state(row['body']) : null;
      if (value && value.id !== workId) throw new Error('invalid_stored_record');
      return value;
    });
  }
  async receipt(workId: string, commandId: string) {
    return this.store.read(async c => {
      const row = (await c.query(`SELECT digest,body FROM secumon_pg.state_receipts WHERE ${where} AND command_id=$4`, [...this.store.key, workId, commandId])).rows[0];
      if (!row) return null;
      if (typeof row['digest'] !== 'string') throw new Error('invalid_stored_receipt');
      const saved = state(row['body']); if (saved.id !== workId) throw new Error('invalid_stored_receipt');
      return { digest: row['digest'], state: saved };
    });
  }
  async commit(raw: CommitRequest): Promise<CommitResult> {
    const request = validateCommit(structuredClone(raw)), next = request.next, key = [...this.store.key, next.id];
    return this.store.write(async c => {
      const priorReceipt = (await c.query(`SELECT digest,body FROM secumon_pg.state_receipts WHERE ${where} AND command_id=$4`, [...key, request.commandId])).rows[0];
      if (priorReceipt) return priorReceipt['digest'] === request.commandDigest ? { kind: 'duplicate', state: state(priorReceipt['body']) } : { kind: 'idempotency_conflict' };
      const priorRow = (await c.query('SELECT revision,body FROM secumon_pg.works WHERE store_id=$1 AND agent_id=$2 AND id=$3', key)).rows[0];
      const actualRevision = priorRow ? postgresInteger(priorRow['revision']) : 0;
      if (actualRevision !== request.expectedRevision) return { kind: 'conflict', actualRevision };
      validateStateTransition(priorRow ? state(priorRow['body']) : null, next);
      await c.query(`INSERT INTO secumon_pg.works VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(store_id,agent_id,id)
        DO UPDATE SET revision=excluded.revision,status=excluded.status,deadline_at=excluded.deadline_at,body=excluded.body`, [...key, next.revision, next.status, next.deadlineAt, JSON.stringify(next)]);
      let sequence = postgresInteger((await c.query(`SELECT COALESCE(MAX(sequence),0) AS sequence FROM secumon_pg.events WHERE ${where}`, key)).rows[0]!['sequence']);
      for (const event of request.events) {
        if (sequence >= Number.MAX_SAFE_INTEGER) throw new Error('event_sequence_exhausted');
        const stored: StoredEvent = { ...event, workId: next.id, revision: next.revision, commandId: request.commandId, sequence: ++sequence };
        await c.query('INSERT INTO secumon_pg.events VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [...key, stored.sequence, stored.revision, stored.type, stored.at, stored.commandId, JSON.stringify(stored)]);
      }
      for (const delivery of request.deliveries) await c.query(`INSERT INTO secumon_pg.deliveries VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(store_id,agent_id,work_id,id) DO UPDATE SET body=excluded.body`, [...key, delivery.id, JSON.stringify(delivery)]);
      await c.query('INSERT INTO secumon_pg.state_receipts VALUES($1,$2,$3,$4,$5,$6)', [...key, request.commandId, request.commandDigest, JSON.stringify(next)]);
      await c.query(`DELETE FROM secumon_pg.conversation_work WHERE ${where}`, key);
      for (const binding of next.conversation?.bindings ?? []) if (binding.tenantId === next.policy.tenantId && binding.principalId === next.policy.principalId) {
        await c.query('INSERT INTO secumon_pg.conversation_work VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
          [...this.store.key, binding.tenantId, binding.principalId, binding.channel, binding.conversationId, next.id]);
      }
      return { kind: 'committed', state: next };
    });
  }
  async events(workId: string, afterSequence: number) {
    postgresInteger(afterSequence);
    return this.store.read(async c => (await c.query(`SELECT body FROM secumon_pg.events WHERE ${where} AND sequence>$4 ORDER BY sequence`, [...this.store.key, workId, afterSequence])).rows
      .map(row => parseContract(StoredEventSchema, postgresJson(row['body']))));
  }
  async recentEventMetadata(workId: string, raw: RecentEventMetadataQuery) {
    const query = validateRecentEventQuery(workId, raw), key = [...this.store.key, workId];
    return this.store.read(async c => {
      const total = postgresInteger((await c.query(`SELECT COALESCE(MAX(sequence),0) AS sequence FROM secumon_pg.events WHERE ${where} AND revision<=$4`, [...key, query.throughRevision])).rows[0]!['sequence']);
      const rows = (await c.query(`SELECT sequence,revision,type,at FROM secumon_pg.events WHERE ${where} AND sequence<=$4 ORDER BY sequence DESC LIMIT $5`, [...key, total, query.limit])).rows;
      return { items: rows.reverse().map(row => ({ sequence: postgresInteger(row['sequence']), revision: postgresInteger(row['revision']), type: String(row['type']), at: postgresInteger(row['at']) })), omittedCount: Math.max(0, total - rows.length) };
    });
  }
  async deliveries(workId: string) {
    return this.store.read(async c => (await c.query(`SELECT body FROM secumon_pg.deliveries WHERE ${where} ORDER BY id`, [...this.store.key, workId])).rows
      .map(row => parseContract(DeliverySchema, postgresJson(row['body']))));
  }
  async workIdsForConversation(tenantId: string, principalId: string, channel: string, conversationId: string) {
    validateConversationQuery({ tenantId, principalId, channel, conversationId, limit: 1 });
    return this.store.read(async c => (await c.query('SELECT work_id FROM secumon_pg.conversation_work WHERE store_id=$1 AND agent_id=$2 AND tenant_id=$3 AND principal_id=$4 AND channel=$5 AND conversation_id=$6 ORDER BY work_id', [...this.store.key, tenantId, principalId, channel, conversationId])).rows.map(row => String(row['work_id'])));
  }
  async conversationWorkPage(raw: ConversationWorkQuery) {
    const q = validateConversationQuery(raw), after = decodeStateQueryCursor(this.#cursor, q);
    return this.store.read(async c => {
      const rows = (await c.query(`SELECT work_id FROM secumon_pg.conversation_work WHERE store_id=$1 AND agent_id=$2 AND tenant_id=$3 AND principal_id=$4 AND channel=$5 AND conversation_id=$6
        AND ($7::text IS NULL OR work_id>$7 COLLATE "C") ORDER BY work_id LIMIT $8`, [...this.store.key, q.tenantId, q.principalId, q.channel, q.conversationId, after, q.limit + 1])).rows;
      const workIds = rows.slice(0, q.limit).map(row => String(row['work_id']));
      return { workIds, nextCursor: rows.length > q.limit ? encodeStateQueryCursor(this.#cursor, q, workIds.at(-1)!) : null };
    });
  }
  async runnable(now: number) {
    postgresInteger(now);
    return this.store.read(async c => (await c.query(`SELECT id FROM secumon_pg.works WHERE store_id=$1 AND agent_id=$2 AND (
      status IN ('ready','running') OR EXISTS (SELECT 1 FROM jsonb_array_elements(body::jsonb->'attempts') a WHERE a->>'status'='received' OR
        (a->>'status' IN ('reserved','running') AND (a->>'leaseUntil')::bigint<=$3)) OR
      EXISTS (SELECT 1 FROM jsonb_array_elements(body::jsonb->'modelCalls') m WHERE m->>'status'='received' OR
        (m->>'status' IN ('reserved','running') AND ((m->>'expired')::boolean=true OR (m->>'leaseUntil')::bigint<=$3))) OR
      (status='waiting' AND (deadline_at<=$3 OR (body::jsonb->>'retryWakeAt')::bigint<=$3 OR
        EXISTS (SELECT 1 FROM jsonb_array_elements(body::jsonb->'obligations') o WHERE o->>'status'='pending' AND (o->>'dueAt')::bigint<=$3)))) ORDER BY id`, [...this.store.key, now])).rows.map(row => String(row['id'])));
  }
  close() { return this.store.close(); }
}
