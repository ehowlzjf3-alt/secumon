import type { DatabaseSync } from 'node:sqlite';
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { z } from 'zod';
import type { AgentProfileStatus } from '../application/agent-profile-contracts.js';
import type { CommitRequest } from '../application/ports.js';
import type { Delivery, StoredEvent, WorkState, Json } from '../domain/model.js';
import { validateCommit, validateStateTransition } from '../application/store-contract.js';
import { canonical, sha256 } from './digest.js';
import { agentDatabaseExists } from './agent-database-owner.js';
import { parseJournalHeader, readJournalMetadata } from './journal-ownership.js';
import { sqlitePersonalMemoryFence } from './sqlite-personal-memory-migration.js';
import { hostMetadataFiles, releaseMetadataDirectory, type MetadataDirectory } from './host-metadata-files.js';
import { WindowsMetadataFiles } from './windows-metadata-files.js';
import { windowsProfileNames } from './windows-profile-files.js';
import { readWindowsFile } from './windows-stream-files.js';
import { openHostSqliteDatabase } from './windows-sqlite.js';
import { PostgresBindingSchema, postgresInteger, postgresTransaction, assertPostgresBindings, type PostgresBinding, type PostgresClient, type PostgresPool } from './postgres-store.js';
import { TRANSFER_TABLES, type TransferTable } from './postgres-transfer-tables.js';

export const TRANSFER_LIMITS = Object.freeze({ rowsPerPage: 128, pageBytes: 4 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, pages: 65536 });
const purposeSchema = z.enum(['state', 'knowledge', 'channel', 'board']);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const scalar = z.union([z.string(), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), z.boolean(), z.null()]);
export const TransferPageSchema = z.strictObject({ table: z.string().max(80), columns: z.array(z.string().max(80)).min(1).max(32), rows: z.array(z.array(scalar).max(32)).max(128) });
export type TransferPage = z.infer<typeof TransferPageSchema>;
export const TransferManifestSchema = z.strictObject({
  schemaVersion: z.literal(1), agentId: z.string().min(1).max(256), sourceBindings: z.array(PostgresBindingSchema).max(4),
  purposes: z.array(purposeSchema).min(1).max(4), sourceKinds: z.array(z.enum(['postgres', 'sqlite', 'file-journal'])).min(1).max(3).optional(),
  pages: z.array(z.strictObject({ id: z.string().regex(/^page-[0-9]{8}$/), table: z.string().max(80), rows: z.number().int().min(0).max(128), digest: hash })).max(TRANSFER_LIMITS.pages), digest: hash,
});
export type TransferManifest = z.infer<typeof TransferManifestSchema>;
export type TransferWriter = (id: string, page: TransferPage) => Promise<void>;
export type TransferReader = (id: string) => Promise<TransferPage>;
export class PostgresTransferError extends Error { constructor(readonly code: string, cause?: unknown) { super(code, cause === undefined ? undefined : { cause }); } }
function fail(code = 'postgres_transfer_invalid', cause?: unknown): never { throw new PostgresTransferError(code, cause); }
const serialized = (value: unknown) => canonical(value as Json);
const digest = (value: unknown) => sha256(serialized(value));
const same = (a: unknown, b: unknown) => serialized(a) === serialized(b);
const pageId = (index: number) => `page-${String(index + 1).padStart(8, '0')}`;
function tables(purposes: readonly PostgresBinding['purpose'][]) { return TRANSFER_TABLES.filter(table => purposes.includes(table.purpose)); }
function bindings(raw: readonly PostgresBinding[]) {
  const result = raw.map(value => PostgresBindingSchema.parse(value));
  if (!result.length || result.length > 4 || new Set(result.map(value => value.agentId)).size !== 1 || new Set(result.map(value => value.purpose)).size !== result.length) fail('postgres_transfer_bindings_invalid');
  return result.sort((a, b) => a.purpose.localeCompare(b.purpose, 'en'));
}
function tableFor(name: string): TransferTable { return TRANSFER_TABLES.find(table => table.name === name) ?? fail(); }
function validatePage(raw: unknown): TransferPage {
  const page = TransferPageSchema.parse(raw), table = tableFor(page.table);
  if (!same(page.columns, table.columns) || Buffer.byteLength(JSON.stringify(page)) > TRANSFER_LIMITS.pageBytes) fail('postgres_transfer_page_invalid');
  for (const row of page.rows) {
    if (row.length !== table.columns.length) fail('postgres_transfer_row_invalid');
    table.columns.forEach((column, index) => {
      const value = row[index];
      if (value === null && table.nullable.includes(column)) return;
      if (table.integers.includes(column) ? typeof value !== 'number' : table.booleans.includes(column) ? typeof value !== 'boolean' : typeof value !== 'string') fail('postgres_transfer_row_invalid');
    });
    if (table.purpose === 'knowledge') {
      const partition = row[1], principal = row[2];
      if ((partition !== 'work' && partition !== 'personal') || (partition === 'work') !== (principal === '')) fail('postgres_transfer_scope_invalid');
    }
  }
  return page;
}
export function transferPageDigest(page: TransferPage): string { return digest(validatePage(page)); }
export function validateTransferManifest(raw: unknown): TransferManifest {
  const manifest = TransferManifestSchema.parse(raw), { digest: expected, ...body } = manifest;
  if (digest(body) !== expected || new Set(manifest.purposes).size !== manifest.purposes.length) fail('postgres_transfer_manifest_invalid');
  if (manifest.sourceBindings.length) {
    const sources = bindings(manifest.sourceBindings);
    if (sources[0]!.agentId !== manifest.agentId || !same(sources.map(value => value.purpose).sort(), [...manifest.purposes].sort())) fail('postgres_transfer_bindings_invalid');
  }
  const expectedTables = tables(manifest.purposes).map(table => table.name);
  const seen: string[] = [];
  for (const [index, page] of manifest.pages.entries()) {
    if (page.id !== pageId(index) || !expectedTables.includes(page.table)) fail('postgres_transfer_manifest_invalid');
    if (seen.at(-1) !== page.table) { if (seen.includes(page.table)) fail(); seen.push(page.table); }
    if (page.rows === 0 && (manifest.pages[index - 1]?.table === page.table || manifest.pages[index + 1]?.table === page.table)) fail();
  }
  if (!same(seen, expectedTables)) fail('postgres_transfer_manifest_invalid');
  return manifest;
}
class PageWriter {
  readonly pages: TransferManifest['pages'] = []; total = 0;
  constructor(readonly write: TransferWriter) {}
  async table(table: TransferTable, input: AsyncIterable<unknown[]> | Iterable<unknown[]>) {
    let rows: TransferPage['rows'] = [], emitted = false;
    const emit = async () => {
      const page = validatePage({ table: table.name, columns: [...table.columns], rows });
      this.total += Buffer.byteLength(JSON.stringify(page));
      if (this.total > TRANSFER_LIMITS.totalBytes || this.pages.length >= TRANSFER_LIMITS.pages) fail('postgres_transfer_limit');
      const id = pageId(this.pages.length), entry = { id, table: table.name, rows: rows.length, digest: transferPageDigest(page) };
      await this.write(id, structuredClone(page)); this.pages.push(entry); rows = []; emitted = true;
    };
    for await (const row of input) {
      const normalized = table.columns.map((column, i) => table.integers.includes(column) && row[i] !== null ? postgresInteger(row[i]) : row[i]) as TransferPage['rows'][number];
      if (rows.length && (rows.length === TRANSFER_LIMITS.rowsPerPage || Buffer.byteLength(JSON.stringify({ table: table.name, columns: table.columns, rows: [...rows, normalized] })) > TRANSFER_LIMITS.pageBytes)) await emit();
      rows.push(normalized);
      if (Buffer.byteLength(JSON.stringify({ table: table.name, columns: table.columns, rows })) > TRANSFER_LIMITS.pageBytes) fail('postgres_transfer_row_too_large');
    }
    if (rows.length || !emitted) await emit();
  }
  manifest(agentId: string, sourceBindings: PostgresBinding[], purposes: TransferManifest['purposes'], sourceKinds: NonNullable<TransferManifest['sourceKinds']>) {
    const body = { schemaVersion: 1 as const, agentId, sourceBindings, purposes, sourceKinds, pages: this.pages };
    return validateTransferManifest({ ...body, digest: digest(body) });
  }
}
async function* pgRows(client: PostgresClient, binding: PostgresBinding, table: TransferTable): AsyncGenerator<unknown[]> {
  await client.query(`DECLARE secumon_transfer_cursor NO SCROLL CURSOR FOR SELECT ${table.columns.join(',')} FROM secumon_pg.${table.name} WHERE store_id=$1 AND agent_id=$2 ORDER BY ${table.key.join(',')}`, [binding.storeId, binding.agentId]);
  for (;;) {
    const result = await client.query(`FETCH FORWARD ${TRANSFER_LIMITS.rowsPerPage} FROM secumon_transfer_cursor`);
    for (const row of result.rows) yield table.columns.map(column => table.integers.includes(column) && row[column] !== null ? postgresInteger(row[column]) : row[column]);
    if (result.rows.length < TRANSFER_LIMITS.rowsPerPage) break;
  }
  // On an error the enclosing transaction rolls back and closes the cursor without replacing the original failure.
  await client.query('CLOSE secumon_transfer_cursor');
}
export async function exportPostgresAgent(pool: PostgresPool, rawBindings: readonly PostgresBinding[], writePage: TransferWriter, options: { maintenanceId?: string } = {}): Promise<TransferManifest> {
  const source = bindings(rawBindings), purposes = source.map(value => value.purpose), writer = new PageWriter(writePage);
  return postgresTransaction(pool, false, async client => {
    await assertPostgresBindings(client, source, options);
    for (const table of tables(purposes)) await writer.table(table, pgRows(client, source.find(value => value.purpose === table.purpose)!, table));
    await assertPostgresBindings(client, source, options);
    return writer.manifest(source[0]!.agentId, source, purposes, ['postgres']);
  });
}
async function readPages(manifest: TransferManifest, read: TransferReader) {
  const values = new Map<string, TransferPage['rows']>(); let total = 0;
  for (const entry of manifest.pages) {
    const page = validatePage(await read(entry.id)); total += Buffer.byteLength(JSON.stringify(page));
    if (total > TRANSFER_LIMITS.totalBytes || page.table !== entry.table || page.rows.length !== entry.rows || transferPageDigest(page) !== entry.digest) fail('postgres_transfer_page_mismatch');
    const rows = values.get(page.table) ?? []; rows.push(...page.rows); values.set(page.table, rows);
  }
  return values;
}
export async function importPostgresAgent(pool: PostgresPool, rawBindings: readonly PostgresBinding[], rawManifest: TransferManifest, readPage: TransferReader,
  options: { operationId: string; maintenanceId?: string }): Promise<{ operationId: string; snapshotDigest: string }> {
  const target = bindings(rawBindings), manifest = validateTransferManifest(rawManifest), operationId = z.uuid().parse(options.operationId);
  if (target[0]!.agentId !== manifest.agentId || !same(target.map(value => value.purpose).sort(), [...manifest.purposes].sort())) fail('postgres_transfer_bindings_invalid');
  const content = await readPages(manifest, readPage);
  return postgresTransaction(pool, true, async client => {
    await assertPostgresBindings(client, target, { ...options, lock: true });
    const groups = [...new Set(target.map(binding => binding.storeId))].map(storeId => ({ storeId, purposes: JSON.stringify(target.filter(binding => binding.storeId === storeId).map(binding => binding.purpose).sort()) }));
    let receipts = 0;
    for (const group of groups) {
      const rows = (await client.query('SELECT snapshot_digest,purposes FROM secumon_pg.transfers WHERE store_id=$1 AND agent_id=$2 AND operation_id=$3', [group.storeId, manifest.agentId, operationId])).rows;
      if (rows.length) { if (rows.length !== 1 || rows[0]!['snapshot_digest'] !== manifest.digest || rows[0]!['purposes'] !== group.purposes) fail('postgres_transfer_operation_conflict'); receipts++; }
    }
    if (receipts !== 0 && receipts !== groups.length) fail('postgres_transfer_receipt_incomplete');
    for (const table of tables(manifest.purposes)) {
      const binding = target.find(value => value.purpose === table.purpose)!;
      if (receipts) {
        const expected = content.get(table.name)!.map(serialized).sort(), actual: string[] = []; let bytes = 0;
        for await (const row of pgRows(client, binding, table)) { const text = serialized(row); bytes += Buffer.byteLength(text); if (bytes > TRANSFER_LIMITS.totalBytes || actual.length >= expected.length) fail('postgres_transfer_target_changed'); actual.push(text); }
        if (!same(actual.sort(), expected)) fail('postgres_transfer_target_changed');
      } else if ((await client.query(`SELECT 1 FROM secumon_pg.${table.name} WHERE store_id=$1 AND agent_id=$2 LIMIT 1`, [binding.storeId, binding.agentId])).rows.length) fail('postgres_transfer_target_not_empty');
    }
    if (!receipts) {
      // Identity allocation is table-wide. Prevent another insert between observing and advancing it.
      if (manifest.purposes.includes('channel')) await client.query('LOCK TABLE secumon_pg.local_messages IN SHARE ROW EXCLUSIVE MODE');
      for (const table of tables(manifest.purposes)) {
        const binding = target.find(value => value.purpose === table.purpose)!;
        for (const row of content.get(table.name)!) {
          const values = [binding.storeId, binding.agentId, ...row];
          await client.query(`INSERT INTO secumon_pg.${table.name}(store_id,agent_id,${table.columns.join(',')})${table.name === 'local_messages' ? ' OVERRIDING SYSTEM VALUE' : ''} VALUES(${values.map((_, index) => `$${index + 1}`).join(',')})`, values);
        }
      }
      // nextval is global to the table; increasing it is safe for peers and never rolls it backwards.
      if (manifest.purposes.includes('channel')) {
        const max = content.get('local_messages')!.reduce((value, row) => Math.max(value, row[2] as number), 0);
        if (max) await client.query("SELECT pg_catalog.setval(pg_catalog.pg_get_serial_sequence('secumon_pg.local_messages','sequence'),GREATEST($1,pg_catalog.nextval(pg_catalog.pg_get_serial_sequence('secumon_pg.local_messages','sequence'))),true)", [max]);
      }
      for (const group of groups) await client.query('INSERT INTO secumon_pg.transfers(store_id,agent_id,operation_id,snapshot_digest,purposes) VALUES($1,$2,$3,$4,$5)', [group.storeId, manifest.agentId, operationId, manifest.digest, group.purposes]);
    }
    await assertPostgresBindings(client, target, { ...options, lock: true });
    return { operationId, snapshotDigest: manifest.digest };
  });
}

type LocalProfile = Extract<AgentProfileStatus, { status: 'ready' }>;
type LocalPurpose = 'state' | 'knowledge' | 'channel';
type LocalDatabase = { db: DatabaseSync; path: string; identity: { dev: number; ino: number } | null; empty: boolean; tables: Set<string> };
const localNames = (path: string) => process.platform === 'win32' ? windowsProfileNames(path, 65536) : readdirSync(path).sort();
function localMaintenance(profile: LocalProfile) {
  const path = join(profile.paths.metadata, 'lifecycle-maintenance.json'), bytes = readJournalMetadata(path, 4096);
  const value = z.strictObject({ schemaVersion: z.literal(1), id: z.uuid(), pid: z.number().int().positive(), host: z.string(), createdAt: z.number().int().nonnegative() }).parse(JSON.parse(bytes.toString('utf8')));
  if (value.pid !== process.pid || value.host !== hostname() || localNames(join(profile.paths.metadata, 'runtime-leases')).length) fail('postgres_transfer_local_maintenance_required');
  return () => { if (!bytes.equals(readJournalMetadata(path, 4096)) || localNames(join(profile.paths.metadata, 'runtime-leases')).length) fail('postgres_transfer_local_maintenance_changed'); };
}
function assertLocalFile(value: LocalDatabase) {
  if (!agentDatabaseExists(value.path)) fail('postgres_transfer_source_missing');
  if (!value.identity) return; // The Windows connection guard retains its original main object through close.
  const current = lstatSync(value.path);
  if (value.identity.dev !== current.dev || value.identity.ino !== current.ino) fail('postgres_transfer_source_changed');
}
function openLocal(path: string, agentId: string, purpose: LocalPurpose, documents: boolean): LocalDatabase {
  if (!agentDatabaseExists(path)) fail('postgres_transfer_source_missing');
  const identity = process.platform === 'win32' ? null : lstatSync(path), db = openHostSqliteDatabase(path, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA query_only=ON; BEGIN;');
    const owner = db.prepare('SELECT singleton,schema_version,agent_id,kind FROM agent_storage_owner LIMIT 2').all();
    if (owner.length !== 1 || !same(owner[0], { singleton: 1, schema_version: 1, agent_id: agentId, kind: purpose === 'knowledge' ? 'memory' : purpose })) fail('postgres_transfer_source_owner_invalid');
    const names = new Set<string>();
    for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").iterate()) names.add(String(row['name']));
    const empty = names.size === 1, result = { db, path, identity, empty, tables: names };
    if (!empty) {
      if (purpose === 'state' && db.prepare('PRAGMA user_version').get()?.['user_version'] !== 3) fail('postgres_transfer_source_schema_invalid');
      if (purpose === 'knowledge') {
        const fence = sqlitePersonalMemoryFence(db, agentId);
        const versions = db.prepare('SELECT version FROM knowledge_schema LIMIT 2').all();
        if (versions.length !== 1 || !(versions[0]!['version'] === 2 || documents && versions[0]!['version'] === 3 && fence)) fail('postgres_transfer_source_schema_invalid');
        for (const table of tables(['knowledge'])) if (db.prepare(`SELECT 1 FROM ${table.name}_v2 WHERE agent_id<>? LIMIT 1`).get(agentId)) fail('postgres_transfer_source_owner_invalid');
      }
      if (purpose === 'channel') {
        const schema = db.prepare('SELECT singleton,version FROM session_schema LIMIT 2').all();
        if (schema.length !== 1 || !same(schema[0], { singleton: 1, version: 1 })) fail('postgres_transfer_source_schema_invalid');
        const compact = ['session_compact_schema', 'session_summaries', 'session_summary_heads', 'session_summary_publications'];
        if (compact.some(name => names.has(name))) {
          if (!compact.every(name => names.has(name))) fail('postgres_transfer_source_schema_invalid');
          const versions = db.prepare('SELECT singleton,version FROM session_compact_schema LIMIT 2').all();
          if (versions.length !== 1 || !same(versions[0], { singleton: 1, version: 1 })) fail('postgres_transfer_source_schema_invalid');
        }
        for (const table of tables(['channel']).filter(table => table.name !== 'local_messages' && names.has(table.name))) {
          if (db.prepare(`SELECT 1 FROM ${table.name} WHERE agent_id<>? LIMIT 1`).get(agentId)) fail('postgres_transfer_source_owner_invalid');
        }
      }
    }
    assertLocalFile(result); return result;
  } catch (error) {
    const errors: unknown[] = [error]; try { db.close(); } catch (close) { errors.push(close); }
    if (errors.length > 1) throw new AggregateError(errors, 'postgres_transfer_source_close_failed', { cause: error });
    if (typeof (error as { errcode?: number })?.errcode === 'number' && ((error as { errcode: number }).errcode & 0xff) === 8) fail('postgres_transfer_source_recovery_required', error);
    throw error;
  }
}
function* localRows(source: LocalDatabase, table: TransferTable, agentId: string, documents: boolean): Generator<unknown[]> {
  if (source.empty) return;
  let name = table.name, columns = [...table.columns], where = '', args: string[] = [];
  if (table.purpose === 'knowledge') { name += '_v2'; where = ` WHERE agent_id=?${documents ? " AND partition='work'" : ''}`; args = [agentId]; }
  if (table.purpose === 'channel' && name !== 'local_messages') { where = ' WHERE agent_id=?'; args = [agentId]; }
  if (name === 'state_receipts') name = 'receipts';
  if (name === 'local_messages') columns = columns.map(column => column === 'sequence' ? 'rowid AS sequence' : column);
  if (name === 'events') columns = columns.map(column => column === 'type' || column === 'at' ? `json_extract(body,'$.${column}') AS ${column}` : column);
  if (['session_summaries', 'session_summary_heads', 'session_summary_publications'].includes(name) && !source.tables.has('session_compact_schema')) return;
  for (const row of source.db.prepare(`SELECT ${columns.join(',')} FROM ${name}${where} ORDER BY ${table.key.join(',')}`).iterate(...args)) yield table.columns.map(column => row[column]);
}
const journalRecord = z.strictObject({ schemaVersion: z.literal(1), storeId: z.uuid(), previousHash: hash.nullable(), request: z.unknown(), checksum: hash });
function journalRows(path: string, agentId: string) {
  const files = hostMetadataFiles(), directories = new Map<string, { ref: MetadataDirectory; names: string[] }>(), originals = new Map<string, { directory: MetadataDirectory; name: string; digest: string }>();
  let total = 0;
  const readBytes = (ref: MetadataDirectory, name: string) => files instanceof WindowsMetadataFiles ?
    readWindowsFile(files, ref, name, TRANSFER_LIMITS.totalBytes) : files.readStableRegularFile(ref, name, { maximum: TRANSFER_LIMITS.totalBytes, access: 'private' });
  const namesAt = (location: string, ref: MetadataDirectory) => files instanceof WindowsMetadataFiles ? files.names(ref, 65536) : readdirSync(location).sort();
  function close() {
    const errors: unknown[] = [];
    for (const entry of [...directories.values()].reverse()) try { releaseMetadataDirectory(files, entry.ref); } catch (error) { errors.push(error); }
    directories.clear(); if (errors.length) throw new AggregateError(errors, 'postgres_transfer_source_close_failed');
  }
  function directory(location: string) {
    const ref = files.inspectDirectory(location, 'private'); if (!ref) fail('postgres_transfer_source_missing');
    directories.set(location, { ref, names: [] });
    const names = namesAt(location, ref); directories.set(location, { ref, names }); return { ref, names };
  }
  function read(location: string, ref: MetadataDirectory, name: string) {
    const bytes = readBytes(ref, name); total += bytes.length;
    if (total > TRANSFER_LIMITS.totalBytes) fail('postgres_transfer_limit');
    originals.set(join(location, name), { directory: ref, name, digest: sha256(bytes) }); return bytes;
  }
  try {
  const root = directory(path), header = parseJournalHeader(read(path, root.ref, 'format.json'), { agentId, kind: 'state' });
  const result = new Map<string, unknown[][]>(tables(['state']).map(table => [table.name, []]));
  for (const name of root.names) {
    if (name === 'format.json') continue;
    if (!/^[a-f0-9]{64}$/.test(name)) fail('postgres_transfer_journal_pending_or_invalid');
    const location = join(path, name), folder = directory(location);
    let state: WorkState | null = null, previousHash: string | null = null, sequence = 0;
    const receipts = new Set<string>(), deliveries = new Map<string, Delivery>();
    for (const [index, leaf] of folder.names.entries()) {
      if (leaf !== `${String(index + 1).padStart(16, '0')}.json`) fail('postgres_transfer_journal_gap_or_pending');
      const record = journalRecord.parse(JSON.parse(read(location, folder.ref, leaf).toString('utf8'))), { checksum, ...payload } = record;
      if (sha256(JSON.stringify(payload)) !== checksum || record.storeId !== header.storeId || record.previousHash !== previousHash) fail('postgres_transfer_journal_invalid');
      const request = validateCommit(record.request as CommitRequest), revision = index + 1;
      if (sha256(request.workId) !== name || request.next.revision !== revision || request.expectedRevision !== revision - 1 || receipts.has(request.commandId)) fail('postgres_transfer_journal_invalid');
      validateStateTransition(state, request.next); state = request.next; previousHash = checksum; receipts.add(request.commandId);
      result.get('state_receipts')!.push([request.workId, request.commandId, request.commandDigest, JSON.stringify(request.next)]);
      for (const event of request.events) {
        const stored: StoredEvent = { ...event, workId: request.workId, revision, commandId: request.commandId, sequence: ++sequence };
        result.get('events')!.push([stored.workId, stored.sequence, stored.revision, stored.type, stored.at, stored.commandId, JSON.stringify(stored)]);
      }
      for (const delivery of request.deliveries) deliveries.set(delivery.id, delivery);
    }
    if (state) {
      result.get('works')!.push([state.id, state.revision, state.status, state.deadlineAt, JSON.stringify(state)]);
      for (const delivery of deliveries.values()) result.get('deliveries')!.push([state.id, delivery.id, JSON.stringify(delivery)]);
      const seen = new Set<string>();
      for (const binding of state.conversation?.bindings ?? []) if (binding.tenantId === state.policy.tenantId && binding.principalId === state.policy.principalId) {
        const row = [binding.tenantId, binding.principalId, binding.channel, binding.conversationId, state.id], key = JSON.stringify(row);
        if (!seen.has(key)) result.get('conversation_work')!.push(row); seen.add(key);
      }
    }
  }
  return { rows: result, close, check() {
    for (const [location, entry] of directories) {
      if (!files.inspectDirectory(location, 'private', entry.ref) || !same(namesAt(location, entry.ref), entry.names)) fail('postgres_transfer_source_changed');
    }
    for (const entry of originals.values()) if (sha256(readBytes(entry.directory, entry.name)) !== entry.digest) fail('postgres_transfer_source_changed');
  } };
  } catch (error) {
    try { close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'postgres_transfer_source_close_failed'); }
    throw error;
  }
}
/** Host-only: the caller owns the existing local maintenance barrier and has confirmed external clients are offline. */
export async function exportLocalAgent(rawProfile: LocalProfile, writePage: TransferWriter, options: { purposes?: LocalPurpose[] } = {}): Promise<TransferManifest> {
  const profile = structuredClone(rawProfile), purposes = z.array(z.enum(['state', 'knowledge', 'channel'])).min(1).max(3).parse(options.purposes ?? ['state', 'knowledge', 'channel']);
  if (profile.status !== 'ready' || new Set(purposes).size !== purposes.length || purposes.some(purpose => profile.config.storage.postgres?.purposes.includes(purpose))) fail('postgres_transfer_local_selection_invalid');
  const check = localMaintenance(profile), sources = new Map<LocalPurpose, LocalDatabase>(), writer = new PageWriter(writePage), documents = profile.effectivePersonalMemory.backend === 'documents';
  const errors: unknown[] = []; let result: TransferManifest | undefined;
  let journal: ReturnType<typeof journalRows> | undefined;
  try {
    journal = purposes.includes('state') && profile.config.storage.state === 'file-journal' ? journalRows(profile.paths.state, profile.identity.agentId) : undefined;
    for (const purpose of purposes) {
      if (purpose === 'state' && journal) continue;
      const path = purpose === 'state' ? profile.paths.state : purpose === 'knowledge' ? profile.paths.memory : join(profile.paths.metadata, 'channel.sqlite');
      sources.set(purpose, openLocal(path, profile.identity.agentId, purpose, documents));
    }
    for (const table of tables(purposes)) {
      check();
      if (table.purpose === 'state' && journal) await writer.table(table, journal.rows.get(table.name)!);
      else { const source = sources.get(table.purpose as LocalPurpose)!; assertLocalFile(source); await writer.table(table, localRows(source, table, profile.identity.agentId, documents)); }
    }
    journal?.check(); check();
    for (const source of sources.values()) { assertLocalFile(source); source.db.exec('COMMIT'); }
    result = writer.manifest(profile.identity.agentId, [], purposes, journal ? sources.size ? ['sqlite', 'file-journal'] : ['file-journal'] : ['sqlite']);
  } catch (error) { errors.push(error); }
  for (const source of sources.values()) { try { source.db.close(); } catch (error) { errors.push(error); } }
  try { journal?.close(); } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, 'postgres_transfer_local_cleanup_failed', { cause: errors[0] });
  check(); return result!;
}
