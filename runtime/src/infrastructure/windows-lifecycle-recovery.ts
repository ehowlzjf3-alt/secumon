import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import type { LifecycleEntry } from '../application/agent-lifecycle-contracts.js';
import { AgentLifecycleError } from '../application/agent-lifecycle-contracts.js';
import { openProfileMutationScope } from './agent-profile-files.js';
import type { WindowsFileLock } from './windows-file-addon.js';
import { windowsCanonicalPath, windowsPathInfo, windowsProfileFiles } from './windows-profile-files.js';
import { readWindowsFile } from './windows-stream-files.js';
import { captureWindowsLifecycleTree, createWindowsLifecycleDirectory, restoreWindowsLifecycleFile,
  syncWindowsLifecycleDirectory, validateWindowsLifecycleEntries, windowsLifecycleDisjoint, windowsLifecycleRoot,
  type WindowsLifecycleLimits } from './windows-lifecycle-files.js';

export interface WindowsLifecycleRecovery {
  operationId: string;
  backupDigest: string;
  agentId: string;
  markerName: '.secumon-restore-in-progress.json';
  markerBytes: Buffer;
}
const lockName = '.secumon-restore-active.lock';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
const fail: (code: string) => never = code => { throw new AgentLifecycleError(code); };
const pending = /^\.secumon-restore-[a-f0-9]{64}\.pending$/;

/** No scanning-based candidate adoption: the immutable archive and exact marker select each pending name. */
export function restoreWindowsLifecycleTree(source: string, destination: string, entries: readonly LifecycleEntry[],
  operation: WindowsLifecycleRecovery, limits: WindowsLifecycleLimits, include: (path: string) => boolean = () => true): void {
  if (process.platform !== 'win32' || !/^[a-f0-9]{64}$/.test(operation.backupDigest) || !operation.agentId ||
    !operation.operationId || operation.operationId.length > 200 || operation.markerName !== '.secumon-restore-in-progress.json' ||
    !Buffer.isBuffer(operation.markerBytes) || operation.markerBytes.length > 65536) fail('lifecycle_restore_binding_mismatch');
  validateWindowsLifecycleEntries(entries, limits);
  const from = windowsLifecycleRoot(source, true), to = windowsLifecycleRoot(destination, true);
  windowsLifecycleDisjoint(from, to);
  const markerBytes = Buffer.from(operation.markerBytes);
  let marker: unknown;
  try { marker = JSON.parse(markerBytes.toString('utf8')); } catch { return fail('lifecycle_restore_binding_mismatch'); }
  const value = marker as { agentId?: unknown; backupDigest?: unknown; operationId?: unknown; originalRoot?: unknown } | null;
  if (!value || value.agentId !== operation.agentId || value.backupDigest !== operation.backupDigest ||
    (value.operationId !== undefined ? value.operationId !== operation.operationId : operation.operationId !== `local:${operation.backupDigest}`) ||
    value.originalRoot !== undefined && value.originalRoot !== to) fail('lifecycle_restore_binding_mismatch');
  for (const entry of entries) if (!include(entry.path) || entry.path === operation.markerName ||
    entry.path.split('/').some(part => part === lockName || pending.test(part))) fail('lifecycle_restore_entries_invalid');
  const names = new Set(entries.map(entry => entry.path));
  if (!same(captureWindowsLifecycleTree(from, path => names.has(path), limits), entries)) fail('lifecycle_source_changed');
  const files = windowsProfileFiles(), scope = openProfileMutationScope(to, [from]);
  let lock: WindowsFileLock | undefined, primary: { error: unknown } | undefined;
  try {
    const root = scope.directory(to, 'private'); if (!root) return fail('lifecycle_directory_unsafe');
    const canonicalRoot = windowsCanonicalPath(to);
    const current = () => {
      scope.check(); lock?.check();
      if (windowsCanonicalPath(to) !== canonicalRoot || !readWindowsFile(files, root, operation.markerName, 65536).equals(markerBytes))
        fail('lifecycle_restore_binding_mismatch');
    };
    current(); lock = files.handle(root).lockRegular(lockName); current();
    for (const entry of entries) {
      current(); const target = win32.join(to, ...entry.path.split('/'));
      if (entry.kind === 'directory') {
        if (windowsPathInfo(target)) windowsLifecycleRoot(target, true); else createWindowsLifecycleDirectory(target);
        continue;
      }
      const candidate = `.secumon-restore-${digest({ schemaVersion: 1, operationId: operation.operationId,
        backupDigest: operation.backupDigest, agentId: operation.agentId, root: canonicalRoot, entry })}.pending`;
      const parent = win32.dirname(target), pendingPath = win32.join(parent, candidate);
      if (windowsPathInfo(target)) {
        if (windowsPathInfo(pendingPath)) fail('lifecycle_restore_candidate_conflict');
        const actual = captureWindowsLifecycleTree(parent, path => path === win32.basename(target), limits);
        if (actual.length !== 1 || !same(actual[0], { ...entry, path: win32.basename(target) })) fail('lifecycle_restore_digest_mismatch');
        syncWindowsLifecycleDirectory(parent); current();
      } else {
        restoreWindowsLifecycleFile(win32.join(from, ...entry.path.split('/')), target, entry, limits.fileBytes, candidate, current);
      }
    }
    current();
    if (!same(captureWindowsLifecycleTree(from, path => names.has(path), limits), entries)) fail('lifecycle_source_changed');
    const actual = captureWindowsLifecycleTree(to, path => path !== lockName && path !== operation.markerName && include(path), limits);
    if (!same(actual, entries)) fail('lifecycle_restore_digest_mismatch');
    syncWindowsLifecycleDirectory(to); current();
  } catch (error) { primary = { error }; throw error; }
  finally {
    const errors: unknown[] = [];
    try { lock?.close(); } catch (error) { errors.push(error); }
    try { scope.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError([...(primary ? [primary.error] : []), ...errors], 'lifecycle_restore_cleanup_failed');
  }
}
