import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_LOCAL_RESTORE_COMPLETION, AgentLocalRestoreMarkerSchema, type LifecycleEntry } from '../application/agent-lifecycle-contracts.js';
import { AgentConfigSchema, AgentIdentitySchema, type AgentIdentity, type AgentProfileStore } from '../application/agent-profile-contracts.js';
import type { AgentHostIdentityClaim, AgentHostIdentityOptions } from '../application/agent-host-identity-contracts.js';
import {
  AGENT_RESTORE_RECOVERY_MANIFEST, AgentRestoreRecoveryInputSchema, AgentRestoreRecoveryManifestSchema,
  type AgentRestoreRecoveryInput, type AgentRestoreRecoveryInspection,
} from '../application/agent-restore-recovery-contracts.js';
import { claimAgentHostIdentity, inspectAgentHostIdentity } from './agent-host-identities.js';
import { publishLifecycleManifest, readAgentEnginePin } from './agent-engine-release.js';
import { inspectAgentBackup } from './agent-lifecycle.js';
import { acquireAgentMaintenance } from './agent-lifecycle-lease.js';
import {
  captureLifecycleTree, copyLifecycleTree, disjoint, lifecycleDigest, lifecycleExists, lifecycleFail, lifecycleLimits,
  lifecycleNames, lifecycleRoot,
} from './agent-lifecycle-files.js';
import { effectiveAgentPostgresSelection } from './agent-postgres-migration-profile.js';
import { openProfileMutationScope, profileDirectory, readProfileBytes, readProfileJson } from './agent-profile-files.js';
import { readWindowsLifecycleJson } from './windows-lifecycle-files.js';

const metadataMaximum = 32 * 1024 * 1024;
const zeroDigest = '0'.repeat(64);
const restorePending = '.secumon-restore-in-progress.json';
const postgresCompletion = '.secumon-postgres-restore-complete.json';
const same = (left: unknown, right: unknown) => lifecycleDigest(left) === lifecycleDigest(right);
const included = (path: string) => path !== '.secumon/runtime-leases' && !path.startsWith('.secumon/runtime-leases/') &&
  path !== '.secumon/lifecycle-maintenance.json';
type Scope = ReturnType<typeof openProfileMutationScope>;

function owner(root: string, expected?: AgentIdentity) {
  const identity = readProfileJson(join(root, '.secumon', 'identity.json'), AgentIdentitySchema);
  const config = readProfileJson(join(root, 'config.json'), AgentConfigSchema, [1, 2]);
  if (!identity || !config || !same(identity, config.identity) || expected && !same(identity, expected))
    return lifecycleFail('agent_restore_recovery_binding_mismatch');
  // Local files cannot constitute a complete PostgreSQL snapshot, including an unfinished migration.
  if (config.storage.postgres || lifecycleExists(join(root, '.secumon', 'postgres-migration.json')) ||
    lifecycleExists(join(root, postgresCompletion))) lifecycleFail('lifecycle_external_storage_snapshot_required');
  return { identity, config, pin: readAgentEnginePin(root) };
}
function completed(root: string, agentId: string, targetRoot: string) {
  if (lifecycleExists(join(root, restorePending))) lifecycleFail('lifecycle_restore_incomplete');
  const bytes = readProfileBytes(join(root, AGENT_LOCAL_RESTORE_COMPLETION), 65536);
  if (!bytes) return lifecycleFail('lifecycle_restore_completion_required');
  const value = AgentLocalRestoreMarkerSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (value.agentId !== agentId || value.originalRoot !== targetRoot || value.operationId !== `local:${value.backupDigest}`)
    lifecycleFail('agent_restore_recovery_binding_mismatch');
  return { value, digest: createHash('sha256').update(bytes).digest('hex') };
}
function selected(archive: string, targetRoot: string, identity: AgentIdentity, expectedDigest: string) {
  const saved = inspectAgentBackup(archive);
  if (saved.manifest.digest !== expectedDigest || saved.manifest.agentId !== identity.agentId || saved.manifest.originalRoot !== targetRoot)
    lifecycleFail('agent_restore_recovery_binding_mismatch');
  const original = owner(join(archive, 'data'), identity);
  if ((original.pin?.releaseDigest ?? null) !== saved.manifest.releaseDigest)
    lifecycleFail('lifecycle_restore_engine_mismatch');
  if (saved.manifest.entries.some(entry => entry.path === restorePending || entry.path === AGENT_LOCAL_RESTORE_COMPLETION))
    lifecycleFail('lifecycle_restore_entries_invalid');
  return saved;
}
function comparison(prior: readonly LifecycleEntry[], next: readonly LifecycleEntry[]) {
  const before = new Map(prior.map(entry => [entry.path, entry])), after = new Map(next.map(entry => [entry.path, entry]));
  const added: string[] = [], removed: string[] = [], changed: string[] = []; let unchanged = 0;
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const old = before.get(path), current = after.get(path);
    if (!old) added.push(path); else if (!current) removed.push(path);
    else if (!same(old, current)) changed.push(path); else unchanged++;
  }
  return { added, removed, changed, unchanged };
}
function outputEntries(prior: readonly LifecycleEntry[], archive: readonly LifecycleEntry[]): LifecycleEntry[] {
  return [{ kind: 'directory', path: 'preserved' }, ...prior.map(entry => ({ ...entry, path: `preserved/${entry.path}` })),
    { kind: 'directory', path: 'selected-backup' }, ...archive.map(entry => ({ ...entry, path: `selected-backup/${entry.path}` }))];
}
function assertCapacity(entries: readonly LifecycleEntry[]) {
  if (entries.length + 1 > lifecycleLimits.entries || entries.reduce((bytes, entry) => bytes + (entry.kind === 'file' ? entry.bytes : 0), 0) > lifecycleLimits.bytes)
    lifecycleFail('lifecycle_capacity_exceeded');
}
function assertOutput(directory: string, expected: readonly LifecycleEntry[], scope: Scope) {
  scope.check();
  const actual = captureLifecycleTree(directory);
  if (!same(actual.filter(entry => entry.path !== AGENT_RESTORE_RECOVERY_MANIFEST), expected))
    lifecycleFail('agent_restore_recovery_digest_mismatch');
  scope.check();
}
function readManifest(directory: string, scope: Scope) {
  scope.check();
  const path = join(directory, AGENT_RESTORE_RECOVERY_MANIFEST);
  const manifest = process.platform === 'win32' ? readWindowsLifecycleJson(path, AgentRestoreRecoveryManifestSchema, metadataMaximum) :
    readProfileJson(path, AgentRestoreRecoveryManifestSchema, [1], metadataMaximum, scope);
  scope.check(); return manifest;
}

/** A preserved replacement candidate, never activation, history merging, identity rebind or effect clearance. */
export function prepareAgentRestoreRecovery(profiles: AgentProfileStore, value: AgentRestoreRecoveryInput,
  identityOptions: AgentHostIdentityOptions): AgentRestoreRecoveryInspection {
  const input = Object.freeze(AgentRestoreRecoveryInputSchema.parse(value));
  if (!input.offline) lifecycleFail('lifecycle_offline_confirmation_required');
  const root = lifecycleRoot(input.directory), archive = lifecycleRoot(input.backupDirectory), output = lifecycleRoot(input.destination, false);
  const registry = lifecycleRoot(identityOptions.registryDirectory ?? join(homedir(), '.secumon', 'host-identities'));
  const engines = [...new Set([fileURLToPath(new URL('../../', import.meta.url)), ...identityOptions.engineDirectories,
    ...(profiles.engineDirectories ?? [])].map(path => lifecycleRoot(path)))];
  const registration = Object.freeze({ registryDirectory: registry, engineDirectories: Object.freeze(engines) });
  for (const [index, path] of [root, archive, output, registry].entries()) {
    for (const other of [root, archive, output, registry].slice(index + 1)) disjoint(path, other);
    for (const engine of engines) disjoint(path, engine);
  }
  if (lifecycleExists(output)) lifecycleFail('agent_restore_recovery_destination_exists');
  const profile = profiles.inspect(root);
  if (profile.status !== 'ready' || profile.root !== root) return lifecycleFail('agent_profile_not_ready');
  if (effectiveAgentPostgresSelection(profile) || profile.postgresMigration || profile.effectivePersonalMemory.backend === 'postgres')
    lifecycleFail('lifecycle_external_storage_snapshot_required');
  if (profile.personalMemoryMigration?.phase === 'pending') lifecycleFail('agent_migration_resume_required');
  const head = inspectAgentHostIdentity(profile, registration);
  if (!head || head.digest !== input.expectedHeadDigest) lifecycleFail('agent_restore_recovery_binding_mismatch');
  const scopes: Scope[] = []; const failures: unknown[] = [];
  let claim: AgentHostIdentityClaim | undefined, lease: ReturnType<typeof acquireAgentMaintenance> | undefined;
  let result: AgentRestoreRecoveryInspection | undefined;
  try {
    claim = claimAgentHostIdentity(profile, registration);
    if (claim.digest !== input.expectedHeadDigest) lifecycleFail('agent_restore_recovery_binding_mismatch');
    lease = acquireAgentMaintenance(root, true);
    const sourceScope = openProfileMutationScope(root, [archive, output, registry, ...engines]); scopes.push(sourceScope);
    const archiveScope = openProfileMutationScope(archive, [root, output, registry, ...engines]); scopes.push(archiveScope);
    const outputScope = openProfileMutationScope(output, [root, archive, registry, ...engines]); scopes.push(outputScope);
    const leasePath = join(root, '.secumon', 'lifecycle-maintenance.json'), leaseBytes = readProfileBytes(leasePath, 65536, true, sourceScope);
    if (!leaseBytes) return lifecycleFail('lifecycle_lease_changed');
    const currentOwner = owner(root, profile.identity);
    if (!same(currentOwner.config, profile.config)) lifecycleFail('agent_restore_recovery_binding_mismatch');
    const completion = completed(root, profile.identity.agentId, root);
    const saved = selected(archive, root, profile.identity, input.expectedBackupDigest);
    const priorEntries = captureLifecycleTree(root, included), archiveEntries = captureLifecycleTree(archive);
    const expectedOutput = outputEntries(priorEntries, archiveEntries); assertCapacity(expectedOutput);
    const assertCurrent = () => {
      for (const scope of scopes) scope.check();
      claim!.assertCurrent();
      const currentLease = readProfileBytes(leasePath, 65536, true, sourceScope);
      if (!currentLease?.equals(leaseBytes) || lifecycleNames(join(root, '.secumon', 'runtime-leases')).length !== 0)
        lifecycleFail('lifecycle_lease_changed');
      if (!same(owner(root, profile.identity), currentOwner) || !same(completed(root, profile.identity.agentId, root), completion) ||
        !same(selected(archive, root, profile.identity, input.expectedBackupDigest).manifest, saved.manifest) ||
        !same(captureLifecycleTree(root, included), priorEntries) || !same(captureLifecycleTree(archive), archiveEntries))
        lifecycleFail('lifecycle_source_changed');
      for (const scope of scopes) scope.check();
      claim!.assertCurrent();
      if (!readProfileBytes(leasePath, 65536, true, sourceScope)?.equals(leaseBytes)) lifecycleFail('lifecycle_lease_changed');
    };
    const normalized = AgentRestoreRecoveryManifestSchema.parse({
      schemaVersion: 1, kind: 'secumon-agent-restore-recovery', operationId: input.operationId, agentId: profile.identity.agentId,
      targetRoot: root, createdAt: Date.now(),
      prior: { identityHeadDigest: head!.digest, completionDigest: completion.digest, restorationId: completion.value.restorationId ?? null,
        entries: priorEntries, digest: lifecycleDigest(priorEntries) },
      selectedBackup: { digest: saved.manifest.digest, originalRoot: saved.manifest.originalRoot, entries: archiveEntries, treeDigest: lifecycleDigest(archiveEntries) },
      comparison: comparison(priorEntries, saved.manifest.entries), activation: 'not_applied', digest: zeroDigest,
    });
    const { digest: _digest, ...body } = normalized;
    const manifest = AgentRestoreRecoveryManifestSchema.parse({ ...body, digest: lifecycleDigest(body) });
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    if (bytes.length > metadataMaximum || expectedOutput.reduce((sum, entry) => sum + (entry.kind === 'file' ? entry.bytes : 0), bytes.length) > lifecycleLimits.bytes)
      lifecycleFail('lifecycle_capacity_exceeded');
    assertCurrent();
    profileDirectory(output, true, true, outputScope, true);
    profileDirectory(join(output, 'preserved'), true, true, outputScope, true);
    profileDirectory(join(output, 'selected-backup'), true, true, outputScope, true);
    copyLifecycleTree(root, join(output, 'preserved'), priorEntries);
    assertCurrent();
    copyLifecycleTree(archive, join(output, 'selected-backup'), archiveEntries);
    assertOutput(output, expectedOutput, outputScope);
    // No source-current assertion follows issuance: this manifest describes verified copied originals, not permission to run them.
    assertCurrent();
    publishLifecycleManifest(output, AGENT_RESTORE_RECOVERY_MANIFEST, manifest);
    result = { directory: output, manifest };
  } catch (error) { failures.push(error); }
  finally {
    for (const scope of scopes.reverse()) try { scope.close(); } catch (error) { failures.push(error); }
    try { lease?.close(); } catch (error) { failures.push(error); }
    try { claim?.close(); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'agent_restore_recovery_cleanup_failed', { cause: failures[0] });
  return result!;
}

/** Verifies only the preserved package. It makes no claim about the current target directory or external effects. */
export function inspectAgentRestoreRecovery(input: string): AgentRestoreRecoveryInspection {
  const directory = lifecycleRoot(input), scope = openProfileMutationScope(directory, []);
  let primary: unknown;
  try {
    const manifest = readManifest(directory, scope);
    if (!manifest) return lifecycleFail('agent_restore_recovery_incomplete');
    const { digest, ...body } = manifest;
    if (lifecycleDigest(body) !== digest || lifecycleDigest(manifest.prior.entries) !== manifest.prior.digest ||
      lifecycleDigest(manifest.selectedBackup.entries) !== manifest.selectedBackup.treeDigest || manifest.selectedBackup.originalRoot !== manifest.targetRoot ||
      manifest.prior.entries.some(entry => !included(entry.path))) lifecycleFail('agent_restore_recovery_digest_mismatch');
    const expected = outputEntries(manifest.prior.entries, manifest.selectedBackup.entries); assertCapacity(expected);
    assertOutput(directory, expected, scope);
    const prior = owner(join(directory, 'preserved'));
    if (prior.identity.agentId !== manifest.agentId) lifecycleFail('agent_restore_recovery_binding_mismatch');
    const completion = completed(join(directory, 'preserved'), manifest.agentId, manifest.targetRoot);
    const saved = selected(join(directory, 'selected-backup'), manifest.targetRoot, prior.identity, manifest.selectedBackup.digest);
    if (completion.digest !== manifest.prior.completionDigest || (completion.value.restorationId ?? null) !== manifest.prior.restorationId ||
      !same(comparison(manifest.prior.entries, saved.manifest.entries), manifest.comparison)) lifecycleFail('agent_restore_recovery_digest_mismatch');
    assertOutput(directory, expected, scope);
    const again = readManifest(directory, scope);
    if (!same(again, manifest)) lifecycleFail('agent_restore_recovery_digest_mismatch');
    return { directory, manifest };
  } catch (error) { primary = error; throw error; }
  finally {
    try { scope.close(); } catch (error) {
      if (primary !== undefined) throw new AggregateError([primary, error], 'agent_restore_recovery_cleanup_failed', { cause: primary });
      throw error;
    }
  }
}
