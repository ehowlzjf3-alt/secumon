import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AgentIdentity } from '../application/agent-profile-contracts.js';
import type { EnginePin } from '../application/agent-lifecycle-contracts.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { bundleAgentEngine, installAgentEngine, readAgentEnginePin } from '../infrastructure/agent-engine-release.js';
import { resolveAgentEngine } from '../infrastructure/agent-engine-registry.js';
import { captureLifecycleTree, lifecycleDigest } from '../infrastructure/agent-lifecycle-files.js';
import { SYNTHETIC_AGENT_TURN_REQUESTS } from '../infrastructure/synthetic-agent-turn.js';
import type { InitialEngineBoundary } from './helpers/agent-initial-engine-worker.js';

const execute = promisify(execFile), runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
const worker = fileURLToPath(new URL('./helpers/agent-initial-engine-worker.js', import.meta.url));
const preloader = fileURLToPath(new URL('./helpers/agent-installation-home.js', import.meta.url));
const posix = { skip: process.platform === 'win32' ? 'POSIX link/process fixture; a macOS run does not establish Linux or native Windows behavior.' : false };
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const json = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value) + '\n', { mode: 0o600 });
type InitialOperation = { schemaVersion: 3; kind: 'initialize'; operationId: string; identity: AgentIdentity;
  initialEngine: { pin: EnginePin; registrationDigest: string } };
type InitialReceipt = { schemaVersion: 3; agentId: string; operationId: string; initialPinDigest: string };
type WorkerResult = { status?: string; identity?: AgentIdentity; operation?: InitialOperation; pin?: EnginePin; receipt?: InitialReceipt;
  error?: { code: string | null; message: string } };
function fixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-initial-engine-'))); t.after(() => rmSync(base, { recursive: true, force: true }));
  const registry = join(base, 'engines'), root = join(base, 'agent'), dev = join(base, 'dev'); mkdirSync(dev, { mode: 0o700 });
  return { base, registry, root, dev, options: { engineRegistryDirectory: registry } };
}
function smallRelease(base: string, name = 'a') {
  const source = join(base, `source-${name}`); mkdirSync(source, { mode: 0o700 });
  for (const path of ['dist', 'dist/presentation', 'node_modules', 'node_modules/zod']) mkdirSync(join(source, path), { mode: 0o700 });
  // Metadata boundary fixture only. Its candidate entry is never executed; the final test uses the complete real runtime.
  json(join(source, 'package.json'), { name: 'long-horizon-runtime', version: `0.0.${name === 'a' ? 1 : 2}-initial-engine`, engines: { node: '>=24.20.0 <25' } });
  json(join(source, 'node_modules/zod/package.json'), { name: 'zod', version: '0.0.0-metadata-fixture' });
  writeFileSync(join(source, 'dist/presentation/agent-cli.js'), 'throw new Error("metadata_fixture_must_not_execute");\n', { mode: 0o600 });
  const bundle = bundleAgentEngine(source, join(base, `bundle-${name}`));
  return installAgentEngine(bundle.directory, join(base, `engine-${name}`), bundle.release.digest);
}
function originals(root: string) {
  const rows: { path: string; kind: string; mode: number; identity: string; links: number; sha256: string | null }[] = [];
  const visit = (path: string, relative: string) => {
    const stat = lstatSync(path); assert.equal(stat.isSymbolicLink(), false); assert.ok(stat.isDirectory() || stat.isFile());
    rows.push({ path: relative, kind: stat.isDirectory() ? 'directory' : 'file', mode: stat.mode & 0o777, identity: `${stat.dev}:${stat.ino}`,
      links: stat.isFile() ? stat.nlink : 0, sha256: stat.isFile() ? digest(readFileSync(path)) : null });
    if (stat.isDirectory()) for (const leaf of readdirSync(path).sort()) visit(join(path, leaf), relative ? `${relative}/${leaf}` : leaf);
  };
  visit(root, ''); return rows;
}
function proof(root: string, engine: ReturnType<typeof smallRelease>, registry: string) {
  const operation = JSON.parse(readFileSync(join(root, '.secumon/setup-operation.json'), 'utf8')) as InitialOperation;
  const receipt = JSON.parse(readFileSync(join(root, '.secumon/setup.json'), 'utf8')) as InitialReceipt;
  const pin = readAgentEnginePin(root); assert.ok(pin);
  assert.equal(operation.schemaVersion, 3); assert.equal(operation.kind, 'initialize'); assert.ok(operation.operationId);
  assert.deepEqual(operation.initialEngine.pin, pin); assert.equal(pin.agentId, operation.identity.agentId);
  assert.equal(pin.sequence, 1); assert.equal(pin.previous, null); assert.equal(pin.backupDigest, null);
  assert.equal(pin.releaseDigest, engine.release.digest); assert.equal(pin.engineDirectory, engine.directory); assert.equal(pin.version, engine.release.version);
  assert.deepEqual(receipt, { schemaVersion: 3, agentId: operation.identity.agentId, operationId: operation.operationId, initialPinDigest: lifecycleDigest(pin) });
  const registrations = readdirSync(registry).filter(value => value.endsWith('.json')).map(leaf => JSON.parse(readFileSync(join(registry, leaf), 'utf8')));
  const registration = registrations.find(value => value.directory === engine.directory && value.releaseDigest === engine.release.digest); assert.ok(registration);
  assert.equal(operation.initialEngine.registrationDigest, lifecycleDigest(registration));
  return { operation, receipt, pin };
}
function beforeInitialPinPublication(t: TestContext) {
  const f = fixture(t), engine = smallRelease(f.base), profiles = new FileAgentProfileStore(engine.directory, f.options);
  profiles.initialize(f.root); const initial = proof(f.root, engine, f.registry);
  const pinPath = join(f.root, '.secumon/engine-pins/00000001.json'), receiptPath = join(f.root, '.secumon/setup.json');
  const pinBytes = readFileSync(pinPath), receiptBytes = readFileSync(receiptPath);
  const operationPath = join(f.root, '.secumon/setup-operation.json'), operationBytes = readFileSync(operationPath);
  // Reconstruct only the before-link layout from actual saved bytes. This is separate from the real SIGKILL tests.
  const retainedPin = join(f.base, 'retained-first-pin.json'), retainedReceipt = join(f.base, 'retained-setup.json');
  renameSync(pinPath, retainedPin); renameSync(receiptPath, retainedReceipt);
  return { ...f, engine, profiles, initial, pinPath, receiptPath, pinBytes, receiptBytes, operationPath, operationBytes, retainedPin, retainedReceipt,
    pending: join(f.root, '.secumon/engine-pins/.secumon-init-00000000-0000-4000-8000-000000000001.pending') };
}
function start(f: ReturnType<typeof fixture>, engine: string, phase: string, go = '') {
  const child = fork(worker, [engine, f.root, f.registry, phase, go], { cwd: f.base, execArgv: [],
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: f.base, LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '', errors = '', failure: unknown, exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let accept!: (value: InitialEngineBoundary) => void, reject!: (error: unknown) => void;
  const boundary = new Promise<InitialEngineBoundary>((yes, no) => { accept = yes; reject = no; }); void boundary.catch(() => {});
  const kill = (error: unknown) => { failure ??= error; reject(error); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); };
  const timer = setTimeout(() => kill(new Error(`initial_engine_worker_deadline:${phase}`)), 30000);
  child.stdout!.on('data', (bytes: Buffer) => { output += bytes.toString('utf8'); if (Buffer.byteLength(output) > 65536) kill(new Error('initial_engine_worker_output_limit')); });
  child.stderr!.on('data', (bytes: Buffer) => { errors += bytes.toString('utf8'); if (Buffer.byteLength(errors) > 65536) kill(new Error('initial_engine_worker_error_limit')); });
  child.on('message', raw => {
    try {
      assert.ok(Buffer.byteLength(JSON.stringify(raw)) <= 65536);
      const value = raw as InitialEngineBoundary; assert.equal(value.type, 'initial-engine-boundary'); assert.equal(value.phase, phase);
      assert.equal(value.root, f.root); assert.equal(value.pid, child.pid); assert.ok(Array.isArray(value.originals)); accept(value);
    } catch (error) { kill(error); }
  });
  child.once('error', kill); child.once('exit', (code, signal) => { exit = { code, signal }; });
  const terminal = new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string; errors: string }>((resolve, no) => {
    child.once('close', (code, signal) => {
      clearTimeout(timer); reject(new Error(`initial_engine_worker_closed_before_boundary:${code}:${signal}:${output}:${errors}`));
      if (failure) { no(failure); return; }
      try { assert.deepEqual(exit, { code, signal }, 'actual exit and close must both be observed'); resolve({ code, signal, output, errors }); }
      catch (error) { no(error); }
    });
  }); void terminal.catch(() => {});
  return { child, boundary, terminal, async close() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await terminal; } };
}

test('a fresh profile from an installed release publishes one original operation-linked registration, pin and receipt', posix, t => {
  const f = fixture(t), engine = smallRelease(f.base), profiles = new FileAgentProfileStore(engine.directory, f.options);
  const profile = profiles.initialize(f.root, { name: 'initial-engine-fixture' }), initial = proof(f.root, engine, f.registry);
  assert.deepEqual(profile.identity, initial.operation.identity);
  assert.deepEqual(resolveAgentEngine(f.root, f.dev, { registryDirectory: f.registry }), { directory: engine.directory, source: 'registered', releaseDigest: engine.release.digest });
  const before = originals(f.base);
  assert.deepEqual(profiles.initialize(f.root, { name: 'initial-engine-fixture' }), profile); assert.deepEqual(profiles.inspect(f.root), profile);
  assert.deepEqual(proof(f.root, engine, f.registry), initial); assert.deepEqual(originals(f.base), before);
});

test('development, already initialized unpinned, and cloned profiles are not silently adopted by an installed release', posix, t => {
  const f = fixture(t), engine = smallRelease(f.base), dev = new FileAgentProfileStore(f.dev), legacy = dev.initialize(f.root);
  assert.equal(readAgentEnginePin(f.root), null); assert.equal(existsSync(f.registry), false);
  const profiles = new FileAgentProfileStore(engine.directory, f.options), before = originals(f.root);
  assert.deepEqual(profiles.initialize(f.root), legacy); assert.equal(readAgentEnginePin(f.root), null); assert.deepEqual(originals(f.root), before);
  assert.equal(existsSync(f.registry), false);
  const fresh = profiles.initialize(join(f.base, 'fresh')), initial = proof(fresh.root, engine, f.registry);
  const source = originals(fresh.root), cloned = profiles.clone(fresh.root, join(f.base, 'cloned'));
  assert.notEqual(cloned.identity.agentId, fresh.identity.agentId); assert.equal(readAgentEnginePin(cloned.root), null);
  const cloneBefore = originals(cloned.root); profiles.initialize(cloned.root); assert.deepEqual(originals(cloned.root), cloneBefore);
  assert.deepEqual(originals(fresh.root), source); assert.deepEqual(proof(fresh.root, engine, f.registry), initial);
});

test('completed initial-engine proofs preserve the original selection while refusing missing operation or pin and altered proof bodies', posix, t => {
  const f = fixture(t), engine = smallRelease(f.base), profiles = new FileAgentProfileStore(engine.directory, f.options); profiles.initialize(f.root);
  const initial = proof(f.root, engine, f.registry), setup = join(f.root, '.secumon/setup.json'), pin = join(f.root, '.secumon/engine-pins/00000001.json');
  const operation = join(f.root, '.secumon/setup-operation.json');
  for (const [path, code] of [[operation, 'agent_initial_engine_proof_invalid'], [pin, 'agent_initial_engine_pin_missing']] as const) {
    const retained = join(f.base, `retained-${path === operation ? 'operation' : 'pin'}.json`); renameSync(path, retained);
    try {
      const before = originals(f.base);
      assert.throws(() => profiles.initialize(f.root, { repair: true }), new RegExp(`^Error: ${code}$`));
      assert.deepEqual(originals(f.base), before); assert.equal(existsSync(path), false);
    } finally { renameSync(retained, path); }
  }
  for (const [path, value, code] of [[operation, { ...initial.operation, operationId: '00000000-0000-4000-8000-000000000001' }, 'agent_initial_engine_proof_invalid'],
    [setup, { ...initial.receipt, initialPinDigest: '0'.repeat(64) }, 'agent_initial_engine_proof_invalid'],
    [pin, { ...initial.pin, createdAt: initial.pin.createdAt + 1 }, 'agent_initial_engine_pin_mismatch']] as const) {
    const bytes = readFileSync(path);
    try {
      json(path, value); const before = originals(f.base);
      assert.throws(() => profiles.initialize(f.root, { repair: true }), new RegExp(`^Error: ${code}$`)); assert.deepEqual(originals(f.base), before);
    } finally { writeFileSync(path, bytes, { mode: 0o600 }); }
  }
  // A lost receipt alone is indistinguishable from interruption after the exact initial pin publication.
  // Recreate only that original receipt; its source operation and pin cannot be replaced by a new selection.
  const before = captureLifecycleTree(f.root), receiptBytes = readFileSync(setup), operationBytes = readFileSync(operation), pinBytes = readFileSync(pin);
  const retainedReceipt = join(f.base, 'retained-receipt.json'); renameSync(setup, retainedReceipt);
  profiles.initialize(f.root, { repair: true });
  assert.deepEqual(readFileSync(setup), receiptBytes); assert.deepEqual(readFileSync(retainedReceipt), receiptBytes);
  assert.deepEqual(readFileSync(operation), operationBytes); assert.deepEqual(readFileSync(pin), pinBytes);
  assert.deepEqual(captureLifecycleTree(f.root), before);
  assert.deepEqual(proof(f.root, engine, f.registry), initial);
});

for (const phase of ['operation-linked', 'pin-linked', 'receipt-linked']) test(`SIGKILL after ${phase} resumes the exact original initial-engine publication`, { ...posix, timeout: 60000 }, async t => {
  const f = fixture(t), engine = smallRelease(f.base), child = start(f, engine.directory, phase);
  try {
    const observed = await child.boundary; assert.ok(observed.source.startsWith(f.root + '/'));
    for (const original of observed.originals) {
      const bytes = readFileSync(original.path); assert.equal(digest(bytes), original.sha256); assert.equal(bytes.toString('base64'), original.base64);
    }
    const source = observed.originals.find(value => value.path === observed.source), target = observed.originals.find(value => value.path === observed.target);
    assert.ok(source && target); assert.equal(source.links, 2); assert.equal(target.links, 2); assert.equal(source.identity, target.identity); assert.equal(source.sha256, target.sha256);
    assert.equal(child.child.kill('SIGKILL'), true); const stopped = await child.terminal;
    assert.equal(stopped.code, null); assert.equal(stopped.signal, 'SIGKILL'); assert.equal(stopped.output, '');
    const operationBytes = readFileSync(join(f.root, '.secumon/setup-operation.json'));
    const operation = JSON.parse(operationBytes.toString('utf8')) as InitialOperation; assert.equal(operation.schemaVersion, 3);
    assert.equal(operation.initialEngine.pin.releaseDigest, engine.release.digest);
    const profile = new FileAgentProfileStore(engine.directory, f.options).initialize(f.root, { repair: true, name: 'initial-engine-fixture' });
    assert.deepEqual(profile.identity, operation.identity); const initial = proof(f.root, engine, f.registry);
    assert.deepEqual(initial.operation, operation); assert.deepEqual(readFileSync(join(f.root, '.secumon/setup-operation.json')), operationBytes);
    for (const original of observed.originals.filter(value => value.path !== observed.source)) {
      assert.equal(readFileSync(original.path).toString('base64'), original.base64);
      const stat = lstatSync(original.path); assert.equal(`${stat.dev}:${stat.ino}`, original.identity, 'published original was reused, not replaced');
    }
    const before = originals(f.root); new FileAgentProfileStore(engine.directory, f.options).initialize(f.root);
    assert.deepEqual(originals(f.root), before);
  } finally { await child.close(); }
});

test('a pin-linked SIGKILL followed by loss of its original operation cannot create a legacy setup around the retained pin', { ...posix, timeout: 60000 }, async t => {
  const f = fixture(t), engine = smallRelease(f.base), child = start(f, engine.directory, 'pin-linked');
  try {
    const observed = await child.boundary;
    const target = observed.originals.find(value => value.path === observed.target), candidate = observed.originals.find(value => value.path === observed.source);
    assert.ok(target && candidate); assert.equal(target.links, 2); assert.equal(candidate.links, 2); assert.equal(target.identity, candidate.identity);
    for (const original of observed.originals) assert.equal(digest(readFileSync(original.path)), original.sha256);
    assert.equal(child.child.kill('SIGKILL'), true); const stopped = await child.terminal;
    assert.equal(stopped.code, null); assert.equal(stopped.signal, 'SIGKILL'); assert.equal(stopped.output, '');
    assert.equal(existsSync(join(f.root, '.secumon/setup.json')), false);
    const operationPath = join(f.root, '.secumon/setup-operation.json'), operationBytes = readFileSync(operationPath);
    const operation = JSON.parse(operationBytes.toString('utf8')) as InitialOperation; assert.equal(operation.schemaVersion, 3);
    const retained = join(f.base, 'retained-lost-operation.json'); renameSync(operationPath, retained);
    const before = originals(f.base);
    assert.throws(() => new FileAgentProfileStore(engine.directory, f.options).initialize(f.root, { repair: true }), /^Error: agent_initial_engine_proof_invalid$/);
    assert.deepEqual(originals(f.base), before); assert.equal(existsSync(operationPath), false);
    assert.equal(existsSync(join(f.root, '.secumon/setup.json')), false); assert.deepEqual(readFileSync(retained), operationBytes);
    for (const original of observed.originals.filter(value => value.path !== operationPath)) {
      assert.equal(readFileSync(original.path).toString('base64'), original.base64);
      const stat = lstatSync(original.path); assert.equal(`${stat.dev}:${stat.ino}`, original.identity);
    }
  } finally { await child.close(); }
});

test('SIGKILL before the initial pin link resumes the exact single-link orphan without selecting a new engine', { ...posix, timeout: 60000 }, async t => {
  const f = fixture(t), engine = smallRelease(f.base), child = start(f, engine.directory, 'pin-before-link');
  try {
    const observed = await child.boundary, candidate = observed.originals.find(value => value.path === observed.source); assert.ok(candidate);
    assert.equal(observed.target, join(f.root, '.secumon/engine-pins/00000001.json'));
    assert.equal(candidate.links, 1); assert.equal(existsSync(observed.target), false); assert.equal(existsSync(join(f.root, '.secumon/setup.json')), false);
    for (const original of observed.originals) assert.equal(digest(readFileSync(original.path)), original.sha256);
    assert.equal(child.child.kill('SIGKILL'), true); const stopped = await child.terminal;
    assert.equal(stopped.code, null); assert.equal(stopped.signal, 'SIGKILL'); assert.equal(stopped.output, '');
    const operationPath = join(f.root, '.secumon/setup-operation.json'), operationBytes = readFileSync(operationPath);
    const operation = JSON.parse(operationBytes.toString('utf8')) as InitialOperation; assert.equal(operation.schemaVersion, 3);
    const pinBytes = Buffer.from(candidate.base64, 'base64'); assert.deepEqual(JSON.parse(pinBytes.toString('utf8')), operation.initialEngine.pin);
    const profiles = new FileAgentProfileStore(engine.directory, f.options), profile = profiles.initialize(f.root, { name: 'initial-engine-fixture' });
    assert.deepEqual(profile.identity, operation.identity); assert.deepEqual(proof(f.root, engine, f.registry).operation, operation);
    assert.deepEqual(readFileSync(operationPath), operationBytes); assert.deepEqual(readFileSync(observed.target), pinBytes);
    for (const original of observed.originals) {
      assert.equal(readFileSync(original.path).toString('base64'), original.base64);
      const stat = lstatSync(original.path); assert.equal(`${stat.dev}:${stat.ino}`, original.identity);
    }
    assert.equal(lstatSync(observed.source).nlink, 1, 'the observed orphan is preserved, not consumed as a new authority');
    const before = originals(f.base); profiles.initialize(f.root); assert.deepEqual(originals(f.base), before);
  } finally { await child.close(); }
});

test('an initial pin orphan with a different body is refused while its operation and candidate are preserved', posix, t => {
  const f = beforeInitialPinPublication(t);
  const altered = Buffer.from(JSON.stringify({ ...f.initial.pin, releaseDigest: '0'.repeat(64) }, null, 2) + '\n');
  assert.notDeepEqual(altered, f.pinBytes); writeFileSync(f.pending, altered, { mode: 0o600, flag: 'wx' });
  assert.equal(lstatSync(f.pending).nlink, 1); const before = originals(f.base);
  assert.throws(() => f.profiles.initialize(f.root, { repair: true }), /^Error: engine_pin_history_invalid$/);
  assert.deepEqual(originals(f.base), before); assert.deepEqual(readFileSync(f.pending), altered); assert.deepEqual(readFileSync(f.operationPath), f.operationBytes);
  assert.equal(existsSync(f.pinPath), false); assert.equal(existsSync(f.receiptPath), false);
});

test('exact initial pin bytes linked to an external file do not qualify as the local pending publication', posix, t => {
  const f = beforeInitialPinPublication(t), external = join(f.base, 'external-exact-pin.json');
  writeFileSync(external, f.pinBytes, { mode: 0o600, flag: 'wx' }); linkSync(external, f.pending);
  assert.equal(lstatSync(f.pending).nlink, 2); assert.equal(lstatSync(external).ino, lstatSync(f.pending).ino);
  const before = originals(f.base);
  assert.throws(() => f.profiles.initialize(f.root, { repair: true }), /^Error: metadata_read_unsafe$/);
  assert.deepEqual(originals(f.base), before); assert.deepEqual(readFileSync(external), f.pinBytes); assert.deepEqual(readFileSync(f.pending), f.pinBytes);
  assert.deepEqual(readFileSync(f.operationPath), f.operationBytes); assert.equal(existsSync(f.pinPath), false); assert.equal(existsSync(f.receiptPath), false);
});

test('concurrent initializers converge on one original operation and a different engine cannot adopt the winner work', { ...posix, timeout: 90000 }, async t => {
  for (const different of [false, true]) await t.test(different ? 'different installed releases' : 'same installed release', async sub => {
    const f = fixture(sub), a = smallRelease(f.base), b = different ? smallRelease(f.base, 'b') : a;
    const go = join(f.base, 'publish.go'), left = start(f, a.directory, 'race', go), right = start(f, b.directory, 'race', go);
    try {
      const boundaries = await Promise.all([left.boundary, right.boundary]);
      assert.ok(boundaries.every(value => value.target === join(f.root, '.secumon/setup-operation.json')));
      assert.equal(existsSync(join(f.root, '.secumon/setup-operation.json')), false);
      writeFileSync(go, 'publish original candidates\n', { flag: 'wx', mode: 0o600 });
      const results = await Promise.all([left.terminal, right.terminal]);
      const replies = results.map(value => JSON.parse(value.output) as WorkerResult);
      const winnerIndex = results.findIndex(value => value.code === 0); assert.ok(winnerIndex >= 0);
      const winner = winnerIndex === 0 ? a : b, loser = winnerIndex === 0 ? b : a;
      const initial = proof(f.root, winner, f.registry);
      for (const [index, result] of results.entries()) {
        assert.equal(result.signal, null);
        if (result.code === 0) { assert.equal(replies[index]?.status, 'ready'); assert.deepEqual(replies[index]?.operation, initial.operation); assert.deepEqual(replies[index]?.pin, initial.pin); }
        else {
          assert.equal(result.code, 1, result.errors);
          assert.ok(['agent_initial_engine_mismatch', 'agent_engine_update_required'].includes(replies[index]?.error?.code ?? ''), JSON.stringify(replies[index]));
        }
      }
      assert.equal(results.filter(value => value.code === 0).length, different ? 1 : 2);
      if (different) {
        const before = originals(f.base);
        assert.throws(() => new FileAgentProfileStore(loser.directory, f.options).initialize(f.root, { repair: true }), /^Error: agent_engine_update_required$/);
        assert.deepEqual(originals(f.base), before);
      }
      assert.equal(readdirSync(join(f.root, '.secumon/engine-pins')).filter(value => /^\d{8}\.json$/.test(value)).length, 1);
    } finally { await Promise.allSettled([left.close(), right.close()]); }
  });
});

test('a full installed CLI automatically pins a new SQLite agent before open and the ordinary synthetic tool loop', { ...posix, timeout: 180000 }, async t => {
  const f = fixture(t), bundle = bundleAgentEngine(runtimeRoot, join(f.base, 'full-bundle'));
  const engine = installAgentEngine(bundle.directory, join(f.base, 'full-engine'), bundle.release.digest);
  const home = join(f.base, 'home'); mkdirSync(home, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: f.base, LANG: 'C.UTF-8',
    NODE_OPTIONS: `--import=${pathToFileURL(preloader).href}`, SECUMON_INSTALLATION_HOME: home };
  const cli = async <T>(args: string[]): Promise<T> => JSON.parse((await execute(process.execPath, [engine.command[1]!, ...args, '--json'],
    { cwd: f.base, env, timeout: 45000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 })).stdout) as T;
  type Setup = { status: string; identity: AgentIdentity; engineVersion: string; storageInitialized: boolean };
  type Turn = { workId: string; sessionId: string; snapshot: { status: string; usage: { modelCalls: number; toolCalls: number } }; messages: { kind: string; text: string }[] };
  const setup = await cli<Setup>(['init', '--directory', f.root]); assert.equal(setup.status, 'ready'); assert.equal(setup.storageInitialized, true);
  const registry = join(home, '.secumon/engines'), initial = proof(f.root, engine, registry); assert.deepEqual(initial.operation.identity, setup.identity);
  const registryBefore = captureLifecycleTree(registry), originalPin = readFileSync(join(f.root, '.secumon/engine-pins/00000001.json'));
  const reopened = await cli<Setup>(['open', '--directory', f.root]); assert.deepEqual(reopened.identity, setup.identity); assert.equal(reopened.engineVersion, engine.release.version);
  const args = ['chat', 'ask', '--directory', f.root, '--provider', 'synthetic', '--conversation', 'initial-engine', '--message-id', 'initial-read', '--text', SYNTHETIC_AGENT_TURN_REQUESTS.read];
  const reply = await cli<Turn>(args); assert.equal(reply.snapshot.status, 'completed'); assert.equal(reply.snapshot.usage.modelCalls, 2); assert.equal(reply.snapshot.usage.toolCalls, 1);
  assert.ok(reply.messages.some(value => value.kind === 'result' && value.text.includes('30일')));
  const repeat = await cli<Turn>([...args, '--session', reply.sessionId]); assert.equal(repeat.workId, reply.workId); assert.equal(repeat.sessionId, reply.sessionId);
  assert.deepEqual(repeat.snapshot.usage, reply.snapshot.usage); assert.deepEqual(repeat.messages, reply.messages);
  assert.deepEqual(proof(f.root, engine, registry), initial); assert.deepEqual(readFileSync(join(f.root, '.secumon/engine-pins/00000001.json')), originalPin);
  const firstAgent = originals(f.root), identities = new Set([setup.identity.agentId]);
  // Reuse this one installed release and host registry: the public CLI, not a direct initializer, must cross the interrupted setup gate.
  for (const phase of ['pin-before-link', 'pin-linked']) {
    const root = join(f.base, `public-open-${phase}`), child = start({ ...f, root, registry }, engine.directory, phase);
    try {
      const observed = await child.boundary;
      assert.equal(observed.target, join(root, '.secumon/engine-pins/00000001.json'));
      assert.equal(existsSync(observed.target), phase === 'pin-linked');
      assert.equal(existsSync(join(root, '.secumon/setup.json')), false);
      for (const original of observed.originals) assert.equal(digest(readFileSync(original.path)), original.sha256);
      assert.equal(child.child.kill('SIGKILL'), true); const stopped = await child.terminal;
      assert.equal(stopped.code, null); assert.equal(stopped.signal, 'SIGKILL'); assert.equal(stopped.output, '');
      const operationPath = join(root, '.secumon/setup-operation.json'), operationBytes = readFileSync(operationPath);
      const operation = JSON.parse(operationBytes.toString('utf8')) as InitialOperation; assert.equal(operation.schemaVersion, 3);
      const resumed = await cli<Setup>(['open', '--directory', root]);
      assert.equal(resumed.status, 'ready'); assert.equal(resumed.storageInitialized, true); assert.equal(resumed.engineVersion, engine.release.version);
      assert.deepEqual(resumed.identity, operation.identity); assert.equal(identities.has(resumed.identity.agentId), false); identities.add(resumed.identity.agentId);
      assert.deepEqual(proof(root, engine, registry).operation, operation); assert.deepEqual(readFileSync(operationPath), operationBytes);
      for (const original of observed.originals) {
        assert.equal(readFileSync(original.path).toString('base64'), original.base64);
        const stat = lstatSync(original.path); assert.equal(`${stat.dev}:${stat.ino}`, original.identity);
      }
    } finally { await child.close(); }
  }
  assert.equal(identities.size, 3); assert.deepEqual(originals(f.root), firstAgent);
  assert.deepEqual(captureLifecycleTree(registry), registryBefore);
});
