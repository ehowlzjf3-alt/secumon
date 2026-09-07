import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { scopedKnowledgeRepository } from '../application/knowledge-ports.js';
import { SqliteKnowledgeRepository } from '../infrastructure/sqlite-knowledge.js';
import { registerSharedKnowledgeStore } from '../infrastructure/sqlite-knowledge-owner.js';
import { storageFixture, ownerScope, personalRecord, storageCommand, personalActor, personalQuery, correctedRecord } from './personal-knowledge-storage-helpers.js';

const tableCount = (db: DatabaseSync, name: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${name}`).get()?.['n']);

test('personal commit indexes immediately, survives reopen, uses CAS and retains receipts after forgetting', async () => {
  const f = storageFixture(); f.bind(); const scope = ownerScope(f.agentId); const next = personalRecord(f.agentId);
  let store = new SqliteKnowledgeRepository(f.path, { mode: 'agent', agentId: f.agentId });
  try {
    assert.deepEqual(await store.commit(storageCommand(next, 'create', scope)), { kind: 'committed', revision: 1 });
    assert.deepEqual(await store.indexHead('tenant-a', 'personal', scope), { revision: 1, cursor: 1, error: null });
    assert.deepEqual(await store.candidates(personalActor(f.agentId), personalQuery, 5, scope), { ids: [next.id], truncated: false });
    await store.close(); store = new SqliteKnowledgeRepository(f.path, { mode: 'agent', agentId: f.agentId });
    assert.deepEqual(await store.get('tenant-a', next.id, scope), next);
    const second = new SqliteKnowledgeRepository(f.path, { mode: 'agent', agentId: f.agentId });
    const correction = correctedRecord(next);
    try {
      assert.deepEqual(await store.commit(storageCommand(correction, 'correct', scope)), { kind: 'committed', revision: 2 });
      assert.deepEqual(await second.commit(storageCommand(correctedRecord(next, 'stale candidate'), 'late', scope)), { kind: 'conflict', actualRevision: 2 });
    } finally { await second.close(); }
    const deleted = { ...correction, revision: 3, updatedAt: 112, status: 'deleted' as const, title: '[deleted]', body: '' };
    assert.deepEqual(await store.commit(storageCommand(deleted, 'forget', scope)), { kind: 'committed', revision: 3 });
    assert.deepEqual(await store.commit(storageCommand(next, 'create', scope)), { kind: 'duplicate', revision: 1 });
    assert.equal((await store.get('tenant-a', next.id, scope))?.status, 'deleted');
    assert.deepEqual(await store.candidates(personalActor(f.agentId), personalQuery, 5, scope), { ids: [], truncated: false });
    assert.deepEqual(await store.indexHead('tenant-a', 'personal', scope), { revision: 3, cursor: 3, error: null });
    assert.equal((await store.receipt('tenant-a', next.id, 'create', scope))?.revision, 1);
    const db = new DatabaseSync(f.path, { readOnly: true });
    try {
      const row = db.prepare("SELECT audit_body FROM knowledge_receipts_v2 WHERE command_id='correct'").get();
      const audit = JSON.parse(String(row?.['audit_body']));
      assert.equal(audit.expectedRevision, 1); assert.equal(audit.revision, 2);
      assert.equal(audit.previousSources[0].messageId, 'message-a'); assert.equal(audit.sources[0].messageId, 'message-2');
      assert.equal(tableCount(db, 'knowledge_receipts_v2'), 3); assert.equal(tableCount(db, 'knowledge_index_v2'), 0);
    } finally { db.close(); }
  } finally { await store.close(); f.close(); }
});

test('shared handles isolate identical IDs, receipts, heads and indexes across agents, users and tenants', async () => {
  const f = storageFixture(); registerSharedKnowledgeStore(f.path, { storeId: 'shared-memory', agentIds: [f.agentId, f.otherAgentId] });
  const a = new SqliteKnowledgeRepository(f.path, { mode: 'shared', storeId: 'shared-memory', agentId: f.agentId });
  const b = new SqliteKnowledgeRepository(f.path, { mode: 'shared', storeId: 'shared-memory', agentId: f.otherAgentId });
  try {
    const values = [[a, f.agentId, 'user-a', 'tenant-a'], [a, f.agentId, 'user-b', 'tenant-a'],
      [b, f.otherAgentId, 'user-a', 'tenant-a'], [a, f.agentId, 'user-a', 'tenant-b']] as const;
    for (const [store, agent, user, tenant] of values) {
      const scope = ownerScope(agent, user); const value = personalRecord(agent, user, tenant, `${agent}/${user}/${tenant}`);
      assert.equal((await store.commit(storageCommand(value, 'same-command', scope))).kind, 'committed');
    }
    for (const [store, agent, user, tenant] of values) {
      const scope = ownerScope(agent, user); const actor = personalActor(agent, user, tenant);
      assert.equal((await store.get(tenant, 'same-memory', scope))?.body, `${agent}/${user}/${tenant}`);
      assert.equal((await store.receipt(tenant, 'same-memory', 'same-command', scope))?.revision, 1);
      assert.deepEqual(await store.candidates(actor, personalQuery, 5, scope), { ids: ['same-memory'], truncated: false });
      assert.deepEqual(await store.indexHead(tenant, 'personal', scope), { revision: 1, cursor: 1, error: null });
    }
    const scope = ownerScope(f.agentId); await a.markIndexError('tenant-a', 'personal', 'index_read_failed', scope);
    assert.equal((await a.indexHead('tenant-a', 'personal', ownerScope(f.agentId, 'user-b'))).error, null);
    assert.equal((await b.indexHead('tenant-a', 'personal', ownerScope(f.otherAgentId))).error, null);
    assert.equal((await a.indexHead('tenant-b', 'personal', scope)).error, null);
    await b.rebuildIndex('tenant-a', 'personal', ownerScope(f.otherAgentId));
    assert.equal((await a.indexHead('tenant-a', 'personal', scope)).error, 'index_read_failed');
    const corrected = correctedRecord((await a.get('tenant-a', 'same-memory', scope))!);
    await a.commit(storageCommand(corrected, 'correct', scope));
    assert.deepEqual(await a.indexHead('tenant-a', 'personal', scope), { revision: 2, cursor: 1, error: 'index_read_failed' });
    await a.rebuildIndex('tenant-a', 'personal', scope);
    assert.deepEqual(await a.indexHead('tenant-a', 'personal', scope), { revision: 2, cursor: 2, error: null });
    await assert.rejects(a.get('tenant-a', 'same-memory', ownerScope(f.otherAgentId)), /knowledge_scope_mismatch/);
    await assert.rejects(a.candidates(personalActor(f.agentId, 'user-b'), personalQuery, 5, scope), /knowledge_scope_mismatch/);
    await assert.rejects(a.commit(storageCommand(personalRecord(f.agentId, 'user-b'), 'forged', scope)), /knowledge_scope_mismatch/);
    const bound = scopedKnowledgeRepository(a, scope); scope.principalId = 'user-b';
    assert.equal((await bound.get('tenant-a', 'same-memory'))?.authorId, 'user-a');
    await assert.rejects(bound.commit(storageCommand(personalRecord(f.agentId, 'user-b'), 'forged')), /knowledge_scope_mismatch/);
  } finally { await a.close(); await b.close(); f.close(); }
});

test('personal scope is explicit and cannot enter legacy/work partitions or reviewer searches', async () => {
  const f = storageFixture(); f.bind(); const store = new SqliteKnowledgeRepository(f.path, { mode: 'agent', agentId: f.agentId });
  const scope = ownerScope(f.agentId); const value = personalRecord(f.agentId);
  try {
    await assert.rejects(store.commit(storageCommand(value)), /knowledge_scope_required/);
    await assert.rejects(store.commit(storageCommand(value, 'work', { agentId: f.agentId, partition: 'work' })), /knowledge_scope_mismatch/);
    await store.commit(storageCommand(value, 'personal', scope));
    assert.equal(await store.get('tenant-a', value.id), null);
    assert.equal(await store.receipt('tenant-a', value.id, 'personal'), null);
    await assert.rejects(store.indexHead('tenant-a', 'team', scope), /knowledge_scope_mismatch/);
    await assert.rejects(store.candidates(personalActor(f.agentId), { ...personalQuery, kinds: ['experience'] }, 5, scope), /knowledge_scope_mismatch/);
    await assert.rejects(store.candidates({ ...personalActor(f.agentId), agentId: f.otherAgentId }, personalQuery, 5, scope), /knowledge_scope_mismatch/);
    await assert.rejects(store.candidates(personalActor(f.agentId, 'reviewer'), personalQuery, 5, scope), /knowledge_scope_mismatch/);
    await assert.rejects(store.get('tenant-a', value.id, { ...scope, extra: true } as never));
  } finally { await store.close(); f.close(); }
});

test('shared registration is explicit, immutable, distinct from single-agent owner and checked on reuse', async () => {
  const f = storageFixture();
  try {
    const options = { mode: 'shared' as const, storeId: 'shared', agentId: f.agentId };
    assert.throws(() => new SqliteKnowledgeRepository(f.path, options), /agent_storage_owner_missing/); assert.equal(existsSync(f.path), false);
    registerSharedKnowledgeStore(f.path, { storeId: 'shared', agentIds: [f.agentId] });
    registerSharedKnowledgeStore(f.path, { storeId: 'shared', agentIds: [f.agentId] });
    assert.throws(() => registerSharedKnowledgeStore(f.path, { storeId: 'shared', agentIds: [f.agentId, f.otherAgentId] }), /knowledge_store_registration_conflict/);
    assert.throws(() => new SqliteKnowledgeRepository(f.path, { ...options, storeId: 'other' }), /agent_storage_owner_mismatch/);
    assert.throws(() => new SqliteKnowledgeRepository(f.path, { ...options, agentId: f.otherAgentId }), /knowledge_agent_not_registered/);
    assert.throws(() => new SqliteKnowledgeRepository(f.path), /knowledge_scoped_handle_required/);
    assert.throws(() => new SqliteKnowledgeRepository(f.path, { mode: 'agent', agentId: f.agentId }), /agent_storage_owner_missing|agent_storage_owner_mismatch/);
    const store = new SqliteKnowledgeRepository(f.path, options); options.agentId = f.otherAgentId;
    try {
      await assert.rejects(store.get('tenant-a', 'same-memory'), /knowledge_scope_required/);
      assert.equal(await store.get('tenant-a', 'same-memory', ownerScope(f.agentId)), null);
      const db = new DatabaseSync(f.path); try { db.prepare('DELETE FROM knowledge_store_agents WHERE agent_id=?').run(f.agentId); } finally { db.close(); }
      await assert.rejects(store.get('tenant-a', 'same-memory', ownerScope(f.agentId)), /knowledge_agent_not_registered/);
    } finally { await store.close(); }
  } finally { f.close(); }
  const existing = storageFixture(); existing.bind();
  try {
    const before = readFileSync(existing.path);
    assert.throws(() => registerSharedKnowledgeStore(existing.path, { storeId: 'shared', agentIds: [existing.agentId] }), /agent_storage_owner_missing/);
    assert.deepEqual(readFileSync(existing.path), before);
  } finally { existing.close(); }
  const unknown = storageFixture(); writeFileSync(unknown.path, '', { mode: 0o600 }); const db = new DatabaseSync(unknown.path);
  db.exec('CREATE TABLE private_data(value TEXT);'); db.close();
  try {
    const before = readFileSync(unknown.path);
    assert.throws(() => registerSharedKnowledgeStore(unknown.path, { storeId: 'shared', agentIds: [unknown.agentId] }), /agent_storage_owner_missing/);
    assert.deepEqual(readFileSync(unknown.path), before);
  } finally { unknown.close(); }
});

test('personal record, index, head and receipt roll back together at index and receipt failures', async () => {
  const f = storageFixture(); f.bind(); const store = new SqliteKnowledgeRepository(f.path, { mode: 'agent', agentId: f.agentId });
  const scope = ownerScope(f.agentId); const value = personalRecord(f.agentId); const db = new DatabaseSync(f.path);
  try {
    for (const target of ['knowledge_index_v2', 'knowledge_receipts_v2']) {
      db.exec(`CREATE TRIGGER injected_failure BEFORE INSERT ON ${target} BEGIN SELECT RAISE(ABORT,'personal_commit_fixture_failure'); END;`);
      await assert.rejects(store.commit(storageCommand(value, 'create', scope)), /personal_commit_fixture_failure/);
      assert.equal(await store.get('tenant-a', value.id, scope), null); assert.equal(await store.receipt('tenant-a', value.id, 'create', scope), null);
      assert.deepEqual(await store.indexHead('tenant-a', 'personal', scope), { revision: 0, cursor: 0, error: null });
      for (const table of ['knowledge_records_v2', 'knowledge_index_v2', 'knowledge_heads_v2', 'knowledge_receipts_v2']) assert.equal(tableCount(db, table), 0);
      db.exec('DROP TRIGGER injected_failure;');
    }
    assert.equal((await store.commit(storageCommand(value, 'create', scope))).kind, 'committed');
    assert.deepEqual(await store.candidates(personalActor(f.agentId), personalQuery, 5, scope), { ids: [value.id], truncated: false });
  } finally { db.close(); await store.close(); f.close(); }
});

test('scoped canonical rows reject body identity tampering rather than returning another user record', async () => {
  const f = storageFixture(); f.bind(); const store = new SqliteKnowledgeRepository(f.path, { mode: 'agent', agentId: f.agentId });
  const scope = ownerScope(f.agentId); const value = personalRecord(f.agentId);
  try {
    await store.commit(storageCommand(value, 'create', scope)); const db = new DatabaseSync(f.path);
    try { db.prepare('UPDATE knowledge_records_v2 SET body=?').run(JSON.stringify(personalRecord(f.agentId, 'user-b'))); } finally { db.close(); }
    await assert.rejects(store.get('tenant-a', value.id, scope), /knowledge_scope_mismatch/);
  } finally { await store.close(); f.close(); }
});
