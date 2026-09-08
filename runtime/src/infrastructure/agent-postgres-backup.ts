import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { AgentPostgresBackupSchema, AgentPostgresRestoreFloorSchema, AgentPostgresRestoreMarkerSchema,
  type AgentPostgresBackup, type AgentPostgresRestoreFloor } from '../application/agent-postgres-backup-contracts.js';
import { AgentConfigSchema, AgentIdentitySchema, type AgentProfileStore, type AgentPostgresSelection } from '../application/agent-profile-contracts.js';
import { AGENT_LOCAL_RESTORE_COMPLETION, type LifecycleEntry } from '../application/agent-lifecycle-contracts.js';
import { AGENT_RESTORE_RECONCILIATION, AGENT_RESTORE_RECONCILIATION_PENDING } from '../application/agent-restore-reconciliation-contracts.js';
import { asJson } from '../application/plan-validator.js';
import { acquireAgentMaintenance, recoverAgentLifecycleLeases } from './agent-lifecycle-lease.js';
import { captureLifecycleTree, copyLifecycleTree, createLifecycleDirectory, disjoint, lifecycleDigest, lifecycleExists, lifecycleFail,
  lifecycleLimits, lifecycleNames, lifecycleRoot, syncLifecycleDirectory } from './agent-lifecycle-files.js';
import { removeWindowsLifecycleMarker } from './windows-lifecycle-files.js';
import { restoreWindowsLifecycleTree, type WindowsLifecycleRecovery } from './windows-lifecycle-recovery.js';
import { engineCompatibility, publishLifecycleManifest, readAgentEnginePin } from './agent-engine-release.js';
import { openProfileMutationScope, profileDirectory, profileStat, readProfileJson, syncProfileDirectory } from './agent-profile-files.js';
import { effectiveAgentPostgresSelection } from './agent-postgres-migration-profile.js';
import { postgresAgentBinding, type AgentPostgresHost } from './agent-postgres-storage.js';
import { acquirePostgresMaintenance, type PostgresBinding } from './postgres-store.js';
import { exportPostgresAgent, importPostgresAgent, transferPageDigest, validateTransferManifest, TRANSFER_LIMITS } from './postgres-transfer.js';
import { inspectPostgresTransferPage, readPostgresTransferPage, writePostgresTransferPage, type PostgresTransferFile } from './postgres-transfer-files.js';

const markerName = '.secumon-restore-in-progress.json';
const activationName = '.secumon-postgres-restore-complete.json';
const pendingPrefix = '.secumon-pg-copy-';
const manifestLimit = 4 * 1024 ** 2;
const same = (a: unknown, b: unknown) => lifecycleDigest(a) === lifecycleDigest(b);
const selected = (value: AgentPostgresSelection) => ({ storeId: value.storeId, registrationId: value.registrationId, purposes: [...value.purposes].sort() });
const backupInclude = (path: string) => path !== '.secumon/runtime-leases' && !path.startsWith('.secumon/runtime-leases/') &&
  path !== '.secumon/lifecycle-maintenance.json' && path !== activationName && path !== AGENT_LOCAL_RESTORE_COMPLETION && path !== AGENT_RESTORE_RECONCILIATION && path !== AGENT_RESTORE_RECONCILIATION_PENDING &&
  !['.secumon/runtime.sqlite-shm', '.secumon/channel.sqlite-shm', 'memory/memory.sqlite-shm'].includes(path);
const operation = (value: string) => z.uuid().parse(value);
function uncertain(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || typeof error !== 'object' || seen.has(error)) return false;
  seen.add(error);
  const value = error as { code?: unknown; cause?: unknown; errors?: unknown };
  return value.code === 'postgres_commit_outcome_unknown' || uncertain(value.cause, seen) ||
    Array.isArray(value.errors) && value.errors.some(item => uncertain(item, seen));
}
function capacity(entries: readonly LifecycleEntry[], pages: readonly PostgresTransferFile[]) {
  const pageBytes = pages.reduce((total, item) => total + item.bytes, 0);
  const bytes = entries.reduce((total, item) => total + (item.kind === 'file' ? item.bytes : 0), 0) + pageBytes;
  if (pageBytes > TRANSFER_LIMITS.totalBytes || bytes > lifecycleLimits.bytes || entries.some(item => item.kind === 'file' && item.bytes > lifecycleLimits.fileBytes)) lifecycleFail('lifecycle_capacity_exceeded');
}
function assertEntries(entries: readonly LifecycleEntry[]) {
  const names = new Map<string, LifecycleEntry>();
  for (const entry of entries) {
    if (names.has(entry.path) || !backupInclude(entry.path) || [AGENT_RESTORE_RECONCILIATION, AGENT_RESTORE_RECONCILIATION_PENDING].some(path => entry.path.startsWith(`${path}/`)) || entry.path === markerName || entry.path.split('/').some(part => part.startsWith(pendingPrefix))) lifecycleFail('postgres_backup_entries_invalid');
    const parent = dirname(entry.path);
    if (parent !== '.' && names.get(parent)?.kind !== 'directory') lifecycleFail('postgres_backup_entries_invalid');
    names.set(entry.path, entry);
  }
}
function checkLocalIdentity(root: string, manifest: AgentPostgresBackup) {
  const identity = readProfileJson(join(root, '.secumon', 'identity.json'), AgentIdentitySchema);
  const config = readProfileJson(join(root, 'config.json'), AgentConfigSchema, [1, 2]);
  if (!identity || identity.agentId !== manifest.agentId || !config || !same(config.identity, identity)) lifecycleFail('lifecycle_restore_owner_mismatch');
  if (!engineCompatibility.config.includes(config.schemaVersion)) lifecycleFail('engine_config_incompatible');
  const pin = readAgentEnginePin(root);
  if ((pin?.releaseDigest ?? null) !== manifest.releaseDigest) lifecycleFail('lifecycle_restore_engine_mismatch');
  return pin;
}
function assertBindings(bindings: readonly PostgresBinding[], agentId: string, selection: AgentPostgresSelection) {
  const expected = [...selection.purposes].sort().map(purpose => ({ agentId, purpose, storeId: selection.storeId, registrationId: selection.registrationId }));
  const actual = [...bindings].sort((a, b) => a.purpose.localeCompare(b.purpose));
  if (actual.length !== expected.length || actual.some((item, index) => !same({ agentId: item.agentId, purpose: item.purpose, storeId: item.storeId, registrationId: item.registrationId }, expected[index]))) lifecycleFail('postgres_backup_binding_mismatch');
}

/** Publishes a manifest last. An unfinished directory is retained as evidence, never an accepted backup. */
export async function backupAgentPostgres(profiles: AgentProfileStore, directory: string, destination: string,
  host: AgentPostgresHost, options: { offline: boolean; operationId: string }) {
  const id = operation(options.operationId), profile = profiles.inspect(directory);
  if (profile.status !== 'ready') return lifecycleFail('agent_profile_not_ready');
  if (profile.personalMemoryMigration?.phase === 'pending' || profile.postgresMigration?.phase === 'pending') lifecycleFail('agent_migration_resume_required');
  const selection = effectiveAgentPostgresSelection(profile);
  if (!selection || !same(selected(selection), selected(host.selection))) lifecycleFail('agent_postgres_registration_mismatch');
  profiles.assertRuntimeCompatible?.(directory);
  const target = lifecycleRoot(destination, false); disjoint(profile.root, target);
  if (lifecycleExists(target)) lifecycleFail('lifecycle_destination_exists');
  const bindings = selection.purposes.map(purpose => postgresAgentBinding(profile, selection, purpose));
  const pool = Object.freeze({ connect: host.pool.connect.bind(host.pool) });
  const local = acquireAgentMaintenance(profile.root, options.offline);
  let fence: Awaited<ReturnType<typeof acquirePostgresMaintenance>> | undefined, result: { directory: string; manifest: AgentPostgresBackup; recoveryRequired: true } | undefined;
  const failures: unknown[] = [];
  try {
    fence = await acquirePostgresMaintenance(pool, bindings, id);
    const entries = captureLifecycleTree(profile.root, backupInclude); assertEntries(entries);
    const pin = readAgentEnginePin(profile.root);
    createLifecycleDirectory(target); createLifecycleDirectory(join(target, 'data')); createLifecycleDirectory(join(target, 'pages'));
    copyLifecycleTree(profile.root, join(target, 'data'), entries);
    const pages: PostgresTransferFile[] = [];
    const transfer = await exportPostgresAgent(pool, bindings, async (pageId, page) => {
      pages.push(await writePostgresTransferPage(join(target, 'pages'), pageId, page)); capacity(entries, pages);
    }, { maintenanceId: id });
    assertBindings(transfer.sourceBindings, profile.identity.agentId, selection);
    if (!same(captureLifecycleTree(profile.root, backupInclude), entries)) lifecycleFail('lifecycle_source_changed');
    const current = profiles.inspect(directory);
    const currentSelection = current.status === 'ready' ? effectiveAgentPostgresSelection(current) : null;
    if (current.status !== 'ready' || !same(current.config, profile.config) || !same(current.postgresMigration ?? null, profile.postgresMigration ?? null) ||
      !currentSelection || !same(selected(currentSelection), selected(selection))) lifecycleFail('lifecycle_source_changed');
    const body = { schemaVersion: 1 as const, kind: 'secumon-agent-postgres-backup' as const, operationId: id,
      agentId: profile.identity.agentId, originalRoot: profile.root, createdAt: Date.now(), releaseDigest: pin?.releaseDigest ?? null,
      selection, entries, transfer: asJson(transfer), pages };
    const manifest = AgentPostgresBackupSchema.parse({ ...body, digest: lifecycleDigest(body) });
    if (Buffer.byteLength(JSON.stringify(manifest, null, 2) + '\n') > manifestLimit) lifecycleFail('lifecycle_capacity_exceeded');
    checkLocalIdentity(join(target, 'data'), manifest);
    publishLifecycleManifest(target, 'backup.json', manifest);
    result = { directory: target, manifest, recoveryRequired: true };
  } catch (error) { failures.push(error); }
  finally {
    if (fence && !failures.some(error => uncertain(error))) try { await fence.release(); } catch (error) { failures.push(error); }
    try { local.close(); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'postgres_backup_cleanup_failed');
  return result!;
}

export async function inspectAgentPostgresBackup(input: string) {
  const directory = lifecycleRoot(input);
  const manifest = readProfileJson(join(directory, 'backup.json'), AgentPostgresBackupSchema, [1], manifestLimit);
  if (!manifest) return lifecycleFail('lifecycle_backup_missing');
  const { digest, ...body } = manifest;
  if (digest !== lifecycleDigest(body)) lifecycleFail('lifecycle_backup_digest_mismatch');
  assertEntries(manifest.entries); capacity(manifest.entries, manifest.pages);
  if (!same(captureLifecycleTree(join(directory, 'data')), manifest.entries)) lifecycleFail('lifecycle_backup_digest_mismatch');
  checkLocalIdentity(join(directory, 'data'), manifest);
  const transfer = validateTransferManifest(manifest.transfer);
  if (transfer.agentId !== manifest.agentId) lifecycleFail('postgres_backup_binding_mismatch');
  assertBindings(transfer.sourceBindings, manifest.agentId, manifest.selection);
  if (transfer.pages.length !== manifest.pages.length || new Set(manifest.pages.map(page => page.id)).size !== manifest.pages.length) lifecycleFail('postgres_backup_pages_invalid');
  for (const [index, page] of manifest.pages.entries()) {
    const expected = transfer.pages[index];
    if (!expected || expected.id !== page.id || page.file !== `${page.id}.json`) lifecycleFail('postgres_backup_pages_invalid');
    const read = await inspectPostgresTransferPage(join(directory, 'pages'), page.id);
    if (!same(read.file, page) || transferPageDigest(read.page) !== expected.digest || read.page.table !== expected.table || read.page.rows.length !== expected.rows) lifecycleFail('postgres_backup_page_changed');
  }
  if (!same(lifecycleNames(join(directory, 'pages')).sort(), manifest.pages.map(page => page.file).sort())) lifecycleFail('postgres_backup_pages_invalid');
  return { directory, manifest, transfer };
}

type FileEntry = Extract<LifecycleEntry, { kind: 'file' }>;
function assertRegular(path: string, linked = false) {
  const value = lstatSync(path);
  if (!value.isFile() || value.isSymbolicLink() || (value.mode & 0o022) !== 0 || value.nlink !== 1 && !(linked && value.nlink === 2) ||
    typeof process.getuid === 'function' && value.uid !== process.getuid()) lifecycleFail('lifecycle_file_unsafe');
  return value;
}
/** Streams at most one file; the final pathname is published only after its content matches the archive. */
function restoreFile(source: string, root: string, entry: FileEntry, id: string, index: number) {
  const target = join(root, entry.path), parent = dirname(target), pending = join(parent, `${pendingPrefix}${id}-${index}.pending`);
  if (process.platform === 'win32') return lifecycleFail('lifecycle_restore_binding_required');
  const scope = openProfileMutationScope(root, [source]);
  let sourceScope: ReturnType<typeof openProfileMutationScope> | undefined;
  let input: number | undefined, output: number | undefined, failed = false, primary: unknown;
  try {
    profileDirectory(parent, false, true, scope);
    if (profileStat(pending)) {
      const prior = assertRegular(pending, true);
      if (prior.nlink === 2) {
        const named = profileStat(target);
        if (!named || named.ino !== prior.ino || named.dev !== prior.dev) lifecycleFail('lifecycle_restore_source_changed');
      }
      scope.check(); unlinkSync(pending); syncProfileDirectory(parent, scope);
    }
    if (profileStat(target)) {
      const actual = captureLifecycleTree(parent, path => path === entry.path.split('/').at(-1));
      if (actual.length !== 1 || !same(actual[0], { ...entry, path: entry.path.split('/').at(-1) })) lifecycleFail('lifecycle_restore_digest_mismatch');
      syncProfileDirectory(parent, scope); return;
    }
    const path = join(source, entry.path);
    sourceScope = openProfileMutationScope(source, [root]);
    profileDirectory(dirname(path), false, false, sourceScope);
    const before = assertRegular(path);
    input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(input);
    if (opened.ino !== before.ino || opened.dev !== before.dev) lifecycleFail('lifecycle_source_changed');
    output = openSync(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, entry.executable ? 0o700 : 0o600);
    const buffer = Buffer.allocUnsafe(1024 * 1024), hash = createHash('sha256'); let bytes = 0;
    for (;;) {
      const count = readSync(input, buffer, 0, buffer.length, null); if (!count) break;
      bytes += count; if (bytes > entry.bytes || bytes > lifecycleLimits.fileBytes) lifecycleFail('lifecycle_capacity_exceeded');
      hash.update(buffer.subarray(0, count));
      for (let offset = 0; offset < count;) offset += writeSync(output, buffer, offset, count - offset);
    }
    const after = fstatSync(input), named = lstatSync(path);
    if (bytes !== entry.bytes || hash.digest('hex') !== entry.sha256 || before.ino !== named.ino || before.dev !== named.dev ||
      after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) lifecycleFail('lifecycle_source_changed');
    sourceScope.check(); fsyncSync(output); const closing = output; output = undefined; closeSync(closing);
    scope.check(); linkSync(pending, target); syncProfileDirectory(parent, scope);
    unlinkSync(pending); syncProfileDirectory(parent, scope); scope.check();
  } catch (error) { failed = true; primary = error; throw error; }
  finally {
    const cleanup: unknown[] = [];
    for (const fd of [output, input]) if (fd !== undefined) try { closeSync(fd); } catch (error) { cleanup.push(error); }
    for (const openedScope of [sourceScope, scope]) if (openedScope) try { openedScope.close(); } catch (error) { cleanup.push(error); }
    if (cleanup.length) throw new AggregateError(failed ? [primary, ...cleanup] : cleanup, 'postgres_restore_file_cleanup_failed');
  }
}
function restoreTree(source: string, root: string, entries: readonly LifecycleEntry[], id: string, recovery: WindowsLifecycleRecovery) {
  if (process.platform === 'win32') return restoreWindowsLifecycleTree(source, root, entries, recovery, lifecycleLimits, backupInclude);
  for (const [index, entry] of entries.entries()) {
    const path = join(root, entry.path);
    if (entry.kind === 'file') restoreFile(source, root, entry, id, index);
    else if (lifecycleExists(path)) lifecycleRoot(path); else createLifecycleDirectory(path);
  }
  if (!same(captureLifecycleTree(root, path => backupInclude(path) && path !== markerName), entries)) lifecycleFail('lifecycle_restore_digest_mismatch');
  syncLifecycleDirectory(root);
}

/** Same original root and registration only. No target provisioning, existing-data replacement or execution. */
export async function restoreAgentPostgresBackup(profiles: AgentProfileStore, input: string, directory: string,
  host: AgentPostgresHost, options: { offline: boolean; operationId: string; expectedDigest: string; currentFloor: AgentPostgresRestoreFloor }) {
  if (options.offline !== true) lifecycleFail('lifecycle_offline_confirmation_required');
  const id = operation(options.operationId), floor = AgentPostgresRestoreFloorSchema.parse(options.currentFloor);
  const saved = await inspectAgentPostgresBackup(input), target = lifecycleRoot(directory, false), manifest = saved.manifest;
  disjoint(saved.directory, target);
  if (manifest.digest !== options.expectedDigest || manifest.originalRoot !== target || floor.agentId !== manifest.agentId || floor.backupDigest !== manifest.digest ||
    !same(selected(host.selection), selected(manifest.selection))) lifecycleFail('lifecycle_restore_binding_mismatch');
  let marker = AgentPostgresRestoreMarkerSchema.parse({ schemaVersion: 1, kind: 'secumon-postgres-restore', operationId: id,
    agentId: manifest.agentId, backupDigest: manifest.digest, transferDigest: saved.transfer.digest, originalRoot: target, selection: manifest.selection });
  const exists = lifecycleExists(target);
  if (exists) {
    lifecycleRoot(target);
    const pending = readProfileJson(join(target, markerName), AgentPostgresRestoreMarkerSchema);
    const activation = readProfileJson(join(target, activationName), AgentPostgresRestoreMarkerSchema);
    const matches = (value: z.infer<typeof AgentPostgresRestoreMarkerSchema>) => same(value, {
      ...marker, ...(value.restorationId === undefined ? {} : { restorationId: value.restorationId }),
    });
    const previous = pending ?? activation;
    if (!previous || !matches(previous)) return lifecycleFail('lifecycle_restore_destination_exists');
    if (pending && !matches(pending) || activation && !matches(activation) || pending && activation && !same(pending, activation)) lifecycleFail('lifecycle_restore_binding_mismatch');
    // Retry retains the exact original occurrence, including a legacy marker without a nonce.
    marker = previous;
  } else marker = AgentPostgresRestoreMarkerSchema.parse({ ...marker, restorationId: randomUUID() });
  const recovery: WindowsLifecycleRecovery = { operationId: id, backupDigest: manifest.digest, agentId: manifest.agentId,
    markerName, markerBytes: Buffer.from(JSON.stringify(marker, null, 2) + '\n') };
  const bindings = saved.transfer.sourceBindings;
  const pool = Object.freeze({ connect: host.pool.connect.bind(host.pool) });
  let fence: Awaited<ReturnType<typeof acquirePostgresMaintenance>> | undefined;
  let local: ReturnType<typeof acquireAgentMaintenance> | undefined;
  const failures: unknown[] = []; let result: { agentId: string; root: string; backupDigest: string; restorationId?: string; recoveryRequired: true; externalEffects: string } | undefined;
  try {
    if (!exists) { createLifecycleDirectory(target); publishLifecycleManifest(target, markerName, marker); }
    const metadata = join(target, '.secumon');
    if (!lifecycleExists(metadata)) createLifecycleDirectory(metadata);
    // This exact operation marker plus offline confirmation allows only the existing dead-owner check.
    if (exists) recoverAgentLifecycleLeases(target, true);
    local = acquireAgentMaintenance(target, true);
    if (!lifecycleExists(join(target, markerName))) publishLifecycleManifest(target, markerName, marker);
    fence = await acquirePostgresMaintenance(pool, bindings, id);
    restoreTree(join(saved.directory, 'data'), target, manifest.entries, id, recovery);
    checkLocalIdentity(target, manifest);
    const imported = await importPostgresAgent(pool, bindings, saved.transfer,
      pageId => readPostgresTransferPage(join(saved.directory, 'pages'), pageId), { operationId: id, maintenanceId: id });
    if (imported.operationId !== id || imported.snapshotDigest !== saved.transfer.digest) lifecycleFail('postgres_restore_import_mismatch');
    const verified = await exportPostgresAgent(pool, bindings, async (pageId, page) => {
      const index = saved.transfer.pages.findIndex(item => item.id === pageId), expected = saved.transfer.pages[index];
      if (!expected || transferPageDigest(page) !== expected.digest) lifecycleFail('postgres_restore_digest_mismatch');
    }, { maintenanceId: id });
    if (verified.digest !== saved.transfer.digest) lifecycleFail('postgres_restore_digest_mismatch');
    restoreTree(join(saved.directory, 'data'), target, manifest.entries, id, recovery);
    if (!lifecycleExists(join(target, activationName))) publishLifecycleManifest(target, activationName, marker);
    if (!same(readProfileJson(join(target, activationName), AgentPostgresRestoreMarkerSchema), marker)) lifecycleFail('lifecycle_restore_binding_mismatch');
    const releaseFence = fence; fence = undefined; await releaseFence.release();
    const releaseLocal = local; local = undefined; releaseLocal.close();
    const scope = openProfileMutationScope(target, [saved.directory]);
    try {
      if (!same(readProfileJson(join(target, markerName), AgentPostgresRestoreMarkerSchema, [1], 65536, scope), marker)) lifecycleFail('lifecycle_restore_binding_mismatch');
      syncProfileDirectory(target, scope); scope.check();
      if (process.platform === 'win32') removeWindowsLifecycleMarker(join(target, markerName), Buffer.from(JSON.stringify(marker, null, 2) + '\n'));
      else unlinkSync(join(target, markerName));
      syncProfileDirectory(target, scope); scope.check();
    } finally { scope.close(); }
    const ready = profiles.inspect(target);
    const current = ready.status === 'ready' ? effectiveAgentPostgresSelection(ready) : null;
    if (ready.status !== 'ready' || ready.identity.agentId !== manifest.agentId || !current || !same(selected(current), selected(manifest.selection))) lifecycleFail('lifecycle_restore_owner_mismatch');
    result = { agentId: manifest.agentId, root: target, backupDigest: manifest.digest, recoveryRequired: true,
      ...(marker.restorationId === undefined ? {} : { restorationId: marker.restorationId }),
      externalEffects: 'not undone; existing runtime recovery and external reconciliation remain required' };
  } catch (error) { failures.push(error); }
  finally {
    if (fence && !failures.some(error => uncertain(error))) try { await fence.release(); } catch (error) { failures.push(error); }
    if (local) try { local.close(); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'postgres_restore_cleanup_failed');
  return result!;
}
