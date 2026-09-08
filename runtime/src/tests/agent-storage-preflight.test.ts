import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { EngineRelease } from '../application/agent-lifecycle-contracts.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';
import { bindAgentDatabase } from '../infrastructure/agent-database-owner.js';
import { bindAgentStateProfile } from '../infrastructure/agent-state-profile.js';
import { checkAgentLifecycle } from '../infrastructure/agent-lifecycle.js';
import { engineCompatibility, publishLifecycleManifest } from '../infrastructure/agent-engine-release.js';
import { lifecycleDigest } from '../infrastructure/agent-lifecycle-files.js';
import { openHostSqliteDatabase } from '../infrastructure/windows-sqlite.js';
import { LocalChannel } from '../infrastructure/local-channel.js';
import { initial, command, delivery } from './state-conformance-helpers.js';

function fixture(options: { personalMemory?: 'documents' } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-storage-preflight-'))), engine = join(base, 'engine');
  mkdirSync(engine, { mode: 0o700 });
  const profiles = new FileAgentProfileStore(engine), profile = profiles.initialize(join(base, 'agent'), options);
  const paths = [profile.paths.state, profile.paths.memory, join(profile.paths.metadata, 'channel.sqlite')];
  return { base, profiles, profile, paths,
    open: () => openAgentStores(profiles, profile.root, undefined, { identityRegistryDirectory: join(base, 'identities') }),
    close: () => rmSync(base, { recursive: true, force: true }) };
}
function database<T>(path: string, action: (db: DatabaseSync) => T, readOnly = false): T {
  const db = openHostSqliteDatabase(path, { readOnly });
  try { return action(db); } finally { db.close(); }
}
// The original base tables and raw records are identical in state v1; only the later derived indexes are removed.
function legacyState(path: string) {
  database(path, db => db.exec(`BEGIN IMMEDIATE;
    DROP TRIGGER works_query_insert; DROP TRIGGER works_query_update; DROP TRIGGER works_query_delete;
    DROP TRIGGER events_query_insert; DROP TRIGGER events_query_update; DROP TRIGGER events_query_delete;
    DROP TABLE event_metadata; DROP TABLE conversation_work; PRAGMA user_version=1; COMMIT;`));
}
function originals(f: ReturnType<typeof fixture>) { return f.paths.map(path => readFileSync(path)); }
function preserved(f: ReturnType<typeof fixture>, before: Buffer[]) {
  assert.deepEqual(originals(f), before, 'no database main bytes may change before rejecting the known incompatible format');
  assert.equal(database(f.profile.paths.state, db => db.prepare('PRAGMA user_version').get()?.['user_version'], true), 1);
  assert.equal(database(f.profile.paths.state, db => db.prepare("SELECT name FROM sqlite_master WHERE name='event_metadata'").get(), true), undefined);
}
async function seed(f: ReturnType<typeof fixture>, compact = false) {
  const stores = await f.open();
  try {
    assert.equal((await stores.state.commit(command(initial(), 'original-command', [delivery()]))).kind, 'committed');
    if (compact) {
      const { scope } = await stores.sessions.open({ tenantId: 'tenant-a', principalId: 'person-a', agentId: f.profile.identity.agentId }, { route: 'cli', now: 1 });
      await stores.sessions.receive({ scope, messageId: 'original-user', digest: 'a'.repeat(64), text: 'Keep this original message.', payload: {},
        kind: 'work', workId: 'work-1', labels: ['synthetic'], receivedAt: 1 });
      await stores.sessions.publishSummary(scope, 0, { scope, ref: { id: 'summary-1', throughSequence: 1, policyDigest: 'b'.repeat(64), digest: 'c'.repeat(64) },
        content: { narrative: 'A derived summary, separate from the original.', retained: [] }, workId: 'work-1', callId: 'compact-1',
        inputDigest: 'd'.repeat(64), prefix: { throughSequence: 1, entries: 1, digest: 'e'.repeat(64) }, previous: null, createdAt: 2 });
    }
  } finally { await stores.close(); }
  legacyState(f.profile.paths.state);
}
function candidate(f: ReturnType<typeof fixture>, compact: number[] | undefined, name: string) {
  const directory = join(f.base, name); mkdirSync(directory, { mode: 0o700 });
  const compatibility: EngineRelease['compatibility'] = structuredClone(engineCompatibility);
  if (compact === undefined) delete compatibility.sessionCompact; else compatibility.sessionCompact = compact;
  // A metadata-only release is sufficient to exercise lifecycle inspection; it is never executed or installed.
  const body = { schemaVersion: 1 as const, kind: 'secumon-engine-release' as const, version: '0.1.0', node: '>=24.20.0 <25' as const,
    platform: process.platform, arch: process.arch, compatibility, entries: [] };
  publishLifecycleManifest(directory, 'release.json', { ...body, digest: lifecycleDigest(body) });
  return directory;
}

for (const kind of ['knowledge', 'session'] as const) test(`storage preflight rejects unsupported ${kind} before committing the older state migration`, async () => {
  const f = fixture();
  try {
    await seed(f);
    database(kind === 'knowledge' ? f.paths[1]! : f.paths[2]!, db => db.exec(`UPDATE ${kind}_schema SET version=999;`));
    const before = originals(f);
    await assert.rejects(f.open(), /engine_storage_incompatible/);
    preserved(f, before);
  } finally { f.close(); }
});

test('storage preflight refuses ambiguous knowledge version rows before changing original state', async () => {
  const f = fixture();
  try {
    await seed(f); database(f.profile.paths.memory, db => db.exec('INSERT INTO knowledge_schema(version) VALUES(2);'));
    const before = originals(f);
    await assert.rejects(f.open(), /lifecycle_storage_version_invalid/);
    preserved(f, before);
    assert.throws(() => checkAgentLifecycle(f.profiles, f.profile.root, candidate(f, [1], 'candidate')), /lifecycle_storage_version_invalid/);
    preserved(f, before);
  } finally { f.close(); }
});

test('storage preflight checks the physical compact format before migrating work state', async () => {
  const f = fixture();
  try {
    await seed(f, true); database(f.paths[2]!, db => db.exec('UPDATE session_compact_schema SET version=999;'));
    const before = originals(f);
    await assert.rejects(f.open(), /engine_session_compact_incompatible/);
    preserved(f, before);
    assert.throws(() => checkAgentLifecycle(f.profiles, f.profile.root, candidate(f, [1], 'candidate')), /engine_session_compact_incompatible/);
    preserved(f, before);
  } finally { f.close(); }
});

test('storage preflight refuses a partial compact schema while preserving the original summary and work', async () => {
  const f = fixture();
  try {
    await seed(f, true); database(f.paths[2]!, db => db.exec('DROP TABLE session_summary_publications;'));
    const before = originals(f);
    await assert.rejects(f.open(), /invalid_session_compact_storage/);
    preserved(f, before);
  } finally { f.close(); }
});

test('lifecycle checks inherited compact version one support and explicit omission without changing the old state', async () => {
  const f = fixture();
  try {
    await seed(f, true); const before = originals(f);
    const legacy = checkAgentLifecycle(f.profiles, f.profile.root, candidate(f, undefined, 'legacy-manifest'));
    assert.equal(legacy.storage.state, 1); assert.equal(legacy.storage.sessionCompact, 1); preserved(f, before);
    assert.throws(() => checkAgentLifecycle(f.profiles, f.profile.root, candidate(f, [], 'no-compact-support')), /engine_session_compact_incompatible/);
    preserved(f, before);
  } finally { f.close(); }
});

test('storage preflight refuses an unsupported document memory format before migrating original work', async () => {
  const f = fixture({ personalMemory: 'documents' });
  try {
    await seed(f);
    const path = join(f.profile.root, 'memory', 'documents', 'format.json');
    const format = JSON.parse(readFileSync(path, 'utf8')) as { schemaVersion: number };
    writeFileSync(path, JSON.stringify({ ...format, schemaVersion: 999 }) + '\n');
    const before = originals(f), document = readFileSync(path);
    await assert.rejects(f.open());
    preserved(f, before); assert.deepEqual(readFileSync(path), document);
  } finally { f.close(); }
});

for (const legacyChannel of [false, true]) test(`storage preflight recovers assigned owner-only databases with legacy channel ${legacyChannel}`, async () => {
  const f = fixture();
  try {
    bindAgentStateProfile(f.profile);
    for (const [index, kind] of ['state', 'memory', 'channel'].entries()) bindAgentDatabase(f.paths[index]!, f.profile.identity.agentId, kind as 'state' | 'memory' | 'channel');
    if (legacyChannel) {
      const channel = new LocalChannel(f.paths[2]!); channel.close();
      database(f.paths[2]!, db => db.prepare('INSERT INTO local_messages VALUES(?,?,?,?,?)')
        .run('legacy-work', 'legacy-delivery', 'legacy-digest', 'legacy-external', JSON.stringify(delivery('legacy-work', 'legacy-delivery'))));
    }
    const owners = f.paths.map(path => database(path, db => db.prepare('SELECT * FROM agent_storage_owner').all(), true));
    const legacy = legacyChannel ? database(f.paths[2]!, db => db.prepare('SELECT * FROM local_messages').all(), true) : null;
    const stores = await f.open();
    try { assert.equal(await stores.state.get('not-created'), null); assert.ok(stores.sessions); }
    finally { await stores.close(); }
    assert.deepEqual(f.paths.map(path => database(path, db => db.prepare('SELECT * FROM agent_storage_owner').all(), true)), owners);
    if (legacy) assert.deepEqual(database(f.paths[2]!, db => db.prepare('SELECT * FROM local_messages').all(), true), legacy);
    assert.equal(database(f.profile.paths.state, db => db.prepare('PRAGMA user_version').get()?.['user_version'], true), 3);
  } finally { f.close(); }
});
