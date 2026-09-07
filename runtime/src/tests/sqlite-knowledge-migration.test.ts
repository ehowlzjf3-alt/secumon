import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SqliteKnowledgeRepository } from '../infrastructure/sqlite-knowledge.js';
import { bindAgentDatabase } from '../infrastructure/agent-database-owner.js';
import { storageFixture, legacyRecord, storageCommand } from './personal-knowledge-storage-helpers.js';

function legacySnapshot(db: DatabaseSync) {
  return Object.fromEntries(['records', 'heads', 'receipts', 'index'].map(name => [name,
    db.prepare(`SELECT * FROM knowledge_${name} ORDER BY tenant_id${name === 'heads' ? ',namespace' : ',id'}`).all().map(row => ({ ...row }))]));
}
function migratedSnapshot(db: DatabaseSync) {
  return Object.fromEntries(['records', 'heads', 'receipts', 'index'].map(name => [name,
    db.prepare(`SELECT * FROM knowledge_${name}_v2 ORDER BY tenant_id${name === 'heads' ? ',namespace' : ',id'}`).all()
      .map(({ agent_id: _agent, partition: _part, principal_id: _principal, audit_body: _audit, ...rest }) => rest)]));
}

test('owned v1 migration preserves exact work JSON, sources, receipts and index state without personal adoption', async () => {
  const f = storageFixture(); f.bind(); const legacy = new SqliteKnowledgeRepository(f.path); const value = legacyRecord();
  let scoped: SqliteKnowledgeRepository | undefined;
  try {
    await legacy.commit(storageCommand(value, 'old-create')); await legacy.rebuildIndex('tenant-a', 'team');
    await legacy.markIndexError('tenant-a', 'team', 'index_read_failed');
    const db = new DatabaseSync(f.path); let before: ReturnType<typeof legacySnapshot>;
    const json = JSON.stringify(value, null, 2);
    try {
      db.prepare('UPDATE knowledge_records SET body=?').run(json); db.prepare('UPDATE knowledge_index SET body=?').run(json); before = legacySnapshot(db);
    } finally { db.close(); }
    scoped = new SqliteKnowledgeRepository(f.path, { mode: 'agent', agentId: f.agentId });
    assert.deepEqual(await scoped.get('tenant-a', value.id), value);
    assert.deepEqual(await scoped.indexHead('tenant-a', 'team'), { revision: 1, cursor: 1, error: 'index_read_failed' });
    assert.deepEqual(await scoped.commit(storageCommand(value, 'old-create')), { kind: 'duplicate', revision: 1 });
    assert.equal(await scoped.get('tenant-a', value.id, { agentId: f.agentId, partition: 'personal', principalId: 'user-a' }), null);
    await assert.rejects(legacy.get('tenant-a', value.id), /knowledge_scoped_handle_required/);
    await assert.rejects(legacy.commit(storageCommand({ ...value, revision: 2 }, 'old-live-write')), /knowledge_scoped_handle_required/);
    assert.throws(() => new SqliteKnowledgeRepository(f.path), /knowledge_scoped_handle_required/);
    const check = new DatabaseSync(f.path);
    try {
      assert.equal(check.prepare('SELECT version FROM knowledge_schema').get()?.['version'], 2);
      assert.deepEqual(legacySnapshot(check), before); assert.deepEqual(migratedSnapshot(check), before);
      assert.equal(check.prepare('SELECT body FROM knowledge_records_v2').get()?.['body'], json);
      assert.equal(check.prepare("SELECT count(*) AS n FROM knowledge_records_v2 WHERE partition='personal'").get()?.['n'], 0);
      assert.throws(() => check.prepare('UPDATE knowledge_records SET body=?').run('{}'), /knowledge_schema_migrated/);
    } finally { check.close(); }
    await scoped.close(); scoped = new SqliteKnowledgeRepository(f.path, { mode: 'agent', agentId: f.agentId });
    assert.deepEqual(await scoped.get('tenant-a', value.id), value);
    const query = { namespace: 'team', scope: 'fixture', text: '', kinds: [], observedFrom: null, observedThrough: null, limit: 5 };
    const actor = { tenantId: 'tenant-a', principalId: 'user-a', allowedLabels: [], allowedNamespaces: ['team'], allowedScopes: ['fixture'], canReview: false, canPublish: false };
    assert.deepEqual(await scoped.candidates(actor, query, 5), { ids: [value.id], truncated: false });
  } finally { await scoped?.close(); await legacy.close(); f.close(); }
});

test('migration copy failure rolls back schema and all data, then the same owner can retry', async () => {
  const f = storageFixture(); f.bind(); const legacy = new SqliteKnowledgeRepository(f.path); const value = legacyRecord();
  try { await legacy.commit(storageCommand(value)); } finally { await legacy.close(); }
  const originalPrepare = DatabaseSync.prototype.prepare; const fault = new Error('migration_copy_failure'); let injected = false;
  DatabaseSync.prototype.prepare = function (sql: string) {
    const statement = originalPrepare.call(this, sql);
    if (sql.startsWith('INSERT INTO knowledge_heads_v2(')) statement.run = () => { injected = true; throw fault; };
    return statement;
  };
  try { assert.throws(() => new SqliteKnowledgeRepository(f.path, { mode: 'agent', agentId: f.agentId }), error => error === fault); }
  finally { DatabaseSync.prototype.prepare = originalPrepare; }
  let reopened: SqliteKnowledgeRepository | undefined;
  try {
    assert.equal(injected, true); const db = new DatabaseSync(f.path, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT version FROM knowledge_schema').get()?.['version'], 1);
      assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='knowledge_scoped_schema' OR name LIKE '%_v2' OR type='trigger'").get(), undefined);
      assert.equal(db.prepare('SELECT body FROM knowledge_records').get()?.['body'], JSON.stringify(value));
      assert.equal(db.prepare('SELECT digest FROM knowledge_receipts').get()?.['digest'], storageCommand(value).commandDigest);
    } finally { db.close(); }
    reopened = new SqliteKnowledgeRepository(f.path, { mode: 'agent', agentId: f.agentId });
    assert.deepEqual(await reopened.get('tenant-a', value.id), value);
    assert.deepEqual(await reopened.commit(storageCommand(value)), { kind: 'duplicate', revision: 1 });
  } finally { await reopened?.close(); f.close(); }
});

test('unowned, foreign-owned and malformed legacy databases cannot be silently migrated', async () => {
  for (const scenario of ['unowned', 'foreign', 'malformed'] as const) {
    const f = storageFixture();
    if (scenario !== 'unowned') bindAgentDatabase(f.path, scenario === 'foreign' ? f.otherAgentId : f.agentId, 'memory');
    else writeFileSync(f.path, '', { mode: 0o600 });
    const legacy = new SqliteKnowledgeRepository(f.path);
    try { await legacy.commit(storageCommand(legacyRecord())); } finally { await legacy.close(); }
    if (scenario === 'malformed') {
      const db = new DatabaseSync(f.path); try { db.exec("UPDATE knowledge_records SET body='{invalid';"); } finally { db.close(); }
    }
    try {
      const before = readFileSync(f.path);
      assert.throws(() => new SqliteKnowledgeRepository(f.path, { mode: 'agent', agentId: f.agentId }));
      assert.deepEqual(readFileSync(f.path), before);
      const db = new DatabaseSync(f.path, { readOnly: true });
      try {
        assert.equal(db.prepare('SELECT version FROM knowledge_schema').get()?.['version'], 1);
        assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='knowledge_scoped_schema'").get(), undefined);
      } finally { db.close(); }
    } finally { f.close(); }
  }
});

test('independent scoped reopens retain legacy shared/reviewed records and work index lag semantics', async () => {
  const f = storageFixture(); f.bind(); const legacy = new SqliteKnowledgeRepository(f.path);
  const value = { ...legacyRecord(), visibility: 'shared' as const, reviewState: 'reviewed' as const,
    review: { reviewerId: 'reviewer', contentRevision: 1, at: 110, reason: 'checked' } };
  try { await legacy.commit(storageCommand(value)); } finally { await legacy.close(); }
  const options = { mode: 'agent' as const, agentId: f.agentId }; const a = new SqliteKnowledgeRepository(f.path, options); options.agentId = f.otherAgentId;
  const b = new SqliteKnowledgeRepository(f.path, { mode: 'agent', agentId: f.agentId });
  try {
    assert.deepEqual(await a.indexHead('tenant-a', 'team'), { revision: 1, cursor: 0, error: null });
    await b.rebuildIndex('tenant-a', 'team');
    const actor = { tenantId: 'tenant-a', principalId: 'different-reader', allowedLabels: [], allowedNamespaces: ['team'], allowedScopes: ['fixture'], canReview: false, canPublish: false };
    const query = { namespace: 'team', scope: 'fixture', text: '', kinds: [], observedFrom: null, observedThrough: null, limit: 5 };
    assert.deepEqual(await a.candidates(actor, query, 5), { ids: [value.id], truncated: false });
    assert.deepEqual(await a.get('tenant-a', value.id), value);
    await a.commit(storageCommand({ ...value, revision: 2, updatedAt: 111, status: 'retracted' }, 'retract'));
    assert.deepEqual(await b.indexHead('tenant-a', 'team'), { revision: 2, cursor: 1, error: null });
    await b.rebuildIndex('tenant-a', 'team'); assert.deepEqual(await a.candidates(actor, query, 5), { ids: [], truncated: false });
  } finally { await a.close(); await b.close(); f.close(); }
});

for (const phase of ['copied', 'committed'] as const) test(`actual SIGKILL at migration ${phase} preserves the atomic schema and original receipt`, { timeout: 30000 }, async () => {
  const f = storageFixture(); f.bind(); const legacy = new SqliteKnowledgeRepository(f.path); const value = legacyRecord();
  const command = storageCommand(value, 'surviving-receipt');
  try { await legacy.commit(command); await legacy.rebuildIndex('tenant-a', 'team'); } finally { await legacy.close(); }
  const originalFile = readFileSync(f.path), originalBody = JSON.stringify(value);
  const worker = fileURLToPath(new URL('./helpers/knowledge-migration-worker.js', import.meta.url));
  const child = fork(worker, [phase, f.path, f.agentId], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8000); });
  const exited = once(child, 'exit'); const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  let resumed: SqliteKnowledgeRepository | undefined;
  try {
    const [message] = await once(child, 'message', { signal: AbortSignal.timeout(12000) });
    assert.deepEqual(message, { checkpoint: phase, transactionOpen: phase === 'copied', version: phase === 'copied' ? 1 : 2,
      copiedRecords: 1, bodyDigest: createHash('sha256').update(originalBody).digest('hex') }, stderr);
    assert.equal(child.kill('SIGKILL'), true); const [, signal] = await exited; assert.equal(signal, 'SIGKILL', stderr);
    const db = new DatabaseSync(f.path, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT version FROM knowledge_schema').get()?.['version'], phase === 'copied' ? 1 : 2);
      assert.equal(db.prepare('SELECT body FROM knowledge_records').get()?.['body'], originalBody);
      assert.equal(db.prepare('SELECT digest FROM knowledge_receipts').get()?.['digest'], command.commandDigest);
      if (phase === 'copied') {
        assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='knowledge_scoped_schema'").get(), undefined);
        assert.deepEqual(readFileSync(f.path), originalFile);
      } else assert.deepEqual(migratedSnapshot(db), legacySnapshot(db));
    } finally { db.close(); }
    resumed = new SqliteKnowledgeRepository(f.path, { mode: 'agent', agentId: f.agentId });
    assert.deepEqual(await resumed.get('tenant-a', value.id), value);
    assert.deepEqual(await resumed.commit(command), { kind: 'duplicate', revision: 1 });
    const verified = new DatabaseSync(f.path, { readOnly: true });
    try {
      assert.equal(verified.prepare('SELECT count(*) AS n FROM knowledge_records_v2').get()?.['n'], 1);
      assert.equal(verified.prepare('SELECT count(*) AS n FROM knowledge_receipts_v2').get()?.['n'], 1);
      assert.equal(verified.prepare('SELECT body FROM knowledge_records_v2').get()?.['body'], originalBody);
      assert.equal(verified.prepare('SELECT digest FROM knowledge_receipts_v2').get()?.['digest'], command.commandDigest);
    } finally { verified.close(); }
  } finally {
    clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    await resumed?.close(); f.close();
  }
});
