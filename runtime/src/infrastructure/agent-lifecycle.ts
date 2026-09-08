import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { z } from 'zod';
import { inspectEngineExtensions, type EngineExtensionCheckOptions } from '../application/engine-extension-contracts.js';
import { AGENT_LOCAL_RESTORE_COMPLETION, AgentBackupSchema, AgentLocalRestoreMarkerSchema, EnginePinSchema, type EnginePin, type EngineRelease } from '../application/agent-lifecycle-contracts.js';
import { AgentConfigSchema, AgentIdentitySchema, type AgentProfileStore, type AgentProfileStatus } from '../application/agent-profile-contracts.js';
import { acquireAgentMaintenance } from './agent-lifecycle-lease.js';
import { captureLifecycleTree, copyLifecycleTree, createLifecycleDirectory, disjoint, lifecycleDigest, lifecycleExists, lifecycleFail, lifecycleLimits, lifecycleNames, lifecycleRoot } from './agent-lifecycle-files.js';
import { assertAgentSetupCompatibility, engineCompatibility, inspectEngineRelease, publishLifecycleManifest, readAgentEnginePin } from './agent-engine-release.js';
import { openProfileMutationScope, profileDirectory, publishProfileJson, readProfileJson, syncProfileDirectory } from './agent-profile-files.js';
import { inspectAgentDatabaseOwner } from './agent-database-owner.js';
import { inspectDocumentKnowledgeStore } from './document-knowledge-owner.js';
import { effectiveAgentPostgresSelection } from './agent-postgres-migration-profile.js';
import { readWindowsLifecycleJson, removeWindowsLifecycleMarker } from './windows-lifecycle-files.js';
import { openHostSqliteDatabase } from './windows-sqlite.js';
import { restoreWindowsLifecycleTree } from './windows-lifecycle-recovery.js';

type Ready = Extract<AgentProfileStatus, { status: 'ready' }>;
const backupInclude = (path: string) => path !== '.secumon/runtime-leases' && !path.startsWith('.secumon/runtime-leases/') && path !== '.secumon/lifecycle-maintenance.json' &&
  path !== AGENT_LOCAL_RESTORE_COMPLETION &&
  !['.secumon/runtime.sqlite-shm', '.secumon/channel.sqlite-shm', 'memory/memory.sqlite-shm'].includes(path);
function ready(profiles: AgentProfileStore, directory: string) {
  const profile = profiles.inspect(directory);
  if (profile.status !== 'ready') return lifecycleFail('agent_profile_not_ready');
  if (profile.personalMemoryMigration?.phase === 'pending') lifecycleFail('agent_migration_resume_required');
  return profile;
}
function sqliteVersion(path: string, profile: Ready, kind: 'state' | 'memory' | 'channel', query: string) {
  if (inspectAgentDatabaseOwner(path, profile.identity.agentId, kind) !== 'owned') lifecycleFail('lifecycle_storage_not_initialized');
  const db = openHostSqliteDatabase(path, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN;');
    const result = db.prepare(query).get(); const value = result && Object.values(result)[0];
    if (typeof value !== 'number') return lifecycleFail('lifecycle_storage_version_invalid');
    db.exec('COMMIT;'); return value;
  } finally { db.close(); }
}
/** Checks only the local portions of the actual selected storage; PG binding versions are separate. */
export function inspectAgentLocalStorageCompatibility(profile: Ready, release: Pick<EngineRelease, 'compatibility'>) {
  assertAgentSetupCompatibility(profile.root, release);
  if (profile.postgresMigration?.phase === 'pending' || profile.personalMemoryMigration?.phase === 'pending') lifecycleFail('agent_migration_resume_required');
  const postgres = effectiveAgentPostgresSelection(profile);
  const config = profile.config, support = release.compatibility;
  if (!support.config.includes(config.schemaVersion)) lifecycleFail('engine_config_incompatible');
  const state = postgres?.purposes.includes('state') ? null : config.storage.state === 'sqlite' ? sqliteVersion(profile.paths.state, profile, 'state', 'PRAGMA user_version') : (() => {
    const header = readProfileJson(join(profile.paths.state, 'format.json'), z.strictObject({ kind: z.literal('long-horizon-file-journal'), schemaVersion: z.literal(2), storeId: z.uuid(), owner: z.strictObject({ agentId: z.uuid(), kind: z.literal('state') }) }), [2]);
    if (!header || header.owner.agentId !== profile.identity.agentId) return lifecycleFail('lifecycle_storage_owner_mismatch'); return header.schemaVersion;
  })();
  const knowledge = postgres?.purposes.includes('knowledge') ? null : sqliteVersion(profile.paths.memory, profile, 'memory', 'SELECT version FROM knowledge_schema');
  const session = postgres?.purposes.includes('channel') ? null : sqliteVersion(join(profile.paths.metadata, 'channel.sqlite'), profile, 'channel', 'SELECT version FROM session_schema');
  if (state !== null && !(config.storage.state === 'sqlite' ? support.state : support.journal).includes(state) ||
    knowledge !== null && !support.knowledge.includes(knowledge) || session !== null && !support.session.includes(session)) lifecycleFail('engine_storage_incompatible');
  if (profile.effectivePersonalMemory.backend === 'documents') {
    const folder = join(profile.root, 'memory', 'documents');
    if (inspectDocumentKnowledgeStore(folder, { agentId: profile.identity.agentId, storeId: profile.effectivePersonalMemory.storeId, root: profile.root }) !== 'registered') lifecycleFail('lifecycle_document_store_invalid');
    const format = readProfileJson(join(folder, 'format.json'), z.object({ schemaVersion: z.number().int() }).passthrough(), [1, 2]);
    if (!format || !support.documents.includes(format.schemaVersion)) lifecycleFail('engine_document_storage_incompatible');
  }
  return { config: config.schemaVersion, stateBackend: config.storage.state, state, knowledge, session, personalMemory: profile.effectivePersonalMemory.backend };
}
function inspectCompatibility(profile: Ready, release: Pick<EngineRelease, 'compatibility'>) {
  if (effectiveAgentPostgresSelection(profile) || profile.postgresMigration?.phase === 'pending') lifecycleFail('lifecycle_external_storage_snapshot_required');
  return inspectAgentLocalStorageCompatibility(profile, release);
}
export function checkAgentLifecycle(profiles: AgentProfileStore, directory: string, engineDirectory: string, options: EngineExtensionCheckOptions = {}) {
  const profile = ready(profiles, directory), release = inspectEngineRelease(engineDirectory);
  const extensions = inspectEngineExtensions(release.compatibility.extensions, options);
  return { agentId: profile.identity.agentId, root: profile.root, release, pin: readAgentEnginePin(profile.root), storage: inspectCompatibility(profile, release), extensions, effects: 'preserved; existing runtime recovery required before new execution' };
}
export function backupAgent(profiles: AgentProfileStore, directory: string, destination: string, offline: boolean) {
  const profile = ready(profiles, directory), target = lifecycleRoot(destination, false); disjoint(profile.root, target);
  const lease = acquireAgentMaintenance(profile.root, offline);
  try {
    const pin = readAgentEnginePin(profile.root);
    inspectCompatibility(profile, { compatibility: engineCompatibility });
    const entries = captureLifecycleTree(profile.root, backupInclude);
    const body = { schemaVersion: 1 as const, kind: 'secumon-agent-backup' as const, agentId: profile.identity.agentId, originalRoot: profile.root, createdAt: Date.now(), releaseDigest: pin?.releaseDigest ?? null, entries };
    const manifest = AgentBackupSchema.parse({ ...body, digest: lifecycleDigest(body) });
    createLifecycleDirectory(target); createLifecycleDirectory(join(target, 'data')); copyLifecycleTree(profile.root, join(target, 'data'), entries);
    if (lifecycleDigest(captureLifecycleTree(profile.root, backupInclude)) !== lifecycleDigest(entries)) lifecycleFail('lifecycle_source_changed');
    publishLifecycleManifest(target, 'backup.json', manifest); return { directory: target, manifest, recoveryRequired: true };
  } finally { lease.close(); }
}
export function inspectAgentBackup(input: string) {
  const directory = lifecycleRoot(input); const manifest = process.platform === 'win32' ?
    readWindowsLifecycleJson(join(directory, 'backup.json'), AgentBackupSchema, 32 * 1024 * 1024) :
    readProfileJson(join(directory, 'backup.json'), AgentBackupSchema, [1], 32 * 1024 * 1024);
  if (!manifest) return lifecycleFail('lifecycle_backup_missing'); const { digest, ...body } = manifest;
  if (lifecycleDigest(body) !== digest || lifecycleDigest(captureLifecycleTree(join(directory, 'data'))) !== lifecycleDigest(manifest.entries)) lifecycleFail('lifecycle_backup_digest_mismatch');
  return { directory, manifest };
}
export function pinAgentEngine(profiles: AgentProfileStore, directory: string, engineDirectory: string, options: EngineExtensionCheckOptions & { offline: boolean; expectedPrevious: string | null; backup?: string }) {
  const profile = ready(profiles, directory), engine = lifecycleRoot(engineDirectory); disjoint(profile.root, engine);
  const lease = acquireAgentMaintenance(profile.root, options.offline);
  try {
    const current = readAgentEnginePin(profile.root);
    if (current && current.sequence >= 1024) lifecycleFail('engine_pin_limit');
    if ((current?.releaseDigest ?? null) !== options.expectedPrevious) lifecycleFail('engine_pin_conflict');
    const release = inspectEngineRelease(engine);
    const extensions = inspectEngineExtensions(release.compatibility.extensions, options);
    const storage = inspectCompatibility(profile, release);
    if (current?.releaseDigest === release.digest) return { pin: current, applied: false, storage, extensions, recoveryRequired: true };
    let backupDigest: string | null = null;
    if (current) {
      if (!options.backup) lifecycleFail('engine_update_backup_required');
      const saved = inspectAgentBackup(options.backup!);
      if (saved.manifest.agentId !== profile.identity.agentId || saved.manifest.originalRoot !== profile.root || saved.manifest.releaseDigest !== current.releaseDigest || lifecycleDigest(saved.manifest.entries) !== lifecycleDigest(captureLifecycleTree(profile.root, backupInclude))) lifecycleFail('engine_update_backup_stale');
      backupDigest = saved.manifest.digest;
    }
    const pin = publishAgentEnginePin(profile, engine, release, current, backupDigest);
    return { pin, applied: true, storage, extensions, recoveryRequired: true };
  } finally { lease.close(); }
}
/** Shared no-replace publication. The caller retains its local and, when applicable, PG maintenance fence. */
export function publishAgentEnginePin(profile: Ready, engine: string, release: EngineRelease, current: EnginePin | null, backupDigest: string | null): EnginePin {
  if (current && current.sequence >= 1024) lifecycleFail('engine_pin_limit');
  const scope = openProfileMutationScope(profile.root, [engine]);
  let failed = false, failure: unknown;
  try {
    assertAgentSetupCompatibility(profile.root, release);
    if (lifecycleDigest(readAgentEnginePin(profile.root)) !== lifecycleDigest(current)) lifecycleFail('engine_pin_conflict');
    const pin = EnginePinSchema.parse({ schemaVersion: 1, sequence: (current?.sequence ?? 0) + 1, agentId: profile.identity.agentId,
      releaseDigest: release.digest, engineDirectory: engine, version: release.version,
      previous: current ? lifecycleDigest(current) : null, backupDigest, createdAt: Date.now() });
    const folder = join(profile.paths.metadata, 'engine-pins'); profileDirectory(folder, true, true, scope);
    if (!publishProfileJson(join(folder, `${String(pin.sequence).padStart(8, '0')}.json`), pin, scope)) lifecycleFail('engine_pin_conflict');
    syncProfileDirectory(folder, scope); scope.check(); return pin;
  } catch (error) { failed = true; failure = error; throw error; }
  finally {
    try { scope.close(); } catch (error) {
      if (failed) throw new AggregateError([failure, error], 'engine_pin_cleanup_failed', { cause: failure });
      throw error;
    }
  }
}
export function restoreAgentBackup(profiles: AgentProfileStore, input: string, directory: string, expectedDigest: string, offline: boolean) {
  if (offline !== true) lifecycleFail('lifecycle_offline_confirmation_required');
  const saved = inspectAgentBackup(input), target = lifecycleRoot(directory, false); disjoint(saved.directory, target);
  if (saved.manifest.digest !== expectedDigest || saved.manifest.originalRoot !== target) lifecycleFail('lifecycle_restore_binding_mismatch');
  const markerName = '.secumon-restore-in-progress.json';
  const marker = { schemaVersion: 1, backupDigest: saved.manifest.digest, agentId: saved.manifest.agentId };
  if (saved.manifest.entries.some(entry => entry.path === markerName || entry.path === AGENT_LOCAL_RESTORE_COMPLETION)) lifecycleFail('lifecycle_restore_entries_invalid');
  const completed = AgentLocalRestoreMarkerSchema.parse({ schemaVersion: 1, kind: 'secumon-local-restore',
    operationId: `local:${saved.manifest.digest}`, agentId: saved.manifest.agentId, backupDigest: saved.manifest.digest, originalRoot: target });
  // A Windows retry must present the same original archive and the still-pending marker.
  if (lifecycleExists(target)) {
    if (process.platform !== 'win32') lifecycleFail('lifecycle_restore_destination_exists');
    lifecycleRoot(target);
    const previous = readProfileJson(join(target, markerName), z.strictObject({ schemaVersion: z.literal(1), backupDigest: z.string(), agentId: z.uuid() }));
    if (!previous || lifecycleDigest(previous) !== lifecycleDigest(marker)) lifecycleFail('lifecycle_restore_destination_exists');
  } else {
    createLifecycleDirectory(target); publishLifecycleManifest(target, markerName, marker);
  }
  if (process.platform === 'win32') restoreWindowsLifecycleTree(join(saved.directory, 'data'), target, saved.manifest.entries,
    { operationId: `local:${saved.manifest.digest}`, backupDigest: saved.manifest.digest, agentId: saved.manifest.agentId,
      markerName, markerBytes: Buffer.from(JSON.stringify(marker, null, 2) + '\n') }, lifecycleLimits, path => path !== AGENT_LOCAL_RESTORE_COMPLETION);
  else copyLifecycleTree(join(saved.directory, 'data'), target, saved.manifest.entries);
  if (lifecycleDigest(captureLifecycleTree(target, path => path !== markerName && path !== AGENT_LOCAL_RESTORE_COMPLETION)) !== lifecycleDigest(saved.manifest.entries)) lifecycleFail('lifecycle_restore_digest_mismatch');
  const identity = readProfileJson(join(target, '.secumon', 'identity.json'), AgentIdentitySchema);
  const config = readProfileJson(join(target, 'config.json'), AgentConfigSchema, [1, 2]);
  if (!identity || identity.agentId !== saved.manifest.agentId || !config || lifecycleDigest(config.identity) !== lifecycleDigest(identity)) lifecycleFail('lifecycle_restore_owner_mismatch');
  const pin = readAgentEnginePin(target);
  if (pin && pin.releaseDigest !== saved.manifest.releaseDigest) lifecycleFail('lifecycle_restore_engine_mismatch');
  const previousCompletion = readProfileJson(join(target, AGENT_LOCAL_RESTORE_COMPLETION), AgentLocalRestoreMarkerSchema);
  if (previousCompletion && lifecycleDigest(previousCompletion) !== lifecycleDigest(completed)) lifecycleFail('lifecycle_restore_binding_mismatch');
  if (!previousCompletion) publishLifecycleManifest(target, AGENT_LOCAL_RESTORE_COMPLETION, completed);
  const scope = openProfileMutationScope(target, []);
  try {
    scope.check();
    if (process.platform === 'win32') removeWindowsLifecycleMarker(join(target, markerName), Buffer.from(JSON.stringify(marker, null, 2) + '\n'));
    else unlinkSync(join(target, markerName));
    syncProfileDirectory(target, scope); scope.check();
  } finally { scope.close(); }
  const profile = ready(profiles, target);
  return { agentId: profile.identity.agentId, root: target, backupDigest: saved.manifest.digest, operationId: completed.operationId,
    pin, recoveryRequired: true, externalEffects: 'not undone; restore may require external reconciliation' };
}
export function lifecycleInventory(root: string) {
  const pins = readAgentEnginePin(root); return { pin: pins, maintenance: lifecycleExists(join(root, '.secumon', 'lifecycle-maintenance.json')), activeLeases: lifecycleExists(join(root, '.secumon', 'runtime-leases')) ? lifecycleNames(join(root, '.secumon', 'runtime-leases')).length : 0 };
}
