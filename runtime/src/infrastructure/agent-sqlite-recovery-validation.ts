import type { DatabaseSync } from 'node:sqlite';
import { SqliteRecoveryValidationInputSchema, SqliteRecoveryValidationResultSchema,
  type SqliteRecoveryValidationInput, type SqliteRecoveryValidationResult } from '../application/agent-sqlite-recovery-validation-contracts.js';
import { inspectAgentDatabaseOwner } from './agent-database-owner.js';
import { openHostSqliteDatabase } from './windows-sqlite.js';
import { sqlitePersonalMemoryFence } from './sqlite-personal-memory-migration.js';
import { assertKnowledgeStoreOwner } from './sqlite-knowledge-owner.js';
import { sha256 } from './digest.js';

function fail(reason: string): never { throw Object.assign(new Error(`agent_sqlite_recovery_${reason}`), { code: `agent_sqlite_recovery_${reason}` }); }
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function one(db: DatabaseSync, sql: string) {
  let found: Record<string, unknown> | undefined;
  for (const row of db.prepare(sql).iterate()) { if (found) fail('schema_invalid'); found = row; }
  if (!found) return fail('schema_invalid'); return found;
}
type Column = { name: string; type: 'TEXT' | 'INTEGER'; nullable: boolean };
function columns(text: string): Column[] {
  return text.split(',').map(field => ({ name: field.replace(/[?#]/g, ''), type: field.includes('#') ? 'INTEGER' : 'TEXT', nullable: field.includes('?') }));
}
/** Fixed identifiers and the actual SQLite schemas; PostgreSQL transfer layouts differ. */
function table(db: DatabaseSync, name: string, fields: string, primary: string) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)) fail('schema_invalid');
  const expected = columns(fields), keys = primary.split(','); let index = 0;
  for (const row of db.prepare(`PRAGMA table_info("${name}")`).iterate()) {
    const field = expected[index++];
    if (!field || row['name'] !== field.name || String(row['type']).toUpperCase() !== field.type ||
      row['pk'] !== Math.max(0, keys.indexOf(field.name) + 1) ||
      // INTEGER PRIMARY KEY singleton declarations do not set table_info.notnull.
      (row['notnull'] !== (field.nullable ? 0 : 1) && !(field.name === 'singleton' && row['pk'] === 1 && row['notnull'] === 0))) fail('schema_invalid');
  }
  if (index !== expected.length) fail('schema_invalid');
}
const stateTables = [
  ['works', 'id?,revision#,status,deadline_at#,body', 'id'],
  ['events', 'work_id,sequence#,revision#,command_id,body', 'work_id,sequence'],
  ['receipts', 'work_id,command_id,digest,body', 'work_id,command_id'],
  ['deliveries', 'work_id,id,body', 'work_id,id'],
] as const;
function stateSchema(db: DatabaseSync): number {
  const version = one(db, 'PRAGMA user_version')['user_version'];
  if (version !== 1 && version !== 2 && version !== 3) return fail('schema_unsupported');
  for (const [name, fields, key] of stateTables) table(db, name, fields, key);
  if (version >= 2) {
    table(db, 'event_metadata', 'work_id,sequence#,revision#,type,at#', 'work_id,sequence');
    table(db, 'conversation_work', 'tenant_id,principal_id,channel,conversation_id,work_id', 'tenant_id,principal_id,channel,conversation_id,work_id');
  }
  if (version === 3) {
    for (const name of ['works_query_insert', 'works_query_update', 'works_query_delete', 'events_query_insert', 'events_query_update', 'events_query_delete']) {
      const row = db.prepare("SELECT tbl_name,sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name);
      if (!row || row['tbl_name'] !== (name.startsWith('works_') ? 'works' : 'events') || typeof row['sql'] !== 'string') fail('schema_invalid');
    }
  }
  return version;
}
const memoryTables = [
  ['records', 'id,namespace,revision#,body', 'id'], ['heads', 'namespace,revision#,cursor#,error?', 'namespace'],
  ['receipts', 'id,command_id,digest,revision#', 'id,command_id'], ['index', 'namespace,id,document,body', 'namespace,id'],
] as const;
function memorySchema(db: DatabaseSync, input: SqliteRecoveryValidationInput) {
  assertKnowledgeStoreOwner(db, { mode: 'agent', agentId: input.agentId });
  table(db, 'knowledge_schema', 'version#', '');
  const version = one(db, 'SELECT version FROM knowledge_schema LIMIT 2')['version'];
  if (version !== 1 && version !== 2 && version !== 3) return fail('schema_unsupported');
  const scoped = version !== 1, prefix = scoped ? 'tenant_id,agent_id,partition,principal_id' : 'tenant_id';
  if (scoped) {
    table(db, 'knowledge_scoped_schema', 'singleton#,version#,mode,binding_id', 'singleton');
    const binding = one(db, 'SELECT singleton,version,mode,binding_id FROM knowledge_scoped_schema LIMIT 2');
    if (!same(binding, { singleton: 1, version: 1, mode: 'agent', binding_id: input.agentId })) fail('owner_mismatch');
  }
  for (const [name, fields, key] of memoryTables) {
    const selected = `knowledge_${name}${scoped ? '_v2' : ''}`;
    table(db, selected, `${prefix},${fields}${scoped && name === 'receipts' ? ',audit_body?' : ''}`, `${prefix},${key}`);
    if (scoped && db.prepare(`SELECT 1 FROM ${selected} WHERE agent_id!=? OR partition NOT IN('work','personal') OR (partition='work' AND principal_id!='') OR (partition='personal' AND principal_id='') LIMIT 1`).get(input.agentId)) fail('owner_mismatch');
  }
  const fence = sqlitePersonalMemoryFence(db, input.agentId), selected = input.personalMemory!;
  if (selected.backend === 'documents') {
    if (selected.migrationOperationId !== undefined || selected.expectedFence !== undefined || version === 3) {
      if (version !== 3 || !fence || fence.targetStoreId !== selected.storeId ||
        selected.migrationOperationId !== undefined && fence.operationId !== selected.migrationOperationId ||
        selected.expectedFence !== undefined && !same(fence, selected.expectedFence)) fail('memory_fence_mismatch');
    } else {
      // A profile created with documents from the outset has a schema-2 work DB and no retired personal partition.
      if (version !== 2 || fence) fail('memory_fence_mismatch');
      for (const [name] of memoryTables) if (db.prepare(`SELECT 1 FROM knowledge_${name}_v2 WHERE partition='personal' LIMIT 1`).get()) fail('memory_fence_mismatch');
    }
  } else if (version === 3 || fence) fail('memory_fence_mismatch');
  return { version, fence };
}
const sessionScope = 'tenant_id,agent_id,principal_id,session_id';
const channelTables = [
  ['session_records', 'created_at#,revision#,last_sequence#,active_work_id?,active_input_sequence#,head_body?', ''],
  ['session_inbox', 'message_id,sequence#,status,body', 'message_id'],
  ['session_entries', 'sequence#,role,work_id,user_message_id?,delivery_id?', 'sequence'],
  ['session_heads', 'revision#,through_sequence#,digest,policy_digest', 'revision'],
] as const;
const compactTables = [
  ['session_summaries', 'summary_id,revision#,through_sequence#,policy_digest,body', 'summary_id'],
  ['session_summary_heads', 'summary_id', ''],
  ['session_summary_publications', 'call_id,request_digest,summary_id', 'call_id'],
] as const;
function channelSchema(db: DatabaseSync, agentId: string): number {
  table(db, 'local_messages', 'work_id,delivery_id,digest,external_id,body', 'work_id,delivery_id');
  table(db, 'session_schema', 'singleton#,version#', 'singleton');
  if (!same(one(db, 'SELECT singleton,version FROM session_schema LIMIT 2'), { singleton: 1, version: 1 })) fail('schema_unsupported');
  table(db, 'session_aliases', 'tenant_id,agent_id,principal_id,route,session_id', 'tenant_id,agent_id,principal_id,route');
  const names: string[] = ['session_aliases'];
  for (const [name, fields, key] of channelTables) { table(db, name, `${sessionScope},${fields}`, sessionScope + (key ? `,${key}` : '')); names.push(name); }
  const compact = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN('session_compact_schema','session_summaries','session_summary_heads','session_summary_publications')").all();
  if (compact.length) {
    if (compact.length !== 4) fail('schema_invalid');
    table(db, 'session_compact_schema', 'singleton#,version#', 'singleton');
    if (!same(one(db, 'SELECT singleton,version FROM session_compact_schema LIMIT 2'), { singleton: 1, version: 1 })) fail('schema_unsupported');
    for (const [name, fields, key] of compactTables) { table(db, name, `${sessionScope},${fields}`, sessionScope + (key ? `,${key}` : '')); names.push(name); }
  }
  for (const name of names) if (db.prepare(`SELECT 1 FROM ${name} WHERE agent_id!=? LIMIT 1`).get(agentId)) fail('owner_mismatch');
  return 1;
}

/** Read-only candidate or post-publication validation; the caller owns path/metadata and publication. */
export function validateAgentSqliteRecoveryCandidate(candidatePath: string, rawInput: SqliteRecoveryValidationInput): SqliteRecoveryValidationResult {
  const input = SqliteRecoveryValidationInputSchema.parse(rawInput);
  if (inspectAgentDatabaseOwner(candidatePath, input.agentId, input.kind) !== 'owned') fail('owner_mismatch');
  const db = openHostSqliteDatabase(candidatePath, { readOnly: true, timeout: 5000 });
  let primary: unknown, result: SqliteRecoveryValidationResult | undefined;
  try {
    db.exec('PRAGMA trusted_schema=OFF; BEGIN;');
    table(db, 'agent_storage_owner', 'singleton#,schema_version#,agent_id,kind', 'singleton');
    const owner = one(db, 'SELECT singleton,schema_version,agent_id,kind FROM agent_storage_owner LIMIT 2');
    if (!same(owner, { singleton: 1, schema_version: 1, agent_id: input.agentId, kind: input.kind })) fail('owner_mismatch');
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='secumon_postgres_retirement' LIMIT 1").get()) fail('retired_storage');
    const memory = input.kind === 'memory' ? memorySchema(db, input) : null;
    const schemaVersion = memory?.version ?? (input.kind === 'state' ? stateSchema(db) : channelSchema(db, input.agentId));
    const schema: Array<{ type: string; name: string; table: string; sql: string | null }> = [];
    for (const row of db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").iterate()) {
      if (schema.length >= 512 || typeof row['type'] !== 'string' || typeof row['name'] !== 'string' || typeof row['tbl_name'] !== 'string' ||
        row['sql'] !== null && (typeof row['sql'] !== 'string' || Buffer.byteLength(row['sql']) > 65536)) fail('schema_invalid');
      schema.push({ type: row['type'] as string, name: row['name'] as string, table: row['tbl_name'] as string, sql: row['sql'] as string | null });
    }
    const check = one(db, 'PRAGMA integrity_check(1)'); if (check['integrity_check'] !== 'ok') fail('integrity_failed');
    if (db.prepare('PRAGMA foreign_key_check').get()) fail('integrity_failed');
    result = SqliteRecoveryValidationResultSchema.parse({ agentId: input.agentId, kind: input.kind, schemaVersion,
      pageSize: one(db, 'PRAGMA page_size')['page_size'], pageCount: one(db, 'PRAGMA page_count')['page_count'],
      sqliteVersion: one(db, 'SELECT sqlite_version() AS version')['version'], schemaDigest: sha256(JSON.stringify(schema)), personalMemoryFence: memory?.fence ?? null });
    if (result.pageSize * result.pageCount > 1024 ** 3) fail('capacity_exceeded');
    db.exec('COMMIT;');
  } catch (error) { primary = error; }
  try { db.close(); } catch (error) { if (primary !== undefined) throw new AggregateError([primary, error], 'agent_sqlite_recovery_validation_close_failed', { cause: primary }); throw error; }
  if (primary !== undefined) throw primary;
  return result!;
}
