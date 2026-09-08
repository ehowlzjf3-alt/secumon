import { join } from 'node:path';
import { z } from 'zod';
import { inspectEngineExtensions, type EngineExtensionCheckOptions } from '../application/engine-extension-contracts.js';
import { AGENT_LOCAL_RESTORE_COMPLETION, type EnginePin, type EngineRelease } from '../application/agent-lifecycle-contracts.js';
import { AgentPostgresSelectionSchema, type AgentPostgresSelection, type AgentProfileStatus, type AgentProfileStore } from '../application/agent-profile-contracts.js';
import { inspectAgentPostgresBackup } from './agent-postgres-backup.js';
import { effectiveAgentPostgresSelection } from './agent-postgres-migration-profile.js';
import { postgresAgentBinding, type AgentPostgresHost } from './agent-postgres-storage.js';
import { inspectEngineRelease, readAgentEnginePin } from './agent-engine-release.js';
import { inspectAgentLocalStorageCompatibility, publishAgentEnginePin } from './agent-lifecycle.js';
import { captureLifecycleTree, disjoint, lifecycleDigest, lifecycleFail, lifecycleNames, lifecycleRoot } from './agent-lifecycle-files.js';
import { acquireAgentMaintenance } from './agent-lifecycle-lease.js';
import { openProfileMutationScope, readProfileBytes } from './agent-profile-files.js';
import { acquirePostgresMaintenance, assertPostgresBindings, POSTGRES_INSTALLATION_VERSION, postgresInteger, postgresTransaction,
  type PostgresBinding, type PostgresPool } from './postgres-store.js';
import { exportPostgresAgent } from './postgres-transfer.js';
import { TRANSFER_TABLES } from './postgres-transfer-tables.js';

type Ready = Extract<AgentProfileStatus, { status: 'ready' }>;
export interface AgentPostgresLifecycleOptions extends EngineExtensionCheckOptions { offline: boolean; operationId: string }
export interface AgentPostgresEnginePinOptions extends AgentPostgresLifecycleOptions {
  expectedPrevious: string | null;
  backup?: string;
}
const same = (left: unknown, right: unknown) => lifecycleDigest(left) === lifecycleDigest(right);
const selected = (input: AgentPostgresSelection) => {
  const value = AgentPostgresSelectionSchema.parse(input);
  value.purposes.sort(); return value;
};
const backupInclude = (path: string) => path !== '.secumon/runtime-leases' && !path.startsWith('.secumon/runtime-leases/') &&
  path !== '.secumon/lifecycle-maintenance.json' && path !== AGENT_LOCAL_RESTORE_COMPLETION && path !== '.secumon-postgres-restore-complete.json' &&
  !['.secumon/runtime.sqlite-shm', '.secumon/channel.sqlite-shm', 'memory/memory.sqlite-shm'].includes(path);
function ready(profiles: AgentProfileStore, directory: string): Ready {
  const value = profiles.inspect(directory);
  if (value.status !== 'ready') return lifecycleFail('agent_profile_not_ready');
  if (value.personalMemoryMigration?.phase === 'pending' || value.postgresMigration?.phase === 'pending') lifecycleFail('agent_migration_resume_required');
  return value;
}
function uncertain(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || typeof error !== 'object' || seen.has(error)) return false;
  seen.add(error);
  const value = error as { code?: unknown; cause?: unknown; errors?: unknown };
  return value.code === 'postgres_commit_outcome_unknown' || uncertain(value.cause, seen) ||
    Array.isArray(value.errors) && value.errors.some(item => uncertain(item, seen));
}
function postgresCompatibility(release: EngineRelease, bindings: readonly PostgresBinding[]) {
  const support = release.compatibility.postgres;
  // Purpose version 1 is the PG binding contract, not a SQLite schema version.
  if (!support || !support.installation.includes(POSTGRES_INSTALLATION_VERSION) || !support.binding.includes(1) ||
      bindings.some(binding => binding.purpose === 'board' || !support[binding.purpose].includes(1))) lifecycleFail('engine_postgres_incompatible');
  return { installation: POSTGRES_INSTALLATION_VERSION, binding: 1 as const,
    purposes: bindings.map(binding => ({ purpose: binding.purpose, schemaVersion: 1 as const })) };
}
async function inspectPostgresStorage(pool: PostgresPool, bindings: readonly PostgresBinding[], operationId: string) {
  await postgresTransaction(pool, false, async client => {
    await assertPostgresBindings(client, bindings, { maintenanceId: operationId });
    // Check the selected, fixed schema surface without creating tables or loading work bodies.
    for (const binding of bindings) for (const table of TRANSFER_TABLES.filter(value => value.purpose === binding.purpose)) {
      await client.query(`SELECT store_id,agent_id,${table.columns.join(',')} FROM secumon_pg.${table.name} WHERE store_id=$1 AND agent_id=$2 LIMIT 0`,
        [binding.storeId, binding.agentId]);
    }
    await assertPostgresBindings(client, bindings, { maintenanceId: operationId });
  });
}

interface LifecycleContext {
  profile: Ready;
  selection: AgentPostgresSelection;
  engine: string;
  release: EngineRelease;
  pin: EnginePin | null;
  storage: ReturnType<typeof inspectAgentLocalStorageCompatibility> & { postgres: ReturnType<typeof postgresCompatibility> };
  extensions: ReturnType<typeof inspectEngineExtensions>;
  pool: PostgresPool;
  bindings: readonly PostgresBinding[];
  operationId: string;
  assertLocal(): void;
  assertDatabase(): Promise<void>;
}
/** Both maintenance fences remain held through the caller's final compatibility check or pin publication. */
async function withLifecycle<T>(profiles: AgentProfileStore, directory: string, engineDirectory: string, host: AgentPostgresHost,
  options: AgentPostgresLifecycleOptions, action: (context: LifecycleContext) => Promise<T>): Promise<T> {
  const operationId = z.uuid().parse(options.operationId);
  if (options.offline !== true) lifecycleFail('lifecycle_offline_confirmation_required');
  const profile = ready(profiles, directory), configured = effectiveAgentPostgresSelection(profile);
  if (!configured) return lifecycleFail('agent_postgres_selection_required');
  const selection = selected(configured);
  if (!same(selection, selected(host.selection))) lifecycleFail('agent_postgres_registration_mismatch');
  const engine = lifecycleRoot(engineDirectory); disjoint(profile.root, engine);
  const bindings = selection.purposes.map(purpose => postgresAgentBinding(profile, selection, purpose));
  const pool: PostgresPool = Object.freeze({ connect: host.pool.connect.bind(host.pool) });
  const profileDigest = lifecycleDigest(profile);
  const local = acquireAgentMaintenance(profile.root, true);
  let scope: ReturnType<typeof openProfileMutationScope> | undefined;
  let engineScope: ReturnType<typeof openProfileMutationScope> | undefined;
  let fence: Awaited<ReturnType<typeof acquirePostgresMaintenance>> | undefined;
  const failures: unknown[] = []; let result: T | undefined;
  try {
    scope = openProfileMutationScope(profile.root, [engine]);
    engineScope = openProfileMutationScope(engine, [profile.root]);
    const maintenancePath = join(profile.paths.metadata, 'lifecycle-maintenance.json');
    const lease = readProfileBytes(maintenancePath, 65536, true, scope);
    if (!lease) return lifecycleFail('lifecycle_lease_changed');
    const pin = readAgentEnginePin(profile.root), release = inspectEngineRelease(engine);
    const extensions = inspectEngineExtensions(release.compatibility.extensions, options);
    const postgres = postgresCompatibility(release, bindings);
    const storage = { ...inspectAgentLocalStorageCompatibility(profile, release), postgres };
    const assertLocal = () => {
      if (!same(inspectEngineExtensions(release.compatibility.extensions, options), extensions)) lifecycleFail('engine_extension_declaration_changed');
      scope!.check(); engineScope!.check();
      const currentLease = readProfileBytes(maintenancePath, 65536, true, scope);
      if (!currentLease || !currentLease.equals(lease) || lifecycleNames(join(profile.paths.metadata, 'runtime-leases')).length !== 0)
        lifecycleFail('lifecycle_lease_changed');
      if (lifecycleDigest(ready(profiles, directory)) !== profileDigest) lifecycleFail('lifecycle_source_changed');
      if (!same(readAgentEnginePin(profile.root), pin)) lifecycleFail('engine_pin_conflict');
      scope!.check(); engineScope!.check();
    };
    assertLocal();
    // acquirePostgresMaintenance does not perform installation compatibility checks itself.
    await postgresTransaction(pool, false, async client => {
      const rows = (await client.query('SELECT version FROM secumon_pg.installation WHERE singleton=true')).rows;
      if (rows.length !== 1 || postgresInteger(rows[0]!['version']) !== POSTGRES_INSTALLATION_VERSION) lifecycleFail('postgres_schema_mismatch');
    });
    assertLocal();
    fence = await acquirePostgresMaintenance(pool, bindings, operationId);
    assertLocal();
    await inspectPostgresStorage(pool, bindings, operationId);
    assertLocal();
    const assertDatabase = async () => {
      assertLocal();
      await postgresTransaction(pool, false, client => assertPostgresBindings(client, bindings, { maintenanceId: operationId }));
      assertLocal();
    };
    result = await action({ profile, selection, engine, release, pin, storage, extensions, pool, bindings, operationId, assertLocal, assertDatabase });
  } catch (error) { failures.push(error); }
  // An unknown write commit can have installed a fence; never blindly clear that operation.
  if (fence && !failures.some(error => uncertain(error))) try { await fence.release(); } catch (error) { failures.push(error); }
  for (const opened of [engineScope, scope, local]) if (opened) try { opened.close(); } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'agent_postgres_lifecycle_cleanup_failed', { cause: failures[0] });
  return result as T;
}

/** Offline compatibility inspection; the only DB writes are acquiring and releasing the existing maintenance fence. */
export async function checkAgentPostgresLifecycle(profiles: AgentProfileStore, directory: string, engineDirectory: string,
  host: AgentPostgresHost, options: AgentPostgresLifecycleOptions) {
  return withLifecycle(profiles, directory, engineDirectory, host, options, async context => {
    await context.assertDatabase();
    if (!same(inspectEngineRelease(context.engine), context.release)) lifecycleFail('lifecycle_source_changed');
    context.assertLocal();
    return { agentId: context.profile.identity.agentId, root: context.profile.root, release: context.release, pin: context.pin,
      storage: context.storage, extensions: context.extensions, effects: 'preserved; existing runtime recovery required before new execution' };
  });
}

/** Pins only an explicit release. Updates require the original verified PG+local backup of the current release. */
export async function pinAgentPostgresEngine(profiles: AgentProfileStore, directory: string, engineDirectory: string,
  host: AgentPostgresHost, options: AgentPostgresEnginePinOptions) {
  const expectedPrevious = z.string().regex(/^[a-f0-9]{64}$/).nullable().parse(options.expectedPrevious);
  const backupInput = options.backup;
  return withLifecycle(profiles, directory, engineDirectory, host, options, async context => {
    const { profile, selection, pin: current, release, engine } = context;
    if ((current?.releaseDigest ?? null) !== expectedPrevious) lifecycleFail('engine_pin_conflict');
    if (current?.releaseDigest === release.digest) {
      await context.assertDatabase();
      if (!same(inspectEngineRelease(engine), release)) lifecycleFail('lifecycle_source_changed');
      context.assertLocal();
      return { pin: current, applied: false, storage: context.storage, extensions: context.extensions, recoveryRequired: true as const };
    }
    if (current && current.sequence >= 1024) lifecycleFail('engine_pin_limit');
    let backupDigest: string | null = null;
    let archiveScope: ReturnType<typeof openProfileMutationScope> | undefined;
    const failures: unknown[] = [];
    let result: { pin: EnginePin; applied: boolean; storage: LifecycleContext['storage']; extensions: LifecycleContext['extensions']; recoveryRequired: true } | undefined;
    try {
      let saved: Awaited<ReturnType<typeof inspectAgentPostgresBackup>> | undefined;
      if (current) {
        if (!backupInput) return lifecycleFail('engine_update_backup_required');
        const backup = lifecycleRoot(backupInput);
        disjoint(profile.root, backup); disjoint(engine, backup);
        archiveScope = openProfileMutationScope(backup, [profile.root, engine]);
        saved = await inspectAgentPostgresBackup(backup);
        context.assertLocal(); archiveScope.check();
        if (saved.manifest.agentId !== profile.identity.agentId || saved.manifest.originalRoot !== profile.root ||
            saved.manifest.releaseDigest !== current.releaseDigest || !same(selected(saved.manifest.selection), selection))
          lifecycleFail('engine_update_backup_stale');
        // The transfer digest contains complete original rows, including their timestamps. The outer backup's creation time is not a row.
        const snapshot = await exportPostgresAgent(context.pool, context.bindings, async () => undefined, { maintenanceId: context.operationId });
        context.assertLocal(); archiveScope.check();
        if (snapshot.digest !== saved.transfer.digest) lifecycleFail('engine_update_backup_stale');
        const reread = await inspectAgentPostgresBackup(backup);
        if (reread.manifest.digest !== saved.manifest.digest || reread.transfer.digest !== snapshot.digest) lifecycleFail('lifecycle_backup_digest_mismatch');
        archiveScope.check(); context.assertLocal();
        backupDigest = saved.manifest.digest;
      }
      await context.assertDatabase();
      if (!same(inspectEngineRelease(engine), release)) lifecycleFail('lifecycle_source_changed');
      if (saved && !same(captureLifecycleTree(profile.root, backupInclude), saved.manifest.entries)) lifecycleFail('engine_update_backup_stale');
      archiveScope?.check(); context.assertLocal();
      const pin = publishAgentEnginePin(profile, engine, release, current, backupDigest);
      result = { pin, applied: true, storage: context.storage, extensions: context.extensions, recoveryRequired: true };
    } catch (error) { failures.push(error); }
    if (archiveScope) try { archiveScope.close(); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'agent_postgres_pin_cleanup_failed', { cause: failures[0] });
    return result!;
  });
}
