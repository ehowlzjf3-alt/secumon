import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const [engine, root, scenario] = process.argv.slice(2);
const scenarios = ['normal', 'engine', 'root-parent-sync-failure', 'write-failure', 'file-sync-failure', 'link-after-failure', 'unlink-failure', 'directory-sync-failure',
  'swap-parent', 'swap-root', 'swap-metadata', 'kill-identity-synced', 'kill-config-linked', 'kill-receipt-linked'];
if (!engine || !root || !scenario || !scenarios.includes(scenario)) throw new Error('invalid_agent_setup_mutations_arguments');
const enginePath = engine; const rootPath = root; const scenarioName = scenario;
const parent = dirname(rootPath); const metadata = join(rootPath, '.secumon');
const original = {
  mkdir: fs.mkdirSync, open: fs.openSync, close: fs.closeSync, write: fs.writeFileSync, writeSync: fs.writeSync,
  sync: fs.fsyncSync, link: fs.linkSync, unlink: fs.unlinkSync, rename: fs.renameSync,
};
const descriptors = new Map<number, string>();
const publications = new Set<string>();
const events: Array<{ operation: string; path: string }> = [];
let active = false; let injections = 0;
let injected: NodeJS.ErrnoException | undefined;
let relocated: string | undefined; let foreign: string | undefined;
let originalBefore: ReturnType<typeof snapshot> | undefined; let foreignBefore: ReturnType<typeof snapshot> | undefined;
const blocked = new Int32Array(new SharedArrayBuffer(4));
function event(operation: string, path: string) { if (active) events.push({ operation, path }); }
function candidate(path: string) { return /^\.secumon-init-[a-f0-9-]+\.pending$/.test(basename(path)); }
function identityCandidate(path: string) {
  return candidate(path) && dirname(path) === metadata && publications.has('setup-operation.json') && !publications.has('identity.json');
}
function fail(syscall: string, path: string): never {
  injections++;
  injected = Object.assign(new Error(`synthetic_setup_${scenarioName}`), { code: 'EIO', syscall, path });
  event('injected', path); throw injected;
}
function pause(boundary: string): never {
  process.send!({ type: 'boundary', boundary });
  Atomics.wait(blocked, 0, 0);
  throw new Error('setup_kill_boundary_resumed_without_termination');
}
function snapshot(directory: string) {
  const entries: Array<{ path: string; kind: string; identity: string; mode: number; links: number; sha256?: string }> = [];
  const visit = (path: string, name: string) => {
    const stat = fs.lstatSync(path);
    const entry = { path: name, kind: stat.isDirectory() ? 'directory' : 'file', identity: `${stat.dev}:${stat.ino}`, mode: stat.mode & 0o777, links: stat.nlink };
    if (stat.isDirectory()) {
      entries.push(entry);
      for (const child of fs.readdirSync(path).sort()) visit(join(path, child), name ? `${name}/${child}` : child);
    } else if (stat.isFile()) entries.push({ ...entry, sha256: createHash('sha256').update(fs.readFileSync(path)).digest('hex') });
    else throw new Error('unexpected_setup_fixture_entry');
  };
  visit(directory, ''); return entries;
}
function substitute(candidatePath: string) {
  injections++;
  const source = scenarioName === 'swap-parent' ? parent : scenarioName === 'swap-root' ? rootPath : metadata;
  relocated = `${source}-original`;
  original.rename(source, relocated);
  original.mkdir(source, { mode: scenarioName === 'swap-parent' ? 0o755 : 0o700 });
  if (scenarioName === 'swap-parent') original.mkdir(rootPath, { mode: 0o700 });
  if (scenarioName !== 'swap-metadata') original.mkdir(metadata, { mode: 0o700 });
  original.write(join(source, 'foreign-sentinel.txt'), 'foreign directory must remain untouched', { mode: 0o600 });
  // Reuse the exact pending leaf so a path-only cleanup would delete foreign data.
  original.write(join(metadata, basename(candidatePath)), 'foreign candidate must remain untouched', { mode: 0o600 });
  original.write(join(metadata, 'identity.json'), 'foreign identity must remain untouched', { mode: 0o600 });
  foreign = source;
  originalBefore = snapshot(relocated); foreignBefore = snapshot(foreign);
  event('substituted', source);
}

// fs interception is confined to this process. Real operations are forwarded;
// the write fault performs a partial write, and the unlink fault deliberately
// leaves the candidate in place to model a failed removal.
Reflect.set(fs, 'mkdirSync', ((...args: unknown[]) => {
  const value = Reflect.apply(original.mkdir, fs, args); event('mkdir', String(args[0])); return value;
}) as typeof fs.mkdirSync);
Reflect.set(fs, 'openSync', ((...args: unknown[]) => {
  const fd = Reflect.apply(original.open, fs, args) as number; descriptors.set(fd, String(args[0])); event('open', String(args[0])); return fd;
}) as typeof fs.openSync);
fs.closeSync = (fd: number) => { try { original.close(fd); event('close', descriptors.get(fd) ?? 'unknown'); } finally { descriptors.delete(fd); } };
Reflect.set(fs, 'writeFileSync', ((...args: unknown[]) => {
  const path = typeof args[0] === 'number' ? descriptors.get(args[0]) : undefined;
  if (active && injections === 0 && scenarioName === 'write-failure' && path && identityCandidate(path)) {
    const bytes = Buffer.from(args[1] as Uint8Array);
    original.writeSync(args[0] as number, bytes.subarray(0, Math.min(12, bytes.length)));
    return fail('write', path);
  }
  const value = Reflect.apply(original.write, fs, args); if (path) event('write', path); return value;
}) as typeof fs.writeFileSync);
fs.fsyncSync = (fd: number) => {
  const path = descriptors.get(fd) ?? 'unknown'; original.sync(fd); event('fsync', path);
  if (!active || injections !== 0) return;
  if (scenarioName === 'root-parent-sync-failure' && path === parent && events.some(entry => entry.operation === 'mkdir' && entry.path === rootPath)) fail('fsync', path);
  if (identityCandidate(path)) {
    if (scenarioName === 'file-sync-failure') fail('fsync', path);
    if (scenarioName === 'kill-identity-synced') pause(scenarioName);
    if (scenarioName.startsWith('swap-')) substitute(path);
  }
  if (scenarioName === 'directory-sync-failure' && path === metadata && publications.has('identity.json')) fail('fsync', path);
};
fs.linkSync = (source, destination) => {
  original.link(source, destination);
  const target = String(destination); event('link', target);
  if (active) publications.add(basename(target));
  if (!active) return;
  if (injections === 0 && scenarioName === 'link-after-failure' && target === join(metadata, 'identity.json')) fail('link', target);
  if (scenarioName === 'kill-config-linked' && target === join(rootPath, 'config.json')) pause(scenarioName);
  if (scenarioName === 'kill-receipt-linked' && target === join(metadata, 'setup.json')) pause(scenarioName);
};
fs.unlinkSync = path => {
  const name = String(path); event('unlink-attempt', name);
  if (active && injections === 0 && scenarioName === 'unlink-failure' && candidate(name) && dirname(name) === metadata && publications.has('identity.json')) fail('unlink', name);
  original.unlink(path); event('unlinked', name);
};
syncBuiltinESMExports();
const { FileAgentProfileStore } = await import('../../infrastructure/file-agent-profile.js');
const { FileMutationFault } = await import('../../infrastructure/host-file-mutations.js');

function containsInjected(value: unknown, visited = new Set<unknown>()): boolean {
  if (injected && value === injected) return true;
  if (!value || typeof value !== 'object' || visited.has(value)) return false;
  visited.add(value);
  return Object.getOwnPropertyNames(value).some(key => containsInjected(Reflect.get(value, key), visited));
}
function findMutation(value: unknown): InstanceType<typeof FileMutationFault> | undefined {
  if (value instanceof FileMutationFault) return value;
  if (value instanceof Error) return findMutation(value.cause);
  return undefined;
}
function restore() {
  active = false;
  Reflect.set(fs, 'mkdirSync', original.mkdir); Reflect.set(fs, 'openSync', original.open); fs.closeSync = original.close;
  Reflect.set(fs, 'writeFileSync', original.write); fs.fsyncSync = original.sync; fs.linkSync = original.link; fs.unlinkSync = original.unlink;
  syncBuiltinESMExports();
}
function run() {
  let failure: unknown; let failed = false; let profile: ReturnType<InstanceType<typeof FileAgentProfileStore>['initialize']> | undefined;
  try {
    const profiles = new FileAgentProfileStore(enginePath);
    active = true; profile = profiles.initialize(rootPath, { name: 'mutation-fixture', purpose: 'synthetic setup failure boundaries' });
  } catch (error) { failed = true; failure = error; }
  finally { restore(); }
  const mutation = findMutation(failure);
  const error = failed ? {
    code: (failure as NodeJS.ErrnoException | undefined)?.code ?? null,
    message: failure instanceof Error ? failure.message : String(failure),
    stack: failure instanceof Error ? failure.stack : null,
    exactInjected: failure === injected,
    containsInjected: containsInjected(failure),
    mutation: mutation ? { operation: mutation.operation, stage: mutation.stage, status: mutation.status,
      causeIsInjected: mutation.cause === injected,
      primaryCauseContainsInjected: containsInjected(mutation.cause),
      errors: mutation.errors.map(entry => ({ stage: entry.stage, code: (entry.error as NodeJS.ErrnoException | undefined)?.code ?? null,
        sameInjected: entry.error === injected, containsInjected: containsInjected(entry.error) })) } : null,
  } : null;
  const result = { scenario: scenarioName, injections, openDescriptors: descriptors.size,
    profile: profile ? { status: profile.status, agentId: profile.identity.agentId } : null, error, events,
    replacement: relocated && foreign ? { relocated, foreign, originalBefore, originalAfter: snapshot(relocated), foreignBefore, foreignAfter: snapshot(foreign) } : null };
  if (scenarioName.startsWith('kill-')) {
    process.exitCode = 1;
    process.send!({ type: 'unexpected-completion', result }, () => process.disconnect());
  } else original.writeSync(1, JSON.stringify(result) + '\n');
}
if (scenarioName.startsWith('kill-')) {
  process.once('message', run);
  process.send!({ type: 'ready' });
} else run();
