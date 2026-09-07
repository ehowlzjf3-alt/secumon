import { dirname, join } from 'node:path';
import { z } from 'zod';
import { AgentPostgresSelectionSchema, AgentProfileError, type AgentPostgresSelection, type AgentProfileStatus, type AgentProfileStore } from '../application/agent-profile-contracts.js';
import { agentDatabaseExists } from './agent-database-owner.js';
import { openProfileMutationScope, profileDirectory, profileStat, publishProfileJson, readProfileJson, syncProfileDirectory } from './agent-profile-files.js';
import { PostgresStore, provisionPostgresStore, type PostgresBinding, type PostgresPool } from './postgres-store.js';
import { POSTGRES_STATE_SCHEMA } from './postgres-state.js';
import { POSTGRES_KNOWLEDGE_SCHEMA } from './postgres-knowledge.js';
import { POSTGRES_CHANNEL_SCHEMA } from './postgres-channel.js';
import { acquireAgentMaintenance } from './agent-lifecycle-lease.js';
import { sha256 } from './digest.js';
import { effectiveAgentPostgresSelection, readAgentPostgresMigration, postgresMigrationDigest } from './agent-postgres-migration-profile.js';

type Ready = Extract<AgentProfileStatus, { status: 'ready' }>;
export interface AgentPostgresHost { readonly selection: AgentPostgresSelection; readonly pool: PostgresPool }
const SelectionSchema = z.strictObject({ schemaVersion: z.literal(1), agentId: z.uuid(), postgres: AgentPostgresSelectionSchema.nullable() });
const fail = (code: string): never => { throw new AgentProfileError(code); };
function selected(value: AgentPostgresSelection | undefined) {
  if (!value) return null;
  const parsed = AgentPostgresSelectionSchema.parse(value);
  parsed.purposes.sort(); return parsed;
}
const equal = (a: unknown, b: unknown) => sha256(JSON.stringify(a)) === sha256(JSON.stringify(b));
function noLocalSource(profile: Ready, pg: AgentPostgresSelection) {
  if (pg.purposes.includes('state') && (agentDatabaseExists(join(profile.paths.metadata, 'runtime.sqlite')) || profileStat(join(profile.paths.metadata, 'state-journal')))) fail('agent_postgres_migration_required');
  if (pg.purposes.includes('knowledge') && agentDatabaseExists(profile.paths.memory)) fail('agent_postgres_migration_required');
  if (pg.purposes.includes('channel') && agentDatabaseExists(join(profile.paths.metadata, 'channel.sqlite'))) fail('agent_postgres_migration_required');
  if (profile.personalMemoryMigration) fail('agent_postgres_migration_required');
}

/** Pins configured storage before any backend opens. A missing registered server never becomes an empty local store. */
export function bindAgentStorageSelection(profile: Ready, host?: AgentPostgresHost): AgentPostgresSelection | null {
  if (profile.postgresMigration?.phase === 'pending') return fail('agent_postgres_migration_resume_required');
  const migrated = profile.postgresMigration?.phase === 'activated';
  const pg = selected(effectiveAgentPostgresSelection(profile) ?? undefined);
  if (host && !equal(pg, selected(host.selection))) fail('agent_postgres_registration_mismatch');
  if (pg && !host) fail('agent_postgres_registration_required');
  if (!pg && host) fail('agent_postgres_selection_required');
  const expected = { schemaVersion: 1 as const, agentId: profile.identity.agentId, postgres: pg };
  const path = join(profile.paths.metadata, 'storage-selection.json'), scope = openProfileMutationScope(profile.root, []);
  try {
    profileDirectory(profile.paths.metadata, false, true, scope);
    const saved = readProfileJson(path, SelectionSchema, [1], 65536, scope);
    if (migrated) {
      const operation = readAgentPostgresMigration(profile);
      if (!operation || postgresMigrationDigest(saved) !== operation.sourceSelectionDigest || !equal(selected(operation.selection), pg)) return fail('agent_storage_selection_mismatch');
    } else if (saved && !equal(saved, expected)) fail('agent_storage_selection_mismatch');
    if (pg && !migrated) noLocalSource(profile, pg);
    if (!saved && !migrated) {
      // Previously opened local profiles need a real migration, even if somebody removed a main database file.
      if (pg && [join(profile.paths.metadata, 'state-profile.json'), join(profile.paths.metadata, 'personal-memory-profile.json'),
        join(dirname(profile.paths.memory), 'documents')].some(path => profileStat(path))) fail('agent_postgres_migration_required');
      publishProfileJson(path, expected, scope);
    }
    if (!migrated && !equal(readProfileJson(path, SelectionSchema, [1], 65536, scope), expected)) fail('agent_storage_selection_mismatch');
    syncProfileDirectory(profile.paths.metadata, scope); scope.check();
    return pg;
  } finally { scope.close(); }
}

export function postgresAgentBinding(profile: Ready, selection: AgentPostgresSelection, purpose: PostgresBinding['purpose']): PostgresBinding {
  return { storeId: selection.storeId, registrationId: selection.registrationId, agentId: profile.identity.agentId, purpose };
}
export async function openAgentPostgresStore(profile: Ready, selection: AgentPostgresSelection, host: AgentPostgresHost, purpose: 'state' | 'knowledge' | 'channel') {
  if (!selection.purposes.includes(purpose) || !equal(selected(selection), selected(host.selection))) return fail('agent_postgres_registration_mismatch');
  return PostgresStore.open(host.pool, postgresAgentBinding(profile, selection, purpose));
}
/** A host-only setup step for a new assignment, or an exact retry of that provisioning. */
export async function provisionAgentPostgresStorage(profiles: AgentProfileStore, directory: string, host: AgentPostgresHost, offline: boolean) {
  const profile = profiles.inspect(directory);
  if (profile.status !== 'ready') return fail('agent_profile_not_ready');
  const lease = acquireAgentMaintenance(profile.root, offline);
  let failure: unknown, failed = false;
  try {
    const selection = bindAgentStorageSelection(profile, host);
    if (!selection) return fail('agent_postgres_selection_required');
    const schemas = { state: POSTGRES_STATE_SCHEMA, knowledge: POSTGRES_KNOWLEDGE_SCHEMA, channel: POSTGRES_CHANNEL_SCHEMA };
    for (const purpose of selection.purposes) await provisionPostgresStore(host.pool, postgresAgentBinding(profile, selection, purpose), schemas[purpose]);
    return { agentId: profile.identity.agentId, selection, schemaVersion: 1 as const };
  } catch (error) { failed = true; failure = error; throw error; }
  finally {
    try { lease.close(); } catch (error) { if (failed) throw new AggregateError([failure, error], 'agent_postgres_provision_cleanup_failed'); throw error; }
  }
}
