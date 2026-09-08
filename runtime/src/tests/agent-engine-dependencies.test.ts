import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertAgentEngineDependencies } from '../infrastructure/agent-engine-dependencies.js';
import { captureLifecycleTree, lifecycleLimits } from '../infrastructure/agent-lifecycle-files.js';
import type { LifecycleEntry } from '../application/agent-lifecycle-contracts.js';

const posix = { skip: process.platform === 'win32' ? 'POSIX temporary package trees; native Windows ACL acceptance is separate.' : false };
function fixture(t: TestContext, body: Record<string, unknown>) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'engine-dependencies-'))), root = join(base, 'engine');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  function write(directory: string, value: Record<string, unknown>) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ version: '0.0.1', ...value }) + '\n', { mode: 0o600 });
  }
  const put = (relative: string, value: Record<string, unknown>) => write(join(root, relative), value);
  put('', { name: 'test-engine', ...body });
  function check(error?: RegExp, entries: readonly LifecycleEntry[] = captureLifecycleTree(root)) {
    const before = captureLifecycleTree(base);
    if (error) assert.throws(() => assertAgentEngineDependencies(root, entries), error);
    else assert.doesNotThrow(() => assertAgentEngineDependencies(root, entries));
    assert.deepEqual(captureLifecycleTree(base), before, 'dependency inspection never changes package or outside bytes');
  }
  return { base, root, put, write, check };
}

test('engine dependencies follow nested and internal ancestor node_modules including scoped packages and required peers', posix, t => {
  const f = fixture(t, { dependencies: { alpha: '*', '@scope/tool': '*' } });
  f.put('node_modules/alpha', { name: 'alpha', dependencies: { nested: '*', shared: '*' }, peerDependencies: { peer: '*' } });
  f.put('node_modules/alpha/node_modules/nested', { name: 'nested', dependencies: { local: '*' } });
  f.put('node_modules/alpha/node_modules/local', { name: 'local' });
  f.put('node_modules/shared', { name: 'shared' }); f.put('node_modules/peer', { name: 'peer' });
  f.put('node_modules/@scope/tool', { name: '@scope/tool', dependencies: { scoped: '*', shared: '*' } });
  // Node visits this intermediate ancestor as well as the package's own and root node_modules.
  f.put('node_modules/@scope/node_modules/scoped', { name: 'scoped' });
  f.check();
});

test('engine dependencies refuse missing production packages and required peers without borrowing an outside installation', posix, t => {
  const f = fixture(t, { dependencies: { required: '*' } });
  f.write(join(f.base, 'node_modules/required'), { name: 'required' });
  f.check(/^Error: engine_dependency_missing$/);
  f.put('node_modules/required', { name: 'required', peerDependencies: { peer: '*' } });
  f.write(join(f.base, 'node_modules/peer'), { name: 'peer' });
  f.check(/^Error: engine_dependency_missing$/);
  f.put('node_modules/peer', { name: 'peer' }); f.check();
});

test('engine dependencies allow absent optional and dev packages but verify present optional closure and terminate cycles', posix, t => {
  const f = fixture(t, { dependencies: { alpha: '*', omitted: '*' }, optionalDependencies: { omitted: '*', present: '*' },
    devDependencies: { 'build-only': '*' }, peerDependencies: { 'optional-peer': '*' }, peerDependenciesMeta: { 'optional-peer': { optional: true } } });
  f.put('node_modules/alpha', { name: 'alpha', dependencies: { beta: '*' } });
  f.put('node_modules/beta', { name: 'beta', dependencies: { alpha: '*' } });
  f.check();
  f.put('node_modules/present', { name: 'present', dependencies: { required: '*' } });
  f.check(/^Error: engine_dependency_missing$/);
  f.put('node_modules/present/node_modules/required', { name: 'required' }); f.check();
  f.put('node_modules/optional-peer', { name: 'optional-peer', dependencies: { missing: '*' } });
  f.check(/^Error: engine_dependency_missing$/);
});

test('engine dependencies bind npm aliases to their declared names and reject nearer name mismatches without falling back', posix, t => {
  const f = fixture(t, { dependencies: { alias: 'npm:@actual/library@^99', alpha: '*' } });
  // Presence validation deliberately does not reimplement npm version/range resolution or execute package main.
  f.put('node_modules/alias', { name: '@actual/library', version: '0.0.1' });
  f.put('node_modules/alpha', { name: 'alpha', dependencies: { shared: '*' } });
  f.put('node_modules/shared', { name: 'shared' }); f.check();
  f.put('node_modules/alpha/node_modules/shared', { name: 'different-package' });
  f.check(/^Error: engine_dependency_name_mismatch$/);
  f.put('node_modules/alpha/node_modules/shared', { name: 'shared' });
  f.put('node_modules/alias', { name: 'alias' }); f.check(/^Error: engine_dependency_name_mismatch$/);
});

test('engine dependencies reject changed captured manifests and unsafe declarations while preserving their exact originals', posix, t => {
  const f = fixture(t, { dependencies: { alpha: '*' } });
  f.put('node_modules/alpha', { name: 'alpha' });
  const entries = captureLifecycleTree(f.root), path = join(f.root, 'node_modules/alpha/package.json');
  const original = readFileSync(path);
  writeFileSync(path, original.toString('utf8').replace('0.0.1', '0.0.2'));
  f.check(/^Error: engine_dependency_changed$/, entries);
  writeFileSync(path, original);
  f.put('node_modules/alpha', { name: 'alpha', dependencies: { '../outside': '*' } });
  f.check(/^Error: engine_dependency_manifest_invalid$/);
  f.put('node_modules/alpha', { name: 'alpha', dependencies: ['not-a-dependency-map'] });
  f.check(/^Error: engine_dependency_manifest_invalid$/);
});

test('engine dependencies reject a package directory replaced by an outside symlink without reading or adopting it', posix, t => {
  const f = fixture(t, { dependencies: { alpha: '*' } });
  f.put('node_modules/alpha', { name: 'alpha' });
  const entries = captureLifecycleTree(f.root), original = join(f.base, 'held-alpha'), link = join(f.root, 'node_modules/alpha');
  renameSync(link, original);
  const outside = join(f.base, 'outside'); f.write(outside, { name: 'alpha' });
  symlinkSync(outside, link, 'dir');
  const before = captureLifecycleTree(f.base, path => path !== 'engine/node_modules/alpha'), object = lstatSync(link);
  assert.throws(() => assertAgentEngineDependencies(f.root, entries), /^Error: engine_dependency_unsafe$/);
  assert.equal(readlinkSync(link), outside); assert.equal(lstatSync(link).ino, object.ino);
  assert.deepEqual(captureLifecycleTree(f.base, path => path !== 'engine/node_modules/alpha'), before);
});

test('engine dependencies enforce manifest and captured entry bounds before consuming oversized input', posix, t => {
  const f = fixture(t, {}), entries = captureLifecycleTree(f.root);
  const manifest = entries.find(entry => entry.path === 'package.json'); assert.ok(manifest?.kind === 'file');
  f.check(/^Error: engine_dependency_limit$/, [{ ...manifest, bytes: 4 * 1024 * 1024 + 1 }]);
  f.check(/^Error: engine_dependency_limit$/, Array.from({ length: lifecycleLimits.entries + 1 }, () => manifest));
});
