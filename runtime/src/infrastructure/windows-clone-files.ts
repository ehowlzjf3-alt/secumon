import { win32 } from 'node:path';
import { AgentProfileError, type AgentCloneEntry } from '../application/agent-profile-contracts.js';
import type { MetadataDirectory } from './host-metadata-files.js';
import type { HostFileMutationScope } from './host-file-mutations.js';
import { openProfileMutationScope, publishProfileBytes, readProfileBytes, syncProfileDirectory } from './agent-profile-files.js';
import { windowsProfileContains, windowsProfileFiles, windowsProfilePath, windowsPathInfo } from './windows-profile-files.js';
import { sha256 } from './digest.js';

const maximumEntries = 512, maximumBytes = 4 * 1024 * 1024, maximumTotal = 32 * 1024 * 1024, maximumDepth = 16;
const pendingName = /^\.secumon-init-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.pending$/;
const fail: (code: string) => never = code => { throw new AgentProfileError(code); };
const equal = (a: AgentCloneEntry, b: AgentCloneEntry) => JSON.stringify(a) === JSON.stringify(b);
function assertEntries(actual: AgentCloneEntry[], expected: AgentCloneEntry[], partial = false) {
  const wanted = new Map(expected.map(entry => [entry.path, entry]));
  if (!partial && actual.length !== expected.length || actual.some(entry => !wanted.has(entry.path) || !equal(entry, wanted.get(entry.path)!))) fail('agent_clone_target_conflict');
}
/** Windows skills have native private ACLs; no synthetic POSIX mode or executable bit is inferred. */
export function captureWindowsCloneSkills(input: string, target = false): AgentCloneEntry[] {
  const root = windowsProfilePath(input), files = windowsProfileFiles();
  const held: { ref: MetadataDirectory; token: string }[] = [];
  const observed: { parent: MetadataDirectory; name: string; token: string }[] = [];
  const entries: AgentCloneEntry[] = [], seen = new Set<string>();
  let normal = 0, pending = 0, total = 0, pendingBytes = 0, failure: unknown;
  const changed = () => fail(target ? 'agent_clone_target_conflict' : 'agent_clone_source_changed');
  function retain(ref: MetadataDirectory) { held.push({ ref, token: files.handle(ref).check().changeToken }); }
  function visit(ref: MetadataDirectory, absolute: string, prefix: string, depth: number) {
    const names = files.names(ref, 2 * maximumEntries);
    for (const name of names) {
      if (depth + 1 > maximumDepth) fail('agent_clone_limit_exceeded');
      const orphan = target && pendingName.test(name);
      if (name.startsWith('.secumon-init-') && !orphan) fail('agent_clone_source_unsafe');
      if (orphan ? ++pending > maximumEntries : ++normal > maximumEntries) fail('agent_clone_limit_exceeded');
      const path = prefix ? `${prefix}/${name}` : name, key = path.normalize('NFC').toLowerCase();
      if (seen.has(key)) fail('agent_clone_source_unsafe'); seen.add(key);
      const info = files.inspectChild(ref, name); if (!info) return changed();
      const absoluteChild = win32.join(absolute, name);
      if (info.kind === 'directory') {
        if (orphan) fail('agent_clone_target_conflict');
        const native = files.handle(ref).childDirectory(name, false, false, 'process-crash'); if (!native) return changed();
        const child = files.reference(native, absoluteChild, 'private'); retain(child);
        entries.push({ path, kind: 'directory' }); visit(child, absoluteChild, path, depth + 1);
      } else {
        const size = BigInt(info.bytes);
        if (size < 0n || size > BigInt(maximumBytes)) fail('agent_clone_limit_exceeded');
        if (orphan) pendingBytes += Number(size); else total += Number(size);
        if (total > maximumTotal || pendingBytes > maximumTotal) fail('agent_clone_limit_exceeded');
        const bytes = files.readStableRegularFile(ref, name, { maximum: maximumBytes, access: 'private' });
        if (bytes.length !== Number(size) || files.inspectChild(ref, name)?.changeToken !== info.changeToken) return changed();
        observed.push({ parent: ref, name, token: info.changeToken });
        if (!orphan) entries.push({ path, kind: 'file', bytes: bytes.length, sha256: sha256(bytes), executable: false });
      }
    }
  }
  try {
    const ref = files.inspectDirectory(root, 'private'); if (!ref) fail('agent_clone_source_unsafe');
    retain(ref); visit(ref, root, '', 0);
    for (const entry of observed) if (files.inspectChild(entry.parent, entry.name)?.changeToken !== entry.token) changed();
    for (const entry of held) if (files.handle(entry.ref).check().changeToken !== entry.token) changed();
    return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  } catch (error) { failure = error; throw error; }
  finally {
    const close: unknown[] = [];
    for (const entry of held.reverse()) { try { files.closeDirectory(entry.ref); } catch (error) { close.push(error); } }
    if (close.length) throw new AggregateError([...(failure === undefined ? [] : [failure]), ...close], 'windows_clone_close_failed');
  }
}
export function verifyWindowsCloneSkills(root: string, expected: AgentCloneEntry[]): void {
  if (expected.some(entry => entry.kind === 'file' && entry.executable)) fail('agent_clone_executable_unsupported');
  assertEntries(captureWindowsCloneSkills(root, true), expected);
}
export function copyWindowsCloneSkills(source: string, target: string, expected: AgentCloneEntry[], suppliedScope?: HostFileMutationScope): void {
  if (expected.some(entry => entry.kind === 'file' && entry.executable)) fail('agent_clone_executable_unsupported');
  const from = windowsProfilePath(source), to = windowsProfilePath(target, true);
  if (windowsProfileContains(from, to) || windowsProfileContains(to, from)) fail('agent_clone_path_overlap');
  if (JSON.stringify(captureWindowsCloneSkills(from)) !== JSON.stringify(expected)) fail('agent_clone_source_changed');
  const scope = suppliedScope ?? openProfileMutationScope(to, [from]);
  try {
    if (windowsPathInfo(to)) assertEntries(captureWindowsCloneSkills(to, true), expected, true);
    else { scope.directory(to, 'private', true); syncProfileDirectory(to, scope); }
    for (const entry of expected) {
      const destination = win32.join(to, ...entry.path.split('/'));
      if (entry.kind === 'directory') { scope.directory(destination, 'private', true); syncProfileDirectory(destination, scope); continue; }
      const bytes = readProfileBytes(win32.join(from, ...entry.path.split('/')), maximumBytes);
      if (!bytes || bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) fail('agent_clone_source_changed');
      const existing = readProfileBytes(destination, maximumBytes, true, scope);
      if (existing) {
        if (!existing.equals(bytes)) fail('agent_clone_target_conflict');
      } else publishProfileBytes(destination, bytes, false, scope);
      scope.check();
    }
    if (JSON.stringify(captureWindowsCloneSkills(from)) !== JSON.stringify(expected)) fail('agent_clone_source_changed');
    verifyWindowsCloneSkills(to, expected); scope.check();
  } finally { if (!suppliedScope) scope.close(); }
}
