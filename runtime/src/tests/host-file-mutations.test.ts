import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hostFileMutations } from '../infrastructure/host-file-mutations.js';
import { FileBoundaryFault } from '../infrastructure/host-metadata-files.js';

const execute = promisify(execFile);
const worker = fileURLToPath(new URL('./helpers/host-file-mutations-worker.js', import.meta.url));
const boundary = (code: string) => (error: unknown) => error instanceof FileBoundaryFault && error.code === code;
function fixture() {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'file-mutations-')));
  const parent = join(base, 'public-parent'); fs.mkdirSync(parent, { mode: 0o755 }); fs.chmodSync(parent, 0o755);
  const root = join(parent, 'agent'); const engine = join(base, 'engine'); fs.mkdirSync(engine, { mode: 0o700 });
  return { base, parent, root, engine, close: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('file mutations: an absent root can be created privately under a public parent without changing its permissions', () => {
  const f = fixture(); const scope = hostFileMutations().openScope({ root: f.root, forbiddenRoots: [f.engine] });
  try {
    scope.check(); assert.equal(scope.directory(f.root, 'owner-writable'), null); assert.equal(fs.existsSync(f.root), false);
    const root = scope.directory(f.root, 'owner-writable', true); assert.ok(root);
    const metadata = scope.directory(join(f.root, '.secumon'), 'private', true); assert.ok(metadata);
    assert.equal(fs.lstatSync(f.root).mode & 0o777, 0o700); assert.equal(fs.lstatSync(f.parent).mode & 0o777, 0o755);
    assert.equal(scope.directory(join(f.root, '.secumon'), 'owner-writable'), metadata);
    fs.chmodSync(join(f.root, '.secumon'), 0o755);
    assert.throws(() => scope.directory(join(f.root, '.secumon'), 'owner-writable'), boundary('unsafe'));
  } finally { scope.close(); f.close(); }
});

test('file mutations: publication never replaces an existing target and produces private executable or empty files', () => {
  const f = fixture(); const scope = hostFileMutations().openScope({ root: f.root, forbiddenRoots: [f.engine] });
  try {
    const root = scope.directory(f.root, 'private', true)!;
    const created = scope.publish(root, '한글 설정.json', Buffer.from('first'));
    assert.equal(created.published, true); assert.equal(created.publication, 'published'); assert.equal(created.cleanup, 'removed');
    assert.equal(created.fileSynced, true); assert.equal(created.directorySynced, true);
    const existing = scope.publish(root, '한글 설정.json', Buffer.from('second')); assert.equal(existing.published, false);
    assert.equal(existing.publication, 'not_published'); assert.equal(fs.readFileSync(join(f.root, '한글 설정.json'), 'utf8'), 'first');
    scope.publish(root, 'run', Buffer.from('executable'), { executable: true }); scope.publish(root, 'empty', new Uint8Array());
    assert.equal(fs.lstatSync(join(f.root, 'run')).mode & 0o777, 0o700); assert.equal(fs.lstatSync(join(f.root, 'empty')).size, 0);
    assert.equal(fs.readdirSync(f.root).some(name => name.endsWith('.pending')), false);
  } finally { scope.close(); f.close(); }
});

test('file mutations: scope references cannot cross scopes, escape by leaf syntax or survive scope close', () => {
  const f = fixture(); const first = hostFileMutations().openScope({ root: f.root, forbiddenRoots: [f.engine] });
  let second: ReturnType<ReturnType<typeof hostFileMutations>['openScope']> | undefined;
  try {
    const root = first.directory(f.root, 'private', true)!; second = hostFileMutations().openScope({ root: f.root, forbiddenRoots: [f.engine] });
    assert.throws(() => second!.publish(root, 'foreign', Buffer.from('x')), boundary('invalid_request'));
    assert.throws(() => first.directory(f.parent, 'private', true), boundary('invalid_request'));
    for (const name of ['', '.', '..', '../escape', 'nested/name', 'nested\\name', 'C:stream', '/absolute', 'bad\0name']) {
      assert.throws(() => first.publish(root, name, Buffer.from('x')), boundary('invalid_request'));
    }
    first.close(); assert.throws(() => first.check(), boundary('invalid_request'));
    assert.throws(() => first.publish(root, 'closed', Buffer.from('x')), boundary('invalid_request'));
    assert.throws(() => first.directory(f.root, 'private'), boundary('invalid_request'));
  } finally { first.close(); second?.close(); f.close(); }
});

test('file mutations: canonical forbidden ancestors, descendants and aliases are refused before creation', () => {
  const f = fixture(); try {
    const alias = join(f.base, 'engine-alias'); fs.symlinkSync(f.engine, alias);
    for (const root of [f.engine, f.base, join(f.engine, 'child'), join(alias, 'child')]) {
      assert.throws(() => hostFileMutations().openScope({ root, forbiddenRoots: [f.engine] }), boundary('unsafe'));
    }
    assert.deepEqual(fs.readdirSync(f.engine), []);
    assert.throws(() => hostFileMutations('win32'), boundary('unsupported_platform'));
  } finally { f.close(); }
});

test('file mutations: an ancestor replacement is rejected even when the same root object is moved back under it', () => {
  const f = fixture(); const scope = hostFileMutations().openScope({ root: f.root, forbiddenRoots: [f.engine] });
  try {
    const root = scope.directory(f.root, 'private', true)!;
    const old = join(f.base, 'old-parent'); fs.renameSync(f.parent, old); fs.mkdirSync(f.parent, { mode: 0o755 }); fs.renameSync(join(old, 'agent'), f.root);
    assert.throws(() => scope.publish(root, 'refused', Buffer.from('x')), boundary('changed'));
    assert.equal(fs.existsSync(join(f.root, 'refused')), false);
  } finally { scope.close(); f.close(); }
});

async function run(scenario: string) {
  const f = fixture(); try { return JSON.parse((await execute(process.execPath, [worker, f.base, f.root, scenario], { timeout: 20000 })).stdout); }
  finally { f.close(); }
}

test('file mutations: write failure cleans its candidate and still synchronizes the directory', async () => {
  const result = await run('write-error');
  assert.equal(result.fault, true); assert.equal(result.primaryOriginal, true); assert.equal(result.status.publication, 'not_published');
  assert.equal(result.status.cleanup, 'removed'); assert.equal(result.status.directorySynced, true); assert.equal(result.targetExists, false);
  assert.equal(result.pendingCount, 0); assert.equal(result.openDescriptors, 0);
});

test('file mutations: a link that succeeds before throwing retains published evidence rather than reporting no effect', async () => {
  const result = await run('link-after-success');
  assert.equal(result.fault, true); assert.equal(result.primaryOriginal, true); assert.equal(result.status.publication, 'published');
  assert.equal(result.targetMatches, true); assert.equal(result.status.cleanup, 'removed'); assert.equal(result.status.directorySynced, true);
  assert.equal(result.openDescriptors, 0);
});

test('file mutations: write, close, cleanup and sync failures retain every original error independently', async () => {
  const result = await run('multiple-errors');
  assert.equal(result.fault, true); assert.deepEqual(result.originalErrors, ['write', 'close', 'cleanup', 'sync']);
  assert.deepEqual(result.syncFault, { code: 'io', operation: 'sync', causeOriginal: true, causeCode: 'EIO' });
  assert.equal(result.status.publication, 'not_published'); assert.equal(result.status.cleanup, 'retained'); assert.equal(result.directorySyncAttempts, 1);
  assert.equal(result.targetExists, false); assert.equal(result.pendingCount, 1); assert.equal(result.openDescriptors, 0);
});

test('file mutations: failed candidate cleanup preserves the published normal two-link pair while sync is still attempted', async () => {
  const result = await run('cleanup-and-sync-error');
  assert.equal(result.fault, true); assert.equal(result.status.publication, 'published'); assert.deepEqual(result.originalErrors, ['cleanup', 'sync']);
  assert.deepEqual(result.syncFault, { code: 'io', operation: 'sync', causeOriginal: true, causeCode: 'EIO' });
  assert.equal(result.directorySyncAttempts, 1); assert.equal(result.samePublishedPair, true); assert.equal(result.targetMatches, true);
  assert.equal(result.openDescriptors, 0);
});

for (const scenario of ['candidate-replaced', 'parent-replaced']) test(`file mutations: ${scenario} never removes a foreign candidate or writes through a changed parent`, async () => {
  const result = await run(scenario);
  assert.equal(result.fault, true); assert.equal(result.status.publication, 'not_published'); assert.equal(result.foreignPreserved, true);
  assert.equal(result.ownedPreserved, true); assert.equal(result.targetExists, false); assert.equal(result.unlinkAttempts, 0); assert.equal(result.openDescriptors, 0);
});

test('file mutations: retrying existing-directory creation completes the parent barrier after an earlier sync failure', async () => {
  const result = await run('directory-sync-recovery');
  assert.equal(result.fault, true); assert.equal(result.status.created, true); assert.equal(result.primaryOriginal, true);
  assert.deepEqual(result.syncFault, { code: 'io', operation: 'sync', causeOriginal: true, causeCode: 'EIO' });
  assert.equal(result.sameDirectoryAfterRetry, true); assert.equal(result.recoverySyncAttempts, 1); assert.equal(result.openDescriptors, 0);
});

test('file mutations: uncertain mkdir failure preserves the directory without claiming a confirmed creation', async () => {
  const result = await run('mkdir-after-success');
  assert.equal(result.fault, true); assert.equal(result.status.created, 'unknown'); assert.equal(result.primaryOriginal, true);
  assert.equal(result.directoryExists, true); assert.equal(result.directorySyncAttempts, 1); assert.equal(result.openDescriptors, 0);
});
