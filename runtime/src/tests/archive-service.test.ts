import test from 'node:test';
import assert from 'node:assert/strict';
import type { ArchiveMutation } from '../application/archive-contracts.js';
import { ArchiveService } from '../application/archive-service.js';
import { archiveMutationForTask, createArchiveTools } from '../application/archive-tools.js';
import { asJson } from '../application/plan-validator.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { FileArchiveProvider } from '../infrastructure/file-archive.js';
import { ARCHIVE_CONTENT, ARCHIVE_DESCRIPTOR, ARCHIVE_OWNER, ARCHIVE_POLICY,
  archiveServiceFixture, archiveTask, freshSignal, registration } from './archive-acceptance-fixture.js';

test('archive access requires both source registration and explicit write permission', async t => {
  const readOnly = archiveServiceFixture(t, { access: 'read_only', allowWrites: false });
  await readOnly.file.mutate(registration(), freshSignal());
  assert.equal((await readOnly.service.get(ARCHIVE_POLICY, 'case-1'))?.body, ARCHIVE_CONTENT.body);
  assert.deepEqual(readOnly.tools.map(tool => tool.definition.id), ['archive.search', 'archive.get']);
  await assert.rejects(readOnly.service.mutate(ARCHIVE_POLICY, registration('case-2')), /archive_read_only/);
  const noGrant = archiveServiceFixture(t, { allowWrites: false });
  assert.deepEqual(noGrant.tools.map(tool => tool.definition.id), ['archive.search', 'archive.get']);
  await assert.rejects(noGrant.service.mutate(ARCHIVE_POLICY, registration()), /archive_read_only/);
  const writable = archiveServiceFixture(t);
  assert.deepEqual(writable.tools.map(tool => tool.definition.id), ARCHIVE_POLICY.allowedTools);
  await assert.rejects(writable.service.mutate({ ...ARCHIVE_POLICY, allowWrites: false }, registration()), /archive_read_only/);
  assert.equal((await writable.service.mutate(ARCHIVE_POLICY, registration())).revision, 1);
  assert.equal(readOnly.observed.mutations.length + noGrant.observed.mutations.length, 0);
  assert.equal(writable.observed.mutations.length, 1);
});

test('archive search exposes cards without body and explicit get returns the exact original reference', async t => {
  const f = archiveServiceFixture(t); await f.file.mutate(registration(), freshSignal());
  const search = await f.invoke('search', { query: 'failed rollout', limit: 1, maxBytes: 8192 });
  assert.deepEqual(search.output, { kind: 'archive_reference', provider: 'archive', documents: [{ id: 'case-1', revision: 1,
    status: 'active', title: ARCHIVE_CONTENT.title, path: ARCHIVE_CONTENT.path, sourceVersion: 'source-v1' }], truncated: false });
  assert.equal(JSON.stringify(search.output).includes(ARCHIVE_CONTENT.body), false);
  assert.deepEqual(f.observed.gets, []);
  const full = await f.invoke('get', { id: 'case-1', maxBytes: 8192 });
  assert.deepEqual(full.output, { kind: 'archive_reference', provider: 'archive', document: { ...ARCHIVE_CONTENT, id: 'case-1', revision: 1, status: 'active' } });
  for (const result of [search, full]) {
    assert.equal(result.status, 'success'); assert.equal(result.effectState, 'none');
    assert.deepEqual(result.evidence, []); assert.deepEqual(result.artifacts, []);
  }
  assert.deepEqual(f.observed.gets, ['case-1']); assert.equal(f.observed.mutations.length, 0);
});

test('archive bounded reads distinguish truncated search and oversized original without returning body fragments', async t => {
  const f = archiveServiceFixture(t);
  await f.file.mutate({ ...registration(), kind: 'register', content: { ...ARCHIVE_CONTENT, body: 'private-original:'.repeat(200) } }, freshSignal());
  await f.file.mutate(registration('case-2', 'second'), freshSignal());
  const search = await f.invoke('search', { query: 'case', limit: 1, maxBytes: 8192 });
  assert.equal(search.status, 'partial'); assert.equal(search.coverage, 'partial');
  assert.equal((search.output as { truncated: boolean }).truncated, true);
  const limited = await f.invoke('get', { id: 'case-1', maxBytes: 512 });
  assert.equal(limited.status, 'partial'); assert.equal(limited.coverage, 'partial');
  assert.deepEqual(Object.keys(limited.output as object).sort(), ['byteLength', 'kind', 'status']);
  assert.equal((limited.output as { status: string }).status, 'too_large');
  assert.equal(JSON.stringify(limited.output).includes('private-original'), false);
  assert.equal((await f.invoke('get', { id: 'case-1', maxBytes: 8192 })).status, 'success');
  assert.deepEqual(limited.evidence, []); assert.deepEqual(limited.artifacts, []);
});

test('archive duplicate command reuses its exact durable receipt while changed command content conflicts', async t => {
  const f = archiveServiceFixture(t), command = registration();
  const first = await f.service.mutate(ARCHIVE_POLICY, command), duplicate = await f.service.mutate(ARCHIVE_POLICY, command);
  assert.deepEqual(duplicate, { ...first, duplicate: true });
  assert.equal(first.commandDigest, new Sha256Digester().digest(asJson(command)));
  await assert.rejects(f.service.mutate(ARCHIVE_POLICY, { ...command, kind: 'register', content: { ...ARCHIVE_CONTENT, sourceVersion: 'changed' } }), /archive_idempotency_conflict/);
  await assert.rejects(f.service.mutate(ARCHIVE_POLICY, registration('another-document', command.commandId)), /archive_idempotency_conflict/);
  assert.deepEqual(await f.service.receipt(ARCHIVE_POLICY, command), first);
  assert.equal((await f.file.get('case-1', freshSignal()))?.revision, 1);
  assert.equal(await f.file.get('another-document', freshSignal()), null);
  await assert.rejects(f.service.mutate(ARCHIVE_POLICY, registration('case-1', 'new-command')), /archive_revision_conflict/);
  assert.equal((await f.service.mutate(ARCHIVE_POLICY, registration('same-body-new-id', 'new-id-command'))).revision, 1);
});

test('archive revisions retain source versions and durable receipts after delete and reopen', async t => {
  const f = archiveServiceFixture(t), original = registration();
  const first = await f.service.mutate(ARCHIVE_POLICY, original);
  const revision: ArchiveMutation = { kind: 'revise', id: 'case-1', commandId: 'revise-case', expectedRevision: 1,
    content: { ...ARCHIVE_CONTENT, path: '/source/documents/revised.md', sourceVersion: 'source-v2', body: 'Revised original.' } };
  const second = await f.service.mutate(ARCHIVE_POLICY, revision);
  assert.equal(second.revision, 2);
  assert.deepEqual(await f.service.get(ARCHIVE_POLICY, 'case-1'), { ...revision.content, id: 'case-1', revision: 2, status: 'active' });
  await assert.rejects(f.service.mutate(ARCHIVE_POLICY, { ...revision, commandId: 'stale-revision' }), /archive_revision_conflict/);
  const deletion: ArchiveMutation = { kind: 'delete', id: 'case-1', commandId: 'delete-case', expectedRevision: 2 };
  const third = await f.service.mutate(ARCHIVE_POLICY, deletion);
  assert.equal(third.revision, 3); assert.equal(third.status, 'deleted');
  assert.equal(await f.service.get(ARCHIVE_POLICY, 'case-1'), null);
  assert.deepEqual(await f.service.search(ARCHIVE_POLICY, { query: '', limit: 10 }), { documents: [], truncated: false });
  f.file.close();
  const reopened = new FileArchiveProvider({ root: f.base, owner: ARCHIVE_OWNER, descriptor: ARCHIVE_DESCRIPTOR });
  try {
    assert.equal(await reopened.get('case-1', freshSignal()), null);
    for (const receipt of [first, second, third]) assert.deepEqual(await reopened.receipt(receipt.commandId, freshSignal()), receipt);
    assert.deepEqual(await reopened.mutate(original, freshSignal()), { ...first, duplicate: true });
    await assert.rejects(reopened.mutate(registration('case-1', 'recreate-deleted'), freshSignal()), /archive_revision_conflict/);
  } finally { reopened.close(); }
});

test('archive mutation tool binds command identity to the original work and attempt, never supplied input', async t => {
  const f = archiveServiceFixture(t), input = { id: 'created', expectedRevision: 0, content: ARCHIVE_CONTENT };
  const task = archiveTask('register', input);
  const command = archiveMutationForTask(ARCHIVE_DESCRIPTOR, task, 'archive-work', 'write-attempt');
  assert.equal(command.commandId, JSON.stringify(['archive', 'archive-work', 'write-attempt']));
  const result = await f.invoke('register', input, 'write-attempt');
  assert.deepEqual(f.observed.mutations, [command]);
  assert.deepEqual(result.evidence, []); assert.deepEqual(result.artifacts, []); assert.equal(result.effectReceipt, undefined);
  assert.equal(result.effectState, 'confirmed');
  await assert.rejects(f.invoke('register', { ...input, commandId: 'caller-selected-command' }), /./);
  assert.equal(f.observed.mutations.length, 1);
});

test('archive service rejects mismatched provider receipts without a second mutation', async t => {
  const f = archiveServiceFixture(t), command = registration(); await f.service.mutate(ARCHIVE_POLICY, command);
  const stored = await f.file.receipt(command.commandId, freshSignal()); assert.ok(stored);
  for (const patch of [{ commandId: 'other-command' }, { id: 'other-document' }, { revision: 2 },
    { status: 'deleted' as const }, { commandDigest: '0'.repeat(64) }]) {
    const provider = { ...f.provider, async receipt() { return { ...stored, ...patch }; } };
    const service = new ArchiveService(provider, ARCHIVE_OWNER, freshSignal(), new Sha256Digester(), true);
    await assert.rejects(service.receipt(ARCHIVE_POLICY, command), /archive_result_invalid/);
  }
  assert.equal(f.observed.mutations.length, 1);
  assert.deepEqual(await f.file.receipt(command.commandId, freshSignal()), stored);
  assert.deepEqual(createArchiveTools(f.service, ARCHIVE_POLICY).map(tool => tool.definition.id), ARCHIVE_POLICY.allowedTools);
});
