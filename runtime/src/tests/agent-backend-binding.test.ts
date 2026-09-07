import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { FileJournalStateRepository } from '../infrastructure/file-journal-state.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';
import { advance, command, delivery, initial } from './state-conformance-helpers.js';
import type { AgentProfileStatus } from '../application/agent-profile-contracts.js';
import type { KnowledgeRecord } from '../domain/knowledge.js';
import type { Delivery } from '../domain/model.js';

type Backend = 'sqlite' | 'file-journal';
type ReadyProfile = Extract<AgentProfileStatus, { status: 'ready' }>;
const execute = promisify(execFile);
const cli = fileURLToPath(new URL('./helpers/agent-cli-isolated-worker.js', import.meta.url));
const actor = { tenantId: 'tenant-a', principalId: 'person-a' };
function put(path: string, value: unknown) { writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); }
function select(profiles: FileAgentProfileStore, profile: ReadyProfile, backend: Backend): ReadyProfile {
  const current = profiles.inspect(profile.root); assert.equal(current.status, 'ready');
  if (current.status !== 'ready') throw new Error('fixture_profile_not_ready');
  put(join(profile.root, 'config.json'), { ...current.config, storage: { ...current.config.storage, state: backend } });
  const selected = profiles.inspect(profile.root); assert.equal(selected.status, 'ready');
  if (selected.status !== 'ready') throw new Error('fixture_profile_not_ready');
  return selected;
}
function fixture(backend: Backend = 'file-journal') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-backend-binding-')));
  const engine = join(base, 'engine'); mkdirSync(engine, { mode: 0o700 });
  const profiles = new FileAgentProfileStore(engine);
  const a = select(profiles, profiles.initialize(join(base, 'a')), backend);
  const b = select(profiles, profiles.initialize(join(base, 'b')), backend);
  return { base, engine, registryDirectory: join(base, 'registry'), profiles, a, b, close: () => rmSync(base, { recursive: true, force: true }) };
}
function marker(profile: ReadyProfile) { return join(profile.paths.metadata, 'state-profile.json'); }
function otherState(profile: ReadyProfile) {
  return join(profile.paths.metadata, profile.config.storage.state === 'sqlite' ? 'state-journal' : 'runtime.sqlite');
}
function checkMarker(profile: ReadyProfile) {
  assert.deepEqual(JSON.parse(readFileSync(marker(profile), 'utf8')),
    { schemaVersion: 1, agentId: profile.identity.agentId, stateBackend: profile.config.storage.state });
  assert.equal(statSync(marker(profile)).mode & 0o077, 0);
}
type TreeEntry = { path: string; kind: string; mode: number; sha256?: string; target?: string };
function snapshot(root: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  const visit = (path: string, name: string) => {
    const stat = lstatSync(path); const mode = stat.mode & 0o777;
    if (stat.isSymbolicLink()) entries.push({ path: name, kind: 'link', mode, target: readlinkSync(path) });
    else if (stat.isDirectory()) {
      entries.push({ path: name, kind: 'directory', mode });
      for (const child of readdirSync(path).sort()) visit(join(path, child), name ? `${name}/${child}` : child);
    } else if (stat.isFile()) entries.push({ path: name, kind: 'file', mode, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
    else entries.push({ path: name, kind: 'special', mode });
  };
  visit(root, ''); return entries;
}
function privateCopy(path: string) {
  const stat = lstatSync(path);
  assert.equal(stat.isSymbolicLink(), false);
  if (stat.isDirectory()) {
    chmodSync(path, 0o700);
    for (const child of readdirSync(path)) privateCopy(join(path, child));
  } else {
    assert.equal(stat.isFile(), true); chmodSync(path, 0o600);
  }
}
function header(profile: ReadyProfile) { return JSON.parse(readFileSync(join(profile.paths.state, 'format.json'), 'utf8')); }
function note(body: string): KnowledgeRecord {
  return { id: 'same-note', tenantId: actor.tenantId, namespace: 'private-fixture', scope: 'fixture', authorId: actor.principalId,
    kind: 'experience', title: 'Synthetic private note', body, labels: ['synthetic'], revision: 1, contentRevision: 1,
    status: 'active', visibility: 'private', reviewState: 'private', review: null,
    sources: [{ workId: 'same-work', evidenceId: 'fixture-evidence', ownerId: actor.principalId, sourceId: 'fixture-source',
      sourceVersion: 'a'.repeat(64), generation: 0, observedAt: 1000, recordedAt: 1000, coverage: 'complete', labels: ['synthetic'] }],
    derivedFrom: [], createdAt: 1000, updatedAt: 1000, expiresAt: null };
}
function message(text: string): Delivery {
  return { ...delivery('same-work', 'same-ack'), text,
    context: { binding: { id: 'fixture-binding', channel: 'test', conversationId: 'same-conversation', recipientId: actor.principalId,
      destination: 'local', ...actor }, labels: ['synthetic'], sourceRevision: 1, responseId: null, evidenceIds: [],
    evidenceDigest: null, obligationIds: [], artifact: null } };
}
function checkSqliteOwner(path: string, profile: ReadyProfile, kind: 'state' | 'memory' | 'channel') {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare('SELECT schema_version, agent_id, kind FROM agent_storage_owner WHERE singleton=1').get();
    assert.equal(row?.['schema_version'], 1); assert.equal(row?.['agent_id'], profile.identity.agentId); assert.equal(row?.['kind'], kind);
  } finally { db.close(); }
  assert.equal(statSync(path).mode & 0o077, 0);
}

test('file-journal agents separate identical work IDs, events and historical receipts across reopen', async () => {
  const f = fixture();
  try {
    const a = await openAgentStores(f.profiles, f.a.root, undefined, { identityRegistryDirectory: f.registryDirectory }); const b = await openAgentStores(f.profiles, f.b.root, undefined, { identityRegistryDirectory: f.registryDirectory });
    const first = initial('same-work'); first.goal.description = 'Agent A synthetic work';
    const second = initial('same-work'); second.goal.description = 'Agent B synthetic work';
    const accepted = command(first, 'same-command', [message('Agent A acknowledged')]);
    const advanced = command(advance(first, 'A advanced'), 'next-command');
    try {
      assert.equal((await a.state.commit(accepted)).kind, 'committed'); assert.equal(await b.state.get('same-work'), null);
      assert.equal((await b.state.commit(command(second, 'same-command', [message('Agent B acknowledged')]))).kind, 'committed');
      assert.equal((await a.state.commit(advanced)).kind, 'committed');
      assert.deepEqual((await a.state.events('same-work', 0)).map(event => [event.sequence, event.commandId]), [[1, 'same-command'], [2, 'next-command']]);
      assert.deepEqual((await b.state.events('same-work', 0)).map(event => [event.sequence, event.commandId]), [[1, 'same-command']]);
      assert.deepEqual(await a.state.receipt('same-work', 'same-command'), { digest: accepted.commandDigest, state: first });
      assert.equal((await b.state.get('same-work'))?.goal.description, second.goal.description);
      assert.equal((await a.state.deliveries('same-work'))[0]?.text, 'Agent A acknowledged');
      assert.equal((await b.state.deliveries('same-work'))[0]?.text, 'Agent B acknowledged');
    } finally { await a.close(); await b.close(); }
    const reopened = await openAgentStores(f.profiles, f.a.root, undefined, { identityRegistryDirectory: f.registryDirectory });
    try {
      assert.deepEqual(await reopened.state.get('same-work'), advanced.next);
      assert.deepEqual(await reopened.state.commit(accepted), { kind: 'duplicate', state: first });
      assert.equal((await reopened.state.events('same-work', 0)).length, 2);
    } finally { await reopened.close(); }
    for (const profile of [f.a, f.b]) {
      checkMarker(profile); assert.equal(existsSync(otherState(profile)), false);
      const format = header(profile); assert.equal(format.schemaVersion, 2); assert.deepEqual(format.owner, { agentId: profile.identity.agentId, kind: 'state' });
    }
    assert.notEqual(header(f.a).storeId, header(f.b).storeId);
  } finally { f.close(); }
});

test('file-journal state keeps private memory and channel messages in separately owned SQLite databases', async () => {
  const f = fixture();
  try {
    const a = await openAgentStores(f.profiles, f.a.root, undefined, { identityRegistryDirectory: f.registryDirectory }); const b = await openAgentStores(f.profiles, f.b.root, undefined, { identityRegistryDirectory: f.registryDirectory });
    try {
      assert.equal((await a.knowledge.commit({ expectedRevision: 0, commandId: 'same-memory-command', commandDigest: 'A', next: note('Agent A memory') })).kind, 'committed');
      assert.equal(await b.knowledge.get(actor.tenantId, 'same-note'), null);
      assert.equal((await b.knowledge.commit({ expectedRevision: 0, commandId: 'same-memory-command', commandDigest: 'B', next: note('Agent B memory') })).kind, 'committed');
      assert.equal((await a.channel.send(message('Agent A private message'))).status, 'delivered');
      assert.deepEqual(await b.channel.messages(actor, 'test', 'same-conversation'), []);
      assert.equal((await b.channel.send(message('Agent B private message'))).status, 'delivered');
    } finally { await a.close(); await b.close(); }
    for (const [profile, body, text] of [[f.a, 'Agent A memory', 'Agent A private message'], [f.b, 'Agent B memory', 'Agent B private message']] as const) {
      checkSqliteOwner(profile.paths.memory, profile, 'memory'); checkSqliteOwner(join(profile.paths.metadata, 'channel.sqlite'), profile, 'channel');
      const reopened = await openAgentStores(f.profiles, profile.root, undefined, { identityRegistryDirectory: f.registryDirectory });
      try {
        assert.equal((await reopened.knowledge.get(actor.tenantId, 'same-note'))?.body, body);
        assert.deepEqual((await reopened.channel.messages(actor, 'test', 'same-conversation')).map(item => item.text), [text]);
      } finally { await reopened.close(); }
    }
  } finally { f.close(); }
});

test('a file-journal clone opens a fresh owned journal and empty SQLite memory and channel stores', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.a.paths.skills, 'SKILL.md'), 'Synthetic reusable skill', { mode: 0o600 });
    const source = await openAgentStores(f.profiles, f.a.root, undefined, { identityRegistryDirectory: f.registryDirectory });
    try {
      await source.state.commit(command(initial('same-work'), 'same-command', [message('Original conversation')]));
      await source.knowledge.commit({ expectedRevision: 0, commandId: 'memory-command', commandDigest: 'source', next: note('Original memory') });
      await source.channel.send(message('Original conversation'));
    } finally { await source.close(); }
    const before = snapshot(f.a.root); const oldHeader = header(f.a);
    const clone = f.profiles.clone(f.a.root, join(f.base, 'cloned')); const stores = await openAgentStores(f.profiles, clone.root, undefined, { identityRegistryDirectory: f.registryDirectory });
    try {
      assert.equal(clone.config.storage.state, 'file-journal'); assert.notEqual(clone.identity.agentId, f.a.identity.agentId);
      assert.equal(await stores.state.get('same-work'), null); assert.equal(await stores.state.receipt('same-work', 'same-command'), null);
      assert.deepEqual(await stores.state.events('same-work', 0), []); assert.deepEqual(await stores.state.deliveries('same-work'), []);
      assert.equal(await stores.knowledge.get(actor.tenantId, 'same-note'), null); assert.deepEqual(await stores.channel.messages(actor, 'test', 'same-conversation'), []);
      assert.equal((await stores.state.commit(command(initial('same-work'), 'same-command'))).kind, 'committed');
    } finally { await stores.close(); }
    assert.notEqual(header(clone).storeId, oldHeader.storeId); assert.deepEqual(header(clone).owner, { agentId: clone.identity.agentId, kind: 'state' });
    checkMarker(clone); checkSqliteOwner(clone.paths.memory, clone, 'memory'); checkSqliteOwner(join(clone.paths.metadata, 'channel.sqlite'), clone, 'channel');
    assert.equal(existsSync(otherState(clone)), false); assert.equal(readFileSync(join(clone.paths.skills, 'SKILL.md'), 'utf8'), 'Synthetic reusable skill');
    assert.deepEqual(snapshot(f.a.root), before);
  } finally { f.close(); }
});

test('copying another agents complete journal is rejected before binding a new backend marker', async () => {
  const f = fixture();
  try {
    const a = await openAgentStores(f.profiles, f.a.root, undefined, { identityRegistryDirectory: f.registryDirectory });
    try { await a.state.commit(command(initial('private-work'), 'private-command')); } finally { await a.close(); }
    cpSync(f.a.paths.state, f.b.paths.state, { recursive: true, errorOnExist: true, force: false });
    privateCopy(f.b.paths.state);
    const sourceBefore = snapshot(f.a.root); const copyBefore = snapshot(f.b.root);
    await assert.rejects(openAgentStores(f.profiles, f.b.root, undefined, { identityRegistryDirectory: f.registryDirectory }), /owner/);
    assert.equal(existsSync(marker(f.b)), false); assert.equal(existsSync(f.b.paths.memory), false);
    assert.equal(existsSync(join(f.b.paths.metadata, 'channel.sqlite')), false);
    assert.deepEqual(snapshot(f.a.root), sourceBefore); assert.deepEqual(snapshot(f.b.root), copyBefore);
  } finally { f.close(); }
});

test('file-journal selection does not bypass foreign memory or channel SQLite ownership', async () => {
  for (const kind of ['memory', 'channel'] as const) {
    const f = fixture();
    try {
      const a = await openAgentStores(f.profiles, f.a.root, undefined, { identityRegistryDirectory: f.registryDirectory }); const b = await openAgentStores(f.profiles, f.b.root, undefined, { identityRegistryDirectory: f.registryDirectory });
      try {
        await a.knowledge.commit({ expectedRevision: 0, commandId: 'private', commandDigest: 'source', next: note('Source-only memory') });
        await a.channel.send(message('Source-only channel history'));
      } finally { await a.close(); await b.close(); }
      const sourcePath = kind === 'memory' ? f.a.paths.memory : join(f.a.paths.metadata, 'channel.sqlite');
      const targetPath = kind === 'memory' ? f.b.paths.memory : join(f.b.paths.metadata, 'channel.sqlite');
      copyFileSync(sourcePath, targetPath); privateCopy(targetPath); const copied = readFileSync(targetPath); const sourceBefore = snapshot(f.a.root);
      await assert.rejects(openAgentStores(f.profiles, f.b.root, undefined, { identityRegistryDirectory: f.registryDirectory }), /owner/);
      assert.deepEqual(readFileSync(targetPath), copied); assert.deepEqual(snapshot(f.a.root), sourceBefore);
    } finally { f.close(); }
  }
});

test('empty and populated legacy v1 journals are not automatically adopted by an agent', async () => {
  for (const populated of [false, true]) {
    const f = fixture();
    try {
      const legacy = new FileJournalStateRepository(f.a.paths.state);
      try { if (populated) await legacy.commit(command(initial('legacy-work'), 'legacy-command')); } finally { await legacy.close(); }
      assert.equal(header(f.a).schemaVersion, 1); const before = snapshot(f.a.root);
      await assert.rejects(openAgentStores(f.profiles, f.a.root, undefined, { identityRegistryDirectory: f.registryDirectory }), /owner/);
      assert.equal(existsSync(marker(f.a)), false); assert.equal(existsSync(f.a.paths.memory), false);
      assert.deepEqual(snapshot(f.a.root), before);
    } finally { f.close(); }
  }
});

test('changing config between SQLite and file-journal never creates a replacement state store', async () => {
  for (const backend of ['sqlite', 'file-journal'] as const) {
    const f = fixture(backend);
    try {
      const stores = await openAgentStores(f.profiles, f.a.root, undefined, { identityRegistryDirectory: f.registryDirectory });
      try { await stores.state.commit(command(initial('retained-work'), 'retained-command')); } finally { await stores.close(); }
      const markerBefore = readFileSync(marker(f.a)); const originalBefore = snapshot(f.a.paths.metadata);
      const replacement = select(f.profiles, f.a, backend === 'sqlite' ? 'file-journal' : 'sqlite');
      await assert.rejects(openAgentStores(f.profiles, f.a.root, undefined, { identityRegistryDirectory: f.registryDirectory }), /backend|profile/);
      assert.equal(existsSync(replacement.paths.state), false); assert.deepEqual(readFileSync(marker(f.a)), markerBefore);
      assert.deepEqual(snapshot(f.a.paths.metadata), originalBefore);
      select(f.profiles, replacement, backend); const reopened = await openAgentStores(f.profiles, f.a.root, undefined, { identityRegistryDirectory: f.registryDirectory });
      try { assert.equal((await reopened.state.get('retained-work'))?.id, 'retained-work'); assert.ok(await reopened.state.receipt('retained-work', 'retained-command')); }
      finally { await reopened.close(); }
    } finally { f.close(); }
  }
});

test('an owned legacy SQLite agent gains only its backend marker and preserves historical data', async () => {
  const f = fixture('sqlite');
  try {
    const stores = await openAgentStores(f.profiles, f.a.root, undefined, { identityRegistryDirectory: f.registryDirectory }); const accepted = command(initial('legacy-owned-work'), 'legacy-owned-command');
    try { await stores.state.commit(accepted); await stores.knowledge.commit({ expectedRevision: 0, commandId: 'memory', commandDigest: 'legacy', next: note('Retained SQLite memory') }); }
    finally { await stores.close(); }
    unlinkSync(marker(f.a)); checkSqliteOwner(f.a.paths.state, f.a, 'state');
    const reopened = await openAgentStores(f.profiles, f.a.root, undefined, { identityRegistryDirectory: f.registryDirectory });
    try {
      assert.deepEqual(await reopened.state.get(accepted.workId), accepted.next);
      assert.deepEqual(await reopened.state.receipt(accepted.workId, accepted.commandId), { digest: accepted.commandDigest, state: accepted.next });
      assert.equal((await reopened.knowledge.get(actor.tenantId, 'same-note'))?.body, 'Retained SQLite memory');
    } finally { await reopened.close(); }
    checkMarker(f.a); assert.equal(existsSync(otherState(f.a)), false);
  } finally { f.close(); }
});

test('an unowned legacy SQLite database is preserved without creating a backend marker', async () => {
  const f = fixture('sqlite');
  try {
    writeFileSync(f.a.paths.state, '', { mode: 0o600 }); const legacy = new DatabaseSync(f.a.paths.state);
    try { legacy.exec("CREATE TABLE preserved_data(value TEXT); INSERT INTO preserved_data VALUES('synthetic legacy data');"); } finally { legacy.close(); }
    const before = snapshot(f.a.root); await assert.rejects(openAgentStores(f.profiles, f.a.root, undefined, { identityRegistryDirectory: f.registryDirectory }), /owner/);
    assert.equal(existsSync(marker(f.a)), false); assert.equal(existsSync(f.a.paths.memory), false); assert.deepEqual(snapshot(f.a.root), before);
    const check = new DatabaseSync(f.a.paths.state, { readOnly: true });
    try {
      assert.equal(check.prepare('SELECT value FROM preserved_data').get()?.['value'], 'synthetic legacy data');
      assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name='agent_storage_owner'").get(), undefined);
    } finally { check.close(); }
  } finally { f.close(); }
});

test('copying another agents backend marker is rejected before creating any state or private databases', async () => {
  const f = fixture();
  try {
    const a = await openAgentStores(f.profiles, f.a.root, undefined, { identityRegistryDirectory: f.registryDirectory }); await a.close(); copyFileSync(marker(f.a), marker(f.b));
    const before = snapshot(f.b.root); await assert.rejects(openAgentStores(f.profiles, f.b.root, undefined, { identityRegistryDirectory: f.registryDirectory }), /owner|profile/);
    assert.equal(existsSync(f.b.paths.state), false); assert.equal(existsSync(f.b.paths.memory), false);
    assert.equal(existsSync(join(f.b.paths.metadata, 'channel.sqlite')), false); assert.deepEqual(snapshot(f.b.root), before);
  } finally { f.close(); }
});

test('malformed, unsupported or linked backend markers cannot initialize state stores', async () => {
  for (const variant of ['malformed', 'unsupported', 'linked'] as const) {
    const f = fixture();
    try {
      if (variant === 'malformed') writeFileSync(marker(f.a), '{broken', { mode: 0o600 });
      else if (variant === 'unsupported') put(marker(f.a), { schemaVersion: 999, agentId: f.a.identity.agentId, stateBackend: 'file-journal' });
      else {
        const outside = join(f.engine, 'outside.json'); put(outside, { schemaVersion: 1, agentId: f.a.identity.agentId, stateBackend: 'file-journal' });
        symlinkSync(outside, marker(f.a));
      }
      const before = snapshot(f.a.root); const outsideBefore = snapshot(f.engine);
      await assert.rejects(openAgentStores(f.profiles, f.a.root, undefined, { identityRegistryDirectory: f.registryDirectory }), /agent_|profile/);
      assert.equal(existsSync(f.a.paths.state), false); assert.equal(existsSync(f.a.paths.memory), false);
      assert.deepEqual(snapshot(f.a.root), before); assert.deepEqual(snapshot(f.engine), outsideBefore);
    } finally { f.close(); }
  }
});

test('ambiguous existing SQLite and journal stores are preserved without choosing a new backend', async () => {
  const f = fixture('sqlite');
  try {
    const stores = await openAgentStores(f.profiles, f.a.root, undefined, { identityRegistryDirectory: f.registryDirectory });
    try { await stores.state.commit(command(initial('sqlite-work'), 'sqlite-command')); } finally { await stores.close(); }
    const legacyJournal = new FileJournalStateRepository(otherState(f.a));
    try { await legacyJournal.commit(command(initial('journal-work'), 'journal-command')); } finally { await legacyJournal.close(); }
    unlinkSync(marker(f.a)); const before = snapshot(f.a.root);
    await assert.rejects(openAgentStores(f.profiles, f.a.root, undefined, { identityRegistryDirectory: f.registryDirectory }), /ambiguous|backend|profile/);
    assert.equal(existsSync(marker(f.a)), false); assert.deepEqual(snapshot(f.a.root), before);
  } finally { f.close(); }
});

test('concurrent CLI first storage opens retain one agent, backend selection and journal identity', async () => {
  for (const backend of ['sqlite', 'file-journal'] as const) {
    const f = fixture(backend);
    try {
      const results = await Promise.allSettled(Array.from({ length: 4 }, () => execute(process.execPath,
        [cli, 'init', '--directory', f.a.root, '--json'], { timeout: 20000, maxBuffer: 1024 * 1024, env: { ...process.env, SECUMON_TEST_IDENTITY_REGISTRY: f.registryDirectory } })));
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) {
        const details = results.map((result, index) => {
          const output = result.status === 'fulfilled' ? result.value : result.reason as { stdout?: string; stderr?: string };
          return JSON.stringify({ index, status: result.status, error: result.status === 'rejected' ? String(result.reason) : null,
            stdout: output?.stdout ?? '', stderr: output?.stderr ?? '' });
        }).join('\n');
        throw new AggregateError(failures, `concurrent_agent_backend_initialization_failed:${backend}\n${details}`);
      }
      const replies = results.flatMap(result => result.status === 'fulfilled' ? [JSON.parse(result.value.stdout)] : []);
      assert.equal(replies.length, 4);
      for (const reply of replies) {
        assert.equal(reply.identity.agentId, f.a.identity.agentId); assert.equal(reply.config.storage.state, backend);
        assert.equal(reply.storageInitialized, true); assert.equal(reply.runtimeConnected, false);
      }
      checkMarker(f.a); assert.equal(existsSync(otherState(f.a)), false);
      if (backend === 'file-journal') {
        const format = header(f.a); assert.deepEqual(format.owner, { agentId: f.a.identity.agentId, kind: 'state' });
        const reopened = await openAgentStores(f.profiles, f.a.root, undefined, { identityRegistryDirectory: f.registryDirectory });
        try { assert.equal(header(f.a).storeId, format.storeId); assert.equal(await reopened.state.get('missing'), null); }
        finally { await reopened.close(); }
      } else checkSqliteOwner(f.a.paths.state, f.a, 'state');
    } finally { f.close(); }
  }
});
