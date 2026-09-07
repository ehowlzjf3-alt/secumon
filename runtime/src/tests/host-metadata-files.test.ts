import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { constants as bufferConstants } from 'node:buffer';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { FileBoundaryFault, hostMetadataFiles, metadataFileAllowed, sameFileIdentity, type FileBoundaryCode, type MetadataDirectory, type MetadataReadPolicy } from '../infrastructure/host-metadata-files.js';
import { PosixMetadataFiles } from '../infrastructure/posix-metadata-files.js';

const execute = promisify(execFile);
const worker = fileURLToPath(new URL('./helpers/host-metadata-files-worker.js', import.meta.url));
const policy: MetadataReadPolicy = { maximum: 128, access: 'private' };
const fault = (...codes: FileBoundaryCode[]) => (error: unknown) => error instanceof FileBoundaryFault && codes.includes(error.code);
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'metadata-files-')));
  const root = join(base, 'metadata'); mkdirSync(root, { mode: 0o700 });
  const adapter = new PosixMetadataFiles(); const directory = adapter.inspectDirectory(root, 'private');
  if (!directory) throw new Error('fixture_directory_missing');
  return { base, root, adapter, directory, close: () => rmSync(base, { recursive: true, force: true }) };
}
function put(path: string, bytes: string | Buffer, mode = 0o600) { writeFileSync(path, bytes, { mode }); }
const read = (f: ReturnType<typeof fixture>, name = 'value.json', options: MetadataReadPolicy = policy) => f.adapter.readStableRegularFile(f.directory, name, options);

test('metadata boundary: host dispatch exposes declared POSIX mechanisms and refuses unsupported or emulated hosts', () => {
  const selected = hostMetadataFiles(); assert.equal(selected, hostMetadataFiles());
  assert.deepEqual(selected.capabilities, {
    platform: process.platform, accessControl: 'posix-mode-and-uid', objectAccess: 'path-recheck', directorySync: 'fsync', nativeWindows: 'unimplemented',
  });
  for (const platform of ['win32', 'freebsd', process.platform === 'linux' ? 'darwin' : 'linux'] as NodeJS.Platform[]) {
    assert.throws(() => hostMetadataFiles(platform), fault('unsupported_platform'));
  }
});

test('metadata boundary: missing directories return null; regular files and linked directories are rejected', () => {
  const f = fixture(); try {
    assert.equal(f.adapter.inspectDirectory(join(f.base, 'absent'), 'private'), null);
    put(join(f.base, 'regular'), 'file'); symlinkSync(f.root, join(f.base, 'linked'));
    assert.throws(() => f.adapter.inspectDirectory(join(f.base, 'regular'), 'private'), fault('unsafe'));
    assert.throws(() => f.adapter.inspectDirectory(join(f.base, 'linked'), 'private'), fault('unsafe'));
    assert.ok(sameFileIdentity(f.adapter.inspectDirectory(f.root, 'private', f.directory)!.identity, f.directory.identity));
  } finally { f.close(); }
});

test('metadata boundary: directory access keeps private and owner-writable policies distinct without chmod', () => {
  const f = fixture(); try {
    chmodSync(f.root, 0o755);
    assert.throws(() => f.adapter.inspectDirectory(f.root, 'private'), fault('unsafe'));
    assert.ok(f.adapter.inspectDirectory(f.root, 'owner-writable'));
    chmodSync(f.root, 0o777);
    assert.throws(() => f.adapter.inspectDirectory(f.root, 'owner-writable'), fault('unsafe'));
    assert.equal(lstatSync(f.root).mode & 0o777, 0o777);
  } finally { f.close(); }
});

test('metadata boundary: public parent traversal permits a private file without weakening its access policy', () => {
  const f = fixture(); try {
    chmodSync(f.root, 0o755); put(join(f.root, 'value.json'), 'private value');
    const parent = f.adapter.inspectDirectory(f.root, 'traverse'); assert.ok(parent);
    assert.equal(f.adapter.readStableRegularFile(parent, 'value.json', policy).toString(), 'private value');
    chmodSync(join(f.root, 'value.json'), 0o644);
    assert.throws(() => f.adapter.readStableRegularFile(parent, 'value.json', policy), fault('unsafe'));
    f.adapter.syncDirectory(parent);
    const sync = f.adapter.inspectDirectory(f.root, 'sync'); assert.ok(sync); f.adapter.syncDirectory(sync);
    assert.throws(() => f.adapter.readStableRegularFile(sync, 'value.json', { ...policy, access: 'owner-writable' }), fault('invalid_request', 'unsafe'));
  } finally { f.close(); }
});

test('metadata boundary: files enforce their own access policy and preserve original bytes and permissions', () => {
  const f = fixture(); try {
    const path = join(f.root, 'value.json'); put(path, 'original'); assert.equal(read(f).toString(), 'original');
    chmodSync(path, 0o644); assert.throws(() => read(f), fault('unsafe'));
    assert.equal(read(f, 'value.json', { ...policy, access: 'owner-writable' }).toString(), 'original');
    chmodSync(path, 0o666); assert.throws(() => read(f, 'value.json', { ...policy, access: 'owner-writable' }), fault('unsafe'));
    assert.equal(lstatSync(path).mode & 0o777, 0o666); assert.equal(readFileSync(path, 'utf8'), 'original');
  } finally { f.close(); }
});

test('metadata boundary: only a missing read has missing code and its original ENOENT cause', () => {
  const f = fixture(); try {
    assert.throws(() => read(f), (error: unknown) => error instanceof FileBoundaryFault && error.code === 'missing' &&
      (error.cause as NodeJS.ErrnoException)?.code === 'ENOENT');
    mkdirSync(join(f.root, 'value.json'), { mode: 0o700 }); assert.throws(() => read(f), fault('unsafe'));
    rmSync(join(f.root, 'value.json'), { recursive: true }); put(join(f.base, 'outside'), 'outside'); symlinkSync(join(f.base, 'outside'), join(f.root, 'value.json'));
    assert.throws(() => read(f), fault('unsafe'));
  } finally { f.close(); }
});

test('metadata boundary: named pipes are rejected without waiting for a writer', async () => {
  const f = fixture(); try {
    await execute('mkfifo', ['-m', '600', join(f.root, 'value.json')], { timeout: 15000 });
    const result = JSON.parse((await execute(process.execPath, [worker, f.root, 'fifo'], { timeout: 15000 })).stdout);
    assert.equal(result.code, 'unsafe'); assert.equal(result.openDescriptors, 0); assert.equal(result.reads, 0);
  } finally { f.close(); }
});

test('metadata boundary: maximum counts bytes and includes exact, one-over and empty zero-byte cases', () => {
  const f = fixture(); try {
    const path = join(f.root, 'value.json'); put(path, Buffer.from([0, 1, 2, 255]));
    assert.deepEqual(read(f, 'value.json', { maximum: 4, access: 'private' }), Buffer.from([0, 1, 2, 255]));
    assert.throws(() => read(f, 'value.json', { maximum: 3, access: 'private' }), fault('too_large'));
    put(path, ''); assert.deepEqual(read(f, 'value.json', { maximum: 0, access: 'private' }), Buffer.alloc(0));
    put(path, 'x'); assert.throws(() => read(f, 'value.json', { maximum: 0, access: 'private' }), fault('too_large'));
  } finally { f.close(); }
});

test('metadata boundary: invalid maximums fail before allocating or reading data', () => {
  const f = fixture(); try {
    put(join(f.root, 'value.json'), 'small');
    for (const maximum of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, bufferConstants.MAX_LENGTH + 1]) {
      assert.throws(() => read(f, 'value.json', { maximum, access: 'private' }), fault('invalid_request'));
    }
  } finally { f.close(); }
});

test('metadata boundary: a leaf may contain Unicode and spaces but cannot traverse directories', () => {
  const f = fixture(); try {
    const name = '담당 메타 데이터.json'; put(join(f.root, name), 'unicode'); assert.equal(read(f, name).toString(), 'unicode');
    for (const invalid of ['', '.', '..', '../outside', 'nested/value.json', '\\outside', 'nested\\value.json', '/value.json', 'bad\u0000name']) {
      assert.throws(() => read(f, invalid), fault('invalid_request'));
    }
  } finally { f.close(); }
});

test('metadata boundary: copied, fabricated and foreign adapter directory references cannot authorize access', () => {
  const f = fixture(); try {
    put(join(f.root, 'value.json'), 'value');
    const foreign = new PosixMetadataFiles().inspectDirectory(f.root, 'private'); assert.ok(foreign);
    const references: MetadataDirectory[] = [foreign, { identity: { ...f.directory.identity } }, { ...f.directory }];
    for (const reference of references) {
      assert.throws(() => f.adapter.readStableRegularFile(reference, 'value.json', policy), fault('invalid_request'));
      assert.throws(() => f.adapter.syncDirectory(reference), fault('invalid_request'));
      assert.throws(() => f.adapter.inspectDirectory(f.root, 'private', reference), fault('invalid_request'));
    }
  } finally { f.close(); }
});

test('metadata boundary: an issued directory reference detects replacement before read, sync and reinspection', () => {
  const f = fixture(); try {
    put(join(f.root, 'value.json'), 'original'); renameSync(f.root, join(f.base, 'original-directory'));
    mkdirSync(f.root, { mode: 0o700 }); put(join(f.root, 'value.json'), 'replacement');
    assert.throws(() => read(f), fault('changed'));
    assert.throws(() => f.adapter.syncDirectory(f.directory), fault('changed'));
    assert.throws(() => f.adapter.inspectDirectory(f.root, 'private', f.directory), fault('changed'));
    assert.equal(readFileSync(join(f.root, 'value.json'), 'utf8'), 'replacement');
  } finally { f.close(); }
});

test('metadata boundary: issued directory access is rechecked after permissions change', () => {
  const f = fixture(); try {
    put(join(f.root, 'value.json'), 'private'); chmodSync(f.root, 0o777);
    assert.throws(() => read(f), fault('unsafe')); assert.throws(() => f.adapter.syncDirectory(f.directory), fault('unsafe'));
  } finally { f.close(); }
});

test('metadata boundary: external hard links are rejected and a matching sibling publication pair can be allowed', () => {
  const f = fixture(); try {
    const path = join(f.root, 'value.json'); const outside = join(f.base, 'external'); put(path, 'linked'); linkSync(path, outside);
    assert.throws(() => read(f), fault('unsafe'));
    const allowLinkedFile: NonNullable<MetadataReadPolicy['allowLinkedFile']> = (file, siblings) => {
      for (const name of siblings.names()) {
        if (name !== 'publication.pending') continue;
        const pending = siblings.inspect(name);
        if (pending && file.links === 2n && pending.links === 2n && metadataFileAllowed(pending, 'private') && sameFileIdentity(file.identity, pending.identity)) return true;
      }
      return false;
    };
    put(join(f.root, 'publication.pending'), 'unrelated');
    assert.throws(() => read(f, 'value.json', { ...policy, allowLinkedFile }), fault('unsafe'));
    unlinkSync(outside); unlinkSync(join(f.root, 'publication.pending')); linkSync(path, join(f.root, 'publication.pending'));
    assert.equal(read(f, 'value.json', { ...policy, allowLinkedFile }).toString(), 'linked');
  } finally { f.close(); }
});

test('metadata boundary: publication link removal during policy observation retries the stable single-link file', () => {
  const f = fixture(); try {
    const path = join(f.root, 'value.json'); const pending = join(f.root, 'publication.pending'); put(path, 'published'); linkSync(path, pending);
    let calls = 0;
    const bytes = read(f, 'value.json', { ...policy, allowLinkedFile: () => { calls += 1; unlinkSync(pending); return false; } });
    assert.equal(bytes.toString(), 'published'); assert.equal(calls, 1); assert.equal(lstatSync(path).nlink, 1);
  } finally { f.close(); }
});

test('metadata boundary: sibling inspection cannot escape its issued directory', () => {
  const f = fixture(); try {
    const path = join(f.root, 'value.json'); put(path, 'published'); linkSync(path, join(f.root, 'publication.pending'));
    assert.throws(() => read(f, 'value.json', { ...policy, allowLinkedFile: (_file, siblings) => { siblings.inspect('../outside'); return true; } }), fault('invalid_request'));
  } finally { f.close(); }
});

for (const scenario of ['changed-once', 'changed-twice', 'replaced-once', 'directory-replaced', 'grew-over-limit', 'read-error', 'sync-error', 'foreign-file-uid', 'foreign-directory-uid', 'policy-error'] as const) {
  test(`metadata boundary: isolated ${scenario} observation preserves stable-read and descriptor cleanup contracts`, async () => {
    const f = fixture(); try {
      const result = JSON.parse((await execute(process.execPath, [worker, f.root, scenario], { timeout: 15000 })).stdout);
      assert.equal(result.scenario, scenario); assert.equal(result.openDescriptors, 0); assert.equal(result.opens, result.closes);
      if (scenario === 'changed-once' || scenario === 'replaced-once') {
        assert.equal(result.value, 'new bytes'); assert.equal(result.opens, 2); assert.equal(result.code, null);
      } else if (scenario === 'changed-twice') {
        assert.equal(result.code, 'changed'); assert.equal(result.opens, 2);
      } else if (scenario === 'directory-replaced') {
        assert.equal(result.code, 'changed'); assert.equal(result.opens, 1);
      } else if (scenario === 'grew-over-limit') {
        assert.equal(result.code, 'too_large'); assert.equal(result.opens, 2);
      } else if (scenario === 'read-error' || scenario === 'sync-error') {
        assert.equal(result.code, 'io'); assert.equal(result.causeCode, 'EIO'); assert.equal(result.opens, 1);
      } else if (scenario === 'foreign-file-uid' || scenario === 'foreign-directory-uid') {
        assert.equal(result.code, 'unsafe'); assert.equal(result.reads, 0);
      } else assert.equal(result.message, 'policy_failure');
    } finally { f.close(); }
  });
}
