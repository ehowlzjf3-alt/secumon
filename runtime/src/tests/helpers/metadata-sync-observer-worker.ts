import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { FileBoundaryFault } from '../../infrastructure/host-metadata-files.js';
import { PosixMetadataFiles } from '../../infrastructure/posix-metadata-files.js';

const [rootInput, scenarioInput] = process.argv.slice(2);
const scenarios = ['check-failure', 'open-eio', 'opened-object-replaced', 'fsync-eio', 'success', 'after-fsync-replaced', 'observer-throws'];
if (!rootInput || !scenarioInput || !scenarios.includes(scenarioInput)) throw new Error('metadata_sync_worker_arguments_required');
const root = rootInput; const scenario = scenarioInput; const moved = `${root}.previous`;
const original = { open: fs.openSync, close: fs.closeSync, sync: fs.fsyncSync, stat: fs.fstatSync, lstat: fs.lstatSync,
  rename: fs.renameSync, mkdir: fs.mkdirSync, write: fs.writeFileSync, read: fs.readFileSync, chmod: fs.chmodSync };
const identity = (value: fs.BigIntStats) => `${value.dev}:${value.ino}`;
const originalIdentity = identity(original.lstat(root, { bigint: true }));
const adapter = new PosixMetadataFiles(); const directory = adapter.inspectDirectory(root, 'private');
if (!directory) throw new Error('metadata_sync_worker_directory_missing');
const before = adapter.diagnostics(); const descriptors = new Set<number>(); const events: string[] = [];
const openedIdentities: string[] = []; const observerOpenDescriptors: number[] = [];
let openAttempts = 0; let opens = 0; let closes = 0; let notifications = 0;
let fsyncCalls = 0; let realFsyncCalls = 0; let completedFsyncCalls = 0; let mutation: string | null = null;
const injectedIo = Object.assign(new Error('injected_metadata_sync_io_failure'), { code: 'EIO', syscall: scenario === 'open-eio' ? 'open' : 'fsync' });
const observerFailure = new Error('injected_metadata_sync_observer_failure');
function replaceDirectory(timing: string) {
  // These are real filesystem renames. Only the instant at which they occur is selected by an fs hook.
  original.rename(root, moved); original.mkdir(root, { mode: 0o700 });
  original.write(join(root, 'marker.txt'), 'replacement', { mode: 0o600 });
  mutation = timing; events.push(timing);
}
fs.openSync = ((...args: unknown[]) => {
  if (String(args[0]) !== root) return Reflect.apply(original.open, fs, args);
  openAttempts++; events.push('open-attempt');
  if (scenario === 'open-eio') throw injectedIo;
  if (scenario === 'opened-object-replaced') replaceDirectory('rename-before-open');
  const fd = Reflect.apply(original.open, fs, args) as number;
  descriptors.add(fd); opens++; events.push('opened');
  openedIdentities.push(identity(original.stat(fd, { bigint: true })));
  return fd;
}) as typeof fs.openSync;
fs.closeSync = (fd: number) => {
  original.close(fd);
  if (descriptors.delete(fd)) { closes++; events.push('closed'); }
};
fs.fsyncSync = (fd: number) => {
  if (!descriptors.has(fd)) { original.sync(fd); return; }
  fsyncCalls++; events.push('fsync-attempt');
  // EIO is injected at the fsync call boundary; successful scenarios call the real operating-system fsync.
  if (scenario === 'fsync-eio') throw injectedIo;
  realFsyncCalls++; original.sync(fd); completedFsyncCalls++; events.push('fsync-returned');
  if (scenario === 'after-fsync-replaced') replaceDirectory('rename-after-fsync');
};
syncBuiltinESMExports();
let failure: unknown;
try {
  if (scenario === 'check-failure') {
    original.chmod(root, 0o755); mutation = 'chmod-before-check'; events.push(mutation);
  }
  adapter.syncDirectory(directory, { beforeSync() {
    notifications++; events.push('observer'); observerOpenDescriptors.push(descriptors.size);
    if (scenario === 'observer-throws') throw observerFailure;
  } });
} catch (error) { failure = error; }
finally {
  fs.openSync = original.open; fs.closeSync = original.close; fs.fsyncSync = original.sync;
  syncBuiltinESMExports();
}
const after = adapter.diagnostics(); const boundaryFailure = failure instanceof FileBoundaryFault ? failure : null;
const rootStat = original.lstat(root, { bigint: true });
fs.writeSync(1, JSON.stringify({ scenario, code: boundaryFailure?.code ?? null, operation: boundaryFailure?.operation ?? null,
  message: failure instanceof Error ? failure.message : null,
  causeCode: (boundaryFailure?.cause as NodeJS.ErrnoException | undefined)?.code ?? null,
  causeSyscall: (boundaryFailure?.cause as NodeJS.ErrnoException | undefined)?.syscall ?? null,
  originalIoCause: scenario === 'open-eio' || scenario === 'fsync-eio' ? boundaryFailure?.cause === injectedIo : null,
  originalObserverError: scenario === 'observer-throws' ? failure === observerFailure : null,
  notifications, diagnosticSyncAttempts: after.directorySyncs - before.directorySyncs,
  openAttempts, opens, closes, openDescriptors: descriptors.size, observerOpenDescriptors,
  fsyncCalls, realFsyncCalls, completedFsyncCalls, openedIdentities, originalIdentity,
  currentIdentity: identity(rootStat), movedIdentity: fs.existsSync(moved) ? identity(original.lstat(moved, { bigint: true })) : null,
  rootMode: Number(rootStat.mode & 0o777n), rootMarker: original.read(join(root, 'marker.txt'), 'utf8'),
  movedMarker: fs.existsSync(moved) ? original.read(join(moved, 'marker.txt'), 'utf8') : null,
  mutation, events,
}) + '\n');
