import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync, writeFileSync, copyFileSync, unlinkSync, symlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';
import { initial, command } from './state-conformance-helpers.js';
import type { KnowledgeRecord } from '../domain/knowledge.js';

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-stores-'))); const engine = join(base, 'engine'); mkdirSync(engine, { mode: 0o700 });
  const profiles = new FileAgentProfileStore(engine); const a = profiles.initialize(join(base, 'a')); const b = profiles.initialize(join(base, 'b'));
  return { base, engine, profiles, a, b, registryDirectory: join(base, 'registry'), close: () => rmSync(base, { recursive: true, force: true }) };
}
const note = (body: string): KnowledgeRecord => ({ id: 'same-note', tenantId: 'same-tenant', namespace: 'same-namespace', scope: 'same-scope',
  authorId: 'same-user', kind: 'experience', title: 'note', body, labels: [], revision: 1, contentRevision: 1, status: 'active', visibility: 'private',
  reviewState: 'private', review: null, sources: [{ workId: 'same-work', evidenceId: 'evidence', ownerId: 'same-user', sourceId: 'source',
    sourceVersion: 'a'.repeat(64), generation: 0, observedAt: 1000, recordedAt: 1000, coverage: 'complete', labels: [] }],
  derivedFrom: [], createdAt: 1000, updatedAt: 1000, expiresAt: null });

test('two agent stores reuse existing adapters while separating identical work/memory IDs and preserving reopen', async () => {
  const f = fixture(); const a = await openAgentStores(f.profiles, f.a.root, undefined, { identityRegistryDirectory: f.registryDirectory }); const b = await openAgentStores(f.profiles, f.b.root, undefined, { identityRegistryDirectory: f.registryDirectory });
  try {
    const wa = initial('same-work'); wa.goal.description = 'agent a work';
    const wb = initial('same-work'); wb.goal.description = 'agent b work';
    assert.equal((await a.state.commit(command(wa, 'same-command'))).kind, 'committed');
    assert.equal(await b.state.get('same-work'), null);
    assert.equal((await b.state.commit(command(wb, 'same-command'))).kind, 'committed');
    assert.equal((await a.state.get('same-work'))?.goal.description, 'agent a work');
    assert.equal((await b.state.get('same-work'))?.goal.description, 'agent b work');
    assert.equal((await a.knowledge.commit({ expectedRevision: 0, commandId: 'create', commandDigest: 'a', next: note('A private memory') })).kind, 'committed');
    assert.equal(await b.knowledge.get('same-tenant', 'same-note'), null);
    assert.equal((await b.knowledge.commit({ expectedRevision: 0, commandId: 'create', commandDigest: 'b', next: note('B private memory') })).kind, 'committed');
    assert.equal((await a.knowledge.get('same-tenant', 'same-note'))?.body, 'A private memory');
    await a.close(); const reopened = await openAgentStores(f.profiles, f.a.root, undefined, { identityRegistryDirectory: f.registryDirectory });
    try { assert.equal((await reopened.state.get('same-work'))?.goal.description, 'agent a work'); assert.equal((await reopened.knowledge.get('same-tenant', 'same-note'))?.body, 'A private memory'); }
    finally { await reopened.close(); }
    for (const path of [f.a.paths.state, f.a.paths.memory, join(f.a.paths.metadata, 'channel.sqlite')]) assert.equal(statSync(path).mode & 0o077, 0);
  } finally { await a.close(); await b.close(); f.close(); }
});

test('agent work files cannot traverse into engine or another agent and remain separate', async () => {
  const f = fixture(); const a = await openAgentStores(f.profiles, f.a.root, undefined, { identityRegistryDirectory: f.registryDirectory }); const b = await openAgentStores(f.profiles, f.b.root, undefined, { identityRegistryDirectory: f.registryDirectory });
  try {
    const attributes = { tenantId: 'same-tenant', labels: [], lifecycleGeneration: 0 };
    await a.workspace.stage('same-work', 'same-attempt', 'report.txt', new TextEncoder().encode('A report'), attributes);
    assert.deepEqual(await b.workspace.list('same-work', 'same-attempt'), []);
    for (const path of ['../engine/overwrite.ts', '../../b/config.json', f.engine + '/overwrite.ts']) await assert.rejects(a.workspace.stage('same-work', 'same-attempt', path, new Uint8Array([1]), attributes));
    assert.equal(new TextDecoder().decode((await a.workspace.read('same-work', 'same-attempt', 'report.txt')).bytes), 'A report');
    const artifact = await a.artifacts.put(new Uint8Array([1, 2, 3]), { tenantId: 'same-tenant', labels: [], mediaType: 'application/octet-stream' });
    assert.equal(await a.artifacts.exists(artifact), true); assert.equal(await b.artifacts.exists(artifact), false);
  } finally { await a.close(); await b.close(); f.close(); }
});

test('copying another agents database is detected by its durable owner before runtime access', async () => {
  const f = fixture(); const a = await openAgentStores(f.profiles, f.a.root, undefined, { identityRegistryDirectory: f.registryDirectory }); const b = await openAgentStores(f.profiles, f.b.root, undefined, { identityRegistryDirectory: f.registryDirectory });
  try {
    await a.state.commit(command(initial('private-work'), 'seed')); await a.close(); await b.close();
    copyFileSync(f.a.paths.state, f.b.paths.state); const before = readFileSync(f.b.paths.state);
    await assert.rejects(openAgentStores(f.profiles, f.b.root, undefined, { identityRegistryDirectory: f.registryDirectory }), /agent_storage_owner_mismatch/);
    assert.deepEqual(readFileSync(f.b.paths.state), before);
  } finally { await a.close(); await b.close(); f.close(); }
});

test('unowned existing databases are not silently adopted', async () => {
  const f = fixture();
  try {
    writeFileSync(f.a.paths.state, '', { mode: 0o600 }); const db = new DatabaseSync(f.a.paths.state);
    db.exec('CREATE TABLE existing_private_data (value TEXT); INSERT INTO existing_private_data VALUES (\'keep\')'); db.close();
    await assert.rejects(openAgentStores(f.profiles, f.a.root, undefined, { identityRegistryDirectory: f.registryDirectory }), /agent_storage_owner_missing/);
    const check = new DatabaseSync(f.a.paths.state); try { assert.equal(check.prepare('SELECT value FROM existing_private_data').get()?.['value'], 'keep'); assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name='agent_storage_owner'").get(), undefined); } finally { check.close(); }
  } finally { f.close(); }
});

test('symlink database and sidecar destinations cannot overwrite another file', async () => {
  const f = fixture();
  try {
    const outside = join(f.engine, 'keep'); writeFileSync(outside, 'unchanged'); symlinkSync(outside, f.a.paths.state);
    await assert.rejects(openAgentStores(f.profiles, f.a.root, undefined, { identityRegistryDirectory: f.registryDirectory }), /agent_storage_path_unsafe/);
    unlinkSync(f.a.paths.state); symlinkSync(outside, f.a.paths.state + '-wal');
    await assert.rejects(openAgentStores(f.profiles, f.a.root, undefined, { identityRegistryDirectory: f.registryDirectory }), /agent_storage_path_unsafe/);
    assert.equal(readFileSync(outside, 'utf8'), 'unchanged');
  } finally { f.close(); }
});

test('changing config after SQLite initialization cannot replace it with an empty journal', async () => {
  const f = fixture();
  try {
    const stores = await openAgentStores(f.profiles, f.a.root, undefined, { identityRegistryDirectory: f.registryDirectory }); await stores.close();
    const path = join(f.a.root, 'config.json'); writeFileSync(path, JSON.stringify({ ...f.a.config, storage: { ...f.a.config.storage, state: 'file-journal' } }));
    await assert.rejects(openAgentStores(f.profiles, f.a.root, undefined, { identityRegistryDirectory: f.registryDirectory }), /agent_state_backend_mismatch/);
  } finally { f.close(); }
});
