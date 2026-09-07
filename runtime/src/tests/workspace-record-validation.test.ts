import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceError } from '../application/workspace-checkpoints.js';
import type { WorkspaceFile } from '../domain/workspace.js';
import { FileWorkspaceStore } from '../infrastructure/file-workspaces.js';
import { sha256 } from '../infrastructure/digest.js';

const workId = 'record-work'; const attemptId = 'record-attempt'; const logicalPath = 'report.bin';
const attributes = { tenantId: 'tenant-a', labels: ['synthetic'], lifecycleGeneration: 0 };
type StoredRecord = { schemaVersion: number; file: WorkspaceFile; contentBase64: string; checksum: string };
const fault = (code: string) => (error: unknown) => error instanceof WorkspaceError && error.code === code;
async function fixture(content = Buffer.from([0]), maxFileBytes = 4) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-record-validation-'))); const root = join(base, 'workspace');
  let store: FileWorkspaceStore | undefined;
  try {
    store = new FileWorkspaceStore(root, { maxFileBytes });
    const file = await store.stage(workId, attemptId, logicalPath, content, attributes);
    const attempt = join(root, sha256(workId), sha256(attemptId)); const folder = join(attempt, 'files');
    return { base, root, folder, lock: join(attempt, '.lock'), stored: join(folder, `${sha256(logicalPath)}.json`),
      store, file, content, maxFileBytes, serializedLimit: Math.ceil(maxFileBytes * 4 / 3) + 65536,
      async close() { try { await store!.close(); } finally { rmSync(base, { recursive: true, force: true }); } } };
  } catch (error) {
    try { await store?.close(); } finally { rmSync(base, { recursive: true, force: true }); }
    throw error;
  }
}
function parseStored(path: string): StoredRecord { return JSON.parse(readFileSync(path, 'utf8')) as StoredRecord; }
function signed(record: StoredRecord): Buffer {
  // Re-signing isolates inner validation from the outer checksum check, including schema-invalid cases.
  const payload: Record<string, unknown> = { ...record }; delete payload.checksum;
  return Buffer.from(JSON.stringify({ ...payload, checksum: sha256(JSON.stringify(payload)) }));
}
async function rejectedBoth(f: Awaited<ReturnType<typeof fixture>>, readCode: string, listCode = readCode, requestedPath = logicalPath, stored = f.stored) {
  const before = readFileSync(stored);
  await assert.rejects(f.store.read(workId, attemptId, requestedPath), fault(readCode));
  await assert.rejects(f.store.list(workId, attemptId), fault(listCode));
  assert.deepEqual(readFileSync(stored), before); assert.equal(existsSync(f.lock), false);
}

test('workspace record: exact serialized limit accepts JSON whitespace without rewriting it and one extra byte retains read/list error distinction', async () => {
  const content = Buffer.from([0, 127, 128, 255]); const f = await fixture(content);
  try {
    assert.equal(content.length, f.maxFileBytes);
    const original = readFileSync(f.stored); assert.ok(original.length < f.serializedLimit);
    const exact = Buffer.concat([original, Buffer.alloc(f.serializedLimit - original.length, 0x20)]);
    writeFileSync(f.stored, exact); assert.equal(lstatSync(f.stored).size, f.serializedLimit);
    assert.deepEqual(Buffer.from((await f.store.read(workId, attemptId, logicalPath)).bytes), content);
    assert.deepEqual(await f.store.list(workId, attemptId), [f.file]); assert.deepEqual(readFileSync(f.stored), exact);
    writeFileSync(f.stored, Buffer.concat([exact, Buffer.from(' ')]));
    await rejectedBoth(f, 'workspace_file_too_large', 'workspace_file_unsafe');
  } finally { await f.close(); }
});

test('workspace record: a valid self-consistent raw payload above its bound is too large for both read and list', async () => {
  const f = await fixture(Buffer.from([0, 1, 2, 3]));
  try {
    const record = parseStored(f.stored); const oversized = Buffer.from([0, 1, 2, 3, 4]);
    record.contentBase64 = oversized.toString('base64'); record.file.byteLength = oversized.length; record.file.sha256 = sha256(oversized);
    const serialized = signed(record); assert.ok(serialized.length < f.serializedLimit); writeFileSync(f.stored, serialized);
    await rejectedBoth(f, 'workspace_file_too_large');
  } finally { await f.close(); }
});

test('workspace record: canonical empty content remains a valid read and listed file', async () => {
  const f = await fixture(Buffer.alloc(0));
  try {
    assert.equal(parseStored(f.stored).contentBase64, ''); assert.equal(f.file.byteLength, 0);
    assert.deepEqual(Buffer.from((await f.store.read(workId, attemptId, logicalPath)).bytes), Buffer.alloc(0));
    assert.deepEqual(await f.store.list(workId, attemptId), [f.file]);
  } finally { await f.close(); }
});

for (const corruption of ['checksum', 'base64-whitespace', 'base64-missing-padding', 'base64-nonzero-padbits', 'byte-length',
  'content-sha', 'schema-version', 'schema-extra-record', 'schema-extra-file', 'schema-path', 'json'] as const) {
  test(`workspace record: ${corruption} is rejected after stable read by both entry points`, async () => {
    const f = await fixture();
    try {
      const record = parseStored(f.stored);
      if (corruption === 'checksum') record.checksum = '0'.repeat(64);
      if (corruption === 'base64-whitespace') record.contentBase64 = 'AA==\n';
      if (corruption === 'base64-missing-padding') record.contentBase64 = 'AA';
      if (corruption === 'base64-nonzero-padbits') record.contentBase64 = 'AB==';
      if (corruption.startsWith('base64-')) {
        assert.deepEqual(Buffer.from(record.contentBase64, 'base64'), f.content);
        assert.notEqual(record.contentBase64, f.content.toString('base64'));
      }
      if (corruption === 'byte-length') record.file.byteLength++;
      if (corruption === 'content-sha') record.file.sha256 = 'f'.repeat(64);
      if (corruption === 'schema-version') record.schemaVersion = 2;
      if (corruption === 'schema-extra-record') Object.assign(record, { unexpected: true });
      if (corruption === 'schema-extra-file') Object.assign(record.file, { unexpected: true });
      if (corruption === 'schema-path') record.file.path = '../outside';
      const serialized = corruption === 'json' ? Buffer.from('{"schemaVersion":') :
        corruption === 'checksum' ? Buffer.from(JSON.stringify(record)) : signed(record);
      writeFileSync(f.stored, serialized);
      await rejectedBoth(f, 'workspace_file_integrity_failure');
    } finally { await f.close(); }
  });
}

for (const mismatch of ['work', 'attempt', 'path', 'filename', 'filename-before-checksum'] as const) {
  test(`workspace record: ${mismatch} binds metadata to its requested scope and physical filename`, async () => {
    const f = await fixture();
    try {
      const record = parseStored(f.stored); let requestedPath = logicalPath; let stored = f.stored;
      if (mismatch === 'work') record.file.workId = 'another-work';
      if (mismatch === 'attempt') record.file.attemptId = 'another-attempt';
      if (mismatch === 'path') record.file.path = 'another.bin';
      if (mismatch === 'filename' || mismatch === 'filename-before-checksum') {
        requestedPath = 'another.bin'; stored = join(f.folder, `${sha256(requestedPath)}.json`); renameSync(f.stored, stored);
      }
      const serialized = signed(record);
      if (mismatch === 'filename-before-checksum') {
        const broken = JSON.parse(serialized.toString('utf8')) as StoredRecord; broken.checksum = '0'.repeat(64);
        writeFileSync(stored, JSON.stringify(broken));
      } else writeFileSync(stored, serialized);
      await rejectedBoth(f, mismatch === 'filename-before-checksum' ? 'workspace_file_integrity_failure' : 'workspace_file_identity_mismatch',
        'workspace_file_identity_mismatch', requestedPath, stored);
    } finally { await f.close(); }
  });
}

test('workspace record: three external aliases preserve existing unrestricted hardlink read/list/stage and targeted removal', async () => {
  const f = await fixture(Buffer.from([0, 255]));
  try {
    const aliases = [1, 2, 3].map(index => join(f.base, `outside-${index}.json`)); const original = readFileSync(f.stored);
    for (const alias of aliases) linkSync(f.stored, alias);
    assert.equal(lstatSync(f.stored).nlink, 4);
    assert.deepEqual(Buffer.from((await f.store.read(workId, attemptId, logicalPath)).bytes), f.content);
    assert.deepEqual(await f.store.list(workId, attemptId), [f.file]);
    assert.deepEqual(await f.store.stage(workId, attemptId, logicalPath, f.content, attributes), f.file);
    assert.equal(lstatSync(f.stored).nlink, 4); await f.store.removeAttempt(workId, attemptId, [f.file]);
    assert.equal(existsSync(f.stored), false); assert.deepEqual(await f.store.list(workId, attemptId), []);
    for (const alias of aliases) { assert.deepEqual(readFileSync(alias), original); assert.equal(lstatSync(alias).nlink, 3); }
  } finally { await f.close(); }
});

for (const entry of ['unrelated.pending', 'unrelated.txt'] as const) {
  test(`workspace record: ${entry} blocks aggregate operations without broadening the single-file read`, async () => {
    const f = await fixture();
    try {
      const extra = join(f.folder, entry); const extraBytes = Buffer.from('preserve this unrelated entry');
      writeFileSync(extra, extraBytes, { mode: 0o600 }); const original = readFileSync(f.stored); const names = readdirSync(f.folder).sort();
      const code = entry.endsWith('.pending') ? 'workspace_incomplete_write' : 'workspace_layout_invalid';
      assert.deepEqual(Buffer.from((await f.store.read(workId, attemptId, logicalPath)).bytes), f.content);
      await assert.rejects(f.store.list(workId, attemptId), fault(code));
      await assert.rejects(f.store.stage(workId, attemptId, 'next.bin', f.content, attributes), fault(code));
      await assert.rejects(f.store.removeAttempt(workId, attemptId, [f.file]), fault(code));
      assert.deepEqual(readFileSync(f.stored), original); assert.deepEqual(readFileSync(extra), extraBytes);
      assert.deepEqual(readdirSync(f.folder).sort(), names); assert.equal(existsSync(f.lock), false);
    } finally { await f.close(); }
  });
}
