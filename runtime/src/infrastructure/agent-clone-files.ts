import { opendirSync, realpathSync, type Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AgentProfileError, type AgentCloneEntry } from '../application/agent-profile-contracts.js';
import { profileDirectory, profileStat, publishProfileBytes, readProfileBytes, syncProfileDirectory, openProfileMutationScope, checkProfileMutationScope } from './agent-profile-files.js';
import { FileMutationFault, type HostFileMutationScope } from './host-file-mutations.js';
import { sha256 } from './digest.js';
import { captureWindowsCloneSkills, copyWindowsCloneSkills, verifyWindowsCloneSkills } from './windows-clone-files.js';

const maximumEntries = 512;
const maximumFileBytes = 4 * 1024 * 1024;
const maximumTotalBytes = 32 * 1024 * 1024;
const maximumDepth = 16;
const pendingName = /^\.secumon-init-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.pending$/;
type Side = 'source' | 'target';
type Observed = { path: string; absolute: string; stat: Stats; pending: boolean };
const fail = (code: string): never => { throw new AgentProfileError(code); };
const unsafe = (side: Side): never => fail(side === 'source' ? 'agent_clone_source_unsafe' : 'agent_clone_target_conflict');
const changed = (side: Side): never => fail(side === 'source' ? 'agent_clone_source_changed' : 'agent_clone_target_conflict');
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function guarded<T>(side: Side, action: () => T): T {
  try { return action(); }
  catch (error) {
    if (error instanceof FileMutationFault || error instanceof AgentProfileError &&
      ['agent_metadata_publish_unknown', 'agent_directory_create_unknown'].includes(error.code)) throw error;
    if (error instanceof AgentProfileError && error.code.startsWith('agent_clone_')) throw error;
    return unsafe(side);
  }
}
function component(name: string) {
  return name.length > 0 && name !== '.' && name !== '..' && !/[\\/:<>"|?*\x00-\x1f\x7f]/.test(name) &&
    !/[ .]$/.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) && Buffer.byteLength(name) <= 255;
}
function parts(path: string, side: Side) {
  if (typeof path !== 'string') return unsafe(side);
  const names = path.split('/');
  if (names.length > maximumDepth) fail('agent_clone_limit_exceeded');
  if (names.some(name => !component(name) || name.startsWith('.secumon-init-'))) return unsafe(side);
  return names;
}
function manifest(input: AgentCloneEntry[], side: Side): AgentCloneEntry[] {
  if (!Array.isArray(input)) return unsafe(side);
  if (input.length > maximumEntries) fail('agent_clone_limit_exceeded');
  const entries: AgentCloneEntry[] = []; const seen = new Set<string>(); let bytes = 0;
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') return unsafe(side);
    parts(entry.path, side);
    const key = entry.path.normalize('NFC').toLowerCase();
    if (seen.has(key)) return unsafe(side); seen.add(key);
    if (entry.kind === 'directory') {
      if (Object.keys(entry).sort().join(',') !== 'kind,path') return unsafe(side);
      entries.push({ path: entry.path, kind: 'directory' });
    } else if (entry.kind === 'file') {
      if (Object.keys(entry).sort().join(',') !== 'bytes,executable,kind,path,sha256' ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || typeof entry.executable !== 'boolean' ||
        typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) return unsafe(side);
      if (entry.bytes > maximumFileBytes || entry.bytes > maximumTotalBytes - bytes) fail('agent_clone_limit_exceeded');
      bytes += entry.bytes;
      entries.push({ path: entry.path, kind: 'file', bytes: entry.bytes, sha256: entry.sha256, executable: entry.executable });
    } else return unsafe(side);
  }
  const byPath = new Map(entries.map(entry => [entry.path, entry]));
  for (const entry of entries) {
    const names = entry.path.split('/');
    for (let length = 1; length < names.length; length++) {
      if (byPath.get(names.slice(0, length).join('/'))?.kind !== 'directory') return unsafe(side);
    }
  }
  return entries.sort((a, b) => compare(a.path, b.path));
}
function stable(a: Stats, b: Stats) {
  return (['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeMs', 'ctimeMs'] as const).every(key => a[key] === b[key]);
}
function assertObserved(entry: Observed, side: Side) {
  const current = profileStat(entry.absolute);
  if (!current || !stable(entry.stat, current)) changed(side);
}
function checkDirectory(path: string, side: Side): Stats {
  if (!profileDirectory(path, false, side === 'target')) return unsafe(side);
  const stat = profileStat(path)!;
  if ((stat.mode & 0o7000) !== 0 || side === 'target' && (stat.mode & 0o777) !== 0o700) return unsafe(side);
  return stat;
}
function checkFile(stat: Stats, side: Side) {
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & (side === 'source' ? 0o022 : 0o077)) !== 0 ||
    (stat.mode & 0o7000) !== 0 || typeof process.getuid === 'function' && stat.uid !== process.getuid() ||
    side === 'source' && stat.nlink !== 1 || side === 'target' && ![0o600, 0o700].includes(stat.mode & 0o777)) return unsafe(side);
  if (!Number.isSafeInteger(stat.size) || stat.size < 0) return unsafe(side);
  if (stat.size > maximumFileBytes) fail('agent_clone_limit_exceeded');
}
function rootPath(input: string, side: Side, allowMissing = false) {
  const absolute = resolve(input);
  if (dirname(absolute) === absolute) return unsafe(side);
  const root = join(realpathSync(dirname(absolute)), basename(absolute));
  if (!allowMissing || profileStat(root)) checkDirectory(root, side);
  return root;
}
function readObserved(entry: Observed, side: Side): Buffer {
  checkFile(entry.stat, side); assertObserved(entry, side);
  const bytes = readProfileBytes(entry.absolute, maximumFileBytes, side === 'target');
  if (bytes === null || bytes.length !== entry.stat.size) return changed(side);
  assertObserved(entry, side); return bytes;
}
function assertTargetLinks(files: Observed[]) {
  const groups = new Map<string, Observed[]>();
  for (const file of files) {
    const key = `${file.stat.dev}:${file.stat.ino}`;
    const group = groups.get(key) ?? []; group.push(file); groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.length === 1 && group[0]!.stat.nlink === 1) continue;
    if (group.length !== 2 || group.some(file => file.stat.nlink !== 2) ||
      group.filter(file => file.pending).length !== 1 || dirname(group[0]!.absolute) !== dirname(group[1]!.absolute)) unsafe('target');
  }
}
function scan(root: string, side: Side): AgentCloneEntry[] {
  const directories: Observed[] = []; const files: Observed[] = []; const entries: AgentCloneEntry[] = [];
  // Orphan publication files have their own bounded allowance so a full-size manifest can resume after a crash.
  let normalCount = 0; let pendingCount = 0; let normalBytes = 0; let pendingBytes = 0;
  function visit(absolute: string, path: string, depth: number) {
    const observed = { absolute, path, stat: checkDirectory(absolute, side), pending: false };
    directories.push(observed);
    const names: string[] = []; const directory = opendirSync(absolute);
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        if (side === 'target' && pendingName.test(entry.name)) pendingCount++;
        else normalCount++;
        if (normalCount > maximumEntries || pendingCount > maximumEntries || normalCount + pendingCount > 2 * maximumEntries) fail('agent_clone_limit_exceeded');
        names.push(entry.name);
      }
    } finally { directory.closeSync(); }
    for (const name of names.sort(compare)) {
      if (depth + 1 > maximumDepth) fail('agent_clone_limit_exceeded');
      const pending = side === 'target' && pendingName.test(name);
      if (!component(name) || name.startsWith('.secumon-init-') && !pending) return unsafe(side);
      const child = join(absolute, name); const relativePath = path ? `${path}/${name}` : name;
      const stat = profileStat(child); if (!stat) return changed(side);
      if (stat.isSymbolicLink()) return unsafe(side);
      if (stat.isDirectory()) {
        if (pending) return unsafe(side);
        entries.push({ path: relativePath, kind: 'directory' }); visit(child, relativePath, depth + 1);
      } else {
        checkFile(stat, side);
        if (pending) {
          if (stat.size > maximumTotalBytes - pendingBytes) fail('agent_clone_limit_exceeded'); pendingBytes += stat.size;
        } else {
          if (stat.size > maximumTotalBytes - normalBytes) fail('agent_clone_limit_exceeded'); normalBytes += stat.size;
        }
        files.push({ path: relativePath, absolute: child, stat, pending });
      }
    }
    assertObserved(observed, side);
  }
  visit(root, '', 0);
  if (side === 'target') assertTargetLinks(files);
  for (const file of files) {
    for (const directory of directories) assertObserved(directory, side);
    const bytes = readObserved(file, side);
    if (!file.pending) entries.push({ path: file.path, kind: 'file', bytes: bytes.length, sha256: sha256(bytes), executable: (file.stat.mode & 0o111) !== 0 });
  }
  for (const entry of [...directories, ...files]) assertObserved(entry, side);
  return manifest(entries, side);
}
const equalEntry = (a: AgentCloneEntry, b: AgentCloneEntry) => JSON.stringify(a) === JSON.stringify(b);
function assertManifest(actual: AgentCloneEntry[], expected: AgentCloneEntry[], side: Side, partial = false) {
  const wanted = new Map(expected.map(entry => [entry.path, entry]));
  if (!partial && actual.length !== expected.length || actual.some(entry => !wanted.has(entry.path) || !equalEntry(entry, wanted.get(entry.path)!))) changed(side);
}
function contains(parent: string, child: string) {
  const tail = relative(parent, child);
  return tail === '' || !isAbsolute(tail) && tail !== '..' && !tail.startsWith(`..${sep}`);
}
function parents(root: string, path: string, side: Side): Observed[] {
  const entries: Observed[] = [{ absolute: root, path: '', stat: checkDirectory(root, side), pending: false }];
  let absolute = root;
  for (const part of parts(path, side).slice(0, -1)) {
    absolute = join(absolute, part); entries.push({ absolute, path: '', stat: checkDirectory(absolute, side), pending: false });
  }
  return entries;
}

/** Bounded source snapshot; skill documents may be 0644/0755 but cannot be writable by other users. */
export function captureCloneSkills(root: string): AgentCloneEntry[] {
  if (process.platform === 'win32') return guarded('source', () => manifest(captureWindowsCloneSkills(root), 'source'));
  return guarded('source', () => scan(rootPath(root, 'source'), 'source'));
}

/** Requires an exact private target tree, except safe orphan publication files, which remain untouched. */
export function verifyCloneSkills(root: string, entries: AgentCloneEntry[]): void {
  if (process.platform === 'win32') return guarded('target', () => verifyWindowsCloneSkills(root, manifest(entries, 'target')));
  guarded('target', () => assertManifest(scan(rootPath(root, 'target'), 'target'), manifest(entries, 'target'), 'target'));
}

/** Copies missing entries only. A retry may reuse exact published files but never overwrite conflicts. */
export function copyCloneSkills(source: string, target: string, input: AgentCloneEntry[], suppliedScope?: HostFileMutationScope): void {
  if (process.platform === 'win32') return guarded('target', () => copyWindowsCloneSkills(source, target, manifest(input, 'source'), suppliedScope));
  const sourceRoot = guarded('source', () => rootPath(source, 'source'));
  const targetRoot = guarded('target', () => rootPath(target, 'target', true));
  if (contains(sourceRoot, targetRoot) || contains(targetRoot, sourceRoot)) unsafe('target');
  const scope = suppliedScope ?? openProfileMutationScope(targetRoot, [sourceRoot]);
  try { copyScopedSkills(source, target, input, scope); checkProfileMutationScope(scope); }
  finally { if (!suppliedScope) scope.close(); }
}
function copyScopedSkills(source: string, target: string, input: AgentCloneEntry[], scope: HostFileMutationScope): void {
  const expected = guarded('source', () => manifest(input, 'source'));
  const sourceRoot = guarded('source', () => rootPath(source, 'source'));
  const targetRoot = guarded('target', () => rootPath(target, 'target', true));
  if (contains(sourceRoot, targetRoot) || contains(targetRoot, sourceRoot)) unsafe('target');
  assertManifest(captureCloneSkills(sourceRoot), expected, 'source');
  guarded('target', () => {
    if (profileStat(targetRoot)) assertManifest(scan(targetRoot, 'target'), expected, 'target', true);
    else {
      if (!profileDirectory(dirname(targetRoot), false, false) || !profileDirectory(targetRoot, true, true, scope)) return unsafe('target');
      syncProfileDirectory(targetRoot, scope);
    }
  });
  for (const entry of expected) {
    const path = join(targetRoot, ...entry.path.split('/'));
    if (entry.kind === 'directory') {
      guarded('target', () => {
        const chain = parents(targetRoot, entry.path, 'target');
        if (!profileDirectory(path, true, true, scope)) return unsafe('target');
        checkDirectory(path, 'target');
        // Creating a child changes its parent's metadata, so recheck type/permissions rather than the old directory timestamps.
        for (const parent of chain) {
          const current = checkDirectory(parent.absolute, 'target');
          if (current.dev !== parent.stat.dev || current.ino !== parent.stat.ino) changed('target');
        }
        syncProfileDirectory(path, scope); syncProfileDirectory(dirname(path), scope);
      });
      continue;
    }
    const reused = guarded('target', () => {
      const chain = parents(targetRoot, entry.path, 'target'); const stat = profileStat(path);
      if (!stat) return false;
      const stored = readObserved({ path: entry.path, absolute: path, stat, pending: false }, 'target');
      for (const directory of chain) assertObserved(directory, 'target');
      if (stored.length !== entry.bytes || sha256(stored) !== entry.sha256 || ((stat.mode & 0o111) !== 0) !== entry.executable) return changed('target');
      return true;
    });
    if (reused) continue;
    const bytes = guarded('source', () => {
      const chain = parents(sourceRoot, entry.path, 'source'); const absolute = join(sourceRoot, ...entry.path.split('/'));
      const stat = profileStat(absolute); if (!stat) return changed('source');
      const bytes = readObserved({ path: entry.path, absolute, stat, pending: false }, 'source');
      for (const directory of chain) assertObserved(directory, 'source');
      if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256 || ((stat.mode & 0o111) !== 0) !== entry.executable) return changed('source');
      return bytes;
    });
    guarded('target', () => {
      const chain = parents(targetRoot, entry.path, 'target');
      publishProfileBytes(path, bytes, entry.executable, scope);
      for (const parent of chain) {
        const current = checkDirectory(parent.absolute, 'target');
        if (current.dev !== parent.stat.dev || current.ino !== parent.stat.ino) changed('target');
      }
    });
  }
  assertManifest(captureCloneSkills(sourceRoot), expected, 'source');
  verifyCloneSkills(targetRoot, expected);
}
