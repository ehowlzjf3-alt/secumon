import { createHash, type Hash } from 'node:crypto';
import { lstatSync, type Stats } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openHostSqliteDatabase } from './windows-sqlite.js';
import { z } from 'zod';
import { parseKnowledge } from '../application/knowledge-contracts.js';
import { SessionScopeSchema } from '../application/session-base-contracts.js';
import { PersonalMemoryFenceSchema, PersonalMemoryMigrationError, PersonalMemoryMigrationScopeSchema,
  PersonalMemorySnapshotSchema, type PersonalMemoryFence, type PersonalMemoryImportedReceipt,
  type PersonalMemoryMigrationScope, type PersonalMemoryNamespaceSnapshot, type PersonalMemorySeedRecord,
  type PersonalMemorySnapshot, type PersonalMemorySnapshotReader } from '../application/personal-memory-migration-contracts.js';
import type { KnowledgeRecord } from '../domain/knowledge.js';
import { agentDatabaseExists, inspectAgentDatabaseOwner } from './agent-database-owner.js';
import { documentDigest, documentHash, documentLimits, documentName, validateDocumentRecord } from './document-knowledge-codec.js';
import { assertKnowledgeStoreOwner, preflightKnowledgeStore } from './sqlite-knowledge-owner.js';

/** Initial administrative support limits, not measured performance targets. */
export const personalMemoryMigrationLimits = Object.freeze({ databaseBytes: 256 * 1024 * 1024, rowBytes: 4 * 1024 * 1024,
  recordBytes: documentLimits.file, namespaces: 2048 });
const tables = ['records', 'receipts', 'heads', 'index'] as const;
const key = 'tenant_id,agent_id,partition,principal_id';
const fields = { records: ['id', 'namespace', 'revision', 'body'], receipts: ['id', 'command_id', 'digest', 'revision', 'audit_body'],
  heads: ['namespace', 'revision', 'cursor', 'error'], index: ['namespace', 'id', 'document', 'body'] } as const;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sourceRefSchema = z.strictObject({ type: z.literal('session_user_receipt'), session: SessionScopeSchema,
  messageId: documentName, sequence: count.positive(), receiptDigest: documentHash });
const auditSchema = z.strictObject({ expectedRevision: count, revision: count.positive(), contentRevision: count.positive(),
  previousSources: z.array(sourceRefSchema).max(64), sources: z.array(sourceRefSchema).min(1).max(64) });
type Audit = z.infer<typeof auditSchema>;
type Row = Record<string, unknown>;
function fail(code: string, cause?: unknown): never { throw new PersonalMemoryMigrationError(code, cause === undefined ? undefined : { cause }); }
const same = (a: unknown, b: unknown) => documentDigest(a) === documentDigest(b);
const sum = (a: number, b: number) => count.parse(a + b);
const hash = () => createHash('sha256');
function add(h: Hash, value: unknown) { h.update(documentDigest(value)).update('\n'); }
const rawDigest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
function one(db: DatabaseSync, sql: string): Row | null {
  let result: Row | null = null;
  for (const row of db.prepare(sql).iterate()) { if (result) fail('personal_memory_migration_source_invalid'); result = row; }
  return result;
}
function transaction(db: DatabaseSync) { if (!db.isTransaction) fail('personal_memory_migration_snapshot_required'); }
function sourceSchema(db: DatabaseSync, agentId: string) {
  z.uuid().parse(agentId); transaction(db);
  // The owner query is a real main-database read and pins the caller's deferred snapshot.
  assertKnowledgeStoreOwner(db, { mode: 'agent', agentId });
  const scoped = one(db, 'SELECT singleton,version,mode,binding_id FROM knowledge_scoped_schema LIMIT 2');
  if (!same(scoped, { singleton: 1, version: 1, mode: 'agent', binding_id: agentId })) fail('personal_memory_migration_source_invalid');
  const version = one(db, 'SELECT version FROM knowledge_schema LIMIT 2');
  if (version?.['version'] !== 2) fail('personal_memory_migration_source_schema_unsupported');
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='knowledge_personal_migration' OR name LIKE 'knowledge_personal_fence_%' LIMIT 1").get()) {
    fail('personal_memory_migration_source_invalid');
  }
  const owner = one(db, 'SELECT singleton,schema_version,agent_id,kind FROM agent_storage_owner LIMIT 2');
  return documentDigest({ owner, scoped });
}
function physical(db: DatabaseSync) {
  const pageSize = count.positive().parse(db.prepare('PRAGMA page_size').get()?.['page_size']);
  const pageCount = count.parse(db.prepare('PRAGMA page_count').get()?.['page_count']);
  if (!Number.isSafeInteger(pageSize * pageCount) || pageSize * pageCount > personalMemoryMigrationLimits.databaseBytes) fail('personal_memory_migration_limit_exceeded');
  const sqliteVersion = z.string().parse(db.prepare('SELECT sqlite_version() AS version').get()?.['version']);
  return { pageSize, pageCount, sqliteVersion };
}
/** Check SQL types and byte lengths before returning any potentially large TEXT cell to JS. */
function preflightRows(db: DatabaseSync, agentId: string) {
  for (const table of tables) {
    const texts = ['tenant_id', 'agent_id', 'partition', 'principal_id', ...fields[table].filter(f => !['revision', 'cursor'].includes(f))];
    const checks = texts.map(f => `(${f} IS NOT NULL AND (typeof(${f})!='text' OR length(CAST(${f} AS BLOB))>${personalMemoryMigrationLimits.rowBytes}))`);
    for (const f of texts.filter(f => f !== 'audit_body' && f !== 'error')) checks.push(`${f} IS NULL`);
    for (const f of fields[table].filter(f => f === 'revision' || f === 'cursor')) checks.push(`(typeof(${f})!='integer' OR ${f}<0 OR ${f}>9007199254740991)`);
    checks.push(`agent_id!=?`, `partition NOT IN ('work','personal')`, `(partition='work' AND principal_id!='')`, `(partition='personal' AND principal_id='')`);
    if (table !== 'receipts') checks.push(`(partition='personal' AND namespace!='personal')`);
    const bytes = texts.map(f => `COALESCE(length(CAST(${f} AS BLOB)),0)`).join('+');
    checks.push(`(${bytes})>${personalMemoryMigrationLimits.rowBytes}`);
    if (db.prepare(`SELECT 1 FROM knowledge_${table}_v2 WHERE ${checks.join(' OR ')} LIMIT 1`).get(agentId)) fail('personal_memory_migration_source_invalid');
  }
}
export function comparePersonalMemoryMigrationScopes(a: PersonalMemoryMigrationScope, b: PersonalMemoryMigrationScope): number {
  const ordered = (scope: PersonalMemoryMigrationScope) => JSON.stringify({ agentId: scope.agentId, namespace: scope.namespace,
    partition: scope.partition, principalId: scope.principalId, tenantId: scope.tenantId });
  return Buffer.compare(Buffer.from(ordered(a)), Buffer.from(ordered(b)));
}
function scopes(db: DatabaseSync): PersonalMemoryMigrationScope[] {
  const found: PersonalMemoryMigrationScope[] = [];
  const sql = tables.map(t => `SELECT tenant_id,agent_id,principal_id FROM knowledge_${t}_v2 WHERE partition='personal'`).join(' UNION ');
  for (const row of db.prepare(`${sql} LIMIT ${personalMemoryMigrationLimits.namespaces + 1}`).iterate()) {
    if (found.length === personalMemoryMigrationLimits.namespaces) fail('personal_memory_migration_limit_exceeded');
    found.push(PersonalMemoryMigrationScopeSchema.parse({ tenantId: row['tenant_id'], agentId: row['agent_id'], principalId: row['principal_id'],
      partition: 'personal', namespace: 'personal' }));
  }
  // canonical scope keys are fixed; agent/partition/namespace are equal for this source.
  return found.sort(comparePersonalMemoryMigrationScopes);
}
const where = 'tenant_id=? AND agent_id=? AND partition=\'personal\' AND principal_id=?';
const args = (scope: PersonalMemoryMigrationScope) => [scope.tenantId, scope.agentId, scope.principalId];
function sourceRefs(record: KnowledgeRecord) {
  return record.sources.map(s => {
    if (s.type !== 'session_user_receipt') return fail('personal_memory_migration_source_invalid');
    return { type: s.type, session: s.session, messageId: s.messageId, sequence: s.sequence, receiptDigest: s.receiptDigest };
  });
}
function recordRow(row: Row, scope: PersonalMemoryMigrationScope): KnowledgeRecord {
  const record = parseKnowledge(JSON.parse(z.string().parse(row['body']))); validateDocumentRecord(record, scope);
  if (record.id !== row['id'] || record.namespace !== row['namespace'] || record.revision !== row['revision']) fail('personal_memory_migration_source_invalid');
  documentName.parse(record.id);
  return record;
}
function receipts(db: DatabaseSync, scope: PersonalMemoryMigrationScope, record: KnowledgeRecord): PersonalMemoryImportedReceipt[] {
  const result: PersonalMemoryImportedReceipt[] = []; let last: Audit | null = null;
  let bytes = Buffer.byteLength(JSON.stringify(record));
  if (bytes > personalMemoryMigrationLimits.recordBytes) fail('personal_memory_migration_limit_exceeded');
  for (const row of db.prepare(`SELECT command_id,digest,revision,audit_body FROM knowledge_receipts_v2 WHERE ${where} AND id=? ORDER BY revision,command_id COLLATE BINARY`).iterate(...args(scope), record.id)) {
    const receipt = { commandId: documentName.parse(row['command_id']), digest: documentHash.parse(row['digest']),
      revision: count.positive().parse(row['revision']), auditJson: z.string().parse(row['audit_body']) };
    bytes = sum(bytes, Buffer.byteLength(JSON.stringify(receipt)));
    if (bytes > personalMemoryMigrationLimits.recordBytes) fail('personal_memory_migration_limit_exceeded');
    if (receipt.revision !== result.length + 1 || receipt.revision > record.revision) fail('personal_memory_migration_receipts_invalid');
    const audit = auditSchema.parse(JSON.parse(receipt.auditJson));
    if (audit.revision !== receipt.revision || audit.expectedRevision !== audit.revision - 1 || audit.contentRevision > audit.revision ||
      last && (audit.contentRevision < last.contentRevision || audit.contentRevision > last.contentRevision + 1) ||
      !same(audit.previousSources, last?.sources ?? []) || [...audit.previousSources, ...audit.sources].some(s =>
        s.session.agentId !== scope.agentId || s.session.tenantId !== scope.tenantId || s.session.principalId !== scope.principalId)) fail('personal_memory_migration_audit_invalid');
    result.push(receipt); last = audit;
  }
  if (result.length !== record.revision || !last || last.contentRevision !== record.contentRevision || !same(last.sources, sourceRefs(record))) fail('personal_memory_migration_receipts_invalid');
  return result;
}
function* seedRecords(db: DatabaseSync, scope: PersonalMemoryMigrationScope): Iterable<PersonalMemorySeedRecord> {
  for (const row of db.prepare(`SELECT id,namespace,revision,body FROM knowledge_records_v2 WHERE ${where} ORDER BY id COLLATE BINARY`).iterate(...args(scope))) {
    transaction(db); const record = recordRow(row, scope);
    yield { record, sourceRecordJsonDigest: rawDigest(z.string().parse(row['body'])), receipts: receipts(db, scope, record) };
  }
}
/** Repeatable record-sized reads from the caller's fixed, already inspected snapshot. */
export function* readPersonalMemorySeedRecords(db: DatabaseSync, agentId: string, rawScope: PersonalMemoryMigrationScope): Iterable<PersonalMemorySeedRecord> {
  sourceSchema(db, agentId); physical(db); preflightRows(db, agentId);
  const scope = PersonalMemoryMigrationScopeSchema.parse(rawScope);
  if (scope.agentId !== agentId) fail('personal_memory_migration_source_invalid');
  yield* seedRecords(db, scope);
}
function namespaceSnapshot(db: DatabaseSync, scope: PersonalMemoryMigrationScope): PersonalMemoryNamespaceSnapshot {
  const currentHash = hash(), receiptsHash = hash(), indexHash = hash();
  let records = 0, receiptCount = 0, activeRecords = 0, indexCount = 0;
  for (const entry of seedRecords(db, scope)) {
    records = sum(records, 1); receiptCount = sum(receiptCount, entry.receipts.length);
    if (records + 2 > documentLimits.entries) fail('personal_memory_migration_limit_exceeded');
    add(currentHash, { id: entry.record.id, sourceRecordJsonDigest: entry.sourceRecordJsonDigest });
    for (const receipt of entry.receipts) add(receiptsHash, { id: entry.record.id, ...receipt });
    const indexed = db.prepare(`SELECT document,body FROM knowledge_index_v2 WHERE ${where} AND namespace='personal' AND id=?`).get(...args(scope), entry.record.id);
    if (entry.record.status === 'active') {
      activeRecords++;
      if (!indexed || indexed['document'] !== `${entry.record.title}\n${entry.record.body}`.normalize('NFC').toLocaleLowerCase('en-US') ||
        !same(parseKnowledge(JSON.parse(z.string().parse(indexed['body']))), entry.record)) fail('personal_memory_migration_index_invalid');
    } else if (indexed) fail('personal_memory_migration_index_invalid');
  }
  let actualReceipts = 0;
  for (const _row of db.prepare(`SELECT 1 FROM knowledge_receipts_v2 WHERE ${where}`).iterate(...args(scope))) actualReceipts = sum(actualReceipts, 1);
  if (actualReceipts !== receiptCount) fail('personal_memory_migration_receipts_invalid');
  for (const row of db.prepare(`SELECT id,document,body FROM knowledge_index_v2 WHERE ${where} ORDER BY id COLLATE BINARY`).iterate(...args(scope))) {
    documentName.parse(row['id']); indexCount = sum(indexCount, 1);
    add(indexHash, { id: row['id'], document: row['document'], sourceRecordJsonDigest: rawDigest(z.string().parse(row['body'])) });
  }
  if (indexCount !== activeRecords) fail('personal_memory_migration_index_invalid');
  const rawHead = db.prepare(`SELECT revision,cursor,error FROM knowledge_heads_v2 WHERE ${where} AND namespace='personal'`).get(...args(scope));
  if (!rawHead || rawHead['revision'] !== receiptCount || rawHead['cursor'] !== receiptCount || rawHead['error'] !== null) fail('personal_memory_migration_head_invalid');
  return { scope, records, receipts: receiptCount, audits: receiptCount, activeRecords,
    head: { revision: receiptCount, cursor: receiptCount, error: null }, currentRecordsDigest: currentHash.digest('hex'),
    receiptsDigest: receiptsHash.digest('hex'), indexDigest: indexHash.digest('hex') };
}
function workDigest(db: DatabaseSync) {
  const result = hash();
  for (const table of tables) {
    add(result, table);
    const order = [key, ...fields[table].filter(f => ['id', 'namespace', 'command_id'].includes(f))].join(',');
    for (const row of db.prepare(`SELECT ${key},${fields[table].join(',')} FROM knowledge_${table}_v2 WHERE partition='work' ORDER BY ${order}`).iterate()) add(result, row);
  }
  return result.digest('hex');
}
export function inspectPersonalMemorySnapshot(db: DatabaseSync, agentId: string): PersonalMemorySnapshot & { pageSize: number; pageCount: number; sqliteVersion: string } {
  const ownerDigest = sourceSchema(db, agentId), physicalInfo = physical(db); preflightRows(db, agentId);
  const namespaces = scopes(db).map(scope => namespaceSnapshot(db, scope));
  const snapshot = PersonalMemorySnapshotSchema.parse({ agentId, ownerDigest, knowledgeSchemaVersion: 2, scopedSchemaVersion: 1,
    namespaces, snapshotDigest: documentDigest(namespaces), workDigest: workDigest(db) });
  return { ...snapshot, ...physicalInfo };
}
export function personalMemorySnapshotReader(db: DatabaseSync, agentId: string): PersonalMemorySnapshotReader {
  const { pageSize: _pageSize, pageCount: _pageCount, sqliteVersion: _sqliteVersion, ...snapshot } = inspectPersonalMemorySnapshot(db, agentId);
  return { snapshot, records(scope) {
    transaction(db);
    if (!snapshot.namespaces.some(namespace => same(namespace.scope, scope))) fail('personal_memory_migration_scope_unavailable');
    // The preceding full inspection already bounded SQL cells on this same transaction.
    return seedRecords(db, scope);
  } };
}

const fenceTable = 'knowledge_personal_migration';
const triggerDefinitions = tables.flatMap(table => ['INSERT', 'UPDATE', 'DELETE'].map(action => {
  const condition = action === 'INSERT' ? "NEW.partition='personal'" : action === 'DELETE' ? "OLD.partition='personal'" : "OLD.partition='personal' OR NEW.partition='personal'";
  const name = `knowledge_personal_fence_${table}_${action.toLowerCase()}`;
  return { name, sql: `CREATE TRIGGER ${name} BEFORE ${action} ON knowledge_${table}_v2 WHEN ${condition} BEGIN SELECT RAISE(ABORT,'personal_memory_source_retired'); END` };
}));
const immutableDefinitions = ['INSERT', 'UPDATE', 'DELETE'].map(action => ({ name: `knowledge_personal_fence_owner_${action.toLowerCase()}`,
  sql: `CREATE TRIGGER knowledge_personal_fence_owner_${action.toLowerCase()} BEFORE ${action} ON ${fenceTable} BEGIN SELECT RAISE(ABORT,'personal_memory_source_retired'); END` }));
const schemaDefinitions = ['INSERT', 'UPDATE', 'DELETE'].map(action => ({ name: `knowledge_personal_fence_schema_${action.toLowerCase()}`,
  sql: `CREATE TRIGGER knowledge_personal_fence_schema_${action.toLowerCase()} BEFORE ${action} ON knowledge_schema BEGIN SELECT RAISE(ABORT,'personal_memory_source_retired'); END` }));
const allTriggers = [...triggerDefinitions, ...immutableDefinitions, ...schemaDefinitions];
/** Validates the cheap persistent retirement boundary, without reading personal bodies. */
export function sqlitePersonalMemoryFence(db: DatabaseSync, agentId: string): PersonalMemoryFence | null {
  assertKnowledgeStoreOwner(db, { mode: 'agent', agentId });
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_schema'").get()) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name!='agent_storage_owner' LIMIT 1").get()) fail('personal_memory_migration_fence_invalid');
    return null;
  }
  const version = one(db, 'SELECT version FROM knowledge_schema LIMIT 2');
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(fenceTable);
  // A later work-store migration preserves the independently retired personal partition and its original fence.
  let postgresRetired = false;
  if (version?.['version'] === 65535 && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='secumon_postgres_retirement'").get()) {
    const retired = one(db, 'SELECT singleton,body FROM secumon_postgres_retirement LIMIT 2');
    if (retired?.['singleton'] !== 1 || typeof retired['body'] !== 'string' || Buffer.byteLength(retired['body']) > 4096) fail('personal_memory_migration_fence_invalid');
    const parsed = z.strictObject({ schemaVersion: z.literal(1), operationId: z.uuid(), agentId: z.uuid(), snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/) }).parse(JSON.parse(retired['body']));
    if (parsed.agentId !== agentId) fail('personal_memory_migration_fence_invalid');
    postgresRetired = true;
    if (!exists) return null;
  }
  if (version?.['version'] === 1 && !exists) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='knowledge_scoped_schema' OR name LIKE 'knowledge_personal_fence_%' OR name GLOB 'knowledge_*_v2' LIMIT 1").get() ||
      tables.some(table => !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(`knowledge_${table}`))) fail('personal_memory_migration_fence_invalid');
    return null;
  }
  if (version?.['version'] === 2 && !exists) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE 'knowledge_personal_fence_%' LIMIT 1").get()) fail('personal_memory_migration_fence_invalid');
    const scoped = one(db, 'SELECT singleton,version,mode,binding_id FROM knowledge_scoped_schema LIMIT 2');
    if (!same(scoped, { singleton: 1, version: 1, mode: 'agent', binding_id: agentId }) || tables.some(table =>
      !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(`knowledge_${table}_v2`))) fail('personal_memory_migration_fence_invalid');
    return null;
  }
  if (version?.['version'] !== 3 && !postgresRetired || !exists) fail('personal_memory_migration_fence_invalid');
  if (db.prepare(`SELECT 1 FROM ${fenceTable} WHERE typeof(body)!='text' OR length(CAST(body AS BLOB))>4096 LIMIT 1`).get()) fail('personal_memory_migration_fence_invalid');
  const row = one(db, `SELECT singleton,body FROM ${fenceTable} LIMIT 2`);
  if (row?.['singleton'] !== 1 || typeof row['body'] !== 'string' || Buffer.byteLength(row['body']) > 4096) fail('personal_memory_migration_fence_invalid');
  const fence = PersonalMemoryFenceSchema.parse(JSON.parse(row['body']));
  const scoped = one(db, 'SELECT singleton,version,mode,binding_id FROM knowledge_scoped_schema LIMIT 2');
  const owner = one(db, 'SELECT singleton,schema_version,agent_id,kind FROM agent_storage_owner LIMIT 2');
  if (fence.agentId !== agentId || !same(scoped, { singleton: 1, version: 1, mode: 'agent', binding_id: agentId }) ||
    fence.ownerDigest !== documentDigest({ owner, scoped })) fail('personal_memory_migration_fence_invalid');
  let count = 0;
  for (const trigger of db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'knowledge_personal_fence_%'").iterate()) {
    const expected = allTriggers.find(t => t.name === trigger['name']);
    if (!expected || expected.sql !== trigger['sql']) fail('personal_memory_migration_fence_invalid');
    count++;
  }
  if (count !== allTriggers.length) fail('personal_memory_migration_fence_invalid');
  return fence;
}
function ownedPath(path: string, agentId: string) {
  preflightKnowledgeStore(path, { mode: 'agent', agentId });
  if (!agentDatabaseExists(path)) fail('personal_memory_migration_source_missing');
  return process.platform === 'win32' ? null : lstatSync(path);
}
function samePath(path: string, before: Stats | null) {
  // Windows openHostSqliteDatabase retains and checks the original main object before/after COMMIT.
  if (before === null) return;
  if (!agentDatabaseExists(path)) fail('personal_memory_migration_source_changed');
  const now = lstatSync(path);
  if (now.dev !== before.dev || now.ino !== before.ino) fail('personal_memory_migration_source_changed');
}
export function readSqlitePersonalMemoryFence(path: string, agentId: string): PersonalMemoryFence | null {
  // A normal profile inspection can observe an exclusive-created file before its owner transaction.
  // Administrative snapshot/fence APIs use ownedPath and never adopt this empty state.
  const state = inspectAgentDatabaseOwner(path, agentId, 'memory');
  if (state === 'missing' || state === 'empty') return null;
  if (process.platform === 'win32') {
    const db = openHostSqliteDatabase(path, { readOnly: true });
    try { db.exec('PRAGMA busy_timeout=5000; BEGIN;'); const result = sqlitePersonalMemoryFence(db, agentId); db.exec('COMMIT'); return result; }
    finally { db.close(); }
  }
  const before = ownedPath(path, agentId); const db = new DatabaseSync(path, { readOnly: true });
  try { db.exec('PRAGMA busy_timeout=5000; BEGIN;'); const result = sqlitePersonalMemoryFence(db, agentId); samePath(path, before); db.exec('COMMIT'); return result; }
  finally { db.close(); }
}
/** Irreversible in D3: only an identical operation may resume; work writes remain permitted. */
export function fenceSqlitePersonalMemory(path: string, input: PersonalMemoryFence): PersonalMemoryFence {
  const expected = PersonalMemoryFenceSchema.parse(input), before = ownedPath(path, expected.agentId);
  const db = openHostSqliteDatabase(path);
  let primary: { error: unknown } | undefined;
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
    const existing = sqlitePersonalMemoryFence(db, expected.agentId);
    if (existing) {
      if (!same(existing, expected)) fail('personal_memory_migration_fence_conflict');
      samePath(path, before); db.exec('COMMIT'); return existing;
    }
    const current = inspectPersonalMemorySnapshot(db, expected.agentId);
    if (current.snapshotDigest !== expected.snapshotDigest || current.ownerDigest !== expected.ownerDigest || current.workDigest !== expected.workDigest) {
      fail('personal_memory_migration_source_changed');
    }
    db.exec(`CREATE TABLE ${fenceTable}(singleton INTEGER PRIMARY KEY CHECK(singleton=1),body TEXT NOT NULL)`);
    db.prepare(`INSERT INTO ${fenceTable} VALUES(1,?)`).run(JSON.stringify(expected));
    db.exec('UPDATE knowledge_schema SET version=3');
    for (const trigger of allTriggers) db.exec(trigger.sql);
    samePath(path, before); db.exec('COMMIT'); return expected;
  } catch (error) {
    primary = { error };
    if (process.platform === 'win32') {
      try { if (db.isTransaction) db.exec('ROLLBACK'); }
      catch (rollback) { primary.error = new AggregateError([error, rollback], 'personal_memory_fence_rollback_failed', { cause: error }); }
    } else { try { db.exec('ROLLBACK'); } catch {} }
    throw primary.error;
  } finally {
    try { db.close(); } catch (close) {
      if (primary && process.platform === 'win32') throw new AggregateError([primary.error, close], 'personal_memory_fence_close_failed', { cause: primary.error });
      throw close;
    }
  }
}
