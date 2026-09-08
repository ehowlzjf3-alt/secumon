import type { DatabaseSync } from 'node:sqlite';
import { openHostSqliteDatabase, closeSqliteAfterFailure } from './windows-sqlite.js';
import type { CommitRequest, CommitResult, ConversationWorkQuery, EventPageQuery, RecentEventMetadata, RecentEventMetadataQuery, StateRepository } from '../application/ports.js';
import { WorkStateSchema, parseContract } from '../application/contracts.js';
import { DeliverySchema, StoredEventSchema, validateCommit, validateStateTransition } from '../application/store-contract.js';
import type { Delivery, StoredEvent, WorkState } from '../domain/model.js';
import { eventPageFromRows, validateConversationQuery, validateEventPageQuery, validateRecentEventQuery } from '../application/state-query.js';
import { decodeStateQueryCursor, encodeStateQueryCursor } from './state-query-cursor.js';

function jsonCell(value: unknown): unknown {
  if (typeof value !== 'string') throw new Error('invalid_stored_record');
  return JSON.parse(value);
}

export class SqliteStateRepository implements StateRepository {
  #db: DatabaseSync;
  constructor(path: string) {
    this.#db = openHostSqliteDatabase(path);
    try {
      this.#db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.#db.exec('BEGIN IMMEDIATE');
      const version = this.#db.prepare('PRAGMA user_version').get()?.['user_version'];
      if (version !== 0 && version !== 1 && version !== 2 && version !== 3) throw new Error('unsupported_state_schema');
      this.#db.exec(`
      CREATE TABLE IF NOT EXISTS works (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, status TEXT NOT NULL, deadline_at INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (work_id TEXT NOT NULL REFERENCES works(id), sequence INTEGER NOT NULL, revision INTEGER NOT NULL, command_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(work_id, sequence));
      CREATE TABLE IF NOT EXISTS receipts (work_id TEXT NOT NULL REFERENCES works(id), command_id TEXT NOT NULL, digest TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(work_id, command_id));
      CREATE TABLE IF NOT EXISTS deliveries (work_id TEXT NOT NULL REFERENCES works(id), id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(work_id, id));
      CREATE INDEX IF NOT EXISTS works_status ON works(status);
      `);
      if (version < 2) {
        this.#db.exec(`
          CREATE TABLE event_metadata (work_id TEXT NOT NULL REFERENCES works(id), sequence INTEGER NOT NULL, revision INTEGER NOT NULL, type TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(work_id,sequence));
          CREATE INDEX event_metadata_revision ON event_metadata(work_id,revision,sequence);
          CREATE TABLE conversation_work (tenant_id TEXT NOT NULL, principal_id TEXT NOT NULL, channel TEXT NOT NULL, conversation_id TEXT NOT NULL, work_id TEXT NOT NULL REFERENCES works(id), PRIMARY KEY(tenant_id,principal_id,channel,conversation_id,work_id));
          CREATE INDEX conversation_work_id ON conversation_work(work_id);
        `);
      }
      if (version < 3) {
        this.#db.exec(`DELETE FROM event_metadata; DELETE FROM conversation_work;
          DROP TRIGGER IF EXISTS works_query_insert; DROP TRIGGER IF EXISTS works_query_update; DROP TRIGGER IF EXISTS works_query_delete;
          DROP TRIGGER IF EXISTS events_query_insert; DROP TRIGGER IF EXISTS events_query_update; DROP TRIGGER IF EXISTS events_query_delete;`);
        const insert = this.#db.prepare('INSERT INTO event_metadata(work_id,sequence,revision,type,at) VALUES(?,?,?,?,?)');
        for (const row of this.#db.prepare('SELECT work_id,sequence,revision,body FROM events ORDER BY work_id,sequence').iterate()) {
          const event = parseContract(StoredEventSchema, jsonCell(row['body']));
          if (event.workId !== row['work_id'] || event.sequence !== row['sequence'] || event.revision !== row['revision']) throw new Error('invalid_stored_record');
          insert.run(event.workId, event.sequence, event.revision, event.type, event.at);
        }
        for (const row of this.#db.prepare('SELECT id,body FROM works').iterate()) {
          const state = parseContract(WorkStateSchema, jsonCell(row['body']));
          if (state.id !== row['id']) throw new Error('invalid_stored_record');
          this.#indexConversation(state);
        }
        const bindings = `INSERT OR IGNORE INTO conversation_work(tenant_id,principal_id,channel,conversation_id,work_id)
        SELECT DISTINCT json_extract(NEW.body,'$.policy.tenantId'),json_extract(NEW.body,'$.policy.principalId'),json_extract(b.value,'$.channel'),json_extract(b.value,'$.conversationId'),NEW.id
        FROM json_each(NEW.body,'$.conversation.bindings') b WHERE json_extract(b.value,'$.tenantId')=json_extract(NEW.body,'$.policy.tenantId')
          AND json_extract(b.value,'$.principalId')=json_extract(NEW.body,'$.policy.principalId');`;
        this.#db.exec(`
        CREATE TRIGGER IF NOT EXISTS works_query_insert AFTER INSERT ON works BEGIN ${bindings} END;
        CREATE TRIGGER IF NOT EXISTS works_query_update AFTER UPDATE ON works BEGIN DELETE FROM conversation_work WHERE work_id=OLD.id; ${bindings} END;
        CREATE TRIGGER IF NOT EXISTS works_query_delete AFTER DELETE ON works BEGIN DELETE FROM conversation_work WHERE work_id=OLD.id; END;
        CREATE TRIGGER IF NOT EXISTS events_query_insert AFTER INSERT ON events BEGIN
          INSERT INTO event_metadata(work_id,sequence,revision,type,at) VALUES(NEW.work_id,NEW.sequence,NEW.revision,json_extract(NEW.body,'$.type'),json_extract(NEW.body,'$.at')); END;
        CREATE TRIGGER IF NOT EXISTS events_query_update AFTER UPDATE ON events BEGIN
          DELETE FROM event_metadata WHERE work_id=OLD.work_id AND sequence=OLD.sequence;
          INSERT INTO event_metadata(work_id,sequence,revision,type,at) VALUES(NEW.work_id,NEW.sequence,NEW.revision,json_extract(NEW.body,'$.type'),json_extract(NEW.body,'$.at')); END;
        CREATE TRIGGER IF NOT EXISTS events_query_delete AFTER DELETE ON events BEGIN DELETE FROM event_metadata WHERE work_id=OLD.work_id AND sequence=OLD.sequence; END;
          PRAGMA user_version=3;
        `);
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      if (process.platform === 'win32') { try { this.#db.exec('ROLLBACK'); } catch {} closeSqliteAfterFailure(this.#db, error); }
      try { this.#db.exec('ROLLBACK'); } finally { this.#db.close(); } throw error;
    }
  }
  #indexConversation(state: WorkState) {
    this.#db.prepare('DELETE FROM conversation_work WHERE work_id=?').run(state.id);
    const insert = this.#db.prepare('INSERT OR IGNORE INTO conversation_work(tenant_id,principal_id,channel,conversation_id,work_id) VALUES(?,?,?,?,?)');
    for (const binding of state.conversation?.bindings ?? []) if (binding.tenantId === state.policy.tenantId && binding.principalId === state.policy.principalId) {
      insert.run(state.policy.tenantId, state.policy.principalId, binding.channel, binding.conversationId, state.id);
    }
  }
  async get(workId: string): Promise<WorkState | null> {
    const row = this.#db.prepare('SELECT body FROM works WHERE id=?').get(workId);
    return row ? parseContract(WorkStateSchema, jsonCell(row['body'])) : null;
  }
  async receipt(workId: string, commandId: string) {
    const row = this.#db.prepare('SELECT digest, body FROM receipts WHERE work_id=? AND command_id=?').get(workId, commandId);
    if (!row) return null;
    if (typeof row['digest'] !== 'string') throw new Error('invalid_stored_receipt');
    return { digest: row['digest'], state: parseContract(WorkStateSchema, jsonCell(row['body'])) };
  }
  async commit(request: CommitRequest): Promise<CommitResult> {
    request = validateCommit(request);
    const next = request.next;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const receipt = this.#db.prepare('SELECT digest, body FROM receipts WHERE work_id=? AND command_id=?').get(request.workId, request.commandId);
      if (receipt) {
        this.#db.exec('ROLLBACK');
        if (receipt['digest'] !== request.commandDigest) return { kind: 'idempotency_conflict' };
        return { kind: 'duplicate', state: parseContract(WorkStateSchema, jsonCell(receipt['body'])) };
      }
      const prior = this.#db.prepare('SELECT revision, body FROM works WHERE id=?').get(request.workId);
      const actualRevision = Number(prior?.['revision'] ?? 0);
      if (actualRevision !== request.expectedRevision) { this.#db.exec('ROLLBACK'); return { kind: 'conflict', actualRevision }; }
      validateStateTransition(prior ? parseContract(WorkStateSchema, jsonCell(prior['body'])) : null, next);
      const body = JSON.stringify(next);
      this.#db.prepare('INSERT INTO works(id,revision,status,deadline_at,body) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,status=excluded.status,deadline_at=excluded.deadline_at,body=excluded.body')
        .run(next.id, next.revision, next.status, next.deadlineAt, body);
      let sequence = Number(this.#db.prepare('SELECT COALESCE(MAX(sequence),0) AS seq FROM events WHERE work_id=?').get(next.id)?.['seq']);
      const insertEvent = this.#db.prepare('INSERT INTO events(work_id,sequence,revision,command_id,body) VALUES(?,?,?,?,?)');
      for (const event of request.events) {
        const record: StoredEvent = { ...event, workId: next.id, revision: next.revision, commandId: request.commandId, sequence: ++sequence };
        insertEvent.run(next.id, record.sequence, next.revision, request.commandId, JSON.stringify(record));
      }
      for (const delivery of request.deliveries) {
        this.#db.prepare('INSERT INTO deliveries(work_id,id,body) VALUES(?,?,?) ON CONFLICT(work_id,id) DO UPDATE SET body=excluded.body').run(next.id, delivery.id, JSON.stringify(delivery));
      }
      this.#db.prepare('INSERT INTO receipts(work_id,command_id,digest,body) VALUES(?,?,?,?)').run(next.id, request.commandId, request.commandDigest, body);
      this.#db.exec('COMMIT');
      return { kind: 'committed', state: next };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
  async events(workId: string, afterSequence: number): Promise<StoredEvent[]> {
    return this.#db.prepare('SELECT body FROM events WHERE work_id=? AND sequence>? ORDER BY sequence').all(workId, afterSequence).map(row => parseContract(StoredEventSchema, jsonCell(row['body'])));
  }
  async eventPage(workId: string, input: EventPageQuery) {
    const query = validateEventPageQuery(workId, input);
    const rows = this.#db.prepare(`SELECT e.body FROM events e JOIN event_metadata m ON m.work_id=e.work_id AND m.sequence=e.sequence
      WHERE e.work_id=? AND e.revision>? AND e.revision<=? AND (? IS NULL OR e.sequence<?) AND (? IS NULL OR m.type=?)
      ORDER BY e.sequence DESC LIMIT ?`).all(workId, query.afterRevision, query.throughRevision,
      query.beforeSequence ?? null, query.beforeSequence ?? null, query.type ?? null, query.type ?? null, query.limit + 1);
    return eventPageFromRows(rows.map(row => parseContract(StoredEventSchema, jsonCell(row['body']))), query.limit);
  }
  async recentEventMetadata(workId: string, input: RecentEventMetadataQuery): Promise<RecentEventMetadata> {
    const query = validateRecentEventQuery(workId, input);
    const total = Number(this.#db.prepare('SELECT sequence FROM event_metadata WHERE work_id=? AND revision<=? ORDER BY revision DESC,sequence DESC LIMIT 1').get(workId, query.throughRevision)?.['sequence'] ?? 0);
    const rows = this.#db.prepare('SELECT sequence,revision,type,at FROM event_metadata WHERE work_id=? AND sequence<=? ORDER BY sequence DESC LIMIT ?').all(workId, total, query.limit);
    return { items: rows.reverse().map(row => ({ sequence: Number(row['sequence']), revision: Number(row['revision']), type: String(row['type']), at: Number(row['at']) })), omittedCount: Math.max(0, total - rows.length) };
  }
  async deliveries(workId: string): Promise<Delivery[]> {
    return this.#db.prepare('SELECT body FROM deliveries WHERE work_id=? ORDER BY id').all(workId).map(row => parseContract(DeliverySchema, jsonCell(row['body'])));
  }
  async workIdsForConversation(tenantId: string, principalId: string, channel: string, conversationId: string): Promise<string[]> {
    return this.#db.prepare(`SELECT id FROM works WHERE json_extract(body,'$.policy.tenantId')=? AND json_extract(body,'$.policy.principalId')=? AND
      EXISTS (SELECT 1 FROM json_each(works.body,'$.conversation.bindings') b WHERE json_extract(b.value,'$.channel')=? AND json_extract(b.value,'$.conversationId')=?
        AND json_extract(b.value,'$.tenantId')=? AND json_extract(b.value,'$.principalId')=?) ORDER BY id`)
      .all(tenantId, principalId, channel, conversationId, tenantId, principalId).map(row => String(row['id']));
  }
  async conversationWorkPage(input: ConversationWorkQuery) {
    const query = validateConversationQuery(input); const after = decodeStateQueryCursor('sqlite-v1', query);
    const prefix = [query.tenantId, query.principalId, query.channel, query.conversationId];
    const rows = after === null ? this.#db.prepare('SELECT work_id FROM conversation_work WHERE tenant_id=? AND principal_id=? AND channel=? AND conversation_id=? ORDER BY work_id LIMIT ?').all(...prefix, query.limit + 1) :
      this.#db.prepare('SELECT work_id FROM conversation_work WHERE tenant_id=? AND principal_id=? AND channel=? AND conversation_id=? AND work_id>? ORDER BY work_id LIMIT ?').all(...prefix, after, query.limit + 1);
    const workIds = rows.slice(0, query.limit).map(row => String(row['work_id']));
    return { workIds, nextCursor: rows.length > query.limit ? encodeStateQueryCursor('sqlite-v1', query, workIds.at(-1)!) : null };
  }
  async runnable(now: number): Promise<string[]> {
    return this.#db.prepare(`SELECT DISTINCT works.id AS id FROM works WHERE status IN ('ready','running') OR
      EXISTS (SELECT 1 FROM json_each(works.body,'$.attempts') a WHERE json_extract(a.value,'$.status')='received' OR
        (json_extract(a.value,'$.status') IN ('reserved','running') AND json_extract(a.value,'$.leaseUntil')<=?)) OR
      EXISTS (SELECT 1 FROM json_each(works.body,'$.modelCalls') m WHERE json_extract(m.value,'$.status')='received' OR
        (json_extract(m.value,'$.status') IN ('reserved','running') AND (json_extract(m.value,'$.expired')=1 OR json_extract(m.value,'$.leaseUntil')<=?))) OR
      (status='waiting' AND (deadline_at<=? OR json_extract(works.body,'$.retryWakeAt')<=? OR EXISTS (SELECT 1 FROM json_each(works.body,'$.obligations') o WHERE json_extract(o.value,'$.status')='pending' AND json_extract(o.value,'$.dueAt')<=?))) ORDER BY works.id`)
      .all(now, now, now, now, now).map(row => String(row['id']));
  }
  async close(): Promise<void> { this.#db.close(); }
}
