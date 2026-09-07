import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const [root, scenario] = process.argv.slice(2);
if (!root || !scenario) throw new Error('worker_arguments_required');
const target = join(root, 'value.json'); if (scenario !== 'fifo') fs.writeFileSync(target, 'old bytes', { mode: 0o600 });
if (scenario === 'policy-error') fs.linkSync(target, join(root, 'publication.pending'));
const original = {
  open: fs.openSync, close: fs.closeSync, read: fs.readSync, fstat: fs.fstatSync, lstat: fs.lstatSync,
  sync: fs.fsyncSync, write: fs.writeFileSync, rename: fs.renameSync, mkdir: fs.mkdirSync,
};
const tracked = new Map<number, string>(); const changed = new Set<number>();
let opens = 0; let closes = 0; let reads = 0; let mutations = 0;
const io = () => Object.assign(new Error('injected_io_failure'), { code: 'EIO' });
fs.openSync = ((...args: unknown[]) => {
  const fd = Reflect.apply(original.open, fs, args) as number;
  if (String(args[0]) === target || String(args[0]) === root) { tracked.set(fd, String(args[0])); changed.delete(fd); opens += 1; }
  return fd;
}) as typeof fs.openSync;
fs.closeSync = (fd: number) => {
  original.close(fd); if (tracked.delete(fd)) { closes += 1; changed.delete(fd); }
};
fs.readSync = ((...args: unknown[]) => {
  const fd = args[0] as number;
  if (tracked.get(fd) !== target) return Reflect.apply(original.read, fs, args);
  reads += 1;
  if (scenario === 'read-error') throw io();
  const bytes = Reflect.apply(original.read, fs, args) as number;
  if (!changed.has(fd) && (scenario === 'changed-twice' || mutations === 0 && ['changed-once', 'replaced-once', 'directory-replaced', 'grew-over-limit'].includes(scenario))) {
    changed.add(fd); mutations += 1;
    if (scenario === 'replaced-once') original.rename(target, join(root, 'previous-value.json'));
    if (scenario === 'directory-replaced') { original.rename(root, `${root}.previous`); original.mkdir(root, { mode: 0o700 }); }
    // Mutating descriptors bypass the instrumentation, which counts adapter-owned descriptors only.
    const writer = original.open(target, 'w', 0o600);
    try { original.write(writer, scenario === 'grew-over-limit' ? Buffer.alloc(129, 120) : scenario === 'changed-twice' ? `changed content ${'x'.repeat(mutations)}` : 'new bytes'); }
    finally { original.close(writer); }
    if (scenario === 'changed-once') {
      // Ensure same-sized rewrites are distinguishable even on coarse timestamp file systems.
      fs.utimesSync(target, new Date(1000), new Date(1000));
    }
  }
  return bytes;
}) as typeof fs.readSync;
fs.fstatSync = ((...args: unknown[]) => {
  const result = Reflect.apply(original.fstat, fs, args) as fs.BigIntStats | fs.Stats;
  if (scenario === 'foreign-file-uid' && tracked.get(args[0] as number) === target) {
    return Object.assign(Object.create(Object.getPrototypeOf(result)), result, { uid: typeof result.uid === 'bigint' ? result.uid + 1n : result.uid + 1 });
  }
  return result;
}) as typeof fs.fstatSync;
Reflect.set(fs, 'lstatSync', ((...args: unknown[]) => {
  const result = Reflect.apply(original.lstat, fs, args) as fs.BigIntStats | fs.Stats;
  if (scenario === 'foreign-directory-uid' && String(args[0]) === root) {
    return Object.assign(Object.create(Object.getPrototypeOf(result)), result, { uid: typeof result.uid === 'bigint' ? result.uid + 1n : result.uid + 1 });
  }
  return result;
}) as typeof fs.lstatSync);
fs.fsyncSync = (fd: number) => {
  if (scenario === 'sync-error' && tracked.get(fd) === root) throw io();
  original.sync(fd);
};
syncBuiltinESMExports();
const { PosixMetadataFiles } = await import('../../infrastructure/posix-metadata-files.js');
const adapter = new PosixMetadataFiles();
let value: string | null = null; let failure: unknown;
try {
  const directory = adapter.inspectDirectory(root, 'private'); if (!directory) throw new Error('worker_directory_missing');
  if (scenario === 'sync-error') adapter.syncDirectory(directory);
  else value = adapter.readStableRegularFile(directory, 'value.json', {
    maximum: 128, access: 'private',
    ...(scenario === 'policy-error' ? { allowLinkedFile: () => { throw new Error('policy_failure'); } } : {}),
  }).toString();
} catch (error) { failure = error; }
const error = failure as { code?: string; message?: string; cause?: NodeJS.ErrnoException } | undefined;
fs.writeSync(1, JSON.stringify({ scenario, value, code: error?.code ?? null, message: error?.message ?? null, causeCode: error?.cause?.code ?? null, opens, closes, reads, openDescriptors: tracked.size }) + '\n');
