import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { readdirSync, unlinkSync } from 'node:fs';
import { z } from 'zod';
import { SQLITE_RECOVERY_PENDING, SqliteRecoveryPendingSchema } from '../application/agent-sqlite-recovery-contracts.js';
import { openProfileMutationScope, profileDirectory, profileStat, publishProfileJson, readProfileJson, syncProfileDirectory } from './agent-profile-files.js';
import { lifecycleFail, lifecycleRoot } from './agent-lifecycle-files.js';
import { windowsLeaseRoot, windowsLeaseExists, windowsLeaseNames, removeWindowsLifecycleLease } from './windows-lifecycle-lease.js';

const LeaseSchema = z.strictObject({ schemaVersion: z.literal(1), id: z.uuid(), pid: z.number().int().positive(), host: z.string(), createdAt: z.number().int().nonnegative() });
const leaseRoot = (path: string) => process.platform === 'win32' ? windowsLeaseRoot(path) : lifecycleRoot(path);
const leaseExists = (path: string) => process.platform === 'win32' ? windowsLeaseExists(path) : profileStat(path) !== null;
const leaseNames = (path: string) => process.platform === 'win32' ? windowsLeaseNames(path) : readdirSync(path);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function removeOwned(root: string, path: string, value: z.infer<typeof LeaseSchema>) {
  if (process.platform === 'win32') return removeWindowsLifecycleLease(root, path, value);
  const scope = openProfileMutationScope(root, []);
  try {
    if (!same(readProfileJson(path, LeaseSchema, undefined, undefined, scope), value)) lifecycleFail('lifecycle_lease_changed');
    scope.check(); unlinkSync(path); syncProfileDirectory(dirname(path), scope); scope.check();
  } finally { scope.close(); }
}
export interface SqliteRecoveryMaintenance { readonly operationId: string; readonly preparedDigest: string }
/** Read-only gate for ownership preflight. Lease acquisition repeats the gate before store writes. */
export function assertAgentRuntimeAvailable(input: string) {
  const root = leaseRoot(input), metadata = join(root, '.secumon');
  profileDirectory(metadata, false, true);
  if (readProfileJson(join(metadata, SQLITE_RECOVERY_PENDING), SqliteRecoveryPendingSchema)) lifecycleFail('agent_sqlite_recovery_resume_required');
  if (leaseExists(join(metadata, 'lifecycle-maintenance.json'))) lifecycleFail('agent_maintenance_active');
}
function acquire(input: string, maintenance: boolean, recovery?: SqliteRecoveryMaintenance) {
  const root = leaseRoot(input), metadata = join(root, '.secumon'); const scope = openProfileMutationScope(root, []);
  const value = { schemaVersion: 1 as const, id: randomUUID(), pid: process.pid, host: hostname(), createdAt: Date.now() };
  const barrier = join(metadata, 'lifecycle-maintenance.json'), leases = join(metadata, 'runtime-leases');
  const path = maintenance ? barrier : join(leases, `${value.id}.json`); let published = false;
  const checkRecovery = () => {
    const pending = readProfileJson(join(metadata, SQLITE_RECOVERY_PENDING), SqliteRecoveryPendingSchema);
    if (pending && (!maintenance || !recovery || pending.operationId !== recovery.operationId || pending.preparedDigest !== recovery.preparedDigest))
      lifecycleFail('agent_sqlite_recovery_resume_required');
  };
  try {
    profileDirectory(metadata, false, true, scope);
    checkRecovery();
    if (leaseExists(barrier)) lifecycleFail('agent_maintenance_active');
    profileDirectory(leases, true, true, scope);
    if (!publishProfileJson(path, value, scope)) lifecycleFail('agent_maintenance_active');
    published = true; syncProfileDirectory(maintenance ? metadata : leases, scope);
    if (maintenance ? leaseNames(leases).length !== 0 : leaseExists(barrier)) lifecycleFail('agent_runtime_active');
    checkRecovery();
    scope.check();
  } catch (error) {
    if (published) { try { removeOwned(root, path, value); } catch (cleanup) { throw new AggregateError([error, cleanup], 'lifecycle_lease_cleanup_failed', { cause: error }); } }
    throw error;
  } finally { scope.close(); }
  let closed = false;
  return { close() { if (!closed) { removeOwned(root, path, value); closed = true; } } };
}
/** The lease is acquired before opening databases and released after every store closes. */
export const acquireAgentRuntimeLease = (root: string) => acquire(root, false);
/** Offline confirmation additionally covers older engines and direct database clients. */
export function acquireAgentMaintenance(root: string, offline: boolean, recovery?: SqliteRecoveryMaintenance) {
  if (offline !== true) lifecycleFail('lifecycle_offline_confirmation_required');
  return acquire(root, true, recovery);
}
export function recoverAgentLifecycleLeases(input: string, offline: boolean) {
  if (offline !== true) lifecycleFail('lifecycle_offline_confirmation_required');
  const root = leaseRoot(input), metadata = join(root, '.secumon'), leases = join(metadata, 'runtime-leases');
  const paths = [join(metadata, 'lifecycle-maintenance.json'), ...(leaseExists(leases) ? leaseNames(leases).map(name => { if (!/^[a-f0-9-]{36}\.json$/.test(name)) lifecycleFail('lifecycle_lease_invalid'); return join(leases, name); }) : [])];
  let recovered = 0;
  for (const path of paths) {
    const value = readProfileJson(path, LeaseSchema); if (!value) continue;
    if (value.host !== hostname()) lifecycleFail('lifecycle_foreign_host_lease');
    try { process.kill(value.pid, 0); lifecycleFail('agent_runtime_active'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    removeOwned(root, path, value); recovered++;
  }
  return { recovered };
}
