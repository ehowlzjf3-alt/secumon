import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { EngineRelease } from '../application/agent-lifecycle-contracts.js';
import { AgentProfileError, type AgentProfileStatus } from '../application/agent-profile-contracts.js';
import { inspectAgentDatabaseOwner, type AgentDatabaseKind } from './agent-database-owner.js';
import { assertAgentSetupCompatibility } from './agent-engine-release.js';
import { lifecycleFail } from './agent-lifecycle-files.js';
import { effectiveAgentPostgresSelection } from './agent-postgres-migration-profile.js';
import { readProfileJson } from './agent-profile-files.js';
import { inspectAgentStateProfile } from './agent-state-profile.js';
import { assertDocumentKnowledgeStore, DocumentFiles, DocumentKnowledgeError, inspectUnpreparedDocumentImportRoot } from './document-knowledge-owner.js';
import { inspectJournalOwnership, parseJournalHeader, readJournalMetadata } from './journal-ownership.js';
import { sqlitePersonalMemoryFence } from './sqlite-personal-memory-migration.js';
import { openHostSqliteDatabase } from './windows-sqlite.js';

type Ready = Extract<AgentProfileStatus, { status: 'ready' }>;
type Support = EngineRelease['compatibility'];
export interface AgentStorageCompatibilityOptions { readonly allowUninitialized?: boolean }
const compactTables = ['session_compact_schema', 'session_summaries', 'session_summary_heads', 'session_summary_publications'];
const documentReadySchema = z.strictObject({ schemaVersion: z.literal(1), agentId: z.uuid(), backend: z.literal('documents'), storeId: z.uuid() });

function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
}
function version(db: DatabaseSync, sql: string, singleton = false): number {
  const rows = db.prepare(sql).all(), row = rows[0], value = row?.['version'];
  if (rows.length !== 1 || typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || singleton && row?.['singleton'] !== 1) {
    return lifecycleFail('lifecycle_storage_version_invalid');
  }
  return value;
}
function supported(value: number, versions: readonly number[], code = 'engine_storage_incompatible'): number {
  if (!versions.includes(value)) lifecycleFail(code);
  return value;
}
function uninitialized(db: DatabaseSync, allow: boolean, extraTables: readonly string[] = []): null {
  const names = ['agent_storage_owner', ...extraTables];
  if (db.prepare(`SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND NOT(type='table' AND name IN(${names.map(() => '?').join(',')})) LIMIT 1`).get(...names)) {
    return lifecycleFail('lifecycle_storage_version_invalid');
  }
  if (!allow) lifecycleFail('lifecycle_storage_not_initialized');
  return null;
}
function inspectSqlite<T>(path: string, profile: Ready, kind: AgentDatabaseKind, allow: boolean, inspect: (db: DatabaseSync) => T): T | null {
  if (inspectAgentDatabaseOwner(path, profile.identity.agentId, kind) !== 'owned') {
    if (!allow) lifecycleFail('lifecycle_storage_not_initialized');
    return null;
  }
  const db = openHostSqliteDatabase(path, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN;');
    // Bind this schema snapshot to the owner checked before opening the connection.
    const rows = db.prepare('SELECT singleton,schema_version,agent_id,kind FROM agent_storage_owner LIMIT 2').all(), owner = rows[0];
    if (rows.length !== 1 || owner?.['singleton'] !== 1 || owner['schema_version'] !== 1 || owner['agent_id'] !== profile.identity.agentId || owner['kind'] !== kind) {
      lifecycleFail('lifecycle_storage_owner_mismatch');
    }
    const result = inspect(db); db.exec('COMMIT;'); return result;
  } finally { db.close(); }
}
function inspectCompact(db: DatabaseSync, support: Support): number | null {
  const present = compactTables.filter(name => hasTable(db, name));
  // Compact storage is created lazily in one channel transaction.
  if (present.length === 0) return null;
  if (present.length !== compactTables.length) lifecycleFail('invalid_session_compact_storage');
  return supported(version(db, 'SELECT singleton,version FROM session_compact_schema LIMIT 2', true), support.sessionCompact ?? [1], 'engine_session_compact_incompatible');
}
function inspectDocuments(profile: Ready, support: Support, allow: boolean): void {
  if (profile.effectivePersonalMemory.backend !== 'documents') return;
  const folder = join(profile.root, 'memory', 'documents');
  const binding = { agentId: profile.identity.agentId, storeId: profile.effectivePersonalMemory.storeId, root: profile.root };
  const completed = readProfileJson(join(profile.paths.metadata, 'document-memory-ready.json'), documentReadySchema);
  if (completed && (completed.agentId !== binding.agentId || completed.storeId !== binding.storeId)) lifecycleFail('lifecycle_storage_owner_mismatch');
  const files = new DocumentFiles(folder, binding);
  try {
    if (allow && !completed) {
      const ref = files.directoryRef(folder);
      if (!ref || !files.names(folder, ref).includes('format.json')) {
        try {
          // Reuse the initializer's read-only owner/pending validation. No registration is published here.
          inspectUnpreparedDocumentImportRoot(files); return;
        } catch (error) {
          // A concurrent normal initializer may have completed since enumeration.
          // Validate its complete format below; never accept an incomplete import.
          if (!(error instanceof DocumentKnowledgeError) || error.code !== 'document_knowledge_import_conflict') throw error;
        }
      }
    }
    const descriptor = assertDocumentKnowledgeStore(files);
    supported(descriptor.schemaVersion, support.documents, 'engine_document_storage_incompatible');
  } catch (error) {
    if (error instanceof DocumentKnowledgeError && error.code === 'document_knowledge_store_missing') {
      if (allow && completed) throw new AgentProfileError('agent_document_memory_missing', { cause: error });
      if (!allow) lifecycleFail('lifecycle_document_store_invalid');
    }
    throw error;
  } finally { files.close(); }
}

/** Read-only format preflight, not a full integrity scan or an atomic migration across stores.
 * Per-store constructors retain their transactional migrations and data validation. SQLite may
 * create coordination sidecars even for a read-only connection. Missing formats are allowed only
 * on the ordinary initialization path; ownership/selection binding still runs before writing.
 */
export function inspectAgentLocalStorageCompatibility(profile: Ready, release: Pick<EngineRelease, 'compatibility'>, options: AgentStorageCompatibilityOptions = {}) {
  assertAgentSetupCompatibility(profile.root, release);
  if (profile.postgresMigration?.phase === 'pending' || profile.personalMemoryMigration?.phase === 'pending') lifecycleFail('agent_migration_resume_required');
  const postgres = effectiveAgentPostgresSelection(profile), config = profile.config, support = release.compatibility;
  const allow = options.allowUninitialized === true;
  if (!support.config.includes(config.schemaVersion)) lifecycleFail('engine_config_incompatible');
  if (!postgres?.purposes.includes('state')) inspectAgentStateProfile(profile);
  const state = postgres?.purposes.includes('state') ? null : config.storage.state === 'sqlite' ? inspectSqlite(profile.paths.state, profile, 'state', allow, db => {
    const rows = db.prepare('PRAGMA user_version').all();
    const value = rows[0]?.['user_version'];
    if (rows.length !== 1 || typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return lifecycleFail('lifecycle_storage_version_invalid');
    if (value === 0) return uninitialized(db, allow);
    return supported(value, support.state);
  }) : (() => {
    const owner = { agentId: profile.identity.agentId, kind: 'state' as const };
    if (inspectJournalOwnership(profile.paths.state, owner) === 'uninitialized') {
      if (!allow) lifecycleFail('lifecycle_storage_not_initialized');
      return null;
    }
    return supported(parseJournalHeader(readJournalMetadata(join(profile.paths.state, 'format.json')), owner).schemaVersion, support.journal);
  })();
  const knowledge = postgres?.purposes.includes('knowledge') ? null : inspectSqlite(profile.paths.memory, profile, 'memory', allow, db => {
    if (!hasTable(db, 'knowledge_schema')) return uninitialized(db, allow);
    const value = supported(version(db, 'SELECT version FROM knowledge_schema LIMIT 2'), support.knowledge);
    // Existing metadata-only owner, scoped-format and retirement-fence validation; no body scan.
    sqlitePersonalMemoryFence(db, profile.identity.agentId); return value;
  });
  const channel = postgres?.purposes.includes('channel') ? null : inspectSqlite(join(profile.paths.metadata, 'channel.sqlite'), profile, 'channel', allow, db => {
    // LocalChannel creates this table before the session-schema transaction. Preserve that retry.
    const session = hasTable(db, 'session_schema') ? supported(version(db, 'SELECT singleton,version FROM session_schema LIMIT 2', true), support.session) : uninitialized(db, allow, ['local_messages']);
    return { session, sessionCompact: inspectCompact(db, support) };
  });
  inspectDocuments(profile, support, allow);
  return { config: config.schemaVersion, stateBackend: config.storage.state, state, knowledge, session: channel?.session ?? null,
    sessionCompact: channel?.sessionCompact ?? null, personalMemory: profile.effectivePersonalMemory.backend };
}
