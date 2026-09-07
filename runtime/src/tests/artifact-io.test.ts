import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ArtifactRef, Policy } from '../domain/model.js';
import { FileArtifactStore, type FileArtifactMetrics } from '../infrastructure/file-artifacts.js';

const attributes = { tenantId: 'synthetic-tenant', labels: ['synthetic', '공개', 'synthetic'], mediaType: 'text/plain' };
const policy: Policy = { tenantId: attributes.tenantId, principalId: 'synthetic-reader', allowedLabels: ['synthetic', '공개'],
  allowedTools: [], allowedDestinations: [], allowWrites: false };
const body = Buffer.from('합성🙂\0내용');
const zero: FileArtifactMetrics = { getCalls: 0, existsCalls: 0, putCalls: 0, metadataReadOperations: 0, metadataReadBytes: 0,
  bodyReadOperations: 0, bodyReadBytes: 0, hashCalls: 0, hashBytes: 0, fileWrites: 0, metadataWriteBytes: 0, bodyWriteBytes: 0,
  readFailures: 0, verificationFailures: 0, deniedReads: 0, writeFailures: 0 };
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const metadataBytes = (ref: ArtifactRef) => Buffer.byteLength(JSON.stringify(ref));
const identity = () => JSON.stringify({ hash: hash(body), tenantId: attributes.tenantId, labels: [...new Set(attributes.labels)].sort(), mediaType: attributes.mediaType });
function metrics(store: FileArtifactStore, expected: Partial<FileArtifactMetrics>) { assert.deepEqual(store.metrics(), { ...zero, ...expected }); }
async function fixture(run: (store: FileArtifactStore, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'secumon-artifact-io-')); const store = new FileArtifactStore(directory);
  try { await run(store, directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('artifact I/O: metrics snapshots are independent and reset does not modify stored artifacts', async () => {
  await fixture(async (store, directory) => {
    metrics(store, {}); const empty = store.metrics(); assert.equal(Object.isFrozen(empty), true);
    const ref = await store.put(body, attributes); const beforeReset = store.metrics(); assert.equal(beforeReset.putCalls, 1);
    assert.deepEqual(empty, zero); store.resetMetrics(); metrics(store, {}); assert.equal(beforeReset.putCalls, 1);
    const reopened = new FileArtifactStore(directory); metrics(reopened, {});
    assert.deepEqual(await reopened.get(ref, policy), body); metrics(store, {});
    assert.equal(reopened.metrics().getCalls, 1); assert.equal(beforeReset.getCalls, 0);
  });
});

test('artifact I/O: first put counts its missing existence probe, exact UTF-8 hashes, and two atomic file writes', async () => {
  await fixture(async (store, directory) => {
    const ref = await store.put(body, attributes);
    assert.equal(ref.sha256, hash(body)); assert.equal(ref.id, hash(identity())); assert.equal(ref.byteLength, body.byteLength);
    assert.deepEqual(ref.labels, ['synthetic', '공개']);
    metrics(store, { putCalls: 1, existsCalls: 1, hashCalls: 2, hashBytes: body.byteLength + Buffer.byteLength(identity()),
      fileWrites: 2, metadataWriteBytes: metadataBytes(ref), bodyWriteBytes: body.byteLength, readFailures: 1, verificationFailures: 1 });
    assert.equal((await stat(join(directory, `${ref.id}.blob`))).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, `${ref.id}.json`))).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(directory)).sort(), [`${ref.id}.blob`, `${ref.id}.json`].sort());
  });
});

test('artifact I/O: duplicate put verifies the existing body and performs no file writes', async () => {
  await fixture(async store => {
    const ref = await store.put(body, attributes); store.resetMetrics();
    assert.deepEqual(await store.put(body, { ...attributes, labels: ['공개', 'synthetic'] }), ref);
    metrics(store, { putCalls: 1, existsCalls: 1, metadataReadOperations: 1, metadataReadBytes: metadataBytes(ref), bodyReadOperations: 1,
      bodyReadBytes: body.byteLength, hashCalls: 3, hashBytes: body.byteLength * 2 + Buffer.byteLength(identity()) });
  });
});

test('artifact I/O: put repairs a corrupt existing object after counting the failed verification', async () => {
  await fixture(async (store, directory) => {
    const ref = await store.put(body, attributes); await writeFile(join(directory, `${ref.id}.blob`), Buffer.alloc(body.byteLength, 0x61)); store.resetMetrics();
    assert.deepEqual(await store.put(body, attributes), ref);
    metrics(store, { putCalls: 1, existsCalls: 1, metadataReadOperations: 1, metadataReadBytes: metadataBytes(ref), bodyReadOperations: 1,
      bodyReadBytes: body.byteLength, hashCalls: 3, hashBytes: body.byteLength * 2 + Buffer.byteLength(identity()), verificationFailures: 1,
      fileWrites: 2, metadataWriteBytes: metadataBytes(ref), bodyWriteBytes: body.byteLength });
    assert.deepEqual(await new FileArtifactStore(directory).get(ref, policy), body);
  });
});

test('artifact I/O: get and exists each perform independent metadata, body, and integrity work under concurrent reads', async () => {
  await fixture(async store => {
    const ref = await store.put(body, attributes); store.resetMetrics();
    const [first, second, exists] = await Promise.all([store.get(ref, policy), store.get(ref, policy), store.exists(ref)]);
    assert.deepEqual(first, body); assert.deepEqual(second, body); assert.equal(exists, true);
    metrics(store, { getCalls: 2, existsCalls: 1, metadataReadOperations: 3, metadataReadBytes: metadataBytes(ref) * 3,
      bodyReadOperations: 3, bodyReadBytes: body.byteLength * 3, hashCalls: 3, hashBytes: body.byteLength * 3 });
  });
});

test('artifact I/O: tenant and label denials count API calls without opening or hashing files', async () => {
  await fixture(async store => {
    const ref = await store.put(body, attributes); store.resetMetrics();
    await assert.rejects(store.get(ref, { ...policy, tenantId: 'other-tenant' }), /artifact_access_denied/);
    await assert.rejects(store.get(ref, { ...policy, allowedLabels: ['synthetic'] }), /artifact_access_denied/);
    metrics(store, { getCalls: 2, deniedReads: 2 });
  });
});

for (const extension of ['json', 'blob'] as const) test(`artifact I/O: missing ${extension} counts failed opens without claiming unread body bytes`, async () => {
  await fixture(async (store, directory) => {
    const ref = await store.put(body, attributes); await rm(join(directory, `${ref.id}.${extension}`)); store.resetMetrics();
    await assert.rejects(store.get(ref, policy), { code: 'ENOENT' }); assert.equal(await store.exists(ref), false);
    metrics(store, { getCalls: 1, existsCalls: 1, readFailures: 2, verificationFailures: 2,
      ...(extension === 'blob' ? { metadataReadOperations: 2, metadataReadBytes: metadataBytes(ref) * 2 } : {}) });
  });
});

test('artifact I/O: invalid metadata is a verification failure after a successful metadata read', async () => {
  await fixture(async (store, directory) => {
    const ref = await store.put(body, attributes); const invalid = Buffer.from('invalid-json');
    await writeFile(join(directory, `${ref.id}.json`), invalid); store.resetMetrics();
    await assert.rejects(store.get(ref, policy), SyntaxError); assert.equal(await store.exists(ref), false);
    metrics(store, { getCalls: 1, existsCalls: 1, metadataReadOperations: 2, metadataReadBytes: invalid.byteLength * 2, verificationFailures: 2 });
  });
});

test('artifact I/O: a metadata reference mismatch stops before body read or hashing', async () => {
  await fixture(async store => {
    const ref = await store.put(body, attributes); store.resetMetrics();
    await assert.rejects(store.get({ ...ref, sha256: 'f'.repeat(64) }, policy), /artifact_reference_mismatch/);
    metrics(store, { getCalls: 1, metadataReadOperations: 1, metadataReadBytes: metadataBytes(ref), verificationFailures: 1 });
  });
});

for (const sameSize of [true, false]) test(`artifact I/O: ${sameSize ? 'same-size tampering hashes the read body' : 'length mismatch preserves the existing hash short circuit'}`, async () => {
  await fixture(async (store, directory) => {
    const ref = await store.put(body, attributes); const damaged = Buffer.alloc(body.byteLength + (sameSize ? 0 : 1), 0x61);
    await writeFile(join(directory, `${ref.id}.blob`), damaged); store.resetMetrics();
    await assert.rejects(store.get(ref, policy), /artifact_integrity_failure/);
    metrics(store, { getCalls: 1, metadataReadOperations: 1, metadataReadBytes: metadataBytes(ref), bodyReadOperations: 1,
      bodyReadBytes: damaged.byteLength, verificationFailures: 1, ...(sameSize ? { hashCalls: 1, hashBytes: damaged.byteLength } : {}) });
  });
});

test('artifact I/O: a body symlink remains unreadable and contributes no target bytes', async () => {
  await fixture(async (store, directory) => {
    const ref = await store.put(body, attributes); const path = join(directory, `${ref.id}.blob`); const target = join(directory, 'synthetic-target');
    await writeFile(target, body); await rm(path); await symlink(target, path); store.resetMetrics();
    await assert.rejects(store.get(ref, policy)); assert.equal(await store.exists(ref), false);
    metrics(store, { getCalls: 1, existsCalls: 1, metadataReadOperations: 2, metadataReadBytes: metadataBytes(ref) * 2, readFailures: 2, verificationFailures: 2 });
  });
});
