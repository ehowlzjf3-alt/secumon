import { dirname, join } from 'node:path';
import { renameSync } from 'node:fs';
import { openHostSqliteDatabase } from './windows-sqlite.js';
import { z } from 'zod';
import { AgentProfileError, AgentPostgresSelectionSchema, type AgentProfileStore, type AgentProfileStatus } from '../application/agent-profile-contracts.js';
import { acquireAgentMaintenance } from './agent-lifecycle-lease.js';
import { captureLifecycleTree } from './agent-lifecycle-files.js';
import { inspectAgentDatabaseOwner } from './agent-database-owner.js';
import { openProfileMutationScope, profileDirectory, publishProfileJson, readProfileJson, readProfileBytes, syncProfileDirectory } from './agent-profile-files.js';
import { windowsProfileFiles } from './windows-profile-files.js';
import { readWindowsFile, windowsPublicationResult } from './windows-stream-files.js';
import { sha256 } from './digest.js';
import { PostgresMigrationActivationSchema, PostgresMigrationOperationSchema, effectiveAgentPostgresSelection, postgresActivationPath,
  postgresMigrationDigest, postgresMigrationPath, readAgentPostgresMigration, type PostgresMigrationOperation } from './agent-postgres-migration-profile.js';
import { exportLocalAgent, importPostgresAgent } from './postgres-transfer.js';
import { readPostgresTransferPage, writePostgresTransferPage } from './postgres-transfer-files.js';
import { acquirePostgresMaintenance, provisionPostgresStore, postgresTransaction, assertPostgresBindings } from './postgres-store.js';
import { postgresAgentBinding, type AgentPostgresHost } from './agent-postgres-storage.js';
import { POSTGRES_STATE_SCHEMA } from './postgres-state.js';
import { POSTGRES_KNOWLEDGE_SCHEMA } from './postgres-knowledge.js';
import { POSTGRES_CHANNEL_SCHEMA } from './postgres-channel.js';

type Ready = Extract<AgentProfileStatus, { status: 'ready' }>;
type Purpose = 'state' | 'knowledge' | 'channel';
const fail: (code: string) => never = code => { throw new AgentProfileError(code); };
const same = (a: unknown, b: unknown) => postgresMigrationDigest(a) === postgresMigrationDigest(b);
const pageRoot = (profile: Ready) => join(profile.paths.metadata, 'postgres-transfer');
const RetirementSchema = z.strictObject({ schemaVersion: z.literal(1), operationId: z.uuid(), agentId: z.uuid(), snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/) });
const JournalRetirementSchema = z.strictObject({ kind: z.literal('long-horizon-file-journal'), schemaVersion: z.literal(3), storeId: z.uuid(),
  owner: z.strictObject({ agentId: z.uuid(), kind: z.literal('state') }), postgresRetirement: RetirementSchema });
function ready(profiles: AgentProfileStore, directory: string): Ready {
  const profile = profiles.inspect(directory);
  if (profile.status !== 'ready') return fail('agent_profile_not_ready');
  if (profile.personalMemoryMigration?.phase === 'pending') return fail('agent_migration_resume_required');
  return profile;
}
function publish(profile: Ready, path: string, value: unknown) {
  const scope = openProfileMutationScope(profile.root, []);
  try {
    profileDirectory(dirname(path), false, true, scope);
    publishProfileJson(path, value, scope);
    const saved = readProfileJson(path, z.unknown(), undefined, 4 * 1024 * 1024, scope);
    if (!same(saved, value)) fail('agent_postgres_migration_operation_conflict');
    syncProfileDirectory(dirname(path), scope); scope.check();
  } finally { scope.close(); }
}
function sourcePath(profile: Ready, purpose: Purpose) {
  return purpose === 'state' ? profile.paths.state : purpose === 'knowledge' ? profile.paths.memory : join(profile.paths.metadata, 'channel.sqlite');
}
function sourceEntries(profile: Ready, purpose: Purpose) {
  const prefixes = purpose === 'state' ? (profile.config.storage.state === 'file-journal' ? ['.secumon/state-journal'] : ['.secumon/runtime.sqlite']) :
    purpose === 'knowledge' ? ['memory/memory.sqlite'] : ['.secumon/channel.sqlite'];
  const entries = captureLifecycleTree(profile.root, path => prefixes.some(prefix => prefix === path || prefix.startsWith(`${path}/`) || path.startsWith(`${prefix}/`) ||
    path === `${prefix}-wal` || path === `${prefix}-journal`));
  return entries.filter(entry => prefixes.some(prefix => entry.path === prefix || entry.path.startsWith(`${prefix}/`) || entry.path === `${prefix}-wal` || entry.path === `${prefix}-journal`));
}
function retirement(operation: PostgresMigrationOperation) {
  return { schemaVersion: 1 as const, operationId: operation.operationId, agentId: operation.agentId, snapshotDigest: operation.snapshot.digest };
}
function windowsJournalState(profile: Ready, operation: PostgresMigrationOperation) {
  const base = '.secumon/state-journal/', archive = `format-before-postgres-${operation.operationId}.json`;
  const expected = operation.sources.find(source => source.purpose === 'state')?.entries;
  const original = expected?.find(entry => entry.path === `${base}format.json`);
  if (!expected || !original || original.kind !== 'file') return fail('agent_postgres_migration_source_changed');
  const current = readProfileBytes(join(profile.paths.state, 'format.json'), 65536);
  const archived = readProfileBytes(join(profile.paths.state, archive), 65536);
  const bytes = archived ?? current;
  if (!bytes || bytes.length !== original.bytes || sha256(bytes) !== original.sha256) return fail('agent_postgres_migration_source_changed');
  const header = z.strictObject({ kind: z.literal('long-horizon-file-journal'), schemaVersion: z.literal(2), storeId: z.uuid(),
    owner: z.strictObject({ agentId: z.uuid(), kind: z.literal('state') }) }).parse(JSON.parse(bytes.toString('utf8')));
  if (header.owner.agentId !== operation.agentId) return fail('agent_postgres_migration_source_changed');
  const next = Buffer.from(JSON.stringify({ ...header, schemaVersion: 3, postgresRetirement: retirement(operation) }, null, 2) + '\n');
  const candidate = `.secumon-restore-${sha256(JSON.stringify({ operationId: operation.operationId, purpose: 'journal-retirement', snapshotDigest: operation.snapshot.digest }))}.pending`;
  const pending = readProfileBytes(join(profile.paths.state, candidate), 65536);
  if (pending && (!archived || pending.length > next.length || !pending.equals(next.subarray(0, pending.length)))) return fail('agent_postgres_retirement_conflict');
  const final = !!current?.equals(next);
  if (final && (!archived || pending) || current && !final && !current.equals(bytes) || archived && current && !final) return fail('agent_postgres_retirement_conflict');
  const normalized = sourceEntries(profile, 'state').filter(entry => entry.path !== `${base}${candidate}` &&
    (!archived || entry.path !== `${base}format.json`)).map(entry => entry.path === `${base}${archive}` ? { ...entry, path: `${base}format.json` } : entry);
  const sort = (entries: typeof normalized) => [...entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (!same(sort(normalized), sort(expected))) return fail('agent_postgres_migration_source_changed');
  return { archived: !!archived, archive, candidate, current, original: bytes, next, final };
}
function retireWindowsJournal(profile: Ready, operation: PostgresMigrationOperation) {
  let state = windowsJournalState(profile, operation); if (state.final) return;
  const scope = openProfileMutationScope(profile.root, []), files = windowsProfileFiles();
  let writer: ReturnType<ReturnType<typeof files.handle>['recoverableCandidate']> | undefined, primary: unknown;
  try {
    const parent = scope.directory(profile.paths.state, 'private'); if (!parent) return fail('agent_postgres_migration_source_changed');
    const native = files.handle(parent);
    if (!state.archived) {
      if (!native.moveRegular('format.json', state.archive, state.original)) return fail('agent_postgres_migration_source_changed');
      syncProfileDirectory(profile.paths.state, scope); state = windowsJournalState(profile, operation);
    }
    const candidate = files.inspectChild(parent, state.candidate);
    const prefix = candidate ? readWindowsFile(files, parent, state.candidate, state.next.length) : Buffer.alloc(0);
    if (!prefix.equals(state.next.subarray(0, prefix.length))) return fail('agent_postgres_retirement_conflict');
    writer = native.recoverableCandidate('format.json', state.candidate, state.next.length, candidate, 'process-crash');
    writer.append(state.next.subarray(prefix.length)); writer.prepare(); windowsPublicationResult(writer.publish());
    syncProfileDirectory(profile.paths.state, scope); scope.check();
    if (!windowsJournalState(profile, operation).final) return fail('agent_postgres_retirement_conflict');
  } catch (error) { primary = error; throw error; }
  finally {
    const errors: unknown[] = [];
    try { writer?.close(); } catch (error) { errors.push(error); }
    try { scope.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError([...(primary === undefined ? [] : [primary]), ...errors], 'agent_postgres_retirement_close_failed');
  }
}
function sqliteRetired(profile: Ready, purpose: Purpose, operation: PostgresMigrationOperation) {
  const path = sourcePath(profile, purpose), kind = purpose === 'knowledge' ? 'memory' : purpose;
  if (inspectAgentDatabaseOwner(path, profile.identity.agentId, kind) !== 'owned') return fail('agent_storage_owner_mismatch');
  const db = openHostSqliteDatabase(path, { readOnly: true });
  try {
    const present = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='secumon_postgres_retirement'").get();
    if (!present) return false;
    const rows = db.prepare('SELECT body FROM secumon_postgres_retirement').all();
    if (rows.length !== 1 || !same(RetirementSchema.parse(JSON.parse(String(rows[0]!['body']))), retirement(operation))) return fail('agent_postgres_retirement_conflict');
    return true;
  } finally { db.close(); }
}
function retired(profile: Ready, purpose: Purpose, operation: PostgresMigrationOperation) {
  if (purpose !== 'state' || profile.config.storage.state !== 'file-journal') return sqliteRetired(profile, purpose, operation);
  if (process.platform === 'win32') return windowsJournalState(profile, operation).final;
  const header = readProfileJson(join(profile.paths.state, 'format.json'), z.object({ schemaVersion: z.number() }).passthrough(), [1, 2, 3]);
  if (header?.schemaVersion !== 3) return false;
  const saved = JournalRetirementSchema.parse(header);
  if (saved.owner.agentId !== operation.agentId || !same(saved.postgresRetirement, retirement(operation))) return fail('agent_postgres_retirement_conflict');
  return true;
}
function retireSource(profile: Ready, purpose: Purpose, operation: PostgresMigrationOperation) {
  if (retired(profile, purpose, operation)) return;
  if (process.platform === 'win32' && purpose === 'state' && profile.config.storage.state === 'file-journal') return retireWindowsJournal(profile, operation);
  const expected = operation.sources.find(source => source.purpose === purpose);
  if (!expected || !same(sourceEntries(profile, purpose), expected.entries)) return fail('agent_postgres_migration_source_changed');
  if (purpose === 'state' && profile.config.storage.state === 'file-journal') {
    const path = join(profile.paths.state, 'format.json');
    const header = readProfileJson(path, z.strictObject({ kind: z.literal('long-horizon-file-journal'), schemaVersion: z.literal(2), storeId: z.uuid(),
      owner: z.strictObject({ agentId: z.uuid(), kind: z.literal('state') }) }), [2]);
    if (!header || header.owner.agentId !== operation.agentId) return fail('agent_postgres_migration_source_changed');
    const scope = openProfileMutationScope(profile.root, []);
    try {
      publishProfileJson(join(profile.paths.state, `format-before-postgres-${operation.operationId}.json`), header, scope);
      const candidate = join(profile.paths.state, `.postgres-retire-${operation.operationId}.json`);
      const next = { ...header, schemaVersion: 3, postgresRetirement: retirement(operation) };
      publishProfileJson(candidate, next, scope);
      if (!same(readProfileJson(candidate, JournalRetirementSchema, [3], 65536, scope), next) || !same(readProfileJson(path, z.unknown(), [2], 65536, scope), header)) return fail('agent_postgres_migration_source_changed');
      scope.check(); renameSync(candidate, path); syncProfileDirectory(profile.paths.state, scope); scope.check();
    } finally { scope.close(); }
    return;
  }
  const path = sourcePath(profile, purpose), db = openHostSqliteDatabase(path);
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;');
    db.exec('CREATE TABLE secumon_postgres_retirement(singleton INTEGER PRIMARY KEY CHECK(singleton=1),body TEXT NOT NULL)');
    db.prepare('INSERT INTO secumon_postgres_retirement VALUES(1,?)').run(JSON.stringify(retirement(operation)));
    if (purpose === 'state') db.exec('PRAGMA user_version=65535');
    if (purpose === 'knowledge') {
      const personalFence = db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='knowledge_personal_fence_schema_update'").get();
      if (personalFence) db.exec('DROP TRIGGER knowledge_personal_fence_schema_update');
      db.exec('UPDATE knowledge_schema SET version=65535');
      if (personalFence) db.exec("CREATE TRIGGER knowledge_personal_fence_schema_update BEFORE UPDATE ON knowledge_schema BEGIN SELECT RAISE(ABORT,'personal_memory_source_retired'); END");
    }
    if (purpose === 'channel') db.exec('UPDATE session_schema SET version=65535');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='secumon_postgres_retirement'").all();
    for (const row of tables) {
      const table = String(row['name']); if (!/^[a-z_][a-z0-9_]*$/.test(table)) return fail('agent_postgres_migration_table_invalid');
      for (const event of ['INSERT', 'UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER secumon_pg_retired_${table}_${event} BEFORE ${event} ON "${table}" BEGIN SELECT RAISE(ABORT,'agent_storage_migrated_to_postgres'); END;`);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (rollback) { throw new AggregateError([error, rollback], 'agent_postgres_source_retirement_failed'); }
    throw error;
  } finally { db.close(); }
}

/** Saves a bounded original-data snapshot and a durable pending operation. It does not connect to PostgreSQL. */
export async function prepareAgentPostgresMigration(profiles: AgentProfileStore, directory: string,
  options: { operationId: string; selection: AgentPostgresHost['selection']; offline: boolean }) {
  const profile = ready(profiles, directory), operationId = z.uuid().parse(options.operationId);
  const selection = AgentPostgresSelectionSchema.parse(options.selection); selection.purposes.sort();
  const lease = acquireAgentMaintenance(profile.root, options.offline);
  try {
    const existing = readAgentPostgresMigration(profile);
    if (existing) {
      if (existing.operationId !== operationId || !same(existing.selection, selection)) return fail('agent_postgres_migration_operation_conflict');
      return existing;
    }
    const previous = effectiveAgentPostgresSelection(profile);
    if (previous && (previous.storeId !== selection.storeId || previous.registrationId !== selection.registrationId || previous.purposes.some(p => !selection.purposes.includes(p)))) return fail('agent_postgres_migration_target_mismatch');
    const purposes = selection.purposes.filter(purpose => !previous?.purposes.includes(purpose));
    if (!purposes.length) return fail('agent_postgres_migration_has_no_local_source');
    const scope = openProfileMutationScope(profile.root, []);
    try { profileDirectory(pageRoot(profile), true, true, scope); syncProfileDirectory(profile.paths.metadata, scope); } finally { scope.close(); }
    const snapshot = await exportLocalAgent(profile, async (id, page) => { await writePostgresTransferPage(pageRoot(profile), id, page); }, { purposes });
    const operation = PostgresMigrationOperationSchema.parse({ schemaVersion: 1, operationId, agentId: profile.identity.agentId,
      sourceConfigDigest: postgresMigrationDigest(profile.config), sourceSelectionDigest: postgresMigrationDigest(readProfileJson(join(profile.paths.metadata, 'storage-selection.json'), z.unknown())),
      selection, sources: purposes.map(purpose => ({ purpose, entries: sourceEntries(profile, purpose) })), snapshot });
    if (!same(profiles.inspect(directory).status === 'ready' ? ready(profiles, directory).config : null, profile.config)) return fail('agent_postgres_migration_source_changed');
    publish(profile, postgresMigrationPath(profile.root), operation);
    return operation;
  } finally { lease.close(); }
}

/** Imports exact saved rows, retires old writers, then activates the registered target; no goals or receipts are replayed. */
export async function applyAgentPostgresMigration(profiles: AgentProfileStore, directory: string, host: AgentPostgresHost,
  options: { operationId: string; expectedSnapshotDigest: string; offline: boolean }) {
  const profile = ready(profiles, directory), operation = readAgentPostgresMigration(profile);
  if (!operation || operation.operationId !== options.operationId || operation.snapshot.digest !== options.expectedSnapshotDigest) return fail('agent_postgres_migration_operation_conflict');
  const selection = AgentPostgresSelectionSchema.parse(host.selection); selection.purposes.sort();
  if (!same(selection, operation.selection)) return fail('agent_postgres_registration_mismatch');
  const lease = acquireAgentMaintenance(profile.root, options.offline);
  try {
    if (postgresMigrationDigest(readProfileJson(join(profile.paths.metadata, 'storage-selection.json'), z.unknown())) !== operation.sourceSelectionDigest) return fail('agent_storage_selection_mismatch');
    const activated = profile.postgresMigration?.phase === 'activated';
    if (!activated) for (const source of operation.sources) {
      if (process.platform === 'win32' && source.purpose === 'state' && profile.config.storage.state === 'file-journal') { windowsJournalState(profile, operation); continue; }
      if (!retired(profile, source.purpose, operation) && !same(sourceEntries(profile, source.purpose), source.entries)) return fail('agent_postgres_migration_source_changed');
    }
    const schemas = { state: POSTGRES_STATE_SCHEMA, knowledge: POSTGRES_KNOWLEDGE_SCHEMA, channel: POSTGRES_CHANNEL_SCHEMA };
    const allBindings = selection.purposes.map(purpose => postgresAgentBinding(profile, selection, purpose));
    for (const binding of allBindings) {
      if (binding.purpose === 'board') return fail('agent_postgres_registration_mismatch');
      await provisionPostgresStore(host.pool, binding, schemas[binding.purpose], { maintenanceId: operation.operationId });
    }
    const fence = await acquirePostgresMaintenance(host.pool, allBindings, operation.operationId);
    // On failure keep the durable database fence. Exact retry inspects the original import receipt before continuing.
    if (activated) await postgresTransaction(host.pool, false, async client => {
      await assertPostgresBindings(client, allBindings, { maintenanceId: operation.operationId });
      const receipt = (await client.query('SELECT snapshot_digest FROM secumon_pg.transfers WHERE store_id=$1 AND agent_id=$2 AND operation_id=$3',
        [selection.storeId, profile.identity.agentId, operation.operationId])).rows[0];
      if (receipt?.['snapshot_digest'] !== operation.snapshot.digest) return fail('agent_postgres_migration_receipt_missing');
    });
    else {
      await importPostgresAgent(host.pool, allBindings.filter(binding => operation.snapshot.purposes.includes(binding.purpose)), operation.snapshot,
        id => readPostgresTransferPage(pageRoot(profile), id), { operationId: operation.operationId, maintenanceId: operation.operationId });
      for (const source of operation.sources) retireSource(profile, source.purpose, operation);
    }
    const activation = PostgresMigrationActivationSchema.parse({ schemaVersion: 1, operationId: operation.operationId, agentId: operation.agentId,
      operationDigest: postgresMigrationDigest(operation), snapshotDigest: operation.snapshot.digest });
    publish(profile, postgresActivationPath(profile.root), activation);
    await fence.release();
    return { ...activation, phase: 'activated' as const };
  } finally { lease.close(); }
}
