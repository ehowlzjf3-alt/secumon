import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DocumentKnowledgeRepository, inspectDocumentKnowledgeStore, registerDocumentKnowledgeStore } from '../infrastructure/document-knowledge.js';
import { documentNamespaceName } from '../infrastructure/document-knowledge-codec.js';
import { storageFixture, ownerScope, personalRecord, correctedRecord, storageCommand, personalActor, personalQuery } from './personal-knowledge-storage-helpers.js';

test('document storage requires explicit registration, preserves a 0755 supplied parent and pins copied owner binding', async () => {
  const f = storageFixture(), directory = join(f.directory, 'memory', 'documents');
  const binding = { agentId: f.agentId, storeId: 'document-store', root: f.directory };
  let repository: DocumentKnowledgeRepository | undefined;
  try {
    chmodSync(f.directory, 0o755);
    assert.equal(inspectDocumentKnowledgeStore(directory, binding), 'missing');
    assert.throws(() => new DocumentKnowledgeRepository(directory, binding), /document_knowledge_store_missing/);
    assert.equal(existsSync(directory), false);
    registerDocumentKnowledgeStore(directory, binding);
    const owner = readFileSync(join(directory, 'owner.json'));
    registerDocumentKnowledgeStore(directory, binding);
    assert.deepEqual(readFileSync(join(directory, 'owner.json')), owner);
    assert.equal(statSync(f.directory).mode & 0o777, 0o755); assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(inspectDocumentKnowledgeStore(directory, binding), 'registered');
    assert.throws(() => registerDocumentKnowledgeStore(directory, { ...binding, agentId: f.otherAgentId }), /document_knowledge_owner_mismatch/);
    assert.throws(() => new DocumentKnowledgeRepository(directory, { ...binding, storeId: 'foreign-store' }), /document_knowledge_owner_mismatch/);
    repository = new DocumentKnowledgeRepository(directory, binding); binding.agentId = f.otherAgentId;
    const record = personalRecord(f.agentId), scope = ownerScope(f.agentId);
    assert.deepEqual(await repository.commit(storageCommand(record, 'create', scope)), { kind: 'committed', revision: 1 });
    assert.deepEqual(await repository.get('tenant-a', record.id, scope), record);
    assert.equal(existsSync(f.path), false);
  } finally { await repository?.close(); f.close(); }
});

test('Markdown record and receipt survive reopen, exact text, revision CAS, correction and forgetting without resurrection', async () => {
  const f = storageFixture(), directory = join(f.directory, 'documents'), binding = { agentId: f.agentId, storeId: 'store' }, scope = ownerScope(f.agentId);
  registerDocumentKnowledgeStore(directory, binding);
  let repository = new DocumentKnowledgeRepository(directory, binding); const other = new DocumentKnowledgeRepository(directory, binding);
  try {
    const record = personalRecord(f.agentId, 'user-a', 'tenant-a', '# 사용자 발언\n\n<!-- 문서 -->\n정확한 끝 공백  \n');
    const first = storageCommand(record, 'first', scope);
    assert.deepEqual(await repository.commit(first), { kind: 'committed', revision: 1 });
    assert.deepEqual(await repository.indexHead('tenant-a', 'personal', scope), { revision: 1, cursor: 1, error: null });
    assert.deepEqual(await repository.candidates(personalActor(f.agentId), personalQuery, 5, scope), { ids: [record.id], truncated: false });
    const ns = join(directory, documentNamespaceName({ tenantId: 'tenant-a', ...scope, namespace: 'personal' }));
    const bytes = readFileSync(join(ns, '00000001.md'), 'utf8'); assert.ok(bytes.endsWith(record.body)); assert.match(bytes, /"commandId":"first"/);
    assert.equal(readdirSync(ns).filter(name => name.endsWith('.md')).length, 1);
    await repository.close(); repository = new DocumentKnowledgeRepository(directory, binding);
    assert.deepEqual(await repository.get('tenant-a', record.id, scope), record);
    assert.deepEqual(await repository.receipt('tenant-a', record.id, 'first', scope), { digest: first.commandDigest, revision: 1 });
    assert.deepEqual(await repository.commit(first), { kind: 'duplicate', revision: 1 });
    assert.deepEqual(await repository.commit({ ...first, commandDigest: 'f'.repeat(64) }), { kind: 'idempotency_conflict' });
    const corrected = correctedRecord(record);
    assert.deepEqual(await other.commit(storageCommand(corrected, 'correct', scope)), { kind: 'committed', revision: 2 });
    assert.deepEqual(await repository.commit(storageCommand(correctedRecord(record, '늦은 정정'), 'late', scope)), { kind: 'conflict', actualRevision: 2 });
    const forgotten = { ...corrected, revision: 3, updatedAt: 120, status: 'deleted' as const, body: '', sources: corrected.sources.map(source =>
      source.type === 'session_user_receipt' ? { ...source, quote: '' } : source) };
    await repository.commit(storageCommand(forgotten, 'forget', scope));
    assert.deepEqual(await repository.candidates(personalActor(f.agentId), personalQuery, 5, scope), { ids: [], truncated: false });
    assert.deepEqual(await repository.commit(first), { kind: 'duplicate', revision: 1 });
    assert.equal((await other.get('tenant-a', record.id, scope))?.status, 'deleted');
    await assert.rejects(repository.commit(storageCommand({ ...corrected, revision: 4, contentRevision: 3, updatedAt: 121 }, 'revive', scope)), /invalid_knowledge_transition/);
  } finally { await repository.close(); await other.close(); f.close(); }
});

test('document namespaces isolate tenant, principal, refs, receipts and index error/rebuild state', async () => {
  const f = storageFixture(), directory = join(f.directory, 'documents'), binding = { agentId: f.agentId, storeId: 'store' };
  registerDocumentKnowledgeStore(directory, binding); const repository = new DocumentKnowledgeRepository(directory, binding);
  try {
    for (const tenant of ['tenant-a', 'tenant-b']) for (const user of ['user-a', 'user-b']) {
      const record = personalRecord(f.agentId, user, tenant, `${tenant}/${user}의 선호`), scope = ownerScope(f.agentId, user);
      await repository.commit(storageCommand(record, 'same-command', scope));
      assert.equal((await repository.get(tenant, record.id, scope))?.body, record.body);
    }
    const scope = ownerScope(f.agentId); await repository.markIndexError('tenant-a', 'personal', 'index_read_failed', scope);
    assert.deepEqual(await repository.indexHead('tenant-a', 'personal', scope), { revision: 1, cursor: 1, error: 'index_read_failed' });
    assert.deepEqual(await repository.indexHead('tenant-a', 'personal', ownerScope(f.agentId, 'user-b')), { revision: 1, cursor: 1, error: null });
    assert.deepEqual(await repository.indexHead('tenant-b', 'personal', scope), { revision: 1, cursor: 1, error: null });
    const old = (await repository.get('tenant-a', 'same-memory', scope))!;
    await repository.commit(storageCommand(correctedRecord(old), 'correct', scope));
    assert.deepEqual(await repository.indexHead('tenant-a', 'personal', scope), { revision: 2, cursor: 1, error: 'index_read_failed' });
    const second = new DocumentKnowledgeRepository(directory, binding);
    try { assert.deepEqual(await second.rebuildIndex('tenant-a', 'personal', scope), { revision: 2, cursor: 2, error: null }); }
    finally { await second.close(); }
    assert.equal((await repository.receipt('tenant-a', old.id, 'correct', ownerScope(f.agentId, 'user-b'))), null);
    await assert.rejects(repository.get('tenant-a', old.id), /knowledge_scope_required/);
    await assert.rejects(repository.get('tenant-a', old.id, { agentId: f.agentId, partition: 'work' }), /knowledge_scope_mismatch/);
    await assert.rejects(repository.get('tenant-a', old.id, ownerScope(f.otherAgentId)), /knowledge_scope_mismatch/);
    await assert.rejects(repository.candidates(personalActor(f.agentId, 'user-b'), personalQuery, 5, scope), /knowledge_scope_mismatch/);
    await assert.rejects(repository.candidates(personalActor(f.otherAgentId), personalQuery, 5, scope), /knowledge_scope_mismatch/);
  } finally { await repository.close(); f.close(); }
});

test('document candidate ordering, maximum and private labels follow the existing personal repository contract', async () => {
  const f = storageFixture(), directory = join(f.directory, 'documents'), binding = { agentId: f.agentId, storeId: 'store' }, scope = ownerScope(f.agentId);
  registerDocumentKnowledgeStore(directory, binding); const repository = new DocumentKnowledgeRepository(directory, binding);
  try {
    for (const id of ['b', 'a', 'c']) {
      const record = { ...personalRecord(f.agentId), id, ...(id === 'c' ? { labels: ['private-label'] } : {}) };
      await repository.commit(storageCommand(record, id, scope));
    }
    assert.deepEqual(await repository.candidates(personalActor(f.agentId), personalQuery, 1, scope), { ids: ['a'], truncated: true });
    assert.deepEqual(await repository.candidates(personalActor(f.agentId), personalQuery, 3, scope), { ids: ['a', 'b'], truncated: false });
    assert.deepEqual(await repository.candidates({ ...personalActor(f.agentId), allowedLabels: ['private-label'] }, personalQuery, 3, scope), { ids: ['a', 'b', 'c'], truncated: false });
    await assert.rejects(repository.candidates(personalActor(f.agentId), { ...personalQuery, kinds: [] }, 3, scope), /knowledge_scope_mismatch/);
  } finally { await repository.close(); f.close(); }
});
