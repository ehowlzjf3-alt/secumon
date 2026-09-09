import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_ENGINE_NATIVE_PATH, assertAgentEngineNative } from '../infrastructure/agent-engine-native.js';
import { bundleAgentEngine, inspectAgentEngineBuild, inspectEngineRelease, installAgentEngine } from '../infrastructure/agent-engine-release.js';
import { registerAgentEngine } from '../infrastructure/agent-engine-registry.js';
import { captureLifecycleTree, lifecycleDigest } from '../infrastructure/agent-lifecycle-files.js';
import { copyAgentEngineNativeFixture } from './helpers/agent-engine-native-fixture.js';

const posix = { skip: process.platform === 'win32' ? 'POSIX private fixture; native Windows installation is a separate acceptance run.' : false };
function fixture(t: TestContext, native = true) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'engine-native-'))), source = join(base, 'source');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  for (const path of ['dist/presentation', 'node_modules/zod']) mkdirSync(join(source, path), { recursive: true, mode: 0o700 });
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'long-horizon-runtime', version: '0.0.1-native-fixture',
    engines: { node: '>=24.20.0 <25' }, dependencies: { zod: '0.0.0-fixture' } }), { mode: 0o600 });
  writeFileSync(join(source, 'node_modules/zod/package.json'), JSON.stringify({ name: 'zod', version: '0.0.0-fixture' }), { mode: 0o600 });
  writeFileSync(join(source, 'dist/presentation/agent-cli.js'), 'throw new Error("candidate_js_must_not_execute");', { mode: 0o600 });
  if (native) copyAgentEngineNativeFixture(source);
  return { base, source };
}

test('full POSIX source and historical release without the native asset are rejected before installation', posix, t => {
  const f = fixture(t, false), before = captureLifecycleTree(f.source);
  assert.throws(() => inspectAgentEngineBuild(f.source), /engine_native_build_required/);
  assert.throws(() => bundleAgentEngine(f.source, join(f.base, 'bundle')), /engine_native_build_required/);
  assert.deepEqual(captureLifecycleTree(f.source), before); assert.equal(existsSync(join(f.base, 'bundle')), false);
  const body = { schemaVersion: 1, kind: 'secumon-engine-release', version: '0.0.1', node: '>=24.20.0 <25', platform: process.platform, arch: process.arch,
    compatibility: { config: [1], state: [1], knowledge: [1], session: [1], journal: [2], documents: [1] }, entries: before };
  writeFileSync(join(f.source, 'release.json'), JSON.stringify({ ...body, digest: lifecycleDigest(body) }), { mode: 0o600 });
  assert.throws(() => inspectEngineRelease(f.source), /engine_native_build_required/);
  assert.throws(() => installAgentEngine(f.source, join(f.base, 'installed'), lifecycleDigest(body)), /engine_native_build_required/);
  assert.equal(existsSync(join(f.base, 'installed')), false);
});

test('native source and installed copies load through a fixed child without candidate JS or inherited Node preloads', posix, t => {
  const f = fixture(t), marker = join(f.base, 'preload-ran'), preload = join(f.base, 'preload.cjs');
  writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected');`, { mode: 0o600 });
  const previous = process.env['NODE_OPTIONS'];
  t.after(() => { if (previous === undefined) delete process.env['NODE_OPTIONS']; else process.env['NODE_OPTIONS'] = previous; });
  process.env['NODE_OPTIONS'] = `--require=${JSON.stringify(preload)}`;
  const before = captureLifecycleTree(f.source), bundle = bundleAgentEngine(f.source, join(f.base, 'bundle'));
  const installed = installAgentEngine(bundle.directory, join(f.base, 'installed'), bundle.release.digest);
  assert.deepEqual(assertAgentEngineNative(installed.directory, installed.release.entries),
    { platform: process.platform, arch: process.arch, fileApi: 4, retirementApi: 1 });
  assert.deepEqual(readFileSync(join(installed.directory, AGENT_ENGINE_NATIVE_PATH)), readFileSync(join(f.source, AGENT_ENGINE_NATIVE_PATH)));
  assert.deepEqual(captureLifecycleTree(f.source), before); assert.equal(existsSync(marker), false);
});

test('metadata inspection and wrong digest do not load native code; trusted install and registration reject incompatible binaries', posix, t => {
  const f = fixture(t), release = inspectAgentEngineBuild(f.source);
  writeFileSync(join(f.source, AGENT_ENGINE_NATIVE_PATH), 'This is not a compatible native library.', { mode: 0o600 });
  const { digest: _digest, ...original } = release;
  const body = { ...original, entries: captureLifecycleTree(f.source) }, changed = { ...body, digest: lifecycleDigest(body) };
  writeFileSync(join(f.source, 'release.json'), JSON.stringify(changed), { mode: 0o600 });
  assert.deepEqual(inspectEngineRelease(f.source), changed, 'metadata lookup verifies bytes without running a native probe');
  const destination = join(f.base, 'installed'), registryDirectory = join(f.base, 'registry');
  assert.throws(() => installAgentEngine(f.source, destination, release.digest), /engine_release_digest_mismatch/);
  assert.throws(() => registerAgentEngine(f.source, release.digest, { registryDirectory }), /engine_release_digest_mismatch/);
  assert.throws(() => installAgentEngine(f.source, destination, changed.digest), /engine_native_incompatible/);
  assert.throws(() => registerAgentEngine(f.source, changed.digest, { registryDirectory }), /engine_native_incompatible/);
  assert.equal(existsSync(destination), false); assert.equal(existsSync(registryDirectory), false);
});

test('replacing a previously verified native pathname cannot reuse the earlier process load', posix, t => {
  const f = fixture(t), path = join(f.source, AGENT_ENGINE_NATIVE_PATH), original = readFileSync(path);
  const release = inspectAgentEngineBuild(f.source);
  assert.equal(assertAgentEngineNative(f.source, release.entries).retirementApi, 1);
  writeFileSync(path, 'replacement with incompatible bytes', { mode: 0o600 });
  assert.throws(() => assertAgentEngineNative(f.source, release.entries), /engine_native_changed/);
  assert.throws(() => assertAgentEngineNative(f.source, captureLifecycleTree(f.source)), /engine_native_incompatible/);
  writeFileSync(path, original, { mode: 0o600 });
  assert.deepEqual(inspectAgentEngineBuild(f.source), release);
});
