import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { AGENT_LOCAL_RESTORE_COMPLETION, AgentLocalRestoreMarkerSchema } from '../application/agent-lifecycle-contracts.js';
import { AgentPostgresRestoreMarkerSchema } from '../application/agent-postgres-backup-contracts.js';
import type { AgentProfileStore, AgentProfileStatus } from '../application/agent-profile-contracts.js';
import type { AgentHostIdentityHead, AgentHostIdentityOptions } from '../application/agent-host-identity-contracts.js';
import {
  AGENT_RESTORE_RECONCILIATION, AGENT_RESTORE_RECONCILIATION_PENDING, AgentRestoreReconciliationBasisSchema,
  AgentRestoreReconciliationPendingSchema,
  AgentRestoreReconciliationReceiptSchema, AgentRestoreReconciliationReportSchema,
  type AgentRestoreReconciliationBasis, type AgentRestoreReconciliationReceipt,
  type AgentRestoreReconciliationRegistration, type AgentRestoreReconciliationReport,
} from '../application/agent-restore-reconciliation-contracts.js';
import { frozen } from '../application/resource-contracts.js';
import { captureLifecycleTree, lifecycleDigest, lifecycleExists, lifecycleFail } from './agent-lifecycle-files.js';
import { acquireAgentMaintenance } from './agent-lifecycle-lease.js';
import { claimAgentHostIdentity, inspectAgentHostIdentity } from './agent-host-identities.js';
import { openProfileMutationScope, publishProfileJson, readProfileBytes, syncProfileDirectory } from './agent-profile-files.js';
import { sha256 } from './digest.js';
import { removeWindowsLifecycleMarker } from './windows-lifecycle-files.js';

type Ready = Extract<AgentProfileStatus, { status: 'ready' }>;
const pendingName = '.secumon-restore-in-progress.json';
const postgresCompletionName = '.secumon-postgres-restore-complete.json';
const maximumReceiptBytes = 1024 * 1024;
const emptyDigest = '0'.repeat(64);
const same = (a: unknown, b: unknown) => lifecycleDigest(a) === lifecycleDigest(b);
function ready(profiles: AgentProfileStore, directory: string): Ready {
  const profile = profiles.inspect(directory);
  if (profile.status !== 'ready') return lifecycleFail('agent_profile_not_ready');
  if (profile.personalMemoryMigration?.phase === 'pending' || profile.postgresMigration?.phase === 'pending')
    return lifecycleFail('agent_migration_resume_required');
  return profile;
}

function restored(profile: Ready) {
  if (lifecycleExists(join(profile.root, pendingName))) return lifecycleFail('lifecycle_restore_incomplete');
  const local = readProfileBytes(join(profile.root, AGENT_LOCAL_RESTORE_COMPLETION), 65536);
  const postgres = readProfileBytes(join(profile.root, postgresCompletionName), 65536);
  if (local && postgres) return lifecycleFail('agent_restore_completion_ambiguous');
  const bytes = local ?? postgres;
  if (!bytes) return null;
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { return lifecycleFail('agent_restore_completion_invalid'); }
  const result = local ? AgentLocalRestoreMarkerSchema.safeParse(value) : AgentPostgresRestoreMarkerSchema.safeParse(value);
  if (!result.success) return lifecycleFail('agent_restore_completion_invalid');
  const marker = result.data;
  if (marker.agentId !== profile.identity.agentId || marker.originalRoot !== profile.root)
    return lifecycleFail('agent_restore_binding_mismatch');
  return { marker, restoreKind: local ? 'local' as const : 'postgres' as const, completionDigest: sha256(bytes) };
}
function binding(profile: Ready, head: AgentHostIdentityHead | null, completed: NonNullable<ReturnType<typeof restored>>) {
  if (!completed.marker.restorationId) return null;
  if (!head) return null;
  return {
    schemaVersion: 1 as const, agentId: profile.identity.agentId, root: profile.root,
    restorationId: completed.marker.restorationId, restoreKind: completed.restoreKind,
    operationId: completed.marker.operationId, backupDigest: completed.marker.backupDigest,
    completionDigest: completed.completionDigest, identityHeadDigest: head.digest,
  };
}
function receiptBinding(basis: AgentRestoreReconciliationBasis) {
  const { localTreeDigest: _tree, digest: _digest, ...value } = basis;
  return value;
}
function receiptAt(root: string): AgentRestoreReconciliationReceipt | null {
  const bytes = readProfileBytes(join(root, AGENT_RESTORE_RECONCILIATION), maximumReceiptBytes);
  if (!bytes) return null;
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { return lifecycleFail('agent_restore_receipt_invalid'); }
  const parsed = AgentRestoreReconciliationReceiptSchema.safeParse(value);
  if (!parsed.success) return lifecycleFail('agent_restore_receipt_invalid');
  const receipt = parsed.data;
  const { digest: expected, ...body } = receipt;
  const { digest: basisDigest, ...basisBody } = receipt.basis;
  if (lifecycleDigest(body) !== expected || lifecycleDigest(basisBody) !== basisDigest ||
      new Set(receipt.reports.map(report => report.sourceId)).size !== receipt.reports.length ||
      receipt.reports.some(report => report.status !== 'consistent' || report.basisDigest !== basisDigest))
    return lifecycleFail('agent_restore_receipt_invalid');
  return receipt;
}
function pendingAt(root: string) {
  const bytes = readProfileBytes(join(root, AGENT_RESTORE_RECONCILIATION_PENDING), 65536);
  if (!bytes) return null;
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { return lifecycleFail('agent_restore_pending_invalid'); }
  const parsed = AgentRestoreReconciliationPendingSchema.safeParse(value);
  if (!parsed.success) return lifecycleFail('agent_restore_pending_invalid');
  const { digest, ...body } = parsed.data.basis;
  if (lifecycleDigest(body) !== digest) return lifecycleFail('agent_restore_pending_invalid');
  return { value: parsed.data, bytes };
}
function status(profile: Ready, head: AgentHostIdentityHead | null) {
  const completed = restored(profile), receipt = receiptAt(profile.root), pending = pendingAt(profile.root);
  if (!completed) {
    if (receipt || pending) return lifecycleFail('agent_restore_receipt_without_restore');
    return { status: 'not_restored' as const, agentId: profile.identity.agentId, root: profile.root };
  }
  const current = binding(profile, head, completed);
  if (pending) return { status: 'required' as const, agentId: profile.identity.agentId, root: profile.root,
    reason: 'reconciliation_publication_pending' };
  if (!current) return { status: 'required' as const, agentId: profile.identity.agentId, root: profile.root,
    reason: completed.marker.restorationId ? 'identity_registration_required' : 'restore_occurrence_required' };
  if (!receipt || !same(receiptBinding(receipt.basis), current))
    return { status: 'required' as const, agentId: profile.identity.agentId, root: profile.root,
      reason: receipt ? 'receipt_binding_mismatch' : 'external_reconciliation_required' };
  return { status: 'reconciled' as const, basis: receipt.basis, reports: receipt.reports, receiptDigest: receipt.digest };
}

/** Management inspection never claims identity, opens a provider or migrates a store. */
export function inspectAgentRestoreReconciliation(profiles: AgentProfileStore, directory: string, options: AgentHostIdentityOptions) {
  const profile = ready(profiles, directory);
  return status(profile, inspectAgentHostIdentity(profile, options));
}
/** Startup remains cheap after a successful reconciliation; do not hash the entire working tree here. */
export function assertAgentRestoreReconciled(profile: Ready, head: AgentHostIdentityHead): void {
  if (status(profile, head).status === 'required') lifecycleFail('agent_restore_reconciliation_required');
}

const includeTree = (path: string) => path !== AGENT_RESTORE_RECONCILIATION && path !== AGENT_RESTORE_RECONCILIATION_PENDING &&
  path !== '.secumon/runtime-leases' && !path.startsWith('.secumon/runtime-leases/') &&
  path !== '.secumon/lifecycle-maintenance.json' &&
  !['.secumon/runtime.sqlite-shm', '.secumon/channel.sqlite-shm', 'memory/memory.sqlite-shm'].includes(path);
const treeDigest = (root: string) => lifecycleDigest(captureLifecycleTree(root, includeTree));

function captureSources(options: AgentRestoreReconciliationRegistration) {
  if (!options.sources || options.sources.size < 1 || options.sources.size > 64) return lifecycleFail('agent_restore_sources_required');
  const sources = [...options.sources].map(([id, source]) => {
    if (typeof id !== 'string' || !id.trim() || id.length > 256 || /[\x00-\x1f\x7f]/.test(id) ||
        !source || typeof source.revision !== 'string' || !source.revision.trim() || source.revision.length > 256 ||
        /[\x00-\x1f\x7f]/.test(source.revision) || typeof source.inspect !== 'function' || typeof source.verify !== 'function')
      return lifecycleFail('agent_restore_source_invalid');
    return Object.freeze({ id, revision: source.revision, inspect: source.inspect.bind(source), verify: source.verify.bind(source) });
  });
  if (sources.length !== options.sources.size || new Set(sources.map(source => source.id)).size !== sources.length)
    return lifecycleFail('agent_restore_source_invalid');
  return Object.freeze(sources);
}

/** Offline reconciliation issues only a restore clearance. It never executes work, imports a tool
 * result, marks a goal complete, or settles resources from a source's assertion. */
export async function reconcileAgentRestore(profiles: AgentProfileStore, input: { directory: string; offline: boolean },
  options: AgentHostIdentityOptions & AgentRestoreReconciliationRegistration) {
  if (input.offline !== true) return lifecycleFail('lifecycle_offline_confirmation_required');
  const sources = captureSources(options);
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) return lifecycleFail('agent_restore_timeout_invalid');
  const profile = ready(profiles, input.directory);
  const identity = claimAgentHostIdentity(profile, options);
  let lease: ReturnType<typeof acquireAgentMaintenance> | undefined;
  let scope: ReturnType<typeof openProfileMutationScope> | undefined;
  let primary: { error: unknown } | undefined;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const existing = status(profile, identity);
    if (existing.status === 'not_restored') return lifecycleFail('agent_restore_completion_required');
    if (existing.status === 'reconciled') { identity.assertCurrent(); return existing; }
    lease = acquireAgentMaintenance(profile.root, true);
    scope = openProfileMutationScope(profile.root, options.engineDirectories);
    const completed = restored(profile)!;
    const current = binding(profile, identity, completed);
    if (!current) return lifecycleFail('agent_restore_occurrence_required');
    const previousPending = pendingAt(profile.root), previousReceipt = receiptAt(profile.root);
    // Only a still-provisional receipt can be retried, without changing its original proof.
    if (previousReceipt && !previousPending) return lifecycleFail('agent_restore_receipt_binding_mismatch');
    const draft = AgentRestoreReconciliationBasisSchema.parse({ ...current, localTreeDigest: treeDigest(profile.root), digest: emptyDigest });
    const { digest: _ignored, ...body } = draft;
    const basis = frozen({ ...body, digest: lifecycleDigest(body) });
    if (previousPending && !same(previousPending.value.basis, basis) || previousReceipt && !same(previousReceipt.basis, basis))
      return lifecycleFail('agent_restore_reconciliation_recovery_required');
    const assertUnchanged = () => {
      scope!.check(); identity.assertCurrent();
      const latest = restored(profile);
      if (!latest || !same(binding(profile, identity, latest), current) || treeDigest(profile.root) !== basis.localTreeDigest)
        lifecycleFail('agent_restore_basis_changed');
      scope!.check(); identity.assertCurrent();
    };
    assertUnchanged();
    // The deadline covers all readers and verification, not one fresh allowance per source.
    const deadline = performance.now() + timeoutMs;
    const checkDeadline = () => {
      if (controller.signal.aborted || performance.now() >= deadline) {
        controller.abort(); lifecycleFail('agent_restore_source_timeout');
      }
    };
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); try { lifecycleFail('agent_restore_source_timeout'); } catch (error) { reject(error); } }, timeoutMs);
    });
    const call = async <T>(action: () => Promise<T>) => {
      checkDeadline(); const result = await Promise.race([Promise.resolve().then(action), expired]);
      checkDeadline(); return result;
    };
    const reports: AgentRestoreReconciliationReport[] = [];
    for (const source of sources) {
      const raw = await call(() => source.inspect(basis, controller.signal));
      const parsed = AgentRestoreReconciliationReportSchema.safeParse(raw);
      if (!parsed.success || parsed.data.sourceId !== source.id || parsed.data.sourceRevision !== source.revision || parsed.data.basisDigest !== basis.digest)
        return lifecycleFail('agent_restore_report_invalid');
      reports.push(frozen(parsed.data));
      if (Buffer.byteLength(JSON.stringify(reports), 'utf8') > maximumReceiptBytes / 2) return lifecycleFail('agent_restore_report_too_large');
    }
    assertUnchanged();
    checkDeadline();
    if (reports.some(report => report.status === 'unresolved')) return { status: 'unresolved' as const, basis, reports };
    for (let index = 0; index < sources.length; index++) {
      if (await call(() => sources[index]!.verify(basis, reports[index]!, controller.signal)) !== true)
        return lifecycleFail('agent_restore_source_changed');
    }
    assertUnchanged();
    checkDeadline();
    const candidate = AgentRestoreReconciliationReceiptSchema.parse({ schemaVersion: 1, kind: 'agent-restore-reconciliation',
      basis, reports, checkedAt: Date.now(), digest: emptyDigest });
    const { digest: _receiptDigest, ...receiptBody } = candidate;
    let receipt = { ...receiptBody, digest: lifecycleDigest(receiptBody) };
    if (previousReceipt) {
      if (!same(previousReceipt.reports, reports)) return lifecycleFail('agent_restore_reconciliation_recovery_required');
      receipt = previousReceipt;
    }
    if (Buffer.byteLength(JSON.stringify(receipt), 'utf8') > maximumReceiptBytes) return lifecycleFail('agent_restore_report_too_large');
    const pendingPath = join(profile.root, AGENT_RESTORE_RECONCILIATION_PENDING);
    const pending = { schemaVersion: 1 as const, kind: 'agent-restore-reconciliation-pending' as const, basis };
    if (!previousPending && !publishProfileJson(pendingPath, pending, scope)) return lifecycleFail('agent_restore_receipt_conflict');
    syncProfileDirectory(profile.root, scope);
    const pendingBytes = pendingAt(profile.root);
    if (!pendingBytes || !same(pendingBytes.value, pending)) return lifecycleFail('agent_restore_pending_changed');
    if (!previousReceipt && !publishProfileJson(join(profile.root, AGENT_RESTORE_RECONCILIATION), receipt, scope))
      return lifecycleFail('agent_restore_receipt_conflict');
    syncProfileDirectory(profile.root, scope); assertUnchanged();
    checkDeadline();
    if (!same(receiptAt(profile.root), receipt)) return lifecycleFail('agent_restore_receipt_conflict');
    const finalPending = pendingAt(profile.root);
    if (!finalPending || !finalPending.bytes.equals(pendingBytes.bytes)) return lifecycleFail('agent_restore_pending_changed');
    scope.check();
    if (process.platform === 'win32') removeWindowsLifecycleMarker(pendingPath, pendingBytes.bytes);
    else unlinkSync(pendingPath);
    syncProfileDirectory(profile.root, scope); scope.check();
    return { status: 'reconciled' as const, basis, reports, receiptDigest: receipt.digest };
  } catch (error) { primary = { error }; throw error; }
  finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
    const errors: unknown[] = primary ? [primary.error] : [];
    for (const close of [() => scope?.close(), () => lease?.close(), () => identity.close()]) {
      try { close(); } catch (error) { errors.push(error); }
    }
    if (errors.length > (primary ? 1 : 0)) throw new AggregateError(errors, 'agent_restore_reconciliation_cleanup_failed', { cause: errors[0] });
  }
}
