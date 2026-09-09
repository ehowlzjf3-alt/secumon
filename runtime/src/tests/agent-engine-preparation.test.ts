import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareAgentEngine } from '../infrastructure/agent-engine-preparation.js';
import { inspectAgentEngineBuild, inspectEngineRelease } from '../infrastructure/agent-engine-release.js';
import { captureLifecycleTree, lifecycleDigest } from '../infrastructure/agent-lifecycle-files.js';
import { hostMetadataFiles, releaseMetadataDirectory } from '../infrastructure/host-metadata-files.js';
import type { PreparationBoundary, PreparationStage } from './helpers/agent-engine-preparation-worker.js';
import { copyAgentEngineNativeFixture } from './helpers/agent-engine-native-fixture.js';

const runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
const worker = fileURLToPath(new URL('./helpers/agent-engine-preparation-worker.js', import.meta.url));
const posix = { skip: process.platform === 'win32' ? 'POSIX metadata/process fixture; this does not establish native Windows or Linux execution.' : false };
const json = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value) + '\n', { mode: 0o600 });
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Prepared = ReturnType<typeof prepareAgentEngine>;
type Selection = { schemaVersion: 1; kind: 'prepared-agent-engine'; releaseDigest: string; attemptId: string; registrationDigest: string };
function directoryIdentity(path: string) {
  const files = hostMetadataFiles(), reference = files.inspectDirectory(path, 'owner-writable'); assert.ok(reference);
  try { return { ...reference.identity }; } finally { releaseMetadataDirectory(files, reference); }
}
function fixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'engine-preparation-'))); t.after(() => rmSync(base, { recursive: true, force: true }));
  const source = join(base, 'source'), agent = join(base, 'agent'), preparationDirectory = join(base, 'prepared'), registryDirectory = join(base, 'registry');
  for (const path of [source, agent]) mkdirSync(path, { mode: 0o700 });
  for (const path of ['dist', 'dist/presentation', 'node_modules', 'node_modules/zod']) mkdirSync(join(source, path), { mode: 0o700 });
  const zod = JSON.parse(readFileSync(join(runtimeRoot, 'node_modules/zod/package.json'), 'utf8')) as { version: string };
  assert.equal(typeof zod.version, 'string');
  json(join(source, 'package.json'), { name: 'long-horizon-runtime', version: '0.0.1-preparation-fixture', type: 'module',
    engines: { node: '>=24.20.0 <25' }, dependencies: { zod: zod.version } });
  writeFileSync(join(source, 'node_modules/zod/package.json'), readFileSync(join(runtimeRoot, 'node_modules/zod/package.json')), { mode: 0o600 });
  // Real bundle/install/registry metadata acceptance. This deliberately incomplete CLI/dependency fixture is never executed.
  writeFileSync(join(source, 'dist/presentation/agent-cli.js'), 'throw new Error("preparation_metadata_fixture_must_not_execute");\n', { mode: 0o600 });
  copyAgentEngineNativeFixture(source);
  writeFileSync(join(source, 'operator-note.md'), 'Source files remain in their original checkout.\n', { mode: 0o600 });
  writeFileSync(join(agent, 'operator-note.md'), 'Preparation must not initialize or pin this agent.\n', { mode: 0o600 });
  const options = { preparationDirectory, registryDirectory }, prepare = (root = agent) => prepareAgentEngine(source, root, options);
  return { base, source, agent, preparationDirectory, registryDirectory, options, prepare };
}
function selection(f: ReturnType<typeof fixture>, prepared: Prepared) {
  const folder = join(f.preparationDirectory, prepared.releaseDigest), path = join(folder, 'selected.json');
  const selected = JSON.parse(readFileSync(path, 'utf8')) as Selection;
  assert.deepEqual(Object.keys(selected).sort(), ['attemptId', 'kind', 'registrationDigest', 'releaseDigest', 'schemaVersion']);
  assert.equal(selected.schemaVersion, 1); assert.equal(selected.kind, 'prepared-agent-engine'); assert.equal(selected.releaseDigest, prepared.releaseDigest);
  assert.match(selected.attemptId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/); assert.match(selected.registrationDigest, /^[a-f0-9]{64}$/);
  assert.equal(prepared.directory, join(folder, selected.attemptId, 'engine')); assert.equal(prepared.preparationDirectory, f.preparationDirectory);
  assert.equal(inspectEngineRelease(prepared.directory).digest, prepared.releaseDigest);
  const registrations = readdirSync(f.registryDirectory).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(f.registryDirectory, name), 'utf8')) as Record<string, unknown>);
  const registration = registrations.find(value => value['directory'] === prepared.directory && value['releaseDigest'] === prepared.releaseDigest); assert.ok(registration);
  assert.equal(lifecycleDigest(registration), selected.registrationDigest); assert.deepEqual(registration['directoryIdentity'], directoryIdentity(prepared.directory));
  return { folder, path, selected, registration };
}
function attempts(folder: string) {
  return readdirSync(folder).filter(name => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(name)).sort();
}
function start(f: ReturnType<typeof fixture>, phase: 'partial' | 'linked' | 'race', gates: string) {
  const child = fork(worker, [f.source, f.agent, f.preparationDirectory, f.registryDirectory, phase, gates], { cwd: f.base, execArgv: [],
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: f.base, LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const waiting = new Map<PreparationStage, { resolve(value: PreparationBoundary): void; reject(error: unknown): void; promise: Promise<PreparationBoundary> }>();
  for (const stage of ['engine-before-manifest', 'engine-after-manifest', 'selector-before-link'] as const) {
    let resolve!: (value: PreparationBoundary) => void, reject!: (error: unknown) => void;
    const promise = new Promise<PreparationBoundary>((yes, no) => { resolve = yes; reject = no; }); void promise.catch(() => {});
    waiting.set(stage, { resolve, reject, promise });
  }
  let output = '', errors = '', failure: unknown, exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const observed = new Set<PreparationStage>();
  const kill = (error: unknown) => { failure ??= error; for (const pending of waiting.values()) pending.reject(error); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); };
  const timer = setTimeout(() => kill(new Error('preparation_worker_deadline')), 50000);
  child.stdout!.on('data', (bytes: Buffer) => { output += bytes.toString('utf8'); if (Buffer.byteLength(output) > 65536) kill(new Error('preparation_worker_output_limit')); });
  child.stderr!.on('data', (bytes: Buffer) => { errors += bytes.toString('utf8'); if (Buffer.byteLength(errors) > 65536) kill(new Error('preparation_worker_error_limit')); });
  child.on('message', raw => {
    try {
      assert.ok(Buffer.byteLength(JSON.stringify(raw)) <= 256 * 1024);
      const value = raw as PreparationBoundary; assert.equal(value.type, 'engine-preparation-boundary'); assert.equal(value.pid, child.pid);
      assert.ok(waiting.has(value.stage)); assert.equal(observed.has(value.stage), false); observed.add(value.stage);
      assert.ok(value.source.startsWith(f.preparationDirectory + '/') && value.target.startsWith(f.preparationDirectory + '/'));
      const bytes = readFileSync(value.source); assert.equal(bytes.toString('base64'), value.candidate.base64); assert.equal(sha(bytes), value.candidate.sha256);
      const stat = lstatSync(value.source), links = value.stage === 'engine-after-manifest' ? 2 : 1;
      assert.equal(`${stat.dev}:${stat.ino}`, value.candidate.identity); assert.equal(stat.nlink, links); assert.equal(value.candidate.links, links);
      waiting.get(value.stage)!.resolve(value);
    } catch (error) { kill(error); }
  });
  child.once('error', kill); child.once('exit', (code, signal) => { exit = { code, signal }; });
  const terminal = new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string; errors: string }>((resolve, reject) => {
    child.once('close', (code, signal) => {
      clearTimeout(timer); for (const pending of waiting.values()) pending.reject(new Error(`preparation_worker_closed:${code}:${signal}:${output}:${errors}`));
      if (failure) { reject(failure); return; }
      try { assert.deepEqual(exit, { code, signal }, 'actual exit and close must both be observed'); resolve({ code, signal, output, errors }); }
      catch (error) { reject(error); }
    });
  }); void terminal.catch(() => {});
  return { child, terminal, boundary: (stage: PreparationStage) => waiting.get(stage)!.promise,
    async close() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await terminal; } };
}

test('preparation creates a real verified bundle, installation and selector without changing source or agent files', posix, t => {
  const f = fixture(t), source = captureLifecycleTree(f.source), agent = captureLifecycleTree(f.agent), release = inspectAgentEngineBuild(f.source);
  const result = f.prepare(); assert.equal(result.source, 'prepared'); assert.equal(result.releaseDigest, release.digest);
  const saved = selection(f, result); assert.equal(inspectEngineRelease(join(saved.folder, saved.selected.attemptId, 'bundle')).digest, release.digest);
  assert.deepEqual(captureLifecycleTree(f.source), source); assert.deepEqual(captureLifecycleTree(f.agent), agent);
  assert.equal(existsSync(join(f.source, 'release.json')), false); assert.equal(existsSync(join(f.agent, '.secumon')), false);
});

test('two agents reuse the identical prepared source installation and its original selector and registration', posix, t => {
  const f = fixture(t), other = join(f.base, 'other-agent'); mkdirSync(other, { mode: 0o700 });
  writeFileSync(join(other, 'operator-note.md'), 'Second agent remains independent.\n', { mode: 0o600 });
  const first = f.prepare(), saved = selection(f, first), identity = directoryIdentity(first.directory), before = captureLifecycleTree(f.base);
  const second = f.prepare(other); assert.equal(second.source, 'reused'); assert.equal(second.directory, first.directory); assert.equal(second.releaseDigest, first.releaseDigest);
  assert.deepEqual(directoryIdentity(second.directory), identity); assert.deepEqual(selection(f, second), saved); assert.deepEqual(captureLifecycleTree(f.base), before);
});

test('changing actual source executable bytes prepares a new digest while preserving the prior selected installation', posix, t => {
  const f = fixture(t), first = f.prepare(), saved = selection(f, first), original = captureLifecycleTree(saved.folder), registry = captureLifecycleTree(f.registryDirectory);
  writeFileSync(join(f.source, 'dist/presentation/agent-cli.js'), 'throw new Error("changed_preparation_metadata_fixture_must_not_execute");\n', { mode: 0o600 });
  const changedSource = captureLifecycleTree(f.source), agent = captureLifecycleTree(f.agent), second = f.prepare();
  assert.equal(second.source, 'prepared'); assert.notEqual(second.releaseDigest, first.releaseDigest); assert.notEqual(second.directory, first.directory);
  assert.equal(second.releaseDigest, inspectAgentEngineBuild(f.source).digest); selection(f, second);
  assert.deepEqual(captureLifecycleTree(saved.folder), original);
  for (const entry of registry) assert.deepEqual(captureLifecycleTree(f.registryDirectory).find(value => value.path === entry.path), entry);
  assert.deepEqual(captureLifecycleTree(f.source), changedSource); assert.deepEqual(captureLifecycleTree(f.agent), agent);
});

test('a selected missing or corrupted engine is rejected without selecting a substitute or rewriting the selector', posix, t => {
  const f = fixture(t), first = f.prepare(), saved = selection(f, first), bytes = readFileSync(saved.path), held = join(f.base, 'retained-engine');
  renameSync(first.directory, held);
  const missing = captureLifecycleTree(f.base); assert.throws(f.prepare, /^Error: engine_preparation_installation_missing$/);
  assert.deepEqual(captureLifecycleTree(f.base), missing); assert.deepEqual(readFileSync(saved.path), bytes); renameSync(held, first.directory);
  const changedPath = join(first.directory, 'dist/presentation/agent-cli.js'); writeFileSync(changedPath, 'modified installed code\n', { mode: 0o600 });
  const corrupted = captureLifecycleTree(f.base); assert.throws(f.prepare, /^Error: engine_release_(files_changed|digest_mismatch)$/);
  assert.deepEqual(captureLifecycleTree(f.base), corrupted); assert.deepEqual(readFileSync(saved.path), bytes);
  json(saved.path, { ...saved.selected, extra: 'not a supported selector field' }); const changedSelector = captureLifecycleTree(f.base);
  assert.throws(f.prepare, /^Error: (agent_metadata_invalid|engine_preparation_invalid)$/); assert.deepEqual(captureLifecycleTree(f.base), changedSelector);
});

test('registry failure preserves the actual complete installation and retry registers that same engine without reinstalling', posix, t => {
  const f = fixture(t), obstruction = Buffer.from('Unrelated original registry-path file.\n'); writeFileSync(f.registryDirectory, obstruction, { mode: 0o600 });
  const source = captureLifecycleTree(f.source), agent = captureLifecycleTree(f.agent), digest = inspectAgentEngineBuild(f.source).digest;
  assert.throws(f.prepare, /^Error: agent_directory_unsafe$/);
  const folder = join(f.preparationDirectory, digest), originalAttempts = attempts(folder); assert.equal(originalAttempts.length, 1); assert.equal(existsSync(join(folder, 'selected.json')), false);
  const engine = join(folder, originalAttempts[0]!, 'engine'); assert.equal(inspectEngineRelease(engine).digest, digest);
  const original = captureLifecycleTree(engine), identity = directoryIdentity(engine); assert.deepEqual(readFileSync(f.registryDirectory), obstruction);
  const retained = join(f.base, 'retained-registry-file'); renameSync(f.registryDirectory, retained);
  const result = f.prepare(); assert.equal(result.source, 'reused'); assert.equal(result.directory, engine); selection(f, result);
  assert.deepEqual(attempts(folder), originalAttempts); assert.deepEqual(captureLifecycleTree(engine), original); assert.deepEqual(directoryIdentity(engine), identity);
  assert.deepEqual(readFileSync(retained), obstruction); assert.deepEqual(captureLifecycleTree(f.source), source); assert.deepEqual(captureLifecycleTree(f.agent), agent);
});

test('SIGKILL before the installed manifest publication retains the partial attempt and a later preparation uses a new attempt', { ...posix, timeout: 70000 }, async t => {
  const f = fixture(t), gates = join(f.base, 'gates'); mkdirSync(gates, { mode: 0o700 });
  const source = captureLifecycleTree(f.source), agent = captureLifecycleTree(f.agent), child = start(f, 'partial', gates);
  try {
    const observed = await child.boundary('engine-before-manifest'), engine = dirname(observed.target), partial = dirname(engine);
    assert.equal(existsSync(observed.target), false); assert.equal(existsSync(join(dirname(partial), 'selected.json')), false);
    assert.equal(child.child.kill('SIGKILL'), true); const stopped = await child.terminal;
    assert.equal(stopped.code, null); assert.equal(stopped.signal, 'SIGKILL'); assert.equal(stopped.output, ''); assert.equal(stopped.errors, '');
    const retained = captureLifecycleTree(partial), candidate = readFileSync(observed.source), identity = directoryIdentity(engine);
    const result = f.prepare(); assert.equal(result.source, 'prepared'); assert.notEqual(result.directory, engine); selection(f, result);
    assert.deepEqual(captureLifecycleTree(partial), retained); assert.deepEqual(readFileSync(observed.source), candidate); assert.deepEqual(directoryIdentity(engine), identity);
    assert.equal(existsSync(observed.target), false); assert.deepEqual(captureLifecycleTree(f.source), source); assert.deepEqual(captureLifecycleTree(f.agent), agent);
  } finally { await child.close(); }
});

test('SIGKILL after the installed manifest link preserves both original hardlinks and retry selects a new completed attempt', { ...posix, timeout: 70000 }, async t => {
  const f = fixture(t), gates = join(f.base, 'gates'); mkdirSync(gates, { mode: 0o700 });
  const source = captureLifecycleTree(f.source), agent = captureLifecycleTree(f.agent), child = start(f, 'linked', gates);
  try {
    const observed = await child.boundary('engine-after-manifest'), engine = dirname(observed.target), partial = dirname(engine);
    assert.equal(existsSync(observed.target), true); assert.equal(existsSync(join(dirname(partial), 'selected.json')), false);
    const raw = (path: string) => {
      const stat = lstatSync(path); assert.ok(stat.isFile() && !stat.isSymbolicLink());
      return { bytes: readFileSync(path), identity: `${stat.dev}:${stat.ino}`, links: stat.nlink, mode: stat.mode & 0o777 };
    };
    const pending = raw(observed.source), manifest = raw(observed.target);
    assert.equal(pending.links, 2); assert.equal(manifest.links, 2); assert.equal(pending.identity, manifest.identity);
    assert.deepEqual(pending.bytes, manifest.bytes); assert.equal(manifest.bytes.toString('base64'), observed.candidate.base64);
    assert.equal(sha(manifest.bytes), observed.candidate.sha256);
    assert.equal(child.child.kill('SIGKILL'), true); const stopped = await child.terminal;
    assert.equal(stopped.code, null); assert.equal(stopped.signal, 'SIGKILL'); assert.equal(stopped.output, ''); assert.equal(stopped.errors, '');
    // General lifecycle capture correctly rejects linked files; inspect just these two exact originals separately.
    const remaining = () => captureLifecycleTree(partial, path => path !== 'engine/release.json' && path !== `engine/${basename(observed.source)}`);
    const retained = remaining(), identity = directoryIdentity(engine);
    assert.deepEqual(raw(observed.source), pending); assert.deepEqual(raw(observed.target), manifest);
    const result = f.prepare(); assert.equal(result.source, 'prepared'); assert.notEqual(result.directory, engine); selection(f, result);
    assert.deepEqual(raw(observed.source), pending); assert.deepEqual(raw(observed.target), manifest);
    assert.deepEqual(remaining(), retained); assert.deepEqual(directoryIdentity(engine), identity);
    assert.deepEqual(captureLifecycleTree(f.source), source); assert.deepEqual(captureLifecycleTree(f.agent), agent);
  } finally { await child.close(); }
});

test('two real preparing processes publish competing complete candidates but converge on one original no-replace selector', { ...posix, timeout: 90000 }, async t => {
  const f = fixture(t), gates = join(f.base, 'gates'); mkdirSync(gates, { mode: 0o700 });
  const source = captureLifecycleTree(f.source), agent = captureLifecycleTree(f.agent), left = start(f, 'race', gates), right = start(f, 'race', gates);
  try {
    const engines = await Promise.all([left.boundary('engine-before-manifest'), right.boundary('engine-before-manifest')]);
    assert.notEqual(engines[0]!.target, engines[1]!.target); assert.ok(engines.every(value => !existsSync(value.target)));
    writeFileSync(join(gates, 'engine-before-manifest'), 'publish both original manifests\n', { flag: 'wx', mode: 0o600 });
    const candidates = await Promise.all([left.boundary('selector-before-link'), right.boundary('selector-before-link')]);
    assert.equal(candidates[0]!.target, candidates[1]!.target); assert.equal(existsSync(candidates[0]!.target), false);
    const proposed = candidates.map(value => JSON.parse(Buffer.from(value.candidate.base64, 'base64').toString('utf8')) as Selection);
    assert.notEqual(proposed[0]!.attemptId, proposed[1]!.attemptId);
    const originals = engines.map(value => ({ root: dirname(value.target), tree: captureLifecycleTree(dirname(value.target)), identity: directoryIdentity(dirname(value.target)) }));
    writeFileSync(join(gates, 'selector-before-link'), 'publish one original selector\n', { flag: 'wx', mode: 0o600 });
    const results = await Promise.all([left.terminal, right.terminal]);
    for (const result of results) { assert.equal(result.code, 0, result.output); assert.equal(result.signal, null); assert.equal(result.errors, ''); }
    const outputs = results.map(value => JSON.parse(value.output) as Prepared); assert.equal(outputs[0]!.directory, outputs[1]!.directory); assert.equal(outputs[0]!.releaseDigest, outputs[1]!.releaseDigest);
    const saved = selection(f, outputs[0]!); assert.ok(proposed.some(value => lifecycleDigest(value) === lifecycleDigest(saved.selected)));
    assert.equal(candidates.some(value => value.candidate.base64 === readFileSync(saved.path).toString('base64')), true);
    for (const original of originals) { assert.deepEqual(captureLifecycleTree(original.root), original.tree); assert.deepEqual(directoryIdentity(original.root), original.identity); }
    const before = captureLifecycleTree(f.base), reused = f.prepare(); assert.equal(reused.source, 'reused'); assert.equal(reused.directory, outputs[0]!.directory);
    assert.deepEqual(captureLifecycleTree(f.base), before); assert.deepEqual(captureLifecycleTree(f.source), source); assert.deepEqual(captureLifecycleTree(f.agent), agent);
  } finally { await Promise.allSettled([left.close(), right.close()]); }
});
