import fs from 'node:fs';
import { join, sep } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { FileWorkspaceStore } from '../../infrastructure/file-workspaces.js';
import { WorkspaceError } from '../../application/workspace-checkpoints.js';
import { sha256 } from '../../infrastructure/digest.js';

const [parentInput, scenarioInput] = process.argv.slice(2);
const scenarios = ['order', 'constructor-sync-eio', 'open-eio', 'files-fsync-eio', 'cleanup-sync-eio',
  'action-only', 'action-unlock-eio', 'action-cleanup-sync-eio', 'cleanup-new-lock', 'cleanup-new-lock-sync-eio', 'unsupported-platform'];
if (!parentInput || !scenarioInput || !scenarios.includes(scenarioInput)) throw new Error('workspace_sync_worker_arguments_required');
const parent = parentInput; const scenario = scenarioInput; const root = join(parent, 'workspace');
const workId = 'workspace-sync-work'; const attemptId = 'workspace-sync-attempt'; const logicalPath = 'report.bin';
const work = join(root, sha256(workId)); const attempt = join(work, sha256(attemptId));
const files = join(attempt, 'files'); const lock = join(attempt, '.lock'); const record = join(files, `${sha256(logicalPath)}.json`);
const content = Buffer.from([0, 1, 2, 127, 128, 255]);
const attributes = { tenantId: 'tenant-a', labels: ['synthetic'], lifecycleGeneration: 0 };
const labels = new Map([[parent, 'parent'], [root, 'root'], [work, 'work'], [attempt, 'attempt'], [files, 'files']]);
const original = { open: fs.openSync, close: fs.closeSync, sync: fs.fsyncSync, fstat: fs.fstatSync,
  mkdir: fs.mkdirSync, rmdir: fs.rmdirSync, readdir: fs.readdirSync, read: fs.readFileSync, write: fs.writeFileSync };
const originalPlatform = process.platform;
const descriptors = new Map<number, { path: string; directory: string | null }>();
const events: string[] = []; const directorySyncs: string[] = []; const directoryOpenAttempts: string[] = [];
let opens = 0; let closes = 0; let fileSyncs = 0; let mkdirCalls = 0; let unlocked = false;
let armed = false; let injected = false; let actionInjected = false; let cleanupInjected = false;
let newLockIdentity: string | null = null; let operationSucceeded = false;
const actionFailure = new WorkspaceError('workspace_layout_invalid');
const syncFailure = Object.assign(new Error('injected_workspace_sync_io_failure'), { code: 'EIO', syscall: scenario === 'open-eio' ? 'open' : 'fsync' });
const cleanupFailure = Object.assign(new Error('injected_workspace_cleanup_io_failure'), { code: 'EIO', syscall: scenario === 'action-unlock-eio' ? 'rmdir' : 'fsync' });
const actionScenario = scenario === 'action-only' || scenario === 'action-unlock-eio' || scenario === 'action-cleanup-sync-eio';
const withinParent = (path: string) => path === parent || path.startsWith(`${parent}${sep}`);

fs.mkdirSync = ((...args: unknown[]) => {
  if (withinParent(String(args[0]))) mkdirCalls++;
  return Reflect.apply(original.mkdir, fs, args);
}) as typeof fs.mkdirSync;
fs.openSync = ((...args: unknown[]) => {
  const path = String(args[0]); const flags = args[1];
  const label = typeof flags === 'number' && (flags & fs.constants.O_DIRECTORY) !== 0 ? labels.get(path) ?? null : null;
  if (label) {
    directoryOpenAttempts.push(label);
    if (armed && !injected && scenario === 'open-eio' && label === 'files') {
      injected = true; events.push('open-eio:files'); throw syncFailure;
    }
  }
  const fd = Reflect.apply(original.open, fs, args) as number;
  if (withinParent(path)) { descriptors.set(fd, { path, directory: label }); opens++; }
  return fd;
}) as typeof fs.openSync;
fs.closeSync = fd => { original.close(fd); if (descriptors.delete(fd)) closes++; };
fs.fsyncSync = fd => {
  const tracked = descriptors.get(fd);
  if (tracked?.directory) {
    if (!original.fstat(fd).isDirectory()) throw new Error('workspace_sync_expected_directory_descriptor');
    const label = tracked.directory; directorySyncs.push(label); events.push(`sync:${label}`);
    // Injected EIO occurs at the fsync boundary; successful calls below invoke the real filesystem fsync.
    if (armed && !injected && (scenario === 'constructor-sync-eio' && label === 'parent' || scenario === 'files-fsync-eio' && label === 'files')) {
      injected = true; throw syncFailure;
    }
    if (armed && !cleanupInjected && unlocked && label === 'attempt' && ['cleanup-sync-eio', 'action-cleanup-sync-eio', 'cleanup-new-lock-sync-eio'].includes(scenario)) {
      cleanupInjected = true; throw cleanupFailure;
    }
  } else if (tracked) fileSyncs++;
  original.sync(fd);
};
fs.rmdirSync = ((...args: unknown[]) => {
  if (String(args[0]) === lock) {
    events.push('unlock-attempt');
    if (armed && !cleanupInjected && scenario === 'action-unlock-eio') {
      cleanupInjected = true; events.push('unlock-eio'); throw cleanupFailure;
    }
    const result = Reflect.apply(original.rmdir, fs, args); unlocked = true; events.push('unlocked');
    if (armed && (scenario === 'cleanup-new-lock' || scenario === 'cleanup-new-lock-sync-eio')) {
      // The original lock really has been removed. Another actor now owns a newly created lock.
      original.mkdir(lock, { mode: 0o700 });
      const writer = original.open(join(lock, 'owner.txt'), 'wx', 0o600);
      try { original.write(writer, 'next-owner'); } finally { original.close(writer); }
      const stat = fs.lstatSync(lock, { bigint: true }); newLockIdentity = `${stat.dev}:${stat.ino}`;
      events.push('next-owner-lock');
    }
    return result;
  }
  return Reflect.apply(original.rmdir, fs, args);
}) as typeof fs.rmdirSync;
fs.readdirSync = ((...args: unknown[]) => {
  if (armed && actionScenario && !actionInjected && String(args[0]) === files) {
    // Select an action failure while the lock is held, without a new runtime test hook or public option.
    actionInjected = true; events.push('action-failure'); throw actionFailure;
  }
  return Reflect.apply(original.readdir, fs, args);
}) as typeof fs.readdirSync;
syncBuiltinESMExports();

let store: FileWorkspaceStore | undefined; let failure: unknown; let outcome: Record<string, unknown> = {};
type Step = { operation: string; directories: string[]; events: string[]; fileSyncs: number };
try {
  if (scenario === 'unsupported-platform') Object.defineProperty(process, 'platform', { value: 'win32' });
  armed = scenario === 'constructor-sync-eio';
  store = new FileWorkspaceStore(root);
  if (scenario === 'order') {
    const steps: Step[] = [{ operation: 'constructor', directories: [...directorySyncs], events: [...events], fileSyncs }];
    async function observe<T>(operation: string, action: () => Promise<T>): Promise<T> {
      const directoryOffset = directorySyncs.length; const eventOffset = events.length; const beforeFileSyncs = fileSyncs;
      unlocked = false;
      const result = await action();
      steps.push({ operation, directories: directorySyncs.slice(directoryOffset), events: events.slice(eventOffset), fileSyncs: fileSyncs - beforeFileSyncs });
      return result;
    }
    const staged = await observe('stage', () => store!.stage(workId, attemptId, logicalPath, content, attributes));
    const read = await observe('read', () => store!.read(workId, attemptId, logicalPath));
    const listed = await observe('list', () => store!.list(workId, attemptId));
    await observe('remove', () => store!.removeAttempt(workId, attemptId, [staged]));
    outcome = { steps, bytesEqual: Buffer.from(read.bytes).equals(content), listedPaths: listed.map(file => file.path),
      removed: !fs.existsSync(record), lockExists: fs.existsSync(lock) };
    operationSucceeded = true;
  } else {
    directorySyncs.length = 0; events.length = 0; directoryOpenAttempts.length = 0; fileSyncs = 0; unlocked = false; armed = true;
    try {
      if (actionScenario) await store.list(workId, attemptId);
      else await store.stage(workId, attemptId, logicalPath, content, attributes);
      operationSucceeded = true;
    } catch (error) { failure = error; }
    armed = false;
  }
} catch (error) { failure = error; }
finally {
  armed = false;
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  fs.mkdirSync = original.mkdir; fs.openSync = original.open; fs.closeSync = original.close; fs.fsyncSync = original.sync;
  fs.rmdirSync = original.rmdir; fs.readdirSync = original.readdir; syncBuiltinESMExports();
}
const error = failure as (Error & { code?: string; cleanupError?: unknown }) | undefined;
const persisted = fs.existsSync(record) ? JSON.parse(original.read(record, 'utf8')) : null;
const remainingLock = fs.existsSync(lock) ? fs.lstatSync(lock, { bigint: true }) : null;
const beforeRecovery = { directorySyncs: [...directorySyncs], events: [...events], directoryOpenAttempts: [...directoryOpenAttempts], fileSyncs,
  lockExists: remainingLock !== null, persistedBytesEqual: persisted !== null && Buffer.from(persisted.contentBase64, 'base64').equals(content),
  newLockIdentity, newLockPreserved: newLockIdentity !== null && remainingLock !== null && `${remainingLock.dev}:${remainingLock.ino}` === newLockIdentity,
  newLockOwner: fs.existsSync(join(lock, 'owner.txt')) ? original.read(join(lock, 'owner.txt'), 'utf8') : null };
let recovered: boolean | null = null;
try {
  if (store && ['open-eio', 'files-fsync-eio', 'cleanup-sync-eio'].includes(scenario)) {
    recovered = Buffer.from((await store.read(workId, attemptId, logicalPath)).bytes).equals(content);
  }
} finally { await store?.close(); }
fs.writeSync(1, JSON.stringify({ scenario, ...outcome, ...beforeRecovery, recovered, code: error?.code ?? null, message: error?.message ?? null,
  workspaceError: failure instanceof WorkspaceError, originalSyncError: failure === syncFailure,
  originalActionError: failure === actionFailure, originalCleanupError: failure === cleanupFailure,
  originalActionCause: error?.cause === actionFailure, originalCleanupDetail: error?.cleanupError === cleanupFailure,
  hasCleanupDetail: error?.cleanupError !== undefined, injected, actionInjected, cleanupInjected, operationSucceeded,
  opens, closes, openDescriptors: descriptors.size, mkdirCalls, parentMode: fs.lstatSync(parent).mode & 0o777,
  rootExists: fs.existsSync(root), platformEmulated: scenario === 'unsupported-platform', actualPlatform: originalPlatform,
}) + '\n');
