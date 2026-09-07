import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { PersonalMemoryFence, PersonalMemoryMigrationScope } from '../application/personal-memory-migration-contracts.js';
import { PersonalMemorySnapshotSchema } from '../application/personal-memory-migration-contracts.js';
import { SqliteKnowledgeRepository } from '../infrastructure/sqlite-knowledge.js';
import { bindAgentDatabase } from '../infrastructure/agent-database-owner.js';
import { fenceSqlitePersonalMemory, inspectPersonalMemorySnapshot, personalMemorySnapshotReader,
  readPersonalMemorySeedRecords, readSqlitePersonalMemoryFence } from '../infrastructure/sqlite-personal-memory-migration.js';
import { correctedRecord, legacyRecord, ownerScope, personalActor, personalQuery, personalRecord,
  storageCommand, storageFixture } from './personal-knowledge-storage-helpers.js';

function scope(agentId: string, principalId = 'user-a', tenantId = 'tenant-a'): PersonalMemoryMigrationScope {
  return { tenantId, agentId, principalId, partition: 'personal', namespace: 'personal' };
}
function snapshot(path: string, agentId: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { db.exec('BEGIN'); return personalMemorySnapshotReader(db, agentId).snapshot; } finally { db.close(); }
}
function fence(path: string, agentId: string): PersonalMemoryFence {
  const value = snapshot(path, agentId);
  return { schemaVersion: 1, operationId: randomUUID(), targetStoreId: randomUUID(), agentId,
    ownerDigest: value.ownerDigest, snapshotDigest: value.snapshotDigest, workDigest: value.workDigest };
}
function rows(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return Object.fromEntries(['records', 'receipts', 'heads', 'index'].map(table => [table,
    db.prepare(`SELECT * FROM knowledge_${table}_v2 ORDER BY tenant_id,agent_id,partition,principal_id`).all().map(row => ({ ...row }))])); }
  finally { db.close(); }
}
async function seeded() {
  const f = storageFixture(); f.bind(); const repo = new SqliteKnowledgeRepository(f.path, { mode: 'agent', agentId: f.agentId });
  try {
    const value = personalRecord(f.agentId);
    await repo.commit(storageCommand(value, 'create', ownerScope(f.agentId)));
    await repo.commit(storageCommand(legacyRecord(), 'work-create')); await repo.rebuildIndex('tenant-a', 'team');
    return { ...f, repo, value };
  } catch (error) { await repo.close(); f.close(); throw error; }
}

test('fixed source snapshot preserves active, retracted and deleted rows, all original receipts and raw audit strings across owners', async () => {
  const f = await seeded();
  try {
    const corrected = correctedRecord(f.value); await f.repo.commit(storageCommand(corrected, 'correct', ownerScope(f.agentId)));
    for (const [principalId, tenantId, status] of [['user-a', 'tenant-b', 'retracted'], ['user-b', 'tenant-a', 'deleted']] as const) {
      const value = personalRecord(f.agentId, principalId, tenantId);
      await f.repo.commit(storageCommand(value, 'create', ownerScope(f.agentId, principalId)));
      await f.repo.commit(storageCommand({ ...value, revision: 2, updatedAt: 111, status }, 'forget', ownerScope(f.agentId, principalId)));
    }
    const edit = new DatabaseSync(f.path);
    try {
      for (const row of edit.prepare("SELECT rowid,body FROM knowledge_records_v2 WHERE partition='personal'").all()) {
        edit.prepare('UPDATE knowledge_records_v2 SET body=? WHERE rowid=?').run(JSON.stringify(JSON.parse(String(row['body'])), null, 2), row['rowid']!);
      }
      for (const row of edit.prepare("SELECT rowid,audit_body FROM knowledge_receipts_v2 WHERE partition='personal'").all()) {
        edit.prepare('UPDATE knowledge_receipts_v2 SET audit_body=? WHERE rowid=?').run(JSON.stringify(JSON.parse(String(row['audit_body'])), null, 2), row['rowid']!);
      }
    } finally { edit.close(); }
    const before = rows(f.path), db = new DatabaseSync(f.path, { readOnly: true });
    try {
      assert.throws(() => inspectPersonalMemorySnapshot(db, f.agentId), /snapshot_required/);
      db.exec('BEGIN'); const reader = personalMemorySnapshotReader(db, f.agentId);
      assert.deepEqual(PersonalMemorySnapshotSchema.parse(reader.snapshot), reader.snapshot);
      assert.equal(reader.snapshot.namespaces.length, 3);
      const entries = reader.snapshot.namespaces.flatMap(ns => [...reader.records(ns.scope)]);
      assert.equal(entries.length, 3); assert.equal(entries.reduce((n, entry) => n + entry.receipts.length, 0), 6);
      assert.deepEqual(entries.map(entry => entry.record.status), ['active', 'retracted', 'deleted']);
      for (const entry of entries) {
        assert.deepEqual(entry.receipts.map(receipt => receipt.revision), [1, 2]);
        assert.ok(entry.receipts.every(receipt => receipt.auditJson.includes('\n')));
        const original = before['records']!.find(row => row['tenant_id'] === entry.record.tenantId && row['principal_id'] === entry.record.authorId && row['partition'] === 'personal');
        assert.deepEqual(entry.record, JSON.parse(String(original!['body'])));
      }
      assert.deepEqual([...reader.records(scope(f.agentId))], [...readPersonalMemorySeedRecords(db, f.agentId, scope(f.agentId))]);
      assert.throws(() => [...reader.records(scope(f.otherAgentId))], /scope_unavailable/);
      assert.deepEqual(reader.snapshot, snapshot(f.path, f.agentId));
    } finally { db.close(); }
    assert.deepEqual(rows(f.path), before);
  } finally { await f.repo.close(); f.close(); }
});

test('scope union rejects orphan receipts, missing heads, stale index and malformed audits without changing the source', async () => {
  const mutations = [
    "UPDATE knowledge_receipts_v2 SET id='orphan' WHERE partition='personal'",
    "UPDATE knowledge_receipts_v2 SET revision=2 WHERE partition='personal'",
    "UPDATE knowledge_receipts_v2 SET audit_body=NULL WHERE partition='personal'",
    "UPDATE knowledge_receipts_v2 SET audit_body=json_set(audit_body,'$.expectedRevision',7) WHERE partition='personal'",
    "DELETE FROM knowledge_heads_v2 WHERE partition='personal'",
    "UPDATE knowledge_heads_v2 SET cursor=0 WHERE partition='personal'",
    "UPDATE knowledge_index_v2 SET document='stale' WHERE partition='personal'",
    "UPDATE knowledge_index_v2 SET id='orphan' WHERE partition='personal'",
    "UPDATE knowledge_records_v2 SET agent_id='foreign' WHERE partition='personal'",
  ];
  for (const sql of mutations) {
    const f = await seeded();
    try {
      const edit = new DatabaseSync(f.path); try { edit.exec(sql); } finally { edit.close(); }
      const before = rows(f.path); assert.throws(() => snapshot(f.path, f.agentId), /.+/, sql);
      assert.deepEqual(rows(f.path), before); assert.equal(readSqlitePersonalMemoryFence(f.path, f.agentId), null);
    } finally { await f.repo.close(); f.close(); }
  }
});

test('source cell byte cap rejects oversized SQL strings before any record is yielded', async () => {
  const f = await seeded();
  try {
    const db = new DatabaseSync(f.path);
    try { db.exec("UPDATE knowledge_records_v2 SET body=printf('%.*c',4194305,'x') WHERE partition='personal'"); }
    finally { db.close(); }
    assert.throws(() => snapshot(f.path, f.agentId), /source_invalid/);
  } finally { await f.repo.close(); f.close(); }
});

test('normal fence discovery accepts missing, exclusive-created empty, owner-only and valid legacy1 but administrative snapshot never adopts them', async () => {
  const f = storageFixture();
  try {
    assert.equal(readSqlitePersonalMemoryFence(f.path, f.agentId), null); assert.equal(existsSync(f.path), false);
    writeFileSync(f.path, '', { mode: 0o600 }); assert.equal(readSqlitePersonalMemoryFence(f.path, f.agentId), null);
    assert.equal(readFileSync(f.path).length, 0);
    bindAgentDatabase(f.path, f.agentId, 'memory'); assert.equal(readSqlitePersonalMemoryFence(f.path, f.agentId), null);
    assert.throws(() => snapshot(f.path, f.agentId));
    const legacy = new SqliteKnowledgeRepository(f.path); await legacy.close();
    assert.equal(readSqlitePersonalMemoryFence(f.path, f.agentId), null);
    assert.throws(() => snapshot(f.path, f.agentId), /source_schema_unsupported|no such table/);
  } finally { f.close(); }
});

test('foreign and unowned existing sources cannot acquire a fence or owner', async () => {
  for (const owner of ['foreign', 'unowned'] as const) {
    const f = storageFixture();
    try {
      if (owner === 'foreign') bindAgentDatabase(f.path, f.otherAgentId, 'memory');
      else writeFileSync(f.path, '', { mode: 0o600 });
      const db = new DatabaseSync(f.path); try { db.exec('CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES(\'keep\')'); } finally { db.close(); }
      const before = readFileSync(f.path);
      assert.throws(() => readSqlitePersonalMemoryFence(f.path, f.agentId), /owner_/);
      assert.throws(() => fenceSqlitePersonalMemory(f.path, { schemaVersion: 1, operationId: randomUUID(), targetStoreId: randomUUID(), agentId: f.agentId,
        ownerDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64), workDigest: 'c'.repeat(64) }), /owner_/);
      assert.deepEqual(readFileSync(f.path), before);
    } finally { f.close(); }
  }
});

test('fresh writer snapshot must still match both personal and work digests before the first fence', async () => {
  for (const change of ['personal', 'work'] as const) {
    const f = await seeded();
    try {
      const expected = fence(f.path, f.agentId);
      if (change === 'personal') await f.repo.commit(storageCommand(correctedRecord(f.value), 'newer', ownerScope(f.agentId)));
      else await f.repo.commit(storageCommand({ ...legacyRecord(), revision: 2, updatedAt: 111 }, 'newer'));
      const before = rows(f.path);
      assert.throws(() => fenceSqlitePersonalMemory(f.path, expected), /source_changed/);
      assert.equal(readSqlitePersonalMemoryFence(f.path, f.agentId), null); assert.deepEqual(rows(f.path), before);
      assert.deepEqual(fenceSqlitePersonalMemory(f.path, fence(f.path, f.agentId)).agentId, f.agentId);
    } finally { await f.repo.close(); f.close(); }
  }
});

test('source retirement blocks every personal SQL write and old prepared handle while current work reads and commits continue', async () => {
  const f = await seeded(), raw = new DatabaseSync(f.path);
  const preparedBeforeFence = raw.prepare("UPDATE knowledge_records_v2 SET body=body WHERE partition='personal'");
  let reopened: SqliteKnowledgeRepository | undefined;
  try {
    const expected = fence(f.path, f.agentId), before = rows(f.path);
    assert.deepEqual(fenceSqlitePersonalMemory(f.path, expected), expected);
    assert.deepEqual(rows(f.path), before); assert.deepEqual(readSqlitePersonalMemoryFence(f.path, f.agentId), expected);
    assert.equal(raw.prepare('SELECT version FROM knowledge_schema').get()?.['version'], 3);
    assert.throws(() => preparedBeforeFence.run(), /personal_memory_source_retired/);
    for (const table of ['records', 'receipts', 'heads', 'index']) {
      for (const sql of [
        `INSERT INTO knowledge_${table}_v2 SELECT * FROM knowledge_${table}_v2 WHERE partition='personal'`,
        `DELETE FROM knowledge_${table}_v2 WHERE partition='personal'`,
        `UPDATE knowledge_${table}_v2 SET partition='work',principal_id='' WHERE partition='personal'`,
        `UPDATE knowledge_${table}_v2 SET partition='personal',principal_id='user-b' WHERE partition='work'`,
      ]) assert.throws(() => raw.exec(sql), /personal_memory_source_retired/, sql);
    }
    assert.throws(() => raw.exec('DELETE FROM knowledge_personal_migration'), /personal_memory_source_retired/);
    assert.throws(() => raw.exec('UPDATE knowledge_schema SET version=2'), /personal_memory_source_retired/);
    await assert.rejects(f.repo.get('tenant-a', f.value.id, ownerScope(f.agentId)), /personal_memory_source_retired/);
    await assert.rejects(f.repo.receipt('tenant-a', f.value.id, 'create', ownerScope(f.agentId)), /personal_memory_source_retired/);
    await assert.rejects(f.repo.candidates(personalActor(f.agentId), personalQuery, 5, ownerScope(f.agentId)), /personal_memory_source_retired/);
    await assert.rejects(f.repo.indexHead('tenant-a', 'personal', ownerScope(f.agentId)), /personal_memory_source_retired/);
    await assert.rejects(f.repo.commit(storageCommand(correctedRecord(f.value), 'late', ownerScope(f.agentId))), /personal_memory_source_retired/);
    assert.deepEqual(await f.repo.get('tenant-a', 'legacy-memory'), legacyRecord());
    await f.repo.commit(storageCommand({ ...legacyRecord(), revision: 2, updatedAt: 111 }, 'work-after-fence'));
    await f.repo.rebuildIndex('tenant-a', 'team');
    reopened = new SqliteKnowledgeRepository(f.path, { mode: 'agent', agentId: f.agentId });
    assert.equal((await reopened.get('tenant-a', 'legacy-memory'))?.revision, 2);
    await assert.rejects(reopened.get('tenant-a', f.value.id, ownerScope(f.agentId)), /personal_memory_source_retired/);
    assert.deepEqual(fenceSqlitePersonalMemory(f.path, expected), expected, 'same operation keeps its original work digest after permitted work writes');
    assert.throws(() => fenceSqlitePersonalMemory(f.path, { ...expected, operationId: randomUUID() }), /fence_conflict/);
    assert.throws(() => snapshot(f.path, f.agentId), /source_schema_unsupported/);
  } finally { raw.close(); await reopened?.close(); await f.repo.close(); f.close(); }
});

test('failure during source fence installation rolls back triggers, version and marker together', async () => {
  const f = await seeded(); const expected = fence(f.path, f.agentId), before = rows(f.path);
  const original = DatabaseSync.prototype.exec, fault = new Error('injected_fence_trigger_failure'); let seen = false;
  DatabaseSync.prototype.exec = function (sql: string) {
    if (sql.startsWith('CREATE TRIGGER knowledge_personal_fence_receipts_update')) { seen = true; throw fault; }
    return original.call(this, sql);
  };
  try { assert.throws(() => fenceSqlitePersonalMemory(f.path, expected), error => error === fault); }
  finally { DatabaseSync.prototype.exec = original; }
  try {
    assert.equal(seen, true); assert.equal(readSqlitePersonalMemoryFence(f.path, f.agentId), null);
    assert.deepEqual(rows(f.path), before); assert.deepEqual(fenceSqlitePersonalMemory(f.path, expected), expected);
  } finally { await f.repo.close(); f.close(); }
});

test('a missing persistent trigger is rejected rather than accepting an apparently retired source', async () => {
  const f = await seeded();
  try {
    fenceSqlitePersonalMemory(f.path, fence(f.path, f.agentId));
    const edit = new DatabaseSync(f.path); try { edit.exec('DROP TRIGGER knowledge_personal_fence_index_update'); } finally { edit.close(); }
    assert.throws(() => readSqlitePersonalMemoryFence(f.path, f.agentId), /fence_invalid/);
    await assert.rejects(f.repo.get('tenant-a', 'legacy-memory'), /fence_invalid/);
    assert.throws(() => new SqliteKnowledgeRepository(f.path, { mode: 'agent', agentId: f.agentId }), /fence_invalid/);
  } finally { await f.repo.close(); f.close(); }
});

for (const phase of ['before-commit', 'after-commit'] as const) test(`actual SIGKILL ${phase} keeps all source rows and an atomic resumable fence`, { timeout: 30000 }, async () => {
  const f = await seeded(); const expected = fence(f.path, f.agentId), before = rows(f.path);
  await f.repo.close();
  const worker = fileURLToPath(new URL('./helpers/sqlite-personal-memory-fence-worker.js', import.meta.url));
  const child = fork(worker, [phase, f.path, JSON.stringify(expected)], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8000); });
  const exited = once(child, 'close'); const abort = new AbortController();
  const timer = setTimeout(() => { abort.abort(new Error('fence_worker_checkpoint_timeout')); child.kill('SIGKILL'); }, 12000);
  try {
    const [message] = await Promise.race([once(child, 'message', { signal: abort.signal }), exited.then(result => {
      throw new Error(`fence worker closed before checkpoint: ${JSON.stringify(result)} ${stderr}`);
    })]);
    assert.deepEqual(message, { checkpoint: phase, transactionOpen: phase === 'before-commit', version: 3 }, stderr);
    assert.equal(child.kill('SIGKILL'), true); const [, signal] = await exited; assert.equal(signal, 'SIGKILL', stderr);
    assert.deepEqual(rows(f.path), before);
    assert.deepEqual(readSqlitePersonalMemoryFence(f.path, f.agentId), phase === 'before-commit' ? null : expected);
    assert.deepEqual(fenceSqlitePersonalMemory(f.path, expected), expected);
    assert.deepEqual(rows(f.path), before);
  } finally {
    clearTimeout(timer); abort.abort();
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    f.close();
  }
});
