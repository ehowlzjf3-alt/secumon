import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Delivery, Policy } from '../domain/model.js';
import type { SessionIntake, SessionScope } from '../domain/session.js';
import { LocalChannel } from '../infrastructure/local-channel.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';

const owner = { tenantId: 'tenant', agentId: 'agent', principalId: 'person' };
const policy: Policy = { tenantId: owner.tenantId, principalId: owner.principalId, allowedTools: [], allowedLabels: ['public'], allowedDestinations: ['local'], allowWrites: false };
const digester = new Sha256Digester();
function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'sqlite-sessions-'))); const path = join(directory, 'channel.sqlite');
  let channel = new LocalChannel(path, owner.agentId);
  return { path, get channel() { return channel; }, get sessions() { return channel.sessions!; },
    reopen() { channel.close(); channel = new LocalChannel(path, owner.agentId); },
    close() { channel.close(); rmSync(directory, { recursive: true, force: true }); } };
}
function intake(scope: SessionScope, messageId: string, workId = messageId, labels = ['public']): SessionIntake {
  return { scope, messageId, workId, labels, text: `original user ${messageId}`, kind: 'work', receivedAt: 10,
    payload: { requested: messageId }, digest: digester.digest({ messageId, workId }) };
}
function delivery(scope: SessionScope, workId: string, id = 'result', labels = ['public']): Delivery {
  return { id, workId, goalRevision: 1, destination: 'local', kind: 'result', text: `answer ${workId}/${id}`, status: 'pending', externalId: null,
    context: { binding: { id: 'binding', channel: 'cli', conversationId: 'route', recipientId: scope.principalId, destination: 'local',
      tenantId: scope.tenantId, principalId: scope.principalId, session: scope }, labels, sourceRevision: 1, responseId: null,
      evidenceIds: [], evidenceDigest: null, obligationIds: [], artifact: null } };
}
function inspect<T>(path: string, action: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path); try { return action(db); } finally { db.close(); }
}
const candidate = (throughSequence: number, digest = 'a') => ({ throughSequence, digest: digest.repeat(64), policyDigest: 'f'.repeat(64) });

test('session aliases persist by owner and route; explicit identifiers only resume their exact scope', async () => {
  const f = fixture();
  try {
    const first = await f.sessions.open(owner, { route: 'cli', now: 10 });
    assert.deepEqual(await f.sessions.open(owner, { route: 'cli', now: 99 }), first);
    const web = await f.sessions.open(owner, { route: 'web', now: 20 }); assert.notEqual(first.scope.sessionId, web.scope.sessionId);
    const fresh = await f.sessions.open(owner, { route: 'cli', newSession: true, now: 30 }); assert.notEqual(fresh.scope.sessionId, first.scope.sessionId);
    f.reopen(); assert.deepEqual(await f.sessions.open(owner, { route: 'cli', now: 100 }), fresh);
    assert.deepEqual(await f.sessions.open(owner, { route: 'cli', sessionId: first.scope.sessionId, now: 100 }), first);
    assert.deepEqual(await f.sessions.open(owner, { route: 'cli', now: 101 }), first);
    await assert.rejects(f.sessions.open(owner, { route: 'cli', sessionId: 'not-created', now: 1 }), /session_unavailable/);
    await assert.rejects(f.sessions.open(owner, { route: 'cli', sessionId: first.scope.sessionId, newSession: true, now: 1 }), /invalid_session_open/);
    for (const changed of [{ tenantId: 'other' }, { principalId: 'other' }, { agentId: 'other' }]) {
      await assert.rejects(f.sessions.get({ ...first.scope, ...changed }), /session_unavailable/);
      await assert.rejects(f.sessions.open({ ...owner, ...changed }, { route: 'cli', sessionId: first.scope.sessionId, now: 1 }), /session_unavailable/);
    }
    const other = await f.sessions.open({ ...owner, principalId: 'other' }, { route: 'cli', now: 1 }); assert.notEqual(other.scope.sessionId, first.scope.sessionId);
  } finally { f.close(); }
});

test('intake receipt is durable and idempotent; late settlement never replaces a newer active work', async () => {
  const f = fixture();
  try {
    const { scope } = await f.sessions.open(owner, { route: 'cli', now: 1 }); const x = intake(scope, 'x'), y = intake(scope, 'y');
    assert.equal((await f.sessions.receive(x)).input.sequence, 1); assert.equal((await f.sessions.receive(y)).input.sequence, 2);
    const duplicate = await f.sessions.receive({ ...x, receivedAt: 100 }); assert.equal(duplicate.created, false); assert.equal(duplicate.input.receivedAt, 10);
    for (const changed of [{ digest: 'e'.repeat(64) }, { text: 'different' }, { payload: { requested: 'different' } }, { workId: 'different' }, { labels: ['secret'] }]) {
      await assert.rejects(f.sessions.receive({ ...x, ...changed }), /session_input_identity_conflict/);
    }
    assert.deepEqual((await f.sessions.pending(scope, 1)).map(input => input.messageId), ['x']);
    await assert.rejects(f.sessions.pending(scope, 0)); await assert.rejects(f.sessions.pending(scope, 257));
    await f.sessions.settle(scope, y.messageId, y.digest, { status: 'applied' }); f.reopen();
    assert.deepEqual((await f.sessions.pending(scope, 256)).map(input => input.messageId), ['x']);
    await f.sessions.settle(scope, x.messageId, x.digest, { status: 'applied' });
    const current = await f.sessions.get(scope); assert.equal(current.activeWorkId, 'y'); assert.equal(current.activeInputSequence, 2); assert.equal(current.lastSequence, 2);
    await f.sessions.settle(scope, x.messageId, x.digest, { status: 'applied' }); assert.deepEqual(await f.sessions.get(scope), current);
    await assert.rejects(f.sessions.settle(scope, x.messageId, 'b'.repeat(64), { status: 'applied' }), /session_input_identity_conflict/);
    await assert.rejects(f.sessions.settle(scope, x.messageId, x.digest, { status: 'rejected', reason: 'changed' }), /session_input_settlement_conflict/);
    const z = intake(scope, 'z'); await f.sessions.receive(z); await f.sessions.settle(scope, 'z', z.digest, { status: 'rejected', reason: 'not_authorized' });
    assert.equal((await f.sessions.get(scope)).activeWorkId, 'y'); assert.equal((await f.sessions.input(scope, 'z'))?.rejection, 'not_authorized');
    assert.deepEqual(await f.sessions.pending(scope, 256), []);
    assert.deepEqual((await f.sessions.history(scope, policy, { limit: 10 })).entries.map(entry => [entry.sequence, entry.text]),
      [[1, x.text], [2, y.text], [3, z.text]]);
  } finally { f.close(); }
});

test('head CAS retains tail and historic prefixes, assigning each candidate one permanent revision', async () => {
  const f = fixture();
  try {
    const { scope } = await f.sessions.open(owner, { route: 'cli', now: 1 });
    await f.sessions.receive(intake(scope, 'x')); await f.sessions.receive(intake(scope, 'y'));
    const y = await f.sessions.publishHead(scope, 0, candidate(2)); assert.equal(y?.revision, 1);
    assert.equal(await f.sessions.publishHead(scope, 0, candidate(2)), null, 'CAS is checked even for a canonical candidate');
    const before = await f.sessions.get(scope); const x = await f.sessions.retainHead(scope, candidate(1, 'b'));
    assert.equal(x.revision, 2); assert.deepEqual(await f.sessions.get(scope), before, 'retention changes neither active head nor tail');
    assert.deepEqual(await f.sessions.retainHead(scope, candidate(1, 'b')), x);
    assert.deepEqual(await f.sessions.head(scope, candidate(1, 'b')), x);
    assert.equal(await f.sessions.publishHead(scope, y!.revision, candidate(1, 'b')), null, 'current head cannot move backwards');
    assert.deepEqual(await f.sessions.publishHead(scope, y!.revision, candidate(2)), y);
    await f.sessions.receive(intake(scope, 'z'));
    const z = await f.sessions.publishHead(scope, y!.revision, candidate(3, 'c')); assert.equal(z?.revision, 3, 'retained revisions are not reused');
    await f.sessions.receive(intake(scope, 'tail')); const record = await f.sessions.get(scope); assert.equal(record.lastSequence, 4); assert.equal(record.head?.throughSequence, 3);
    assert.deepEqual(await f.sessions.head(scope, candidate(2)), y); assert.deepEqual(await f.sessions.head(scope, candidate(1, 'b')), x);
    await assert.rejects(f.sessions.publishHead(scope, z!.revision, candidate(5)), /invalid_session_head/);
    await assert.rejects(f.sessions.retainHead(scope, candidate(4, 'd')), /invalid_session_head/);
    f.reopen(); assert.deepEqual(await f.sessions.get(scope), record); assert.deepEqual(await f.sessions.head(scope, candidate(1, 'b')), x);
    assert.equal(inspect(f.path, db => db.prepare('SELECT COUNT(*) AS n FROM session_heads').get()?.['n']), 3);
  } finally { f.close(); }
});

test('local response reference and canonical message commit atomically, with no response-body copy', async () => {
  const f = fixture();
  try {
    const { scope } = await f.sessions.open(owner, { route: 'cli', now: 1 }); await f.sessions.receive(intake(scope, 'x'));
    const d = delivery(scope, 'x');
    inspect(f.path, db => db.exec("CREATE TRIGGER fail_reference BEFORE INSERT ON session_entries WHEN NEW.role='assistant' BEGIN SELECT RAISE(ABORT,'injected_session_reference_failure'); END;"));
    await assert.rejects(f.channel.send(d), /injected_session_reference_failure/);
    assert.equal((await f.channel.lookup(d)).status, 'absent'); assert.equal((await f.sessions.get(scope)).lastSequence, 1);
    assert.equal(inspect(f.path, db => db.prepare('SELECT COUNT(*) AS n FROM local_messages').get()?.['n']), 0);
    inspect(f.path, db => db.exec('DROP TRIGGER fail_reference'));
    const receipt = await f.channel.send(d); assert.equal(receipt.status, 'delivered'); assert.deepEqual(await f.channel.send(d), receipt);
    assert.equal((await f.sessions.get(scope)).lastSequence, 2);
    assert.equal((await f.channel.send({ ...d, text: 'changed body' })).status, 'unknown');
    assert.equal((await f.sessions.history(scope, policy, { limit: 10 })).entries[1]?.text, d.text);
    const other = delivery(scope, 'other-work'); await f.channel.send(other);
    const responses = (await f.sessions.history(scope, policy, { limit: 10 })).entries.filter(entry => entry.role === 'assistant');
    assert.deepEqual(responses.map(entry => [entry.workId, entry.sourceId, entry.sequence]), [['x', 'result', 2], ['other-work', 'result', 3]]);
    const columns = inspect(f.path, db => db.prepare('PRAGMA table_info(session_entries)').all().map(row => row['name']));
    assert.ok(!columns.includes('body') && !columns.includes('text') && !columns.includes('artifact'));
    f.reopen(); assert.deepEqual(await f.channel.lookup(d), receipt); assert.equal((await f.sessions.history(scope, policy, { limit: 10 })).entries.length, 3);
  } finally { f.close(); }
});

test('a failed user-reference transaction leaves neither receipt nor consumed sequence', async () => {
  const f = fixture();
  try {
    const { scope } = await f.sessions.open(owner, { route: 'cli', now: 1 }); const x = intake(scope, 'x');
    inspect(f.path, db => db.exec("CREATE TRIGGER fail_user_reference BEFORE INSERT ON session_entries WHEN NEW.role='user' BEGIN SELECT RAISE(ABORT,'injected_user_reference_failure'); END;"));
    await assert.rejects(f.sessions.receive(x), /injected_user_reference_failure/);
    assert.equal(await f.sessions.input(scope, 'x'), null); assert.equal((await f.sessions.get(scope)).lastSequence, 0);
    inspect(f.path, db => db.exec('DROP TRIGGER fail_user_reference'));
    assert.equal((await f.sessions.receive(x)).input.sequence, 1);
  } finally { f.close(); }
});

test('history applies label and destination policy before paging and binds cursors to a fixed scope/policy/prefix', async () => {
  const f = fixture();
  try {
    const { scope } = await f.sessions.open(owner, { route: 'cli', now: 1 });
    await f.sessions.receive(intake(scope, 'public')); await f.sessions.receive(intake(scope, 'hidden', 'hidden', ['secret']));
    await f.channel.send(delivery(scope, 'public')); await f.channel.send(delivery(scope, 'hidden', 'hidden-result', ['secret']));
    const artifactDelivery = delivery(scope, 'artifact'); artifactDelivery.context!.artifact = { id: 'artifact', sha256: 'a'.repeat(64), byteLength: 1,
      mediaType: 'text/plain', tenantId: scope.tenantId, labels: ['secret'] }; await f.channel.send(artifactDelivery);
    await f.sessions.receive(intake(scope, 'tail'));
    const page = await f.sessions.history(scope, policy, { limit: 1 }); assert.deepEqual(page.entries.map(entry => entry.sequence), [1]); assert.ok(page.nextCursor);
    await f.sessions.receive(intake(scope, 'after-snapshot'));
    const rest = await f.sessions.history(scope, policy, { limit: 10, cursor: page.nextCursor }); assert.deepEqual(rest.entries.map(entry => entry.sequence), [3, 6]); assert.equal(rest.nextCursor, null);
    const noDestination = { ...policy, allowedDestinations: [] };
    assert.deepEqual((await f.sessions.history(scope, noDestination, { limit: 10 })).entries.map(entry => entry.sequence), [1, 6, 7]);
    assert.equal((await f.sessions.history(scope, { ...policy, allowedLabels: ['public', 'secret'] }, { limit: 10 })).entries.length, 7);
    for (const changedPolicy of [noDestination, { ...policy, allowedLabels: ['public', 'secret'] }, { ...policy, allowWrites: true }]) {
      await assert.rejects(f.sessions.history(scope, changedPolicy, { limit: 10, cursor: page.nextCursor }), /invalid_session_cursor/);
    }
    await assert.rejects(f.sessions.history(scope, policy, { limit: 10, cursor: page.nextCursor, throughSequence: 7 }), /invalid_session_cursor/);
    await assert.rejects(f.sessions.history(scope, { ...policy, principalId: 'other' }, { limit: 10 }), /session_unavailable/);
    const other = await f.sessions.open(owner, { route: 'other', now: 1 });
    await assert.rejects(f.sessions.history(other.scope, policy, { limit: 10, cursor: page.nextCursor }), /invalid_session_cursor/);
    await assert.rejects(f.sessions.history(scope, policy, { limit: 10, cursor: page.nextCursor + '=' }), /invalid_session_cursor/);
  } finally { f.close(); }
});

test('delivery scope mismatch cannot append a message, and a missing session reference cannot claim delivered', async () => {
  const f = fixture();
  try {
    const { scope } = await f.sessions.open(owner, { route: 'cli', now: 1 }); const good = delivery(scope, 'x');
    for (const changed of [{ agentId: 'other' }, { sessionId: 'missing' }, { principalId: 'other' }, { tenantId: 'other' }]) {
      const d = delivery({ ...scope, ...changed }, 'x'); await assert.rejects(f.channel.send(d), /session_unavailable/);
    }
    const mismatch = delivery(scope, 'x'); mismatch.context!.binding.principalId = 'other'; await assert.rejects(f.channel.send(mismatch), /session_delivery_mismatch/);
    assert.equal(inspect(f.path, db => db.prepare('SELECT COUNT(*) AS n FROM local_messages').get()?.['n']), 0);
    await f.channel.send(good);
    inspect(f.path, db => db.exec("DELETE FROM session_entries WHERE role='assistant'"));
    assert.equal((await f.channel.lookup(good)).status, 'unknown');
    await f.channel.send(good); assert.equal((await f.channel.lookup(good)).status, 'delivered');
    assert.equal(inspect(f.path, db => db.prepare('SELECT COUNT(*) AS n FROM local_messages').get()?.['n']), 1);
  } finally { f.close(); }
});

test('enabling sessions never adopts legacy local message bodies into a new session', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'session-legacy-'))); const path = join(directory, 'channel.sqlite');
  let channel = new LocalChannel(path);
  try {
    const scope = { ...owner, sessionId: 'legacy' }; const d = delivery(scope, 'old'); delete d.context!.binding.session;
    await channel.send(d); assert.equal(channel.sessions, undefined);
    const sessionDelivery = delivery(scope, 'new'); assert.equal((await channel.send(sessionDelivery)).status, 'unknown');
    channel.close(); channel = new LocalChannel(path, owner.agentId);
    const session = await channel.sessions!.open(owner, { route: 'cli', now: 1 });
    assert.deepEqual((await channel.sessions!.history(session.scope, policy, { limit: 10 })).entries, []);
    assert.equal((await channel.lookup(d)).status, 'delivered');
    assert.equal(inspect(path, db => db.prepare('SELECT COUNT(*) AS n FROM local_messages').get()?.['n']), 1);
  } finally { channel.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('agent-store composition exposes owner-bound sessions separately from each agents long-term memory', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'agent-session-stores-'))); const engine = join(directory, 'engine'); mkdirSync(engine, { mode: 0o700 });
  const profiles = new FileAgentProfileStore(engine); const aProfile = profiles.initialize(join(directory, 'a')); const bProfile = profiles.initialize(join(directory, 'b'));
  const a = await openAgentStores(profiles, aProfile.root, undefined, { identityRegistryDirectory: join(directory, 'registry') }); const b = await openAgentStores(profiles, bProfile.root, undefined, { identityRegistryDirectory: join(directory, 'registry') });
  try {
    const aOwner = { ...owner, agentId: a.profile.identity.agentId }; const bOwner = { ...owner, agentId: b.profile.identity.agentId };
    const aSession = await a.sessions.open(aOwner, { route: 'cli', now: 1 }); const bSession = await b.sessions.open(bOwner, { route: 'cli', now: 1 });
    await a.sessions.receive(intake(aSession.scope, 'same-input')); await b.sessions.receive({ ...intake(bSession.scope, 'same-input'), text: 'B input' });
    assert.equal((await a.sessions.history(aSession.scope, policy, { limit: 10 })).entries[0]?.text, 'original user same-input');
    assert.equal((await b.sessions.history(bSession.scope, policy, { limit: 10 })).entries[0]?.text, 'B input');
    await assert.rejects(a.sessions.get(bSession.scope), /session_unavailable/);
    assert.equal(inspect(a.profile.paths.memory, db => db.prepare("SELECT name FROM sqlite_master WHERE name='session_records'").get()), undefined);
    await a.close(); const reopened = await openAgentStores(profiles, aProfile.root, undefined, { identityRegistryDirectory: join(directory, 'registry') });
    try { assert.deepEqual(await reopened.sessions.open(aOwner, { route: 'cli', now: 100 }), await reopened.sessions.get(aSession.scope)); }
    finally { await reopened.close(); }
  } finally { await a.close(); await b.close(); rmSync(directory, { recursive: true, force: true }); }
});
