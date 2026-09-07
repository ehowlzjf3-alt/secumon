import { z } from 'zod';
import type { KnowledgeCandidates, KnowledgeCommit, KnowledgeCommitResult, KnowledgeRepository, KnowledgeStoreScope } from '../application/knowledge-ports.js';
import { parseKnowledge } from '../application/knowledge-contracts.js';
import type { KnowledgeIndexHead, KnowledgeQuery, KnowledgeRecord, TrustedKnowledgeActor } from '../domain/knowledge.js';
import type { PostgresClient, PostgresStore } from './postgres-store.js';

const columns = 'store_id,agent_id,tenant_id,partition,principal_id';
const where = 'store_id=$1 AND agent_id=$2 AND tenant_id=$3 AND partition=$4 AND principal_id=$5';
const names = `store_id TEXT COLLATE "C" NOT NULL,agent_id TEXT COLLATE "C" NOT NULL,tenant_id TEXT COLLATE "C" NOT NULL,
  partition TEXT COLLATE "C" NOT NULL CHECK(partition IN ('work','personal')),principal_id TEXT COLLATE "C" NOT NULL,
  CHECK((partition='work' AND principal_id='') OR (partition='personal' AND length(principal_id)>0))`;
const integer = 'BIGINT NOT NULL CHECK(VALUE_PLACEHOLDER BETWEEN 0 AND 9007199254740991)';
const numberColumn = (name: string, positive = false) => `${name} ${integer.replace('VALUE_PLACEHOLDER', name)}${positive ? ` CHECK(${name}>0)` : ''}`;

/** Executed only by explicit host provisioning. Ordinary repository construction performs no SQL. */
export const POSTGRES_KNOWLEDGE_SCHEMA: readonly string[] = Object.freeze([
  `CREATE TABLE IF NOT EXISTS secumon_pg.knowledge_records(${names},id TEXT COLLATE "C" NOT NULL,namespace TEXT COLLATE "C" NOT NULL,
    ${numberColumn('revision', true)},body TEXT NOT NULL,PRIMARY KEY(${columns},id))`,
  `CREATE INDEX IF NOT EXISTS knowledge_namespace ON secumon_pg.knowledge_records(${columns},namespace,id)`,
  `CREATE TABLE IF NOT EXISTS secumon_pg.knowledge_heads(${names},namespace TEXT COLLATE "C" NOT NULL,
    ${numberColumn('revision')},${numberColumn('cursor')},error TEXT,CHECK(cursor<=revision),PRIMARY KEY(${columns},namespace))`,
  `CREATE TABLE IF NOT EXISTS secumon_pg.knowledge_receipts(${names},id TEXT COLLATE "C" NOT NULL,command_id TEXT COLLATE "C" NOT NULL,
    digest TEXT NOT NULL,${numberColumn('revision', true)},audit_body TEXT,PRIMARY KEY(${columns},id,command_id))`,
  `CREATE TABLE IF NOT EXISTS secumon_pg.knowledge_index(${names},namespace TEXT COLLATE "C" NOT NULL,id TEXT COLLATE "C" NOT NULL,
    document TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(${columns},namespace,id))`,
]);
const name = z.string().min(1).max(160).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const scopeSchema = z.discriminatedUnion('partition', [z.strictObject({ agentId: name, partition: z.literal('work') }),
  z.strictObject({ agentId: name, partition: z.literal('personal'), principalId: name })]);
const indexErrors = ['index_read_failed', 'index_capacity_exceeded', 'index_rebuild_failed'];
type Selection = { scope: KnowledgeStoreScope; tenantId: string; values: string[] };
const document = (record: KnowledgeRecord) => `${record.title}\n${record.body}`.normalize('NFC').toLocaleLowerCase('en-US');
function invalid(): never { throw new Error('invalid_knowledge_storage'); }
export function postgresKnowledgeInteger(value: unknown): number {
  if (typeof value === 'number') { if (!Number.isSafeInteger(value) || value < 0) invalid(); return value; }
  if (typeof value !== 'bigint' && (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))) invalid();
  const result = BigInt(value);
  if (result < 0n || result > BigInt(Number.MAX_SAFE_INTEGER)) invalid(); return Number(result);
}
function single(rows: Record<string, unknown>[]) { if (rows.length > 1) invalid(); return rows[0]; }
function receipt(row: Record<string, unknown> | undefined) {
  if (!row) return null;
  if (typeof row['digest'] !== 'string' || !row['digest']) invalid();
  const revision = postgresKnowledgeInteger(row['revision']); if (!revision) invalid();
  return { digest: row['digest'], revision };
}
function head(row: Record<string, unknown> | undefined): KnowledgeIndexHead {
  if (!row) return { revision: 0, cursor: 0, error: null };
  const revision = postgresKnowledgeInteger(row['revision']), cursor = postgresKnowledgeInteger(row['cursor']);
  const error = row['error'];
  if (cursor > revision || error !== null && (typeof error !== 'string' || !indexErrors.includes(error))) invalid();
  return { revision, cursor, error };
}
function sourceRefs(record: KnowledgeRecord | null) {
  return record?.sources.map(source => source.type === 'session_user_receipt' ? { type: source.type, session: source.session,
    messageId: source.messageId, sequence: source.sequence, receiptDigest: source.receiptDigest } :
    { workId: source.workId, evidenceId: source.evidenceId, sourceVersion: source.sourceVersion }) ?? [];
}

/** Same scoped record/receipt/index contract as SQLite, with transactions and ownership supplied by PostgresStore. */
export class PostgresKnowledgeRepository implements KnowledgeRepository {
  readonly #storeId: string; readonly #agentId: string;
  constructor(readonly store: PostgresStore) {
    if (store.binding.purpose !== 'knowledge' || store.key[0] !== store.binding.storeId || store.key[1] !== store.binding.agentId)
      throw new Error('knowledge_scope_mismatch');
    this.#storeId = name.parse(store.binding.storeId); this.#agentId = name.parse(store.binding.agentId);
  }
  #select(tenantId: string, input?: KnowledgeStoreScope): Selection {
    const scope = scopeSchema.parse(input ?? { agentId: this.#agentId, partition: 'work' });
    if (scope.agentId !== this.#agentId) throw new Error('knowledge_scope_mismatch');
    const tenant = name.parse(tenantId);
    return { scope, tenantId: tenant, values: [this.#storeId, this.#agentId, tenant, scope.partition, scope.partition === 'personal' ? scope.principalId : ''] };
  }
  #namespace(part: Selection, namespace: string) {
    name.parse(namespace);
    if (part.scope.partition === 'personal' && namespace !== 'personal') throw new Error('knowledge_scope_mismatch');
  }
  #record(value: KnowledgeRecord, part: Selection) {
    if (value.tenantId !== part.tenantId) invalid();
    if (part.scope.partition === 'work') {
      if (value.kind === 'personal' || value.owner !== undefined || value.schemaVersion !== undefined) throw new Error('knowledge_scope_mismatch');
    } else if (value.kind !== 'personal' || value.schemaVersion !== 2 || value.owner?.schemaVersion !== 1 || value.owner.agentId !== part.scope.agentId ||
      value.owner.principalId !== part.scope.principalId || value.authorId !== part.scope.principalId || value.namespace !== 'personal' || value.scope !== 'personal' ||
      value.visibility !== 'private' || value.reviewState !== 'private' || value.review !== null) throw new Error('knowledge_scope_mismatch');
    return value;
  }
  #row(row: Record<string, unknown>, part: Selection) {
    if (typeof row['body'] !== 'string') invalid();
    const value = this.#record(parseKnowledge(JSON.parse(row['body'])), part);
    if (value.id !== row['id'] || value.namespace !== row['namespace'] || value.revision !== postgresKnowledgeInteger(row['revision'])) invalid();
    return value;
  }
  async #head(client: PostgresClient, part: Selection, namespace: string) {
    return head(single((await client.query(`SELECT revision,cursor,error FROM secumon_pg.knowledge_heads WHERE ${where} AND namespace=$6`,
      [...part.values, namespace])).rows));
  }
  async get(tenantId: string, id: string, scope?: KnowledgeStoreScope): Promise<KnowledgeRecord | null> {
    const part = this.#select(tenantId, scope); name.parse(id);
    return this.store.read(async client => {
      const row = single((await client.query(`SELECT id,namespace,revision,body FROM secumon_pg.knowledge_records WHERE ${where} AND id=$6`, [...part.values, id])).rows);
      return row ? this.#row(row, part) : null;
    });
  }
  async receipt(tenantId: string, id: string, commandId: string, scope?: KnowledgeStoreScope) {
    const part = this.#select(tenantId, scope); name.parse(id); name.parse(commandId);
    return this.store.read(async client => receipt(single((await client.query(
      `SELECT digest,revision FROM secumon_pg.knowledge_receipts WHERE ${where} AND id=$6 AND command_id=$7`, [...part.values, id, commandId])).rows)));
  }
  async commit(command: KnowledgeCommit): Promise<KnowledgeCommitResult> {
    const next = parseKnowledge(command.next);
    const { expectedRevision, commandId, commandDigest } = command;
    if (next.kind === 'personal' && command.scope === undefined) throw new Error('knowledge_scope_required');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || next.revision !== expectedRevision + 1 ||
      typeof commandId !== 'string' || !commandId || commandId.length > 160 ||
      typeof commandDigest !== 'string' || !commandDigest) throw new Error('invalid_knowledge_commit');
    name.parse(commandId);
    const part = this.#select(next.tenantId, command.scope); this.#record(next, part);
    return this.store.write<KnowledgeCommitResult>(async client => {
      const previousReceipt = receipt(single((await client.query(`SELECT digest,revision FROM secumon_pg.knowledge_receipts
        WHERE ${where} AND id=$6 AND command_id=$7`, [...part.values, next.id, commandId])).rows));
      if (previousReceipt) return previousReceipt.digest === commandDigest ? { kind: 'duplicate', revision: previousReceipt.revision } : { kind: 'idempotency_conflict' };
      const prior = single((await client.query(`SELECT id,namespace,revision,body FROM secumon_pg.knowledge_records WHERE ${where} AND id=$6`, [...part.values, next.id])).rows);
      const actualRevision = prior ? postgresKnowledgeInteger(prior['revision']) : 0;
      if (actualRevision !== expectedRevision) return { kind: 'conflict', actualRevision };
      const old = prior ? this.#row(prior, part) : null;
      if (old && (old.namespace !== next.namespace || old.scope !== next.scope || old.authorId !== next.authorId || next.createdAt !== old.createdAt ||
        next.updatedAt < old.updatedAt || next.contentRevision < old.contentRevision || next.contentRevision > old.contentRevision + 1 ||
        old.status !== 'active' && next.status === 'active')) throw new Error('invalid_knowledge_transition');
      const body = JSON.stringify(next);
      await client.query(`INSERT INTO secumon_pg.knowledge_records(${columns},id,namespace,revision,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT(${columns},id) DO UPDATE SET revision=EXCLUDED.revision,body=EXCLUDED.body`, [...part.values, next.id, next.namespace, next.revision, body]);
      const personal = part.scope.partition === 'personal';
      const updated = await client.query(`INSERT INTO secumon_pg.knowledge_heads AS current_head(${columns},namespace,revision,cursor,error)
        VALUES($1,$2,$3,$4,$5,$6,1,${personal ? 1 : 0},NULL) ON CONFLICT(${columns},namespace) DO UPDATE SET revision=current_head.revision+1
        ${personal ? ',cursor=CASE WHEN current_head.cursor=current_head.revision AND current_head.error IS NULL THEN current_head.revision+1 ELSE current_head.cursor END' : ''}
        RETURNING revision,cursor,error`, [...part.values, next.namespace]);
      if (!single(updated.rows)) invalid(); head(updated.rows[0]);
      if (personal) {
        if (next.status === 'active') await this.#indexRecord(client, part, next, body);
        else await client.query(`DELETE FROM secumon_pg.knowledge_index WHERE ${where} AND namespace=$6 AND id=$7`, [...part.values, next.namespace, next.id]);
      }
      await client.query(`INSERT INTO secumon_pg.knowledge_receipts(${columns},id,command_id,digest,revision,audit_body)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [...part.values, next.id, commandId, commandDigest, next.revision,
        personal ? JSON.stringify({ expectedRevision, revision: next.revision, contentRevision: next.contentRevision,
          previousSources: sourceRefs(old), sources: sourceRefs(next) }) : null]);
      return { kind: 'committed', revision: next.revision };
    });
  }
  async #indexRecord(client: PostgresClient, part: Selection, value: KnowledgeRecord, body = JSON.stringify(value)) {
    await client.query(`INSERT INTO secumon_pg.knowledge_index(${columns},namespace,id,document,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(${columns},namespace,id) DO UPDATE SET document=EXCLUDED.document,body=EXCLUDED.body`,
      [...part.values, value.namespace, value.id, document(value), body]);
  }
  async indexHead(tenantId: string, namespace: string, scope?: KnowledgeStoreScope): Promise<KnowledgeIndexHead> {
    const part = this.#select(tenantId, scope); this.#namespace(part, namespace);
    return this.store.read(client => this.#head(client, part, namespace));
  }
  async candidates(actor: TrustedKnowledgeActor, query: KnowledgeQuery, maximum: number, scope?: KnowledgeStoreScope): Promise<KnowledgeCandidates> {
    const part = this.#select(actor.tenantId, scope); this.#namespace(part, query.namespace);
    const personal = part.scope.partition === 'personal';
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 200 || !actor.allowedNamespaces.includes(query.namespace) ||
      !personal && !actor.allowedScopes.includes(query.scope) || typeof query.text !== 'string') throw new Error('invalid_knowledge_index_request');
    if (actor.agentId !== undefined && actor.agentId !== part.scope.agentId || part.scope.partition === 'personal' && (actor.agentId !== part.scope.agentId ||
      actor.principalId !== part.scope.principalId || query.scope !== 'personal' || query.kinds.length !== 1 || query.kinds[0] !== 'personal')) throw new Error('knowledge_scope_mismatch');
    const permissionValues = personal ? [actor.principalId] : [actor.principalId, actor.canReview];
    const values = [...part.values, query.namespace, query.scope, ...permissionValues, [...actor.allowedLabels], query.text, [...query.kinds], maximum + 1];
    const labelParameter = personal ? 9 : 10;
    return this.store.read(async client => {
      const visibility = personal ? `(body::jsonb->>'visibility')='private' AND (body::jsonb->>'reviewState')='private' AND (body::jsonb->>'authorId')=$8` :
        `((body::jsonb->>'authorId')=$8 OR ((body::jsonb->>'visibility')='shared' AND (body::jsonb->>'reviewState')='reviewed') OR ($9::boolean AND (body::jsonb->>'reviewState')='submitted'))`;
      const rows = (await client.query(`SELECT id FROM secumon_pg.knowledge_index WHERE ${where} AND namespace=$6
        AND (body::jsonb->>'scope')=$7 AND (body::jsonb->>'status')='active' AND ${visibility}
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(body::jsonb->'labels') AS label(value) WHERE NOT (label.value=ANY($${labelParameter}::text[])))
        AND strpos(document COLLATE "C",$${labelParameter + 1})>0
        AND (cardinality($${labelParameter + 2}::text[])=0 OR (body::jsonb->>'kind')=ANY($${labelParameter + 2}::text[]))
        ORDER BY id COLLATE "C" LIMIT $${labelParameter + 3}`, values)).rows;
      const ids = rows.map(row => name.parse(row['id']));
      if (ids.length > maximum + 1 || new Set(ids).size !== ids.length) invalid();
      return { ids: ids.slice(0, maximum), truncated: ids.length > maximum };
    });
  }
  async #markError(client: PostgresClient, part: Selection, namespace: string, code: string) {
    await client.query(`INSERT INTO secumon_pg.knowledge_heads(${columns},namespace,revision,cursor,error) VALUES($1,$2,$3,$4,$5,$6,0,0,$7)
      ON CONFLICT(${columns},namespace) DO UPDATE SET error=EXCLUDED.error`, [...part.values, namespace, code]);
  }
  async rebuildIndex(tenantId: string, namespace: string, scope?: KnowledgeStoreScope): Promise<KnowledgeIndexHead> {
    const part = this.#select(tenantId, scope); this.#namespace(part, namespace);
    const result = await this.store.write(async client => {
      await client.query('SAVEPOINT knowledge_index_rebuild');
      try {
        const count = single((await client.query(`SELECT count(*)::text AS count FROM
          (SELECT 1 FROM secumon_pg.knowledge_records WHERE ${where} AND namespace=$6 LIMIT 5001) AS bounded`, [...part.values, namespace])).rows);
        if (!count) invalid();
        if (postgresKnowledgeInteger(count['count']) > 5000) throw new Error('index_capacity_exceeded');
        await client.query(`DELETE FROM secumon_pg.knowledge_index WHERE ${where} AND namespace=$6`, [...part.values, namespace]);
        let after: string | null = null, total = 0;
        for (;;) {
          const rows = (await client.query(`SELECT id,namespace,revision,body FROM secumon_pg.knowledge_records WHERE ${where} AND namespace=$6
            AND ($7::text IS NULL OR id>$7 COLLATE "C") ORDER BY id COLLATE "C" LIMIT 64`, [...part.values, namespace, after])).rows;
          if (!rows.length) break;
          total += rows.length; if (rows.length > 64 || total > 5000) throw new Error('index_capacity_exceeded');
          for (const row of rows) { const value = this.#row(row, part); if (value.namespace !== namespace) invalid();
            if (value.status === 'active') await this.#indexRecord(client, part, value); after = value.id; }
        }
        await client.query(`UPDATE secumon_pg.knowledge_heads SET cursor=revision,error=NULL WHERE ${where} AND namespace=$6`, [...part.values, namespace]);
        const value = await this.#head(client, part, namespace);
        await client.query('RELEASE SAVEPOINT knowledge_index_rebuild'); return { kind: 'ready' as const, value };
      } catch (error) {
        try {
          await client.query('ROLLBACK TO SAVEPOINT knowledge_index_rebuild');
          await this.#markError(client, part, namespace, error instanceof Error && error.message === 'index_capacity_exceeded' ? 'index_capacity_exceeded' : 'index_rebuild_failed');
          await client.query('RELEASE SAVEPOINT knowledge_index_rebuild');
        } catch (recordError) { throw new AggregateError([error, recordError], 'knowledge_index_failure_record_failed', { cause: error }); }
        return { kind: 'error' as const, error };
      }
    });
    // A failed/unknown outer COMMIT throws before this point: never start a second write to guess its outcome.
    if (result.kind === 'error') throw result.error; return result.value;
  }
  async markIndexError(tenantId: string, namespace: string, code: string, scope?: KnowledgeStoreScope): Promise<void> {
    if (!indexErrors.includes(code)) throw new Error('invalid_knowledge_index_error');
    const part = this.#select(tenantId, scope); this.#namespace(part, namespace);
    await this.store.write(client => this.#markError(client, part, namespace, code));
  }
  close(): Promise<void> { return this.store.close(); }
}
