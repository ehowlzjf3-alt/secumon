import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AgentLifecycleError, type LifecycleEntry } from '../application/agent-lifecycle-contracts.js';
import { hostMetadataFiles } from './host-metadata-files.js';
import { captureWindowsLifecycleTree, copyWindowsLifecycleFile, copyWindowsLifecycleTree, createWindowsLifecycleDirectory,
  syncWindowsLifecycleDirectory, windowsLifecycleDisjoint, windowsLifecycleRoot } from './windows-lifecycle-files.js';
import { windowsPathInfo, windowsProfileNames } from './windows-profile-files.js';
import { profileStat } from './agent-profile-files.js';

export const lifecycleLimits = Object.freeze({ bytes: 4 * 1024 ** 3, fileBytes: 1024 ** 3, entries: 100000 });
export const lifecycleFail: (code: string) => never = code => { throw new AgentLifecycleError(code); };
export const lifecycleDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function lifecycleRoot(input: string, exists = true) {
  if (process.platform === 'win32') return windowsLifecycleRoot(input, exists);
  const absolute = resolve(input); const parent = realpathSync(dirname(absolute)); const root = join(parent, basename(absolute));
  if (exists) { const stat = lstatSync(root); if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 || typeof process.getuid === 'function' && stat.uid !== process.getuid()) lifecycleFail('lifecycle_directory_unsafe'); }
  return root;
}
export function disjoint(a: string, b: string) {
  if (process.platform === 'win32') return windowsLifecycleDisjoint(a, b);
  const contains = (left: string, right: string) => { const part = relative(left, right); return part === '' || !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`); };
  if (contains(a, b) || contains(b, a)) lifecycleFail('lifecycle_directory_overlap');
}
export function syncLifecycleDirectory(path: string) {
  if (process.platform === 'win32') return syncWindowsLifecycleDirectory(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function lifecycleExists(path: string): boolean {
  return process.platform === 'win32' ? windowsPathInfo(path) !== null : profileStat(path) !== null;
}
export function lifecycleNames(path: string, maximum = 65536): string[] {
  if (process.platform === 'win32') return windowsProfileNames(path, maximum);
  return readdirSync(path);
}
export function createLifecycleDirectory(path: string) {
  if (process.platform === 'win32') return createWindowsLifecycleDirectory(path);
  const files = hostMetadataFiles(), parent = files.inspectDirectory(dirname(path), 'owner-writable');
  if (!parent) lifecycleFail('lifecycle_directory_unsafe');
  mkdirSync(path, { mode: 0o700 }); files.inspectDirectory(dirname(path), 'owner-writable', parent!); syncLifecycleDirectory(dirname(path));
}
function file(path: string, output?: string) {
  const files = hostMetadataFiles(), parent = files.inspectDirectory(dirname(path), 'owner-writable');
  const destinationParent = output ? files.inspectDirectory(dirname(output), 'owner-writable') : null;
  if (!parent || output && !destinationParent) lifecycleFail('lifecycle_directory_unsafe');
  const before = lstatSync(path); if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o022) !== 0 || before.size > lifecycleLimits.fileBytes || typeof process.getuid === 'function' && before.uid !== process.getuid()) lifecycleFail('lifecycle_file_unsafe');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); let target: number | undefined;
  try {
    const opened = fstatSync(fd); if (opened.ino !== before.ino || opened.dev !== before.dev) lifecycleFail('lifecycle_source_changed');
    if (output) target = openSync(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, (before.mode & 0o111) ? 0o700 : 0o600);
    const buffer = Buffer.allocUnsafe(1024 * 1024); const hash = createHash('sha256'); let bytes = 0;
    for (;;) { const count = readSync(fd, buffer, 0, buffer.length, null); if (!count) break; bytes += count; if (bytes > lifecycleLimits.fileBytes) lifecycleFail('lifecycle_capacity_exceeded'); hash.update(buffer.subarray(0, count)); if (target !== undefined) { let offset = 0; while (offset < count) offset += writeSync(target, buffer, offset, count - offset); } }
    const after = fstatSync(fd), named = lstatSync(path);
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || named.ino !== before.ino || named.dev !== before.dev) lifecycleFail('lifecycle_source_changed');
    if (target !== undefined) fsyncSync(target);
    files.inspectDirectory(dirname(path), 'owner-writable', parent!);
    if (output) files.inspectDirectory(dirname(output), 'owner-writable', destinationParent!);
    return { bytes, sha256: hash.digest('hex'), executable: !!(before.mode & 0o111) };
  } finally { if (target !== undefined) closeSync(target); closeSync(fd); }
}
export function captureLifecycleTree(root: string, include: (path: string) => boolean = () => true): LifecycleEntry[] {
  if (process.platform === 'win32') return captureWindowsLifecycleTree(root, include, lifecycleLimits);
  const result: LifecycleEntry[] = []; let bytes = 0;
  const visit = (folder: string, prefix: string) => { for (const name of readdirSync(folder).sort()) {
    const path = prefix ? `${prefix}/${name}` : name; if (!include(path)) continue;
    if (path.includes('\\')) lifecycleFail('lifecycle_path_unsafe');
    const absolute = join(folder, name), stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) lifecycleFail('lifecycle_symlink_unsupported');
    if (stat.isDirectory()) { lifecycleRoot(absolute); result.push({ kind: 'directory', path }); visit(absolute, path); }
    else { const entry = file(absolute); bytes += entry.bytes; if (bytes > lifecycleLimits.bytes) lifecycleFail('lifecycle_capacity_exceeded'); result.push({ kind: 'file', path, ...entry }); }
    if (result.length > lifecycleLimits.entries) lifecycleFail('lifecycle_capacity_exceeded');
  } };
  visit(root, ''); return result;
}
export function copyLifecycleTree(source: string, destination: string, entries: readonly LifecycleEntry[]) {
  if (process.platform === 'win32') return copyWindowsLifecycleTree(source, destination, entries, lifecycleLimits);
  for (const entry of entries) {
    const target = join(destination, entry.path);
    if (entry.kind === 'directory') createLifecycleDirectory(target);
    else { const copied = file(join(source, entry.path), target); if (lifecycleDigest(copied) !== lifecycleDigest({ bytes: entry.bytes, sha256: entry.sha256, executable: entry.executable })) lifecycleFail('lifecycle_source_changed'); }
  }
  for (const entry of [...entries].reverse()) if (entry.kind === 'directory') syncLifecycleDirectory(join(destination, entry.path));
  syncLifecycleDirectory(destination);
}
export function copyLifecycleFile(source: string, destination: string, entry: Extract<LifecycleEntry, { kind: 'file' }>): void {
  if (process.platform === 'win32') return copyWindowsLifecycleFile(source, destination, entry, lifecycleLimits.fileBytes);
  const copied = file(source, destination);
  if (lifecycleDigest(copied) !== lifecycleDigest({ bytes: entry.bytes, sha256: entry.sha256, executable: entry.executable })) lifecycleFail('lifecycle_source_changed');
}
