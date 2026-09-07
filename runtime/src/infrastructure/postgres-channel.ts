import { deliveryContent } from '../domain/conversation.js';
import type { Delivery } from '../domain/model.js';
import type { MessageSink } from '../application/ports.js';
import type { SessionRepository } from '../application/session-ports.js';
import type { WorkActor } from '../application/work-resources.js';
import { parseContract } from '../application/contracts.js';
import { DeliverySchema } from '../application/store-contract.js';
import { Sha256Digester } from './digest.js';
import { PostgresSessionRepository } from './postgres-sessions.js';
import type { PostgresStore } from './postgres-store.js';
export { POSTGRES_CHANNEL_SCHEMA } from './postgres-channel-schema.js';

class DeliveryConflict extends Error {}
/** Delivery custody and the assistant's session original are committed in the same owner-bound transaction. */
export class PostgresChannel implements MessageSink {
  readonly capabilities = Object.freeze({ idempotentSend: true });
  readonly sessions: SessionRepository;
  readonly #sessions: PostgresSessionRepository; readonly #store: PostgresStore; readonly #key: readonly [string, string];
  readonly #digester = new Sha256Digester(); #closing: Promise<void> | undefined;
  constructor(store: PostgresStore) {
    this.#sessions = new PostgresSessionRepository(store); this.sessions = this.#sessions;
    this.#store = store; this.#key = Object.freeze([...store.key]) as readonly [string, string];
  }
  async send(value: Delivery) {
    const delivery = parseContract(DeliverySchema, value);
    if (!delivery.context || delivery.destination !== 'local' || !['cli', 'web', 'test', 'peer'].includes(delivery.context.binding.channel)) return { status: 'unknown' as const };
    return this.recordConfirmedDelivery(delivery, `local-${this.#digester.digest({ workId: delivery.workId, deliveryId: delivery.id })}`);
  }
  /** Trusted channel adapters call this only after local insertion or confirmed external delivery. */
  async recordConfirmedDelivery(value: Delivery, externalId: string) {
    const delivery = parseContract(DeliverySchema, value);
    if (!delivery.context || delivery.destination !== delivery.context.binding.destination || !externalId || externalId.length > 256) return { status: 'unknown' as const };
    const digest = this.#digester.digest(deliveryContent(delivery));
    try {
      return await this.#store.write(async client => {
        await client.query(`INSERT INTO secumon_pg.local_messages(store_id,agent_id,work_id,delivery_id,digest,external_id,body) VALUES($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT(store_id,agent_id,work_id,delivery_id) DO NOTHING`, [...this.#key, delivery.workId, delivery.id, digest, externalId, JSON.stringify({ ...delivery, status: 'delivered', externalId })]);
        const row = (await client.query('SELECT digest,external_id FROM secumon_pg.local_messages WHERE store_id=$1 AND agent_id=$2 AND work_id=$3 AND delivery_id=$4', [...this.#key, delivery.workId, delivery.id])).rows[0];
        if (row?.['digest'] !== digest || typeof row['external_id'] !== 'string') throw new DeliveryConflict('delivery_identity_conflict');
        if (delivery.context!.binding.session) await this.#sessions.recordLocalDelivery(client, delivery);
        return { status: 'delivered' as const, externalId: row['external_id'] };
      });
    } catch (error) { if (error instanceof DeliveryConflict) return { status: 'unknown' as const }; throw error; }
  }
  async lookup(value: Delivery) {
    const delivery = parseContract(DeliverySchema, value);
    return this.#store.read(async client => {
      const row = (await client.query('SELECT digest,external_id FROM secumon_pg.local_messages WHERE store_id=$1 AND agent_id=$2 AND work_id=$3 AND delivery_id=$4', [...this.#key, delivery.workId, delivery.id])).rows[0];
      if (!row) return { status: 'absent' as const };
      if (row['digest'] !== this.#digester.digest(deliveryContent(delivery)) || typeof row['external_id'] !== 'string') return { status: 'unknown' as const };
      if (delivery.context?.binding.session && !(await this.#sessions.hasLocalDelivery(client, delivery))) return { status: 'unknown' as const };
      return { status: 'delivered' as const, externalId: row['external_id'] };
    });
  }
  async messages(actor: WorkActor, channel: string, conversationId: string) {
    return this.#store.read(async client => {
      const rows = (await client.query(`SELECT body FROM secumon_pg.local_messages WHERE store_id=$1 AND agent_id=$2
        AND body::jsonb#>>'{context,binding,tenantId}'=$3 AND body::jsonb#>>'{context,binding,principalId}'=$4
        AND body::jsonb#>>'{context,binding,channel}'=$5 AND body::jsonb#>>'{context,binding,conversationId}'=$6 ORDER BY sequence`,
        [...this.#key, actor.tenantId, actor.principalId, channel, conversationId])).rows;
      return rows.map(row => { if (typeof row['body'] !== 'string') throw new Error('invalid_channel_storage'); return parseContract(DeliverySchema, JSON.parse(row['body'])); })
        .filter(delivery => (actor.allowedDestinations === undefined || actor.allowedDestinations.includes(delivery.destination)) &&
          delivery.context!.labels.every(label => actor.allowedLabels === undefined || actor.allowedLabels.includes(label)))
        .map(delivery => ({ id: delivery.id, workId: delivery.workId, goalRevision: delivery.goalRevision, kind: delivery.kind, text: delivery.text }));
    });
  }
  close(): Promise<void> { return this.#closing ??= this.#store.close(); }
}
