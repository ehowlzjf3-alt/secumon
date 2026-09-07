import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { FileWorkspaceStore } from '../../infrastructure/file-workspaces.js';
import { WorkspaceError } from '../../application/workspace-checkpoints.js';
import { sha256 } from '../../infrastructure/digest.js';

const [base, scenario] = process.argv.slice(2);
if (!base || !scenario) throw new Error('worker_arguments_required');
const root = join(base, 'workspace'); const work = join(root, sha256('work')); const attempt = join(work, sha256('attempt'));
const files = join(attempt, 'files'); const lock = join(attempt, '.lock');
const store = new FileWorkspaceStore(root);
const original = { mkdir: fs.mkdirSync, rmdir: fs.rmdirSync, readdir: fs.readdirSync, rename: fs.renameSync,
  lstat: fs.lstatSync, open: fs.openSync, close: fs.closeSync, chmod: fs.chmodSync, sync: fs.fsyncSync, fstat: fs.fstatSync };
const identity = (path: string) => { const stat = original.lstat(path, { bigint: true }); return `${stat.dev}:${stat.ino}`; };
const acquisitions: string[] = []; const retained: number[] = [];
let injected = false; let success = false; let failure: unknown;
const inspectionError = Object.assign(new Error('injected_initial_lock_inspection_failure'), { code: 'EIO' });
let lockRemovalAttempts = 0;
let acquiredIdentity: string | undefined; let alteredIdentity: string | undefined; let preservedLock: string | undefined;
const afterSync = ['files-replaced-after-sync', 'files-removed-after-sync'].includes(scenario);
const afterCleanup = ['files-replaced-after-cleanup-sync', 'files-removed-after-cleanup-sync'].includes(scenario);
const parentIdentity = original.lstat(base, { bigint: true });
let originalFilesIdentity: string | undefined; let alteredFilesIdentity: string | undefined; let preservedFiles: string | undefined;

Reflect.set(fs, 'mkdirSync', ((...args: unknown[]) => {
  const result = Reflect.apply(original.mkdir, fs, args);
  if (String(args[0]) === lock) acquisitions.push(identity(lock));
  if (scenario === 'files-disappeared-after-create' && !injected && String(args[0]) === files) { injected = true; original.rmdir(files); }
  return result;
}) as typeof fs.mkdirSync);
Reflect.set(fs, 'rmdirSync', ((...args: unknown[]) => {
  if (String(args[0]) === lock) lockRemovalAttempts += 1;
  if ((scenario === 'repeat' || afterCleanup) && String(args[0]) === lock) {
    // Retain only test descriptors to prevent immediate inode reuse between successful calls.
    retained.push(original.open(lock, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW));
    if (afterCleanup) acquiredIdentity = identity(lock);
  }
  return Reflect.apply(original.rmdir, fs, args);
}) as typeof fs.rmdirSync);
Reflect.set(fs, 'lstatSync', ((...args: unknown[]) => {
  if (scenario === 'initial-lock-inspect-error' && !injected && String(args[0]) === lock) { injected = true; throw inspectionError; }
  return Reflect.apply(original.lstat, fs, args);
}) as typeof fs.lstatSync);
Reflect.set(fs, 'readdirSync', ((...args: unknown[]) => {
  const result = Reflect.apply(original.readdir, fs, args);
  if (scenario !== 'repeat' && !afterSync && !afterCleanup && !injected && String(args[0]) === files) {
    injected = true; acquiredIdentity = identity(lock);
    if (scenario === 'lock-removed') original.rmdir(lock);
    else if (scenario === 'lock-replaced') {
      preservedLock = join(base, 'original-lock'); original.rename(lock, preservedLock); original.mkdir(lock, { mode: 0o700 }); alteredIdentity = identity(lock);
    } else if (scenario === 'lock-unsafe') {
      original.chmod(lock, 0o770); alteredIdentity = identity(lock);
    } else if (scenario === 'attempt-replaced') {
      const saved = join(base, 'original-attempt'); original.rename(attempt, saved); preservedLock = join(saved, '.lock');
      original.mkdir(attempt, { mode: 0o700 }); original.mkdir(files, { mode: 0o700 }); original.mkdir(lock, { mode: 0o700 }); alteredIdentity = identity(lock);
    } else throw new Error('unknown_worker_scenario');
  }
  return result;
}) as typeof fs.readdirSync);
fs.fsyncSync = fd => {
  original.sync(fd);
  if ((afterSync || afterCleanup) && !injected) {
    const entry = original.fstat(fd, { bigint: true });
    const attemptIdentity = afterCleanup ? original.lstat(attempt, { bigint: true }) : null;
    const finalParent = afterSync && entry.dev === parentIdentity.dev && entry.ino === parentIdentity.ino;
    const finalCleanup = afterCleanup && attemptIdentity && entry.dev === attemptIdentity.dev && entry.ino === attemptIdentity.ino && !fs.existsSync(lock);
    if (entry.isDirectory() && (finalParent || finalCleanup)) {
      injected = true; originalFilesIdentity = identity(files); preservedFiles = join(base, 'original-files'); original.rename(files, preservedFiles);
      if (scenario === 'files-replaced-after-sync' || scenario === 'files-replaced-after-cleanup-sync') { original.mkdir(files, { mode: 0o700 }); alteredFilesIdentity = identity(files); }
      if (afterCleanup) { original.mkdir(lock, { mode: 0o700 }); alteredIdentity = identity(lock); }
    }
  }
};
syncBuiltinESMExports();
try {
  if (scenario === 'repeat') {
    const content = Buffer.from('stable content');
    await store.stage('work', 'attempt', 'one.txt', content, { tenantId: 'tenant-a', labels: ['synthetic'], lifecycleGeneration: 0 });
    const read = await store.read('work', 'attempt', 'one.txt'); const listed = await store.list('work', 'attempt');
    success = Buffer.from(read.bytes).equals(content) && listed.length === 1 && listed[0]!.path === 'one.txt';
  } else { await store.list('work', 'attempt'); success = true; }
} catch (error) { failure = error; }
finally {
  Reflect.set(fs, 'mkdirSync', original.mkdir); Reflect.set(fs, 'rmdirSync', original.rmdir); Reflect.set(fs, 'readdirSync', original.readdir);
  Reflect.set(fs, 'lstatSync', original.lstat);
  fs.fsyncSync = original.sync;
  syncBuiltinESMExports(); for (const fd of retained.splice(0)) original.close(fd); await store.close();
}
const lockRemains = fs.existsSync(lock);
fs.writeSync(1, JSON.stringify({ scenario, success, injected, code: failure instanceof WorkspaceError ? failure.code : (failure as NodeJS.ErrnoException | undefined)?.code ?? null,
  acquisitions: acquisitions.length, distinctIdentities: new Set(acquisitions).size, lockRemains,
  originalInspectionError: failure === inspectionError, lockRemovalAttempts,
  unconfirmedLockPreserved: lockRemains && acquisitions[0] !== undefined && identity(lock) === acquisitions[0],
  currentLockPreserved: lockRemains && alteredIdentity !== undefined && identity(lock) === alteredIdentity,
  currentLockIsForeign: alteredIdentity !== undefined && alteredIdentity !== acquiredIdentity,
  originalLockRemains: preservedLock !== undefined && fs.existsSync(preservedLock) && identity(preservedLock) === acquiredIdentity,
  filesRemain: fs.existsSync(files),
  originalFilesRemain: preservedFiles !== undefined && fs.existsSync(preservedFiles) && identity(preservedFiles) === originalFilesIdentity,
  currentFilesPreserved: alteredFilesIdentity !== undefined && fs.existsSync(files) && identity(files) === alteredFilesIdentity,
  lockMode: lockRemains ? original.lstat(lock).mode & 0o777 : null, retainedDescriptors: retained.length,
}) + '\n');
