import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';
import { bindAgentDatabase } from '../infrastructure/agent-database-owner.js';
import { AgentKnowledgeRepository } from '../infrastructure/agent-knowledge.js';
import type { KnowledgeRepository } from '../application/knowledge-ports.js';
import { correctedRecord, ownerScope, personalRecord, storageCommand } from './personal-knowledge-storage-helpers.js';

function fixture(personalMemory: 'sqlite' | 'documents' = 'documents') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-document-memory-'))); const engine = join(base, 'engine'); mkdirSync(engine, { mode: 0o700 });
  const profiles = new FileAgentProfileStore(engine), profile = profiles.initialize(join(base, 'agent'), { personalMemory });
  const documents = join(profile.root, 'memory', 'documents');
  const hostOptions = { identityRegistryDirectory: join(base, 'registry') };
  return { base, engine, profiles, profile, documents, hostOptions, assignment: join(profile.paths.metadata, 'personal-memory-profile.json'),
    ready: join(profile.paths.metadata, 'document-memory-ready.json'), open: () => openAgentStores(profiles, profile.root, undefined, hostOptions),
    cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('default SQLite personal selection stays bound on restart without creating a document store', async () => {
  const f = fixture('sqlite'); try {
    const record = personalRecord(f.profile.identity.agentId), scope = ownerScope(f.profile.identity.agentId);
    const first = await f.open(); try { await first.knowledge.commit(storageCommand(record, 'remember', scope)); } finally { await first.close(); }
    const assigned = readFileSync(f.assignment); assert.equal(existsSync(f.documents), false); assert.equal(existsSync(f.ready), false);
    const second = await f.open(); try { assert.deepEqual(await second.knowledge.get(record.tenantId, record.id, scope), record); } finally { await second.close(); }
    assert.deepEqual(readFileSync(f.assignment), assigned); assert.equal(existsSync(f.documents), false);
  } finally { f.cleanup(); }
});

test('a completed document store cannot disappear and silently return an empty SQLite personal partition', async () => {
  const f = fixture(); try {
    const first = await f.open(), record = personalRecord(f.profile.identity.agentId), scope = ownerScope(f.profile.identity.agentId);
    try { await first.knowledge.commit(storageCommand(record, 'remember', scope)); } finally { await first.close(); }
    const saved = readFileSync(f.assignment), ready = readFileSync(f.ready), sqlite = readFileSync(f.profile.paths.memory);
    rmSync(f.documents, { recursive: true });
    await assert.rejects(f.open(), /agent_document_memory_missing/);
    assert.equal(existsSync(f.documents), false); assert.deepEqual(readFileSync(f.assignment), saved); assert.deepEqual(readFileSync(f.ready), ready);
    assert.deepEqual(readFileSync(f.profile.paths.memory), sqlite);
  } finally { f.cleanup(); }
});

test('registration completion can resume after the owner was created without discarding a committed memory', async () => {
  const f = fixture(); try {
    const record = personalRecord(f.profile.identity.agentId), scope = ownerScope(f.profile.identity.agentId);
    const first = await f.open(); try { await first.knowledge.commit(storageCommand(record, 'remember', scope)); } finally { await first.close(); }
    const ready = readFileSync(f.ready); unlinkSync(f.ready);
    const resumed = await f.open(); try {
      assert.deepEqual(await resumed.knowledge.get(record.tenantId, record.id, scope), record);
      assert.deepEqual(await resumed.knowledge.receipt(record.tenantId, record.id, 'remember', scope), { digest: storageCommand(record, 'remember', scope).commandDigest, revision: 1 });
    } finally { await resumed.close(); }
    assert.deepEqual(readFileSync(f.ready), ready);
  } finally { f.cleanup(); }
});

test('documents cannot be assigned over an existing SQLite store without a migration', async () => {
  const f = fixture(); try {
    bindAgentDatabase(f.profile.paths.memory, f.profile.identity.agentId, 'memory');
    const before = readFileSync(f.profile.paths.memory);
    await assert.rejects(f.open(), /agent_personal_memory_migration_required/);
    assert.equal(existsSync(f.assignment), false); assert.equal(existsSync(f.documents), false); assert.equal(existsSync(f.ready), false);
    assert.deepEqual(readFileSync(f.profile.paths.memory), before);
  } finally { f.cleanup(); }
});

test('replacing the config with a legacy default cannot reroute an assigned document partition', async () => {
  const f = fixture(); try {
    const first = await f.open(); await first.close(); const assignment = readFileSync(f.assignment);
    const config = { ...f.profile.config, schemaVersion: 1, storage: { state: 'sqlite', memory: 'sqlite', artifacts: 'files' } };
    writeFileSync(join(f.profile.root, 'config.json'), JSON.stringify(config)); unlinkSync(join(f.profile.paths.metadata, 'setup-operation.json'));
    await assert.rejects(f.open(), /agent_personal_memory_profile_mismatch/);
    assert.deepEqual(readFileSync(f.assignment), assignment);
  } finally { f.cleanup(); }
});

test('a missing assignment behind an existing completion does not create a new owner', async () => {
  const f = fixture(); try {
    const first = await f.open(); await first.close(); const completion = readFileSync(f.ready); unlinkSync(f.assignment);
    await assert.rejects(f.open(), /agent_personal_memory_assignment_missing/);
    assert.equal(existsSync(f.assignment), false); assert.deepEqual(readFileSync(f.ready), completion);
  } finally { f.cleanup(); }
});

test('moving the whole document-backed agent keeps its owner, receipts and revision transitions', async () => {
  const f = fixture(); try {
    const record = personalRecord(f.profile.identity.agentId), scope = ownerScope(f.profile.identity.agentId);
    const first = await f.open(); try { await first.knowledge.commit(storageCommand(record, 'remember', scope)); } finally { await first.close(); }
    const moved = join(f.base, 'moved'); renameSync(f.profile.root, moved);
    const reopened = await openAgentStores(f.profiles, moved, undefined, f.hostOptions); try {
      assert.equal(reopened.profile.identity.agentId, f.profile.identity.agentId);
      assert.deepEqual(await reopened.knowledge.get(record.tenantId, record.id, scope), record);
      const corrected = correctedRecord(record);
      assert.deepEqual(await reopened.knowledge.commit(storageCommand(corrected, 'correct', scope)), { kind: 'committed', revision: 2 });
      assert.deepEqual(await reopened.knowledge.get(record.tenantId, record.id, scope), corrected);
      assert.equal(await reopened.knowledge.get(record.tenantId, record.id), null);
    } finally { await reopened.close(); }
  } finally { f.cleanup(); }
});

test('personal repository errors do not fall back and closing still releases both repositories', async () => {
  let workReads = 0, workCloses = 0, personalCloses = 0;
  const primary = new Error('document_store_changed');
  const work = { get: async () => { workReads++; return null; }, close: async () => { workCloses++; } } as unknown as KnowledgeRepository;
  const personal = { get: async () => { throw primary; }, close: async () => { personalCloses++; throw primary; } } as unknown as KnowledgeRepository;
  const repository = new AgentKnowledgeRepository(work, personal, 'test-agent');
  await assert.rejects(repository.get('tenant-a', 'same-id', ownerScope('test-agent')), error => error === primary);
  assert.equal(workReads, 0);
  await assert.rejects(repository.get('tenant-a', 'same-id', ownerScope('foreign-agent')), /knowledge_scope_mismatch/);
  assert.equal(workReads, 0);
  await assert.rejects(repository.close(), error => error === primary); assert.equal(workCloses, 1); assert.equal(personalCloses, 1);
  await repository.close(); assert.equal(workCloses, 1);
  await assert.rejects(repository.get('tenant-a', 'same-id'), /knowledge_repository_closed/);
});
