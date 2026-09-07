import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import type { z } from 'zod';
import { AgentLifecycleError, LifecycleEntrySchema, type LifecycleEntry } from '../application/agent-lifecycle-contracts.js';
import { completeMetadataPublication, hostFileDurabilityPolicy, type MetadataDirectory } from './host-metadata-files.js';
import { openProfileMutationScope, profileDirectory, syncProfileDirectory } from './agent-profile-files.js';
import { windowsCanonicalPath, windowsProfileContains, windowsProfileFiles, windowsProfilePath, windowsPathInfo } from './windows-profile-files.js';
import type { WindowsPathInfo, WindowsReadStream, WindowsWriteCandidate } from './windows-file-addon.js';
import { readWindowsFile, publishWindowsFileSync } from './windows-stream-files.js';

export interface WindowsLifecycleLimits { bytes: number; fileBytes: number; entries: number }
type FileEntry = Extract<LifecycleEntry, { kind: 'file' }>;
type Files = ReturnType<typeof windowsProfileFiles>;
const chunk = 1024 * 1024;
const fail: (code: string) => never = code => { throw new AgentLifecycleError(code); };
const key = (path: string) => path.normalize('NFC').toUpperCase();
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function policy() {
  if (hostFileDurabilityPolicy() !== 'process-crash') fail('lifecycle_windows_durability_required');
}
function closeAll(actions: (() => void)[], failure?: { error: unknown }) {
  const errors: unknown[] = [];
  for (const action of actions) try { action(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError([...(failure ? [failure.error] : []), ...errors], 'windows_lifecycle_close_failed');
}
function size(info: WindowsPathInfo, maximum: number) {
  if (info.kind !== 'regular' || !/^(0|[1-9][0-9]*)$/.test(info.bytes)) fail('lifecycle_file_unsafe');
  const bytes = BigInt(info.bytes);
  if (bytes > BigInt(maximum)) fail('lifecycle_capacity_exceeded');
  return Number(bytes);
}
function consume(files: Files, parent: MetadataDirectory, name: string, maximum: number, append?: (bytes: Buffer) => void) {
  let reader: WindowsReadStream | undefined, failure: { error: unknown } | undefined;
  try {
    const named = files.inspectChild(parent, name); if (!named) return fail('lifecycle_source_changed');
    const expected = size(named, maximum);
    reader = files.handle(parent).openReadRegular(name, maximum);
    if (!same(reader.info(), named)) fail('lifecycle_source_changed');
    const hash = createHash('sha256'); let bytes = 0;
    for (;;) {
      const part = reader.read(chunk);
      if (!Buffer.isBuffer(part) || part.length > chunk) fail('lifecycle_stream_invalid');
      if (!part.length) break;
      bytes += part.length; if (bytes > expected || bytes > maximum) fail('lifecycle_capacity_exceeded');
      hash.update(part); append?.(part);
    }
    if (bytes !== expected || !same(reader.info(), named) || !same(files.inspectChild(parent, name), named)) fail('lifecycle_source_changed');
    return { bytes, sha256: hash.digest('hex'), executable: false, observed: named };
  } catch (error) { failure = { error }; throw error; }
  finally { closeAll(reader ? [() => reader!.close()] : [], failure); }
}

export function windowsLifecycleRoot(input: string, exists: boolean): string {
  const root = windowsProfilePath(input, !exists);
  if (exists && windowsPathInfo(root)?.kind !== 'directory') fail('lifecycle_directory_unsafe');
  return root;
}
export function windowsLifecycleDisjoint(a: string, b: string): void {
  if (windowsProfileContains(a, b) || windowsProfileContains(b, a)) fail('lifecycle_directory_overlap');
}
export function syncWindowsLifecycleDirectory(path: string): void {
  policy(); const files = windowsProfileFiles(), ref = files.inspectDirectory(windowsProfilePath(path), 'private');
  if (!ref) return fail('lifecycle_directory_unsafe');
  let failure: { error: unknown } | undefined;
  try {
    const completed = completeMetadataPublication(files, ref);
    if (completed.durability !== 'process-crash' || completed.directorySynced) fail('lifecycle_windows_durability_invalid');
  } catch (error) { failure = { error }; throw error; }
  finally { closeAll([() => files.closeDirectory(ref)], failure); }
}
export function createWindowsLifecycleDirectory(input: string): void {
  policy(); const root = windowsLifecycleRoot(input, false), scope = openProfileMutationScope(root, []);
  let failure: { error: unknown } | undefined;
  try { profileDirectory(root, true, true, scope, true); syncProfileDirectory(root, scope); scope.check(); }
  catch (error) { failure = { error }; throw error; }
  finally { closeAll([() => scope.close()], failure); }
}
export function readWindowsLifecycleJson<T>(path: string, schema: z.ZodType<T>, maximum: number): T | null {
  const files = windowsProfileFiles(), parent = files.inspectDirectory(win32.dirname(path), 'private');
  if (!parent) return null;
  let failure: { error: unknown } | undefined;
  try {
    if (!files.inspectChild(parent, win32.basename(path))) return null;
    const bytes = readWindowsFile(files, parent, win32.basename(path), maximum);
    const parsed = schema.safeParse(JSON.parse(bytes.toString('utf8')));
    if (!parsed.success) return fail('lifecycle_manifest_invalid');
    return parsed.data;
  } catch (error) { failure = { error }; throw error; }
  finally { closeAll([() => files.closeDirectory(parent)], failure); }
}
export function publishWindowsLifecycleJson(root: string, name: string, value: unknown): void {
  policy(); const scope = openProfileMutationScope(root, []), files = windowsProfileFiles();
  let failure: { error: unknown } | undefined;
  try {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
    if (bytes.length > 32 * 1024 ** 2) fail('lifecycle_capacity_exceeded');
    const parent = scope.directory(root, 'private'); if (!parent) return fail('lifecycle_directory_unsafe');
    const result = publishWindowsFileSync(files, parent, name, bytes);
    if (!result.published) fail('lifecycle_destination_exists');
    if (!readWindowsFile(files, parent, name, bytes.length).equals(bytes)) fail('lifecycle_source_changed');
    syncProfileDirectory(root, scope); scope.check();
  } catch (error) { failure = { error }; throw error; }
  finally { closeAll([() => scope.close()], failure); }
}
/** Compare the exact marker bytes through the retained native parent before deleting it. */
export function removeWindowsLifecycleMarker(path: string, expected: Buffer): void {
  policy(); const root = windowsProfilePath(win32.dirname(path)), scope = openProfileMutationScope(root, []), files = windowsProfileFiles();
  let failure: { error: unknown } | undefined;
  try {
    if (expected.length > 4 * 1024 ** 2) fail('lifecycle_capacity_exceeded');
    const parent = scope.directory(root, 'private'); if (!parent) return fail('lifecycle_directory_unsafe');
    scope.check();
    if (!files.handle(parent).removeRegular(win32.basename(path), expected)) fail('lifecycle_source_changed');
    syncProfileDirectory(root, scope); scope.check();
  } catch (error) { failure = { error }; throw error; }
  finally { closeAll([() => scope.close()], failure); }
}

/** Retains native directory ancestors throughout traversal and rechecks every consumed file. */
export function captureWindowsLifecycleTree(input: string, include: (path: string) => boolean, limits: WindowsLifecycleLimits): LifecycleEntry[] {
  const root = windowsLifecycleRoot(input, true), files = windowsProfileFiles();
  const held: { ref: MetadataDirectory; token: string }[] = [];
  const observed: { parent: MetadataDirectory; name: string; info: WindowsPathInfo }[] = [];
  const entries: LifecycleEntry[] = [], seen = new Set<string>();
  let total = 0, visited = 0, failure: { error: unknown } | undefined;
  const rootDepth = root.slice(3).split('\\').filter(Boolean).length;
  const retain = (ref: MetadataDirectory) => { held.push({ ref, token: files.handle(ref).check().changeToken }); };
  function visit(ref: MetadataDirectory, absolute: string, prefix: string, depth: number) {
    const names = files.names(ref, Math.min(65536, limits.entries)).sort();
    for (const name of names) {
      if (++visited > limits.entries) fail('lifecycle_capacity_exceeded');
      const path = prefix ? `${prefix}/${name}` : name;
      if (!include(path)) continue;
      if (seen.has(key(path)) || path.includes('\\')) fail('lifecycle_path_unsafe'); seen.add(key(path));
      const info = files.inspectChild(ref, name); if (!info) fail('lifecycle_source_changed');
      if (info.kind === 'directory') {
        if (rootDepth + depth + 1 > 64) fail('lifecycle_capacity_exceeded');
        const absoluteChild = win32.join(absolute, name), native = files.handle(ref).childDirectory(name, false, false, 'process-crash');
        if (!native) fail('lifecycle_source_changed');
        const child = files.reference(native, absoluteChild, 'private'); retain(child);
        entries.push({ kind: 'directory', path }); visit(child, absoluteChild, path, depth + 1);
      } else {
        total += size(info, limits.fileBytes); if (total > limits.bytes) fail('lifecycle_capacity_exceeded');
        const result = consume(files, ref, name, limits.fileBytes);
        if (!same(result.observed, info)) fail('lifecycle_source_changed');
        observed.push({ parent: ref, name, info });
        entries.push({ kind: 'file', path, bytes: result.bytes, sha256: result.sha256, executable: false });
      }
    }
  }
  try {
    const ref = files.inspectDirectory(root, 'private'); if (!ref) fail('lifecycle_directory_unsafe');
    retain(ref); visit(ref, root, '', 0);
    for (const file of observed) if (!same(files.inspectChild(file.parent, file.name), file.info)) fail('lifecycle_source_changed');
    for (const item of held) if (files.handle(item.ref).check().changeToken !== item.token) fail('lifecycle_source_changed');
    return entries;
  } catch (error) { failure = { error }; throw error; }
  finally { closeAll(held.reverse().map(item => () => files.closeDirectory(item.ref)), failure); }
}

export function validateWindowsLifecycleEntries(entries: readonly LifecycleEntry[], limits: WindowsLifecycleLimits) {
  if (entries.length > limits.entries) fail('lifecycle_capacity_exceeded');
  const seen = new Map<string, LifecycleEntry>(); let total = 0;
  for (const raw of entries) {
    const entry = LifecycleEntrySchema.parse(raw), name = key(entry.path), parent = entry.path.split('/').slice(0, -1).join('/');
    if (seen.has(name) || parent && seen.get(key(parent))?.kind !== 'directory') fail('lifecycle_path_unsafe');
    if (entry.kind === 'file') {
      if (entry.executable) fail('lifecycle_windows_executable_unsupported');
      total += entry.bytes; if (entry.bytes > limits.fileBytes || total > limits.bytes) fail('lifecycle_capacity_exceeded');
    }
    seen.set(name, entry);
  }
}
function provePrefix(files: Files, sourceParent: MetadataDirectory, sourceName: string, candidateParent: MetadataDirectory,
  candidate: string, expected: FileEntry, maximum: number): WindowsPathInfo | null {
  const observed = files.inspectChild(candidateParent, candidate);
  let reader: WindowsReadStream | undefined, failure: { error: unknown } | undefined;
  try {
    let remaining = observed ? size(observed, expected.bytes) : 0;
    if (observed) {
      reader = files.handle(candidateParent).openReadRegular(candidate, maximum);
      if (!same(reader.info(), observed)) fail('lifecycle_source_changed');
    }
    const original = consume(files, sourceParent, sourceName, maximum, part => {
      let offset = 0; const wanted = Math.min(part.length, remaining);
      while (offset < wanted) {
        const prefix = reader!.read(wanted - offset);
        if (!prefix.length || prefix.length > wanted - offset || !prefix.equals(part.subarray(offset, offset + prefix.length)))
          fail('lifecycle_restore_prefix_mismatch');
        offset += prefix.length; remaining -= prefix.length;
      }
    });
    if (original.bytes !== expected.bytes || original.sha256 !== expected.sha256) fail('lifecycle_source_changed');
    if (remaining !== 0 || reader && (reader.read(1).length !== 0 || !same(reader.info(), observed))) fail('lifecycle_source_changed');
    if (!same(files.inspectChild(candidateParent, candidate), observed)) fail('lifecycle_source_changed');
    return observed;
  } catch (error) { failure = { error }; throw error; }
  finally { closeAll(reader ? [() => reader!.close()] : [], failure); }
}
function copyFile(source: string, destination: string, expected: FileEntry, maximum: number,
  recovery?: { candidate: string; assertOperation: () => void }): void {
  policy(); if (expected.executable) fail('lifecycle_windows_executable_unsupported');
  if (expected.bytes > maximum) fail('lifecycle_capacity_exceeded');
  const from = windowsProfilePath(win32.dirname(source)), to = windowsProfilePath(win32.dirname(destination));
  const files = windowsProfileFiles(), ref = files.inspectDirectory(from, 'private');
  if (!ref) fail('lifecycle_directory_unsafe');
  let scope: ReturnType<typeof openProfileMutationScope> | undefined, writer: WindowsWriteCandidate | undefined, failure: { error: unknown } | undefined;
  try {
    if (key(win32.join(windowsCanonicalPath(from), win32.basename(source))) ===
      key(win32.join(windowsCanonicalPath(to), win32.basename(destination)))) fail('lifecycle_directory_overlap');
    scope = openProfileMutationScope(to, []);
    const parent = scope.directory(to, 'private'); if (!parent) fail('lifecycle_directory_unsafe');
    let skip = 0;
    if (recovery) {
      recovery.assertOperation();
      const prefix = provePrefix(files, ref, win32.basename(source), parent, recovery.candidate, expected, maximum);
      skip = prefix ? size(prefix, expected.bytes) : 0; recovery.assertOperation();
      writer = files.handle(parent).recoverableCandidate(win32.basename(destination), recovery.candidate, maximum, prefix, 'process-crash');
    } else writer = files.handle(parent).createCandidate(win32.basename(destination), maximum, 'process-crash');
    const copied = consume(files, ref, win32.basename(source), maximum, bytes => {
      const offset = Math.min(skip, bytes.length); skip -= offset;
      if (offset < bytes.length) writer!.append(bytes.subarray(offset));
    });
    if (skip !== 0 || copied.bytes !== expected.bytes || copied.sha256 !== expected.sha256) fail('lifecycle_source_changed');
    writer.prepare(); scope.check(); recovery?.assertOperation();
    const outcome = writer.publish();
    if (!outcome.ok || outcome.publication !== 'created' || outcome.fileFlush !== 'completed' || outcome.namespaceBarrier !== 'unsupported' ||
      outcome.cleanupWin32Error !== undefined || outcome.closeWin32Error !== undefined) {
      throw new AgentLifecycleError(outcome.publication === 'already_exists' ? 'lifecycle_destination_exists' :
        outcome.publication === 'unknown' || outcome.publication === 'created' ? 'lifecycle_publication_unknown' : 'lifecycle_publication_failed',
      { cause: Object.assign(new Error(outcome.code ?? 'windows_publication_failed'), { outcome }) });
    }
    const stored = consume(files, parent, win32.basename(destination), maximum);
    if (stored.bytes !== expected.bytes || stored.sha256 !== expected.sha256 || stored.observed.identity !== outcome.fileIdentity) fail('lifecycle_source_changed');
    syncProfileDirectory(to, scope); scope.check(); recovery?.assertOperation();
  } catch (error) { failure = { error }; throw error; }
  finally { closeAll([...(writer ? [() => writer!.close()] : []), ...(scope ? [() => scope!.close()] : []), () => files.closeDirectory(ref)], failure); }
}
export function copyWindowsLifecycleFile(source: string, destination: string, expected: FileEntry, maximum: number): void {
  copyFile(source, destination, expected, maximum);
}
/** Internal host path: the operation binding selects one name, and every candidate byte is proved before reopening. */
export function restoreWindowsLifecycleFile(source: string, destination: string, expected: FileEntry, maximum: number,
  candidate: string, assertOperation: () => void): void {
  copyFile(source, destination, expected, maximum, { candidate, assertOperation });
}
export function copyWindowsLifecycleTree(source: string, destination: string, entries: readonly LifecycleEntry[], limits: WindowsLifecycleLimits): void {
  policy(); validateWindowsLifecycleEntries(entries, limits);
  const from = windowsLifecycleRoot(source, true), to = windowsLifecycleRoot(destination, true); windowsLifecycleDisjoint(from, to);
  const names = new Set(entries.map(entry => entry.path));
  if (!same(captureWindowsLifecycleTree(from, path => names.has(path), limits), entries)) fail('lifecycle_source_changed');
  for (const entry of entries) {
    const target = win32.join(to, ...entry.path.split('/'));
    if (entry.kind === 'directory') createWindowsLifecycleDirectory(target);
    else copyWindowsLifecycleFile(win32.join(from, ...entry.path.split('/')), target, entry, limits.fileBytes);
  }
  if (!same(captureWindowsLifecycleTree(from, path => names.has(path), limits), entries)) fail('lifecycle_source_changed');
  for (const entry of [...entries].reverse()) if (entry.kind === 'directory') syncWindowsLifecycleDirectory(win32.join(to, ...entry.path.split('/')));
  syncWindowsLifecycleDirectory(to);
}
