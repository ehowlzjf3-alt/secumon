import type { DatabaseSync } from 'node:sqlite';
import { openHostSqliteDatabase, closeSqliteAfterFailure } from './windows-sqlite.js';
import { z } from 'zod';
import type { KnowledgeCandidates, KnowledgeCommit, KnowledgeCommitResult, KnowledgeRepository, KnowledgeStoreScope } from '../application/knowledge-ports.js';
import { parseKnowledge } from '../application/knowledge-contracts.js';
import type { KnowledgeIndexHead, KnowledgeQuery, KnowledgeRecord, TrustedKnowledgeActor } from '../domain/knowledge.js';
import { assertKnowledgeStoreOwner, knowledgeSqliteBinding, preflightKnowledgeStore, type KnowledgeSqliteBinding } from './sqlite-knowledge-owner.js';
import { sqlitePersonalMemoryFence } from './sqlite-personal-memory-migration.js';

function record(value: unknown): KnowledgeRecord {
  if (typeof value !== 'string') throw new Error('invalid_knowledge_storage');
  return parseKnowledge(JSON.parse(value));
}
const name = z.string().min(1).max(160).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const scopeSchema = z.discriminatedUnion('partition', [
  z.strictObject({ agentId: name, partition: z.literal('work') }),
  z.strictObject({ agentId: name, partition: z.literal('personal'), principalId: name }),
]);
type Selection = { scope: KnowledgeStoreScope | null; suffix: string; columns: string; where: string; args: string[] };
const tableNames = ['records', 'heads', 'receipts', 'index'] as const;
const table = (part: Selection, name: typeof tableNames[number]) => `knowledge_${name}${part.suffix}`;
const placeholders = (length: number) => Array.from({ length }, () => '?').join(',');
const document = (r: KnowledgeRecord) => `${r.title}\n${r.body}`.normalize('NFC').toLocaleLowerCase('en-US');
function sourceRefs(r: KnowledgeRecord | null) {
  return r?.sources.map(s => s.type === 'session_user_receipt' ? { type: s.type, session: s.session,
    messageId: s.messageId, sequence: s.sequence, receiptDigest: s.receiptDigest } : { workId: s.workId, evidenceId: s.evidenceId, sourceVersion: s.sourceVersion }) ?? [];
}

export class SqliteKnowledgeRepository implements KnowledgeRepository {
  readonly #db: DatabaseSync;
  readonly #binding: Readonly<KnowledgeSqliteBinding> | undefined;
  constructor(path: string, binding?: KnowledgeSqliteBinding) {
    this.#binding = binding === undefined ? undefined : knowledgeSqliteBinding(binding);
    if (this.#binding) preflightKnowledgeStore(path, this.#binding);
    this.#db = openHostSqliteDatabase(path);
    try {
      if (!this.#binding) this.#legacyMode();
      this.#db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      if (this.#binding) this.#initializeScoped(this.#binding);
      else {
        this.#db.exec(`
          CREATE TABLE IF NOT EXISTS knowledge_schema (version INTEGER NOT NULL);
          INSERT INTO knowledge_schema(version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM knowledge_schema);
        `);
        if (this.#db.prepare('SELECT version FROM knowledge_schema').get()?.['version'] !== 1) throw new Error('unsupported_knowledge_schema');
        this.#db.exec(`
          CREATE TABLE IF NOT EXISTS knowledge_records (
            tenant_id TEXT NOT NULL, id TEXT NOT NULL, namespace TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL,
            PRIMARY KEY(tenant_id,id));
          CREATE INDEX IF NOT EXISTS knowledge_namespace ON knowledge_records(tenant_id,namespace);
          CREATE TABLE IF NOT EXISTS knowledge_heads (
            tenant_id TEXT NOT NULL, namespace TEXT NOT NULL, revision INTEGER NOT NULL, cursor INTEGER NOT NULL, error TEXT,
            PRIMARY KEY(tenant_id,namespace));
          CREATE TABLE IF NOT EXISTS knowledge_receipts (
            tenant_id TEXT NOT NULL, id TEXT NOT NULL, command_id TEXT NOT NULL, digest TEXT NOT NULL, revision INTEGER NOT NULL,
            PRIMARY KEY(tenant_id,id,command_id));
          CREATE TABLE IF NOT EXISTS knowledge_index (
            tenant_id TEXT NOT NULL, namespace TEXT NOT NULL, id TEXT NOT NULL, document TEXT NOT NULL, body TEXT NOT NULL,
            PRIMARY KEY(tenant_id,namespace,id));
        `);
      }
    } catch (error) { if (process.platform === 'win32') closeSqliteAfterFailure(this.#db, error); this.#db.close(); throw error; }
  }
  #exists(name: string) { return this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined; }
  #legacyMode() {
    if (this.#exists('knowledge_scoped_schema') || this.#exists('knowledge_store_owner') || this.#exists('knowledge_schema') &&
      this.#db.prepare('SELECT version FROM knowledge_schema').get()?.['version'] === 2) throw new Error('knowledge_scoped_handle_required');
  }
  #assertScoped(binding: KnowledgeSqliteBinding) {
    assertKnowledgeStoreOwner(this.#db, binding);
    const rows = this.#db.prepare('SELECT singleton,version,mode,binding_id FROM knowledge_scoped_schema LIMIT 2').all(); const row = rows[0];
    if (rows.length !== 1 || row?.['singleton'] !== 1 || row['version'] !== 1 || row['mode'] !== binding.mode ||
      row['binding_id'] !== (binding.mode === 'agent' ? binding.agentId : binding.storeId)) throw new Error('invalid_knowledge_storage_binding');
    const versions = this.#db.prepare('SELECT version FROM knowledge_schema LIMIT 2').all();
    if (versions.length !== 1) throw new Error('unsupported_knowledge_schema');
    if (versions[0]?.['version'] === 3 && binding.mode === 'agent') {
      if (!sqlitePersonalMemoryFence(this.#db, binding.agentId)) throw new Error('unsupported_knowledge_schema');
      return true;
    }
    if (versions[0]?.['version'] !== 2) throw new Error('unsupported_knowledge_schema');
    return false;
  }
  #initializeScoped(binding: KnowledgeSqliteBinding) {
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      assertKnowledgeStoreOwner(this.#db, binding);
      if (this.#exists('knowledge_scoped_schema')) {
        this.#assertScoped(binding);
        if (tableNames.some(name => !this.#exists(`knowledge_${name}_v2`))) throw new Error('invalid_knowledge_storage');
        this.#db.exec('COMMIT;'); return;
      }
      if (tableNames.some(name => this.#exists(`knowledge_${name}_v2`))) throw new Error('invalid_knowledge_storage');
      const legacy = this.#exists('knowledge_schema');
      if (legacy) {
        const versions = this.#db.prepare('SELECT version FROM knowledge_schema LIMIT 2').all();
        if (binding.mode !== 'agent' || versions.length !== 1 || versions[0]?.['version'] !== 1 ||
          tableNames.some(name => !this.#exists(`knowledge_${name}`))) throw new Error('unsupported_knowledge_migration');
        for (const row of this.#db.prepare('SELECT tenant_id,id,namespace,revision,body FROM knowledge_records').iterate()) {
          const value = record(row['body']);
          if (value.kind === 'personal' || value.owner !== undefined || value.schemaVersion !== undefined || value.tenantId !== row['tenant_id'] ||
            value.id !== row['id'] || value.namespace !== row['namespace'] || value.revision !== row['revision']) throw new Error('invalid_knowledge_storage');
        }
      } else if (tableNames.some(name => this.#exists(`knowledge_${name}`))) throw new Error('invalid_knowledge_storage');
      const columns = 'tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,partition TEXT NOT NULL,principal_id TEXT NOT NULL';
      const key = 'tenant_id,agent_id,partition,principal_id';
      this.#db.exec(`
        CREATE TABLE knowledge_scoped_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL,mode TEXT NOT NULL,binding_id TEXT NOT NULL);
        CREATE TABLE knowledge_records_v2(${columns},id TEXT NOT NULL,namespace TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(${key},id));
        CREATE INDEX knowledge_namespace_v2 ON knowledge_records_v2(${key},namespace);
        CREATE TABLE knowledge_heads_v2(${columns},namespace TEXT NOT NULL,revision INTEGER NOT NULL,cursor INTEGER NOT NULL,error TEXT,PRIMARY KEY(${key},namespace));
        CREATE TABLE knowledge_receipts_v2(${columns},id TEXT NOT NULL,command_id TEXT NOT NULL,digest TEXT NOT NULL,revision INTEGER NOT NULL,audit_body TEXT,PRIMARY KEY(${key},id,command_id));
        CREATE TABLE knowledge_index_v2(${columns},namespace TEXT NOT NULL,id TEXT NOT NULL,document TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(${key},namespace,id));
      `);
      this.#db.prepare('INSERT INTO knowledge_scoped_schema VALUES(1,1,?,?)').run(binding.mode, binding.mode === 'agent' ? binding.agentId : binding.storeId);
      if (legacy) {
        // Preserve the original JSON, receipt digests, revisions and index lag exactly; only the SQL partition is new.
        for (const [name, fields] of [['records', 'id,namespace,revision,body'], ['heads', 'namespace,revision,cursor,error'],
          ['receipts', 'id,command_id,digest,revision'], ['index', 'namespace,id,document,body']] as const) {
          this.#db.prepare(`INSERT INTO knowledge_${name}_v2(${key},${fields}) SELECT tenant_id,?,'work','',${fields} FROM knowledge_${name}`).run(binding.agentId);
          // A pre-migration engine must not keep writing a second canonical copy after migration.
          for (const action of ['INSERT', 'UPDATE', 'DELETE']) this.#db.exec(`CREATE TRIGGER knowledge_${name}_retired_${action.toLowerCase()}
            BEFORE ${action} ON knowledge_${name} BEGIN SELECT RAISE(ABORT,'knowledge_schema_migrated'); END;`);
        }
        this.#db.exec('UPDATE knowledge_schema SET version=2;');
      } else this.#db.exec('CREATE TABLE knowledge_schema(version INTEGER NOT NULL); INSERT INTO knowledge_schema VALUES(2);');
      this.#db.exec('COMMIT;');
    } catch (error) { try { this.#db.exec('ROLLBACK;'); } catch {} throw error; }
  }
  #select(tenantId: string, raw?: KnowledgeStoreScope): Selection {
    if (!this.#binding) {
      this.#legacyMode(); if (raw !== undefined) throw new Error('knowledge_scoped_handle_required');
      return { scope: null, suffix: '', columns: 'tenant_id', where: 'tenant_id=?', args: [tenantId] };
    }
    const retired = this.#assertScoped(this.#binding);
    if (raw === undefined && this.#binding.mode === 'shared') throw new Error('knowledge_scope_required');
    const scope = scopeSchema.parse(raw ?? { agentId: this.#binding.agentId, partition: 'work' });
    if (scope.agentId !== this.#binding.agentId) throw new Error('knowledge_scope_mismatch');
    if (retired && scope.partition === 'personal') throw new Error('personal_memory_source_retired');
    return { scope, suffix: '_v2', columns: 'tenant_id,agent_id,partition,principal_id', where: 'tenant_id=? AND agent_id=? AND partition=? AND principal_id=?',
      args: [name.parse(tenantId), scope.agentId, scope.partition, scope.partition === 'personal' ? scope.principalId : ''] };
  }
  #checkRecord(value: KnowledgeRecord, part: Selection, id?: string, namespace?: string, revision?: unknown) {
    if (part.scope === null) {
      if (value.kind === 'personal' || value.owner !== undefined || value.schemaVersion !== undefined) throw new Error('knowledge_scope_required');
      return value;
    }
    if (value.tenantId !== part.args[0] || id !== undefined && value.id !== id || namespace !== undefined && value.namespace !== namespace ||
      revision !== undefined && value.revision !== revision) throw new Error('invalid_knowledge_storage');
    if (part.scope.partition === 'work') {
      if (value.kind === 'personal' || value.owner !== undefined || value.schemaVersion !== undefined) throw new Error('knowledge_scope_mismatch');
    } else if (value.kind !== 'personal' || value.schemaVersion !== 2 || value.owner?.schemaVersion !== 1 || value.owner.agentId !== part.scope.agentId ||
      value.owner.principalId !== part.scope.principalId || value.authorId !== part.scope.principalId || value.namespace !== 'personal' || value.scope !== 'personal' ||
      value.visibility !== 'private' || value.reviewState !== 'private' || value.review !== null) throw new Error('knowledge_scope_mismatch');
    return value;
  }
  #row(row: Record<string, unknown>, part: Selection) {
    return this.#checkRecord(record(row['body']), part, String(row['id']), String(row['namespace']), row['revision']);
  }
  #namespace(part: Selection, namespace: string) {
    if (part.scope?.partition === 'personal' && namespace !== 'personal') throw new Error('knowledge_scope_mismatch');
  }
  async get(tenantId: string, id: string, scope?: KnowledgeStoreScope): Promise<KnowledgeRecord | null> {
    const part = this.#select(tenantId, scope);
    const row = this.#db.prepare(`SELECT id,namespace,revision,body FROM ${table(part, 'records')} WHERE ${part.where} AND id=?`).get(...part.args, id);
    return row ? this.#row(row, part) : null;
  }
  async receipt(tenantId: string, id: string, commandId: string, scope?: KnowledgeStoreScope) {
    const part = this.#select(tenantId, scope);
    const row = this.#db.prepare(`SELECT digest,revision FROM ${table(part, 'receipts')} WHERE ${part.where} AND id=? AND command_id=?`).get(...part.args, id, commandId);
    return row ? { digest: String(row['digest']), revision: Number(row['revision']) } : null;
  }
  async commit(command: KnowledgeCommit): Promise<KnowledgeCommitResult> {
    const next = parseKnowledge(command.next);
    if (next.kind === 'personal' && command.scope === undefined) throw new Error('knowledge_scope_required');
    if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0 || next.revision !== command.expectedRevision + 1 ||
      !command.commandId || command.commandId.length > 160 || !command.commandDigest) throw new Error('invalid_knowledge_commit');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const part = this.#select(next.tenantId, command.scope); this.#checkRecord(next, part); const keys = part.columns;
      const receipt = this.#db.prepare(`SELECT digest,revision FROM ${table(part, 'receipts')} WHERE ${part.where} AND id=? AND command_id=?`).get(...part.args, next.id, command.commandId);
      if (receipt) {
        this.#db.exec('ROLLBACK');
        return receipt['digest'] === command.commandDigest ? { kind: 'duplicate', revision: Number(receipt['revision']) } : { kind: 'idempotency_conflict' };
      }
      const prior = this.#db.prepare(`SELECT id,namespace,revision,body FROM ${table(part, 'records')} WHERE ${part.where} AND id=?`).get(...part.args, next.id);
      const actualRevision = Number(prior?.['revision'] ?? 0);
      if (actualRevision !== command.expectedRevision) { this.#db.exec('ROLLBACK'); return { kind: 'conflict', actualRevision }; }
      const old = prior ? this.#row(prior, part) : null;
      if (old && (old.namespace !== next.namespace || old.scope !== next.scope || old.authorId !== next.authorId || next.createdAt !== old.createdAt ||
        next.updatedAt < old.updatedAt || next.contentRevision < old.contentRevision || next.contentRevision > old.contentRevision + 1 ||
        old.status !== 'active' && next.status === 'active')) throw new Error('invalid_knowledge_transition');
      this.#db.prepare(`INSERT INTO ${table(part, 'records')}(${keys},id,namespace,revision,body) VALUES(${placeholders(part.args.length + 4)})
        ON CONFLICT(${keys},id) DO UPDATE SET revision=excluded.revision,body=excluded.body`)
        .run(...part.args, next.id, next.namespace, next.revision, JSON.stringify(next));
      const personal = part.scope?.partition === 'personal';
      const cursorUpdate = personal ? ',cursor=CASE WHEN cursor=revision AND error IS NULL THEN revision+1 ELSE cursor END' : '';
      this.#db.prepare(`INSERT INTO ${table(part, 'heads')}(${keys},namespace,revision,cursor,error) VALUES(${placeholders(part.args.length + 1)},1,${personal ? 1 : 0},NULL)
        ON CONFLICT(${keys},namespace) DO UPDATE SET revision=revision+1${cursorUpdate}`).run(...part.args, next.namespace);
      if (personal) {
        if (next.status === 'active') this.#db.prepare(`INSERT INTO ${table(part, 'index')}(${keys},namespace,id,document,body) VALUES(${placeholders(part.args.length + 4)})
          ON CONFLICT(${keys},namespace,id) DO UPDATE SET document=excluded.document,body=excluded.body`)
          .run(...part.args, next.namespace, next.id, document(next), JSON.stringify(next));
        else this.#db.prepare(`DELETE FROM ${table(part, 'index')} WHERE ${part.where} AND namespace=? AND id=?`).run(...part.args, next.namespace, next.id);
      }
      const audit = part.scope ? { fields: ',audit_body', values: ',?', args: [personal ? JSON.stringify({ expectedRevision: command.expectedRevision,
        revision: next.revision, contentRevision: next.contentRevision, previousSources: sourceRefs(old), sources: sourceRefs(next) }) : null] } : { fields: '', values: '', args: [] };
      this.#db.prepare(`INSERT INTO ${table(part, 'receipts')}(${keys},id,command_id,digest,revision${audit.fields}) VALUES(${placeholders(part.args.length + 4)}${audit.values})`)
        .run(...part.args, next.id, command.commandId, command.commandDigest, next.revision, ...audit.args);
      this.#db.exec('COMMIT'); return { kind: 'committed', revision: next.revision };
    } catch (error) { try { this.#db.exec('ROLLBACK'); } catch {} throw error; }
  }
  async indexHead(tenantId: string, namespace: string, scope?: KnowledgeStoreScope): Promise<KnowledgeIndexHead> {
    const part = this.#select(tenantId, scope); this.#namespace(part, namespace);
    const row = this.#db.prepare(`SELECT revision,cursor,error FROM ${table(part, 'heads')} WHERE ${part.where} AND namespace=?`).get(...part.args, namespace);
    return { revision: Number(row?.['revision'] ?? 0), cursor: Number(row?.['cursor'] ?? 0), error: row?.['error'] == null ? null : String(row['error']) };
  }
  async candidates(actor: TrustedKnowledgeActor, query: KnowledgeQuery, maximum: number, scope?: KnowledgeStoreScope): Promise<KnowledgeCandidates> {
    const part = this.#select(actor.tenantId, scope); this.#namespace(part, query.namespace);
    const personal = part.scope?.partition === 'personal';
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 200 || !actor.allowedNamespaces.includes(query.namespace) ||
      !personal && !actor.allowedScopes.includes(query.scope)) throw new Error('invalid_knowledge_index_request');
    if (part.scope && actor.agentId !== undefined && actor.agentId !== part.scope.agentId) throw new Error('knowledge_scope_mismatch');
    if (part.scope?.partition === 'personal' && (actor.agentId !== part.scope.agentId || actor.principalId !== part.scope.principalId ||
      query.scope !== 'personal' || query.kinds.length !== 1 || query.kinds[0] !== 'personal')) throw new Error('knowledge_scope_mismatch');
    const body = `${table(part, 'index')}.body`;
    const visibility = personal ? `json_extract(body,'$.visibility')='private' AND json_extract(body,'$.reviewState')='private' AND json_extract(body,'$.authorId')=?` :
      `(json_extract(body,'$.authorId')=? OR (json_extract(body,'$.visibility')='shared' AND json_extract(body,'$.reviewState')='reviewed') OR (?=1 AND json_extract(body,'$.reviewState')='submitted'))`;
    const permissionArgs = personal ? [actor.principalId] : [actor.principalId, actor.canReview ? 1 : 0];
    const rows = this.#db.prepare(`SELECT id FROM ${table(part, 'index')} WHERE ${part.where} AND namespace=?
      AND json_extract(body,'$.scope')=? AND json_extract(body,'$.status')='active' AND ${visibility}
      AND NOT EXISTS (SELECT 1 FROM json_each(${body},'$.labels') l WHERE l.value NOT IN (SELECT value FROM json_each(?)))
      AND instr(document,?)>0 AND (?='[]' OR json_extract(body,'$.kind') IN (SELECT value FROM json_each(?))) ORDER BY id LIMIT ?`)
      .all(...part.args, query.namespace, query.scope, ...permissionArgs, JSON.stringify(actor.allowedLabels), query.text,
        JSON.stringify(query.kinds), JSON.stringify(query.kinds), maximum + 1);
    return { ids: rows.slice(0, maximum).map(r => String(r['id'])), truncated: rows.length > maximum };
  }
  async rebuildIndex(tenantId: string, namespace: string, scope?: KnowledgeStoreScope): Promise<KnowledgeIndexHead> {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const part = this.#select(tenantId, scope); this.#namespace(part, namespace);
      const rows = this.#db.prepare(`SELECT id,namespace,revision,body FROM ${table(part, 'records')} WHERE ${part.where} AND namespace=? ORDER BY id LIMIT 5001`).all(...part.args, namespace);
      if (rows.length > 5000) throw new Error('index_capacity_exceeded');
      this.#db.prepare(`DELETE FROM ${table(part, 'index')} WHERE ${part.where} AND namespace=?`).run(...part.args, namespace);
      const insert = this.#db.prepare(`INSERT INTO ${table(part, 'index')}(${part.columns},namespace,id,document,body) VALUES(${placeholders(part.args.length + 4)})`);
      for (const row of rows) {
        const r = this.#row(row, part); if (r.status !== 'active') continue;
        insert.run(...part.args, namespace, r.id, document(r), JSON.stringify(r));
      }
      this.#db.prepare(`UPDATE ${table(part, 'heads')} SET cursor=revision,error=NULL WHERE ${part.where} AND namespace=?`).run(...part.args, namespace);
      this.#db.exec('COMMIT'); return this.indexHead(tenantId, namespace, scope);
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch {}
      try { await this.markIndexError(tenantId, namespace, error instanceof Error && error.message === 'index_capacity_exceeded' ? 'index_capacity_exceeded' : 'index_rebuild_failed', scope); } catch {}
      throw error;
    }
  }
  async markIndexError(tenantId: string, namespace: string, code: string, scope?: KnowledgeStoreScope): Promise<void> {
    if (!['index_read_failed', 'index_capacity_exceeded', 'index_rebuild_failed'].includes(code)) throw new Error('invalid_knowledge_index_error');
    const part = this.#select(tenantId, scope); this.#namespace(part, namespace);
    this.#db.prepare(`INSERT INTO ${table(part, 'heads')}(${part.columns},namespace,revision,cursor,error) VALUES(${placeholders(part.args.length + 1)},0,0,?)
      ON CONFLICT(${part.columns},namespace) DO UPDATE SET error=excluded.error`).run(...part.args, namespace, code);
  }
  async close(): Promise<void> { this.#db.close(); }
}
