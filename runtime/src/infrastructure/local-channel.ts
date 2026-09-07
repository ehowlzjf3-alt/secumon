import type { DatabaseSync } from 'node:sqlite';
import { openHostSqliteDatabase, closeSqliteAfterFailure } from './windows-sqlite.js';
import { deliveryContent } from '../domain/conversation.js';
import type { Delivery } from '../domain/model.js';
import type { MessageSink } from '../application/ports.js';
import type { SessionRepository } from '../application/session-ports.js';
import type { WorkActor } from '../application/work-resources.js';
import { parseContract } from '../application/contracts.js';
import { DeliverySchema } from '../application/store-contract.js';
import { Sha256Digester } from './digest.js';
import { SqliteSessionRepository } from './sqlite-sessions.js';

export class LocalChannel implements MessageSink {
  readonly capabilities = { idempotentSend: true };
  readonly sessions?: SessionRepository;
  #db: DatabaseSync;
  #digester = new Sha256Digester();
  #sessions: SqliteSessionRepository | undefined;
  constructor(path: string, agentId?: string) {
    this.#db = openHostSqliteDatabase(path);
    try {
      this.#db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.#db.exec('CREATE TABLE IF NOT EXISTS local_messages (work_id TEXT NOT NULL, delivery_id TEXT NOT NULL, digest TEXT NOT NULL, external_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(work_id,delivery_id));');
      if (agentId !== undefined) this.sessions = this.#sessions = new SqliteSessionRepository(this.#db, agentId);
    } catch (error) { if (process.platform === 'win32') closeSqliteAfterFailure(this.#db, error); this.#db.close(); throw error; }
  }
  async send(value: Delivery) {
    const d = parseContract(DeliverySchema, value);
    if (!d.context || d.destination !== 'local' || !['cli', 'web', 'test', 'peer'].includes(d.context.binding.channel)) return { status: 'unknown' as const };
    return this.recordConfirmedDelivery(d, `local-${this.#digester.digest({ workId: d.workId, deliveryId: d.id })}`);
  }
  /** Called by a trusted channel adapter only after local insertion or confirmed external delivery. */
  async recordConfirmedDelivery(value: Delivery, externalId: string) {
    const d = parseContract(DeliverySchema, value);
    if (!d.context || d.destination !== d.context.binding.destination || !externalId || externalId.length > 256) return { status: 'unknown' as const };
    if (d.context.binding.session && !this.#sessions) return { status: 'unknown' as const };
    const digest = this.#digester.digest(deliveryContent(d));
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare('INSERT INTO local_messages(work_id,delivery_id,digest,external_id,body) VALUES(?,?,?,?,?) ON CONFLICT(work_id,delivery_id) DO NOTHING')
        .run(d.workId, d.id, digest, externalId, JSON.stringify({ ...d, status: 'delivered', externalId }));
      const row = this.#db.prepare('SELECT digest,external_id FROM local_messages WHERE work_id=? AND delivery_id=?').get(d.workId, d.id);
      if (row?.['digest'] !== digest) { this.#db.exec('ROLLBACK'); return { status: 'unknown' as const }; }
      if (d.context.binding.session) this.#sessions!.recordLocalDelivery(d);
      this.#db.exec('COMMIT');
      return { status: 'delivered' as const, externalId: String(row['external_id']) };
    } catch (error) { try { this.#db.exec('ROLLBACK'); } catch {} throw error; }
  }
  async lookup(delivery: Delivery) {
    const row = this.#db.prepare('SELECT digest, external_id FROM local_messages WHERE work_id=? AND delivery_id=?').get(delivery.workId, delivery.id);
    if (!row) return { status: 'absent' as const };
    if (row['digest'] !== this.#digester.digest(deliveryContent(delivery))) return { status: 'unknown' as const };
    if (delivery.context?.binding.session && (!this.#sessions || !this.#sessions.hasLocalDelivery(delivery))) return { status: 'unknown' as const };
    return { status: 'delivered' as const, externalId: String(row['external_id']) };
  }
  async messages(actor: WorkActor, channel: string, conversationId: string) {
    return this.#db.prepare(`SELECT body FROM local_messages WHERE json_extract(body,'$.context.binding.tenantId')=? AND json_extract(body,'$.context.binding.principalId')=? AND
      json_extract(body,'$.context.binding.channel')=? AND json_extract(body,'$.context.binding.conversationId')=? ORDER BY rowid`)
      .all(actor.tenantId, actor.principalId, channel, conversationId).map(row => parseContract(DeliverySchema, JSON.parse(String(row['body']))))
      .filter(d => (actor.allowedDestinations === undefined || actor.allowedDestinations.includes(d.destination)) && d.context!.labels.every(l => actor.allowedLabels === undefined || actor.allowedLabels.includes(l)))
      .map(d => ({ id: d.id, workId: d.workId, goalRevision: d.goalRevision, kind: d.kind, text: d.text }));
  }
  close() { this.#db.close(); }
}
