import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { AgentProfileStore } from '../application/agent-profile-contracts.js';
import type { AgentHostIdentityOptions } from '../application/agent-host-identity-contracts.js';
import { AGENT_LOCAL_RESTORE_COMPLETION, AgentLocalRestoreMarkerSchema } from '../application/agent-lifecycle-contracts.js';
import {
  AGENT_RESTORE_RECOVERY_PENDING, AgentRestoreRecoveryApplyInputSchema, AgentRestoreRecoveryApplyIntentSchema,
  AgentRestoreRecoveryApplyPendingSchema, AgentRestoreRecoveryApplyCompleteSchema, AgentRestoreRecoveryPartialSchema,
  type AgentRestoreRecoveryApplyInput, type AgentRestoreRecoveryApplyIntent, type AgentRestoreRecoveryApplyComplete,
  type AgentRestoreRecoveryApplyProgress,
} from '../application/agent-restore-recovery-apply-contracts.js';
import { claimAgentHostIdentity, inspectAgentHostIdentity, agentHostIdentityRegistryDirectory } from './agent-host-identities.js';
import { inspectAgentRestoreRecovery } from './agent-restore-recovery.js';
import { rebindRestoredAgentHostIdentity } from './agent-host-identity-recovery.js';
import { restoreAgentBackup } from './agent-lifecycle.js';
import { acquireAgentMaintenance, recoverAgentLifecycleLeases } from './agent-lifecycle-lease.js';
import { captureLifecycleTree, disjoint, lifecycleDigest, lifecycleExists, lifecycleFail, lifecycleRoot } from './agent-lifecycle-files.js';
import { openProfileMutationScope, profileDirectory, publishProfileJson, readProfileJson } from './agent-profile-files.js';
import { hostMetadataFiles, releaseMetadataDirectory, sameFileIdentity, type FileIdentity } from './host-metadata-files.js';
import { assertHostDirectoryRetirementAvailable, inspectHostDirectoryRetirement, retireHostDirectory } from './host-directory-retirement.js';

const restorePending = '.secumon-restore-in-progress.json';
const RestorePendingSchema = z.strictObject({ schemaVersion: z.literal(1), backupDigest: z.string(), agentId: z.uuid(), restorationId: z.uuid().optional() });
const fail = (code: string): never => lifecycleFail(`agent_restore_recovery_${code}`);
const same = (a: unknown, b: unknown) => lifecycleDigest(a) === lifecycleDigest(b);
const originalIncluded = (path: string) => path !== '.secumon/runtime-leases' && !path.startsWith('.secumon/runtime-leases/') &&
  path !== '.secumon/lifecycle-maintenance.json' && path !== AGENT_RESTORE_RECOVERY_PENDING;
type Prepared = ReturnType<typeof inspectAgentRestoreRecovery>;
function signed<T extends { digest: string }>(schema: z.ZodType<T>, body: Omit<T, 'digest'>): T {
  const { digest: _, ...parsed } = schema.parse({ ...body, digest: '0'.repeat(64) });
  return schema.parse({ ...parsed, digest: lifecycleDigest(parsed) });
}
function readSigned<T extends { digest: string }>(path: string, schema: z.ZodType<T>) {
  const result = readProfileJson(path, schema); if (!result) return null;
  const { digest, ...body } = result; if (lifecycleDigest(body) !== digest) fail('application_record_changed');
  return result;
}
function identity(root: string): FileIdentity {
  const files = hostMetadataFiles(), directory = files.inspectDirectory(root, 'owner-writable');
  if (!directory) return fail('directory_missing');
  try { return { ...directory.identity }; } finally { releaseMetadataDirectory(files, directory); }
}
function writeRecord(directory: string, name: string, value: unknown, forbidden: readonly string[]) {
  const scope = openProfileMutationScope(directory, forbidden);
  try {
    scope.check();
    if (!publishProfileJson(join(directory, name), value, scope)) fail('application_record_exists');
    scope.check();
  } finally { scope.close(); }
}
function locations(prepared: Prepared) {
  const root = prepared.manifest.targetRoot, operationId = prepared.manifest.operationId;
  return { root, retiredDirectory: join(dirname(root), `.secumon-retired-${operationId}`), operationDirectory: `${prepared.directory}.apply` };
}
function readIntent(prepared: Prepared) {
  const expected = locations(prepared), intent = readSigned(join(expected.operationDirectory, 'intent.json'), AgentRestoreRecoveryApplyIntentSchema);
  if (!intent) return null;
  if (intent.operationId !== prepared.manifest.operationId || intent.agentId !== prepared.manifest.agentId || intent.recoveryDirectory !== prepared.directory ||
    intent.recoveryDigest !== prepared.manifest.digest || intent.backupDigest !== prepared.manifest.selectedBackup.digest ||
    intent.previousHeadDigest !== prepared.manifest.prior.identityHeadDigest || intent.root !== expected.root ||
    intent.retiredDirectory !== expected.retiredDirectory || intent.operationDirectory !== expected.operationDirectory) fail('application_binding_mismatch');
  return intent;
}
function readComplete(intent: AgentRestoreRecoveryApplyIntent) {
  const complete = readSigned(join(intent.operationDirectory, 'complete.json'), AgentRestoreRecoveryApplyCompleteSchema);
  if (complete && (complete.intentDigest !== intent.digest || complete.operationId !== intent.operationId || complete.agentId !== intent.agentId))
    fail('application_binding_mismatch');
  return complete;
}
function summary(intent: AgentRestoreRecoveryApplyIntent, complete: AgentRestoreRecoveryApplyComplete) {
  return { operationId: intent.operationId, agentId: intent.agentId, root: intent.root, retiredDirectory: intent.retiredDirectory,
    operationDirectory: intent.operationDirectory, restorationId: complete.restorationId, identityHeadDigest: complete.identityHeadDigest,
    reconciliationRequired: true as const, stage: 'restored' as const };
}
/** A historical application receipt, separate from current effect reconciliation and work completion. */
export function readAgentRestoreRecoveryApplication(recoveryDirectory: string) {
  const prepared = inspectAgentRestoreRecovery(recoveryDirectory), paths = locations(prepared);
  if (!lifecycleExists(paths.operationDirectory)) return { operationId: prepared.manifest.operationId, ...paths, stage: 'not_started' as const };
  const intent = readIntent(prepared);
  if (!intent) return { operationId: prepared.manifest.operationId, ...paths, stage: 'incomplete' as const };
  const complete = readComplete(intent);
  return complete ? { ...summary(intent, complete), currentStateVerified: false } : {
    operationId: intent.operationId, ...paths, stage: 'applying' as const, currentStateVerified: false,
  };
}

function assertOriginal(prepared: Prepared, root: string) {
  if (!same(captureLifecycleTree(root, originalIncluded), prepared.manifest.prior.entries)) fail('original_changed');
}
function assertPackage(prepared: Prepared) {
  const actual = inspectAgentRestoreRecovery(prepared.directory);
  if (!same(actual.manifest, prepared.manifest)) fail('package_changed');
}
function pending(intent: AgentRestoreRecoveryApplyIntent) {
  return AgentRestoreRecoveryApplyPendingSchema.parse({ schemaVersion: 1, operationId: intent.operationId,
    recoveryDigest: intent.recoveryDigest, intentDigest: intent.digest });
}
function preserveOriginal(profiles: AgentProfileStore, prepared: Prepared, intent: AgentRestoreRecoveryApplyIntent,
  host: AgentHostIdentityOptions, forbidden: readonly string[]) {
  const move = { source: intent.root, destination: intent.retiredDirectory, expectedIdentity: intent.originalIdentity, forbiddenRoots: forbidden };
  const observed = inspectHostDirectoryRetirement(move);
  if (observed.retired) {
    assertOriginal(prepared, intent.retiredDirectory);
    if (!same(readProfileJson(join(intent.retiredDirectory, AGENT_RESTORE_RECOVERY_PENDING), AgentRestoreRecoveryApplyPendingSchema), pending(intent)))
      fail('application_binding_mismatch');
    return;
  }
  const profile = profiles.inspect(intent.root); if (profile.status !== 'ready') return fail('profile_not_ready');
  const claim = claimAgentHostIdentity(profile, host); let lease: ReturnType<typeof acquireAgentMaintenance> | undefined;
  const errors: unknown[] = [];
  try {
    if (claim.digest !== intent.previousHeadDigest || !sameFileIdentity(claim.record.rootIdentity, intent.originalIdentity)) fail('application_binding_mismatch');
    const savedPending = readProfileJson(join(intent.root, AGENT_RESTORE_RECOVERY_PENDING), AgentRestoreRecoveryApplyPendingSchema);
    if (savedPending && !same(savedPending, pending(intent))) fail('application_binding_mismatch');
    // Only the same recorded offline operation may clean a demonstrably dead local lease.
    recoverAgentLifecycleLeases(intent.root, true);
    lease = acquireAgentMaintenance(intent.root, true);
    assertOriginal(prepared, intent.root); assertPackage(prepared); claim.assertCurrent();
    if (!savedPending) writeRecord(intent.root, AGENT_RESTORE_RECOVERY_PENDING, pending(intent), forbidden);
    assertOriginal(prepared, intent.root); claim.assertCurrent();
  } catch (error) { errors.push(error); }
  finally {
    try { lease?.close(); } catch (error) { errors.push(error); }
    try { claim.close(); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, 'agent_restore_recovery_original_cleanup_failed');
  // The persisted pending gate remains while path-bound metadata handles are released for the native move.
  assertOriginal(prepared, intent.root); assertPackage(prepared);
  retireHostDirectory(move);
  assertOriginal(prepared, intent.retiredDirectory);
}

/** POSIX restore retries retain the partial directory, then copy the original archive into a new root. */
function preservePartial(intent: AgentRestoreRecoveryApplyIntent, forbidden: readonly string[]) {
  const marker = readProfileJson(join(intent.root, restorePending), RestorePendingSchema);
  if (!marker || marker.agentId !== intent.agentId || marker.backupDigest !== intent.backupDigest || !marker.restorationId)
    return fail('partial_restore_unidentified');
  const name = `partial-${marker.restorationId}.json`, destination = join(dirname(intent.root), `.secumon-partial-${intent.operationId}-${marker.restorationId}`);
  let saved = readSigned(join(intent.operationDirectory, name), AgentRestoreRecoveryPartialSchema);
  if (!saved) {
    saved = signed(AgentRestoreRecoveryPartialSchema, { schemaVersion: 1, intentDigest: intent.digest, restorationId: marker.restorationId,
      rootIdentity: identity(intent.root), destination });
    writeRecord(intent.operationDirectory, name, saved, forbidden.filter(path => path !== intent.operationDirectory));
  }
  if (saved.intentDigest !== intent.digest || saved.restorationId !== marker.restorationId || saved.destination !== destination)
    fail('application_binding_mismatch');
  retireHostDirectory({ source: intent.root, destination, expectedIdentity: saved.rootIdentity, forbiddenRoots: forbidden });
}

/** Applies one explicitly selected full replacement; external history reconciliation remains a separate existing operation. */
export async function applyAgentRestoreRecovery(profiles: AgentProfileStore, value: AgentRestoreRecoveryApplyInput,
  host: AgentHostIdentityOptions, options: { onProgress?: (phase: AgentRestoreRecoveryApplyProgress) => void } = {}) {
  const input = AgentRestoreRecoveryApplyInputSchema.parse(value);
  if (!input.offline) lifecycleFail('lifecycle_offline_confirmation_required');
  const prepared = inspectAgentRestoreRecovery(input.recoveryDirectory);
  if (prepared.manifest.digest !== input.expectedDigest) fail('application_binding_mismatch');
  assertHostDirectoryRetirementAvailable();
  host = Object.freeze({ ...host, engineDirectories: Object.freeze([...host.engineDirectories]) });
  const paths = locations(prepared), registry = lifecycleRoot(agentHostIdentityRegistryDirectory(host));
  const engines = [...new Set([...host.engineDirectories, ...(profiles.engineDirectories ?? [])].map(path => lifecycleRoot(path)))];
  const protectedRoots = [prepared.directory, paths.operationDirectory, registry, ...engines];
  for (const [index, path] of [paths.root, paths.retiredDirectory, ...protectedRoots].entries())
    for (const other of [paths.root, paths.retiredDirectory, ...protectedRoots].slice(index + 1)) disjoint(path, other);
  let intent = lifecycleExists(paths.operationDirectory) ? readIntent(prepared) : null;
  if (!intent) {
    if (lifecycleExists(paths.operationDirectory)) return fail('application_intent_missing');
    const profile = profiles.inspect(paths.root); if (profile.status !== 'ready') return fail('profile_not_ready');
    const head = inspectAgentHostIdentity(profile, host);
    if (!head || head.digest !== prepared.manifest.prior.identityHeadDigest || !sameFileIdentity(head.record.rootIdentity, identity(paths.root)))
      return fail('application_binding_mismatch');
    assertOriginal(prepared, paths.root);
    inspectHostDirectoryRetirement({ source: paths.root, destination: paths.retiredDirectory, expectedIdentity: head.record.rootIdentity,
      forbiddenRoots: protectedRoots });
    intent = signed(AgentRestoreRecoveryApplyIntentSchema, { schemaVersion: 1, kind: 'secumon-restore-recovery-application',
      operationId: prepared.manifest.operationId, agentId: prepared.manifest.agentId, recoveryDirectory: prepared.directory,
      recoveryDigest: prepared.manifest.digest, ...paths, originalIdentity: head.record.rootIdentity,
      previousHeadDigest: head.digest, backupDigest: prepared.manifest.selectedBackup.digest });
    const scope = openProfileMutationScope(paths.operationDirectory, [paths.root, paths.retiredDirectory, prepared.directory, registry, ...engines]);
    try {
      profileDirectory(paths.operationDirectory, true, true, scope, true);
      profileDirectory(join(paths.operationDirectory, '.secumon'), true, true, scope, true);
      if (!publishProfileJson(join(paths.operationDirectory, 'intent.json'), intent, scope)) fail('application_record_exists');
      scope.check();
    } finally { scope.close(); }
  }
  // Exclusive management lease; live or foreign owners are never displaced by a retry.
  recoverAgentLifecycleLeases(intent.operationDirectory, true);
  const lease = acquireAgentMaintenance(intent.operationDirectory, true);
  let failure: unknown;
  try {
    assertPackage(prepared);
    if (!same(readIntent(prepared), intent)) return fail('application_binding_mismatch');
    const completed = readComplete(intent);
    if (completed) {
      const profile = profiles.inspect(intent.root); if (profile.status !== 'ready') return fail('application_no_longer_current');
      const head = inspectAgentHostIdentity(profile, host);
      if (head?.digest !== completed.identityHeadDigest || !sameFileIdentity(identity(intent.root), completed.rootIdentity))
        return fail('application_no_longer_current');
      return summary(intent, completed);
    }
    preserveOriginal(profiles, prepared, intent, host, protectedRoots);
    options.onProgress?.('original_preserved');
    assertPackage(prepared); assertOriginal(prepared, intent.retiredDirectory);
    let restored = lifecycleExists(intent.root) ? readProfileJson(join(intent.root, AGENT_LOCAL_RESTORE_COMPLETION), AgentLocalRestoreMarkerSchema) : null;
    if (lifecycleExists(intent.root) && lifecycleExists(join(intent.root, restorePending))) {
      if (process.platform !== 'win32') preservePartial(intent, protectedRoots);
      restored = null;
    }
    if (!restored) {
      restoreAgentBackup(profiles, join(prepared.directory, 'selected-backup'), intent.root, intent.backupDigest, true);
      restored = readProfileJson(join(intent.root, AGENT_LOCAL_RESTORE_COMPLETION), AgentLocalRestoreMarkerSchema);
    }
    if (!restored?.restorationId || restored.agentId !== intent.agentId || restored.backupDigest !== intent.backupDigest ||
      restored.originalRoot !== intent.root || restored.restorationId === prepared.manifest.prior.restorationId)
      return fail('application_binding_mismatch');
    options.onProgress?.('restored');
    assertPackage(prepared);
    recoverAgentLifecycleLeases(intent.root, true);
    const head = await rebindRestoredAgentHostIdentity({ kind: 'local', directory: intent.root, backupDirectory: join(prepared.directory, 'selected-backup'),
      operationId: restored.operationId, expectedBackupDigest: intent.backupDigest, expectedHeadDigest: intent.previousHeadDigest, offline: true }, host);
    options.onProgress?.('identity_rebound');
    const complete = signed(AgentRestoreRecoveryApplyCompleteSchema, { schemaVersion: 1, operationId: intent.operationId, agentId: intent.agentId,
      intentDigest: intent.digest, restorationId: restored.restorationId, identityHeadDigest: head.digest, rootIdentity: head.record.rootIdentity });
    writeRecord(intent.operationDirectory, 'complete.json', complete, [intent.root, intent.retiredDirectory, prepared.directory, registry, ...engines]);
    return summary(intent, complete);
  } catch (error) { failure = error; throw error; }
  finally {
    try { lease.close(); } catch (error) {
      if (failure !== undefined) throw new AggregateError([failure, error], 'agent_restore_recovery_apply_cleanup_failed', { cause: failure });
      throw error;
    }
  }
}
