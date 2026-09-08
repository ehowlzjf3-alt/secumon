import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertHostDirectoryRetirementAvailable, inspectHostDirectoryRetirement, retireHostDirectory } from '../infrastructure/host-directory-retirement.js';
import { captureLifecycleTree } from '../infrastructure/agent-lifecycle-files.js';
import { hostMetadataFiles, releaseMetadataDirectory, type FileIdentity } from '../infrastructure/host-metadata-files.js';

const require = createRequire(import.meta.url);
const posix = { skip: process.platform === 'win32' ? 'POSIX ownership fixture; native Windows ACL and process acceptance is separate' : false };
function identity(path: string): FileIdentity {
  const files = hostMetadataFiles(), ref = files.inspectDirectory(path, 'owner-writable'); assert.ok(ref);
  try { return { ...ref.identity }; } finally { releaseMetadataDirectory(files, ref); }
}
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'host-directory-retirement-')));
  const source = join(base, 'agent'), destination = join(base, 'preserved-agent'), engine = join(base, 'engine');
  mkdirSync(source, { mode: 0o700 }); mkdirSync(engine, { mode: 0o700 }); mkdirSync(join(source, 'records'), { mode: 0o700 });
  writeFileSync(join(source, 'records', 'receipt.json'), '{"original":"retained"}\n', { mode: 0o600 });
  return { base, source, destination, engine, input: { source, destination, expectedIdentity: identity(source), forbiddenRoots: [engine] },
    close: () => rmSync(base, { recursive: true, force: true }) };
}
interface NativeResult { ok: boolean; outcome: string; code?: string; directorySynced: boolean }
function native() {
  return require(fileURLToPath(new URL('../../native/windows-files/secumon_windows_files.node', import.meta.url))) as {
    retireDirectoryNoReplace(parent: string, source: string, destination: string, expectedParent: FileIdentity, expectedSource: FileIdentity): NativeResult;
  };
}

test('directory retirement moves the exact native object and repeated retirement preserves a newly restored source', posix, () => {
  const f = fixture();
  try {
    assertHostDirectoryRetirementAvailable();
    const original = captureLifecycleTree(f.source);
    assert.deepEqual(inspectHostDirectoryRetirement(f.input), { sourceIdentity: f.input.expectedIdentity, destinationIdentity: null, retired: false });
    const moved = retireHostDirectory(f.input);
    assert.equal(moved.outcome, 'moved'); assert.equal(moved.retired, true); assert.equal(moved.sourceIdentity, null);
    assert.deepEqual(moved.destinationIdentity, f.input.expectedIdentity); assert.equal(moved.directorySynced, true);
    assert.equal(moved.durability, 'namespace-fsync'); assert.equal(existsSync(f.source), false);
    assert.deepEqual(captureLifecycleTree(f.destination), original);
    assert.equal(retireHostDirectory(f.input).outcome, 'already_retired');
    mkdirSync(f.source, { mode: 0o700 }); writeFileSync(join(f.source, 'new-root.json'), '{"new":true}\n', { mode: 0o600 });
    const newIdentity = identity(f.source), newTree = captureLifecycleTree(f.source);
    assert.notDeepEqual(newIdentity, f.input.expectedIdentity);
    const resumed = retireHostDirectory(f.input);
    assert.equal(resumed.outcome, 'already_retired'); assert.equal(resumed.retired, true);
    assert.deepEqual(resumed.sourceIdentity, newIdentity); assert.deepEqual(resumed.destinationIdentity, f.input.expectedIdentity);
    assert.deepEqual(captureLifecycleTree(f.source), newTree); assert.deepEqual(captureLifecycleTree(f.destination), original);
  } finally { f.close(); }
});

test('directory retirement and its native entry reject occupied destinations without overwriting either object', posix, () => {
  const f = fixture();
  try {
    assertHostDirectoryRetirementAvailable(); mkdirSync(f.destination, { mode: 0o700 });
    const destinationIdentity = identity(f.destination), original = captureLifecycleTree(f.source);
    for (const occupied of ['empty', 'nonempty']) {
      if (occupied === 'nonempty') writeFileSync(join(f.destination, 'existing.txt'), 'Existing target remains original.\n', { mode: 0o600 });
      const target = captureLifecycleTree(f.destination);
      assert.throws(() => retireHostDirectory(f.input), /destination_exists/);
      // Exercise the native boundary too; the high-level preflight is not the only no-overwrite guard.
      const result = native().retireDirectoryNoReplace(f.base, basename(f.source), basename(f.destination), identity(f.base), f.input.expectedIdentity);
      assert.equal(result.ok, false); assert.equal(result.code, 'destination_exists'); assert.equal(result.outcome, 'not_moved');
      assert.equal(result.directorySynced, false); assert.deepEqual(identity(f.source), f.input.expectedIdentity);
      assert.deepEqual(identity(f.destination), destinationIdentity); assert.deepEqual(captureLifecycleTree(f.source), original);
      assert.deepEqual(captureLifecycleTree(f.destination), target);
    }
    assert.equal(readFileSync(join(f.destination, 'existing.txt'), 'utf8'), 'Existing target remains original.\n');
  } finally { f.close(); }
});

test('directory retirement rejects wrong source or parent identity and forbidden or nonsibling destinations before mutation', posix, () => {
  const f = fixture();
  try {
    assertHostDirectoryRetirementAvailable(); const before = captureLifecycleTree(f.base), foreign = identity(f.engine);
    assert.throws(() => retireHostDirectory({ ...f.input, expectedIdentity: foreign }), /source_changed/);
    assert.throws(() => retireHostDirectory({ ...f.input, forbiddenRoots: [f.source] }));
    assert.throws(() => retireHostDirectory({ ...f.input, destination: join(f.engine, 'forbidden') }), /sibling_required/);
    assert.throws(() => retireHostDirectory({ ...f.input, destination: f.source }), /sibling_required/);
    const source = native().retireDirectoryNoReplace(f.base, basename(f.source), basename(f.destination), identity(f.base), foreign);
    assert.equal(source.ok, false); assert.equal(source.code, 'source_changed'); assert.equal(source.outcome, 'not_moved');
    const parent = native().retireDirectoryNoReplace(f.base, basename(f.source), basename(f.destination), foreign, f.input.expectedIdentity);
    assert.equal(parent.ok, false); assert.equal(parent.code, 'parent_changed'); assert.equal(parent.outcome, 'not_moved');
    assert.equal(existsSync(f.destination), false); assert.deepEqual(captureLifecycleTree(f.base), before);
  } finally { f.close(); }
});
