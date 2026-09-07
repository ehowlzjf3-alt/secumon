import { join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { AGENT_LOCAL_RESTORE_COMPLETION, AgentLifecycleError, AgentLocalRestoreMarkerSchema } from '../application/agent-lifecycle-contracts.js';
import { AgentPostgresRestoreMarkerSchema } from '../application/agent-postgres-backup-contracts.js';
import { AgentConfigSchema, AgentIdentitySchema, type AgentIdentity } from '../application/agent-profile-contracts.js';
import { inspectAgentBackup } from './agent-lifecycle.js';
import { inspectAgentPostgresBackup } from './agent-postgres-backup.js';
import { acquireAgentMaintenance } from './agent-lifecycle-lease.js';
import { captureLifecycleTree, disjoint, lifecycleDigest, lifecycleExists, lifecycleFail, lifecycleNames, lifecycleRoot } from './agent-lifecycle-files.js';
import { readAgentEnginePin } from './agent-engine-release.js';
import { openProfileMutationScope, readProfileBytes, readProfileJson } from './agent-profile-files.js';
import { rebindAgentHostIdentity } from './agent-host-identities.js';

const pendingName = '.secumon-restore-in-progress.json';
const postgresCompletionName = '.secumon-postgres-restore-complete.json';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const InputSchema = z.strictObject({
  kind: z.enum(['local', 'postgres']), directory: z.string().min(1), backupDirectory: z.string().min(1),
  operationId: z.string().min(1).max(128), expectedBackupDigest: digest, expectedHeadDigest: digest,
  offline: z.boolean(),
});
export type RebindRestoredAgentHostIdentityInput = z.infer<typeof InputSchema>;
export type AgentHostIdentityRecoveryOptions = Parameters<typeof rebindAgentHostIdentity>[1];
const same = (left: unknown, right: unknown) => lifecycleDigest(left) === lifecycleDigest(right);

function included(path: string, kind: 'local' | 'postgres') {
  return path !== '.secumon/runtime-leases' && !path.startsWith('.secumon/runtime-leases/') &&
    path !== '.secumon/lifecycle-maintenance.json' && path !== AGENT_LOCAL_RESTORE_COMPLETION &&
    !(kind === 'postgres' && path === postgresCompletionName) &&
    !['.secumon/runtime.sqlite-shm', '.secumon/channel.sqlite-shm', 'memory/memory.sqlite-shm'].includes(path);
}
function completion<T>(path: string, schema: z.ZodType<T>) {
  const bytes = readProfileBytes(path, 65536);
  if (!bytes) return lifecycleFail('lifecycle_restore_completion_required');
  try { return { value: schema.parse(JSON.parse(bytes.toString('utf8'))), bytes: bytes.toString('base64') }; }
  catch (cause) { throw new AgentLifecycleError('lifecycle_restore_completion_invalid', { cause }); }
}

/** This checks a completed restoration, not whether restoring an old backup is currently permitted. */
async function inspectRestored(input: RebindRestoredAgentHostIdentityInput, root: string, archive: string, identity: AgentIdentity) {
  if (lifecycleExists(join(root, pendingName))) lifecycleFail('lifecycle_restore_incomplete');
  const saved = input.kind === 'local' ? inspectAgentBackup(archive) : await inspectAgentPostgresBackup(archive);
  const manifest = saved.manifest;
  if (manifest.digest !== input.expectedBackupDigest || manifest.agentId !== identity.agentId || manifest.originalRoot !== root) {
    lifecycleFail('lifecycle_restore_binding_mismatch');
  }
  let completed: { value: unknown; bytes: string };
  if (input.kind === 'local') {
    const local = completion(join(root, AGENT_LOCAL_RESTORE_COMPLETION), AgentLocalRestoreMarkerSchema);
    if (input.operationId !== `local:${manifest.digest}` || !same(local.value, {
      schemaVersion: 1, kind: 'secumon-local-restore', operationId: input.operationId,
      agentId: manifest.agentId, backupDigest: manifest.digest, originalRoot: root,
    })) lifecycleFail('lifecycle_restore_binding_mismatch');
    completed = local;
  } else {
    if (!('transfer' in saved)) return lifecycleFail('lifecycle_restore_binding_mismatch');
    const postgres = completion(join(root, postgresCompletionName), AgentPostgresRestoreMarkerSchema);
    if (!same(postgres.value, {
      schemaVersion: 1, kind: 'secumon-postgres-restore', operationId: input.operationId,
      agentId: manifest.agentId, backupDigest: manifest.digest, transferDigest: saved.transfer.digest,
      originalRoot: root, selection: saved.manifest.selection,
    })) lifecycleFail('lifecycle_restore_binding_mismatch');
    completed = postgres;
  }
  const currentIdentity = readProfileJson(join(root, '.secumon', 'identity.json'), AgentIdentitySchema);
  const originalIdentity = readProfileJson(join(archive, 'data', '.secumon', 'identity.json'), AgentIdentitySchema);
  const config = readProfileJson(join(root, 'config.json'), AgentConfigSchema, [1, 2]);
  if (!currentIdentity || !originalIdentity || !config || !same(currentIdentity, identity) ||
    !same(originalIdentity, identity) || !same(config.identity, identity)) lifecycleFail('lifecycle_restore_owner_mismatch');
  if ((readAgentEnginePin(root)?.releaseDigest ?? null) !== manifest.releaseDigest) lifecycleFail('lifecycle_restore_engine_mismatch');
  if (manifest.entries.some(entry => entry.path === pendingName || !included(entry.path, input.kind))) lifecycleFail('lifecycle_restore_entries_invalid');
  if (!same(captureLifecycleTree(root, path => included(path, input.kind)), manifest.entries)) lifecycleFail('lifecycle_restore_digest_mismatch');
  // Keep the archive manifest's actual bytes current, as well as its parsed digest and all data/page originals.
  const archiveManifest = captureLifecycleTree(archive, path => path === 'backup.json');
  if (archiveManifest.length !== 1 || archiveManifest[0]?.kind !== 'file') lifecycleFail('lifecycle_backup_missing');
  return lifecycleDigest({ manifest, completed, archiveManifest, identity });
}

/** Explicit post-restore identity registration. Does not open stores, recover old leases, or run work. */
export async function rebindRestoredAgentHostIdentity(value: RebindRestoredAgentHostIdentityInput, options: AgentHostIdentityRecoveryOptions) {
  const input = Object.freeze(InputSchema.parse(value));
  if (input.offline !== true) lifecycleFail('lifecycle_offline_confirmation_required');
  const root = lifecycleRoot(input.directory), archive = lifecycleRoot(input.backupDirectory);
  disjoint(root, archive);
  const registration = Object.freeze({ registryDirectory: options.registryDirectory,
    engineDirectories: Object.freeze([...options.engineDirectories]) });
  // Rebind requires an existing head; unlike an initial claim it cannot create a missing registry.
  const registry = lifecycleRoot(registration.registryDirectory ?? join(homedir(), '.secumon', 'host-identities'));
  disjoint(archive, registry);
  const identity = readProfileJson(join(root, '.secumon', 'identity.json'), AgentIdentitySchema);
  if (!identity) return lifecycleFail('lifecycle_restore_owner_mismatch');
  return rebindAgentHostIdentity({ root, identity }, registration, async publish => {
    // An existing lease is a refusal, including a dead/foreign lease. This API has no takeover path.
    const lease = acquireAgentMaintenance(root, true);
    let rootScope: ReturnType<typeof openProfileMutationScope> | undefined;
    let archiveScope: ReturnType<typeof openProfileMutationScope> | undefined;
    const failures: unknown[] = [];
    try {
      rootScope = openProfileMutationScope(root, [archive]);
      archiveScope = openProfileMutationScope(archive, [root]);
      const leasePath = join(root, '.secumon', 'lifecycle-maintenance.json');
      const leaseBytes = readProfileBytes(leasePath, 65536);
      if (!leaseBytes) lifecycleFail('lifecycle_lease_changed');
      const assertLeaseCurrent = () => {
        rootScope!.check(); archiveScope!.check();
        const current = readProfileBytes(leasePath, 65536);
        if (!current || !current.equals(leaseBytes!)) lifecycleFail('lifecycle_lease_changed');
        if (lifecycleNames(join(root, '.secumon', 'runtime-leases')).length !== 0) lifecycleFail('agent_runtime_active');
        if (lifecycleExists(join(root, pendingName))) lifecycleFail('lifecycle_restore_incomplete');
      };
      assertLeaseCurrent();
      const observed = await inspectRestored(input, root, archive, identity);
      assertLeaseCurrent();
      const assertProofCurrent = async () => {
        assertLeaseCurrent();
        if (await inspectRestored(input, root, archive, identity) !== observed) lifecycleFail('lifecycle_restore_source_changed');
        assertLeaseCurrent();
      };
      await publish({ operationId: input.operationId, backupDigest: input.expectedBackupDigest, originalRoot: root,
        expectedHeadDigest: input.expectedHeadDigest }, assertProofCurrent);
    } catch (error) { failures.push(error); }
    finally {
      for (const scope of [archiveScope, rootScope]) if (scope) try { scope.close(); } catch (error) { failures.push(error); }
      try { lease.close(); } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'agent_host_identity_recovery_cleanup_failed', { cause: failures[0] });
  });
}
