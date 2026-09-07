import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SessionRepository } from '../application/session-ports.js';
import { AgentProfileError } from '../application/agent-profile-contracts.js';
import { SessionHeadSchema, SessionScopeSchema } from '../application/session-contracts.js';
import { SessionSummaryRecordSchema, SessionSummaryPublicationSchema } from '../application/session-compact-contracts.js';
import { JsonSchema, PolicySchema, parseContract } from '../application/contracts.js';
import { DeliverySchema } from '../application/store-contract.js';
import type { SessionHead, SessionInbox, SessionIntake, SessionOwner, SessionRecord, SessionScope, SessionEntry } from '../domain/session.js';
import type { SessionSummaryPublication, SessionSummaryRecord } from '../domain/session-compact.js';
import type { Delivery, Json, Policy } from '../domain/model.js';
import { deliveryContent } from '../domain/conversation.js';
import { canonical, Sha256Digester, sha256 } from './digest.js';

const id = z.string().min(1).max(256);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const ownerSchema = z.strictObject({ tenantId: id, agentId: id, principalId: id });
const openSchema = z.strictObject({ route: id, sessionId: id.optional(), newSession: z.boolean().optional(), now: count });
const intakeSchema = z.strictObject({ scope: SessionScopeSchema, messageId: id, digest: hash, text: z.string().max(100000), payload: JsonSchema,
  kind: z.enum(['work', 'input', 'command']), workId: id, labels: z.array(id).max(10000), receivedAt: count });
const inboxSchema = intakeSchema.extend({ sequence: count.min(1), status: z.enum(['pending', 'applied', 'rejected']), rejection: id.nullable() });
const candidateSchema = SessionHeadSchema.omit({ revision: true });
const historySchema = z.strictObject({ limit: z.number().int().min(1).max(256), cursor: z.string().min(1).max(4096).optional(), afterSequence: count.optional(), throughSequence: count.optional() });
const recordSchema: z.ZodType<SessionRecord> = z.strictObject({ scope: SessionScopeSchema, createdAt: count, revision: count.min(1), lastSequence: count,
  activeWorkId: id.nullable(), activeInputSequence: count, head: SessionHeadSchema.nullable() });
const scopeWhere = 'tenant_id=? AND agent_id=? AND principal_id=? AND session_id=?';
const scopeColumns = 'tenant_id,agent_id,principal_id,session_id';
const scopeArgs = (scope: SessionScope) => [scope.tenantId, scope.agentId, scope.principalId, scope.sessionId] as const;
const rowJson = (value: unknown): unknown => { if (typeof value !== 'string') throw new Error('invalid_session_storage'); return JSON.parse(value); };
function nextCount(value: number) { if (value >= Number.MAX_SAFE_INTEGER) throw new Error('session_sequence_exhausted'); return value + 1; }
function sameScope(a: SessionScope, b: SessionScope) { return scopeArgs(a).every((value, index) => value === scopeArgs(b)[index]); }
function intakeIdentity(input: SessionIntake) { const { receivedAt: _at, ...identity } = input; return canonical(identity as unknown as Json); }

/** Shares its connection and transaction with LocalChannel; it never owns/closes that connection. */
export class SqliteSessionRepository implements SessionRepository {
  readonly #db: DatabaseSync;
  readonly #agentId: string;
  readonly #digester = new Sha256Digester();
  constructor(db: DatabaseSync, agentId: string) {
    this.#db = db; this.#agentId = parseContract(id, agentId);
    this.#db.exec('PRAGMA foreign_keys=ON;');
    this.#transaction(() => {
      this.#db.exec(`CREATE TABLE IF NOT EXISTS session_schema (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL);
        INSERT OR IGNORE INTO session_schema(singleton,version) VALUES(1,1);`);
      if (this.#db.prepare('SELECT version FROM session_schema WHERE singleton=1').get()?.['version'] !== 1) throw new Error('unsupported_session_schema');
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS session_records (
          tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, principal_id TEXT NOT NULL, session_id TEXT NOT NULL,
          created_at INTEGER NOT NULL, revision INTEGER NOT NULL, last_sequence INTEGER NOT NULL,
          active_work_id TEXT, active_input_sequence INTEGER NOT NULL, head_body TEXT,
          PRIMARY KEY(${scopeColumns}));
        CREATE TABLE IF NOT EXISTS session_aliases (
          tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, principal_id TEXT NOT NULL, route TEXT NOT NULL, session_id TEXT NOT NULL,
          PRIMARY KEY(tenant_id,agent_id,principal_id,route),
          FOREIGN KEY(${scopeColumns}) REFERENCES session_records(${scopeColumns}));
        CREATE TABLE IF NOT EXISTS session_inbox (
          tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, principal_id TEXT NOT NULL, session_id TEXT NOT NULL,
          message_id TEXT NOT NULL, sequence INTEGER NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL,
          PRIMARY KEY(${scopeColumns},message_id), UNIQUE(${scopeColumns},sequence),
          FOREIGN KEY(${scopeColumns}) REFERENCES session_records(${scopeColumns}));
        CREATE INDEX IF NOT EXISTS session_pending ON session_inbox(${scopeColumns},status,sequence);
        CREATE TABLE IF NOT EXISTS session_entries (
          tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, principal_id TEXT NOT NULL, session_id TEXT NOT NULL,
          sequence INTEGER NOT NULL, role TEXT NOT NULL, work_id TEXT NOT NULL, user_message_id TEXT, delivery_id TEXT,
          PRIMARY KEY(${scopeColumns},sequence), UNIQUE(${scopeColumns},user_message_id), UNIQUE(${scopeColumns},work_id,delivery_id),
          CHECK((role='user' AND user_message_id IS NOT NULL AND delivery_id IS NULL) OR (role='assistant' AND delivery_id IS NOT NULL AND user_message_id IS NULL)),
          FOREIGN KEY(${scopeColumns}) REFERENCES session_records(${scopeColumns}),
          FOREIGN KEY(${scopeColumns},user_message_id) REFERENCES session_inbox(${scopeColumns},message_id),
          FOREIGN KEY(work_id,delivery_id) REFERENCES local_messages(work_id,delivery_id));
        CREATE TABLE IF NOT EXISTS session_heads (
          tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, principal_id TEXT NOT NULL, session_id TEXT NOT NULL,
          revision INTEGER NOT NULL, through_sequence INTEGER NOT NULL, digest TEXT NOT NULL, policy_digest TEXT NOT NULL,
          PRIMARY KEY(${scopeColumns},revision), UNIQUE(${scopeColumns},through_sequence,digest,policy_digest),
          FOREIGN KEY(${scopeColumns}) REFERENCES session_records(${scopeColumns}));
      `);
    });
  }
  #transaction<T>(operation: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.#db.exec('COMMIT'); return result; }
    catch (error) { try { this.#db.exec('ROLLBACK'); } catch {} throw error; }
  }
  #scope(raw: SessionScope) {
    const scope = parseContract(SessionScopeSchema, raw);
    if (scope.agentId !== this.#agentId) throw new Error('session_unavailable');
    return scope;
  }
  #record(scope: SessionScope): SessionRecord {
    const row = this.#db.prepare(`SELECT * FROM session_records WHERE ${scopeWhere}`).get(...scopeArgs(scope));
    if (!row) throw new Error('session_unavailable');
    const result = parseContract(recordSchema, { scope, createdAt: row['created_at'], revision: row['revision'], lastSequence: row['last_sequence'],
      activeWorkId: row['active_work_id'], activeInputSequence: row['active_input_sequence'], head: row['head_body'] === null ? null : rowJson(row['head_body']) });
    if (result.activeInputSequence > result.lastSequence || (result.head && result.head.throughSequence > result.lastSequence)) throw new Error('invalid_session_storage');
    return result;
  }
  async open(rawOwner: SessionOwner, rawOptions: Parameters<SessionRepository['open']>[1]) {
    const owner = parseContract(ownerSchema, rawOwner); const options = parseContract(openSchema, rawOptions);
    if (owner.agentId !== this.#agentId) throw new Error('session_unavailable');
    if (options.newSession && options.sessionId !== undefined) throw new Error('invalid_session_open');
    return this.#transaction(() => {
      let sessionId = options.sessionId;
      if (sessionId === undefined && !options.newSession) {
        const alias = this.#db.prepare('SELECT session_id FROM session_aliases WHERE tenant_id=? AND agent_id=? AND principal_id=? AND route=?')
          .get(owner.tenantId, owner.agentId, owner.principalId, options.route);
        if (alias) sessionId = parseContract(id, alias['session_id']);
      }
      if (sessionId === undefined) {
        sessionId = randomUUID();
        this.#db.prepare(`INSERT INTO session_records(${scopeColumns},created_at,revision,last_sequence,active_work_id,active_input_sequence,head_body) VALUES(?,?,?,?,?,1,0,NULL,0,NULL)`)
          .run(owner.tenantId, owner.agentId, owner.principalId, sessionId, options.now);
      }
      const record = this.#record({ ...owner, sessionId });
      this.#db.prepare(`INSERT INTO session_aliases(tenant_id,agent_id,principal_id,route,session_id) VALUES(?,?,?,?,?)
        ON CONFLICT(tenant_id,agent_id,principal_id,route) DO UPDATE SET session_id=excluded.session_id`)
        .run(owner.tenantId, owner.agentId, owner.principalId, options.route, sessionId);
      return record;
    });
  }
  async get(raw: SessionScope) { return this.#record(this.#scope(raw)); }
  #inbox(scope: SessionScope, messageId: string): SessionInbox | null {
    const row = this.#db.prepare(`SELECT sequence,status,body FROM session_inbox WHERE ${scopeWhere} AND message_id=?`).get(...scopeArgs(scope), messageId);
    if (!row) return null;
    const input = parseContract(inboxSchema, rowJson(row['body']));
    if (!sameScope(input.scope, scope) || input.messageId !== messageId || input.sequence !== row['sequence'] || input.status !== row['status']) throw new Error('invalid_session_storage');
    return input;
  }
  async receive(raw: SessionIntake) {
    const input = parseContract(intakeSchema, raw); const scope = this.#scope(input.scope);
    return this.#transaction(() => {
      const record = this.#record(scope); const existing = this.#inbox(scope, input.messageId);
      if (existing) {
        const { sequence: _seq, status: _status, rejection: _rejection, ...prior } = existing;
        if (existing.digest !== input.digest || intakeIdentity(prior) !== intakeIdentity(input)) throw new Error('session_input_identity_conflict');
        return { input: existing, created: false };
      }
      const sequence = nextCount(record.lastSequence); const received: SessionInbox = { ...input, sequence, status: 'pending', rejection: null };
      this.#db.prepare(`INSERT INTO session_inbox(${scopeColumns},message_id,sequence,status,body) VALUES(?,?,?,?,?,?,?,?)`)
        .run(...scopeArgs(scope), input.messageId, sequence, received.status, JSON.stringify(received));
      this.#db.prepare(`INSERT INTO session_entries(${scopeColumns},sequence,role,work_id,user_message_id,delivery_id) VALUES(?,?,?,?,?,'user',?,?,NULL)`)
        .run(...scopeArgs(scope), sequence, input.workId, input.messageId);
      this.#db.prepare(`UPDATE session_records SET last_sequence=?,revision=? WHERE ${scopeWhere}`).run(sequence, nextCount(record.revision), ...scopeArgs(scope));
      return { input: received, created: true };
    });
  }
  async input(raw: SessionScope, messageId: string) {
    const scope = this.#scope(raw); parseContract(id, messageId); this.#record(scope); return this.#inbox(scope, messageId);
  }
  async pending(raw: SessionScope, limit: number) {
    const scope = this.#scope(raw); parseContract(z.number().int().min(1).max(256), limit); this.#record(scope);
    return this.#db.prepare(`SELECT message_id FROM session_inbox WHERE ${scopeWhere} AND status='pending' ORDER BY sequence LIMIT ?`)
      .all(...scopeArgs(scope), limit).map(row => this.#inbox(scope, String(row['message_id']))!);
  }
  async settle(raw: SessionScope, messageId: string, digest: string, rawResult: Parameters<SessionRepository['settle']>[3]) {
    const scope = this.#scope(raw); parseContract(id, messageId); parseContract(hash, digest);
    const result = parseContract(z.discriminatedUnion('status', [z.strictObject({ status: z.literal('applied') }), z.strictObject({ status: z.literal('rejected'), reason: id })]), rawResult);
    return this.#transaction(() => {
      const record = this.#record(scope); const input = this.#inbox(scope, messageId);
      if (!input) throw new Error('session_input_unavailable');
      if (input.digest !== digest) throw new Error('session_input_identity_conflict');
      const rejection = result.status === 'rejected' ? result.reason : null;
      if (input.status !== 'pending') {
        if (input.status !== result.status || input.rejection !== rejection) throw new Error('session_input_settlement_conflict');
        return input;
      }
      const settled = { ...input, status: result.status, rejection };
      this.#db.prepare(`UPDATE session_inbox SET status=?,body=? WHERE ${scopeWhere} AND message_id=?`).run(result.status, JSON.stringify(settled), ...scopeArgs(scope), messageId);
      const latest = result.status === 'applied' && input.sequence > record.activeInputSequence;
      this.#db.prepare(`UPDATE session_records SET revision=?,active_work_id=?,active_input_sequence=? WHERE ${scopeWhere}`)
        .run(nextCount(record.revision), latest ? input.workId : record.activeWorkId, latest ? input.sequence : record.activeInputSequence, ...scopeArgs(scope));
      return settled;
    });
  }
  #head(scope: SessionScope, candidate: Omit<SessionHead, 'revision'>): SessionHead | null {
    const row = this.#db.prepare(`SELECT revision FROM session_heads WHERE ${scopeWhere} AND through_sequence=? AND digest=? AND policy_digest=?`)
      .get(...scopeArgs(scope), candidate.throughSequence, candidate.digest, candidate.policyDigest);
    return row ? parseContract(SessionHeadSchema, { ...candidate, revision: row['revision'] }) : null;
  }
  async head(raw: SessionScope, rawCandidate: Omit<SessionHead, 'revision'>) {
    const scope = this.#scope(raw); const candidate = parseContract(candidateSchema, rawCandidate); this.#record(scope); return this.#head(scope, candidate);
  }
  #insertHead(scope: SessionScope, candidate: Omit<SessionHead, 'revision'>): SessionHead {
    const row = this.#db.prepare(`SELECT COALESCE(MAX(revision),0) AS revision FROM session_heads WHERE ${scopeWhere}`).get(...scopeArgs(scope));
    const head = { ...candidate, revision: nextCount(parseContract(count, row?.['revision'])) };
    this.#db.prepare(`INSERT INTO session_heads(${scopeColumns},revision,through_sequence,digest,policy_digest) VALUES(?,?,?,?,?,?,?,?)`)
      .run(...scopeArgs(scope), head.revision, head.throughSequence, head.digest, head.policyDigest);
    return head;
  }
  async retainHead(raw: SessionScope, rawCandidate: Omit<SessionHead, 'revision'>) {
    const scope = this.#scope(raw); const candidate = parseContract(candidateSchema, rawCandidate);
    return this.#transaction(() => {
      const record = this.#record(scope); const known = this.#head(scope, candidate); if (known) return known;
      if (!record.head || candidate.throughSequence >= record.head.throughSequence || candidate.throughSequence > record.lastSequence) throw new Error('invalid_session_head');
      return this.#insertHead(scope, candidate);
    });
  }
  async publishHead(raw: SessionScope, expectedRevision: number, rawCandidate: Omit<SessionHead, 'revision'>) {
    const scope = this.#scope(raw); parseContract(count, expectedRevision); const candidate = parseContract(candidateSchema, rawCandidate);
    return this.#transaction(() => {
      const record = this.#record(scope); const actual = record.head?.revision ?? 0;
      if (actual !== expectedRevision || candidate.throughSequence < (record.head?.throughSequence ?? 0)) return null;
      if (candidate.throughSequence > record.lastSequence) throw new Error('invalid_session_head');
      const known = this.#head(scope, candidate); if (known) return known;
      const head = this.#insertHead(scope, candidate);
      this.#db.prepare(`UPDATE session_records SET revision=?,head_body=? WHERE ${scopeWhere}`).run(nextCount(record.revision), JSON.stringify(head), ...scopeArgs(scope));
      return head;
    });
  }
  #compactOwner() {
    const exists = this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_storage_owner'").get();
    if (!exists) throw new AgentProfileError('agent_storage_owner_missing');
    const rows = this.#db.prepare('SELECT singleton,schema_version,agent_id,kind FROM agent_storage_owner LIMIT 2').all(); const owner = rows[0];
    if (rows.length !== 1 || owner?.['singleton'] !== 1 || owner['schema_version'] !== 1 || owner['agent_id'] !== this.#agentId || owner['kind'] !== 'channel') {
      throw new AgentProfileError('agent_storage_owner_mismatch');
    }
  }
  #compactSchema(create: boolean): boolean {
    const names = new Set(this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN('session_compact_schema','session_summaries','session_summary_heads','session_summary_publications')")
      .all().map(row => row['name']));
    if (names.size === 0 && !create) return false;
    this.#compactOwner();
    if (names.size === 0) {
      // Caller holds the same channel transaction throughout owner check, migration and publication.
      this.#db.exec(`
        CREATE TABLE session_compact_schema (singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL);
        CREATE TABLE session_summaries (
          tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,principal_id TEXT NOT NULL,session_id TEXT NOT NULL,
          summary_id TEXT NOT NULL,revision INTEGER NOT NULL,through_sequence INTEGER NOT NULL,policy_digest TEXT NOT NULL,body TEXT NOT NULL,
          PRIMARY KEY(${scopeColumns},summary_id),UNIQUE(${scopeColumns},revision),
          FOREIGN KEY(${scopeColumns}) REFERENCES session_records(${scopeColumns}));
        CREATE INDEX session_summary_prefix ON session_summaries(${scopeColumns},policy_digest,through_sequence);
        CREATE TABLE session_summary_heads (
          tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,principal_id TEXT NOT NULL,session_id TEXT NOT NULL,summary_id TEXT NOT NULL,
          PRIMARY KEY(${scopeColumns}),
          FOREIGN KEY(${scopeColumns},summary_id) REFERENCES session_summaries(${scopeColumns},summary_id));
        CREATE TABLE session_summary_publications (
          tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,principal_id TEXT NOT NULL,session_id TEXT NOT NULL,
          call_id TEXT NOT NULL,request_digest TEXT NOT NULL,summary_id TEXT NOT NULL,
          PRIMARY KEY(${scopeColumns},call_id),UNIQUE(${scopeColumns},summary_id),
          FOREIGN KEY(${scopeColumns},summary_id) REFERENCES session_summaries(${scopeColumns},summary_id));
        INSERT INTO session_compact_schema VALUES(1,1);
      `);
    } else {
      if (names.size !== 4 || !names.has('session_compact_schema')) throw new Error('invalid_session_compact_storage');
      const rows = this.#db.prepare('SELECT singleton,version FROM session_compact_schema LIMIT 2').all();
      if (rows.length !== 1 || rows[0]?.['singleton'] !== 1 || rows[0]['version'] !== 1) throw new Error('unsupported_session_compact_schema');
    }
    return true;
  }
  #summary(scope: SessionScope, summaryId: string): SessionSummaryRecord | null {
    const row = this.#db.prepare(`SELECT * FROM session_summaries WHERE ${scopeWhere} AND summary_id=?`).get(...scopeArgs(scope), summaryId);
    if (!row) return null;
    const record = parseContract(SessionSummaryRecordSchema, rowJson(row['body']));
    if (!sameScope(record.scope, scope) || record.ref.id !== summaryId || record.ref.revision !== row['revision'] ||
      record.ref.throughSequence !== row['through_sequence'] || record.ref.policyDigest !== row['policy_digest'] ||
      record.prefix.throughSequence !== record.ref.throughSequence || record.prefix.entries > record.prefix.throughSequence ||
      record.previous && record.previous.throughSequence >= record.ref.throughSequence) throw new Error('invalid_session_compact_storage');
    return record;
  }
  #summaryHead(scope: SessionScope): SessionSummaryRecord | null {
    const row = this.#db.prepare(`SELECT summary_id FROM session_summary_heads WHERE ${scopeWhere}`).get(...scopeArgs(scope));
    if (!row) return null;
    const record = this.#summary(scope, parseContract(id, row['summary_id']));
    if (!record) throw new Error('invalid_session_compact_storage');
    return record;
  }
  async summaryHead(raw: SessionScope) {
    const scope = this.#scope(raw); this.#record(scope);
    return this.#compactSchema(false) ? this.#summaryHead(scope) : null;
  }
  async summary(raw: SessionScope, summaryId: string) {
    const scope = this.#scope(raw); parseContract(id, summaryId); this.#record(scope);
    return this.#compactSchema(false) ? this.#summary(scope, summaryId) : null;
  }
  async summaryBefore(raw: SessionScope, throughSequence: number, policyDigest: string, rawBefore?: { throughSequence: number; revision: number }) {
    const scope = this.#scope(raw); parseContract(count, throughSequence); parseContract(hash, policyDigest); const session = this.#record(scope);
    const before = rawBefore === undefined ? undefined : parseContract(z.strictObject({ throughSequence: count.min(1), revision: count.min(1) }), rawBefore);
    if (throughSequence > session.lastSequence || before && before.throughSequence >= throughSequence) throw new Error('invalid_session_query');
    if (!this.#compactSchema(false)) return null;
    const row = this.#db.prepare(`SELECT summary_id FROM session_summaries WHERE ${scopeWhere} AND through_sequence<? AND policy_digest=?
      ${before ? 'AND (through_sequence<? OR (through_sequence=? AND revision<?))' : ''}
      ORDER BY through_sequence DESC,revision DESC LIMIT 1`)
      .get(...scopeArgs(scope), throughSequence, policyDigest, ...(before ? [before.throughSequence, before.throughSequence, before.revision] : []));
    return row ? this.#summary(scope, parseContract(id, row['summary_id'])) : null;
  }
  #publication(scope: SessionScope, callId: string): { requestDigest: string; record: SessionSummaryRecord } | null {
    const row = this.#db.prepare(`SELECT request_digest,summary_id FROM session_summary_publications WHERE ${scopeWhere} AND call_id=?`).get(...scopeArgs(scope), callId);
    if (!row) return null;
    const record = this.#summary(scope, parseContract(id, row['summary_id']));
    if (!record || record.callId !== callId) throw new Error('invalid_session_compact_storage');
    return { requestDigest: parseContract(hash, row['request_digest']), record };
  }
  async publication(raw: SessionScope, callId: string) {
    const scope = this.#scope(raw); parseContract(id, callId); this.#record(scope);
    return this.#compactSchema(false) ? this.#publication(scope, callId)?.record ?? null : null;
  }
  async publishSummary(raw: SessionScope, expectedRevision: number, rawCandidate: SessionSummaryPublication) {
    const scope = this.#scope(raw); parseContract(count, expectedRevision); const candidate = parseContract(SessionSummaryPublicationSchema, rawCandidate);
    if (!sameScope(scope, candidate.scope)) throw new Error('session_summary_scope_mismatch');
    if (candidate.ref.throughSequence !== candidate.prefix.throughSequence || candidate.prefix.entries > candidate.prefix.throughSequence ||
      candidate.previous && candidate.previous.throughSequence >= candidate.ref.throughSequence || candidate.content.retained.some(item =>
        item.citations.some(quote => quote.sequence > candidate.ref.throughSequence) || item.changedBy && item.changedBy.sequence > candidate.ref.throughSequence)) throw new Error('invalid_session_summary');
    const { createdAt: _createdAt, ...content } = candidate;
    const requestDigest = this.#digester.digest({ expectedRevision, candidate: content } as unknown as Json);
    return this.#transaction(() => {
      const session = this.#record(scope); this.#compactSchema(true);
      const prior = this.#publication(scope, candidate.callId);
      if (prior) {
        if (prior.requestDigest !== requestDigest) throw new Error('session_summary_publication_conflict');
        return prior.record;
      }
      if (this.#summary(scope, candidate.ref.id)) throw new Error('session_summary_identity_conflict');
      if (candidate.ref.throughSequence > session.lastSequence) throw new Error('invalid_session_summary');
      const current = this.#summaryHead(scope);
      if ((current?.ref.revision ?? 0) !== expectedRevision) return null;
      if (candidate.previous) {
        const previous = this.#summary(scope, candidate.previous.id);
        if (!previous || canonical(previous.ref as unknown as Json) !== canonical(candidate.previous as unknown as Json)) throw new Error('session_summary_previous_unavailable');
      }
      const row = this.#db.prepare(`SELECT COALESCE(MAX(revision),0) AS revision FROM session_summaries WHERE ${scopeWhere}`).get(...scopeArgs(scope));
      const record: SessionSummaryRecord = { ...candidate, ref: { ...candidate.ref, revision: nextCount(parseContract(count, row?.['revision'])) } };
      this.#db.prepare(`INSERT INTO session_summaries(${scopeColumns},summary_id,revision,through_sequence,policy_digest,body) VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(...scopeArgs(scope), record.ref.id, record.ref.revision, record.ref.throughSequence, record.ref.policyDigest, JSON.stringify(record));
      // A policy rebuild may retain earlier prefixes while a newer physical head stays in place.
      if (record.ref.throughSequence >= (current?.ref.throughSequence ?? 0)) {
        this.#db.prepare(`INSERT INTO session_summary_heads(${scopeColumns},summary_id) VALUES(?,?,?,?,?) ON CONFLICT(${scopeColumns}) DO UPDATE SET summary_id=excluded.summary_id`)
          .run(...scopeArgs(scope), record.ref.id);
      }
      this.#db.prepare(`INSERT INTO session_summary_publications(${scopeColumns},call_id,request_digest,summary_id) VALUES(?,?,?,?,?,?,?)`)
        .run(...scopeArgs(scope), record.callId, requestDigest, record.ref.id);
      return record;
    });
  }
  #deliveryScope(delivery: Delivery) {
    const binding = delivery.context?.binding;
    if (!binding?.session) throw new Error('session_delivery_missing');
    const scope = this.#scope(binding.session);
    if (binding.tenantId !== scope.tenantId || binding.principalId !== scope.principalId || binding.recipientId !== scope.principalId ||
      delivery.destination !== binding.destination || (delivery.context?.artifact && delivery.context.artifact.tenantId !== scope.tenantId)) throw new Error('session_delivery_mismatch');
    this.#record(scope); return scope;
  }
  /** Infrastructure-only: caller's message insert and this reference must share one transaction. */
  recordLocalDelivery(delivery: Delivery): void {
    const scope = this.#deliveryScope(delivery); const record = this.#record(scope);
    if (this.hasLocalDelivery(delivery)) return;
    const source = this.#db.prepare('SELECT body,digest,external_id FROM local_messages WHERE work_id=? AND delivery_id=?').get(delivery.workId, delivery.id);
    if (!source) throw new Error('session_delivery_missing');
    this.#storedDelivery(source, scope, delivery.workId, delivery.id);
    const sequence = nextCount(record.lastSequence);
    this.#db.prepare(`INSERT INTO session_entries(${scopeColumns},sequence,role,work_id,user_message_id,delivery_id) VALUES(?,?,?,?,?,'assistant',?,NULL,?)`)
      .run(...scopeArgs(scope), sequence, delivery.workId, delivery.id);
    this.#db.prepare(`UPDATE session_records SET last_sequence=?,revision=? WHERE ${scopeWhere}`).run(sequence, nextCount(record.revision), ...scopeArgs(scope));
  }
  hasLocalDelivery(delivery: Delivery): boolean {
    const scope = this.#deliveryScope(delivery);
    return Boolean(this.#db.prepare(`SELECT 1 FROM session_entries WHERE ${scopeWhere} AND role='assistant' AND work_id=? AND delivery_id=?`)
      .get(...scopeArgs(scope), delivery.workId, delivery.id));
  }
  #storedDelivery(row: Record<string, unknown>, scope: SessionScope, workId: string, deliveryId: string): Delivery {
    const delivery = parseContract(DeliverySchema, rowJson(row['body']));
    if (delivery.workId !== workId || delivery.id !== deliveryId || delivery.status !== 'delivered' || delivery.externalId !== row['external_id'] ||
      !delivery.context?.binding.session || !sameScope(delivery.context.binding.session, scope) ||
      this.#digester.digest(deliveryContent(delivery)) !== row['digest']) throw new Error('invalid_session_storage');
    this.#deliveryScope(delivery); return delivery;
  }
  async history(raw: SessionScope, rawPolicy: Policy, rawOptions: Parameters<SessionRepository['history']>[2]) {
    const scope = this.#scope(raw); const policy = parseContract(PolicySchema, rawPolicy); const options = parseContract(historySchema, rawOptions);
    if (policy.tenantId !== scope.tenantId || policy.principalId !== scope.principalId) throw new Error('session_unavailable');
    const record = this.#record(scope); const policyDigest = this.#digester.digest(policy as unknown as Json);
    const identity = `${sha256(JSON.stringify(scopeArgs(scope)))}:${policyDigest}:`;
    const prefix = `session-v2:${identity}`; const legacyPrefix = `session-v1:${identity}`;
    let lower = options.afterSequence ?? 0; let after = lower; let through = options.throughSequence ?? record.lastSequence;
    if (options.cursor !== undefined) {
      try {
        const legacy = options.cursor.startsWith(legacyPrefix);
        if (!legacy && !options.cursor.startsWith(prefix)) throw new Error();
        const encoded = options.cursor.slice(legacy ? legacyPrefix.length : prefix.length); const bytes = Buffer.from(encoded, 'base64url');
        if (bytes.toString('base64url') !== encoded) throw new Error();
        const value = legacy ? { lower: 0, ...parseContract(z.strictObject({ after: count.min(1), through: count }), rowJson(bytes.toString('utf8'))) }
          : parseContract(z.strictObject({ lower: count, after: count.min(1), through: count }), rowJson(bytes.toString('utf8')));
        if (value.after <= value.lower || value.after > value.through ||
          (options.afterSequence !== undefined && options.afterSequence !== value.lower) ||
          (options.throughSequence !== undefined && options.throughSequence !== value.through)) throw new Error();
        lower = value.lower; after = value.after; through = value.through;
      } catch { throw new Error('invalid_session_cursor'); }
    }
    if (lower > through || through > record.lastSequence) throw new Error('invalid_session_query');
    const labels = JSON.stringify(policy.allowedLabels); const destinations = JSON.stringify(policy.allowedDestinations);
    const rows = this.#db.prepare(`SELECT e.sequence,e.role,e.work_id,e.user_message_id,e.delivery_id,
        i.body AS input_body,m.body AS delivery_body,m.digest AS delivery_digest,m.external_id
      FROM session_entries e
      LEFT JOIN session_inbox i ON e.tenant_id=i.tenant_id AND e.agent_id=i.agent_id AND e.principal_id=i.principal_id AND e.session_id=i.session_id AND e.user_message_id=i.message_id
      LEFT JOIN local_messages m ON e.work_id=m.work_id AND e.delivery_id=m.delivery_id
      WHERE e.tenant_id=? AND e.agent_id=? AND e.principal_id=? AND e.session_id=? AND e.sequence>? AND e.sequence<=?
        AND ((e.role='user' AND NOT EXISTS(SELECT 1 FROM json_each(i.body,'$.labels') l WHERE l.value NOT IN(SELECT value FROM json_each(?))))
          OR (e.role='assistant' AND json_extract(m.body,'$.destination') IN(SELECT value FROM json_each(?))
            AND NOT EXISTS(SELECT 1 FROM json_each(m.body,'$.context.labels') l WHERE l.value NOT IN(SELECT value FROM json_each(?)))
            AND NOT EXISTS(SELECT 1 FROM json_each(m.body,'$.context.artifact.labels') l WHERE l.value NOT IN(SELECT value FROM json_each(?)))))
      ORDER BY e.sequence LIMIT ?`).all(...scopeArgs(scope), after, through, labels, destinations, labels, labels, options.limit + 1);
    const entries: SessionEntry[] = rows.slice(0, options.limit).map(row => {
      const sequence = parseContract(count.min(1), row['sequence']); const workId = parseContract(id, row['work_id']);
      if (row['role'] === 'user') {
        const input = parseContract(inboxSchema, rowJson(row['input_body']));
        if (!sameScope(scope, input.scope) || input.sequence !== sequence || input.workId !== workId || input.messageId !== row['user_message_id']) throw new Error('invalid_session_storage');
        return { sequence, role: 'user', sourceId: input.messageId, workId, text: input.text, labels: input.labels, artifact: null, status: 'received', kind: input.kind };
      }
      const deliveryId = parseContract(id, row['delivery_id']);
      const delivery = this.#storedDelivery({ body: row['delivery_body'], digest: row['delivery_digest'], external_id: row['external_id'] }, scope, workId, deliveryId);
      return { sequence, role: 'assistant', sourceId: deliveryId, workId, text: delivery.text, labels: delivery.context!.labels,
        artifact: delivery.context!.artifact, status: 'delivered', kind: delivery.kind };
    });
    const nextCursor = rows.length > options.limit ? prefix + Buffer.from(JSON.stringify({ lower, after: entries.at(-1)!.sequence, through })).toString('base64url') : null;
    return { entries, nextCursor };
  }
}
