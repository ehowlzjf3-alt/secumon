import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SessionRepository } from '../application/session-ports.js';
import { SessionHeadSchema, SessionScopeSchema } from '../application/session-contracts.js';
import { SessionSummaryRecordSchema, SessionSummaryPublicationSchema } from '../application/session-compact-contracts.js';
import { JsonSchema, PolicySchema, parseContract } from '../application/contracts.js';
import { DeliverySchema } from '../application/store-contract.js';
import type { SessionHead, SessionInbox, SessionIntake, SessionOwner, SessionRecord, SessionScope, SessionEntry } from '../domain/session.js';
import type { SessionSummaryPublication, SessionSummaryRecord } from '../domain/session-compact.js';
import type { Delivery, Json, Policy } from '../domain/model.js';
import { deliveryContent } from '../domain/conversation.js';
import { canonical, Sha256Digester, sha256 } from './digest.js';
import { postgresInteger as number, postgresJson as rowJson, type PostgresClient, type PostgresStore } from './postgres-store.js';

const id = z.string().min(1).max(256), count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), hash = z.string().regex(/^[0-9a-f]{64}$/);
const ownerSchema = z.strictObject({ tenantId: id, agentId: id, principalId: id });
const openSchema = z.strictObject({ route: id, sessionId: id.optional(), newSession: z.boolean().optional(), now: count });
const intakeSchema = z.strictObject({ scope: SessionScopeSchema, messageId: id, digest: hash, text: z.string().max(100000), payload: JsonSchema,
  kind: z.enum(['work', 'input', 'command']), workId: id, labels: z.array(id).max(10000), receivedAt: count });
const inboxSchema = intakeSchema.extend({ sequence: count.min(1), status: z.enum(['pending', 'applied', 'rejected']), rejection: id.nullable() });
const candidateSchema = SessionHeadSchema.omit({ revision: true });
const historySchema = z.strictObject({ limit: z.number().int().min(1).max(256), cursor: z.string().min(1).max(4096).optional(), afterSequence: count.optional(), throughSequence: count.optional() });
const recordSchema: z.ZodType<SessionRecord> = z.strictObject({ scope: SessionScopeSchema, createdAt: count, revision: count.min(1), lastSequence: count,
  activeWorkId: id.nullable(), activeInputSequence: count, head: SessionHeadSchema.nullable() });
const scopeWhere = 'store_id=$1 AND agent_id=$2 AND tenant_id=$3 AND principal_id=$4 AND session_id=$5';
const scopeColumns = 'store_id,agent_id,tenant_id,principal_id,session_id';
function nextCount(value: number) { if (value >= Number.MAX_SAFE_INTEGER) throw new Error('session_sequence_exhausted'); return value + 1; }
const legacyScopeArgs = (scope: SessionScope) => [scope.tenantId, scope.agentId, scope.principalId, scope.sessionId];
function sameScope(a: SessionScope, b: SessionScope) { return canonical(a as unknown as Json) === canonical(b as unknown as Json); }
function intakeIdentity(input: SessionIntake) { const { receivedAt: _at, ...identity } = input; return canonical(identity as unknown as Json); }

/** Uses one owner-bound store; channel-only helpers below accept its existing transaction and never open a nested one. */
export class PostgresSessionRepository implements SessionRepository {
  readonly #store: PostgresStore; readonly #key: readonly [string, string]; readonly #digester = new Sha256Digester();
  constructor(store: PostgresStore) {
    if (store.binding.purpose !== 'channel' || store.key[0] !== store.binding.storeId || store.key[1] !== store.binding.agentId) throw new Error('postgres_channel_binding_mismatch');
    this.#store = store; this.#key = Object.freeze([...store.key]) as readonly [string, string];
  }
  #scope(raw: SessionScope) { const scope = parseContract(SessionScopeSchema, raw); if (scope.agentId !== this.#key[1]) throw new Error('session_unavailable'); return scope; }
  #args(scope: SessionScope): unknown[] { return [...this.#key, scope.tenantId, scope.principalId, scope.sessionId]; }
  async #record(client: PostgresClient, scope: SessionScope): Promise<SessionRecord> {
    const row = (await client.query(`SELECT * FROM secumon_pg.session_records WHERE ${scopeWhere}`, this.#args(scope))).rows[0];
    if (!row) throw new Error('session_unavailable');
    const result = parseContract(recordSchema, { scope, createdAt: number(row['created_at']), revision: number(row['revision']), lastSequence: number(row['last_sequence']),
      activeWorkId: row['active_work_id'], activeInputSequence: number(row['active_input_sequence']), head: row['head_body'] === null ? null : rowJson(row['head_body']) });
    if (result.activeInputSequence > result.lastSequence || result.head && result.head.throughSequence > result.lastSequence) throw new Error('invalid_session_storage');
    return result;
  }
  async open(rawOwner: SessionOwner, rawOptions: Parameters<SessionRepository['open']>[1]) {
    const owner = parseContract(ownerSchema, rawOwner), options = parseContract(openSchema, rawOptions);
    if (owner.agentId !== this.#key[1]) throw new Error('session_unavailable');
    if (options.newSession && options.sessionId !== undefined) throw new Error('invalid_session_open');
    return this.#store.write(async client => {
      let sessionId = options.sessionId;
      if (sessionId === undefined && !options.newSession) {
        const alias = (await client.query('SELECT session_id FROM secumon_pg.session_aliases WHERE store_id=$1 AND agent_id=$2 AND tenant_id=$3 AND principal_id=$4 AND route=$5',
          [...this.#key, owner.tenantId, owner.principalId, options.route])).rows[0];
        if (alias) sessionId = parseContract(id, alias['session_id']);
      }
      if (sessionId === undefined) {
        sessionId = randomUUID();
        await client.query(`INSERT INTO secumon_pg.session_records(${scopeColumns},created_at,revision,last_sequence,active_work_id,active_input_sequence,head_body) VALUES($1,$2,$3,$4,$5,$6,1,0,NULL,0,NULL)`,
          [...this.#key, owner.tenantId, owner.principalId, sessionId, options.now]);
      }
      const record = await this.#record(client, { ...owner, sessionId });
      await client.query(`INSERT INTO secumon_pg.session_aliases(store_id,agent_id,tenant_id,principal_id,route,session_id) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(store_id,agent_id,tenant_id,principal_id,route) DO UPDATE SET session_id=excluded.session_id`, [...this.#key, owner.tenantId, owner.principalId, options.route, sessionId]);
      return record;
    });
  }
  async get(raw: SessionScope) { const scope = this.#scope(raw); return this.#store.read(client => this.#record(client, scope)); }
  async #inbox(client: PostgresClient, scope: SessionScope, messageId: string): Promise<SessionInbox | null> {
    const row = (await client.query(`SELECT sequence,status,body FROM secumon_pg.session_inbox WHERE ${scopeWhere} AND message_id=$6`, [...this.#args(scope), messageId])).rows[0];
    if (!row) return null;
    const input = parseContract(inboxSchema, rowJson(row['body']));
    if (!sameScope(input.scope, scope) || input.messageId !== messageId || input.sequence !== number(row['sequence']) || input.status !== row['status']) throw new Error('invalid_session_storage');
    return input;
  }
  async receive(raw: SessionIntake) {
    const input = parseContract(intakeSchema, raw), scope = this.#scope(input.scope);
    return this.#store.write(async client => {
      const record = await this.#record(client, scope), existing = await this.#inbox(client, scope, input.messageId);
      if (existing) {
        const { sequence: _seq, status: _status, rejection: _rejection, ...prior } = existing;
        if (existing.digest !== input.digest || intakeIdentity(prior) !== intakeIdentity(input)) throw new Error('session_input_identity_conflict');
        return { input: existing, created: false };
      }
      const sequence = nextCount(record.lastSequence), received: SessionInbox = { ...input, sequence, status: 'pending', rejection: null };
      await client.query(`INSERT INTO secumon_pg.session_inbox(${scopeColumns},message_id,sequence,status,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [...this.#args(scope), input.messageId, sequence, received.status, JSON.stringify(received)]);
      await client.query(`INSERT INTO secumon_pg.session_entries(${scopeColumns},sequence,role,work_id,user_message_id,delivery_id) VALUES($1,$2,$3,$4,$5,$6,'user',$7,$8,NULL)`,
        [...this.#args(scope), sequence, input.workId, input.messageId]);
      await client.query(`UPDATE secumon_pg.session_records SET last_sequence=$6,revision=$7 WHERE ${scopeWhere}`, [...this.#args(scope), sequence, nextCount(record.revision)]);
      return { input: received, created: true };
    });
  }
  async input(raw: SessionScope, messageId: string) {
    const scope = this.#scope(raw); parseContract(id, messageId);
    return this.#store.read(async client => { await this.#record(client, scope); return this.#inbox(client, scope, messageId); });
  }
  async pending(raw: SessionScope, limit: number) {
    const scope = this.#scope(raw); parseContract(z.number().int().min(1).max(256), limit);
    return this.#store.read(async client => {
      await this.#record(client, scope);
      const rows = (await client.query(`SELECT message_id FROM secumon_pg.session_inbox WHERE ${scopeWhere} AND status='pending' ORDER BY sequence LIMIT $6`, [...this.#args(scope), limit])).rows;
      const inputs: SessionInbox[] = []; for (const row of rows) { const input = await this.#inbox(client, scope, parseContract(id, row['message_id'])); if (!input) throw new Error('invalid_session_storage'); inputs.push(input); } return inputs;
    });
  }
  async settle(raw: SessionScope, messageId: string, digest: string, rawResult: Parameters<SessionRepository['settle']>[3]) {
    const scope = this.#scope(raw); parseContract(id, messageId); parseContract(hash, digest);
    const result = parseContract(z.discriminatedUnion('status', [z.strictObject({ status: z.literal('applied') }), z.strictObject({ status: z.literal('rejected'), reason: id })]), rawResult);
    return this.#store.write(async client => {
      const record = await this.#record(client, scope), input = await this.#inbox(client, scope, messageId);
      if (!input) throw new Error('session_input_unavailable'); if (input.digest !== digest) throw new Error('session_input_identity_conflict');
      const rejection = result.status === 'rejected' ? result.reason : null;
      if (input.status !== 'pending') { if (input.status !== result.status || input.rejection !== rejection) throw new Error('session_input_settlement_conflict'); return input; }
      const settled = { ...input, status: result.status, rejection };
      await client.query(`UPDATE secumon_pg.session_inbox SET status=$6,body=$7 WHERE ${scopeWhere} AND message_id=$8`, [...this.#args(scope), result.status, JSON.stringify(settled), messageId]);
      const latest = result.status === 'applied' && input.sequence > record.activeInputSequence;
      await client.query(`UPDATE secumon_pg.session_records SET revision=$6,active_work_id=$7,active_input_sequence=$8 WHERE ${scopeWhere}`,
        [...this.#args(scope), nextCount(record.revision), latest ? input.workId : record.activeWorkId, latest ? input.sequence : record.activeInputSequence]);
      return settled;
    });
  }
  async #head(client: PostgresClient, scope: SessionScope, candidate: Omit<SessionHead, 'revision'>): Promise<SessionHead | null> {
    const row = (await client.query(`SELECT revision FROM secumon_pg.session_heads WHERE ${scopeWhere} AND through_sequence=$6 AND digest=$7 AND policy_digest=$8`,
      [...this.#args(scope), candidate.throughSequence, candidate.digest, candidate.policyDigest])).rows[0];
    return row ? parseContract(SessionHeadSchema, { ...candidate, revision: number(row['revision']) }) : null;
  }
  async head(raw: SessionScope, rawCandidate: Omit<SessionHead, 'revision'>) {
    const scope = this.#scope(raw), candidate = parseContract(candidateSchema, rawCandidate);
    return this.#store.read(async client => { await this.#record(client, scope); return this.#head(client, scope, candidate); });
  }
  async #insertHead(client: PostgresClient, scope: SessionScope, candidate: Omit<SessionHead, 'revision'>): Promise<SessionHead> {
    const row = (await client.query(`SELECT COALESCE(MAX(revision),0) AS revision FROM secumon_pg.session_heads WHERE ${scopeWhere}`, this.#args(scope))).rows[0];
    const head = { ...candidate, revision: nextCount(number(row?.['revision'])) };
    await client.query(`INSERT INTO secumon_pg.session_heads(${scopeColumns},revision,through_sequence,digest,policy_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [...this.#args(scope), head.revision, head.throughSequence, head.digest, head.policyDigest]); return head;
  }
  async retainHead(raw: SessionScope, rawCandidate: Omit<SessionHead, 'revision'>) {
    const scope = this.#scope(raw), candidate = parseContract(candidateSchema, rawCandidate);
    return this.#store.write(async client => {
      const record = await this.#record(client, scope), known = await this.#head(client, scope, candidate); if (known) return known;
      if (!record.head || candidate.throughSequence >= record.head.throughSequence || candidate.throughSequence > record.lastSequence) throw new Error('invalid_session_head');
      return this.#insertHead(client, scope, candidate);
    });
  }
  async publishHead(raw: SessionScope, expectedRevision: number, rawCandidate: Omit<SessionHead, 'revision'>) {
    const scope = this.#scope(raw), candidate = parseContract(candidateSchema, rawCandidate); parseContract(count, expectedRevision);
    return this.#store.write(async client => {
      const record = await this.#record(client, scope), actual = record.head?.revision ?? 0;
      if (actual !== expectedRevision || candidate.throughSequence < (record.head?.throughSequence ?? 0)) return null;
      if (candidate.throughSequence > record.lastSequence) throw new Error('invalid_session_head');
      const known = await this.#head(client, scope, candidate); if (known) return known;
      const head = await this.#insertHead(client, scope, candidate);
      await client.query(`UPDATE secumon_pg.session_records SET revision=$6,head_body=$7 WHERE ${scopeWhere}`, [...this.#args(scope), nextCount(record.revision), JSON.stringify(head)]); return head;
    });
  }
  async #summary(client: PostgresClient, scope: SessionScope, summaryId: string): Promise<SessionSummaryRecord | null> {
    const row = (await client.query(`SELECT * FROM secumon_pg.session_summaries WHERE ${scopeWhere} AND summary_id=$6`, [...this.#args(scope), summaryId])).rows[0];
    if (!row) return null;
    const record = parseContract(SessionSummaryRecordSchema, rowJson(row['body']));
    if (!sameScope(record.scope, scope) || record.ref.id !== summaryId || record.ref.revision !== number(row['revision']) ||
      record.ref.throughSequence !== number(row['through_sequence']) || record.ref.policyDigest !== row['policy_digest'] ||
      record.prefix.throughSequence !== record.ref.throughSequence || record.prefix.entries > record.prefix.throughSequence ||
      record.previous && record.previous.throughSequence >= record.ref.throughSequence) throw new Error('invalid_session_compact_storage');
    return record;
  }
  async #summaryHead(client: PostgresClient, scope: SessionScope): Promise<SessionSummaryRecord | null> {
    const row = (await client.query(`SELECT summary_id FROM secumon_pg.session_summary_heads WHERE ${scopeWhere}`, this.#args(scope))).rows[0];
    if (!row) return null;
    const record = await this.#summary(client, scope, parseContract(id, row['summary_id']));
    if (!record) throw new Error('invalid_session_compact_storage'); return record;
  }
  async summaryHead(raw: SessionScope) {
    const scope = this.#scope(raw); return this.#store.read(async client => { await this.#record(client, scope); return this.#summaryHead(client, scope); });
  }
  async summary(raw: SessionScope, summaryId: string) {
    const scope = this.#scope(raw); parseContract(id, summaryId);
    return this.#store.read(async client => { await this.#record(client, scope); return this.#summary(client, scope, summaryId); });
  }
  async summaryBefore(raw: SessionScope, throughSequence: number, policyDigest: string, rawBefore?: { throughSequence: number; revision: number }) {
    const scope = this.#scope(raw); parseContract(count, throughSequence); parseContract(hash, policyDigest);
    const before = rawBefore === undefined ? undefined : parseContract(z.strictObject({ throughSequence: count.min(1), revision: count.min(1) }), rawBefore);
    return this.#store.read(async client => {
      const session = await this.#record(client, scope);
      if (throughSequence > session.lastSequence || before && before.throughSequence >= throughSequence) throw new Error('invalid_session_query');
      const row = (await client.query(`SELECT summary_id FROM secumon_pg.session_summaries WHERE ${scopeWhere} AND through_sequence<$6 AND policy_digest=$7
        ${before ? 'AND (through_sequence<$8 OR (through_sequence=$8 AND revision<$9))' : ''} ORDER BY through_sequence DESC,revision DESC LIMIT 1`,
        [...this.#args(scope), throughSequence, policyDigest, ...(before ? [before.throughSequence, before.revision] : [])])).rows[0];
      return row ? this.#summary(client, scope, parseContract(id, row['summary_id'])) : null;
    });
  }
  async #publication(client: PostgresClient, scope: SessionScope, callId: string): Promise<{ requestDigest: string; record: SessionSummaryRecord } | null> {
    const row = (await client.query(`SELECT request_digest,summary_id FROM secumon_pg.session_summary_publications WHERE ${scopeWhere} AND call_id=$6`, [...this.#args(scope), callId])).rows[0];
    if (!row) return null;
    const record = await this.#summary(client, scope, parseContract(id, row['summary_id']));
    if (!record || record.callId !== callId) throw new Error('invalid_session_compact_storage');
    return { requestDigest: parseContract(hash, row['request_digest']), record };
  }
  async publication(raw: SessionScope, callId: string) {
    const scope = this.#scope(raw); parseContract(id, callId);
    return this.#store.read(async client => { await this.#record(client, scope); return (await this.#publication(client, scope, callId))?.record ?? null; });
  }
  async publishSummary(raw: SessionScope, expectedRevision: number, rawCandidate: SessionSummaryPublication) {
    const scope = this.#scope(raw); parseContract(count, expectedRevision); const candidate = parseContract(SessionSummaryPublicationSchema, rawCandidate);
    if (!sameScope(scope, candidate.scope)) throw new Error('session_summary_scope_mismatch');
    if (candidate.ref.throughSequence !== candidate.prefix.throughSequence || candidate.prefix.entries > candidate.prefix.throughSequence ||
      candidate.previous && candidate.previous.throughSequence >= candidate.ref.throughSequence || candidate.content.retained.some(item =>
        item.citations.some(quote => quote.sequence > candidate.ref.throughSequence) || item.changedBy && item.changedBy.sequence > candidate.ref.throughSequence)) throw new Error('invalid_session_summary');
    const { createdAt: _createdAt, ...content } = candidate;
    const requestDigest = this.#digester.digest({ expectedRevision, candidate: content } as unknown as Json);
    return this.#store.write(async client => {
      const session = await this.#record(client, scope), prior = await this.#publication(client, scope, candidate.callId);
      if (prior) { if (prior.requestDigest !== requestDigest) throw new Error('session_summary_publication_conflict'); return prior.record; }
      if (await this.#summary(client, scope, candidate.ref.id)) throw new Error('session_summary_identity_conflict');
      if (candidate.ref.throughSequence > session.lastSequence) throw new Error('invalid_session_summary');
      const current = await this.#summaryHead(client, scope); if ((current?.ref.revision ?? 0) !== expectedRevision) return null;
      if (candidate.previous) {
        const previous = await this.#summary(client, scope, candidate.previous.id);
        if (!previous || canonical(previous.ref as unknown as Json) !== canonical(candidate.previous as unknown as Json)) throw new Error('session_summary_previous_unavailable');
      }
      const row = (await client.query(`SELECT COALESCE(MAX(revision),0) AS revision FROM secumon_pg.session_summaries WHERE ${scopeWhere}`, this.#args(scope))).rows[0];
      const record: SessionSummaryRecord = { ...candidate, ref: { ...candidate.ref, revision: nextCount(number(row?.['revision'])) } };
      await client.query(`INSERT INTO secumon_pg.session_summaries(${scopeColumns},summary_id,revision,through_sequence,policy_digest,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [...this.#args(scope), record.ref.id, record.ref.revision, record.ref.throughSequence, record.ref.policyDigest, JSON.stringify(record)]);
      if (record.ref.throughSequence >= (current?.ref.throughSequence ?? 0)) {
        await client.query(`INSERT INTO secumon_pg.session_summary_heads(${scopeColumns},summary_id) VALUES($1,$2,$3,$4,$5,$6)
          ON CONFLICT(${scopeColumns}) DO UPDATE SET summary_id=excluded.summary_id`, [...this.#args(scope), record.ref.id]);
      }
      await client.query(`INSERT INTO secumon_pg.session_summary_publications(${scopeColumns},call_id,request_digest,summary_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [...this.#args(scope), record.callId, requestDigest, record.ref.id]); return record;
    });
  }
  async #deliveryScope(client: PostgresClient, delivery: Delivery) {
    const binding = delivery.context?.binding; if (!binding?.session) throw new Error('session_delivery_missing');
    const scope = this.#scope(binding.session);
    if (binding.tenantId !== scope.tenantId || binding.principalId !== scope.principalId || binding.recipientId !== scope.principalId ||
      delivery.destination !== binding.destination || delivery.context?.artifact && delivery.context.artifact.tenantId !== scope.tenantId) throw new Error('session_delivery_mismatch');
    await this.#record(client, scope); return scope;
  }
  /** Infrastructure transaction bridge; only PostgresChannel calls this inside the same store.write as its message insert. */
  async recordLocalDelivery(client: PostgresClient, delivery: Delivery): Promise<void> {
    const scope = await this.#deliveryScope(client, delivery), record = await this.#record(client, scope);
    if (await this.hasLocalDelivery(client, delivery)) return;
    const source = (await client.query('SELECT body,digest,external_id FROM secumon_pg.local_messages WHERE store_id=$1 AND agent_id=$2 AND work_id=$3 AND delivery_id=$4',
      [...this.#key, delivery.workId, delivery.id])).rows[0];
    if (!source) throw new Error('session_delivery_missing'); await this.#storedDelivery(client, source, scope, delivery.workId, delivery.id);
    const sequence = nextCount(record.lastSequence);
    await client.query(`INSERT INTO secumon_pg.session_entries(${scopeColumns},sequence,role,work_id,user_message_id,delivery_id) VALUES($1,$2,$3,$4,$5,$6,'assistant',$7,NULL,$8)`,
      [...this.#args(scope), sequence, delivery.workId, delivery.id]);
    await client.query(`UPDATE secumon_pg.session_records SET last_sequence=$6,revision=$7 WHERE ${scopeWhere}`, [...this.#args(scope), sequence, nextCount(record.revision)]);
  }
  /** Read helper for a caller-owned transaction; it performs no transaction or schema management. */
  async hasLocalDelivery(client: PostgresClient, delivery: Delivery): Promise<boolean> {
    const scope = await this.#deliveryScope(client, delivery);
    return (await client.query(`SELECT 1 FROM secumon_pg.session_entries WHERE ${scopeWhere} AND role='assistant' AND work_id=$6 AND delivery_id=$7`,
      [...this.#args(scope), delivery.workId, delivery.id])).rows.length !== 0;
  }
  async #storedDelivery(client: PostgresClient, row: Record<string, unknown>, scope: SessionScope, workId: string, deliveryId: string): Promise<Delivery> {
    const delivery = parseContract(DeliverySchema, rowJson(row['body']));
    if (delivery.workId !== workId || delivery.id !== deliveryId || delivery.status !== 'delivered' || delivery.externalId !== row['external_id'] ||
      !delivery.context?.binding.session || !sameScope(delivery.context.binding.session, scope) || this.#digester.digest(deliveryContent(delivery)) !== row['digest']) throw new Error('invalid_session_storage');
    await this.#deliveryScope(client, delivery); return delivery;
  }
  async history(raw: SessionScope, rawPolicy: Policy, rawOptions: Parameters<SessionRepository['history']>[2]) {
    const scope = this.#scope(raw), policy = parseContract(PolicySchema, rawPolicy), options = parseContract(historySchema, rawOptions);
    if (policy.tenantId !== scope.tenantId || policy.principalId !== scope.principalId) throw new Error('session_unavailable');
    return this.#store.read(async client => {
      const record = await this.#record(client, scope), policyDigest = this.#digester.digest(policy as unknown as Json);
      // Store binding is also part of the cursor: a cursor cannot cross two stores containing the same session IDs.
      const identity = `${sha256(JSON.stringify([...this.#key, ...legacyScopeArgs(scope)]))}:${policyDigest}:`, prefix = `pg-session-v1:${identity}`;
      let lower = options.afterSequence ?? 0, after = lower, through = options.throughSequence ?? record.lastSequence;
      if (options.cursor !== undefined) {
        try {
          if (!options.cursor.startsWith(prefix)) throw new Error();
          const encoded = options.cursor.slice(prefix.length), bytes = Buffer.from(encoded, 'base64url');
          if (bytes.toString('base64url') !== encoded) throw new Error();
          const value = parseContract(z.strictObject({ lower: count, after: count.min(1), through: count }), rowJson(bytes.toString('utf8')));
          if (value.after <= value.lower || value.after > value.through || options.afterSequence !== undefined && options.afterSequence !== value.lower ||
            options.throughSequence !== undefined && options.throughSequence !== value.through) throw new Error();
          lower = value.lower; after = value.after; through = value.through;
        } catch { throw new Error('invalid_session_cursor'); }
      }
      if (lower > through || through > record.lastSequence) throw new Error('invalid_session_query');
      const rows = (await client.query(`SELECT e.sequence,e.role,e.work_id,e.user_message_id,e.delivery_id,
          i.body AS input_body,m.body AS delivery_body,m.digest AS delivery_digest,m.external_id
        FROM secumon_pg.session_entries e
        LEFT JOIN secumon_pg.session_inbox i ON e.store_id=i.store_id AND e.agent_id=i.agent_id AND e.tenant_id=i.tenant_id AND e.principal_id=i.principal_id AND e.session_id=i.session_id AND e.user_message_id=i.message_id
        LEFT JOIN secumon_pg.local_messages m ON e.store_id=m.store_id AND e.agent_id=m.agent_id AND e.work_id=m.work_id AND e.delivery_id=m.delivery_id
        WHERE e.store_id=$1 AND e.agent_id=$2 AND e.tenant_id=$3 AND e.principal_id=$4 AND e.session_id=$5 AND e.sequence>$6 AND e.sequence<=$7
          AND ((e.role='user' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(i.body::jsonb->'labels') l(value) WHERE l.value NOT IN(SELECT value FROM jsonb_array_elements_text($8::jsonb))))
            OR (e.role='assistant' AND m.body::jsonb->>'destination' IN(SELECT value FROM jsonb_array_elements_text($9::jsonb))
              AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(m.body::jsonb#>'{context,labels}') l(value) WHERE l.value NOT IN(SELECT value FROM jsonb_array_elements_text($8::jsonb)))
              AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(m.body::jsonb#>'{context,artifact,labels}') l(value) WHERE l.value NOT IN(SELECT value FROM jsonb_array_elements_text($8::jsonb)))))
        ORDER BY e.sequence LIMIT $10`, [...this.#args(scope), after, through, JSON.stringify(policy.allowedLabels), JSON.stringify(policy.allowedDestinations), options.limit + 1])).rows;
      const entries: SessionEntry[] = [];
      for (const row of rows.slice(0, options.limit)) {
        const sequence = number(row['sequence']), workId = parseContract(id, row['work_id']); if (sequence < 1) throw new Error('invalid_session_storage');
        if (row['role'] === 'user') {
          const input = parseContract(inboxSchema, rowJson(row['input_body']));
          if (!sameScope(scope, input.scope) || input.sequence !== sequence || input.workId !== workId || input.messageId !== row['user_message_id']) throw new Error('invalid_session_storage');
          entries.push({ sequence, role: 'user', sourceId: input.messageId, workId, text: input.text, labels: input.labels, artifact: null, status: 'received', kind: input.kind });
        } else {
          const deliveryId = parseContract(id, row['delivery_id']);
          const delivery = await this.#storedDelivery(client, { body: row['delivery_body'], digest: row['delivery_digest'], external_id: row['external_id'] }, scope, workId, deliveryId);
          entries.push({ sequence, role: 'assistant', sourceId: deliveryId, workId, text: delivery.text, labels: delivery.context!.labels, artifact: delivery.context!.artifact, status: 'delivered', kind: delivery.kind });
        }
      }
      const nextCursor = rows.length > options.limit ? prefix + Buffer.from(JSON.stringify({ lower, after: entries.at(-1)!.sequence, through })).toString('base64url') : null;
      return { entries, nextCursor };
    });
  }
}
