import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundleAgentEngine, inspectEngineRelease, installAgentEngine, readAgentEnginePin } from '../infrastructure/agent-engine-release.js';
import { registerAgentEngine, resolveAgentEngine } from '../infrastructure/agent-engine-registry.js';
import { publishAgentEnginePin } from '../infrastructure/agent-lifecycle.js';
import { captureLifecycleTree, copyLifecycleTree } from '../infrastructure/agent-lifecycle-files.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { hostMetadataFiles, releaseMetadataDirectory } from '../infrastructure/host-metadata-files.js';

const posix = { skip: process.platform === 'win32' ? 'POSIX metadata fixture; native Windows installation and registry behavior are verified separately.' : false };
const execute = promisify(execFile);
const bootstrap = fileURLToPath(new URL('../presentation/agent-cli.js', import.meta.url));
const preloader = fileURLToPath(new URL('./helpers/agent-installation-home.js', import.meta.url));
function json(path: string, value: unknown) { writeFileSync(path, JSON.stringify(value) + '\n', { mode: 0o600 }); }
function identity(path: string) {
  const files = hostMetadataFiles(), reference = files.inspectDirectory(path, 'owner-writable'); assert.ok(reference);
  try { return { ...reference.identity }; } finally { releaseMetadataDirectory(files, reference); }
}
function fixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'engine-registry-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const source = join(base, 'metadata-source'), current = join(base, 'bootstrap'), registryDirectory = join(base, 'registry');
  mkdirSync(current, { mode: 0o700 }); mkdirSync(source, { mode: 0o700 });
  for (const path of ['dist', 'dist/presentation', 'node_modules', 'node_modules/zod']) mkdirSync(join(source, path), { mode: 0o700 });
  // A small metadata-only release produced by the real bundler. Its candidate CLI/dependencies are never executed.
  // Actual runnable A/B releases and work resumption are covered by agent-engine-launcher.test.ts.
  json(join(source, 'package.json'), { name: 'long-horizon-runtime', version: '0.0.1-registry-fixture', type: 'module', engines: { node: '>=24.20.0 <25' } });
  json(join(source, 'node_modules/zod/package.json'), { name: 'zod', version: '0.0.0-registry-fixture' });
  writeFileSync(join(source, 'dist/presentation/agent-cli.js'), 'throw new Error("metadata_fixture_must_not_execute");\n', { mode: 0o600 });
  const bundle = bundleAgentEngine(source, join(base, 'bundle'));
  const installed = installAgentEngine(bundle.directory, join(base, 'installed'), bundle.release.digest);
  const profiles = new FileAgentProfileStore(current), profile = profiles.initialize(join(base, 'agent'), { name: '등록 경계 담당' });
  writeFileSync(join(profile.root, 'original.md'), 'Original profile content retained by registry checks.\n', { mode: 0o600 });
  const options = { registryDirectory };
  const pin = () => publishAgentEnginePin(profile, installed.directory, installed.release, null, null);
  const register = () => registerAgentEngine(installed.directory, installed.release.digest, options);
  const resolve = () => resolveAgentEngine(profile.root, current, options);
  const record = () => {
    const names = readdirSync(registryDirectory); assert.equal(names.length, 1);
    return join(registryDirectory, names[0]!);
  };
  return { base, current, bundle, installed, profiles, profile, options, registryDirectory, pin, register, resolve, record };
}
function preserves(root: string, action: () => unknown, error: RegExp) {
  const before = captureLifecycleTree(root); assert.throws(action, error); assert.deepEqual(captureLifecycleTree(root), before);
}
function cli(f: ReturnType<typeof fixture>) {
  const home = join(f.base, 'home'), temporary = join(f.base, 'tmp');
  mkdirSync(home, { mode: 0o700 }); mkdirSync(temporary, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: temporary, LANG: 'C.UTF-8',
    NODE_OPTIONS: `--import=${pathToFileURL(preloader).href}`, SECUMON_INSTALLATION_HOME: home };
  const command = (args: string[]) => execute(process.execPath, [bootstrap, 'lifecycle', ...args, '--json'],
    { cwd: f.base, env, timeout: 20000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
  const result = async <T>(args: string[]): Promise<T> => JSON.parse((await command(args)).stdout) as T;
  return { home, registryDirectory: join(home, '.secumon', 'engines'), command, result };
}

test('explicit engine registration is idempotent and rejects wrong digests or overlapping registry paths without writes', posix, t => {
  const f = fixture(t);
  for (const digest of ['invalid', '0'.repeat(64)]) preserves(f.base,
    () => registerAgentEngine(f.installed.directory, digest, f.options), /^Error: engine_release_digest_mismatch$/);
  for (const registryDirectory of [f.installed.directory, join(f.installed.directory, 'registry'), f.base]) preserves(f.base,
    () => registerAgentEngine(f.installed.directory, f.installed.release.digest, { registryDirectory }), /^Error: lifecycle_directory_overlap$/);
  preserves(f.base, () => registerAgentEngine(f.installed.directory, f.installed.release.digest,
    { registryDirectory: join(f.base, 'absent-parent', 'registry') }), /^Error: engine_registry_parent_missing$/);
  const first = f.register(); assert.equal(first.published, true);
  assert.equal(first.registration.directory, f.installed.directory); assert.equal(first.registration.releaseDigest, f.installed.release.digest);
  assert.deepEqual(first.registration.directoryIdentity, identity(f.installed.directory));
  const before = captureLifecycleTree(f.base), repeat = f.register();
  assert.equal(repeat.published, false); assert.deepEqual(repeat.registration, first.registration);
  assert.deepEqual(captureLifecycleTree(f.base), before); assert.equal(readdirSync(f.registryDirectory).length, 1);
  f.pin();
  for (const registryDirectory of [f.profile.root, f.current]) preserves(f.base,
    () => resolveAgentEngine(f.profile.root, f.current, { registryDirectory }), /^Error: lifecycle_directory_overlap$/);
});

test('a pin selects its exact installation path and never borrows another same-byte directory registration', posix, t => {
  const f = fixture(t), other = f.profiles.initialize(join(f.base, 'other-agent'), { name: '다른 담당' });
  assert.deepEqual(f.resolve(), { directory: f.current, source: 'current', releaseDigest: null });
  const another = installAgentEngine(f.bundle.directory, join(f.base, 'another-installation'), f.bundle.release.digest);
  f.pin(); publishAgentEnginePin(other, another.directory, another.release, null, null); f.register();
  assert.equal(f.resolve().directory, f.installed.directory);
  preserves(f.base, () => resolveAgentEngine(other.root, f.current, f.options), /^Error: engine_installation_unregistered$/);
  registerAgentEngine(another.directory, another.release.digest, f.options);
  assert.deepEqual(resolveAgentEngine(other.root, f.current, f.options), { directory: another.directory, source: 'registered', releaseDigest: another.release.digest });
  assert.notEqual(readAgentEnginePin(other.root)?.agentId, readAgentEnginePin(f.profile.root)?.agentId);
  const held = join(f.base, 'missing-installation-preserved'); renameSync(another.directory, held);
  preserves(f.base, () => resolveAgentEngine(other.root, f.current, f.options), /^Error: engine_installation_missing$/);
  assert.equal(inspectEngineRelease(held).digest, another.release.digest);
  assert.equal(f.resolve().directory, f.installed.directory, 'another agent missing installation does not change this agent selection');
});

test('same-byte installation directory replacement is rejected without replacing the original registration', posix, t => {
  const f = fixture(t); f.pin(); f.register();
  const originalIdentity = identity(f.installed.directory), entries = captureLifecycleTree(f.installed.directory);
  const record = readFileSync(f.record()), held = join(f.base, 'original-installation');
  renameSync(f.installed.directory, held); mkdirSync(f.installed.directory, { mode: 0o700 });
  copyLifecycleTree(held, f.installed.directory, entries);
  assert.deepEqual(captureLifecycleTree(f.installed.directory), entries); assert.deepEqual(captureLifecycleTree(held), entries);
  assert.notDeepEqual(identity(f.installed.directory), originalIdentity); assert.equal(inspectEngineRelease(f.installed.directory).digest, f.installed.release.digest);
  preserves(f.base, f.resolve, /^Error: engine_installation_changed$/);
  preserves(f.base, f.register, /^Error: engine_installation_conflict$/);
  assert.deepEqual(readFileSync(f.record()), record);
});

test('selection preserves and rejects foreign pin owners, broken history, and nested agent paths', posix, t => {
  const f = fixture(t), other = f.profiles.initialize(join(f.base, 'other-agent'));
  const first = f.pin(); f.register();
  const firstPath = join(f.profile.paths.metadata, 'engine-pins', '00000001.json'), original = readFileSync(firstPath);
  try {
    json(firstPath, { ...first, agentId: other.identity.agentId });
    preserves(f.base, f.resolve, /^Error: engine_pin_owner_mismatch$/);
  } finally { writeFileSync(firstPath, original, { mode: 0o600 }); }
  const second = publishAgentEnginePin(f.profile, f.installed.directory, f.installed.release, first, null);
  const secondPath = join(f.profile.paths.metadata, 'engine-pins', '00000002.json'), secondBytes = readFileSync(secondPath);
  try {
    json(secondPath, { ...second, previous: '0'.repeat(64) });
    preserves(f.base, f.resolve, /^Error: engine_pin_history_invalid$/);
  } finally { writeFileSync(secondPath, secondBytes, { mode: 0o600 }); }
  const nested = join(other.root, 'nested'); mkdirSync(nested, { mode: 0o700 });
  preserves(f.base, () => resolveAgentEngine(nested, f.current, f.options), /^Error: agent_nested_workspace$/);
  assert.equal(f.resolve().releaseDigest, first.releaseDigest); assert.deepEqual(readAgentEnginePin(f.profile.root), second);
});

test('a changed registry record is rejected on resolve and is not silently repaired by register', posix, t => {
  const f = fixture(t); f.pin(); const registered = f.register(), path = f.record(), original = readFileSync(path);
  try {
    json(path, { ...registered.registration, version: '0.0.2-changed-record' });
    preserves(f.base, f.resolve, /^Error: engine_installation_changed$/);
    preserves(f.base, f.register, /^Error: engine_installation_conflict$/);
    json(path, { ...registered.registration, unexpected: true });
    preserves(f.base, f.resolve, /^Error: agent_metadata_invalid$/);
  } finally { writeFileSync(path, original, { mode: 0o600 }); }
  assert.equal(f.resolve().source, 'registered'); assert.equal(f.register().published, false);
});

test('selection rechecks the original registration after the actual release read and refuses a mid-read record change', posix, t => {
  const f = fixture(t); f.pin(); const registered = f.register(), path = f.record();
  const recordName = readdirSync(f.registryDirectory)[0]!;
  const agentBefore = captureLifecycleTree(f.profile.root), engineBefore = captureLifecycleTree(f.installed.directory);
  const changed = { ...registered.registration, version: '0.0.2-withdrawn-during-release-read' };
  const files = hostMetadataFiles(), original = files.readStableRegularFile, order: string[] = [];
  let mutations = 0, releaseReads = 0;
  try {
    files.readStableRegularFile = function (directory, leaf, policy) {
      if (leaf === recordName) order.push('registration:read');
      if (leaf === 'release.json') {
        releaseReads += 1;
        assert.ok(order.includes('registration:read'), 'the original registration was actually read before release verification');
        if (mutations === 0) { json(path, changed); mutations += 1; order.push('registration:changed'); }
      }
      const bytes = original.call(this, directory, leaf, policy);
      if (leaf === 'release.json') order.push('release:read');
      return bytes;
    };
    assert.throws(f.resolve, /^Error: engine_installation_changed$/);
  } finally { files.readStableRegularFile = original; }
  assert.equal(files.readStableRegularFile, original); assert.equal(mutations, 1); assert.equal(releaseReads, 1);
  assert.ok(order.indexOf('registration:read') < order.indexOf('registration:changed'));
  assert.ok(order.indexOf('registration:changed') < order.indexOf('release:read'));
  assert.ok(order.lastIndexOf('registration:read') > order.indexOf('release:read'), 'the original record is re-read after release bytes');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), changed, 'selection does not repair the changed registry record');
  assert.deepEqual(captureLifecycleTree(f.profile.root), agentBefore); assert.deepEqual(captureLifecycleTree(f.installed.directory), engineBefore);
});

test('the actual lifecycle CLI installs and automatically registers a metadata release in an isolated host registry', { ...posix, timeout: 60000 }, async t => {
  const f = fixture(t), c = cli(f), destination = join(f.base, 'cli-installation');
  const sourceBefore = captureLifecycleTree(f.bundle.directory), agentBefore = captureLifecycleTree(f.profile.root);
  const installed = await c.result<{ directory: string; registryDirectory: string; published: boolean; registration: { directory: string; releaseDigest: string } }>(
    ['install', '--source', f.bundle.directory, '--destination', destination, '--digest', f.bundle.release.digest]);
  assert.equal(installed.directory, destination); assert.equal(installed.registryDirectory, c.registryDirectory); assert.equal(installed.published, true);
  assert.equal(installed.registration.directory, destination); assert.equal(installed.registration.releaseDigest, f.bundle.release.digest);
  const release = inspectEngineRelease(destination); publishAgentEnginePin(f.profile, destination, release, null, null);
  assert.equal(resolveAgentEngine(f.profile.root, f.current, { registryDirectory: c.registryDirectory }).directory, destination);
  const installationBefore = captureLifecycleTree(destination), registryBefore = captureLifecycleTree(c.home);
  const again = await c.result<{ published: boolean }>(['register', '--engine', destination, '--digest', release.digest]);
  assert.equal(again.published, false); assert.deepEqual(captureLifecycleTree(destination), installationBefore); assert.deepEqual(captureLifecycleTree(c.home), registryBefore);
  assert.deepEqual(captureLifecycleTree(f.bundle.directory), sourceBefore);
  assert.deepEqual(captureLifecycleTree(f.profile.root, path => path !== '.secumon/engine-pins' && !path.startsWith('.secumon/engine-pins/')), agentBefore);
});

test('registration failure after CLI installation preserves the installation for explicit registration without reinstalling', { ...posix, timeout: 60000 }, async t => {
  const f = fixture(t), c = cli(f), destination = join(f.base, 'cli-installation');
  mkdirSync(join(c.home, '.secumon'), { mode: 0o700 });
  const obstruction = Buffer.from('Existing unrelated host file; do not remove or overwrite.\n');
  writeFileSync(c.registryDirectory, obstruction, { mode: 0o600 });
  const sourceBefore = captureLifecycleTree(f.bundle.directory), agentBefore = captureLifecycleTree(f.profile.root);
  await assert.rejects(c.command(['install', '--source', f.bundle.directory, '--destination', destination, '--digest', f.bundle.release.digest]), error => {
    const result = error as Error & { code?: unknown; stderr?: string; stdout?: string };
    assert.equal(result.code, 1); assert.equal(result.stderr?.trim(), 'agent_directory_unsafe'); assert.equal(result.stdout?.trim(), ''); return true;
  });
  assert.deepEqual(readFileSync(c.registryDirectory), obstruction);
  assert.equal(inspectEngineRelease(destination).digest, f.bundle.release.digest, 'install completed before registry failure');
  const installedBefore = captureLifecycleTree(destination), installedIdentity = identity(destination);
  const retained = join(c.home, '.secumon', 'engines-original-file'); renameSync(c.registryDirectory, retained);
  const registered = await c.result<{ published: boolean; registryDirectory: string }>(['register', '--engine', destination, '--digest', f.bundle.release.digest]);
  assert.equal(registered.published, true); assert.equal(registered.registryDirectory, c.registryDirectory);
  assert.deepEqual(captureLifecycleTree(destination), installedBefore); assert.deepEqual(identity(destination), installedIdentity);
  assert.deepEqual(readFileSync(retained), obstruction); assert.deepEqual(captureLifecycleTree(f.bundle.directory), sourceBefore);
  assert.deepEqual(captureLifecycleTree(f.profile.root), agentBefore);
  publishAgentEnginePin(f.profile, destination, inspectEngineRelease(destination), null, null);
  assert.equal(resolveAgentEngine(f.profile.root, f.current, { registryDirectory: c.registryDirectory }).source, 'registered');
});
