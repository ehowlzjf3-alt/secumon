import fs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { FileMutationFault, hostFileMutations } from '../../infrastructure/host-file-mutations.js';
import { FileBoundaryFault } from '../../infrastructure/host-metadata-files.js';

const [base, root, scenario] = process.argv.slice(2); if (!base || !root || !scenario) throw new Error('worker_arguments_required');
const scope = hostFileMutations().openScope({ root, forbiddenRoots: [join(base, 'engine')] });
const directoryScenario = ['directory-sync-recovery', 'mkdir-after-success'].includes(scenario);
const reference = directoryScenario ? undefined : scope.directory(root, 'private', true)!;
const original = { open: fs.openSync, close: fs.closeSync, write: fs.writeFileSync, sync: fs.fsyncSync, link: fs.linkSync,
  unlink: fs.unlinkSync, mkdir: fs.mkdirSync, rename: fs.renameSync, fstat: fs.fstatSync, lstat: fs.lstatSync };
const errors = Object.fromEntries(['write', 'close', 'cleanup', 'sync', 'link', 'mkdir'].map(name => [name, Object.assign(new Error(`injected_${name}`), { code: 'EIO' })]));
const descriptors = new Map<number, string>(); let candidate: string | undefined; let owned: string | undefined;
let changed = false; let directorySyncAttempts = 0; let unlinkAttempts = 0; let enabled = true;
const bytes = Buffer.from('complete private metadata'); const target = join(root, 'config.json');
Reflect.set(fs, 'openSync', ((...args: unknown[]) => {
  const fd = Reflect.apply(original.open, fs, args) as number; const path = String(args[0]);
  descriptors.set(fd, path); if (path.endsWith('.pending')) candidate = path;
  return fd;
}) as typeof fs.openSync);
Reflect.set(fs, 'writeFileSync', ((...args: unknown[]) => {
  const value = Reflect.apply(original.write, fs, args);
  if (enabled && typeof args[0] === 'number' && descriptors.get(args[0])?.endsWith('.pending') && ['write-error', 'multiple-errors'].includes(scenario)) throw errors.write;
  return value;
}) as typeof fs.writeFileSync);
fs.closeSync = fd => {
  const path = descriptors.get(fd); original.close(fd); descriptors.delete(fd);
  if (enabled && path?.endsWith('.pending') && !changed) {
    if (scenario === 'multiple-errors') { changed = true; throw errors.close; }
    if (scenario === 'candidate-replaced') {
      changed = true; owned = join(base, 'owned-candidate'); original.rename(path, owned); original.write(path, 'foreign candidate', { mode: 0o600 });
    }
    if (scenario === 'parent-replaced') {
      changed = true; const saved = join(base, 'owned-root'); original.rename(root, saved); owned = join(saved, basename(path));
      original.mkdir(root, { mode: 0o700 }); original.write(path, 'foreign candidate', { mode: 0o600 });
    }
  }
};
fs.fsyncSync = fd => {
  if (original.fstat(fd).isDirectory()) {
    directorySyncAttempts += 1;
    if (enabled && ['multiple-errors', 'cleanup-and-sync-error', 'directory-sync-recovery'].includes(scenario)) throw errors.sync;
  }
  original.sync(fd);
};
fs.linkSync = (from, to) => { original.link(from, to); if (enabled && scenario === 'link-after-success') throw errors.link; };
fs.unlinkSync = path => {
  unlinkAttempts += 1;
  if (enabled && ['multiple-errors', 'cleanup-and-sync-error'].includes(scenario)) throw errors.cleanup;
  original.unlink(path);
};
Reflect.set(fs, 'mkdirSync', ((...args: unknown[]) => {
  const value = Reflect.apply(original.mkdir, fs, args);
  if (enabled && scenario === 'mkdir-after-success' && String(args[0]) === root) throw errors.mkdir;
  return value;
}) as typeof fs.mkdirSync);
syncBuiltinESMExports();
let failure: unknown; let sameDirectoryAfterRetry = false; let recoverySyncAttempts = 0;
try {
  try { if (directoryScenario) scope.directory(root, 'private', true); else scope.publish(reference!, 'config.json', bytes); }
  catch (error) { failure = error; }
  enabled = false;
  if (scenario === 'directory-sync-recovery') {
    const before = original.lstat(root, { bigint: true }); const syncBefore = directorySyncAttempts;
    scope.directory(root, 'private', true); const after = original.lstat(root, { bigint: true });
    sameDirectoryAfterRetry = before.dev === after.dev && before.ino === after.ino; recoverySyncAttempts = directorySyncAttempts - syncBefore;
  }
} finally {
  Reflect.set(fs, 'openSync', original.open); fs.closeSync = original.close; Reflect.set(fs, 'writeFileSync', original.write);
  fs.fsyncSync = original.sync; fs.linkSync = original.link; fs.unlinkSync = original.unlink; Reflect.set(fs, 'mkdirSync', original.mkdir);
  syncBuiltinESMExports(); scope.close();
}
const fault = failure instanceof FileMutationFault ? failure : undefined;
const targetExists = fs.existsSync(target); const pending = fs.existsSync(root) ? fs.readdirSync(root).filter(name => name.endsWith('.pending')) : [];
const pendingPath = pending.length === 1 ? join(root, pending[0]!) : undefined;
const primary = scenario === 'link-after-success' ? errors.link : scenario === 'directory-sync-recovery' ? errors.sync : scenario === 'mkdir-after-success' ? errors.mkdir : errors.write;
const syncFailure = fault?.errors.find(item => item.stage === 'directory_sync')?.error;
const isOriginalSync = (error: unknown) => error instanceof FileBoundaryFault && error.code === 'io' && error.operation === 'sync' && error.cause === errors.sync;
const samePublishedPair = targetExists && pendingPath !== undefined && original.lstat(target).ino === original.lstat(pendingPath).ino && original.lstat(target).nlink === 2;
fs.writeSync(1, JSON.stringify({ fault: !!fault, status: fault?.status,
  primaryOriginal: scenario === 'directory-sync-recovery' ? isOriginalSync(fault?.cause) : fault?.cause === primary,
  originalErrors: fault?.errors.flatMap(item => Object.entries(errors).filter(([name, error]) => name === 'sync' ? isOriginalSync(item.error) : item.error === error).map(([name]) => name)),
  syncFault: syncFailure instanceof FileBoundaryFault ? { code: syncFailure.code, operation: syncFailure.operation,
    causeOriginal: syncFailure.cause === errors.sync, causeCode: (syncFailure.cause as NodeJS.ErrnoException)?.code } : undefined,
  stages: fault?.errors.map(item => item.stage), targetExists, targetMatches: targetExists && fs.readFileSync(target).equals(bytes),
  pendingCount: pending.length, samePublishedPair, directorySyncAttempts, unlinkAttempts, openDescriptors: descriptors.size,
  foreignPreserved: candidate !== undefined && fs.existsSync(candidate) && fs.readFileSync(candidate, 'utf8') === 'foreign candidate',
  ownedPreserved: owned !== undefined && fs.existsSync(owned) && fs.readFileSync(owned).equals(bytes),
  directoryExists: fs.existsSync(root), sameDirectoryAfterRetry, recoverySyncAttempts, parent: dirname(root),
}) + '\n');
