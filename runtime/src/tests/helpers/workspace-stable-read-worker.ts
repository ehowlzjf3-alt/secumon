import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { FileWorkspaceStore } from '../../infrastructure/file-workspaces.js';
import { WorkspaceError } from '../../application/workspace-checkpoints.js';
import { sha256 } from '../../infrastructure/digest.js';

const [base, operation, scenario] = process.argv.slice(2);
if (!base || !['read', 'list'].includes(operation ?? '') || !scenario) throw new Error('worker_arguments_required');
const root = join(base, 'workspace'); const attempt = join(root, sha256('work'), sha256('attempt')); const folder = join(attempt, 'files');
const lock = join(attempt, '.lock'); const target = join(folder, `${sha256('document.txt')}.json`);
const store = new FileWorkspaceStore(root); const initialContent = Buffer.from('initial bytes');
const initialFile = await store.stage('work', 'attempt', 'document.txt', initialContent, { tenantId: 'tenant-a', labels: ['synthetic'], lifecycleGeneration: 0 });
let expectedContent = initialContent; let expectedFile = initialFile; let expectedBytes = fs.readFileSync(target); let preservedPath = target;
const original = { open: fs.openSync, close: fs.closeSync, read: fs.readSync, fstat: fs.fstatSync, rmdir: fs.rmdirSync,
  write: fs.writeFileSync, readFile: fs.readFileSync, rename: fs.renameSync, mkdir: fs.mkdirSync, lstat: fs.lstatSync };
const descriptors = new Set<number>(); const changed = new Set<number>(); let opens = 0; let closes = 0; let reads = 0; let injected = 0;
const injectedError = Object.assign(new Error('injected_workspace_file_io'), {
  code: scenario === 'first-open-missing' ? 'ENOENT' : scenario === 'open-access-denied' ? 'EACCES' : 'EIO',
});
const cleanupError = Object.assign(new Error('injected_workspace_lock_cleanup'), { code: 'EIO' });
let acquiredLock: string | undefined;
const identity = (path: string) => { const entry = original.lstat(path, { bigint: true }); return `${entry.dev}:${entry.ino}`; };

function rewrite() {
  expectedContent = Buffer.from(`updated bytes ${'x'.repeat(injected * 9)}`);
  expectedFile = { ...initialFile, byteLength: expectedContent.length, sha256: sha256(expectedContent) };
  const payload = { schemaVersion: 1, file: expectedFile, contentBase64: expectedContent.toString('base64') };
  expectedBytes = Buffer.from(JSON.stringify({ ...payload, checksum: sha256(JSON.stringify(payload)) }));
  const writer = original.open(target, 'w', 0o600);
  try { original.write(writer, expectedBytes); } finally { original.close(writer); }
}

Reflect.set(fs, 'openSync', ((...args: unknown[]) => {
  if (String(args[0]) === target && scenario === 'retry-open-missing' && opens === 1 && injected === 1) {
    injected += 1; preservedPath = join(base, 'preserved-before-retry.json'); original.rename(target, preservedPath);
  }
  if (String(args[0]) === target && ['first-open-missing', 'open-access-denied'].includes(scenario) && injected === 0) {
    injected += 1; throw injectedError;
  }
  const fd = Reflect.apply(original.open, fs, args) as number;
  if (String(args[0]) === target) {
    descriptors.add(fd); changed.delete(fd); opens += 1; acquiredLock ??= identity(lock);
  }
  return fd;
}) as typeof fs.openSync);
fs.closeSync = fd => { original.close(fd); if (descriptors.delete(fd)) { closes += 1; changed.delete(fd); } };
Reflect.set(fs, 'fstatSync', ((...args: unknown[]) => {
  if (descriptors.has(args[0] as number) && scenario === 'fstat-error') { injected += 1; throw injectedError; }
  return Reflect.apply(original.fstat, fs, args);
}) as typeof fs.fstatSync);
Reflect.set(fs, 'readSync', ((...args: unknown[]) => {
  const fd = args[0] as number;
  if (!descriptors.has(fd)) return Reflect.apply(original.read, fs, args);
  reads += 1;
  if (scenario === 'read-error') { injected += 1; throw injectedError; }
  const count = Reflect.apply(original.read, fs, args) as number;
  if (!changed.has(fd)) {
    changed.add(fd);
    if (['change-twice', 'change-and-cleanup-error'].includes(scenario) || ['change-once', 'retry-open-missing'].includes(scenario) && injected === 0) {
      injected += 1; rewrite();
    } else if (scenario === 'missing-during-read' && injected === 0) {
      injected += 1; preservedPath = join(base, 'preserved-named-file.json'); original.rename(target, preservedPath);
    } else if (scenario === 'directory-replaced' && injected === 0) {
      injected += 1; const saved = join(base, 'preserved-files-directory'); original.rename(folder, saved); original.mkdir(folder, { mode: 0o700 });
      // Preserve the actual file object while changing the directory used to reach it.
      original.rename(join(saved, `${sha256('document.txt')}.json`), target);
    }
  }
  return count;
}) as typeof fs.readSync);
Reflect.set(fs, 'rmdirSync', ((...args: unknown[]) => {
  if (String(args[0]) === lock && scenario === 'change-and-cleanup-error') throw cleanupError;
  return Reflect.apply(original.rmdir, fs, args);
}) as typeof fs.rmdirSync);
syncBuiltinESMExports();
let result: unknown; let failure: unknown;
try { result = operation === 'read' ? await store.read('work', 'attempt', 'document.txt') : await store.list('work', 'attempt'); }
catch (error) { failure = error; }
finally {
  Reflect.set(fs, 'openSync', original.open); fs.closeSync = original.close;
  Reflect.set(fs, 'fstatSync', original.fstat); Reflect.set(fs, 'readSync', original.read); Reflect.set(fs, 'rmdirSync', original.rmdir);
  syncBuiltinESMExports(); await store.close();
}
const error = failure as (Error & { code?: string; cleanupError?: unknown }) | undefined;
const cause = error?.cause as (Error & { code?: string; operation?: string }) | undefined;
const nestedCause = cause?.cause as { code?: string } | undefined;
const readResult = result as { file?: unknown; bytes?: Uint8Array } | undefined;
const returnedFinalRecord = operation === 'list' ? isDeepStrictEqual(result, [expectedFile]) :
  isDeepStrictEqual(readResult?.file, expectedFile) && readResult?.bytes !== undefined && Buffer.from(readResult.bytes).equals(expectedContent);
const lockRemains = fs.existsSync(lock);
fs.writeSync(1, JSON.stringify({ operation, scenario, success: failure === undefined, injected, opens, closes, reads, openDescriptors: descriptors.size,
  code: failure instanceof WorkspaceError ? failure.code : error?.code ?? null,
  causeCode: cause?.code ?? null, causeOperation: cause?.operation ?? null, nestedCauseCode: nestedCause?.code ?? null,
  originalError: failure === injectedError, originalCause: error?.cause === injectedError, originalCleanupError: error?.cleanupError === cleanupError,
  returnedFinalRecord, targetExists: fs.existsSync(target), bytesPreserved: original.readFile(preservedPath).equals(expectedBytes),
  lockRemains, sameLock: lockRemains && acquiredLock !== undefined && identity(lock) === acquiredLock,
}) + '\n');
