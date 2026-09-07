import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Json, Policy } from '../domain/model.js';
import type { SessionScope } from '../domain/session.js';
import type { SessionSummaryPublication, SessionSummaryRef } from '../domain/session-compact.js';
import { LocalChannel } from '../infrastructure/local-channel.js';
import { bindAgentDatabase } from '../infrastructure/agent-database-owner.js';
import { Sha256Digester, sha256 } from '../infrastructure/digest.js';

const owner = { tenantId: 'tenant', agentId: 'agent', principalId: 'person' };
const policy: Policy = { tenantId: owner.tenantId, principalId: owner.principalId, allowedTools: [], allowedLabels: ['public'], allowedDestinations: ['local'], allowWrites: false };
const digester = new Sha256Digester();
function fixture(owned = true) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'sqlite-session-compacts-'))); const path = join(directory, 'channel.sqlite');
  if (owned) bindAgentDatabase(path, owner.agentId, 'channel');
  let channel = new LocalChannel(path, owner.agentId);
  return { path, get channel() { return channel; }, get sessions() { return channel.sessions!; },
    reopen() { channel.close(); channel = new LocalChannel(path, owner.agentId); },
    close() { channel.close(); rmSync(directory, { recursive: true, force: true }); } };
}
async function receive(f: ReturnType<typeof fixture>, scope: SessionScope, n: number, labels = ['public']) {
  return f.sessions.receive({ scope, messageId: `m${n}`, workId: `w${n}`, text: `original message ${n}`, labels, kind: 'work',
    payload: { n }, digest: digester.digest({ n }), receivedAt: n });
}
function inspect<T>(path: string, action: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path); try { return action(db); } finally { db.close(); }
}
function publication(scope: SessionScope, n: number, throughSequence: number, previous: SessionSummaryRef | null = null, policyDigest = 'a'.repeat(64)): SessionSummaryPublication {
  const content = { narrative: `Derived summary ${n}`, retained: [] }; const inputDigest = digester.digest({ input: n });
  const prefix = { throughSequence, digest: digester.digest({ throughSequence }), entries: throughSequence };
  return { scope, ref: { id: `summary-${n}`, throughSequence, policyDigest, digest: digester.digest({ content, prefix, inputDigest, previous } as unknown as Json) },
    content, workId: `w${throughSequence}`, callId: `call-${n}`, inputDigest, prefix, previous, createdAt: n };
}
function compactTables(path: string) {
  return inspect(path, db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name='session_compact_schema' OR name LIKE 'session_summar%') ORDER BY name").all().map(row => row['name']));
}

test('history queries a strict open-start closed-end interval and carries its bounds across pages', async () => {
  const f = fixture();
  try {
    const { scope } = await f.sessions.open(owner, { route: 'cli', now: 1 });
    for (let n = 1; n <= 6; n++) await receive(f, scope, n, n === 3 ? ['secret'] : ['public']);
    const first = await f.sessions.history(scope, policy, { limit: 1, afterSequence: 1, throughSequence: 5 });
    assert.deepEqual(first.entries.map(entry => entry.sequence), [2]); assert.ok(first.nextCursor); assert.ok(first.nextCursor.startsWith('session-v2:'));
    await receive(f, scope, 7);
    const next = await f.sessions.history(scope, policy, { limit: 1, cursor: first.nextCursor });
    assert.deepEqual(next.entries.map(entry => entry.sequence), [4]); assert.ok(next.nextCursor);
    const last = await f.sessions.history(scope, policy, { limit: 5, cursor: next.nextCursor, afterSequence: 1, throughSequence: 5 });
    assert.deepEqual(last.entries.map(entry => entry.sequence), [5]); assert.equal(last.nextCursor, null);
    assert.deepEqual((await f.sessions.history(scope, policy, { limit: 5, afterSequence: 5, throughSequence: 5 })).entries, []);
    assert.deepEqual((await f.sessions.history(scope, policy, { limit: 5, afterSequence: 5 })).entries.map(entry => entry.sequence), [6, 7]);
    for (const options of [{ afterSequence: 2 }, { throughSequence: 6 }]) {
      await assert.rejects(f.sessions.history(scope, policy, { limit: 1, cursor: first.nextCursor, ...options }), /invalid_session_cursor/);
    }
    await assert.rejects(f.sessions.history(scope, { ...policy, allowedLabels: ['public', 'secret'] }, { limit: 1, cursor: first.nextCursor }), /invalid_session_cursor/);
    await assert.rejects(f.sessions.history(scope, policy, { limit: 1, afterSequence: 6, throughSequence: 5 }), /invalid_session_query/);
    await assert.rejects(f.sessions.history(scope, policy, { limit: 1, afterSequence: 8 }), /invalid_session_query/);
    const another = await f.sessions.open(owner, { route: 'other', now: 1 });
    await assert.rejects(f.sessions.history(another.scope, policy, { limit: 1, cursor: first.nextCursor }), /invalid_session_cursor/);
    assert.equal(inspect(f.path, db => db.prepare('SELECT version FROM session_schema').get()?.['version']), 1);
  } finally { f.close(); }
});

test('legacy history cursors keep lower bound zero and malformed interval cursors fail closed', async () => {
  const f = fixture();
  try {
    const { scope } = await f.sessions.open(owner, { route: 'cli', now: 1 }); for (let n = 1; n <= 4; n++) await receive(f, scope, n);
    const identity = `${sha256(JSON.stringify([scope.tenantId, scope.agentId, scope.principalId, scope.sessionId]))}:${digester.digest(policy as unknown as Json)}:`;
    const cursor = (version: number, value: unknown) => `session-v${version}:${identity}${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
    const legacy = cursor(1, { after: 1, through: 3 });
    const page = await f.sessions.history(scope, policy, { limit: 1, cursor: legacy });
    assert.deepEqual(page.entries.map(entry => entry.sequence), [2]); assert.ok(page.nextCursor?.startsWith('session-v2:'));
    await assert.rejects(f.sessions.history(scope, policy, { limit: 1, cursor: legacy, afterSequence: 1 }), /invalid_session_cursor/);
    for (const value of [{ lower: 2, after: 2, through: 3 }, { lower: 3, after: 2, through: 4 }, { lower: 0, after: 4, through: 3 },
      { lower: -1, after: 1, through: 3 }, { lower: 0, after: 1.5, through: 3 }, { lower: 0, after: 1, through: 3, extra: true }]) {
      await assert.rejects(f.sessions.history(scope, policy, { limit: 1, cursor: cursor(2, value) }), /invalid_session_cursor/);
    }
    await assert.rejects(f.sessions.history(scope, policy, { limit: 1, cursor: legacy + '=' }), /invalid_session_cursor/);
    assert.equal((await f.sessions.history(scope, policy, { limit: 10 })).entries.length, 4, 'raw source entries were not removed');
  } finally { f.close(); }
});

test('compact storage is an owner-checked additive extension; three revisions and receipts survive reopen without changing raw state', async () => {
  const f = fixture();
  try {
    const { scope } = await f.sessions.open(owner, { route: 'cli', now: 1 }); for (let n = 1; n <= 7; n++) await receive(f, scope, n);
    await f.sessions.settle(scope, 'm7', digester.digest({ n: 7 }), { status: 'applied' });
    await f.sessions.publishHead(scope, 0, { throughSequence: 7, digest: 'e'.repeat(64), policyDigest: 'a'.repeat(64) });
    const before = await f.sessions.get(scope); const raw = await f.sessions.history(scope, policy, { limit: 256 });
    assert.equal(await f.sessions.summaryHead(scope), null); assert.equal(await f.sessions.summary(scope, 'missing'), null);
    assert.equal(await f.sessions.summaryBefore(scope, 7, 'a'.repeat(64)), null); assert.equal(await f.sessions.publication(scope, 'missing'), null);
    assert.deepEqual(compactTables(f.path), [], 'read-only availability checks do not migrate');
    const firstInput = publication(scope, 1, 2); const first = await f.sessions.publishSummary(scope, 0, firstInput); assert.ok(first); assert.equal(first.ref.revision, 1);
    const secondInput = publication(scope, 2, 4, first.ref); const second = await f.sessions.publishSummary(scope, first.ref.revision, secondInput); assert.ok(second);
    const thirdInput = publication(scope, 3, 6, second.ref); const third = await f.sessions.publishSummary(scope, second.ref.revision, thirdInput); assert.ok(third);
    assert.equal(third.ref.revision, 3); assert.deepEqual(await f.sessions.summaryHead(scope), third);
    assert.deepEqual(await f.sessions.get(scope), before, 'summary head never modifies raw head, sequence, active input or work');
    assert.deepEqual(await f.sessions.history(scope, policy, { limit: 256 }), raw);
    assert.deepEqual(await f.sessions.publishSummary(scope, 0, { ...firstInput, createdAt: 100 }), first, 'lost receipt resumes its original successful publication');
    assert.deepEqual(await f.sessions.summaryHead(scope), third, 'idempotent old publication cannot move active summary backwards');
    f.reopen();
    for (const [record, candidate, expected] of [[first, firstInput, 0], [second, secondInput, 1], [third, thirdInput, 2]] as const) {
      assert.deepEqual(await f.sessions.summary(scope, record.ref.id), record);
      assert.deepEqual(await f.sessions.publication(scope, record.callId), record);
      assert.deepEqual(await f.sessions.publishSummary(scope, expected, candidate), record);
    }
    assert.equal(inspect(f.path, db => db.prepare('SELECT version FROM session_schema').get()?.['version']), 1);
    assert.equal(inspect(f.path, db => db.prepare('SELECT version FROM session_compact_schema').get()?.['version']), 1);
    assert.equal(inspect(f.path, db => db.prepare('SELECT COUNT(*) AS n FROM session_summaries').get()?.['n']), 3);
    assert.equal(inspect(f.path, db => db.prepare('SELECT COUNT(*) AS n FROM session_summary_publications').get()?.['n']), 3);
    assert.deepEqual(await f.sessions.get(scope), before); assert.deepEqual(await f.sessions.history(scope, policy, { limit: 256 }), raw);
  } finally { f.close(); }
});

test('summary CAS permits same-cutoff recovery and immutable earlier prefixes without regressing the active head', async () => {
  const f = fixture();
  try {
    const { scope } = await f.sessions.open(owner, { route: 'cli', now: 1 }); for (let n = 1; n <= 8; n++) await receive(f, scope, n);
    const one = publication(scope, 1, 2); const first = await f.sessions.publishSummary(scope, 0, one); assert.ok(first);
    assert.equal(await f.sessions.publishSummary(scope, 0, publication(scope, 2, 4)), null);
    assert.equal(await f.sessions.publication(scope, 'call-2'), null);
    await assert.rejects(f.sessions.publishSummary(scope, 1, one), /session_summary_publication_conflict/);
    await assert.rejects(f.sessions.publishSummary(scope, 0, { ...one, content: { ...one.content, narrative: 'changed' } }), /session_summary_publication_conflict/);
    await assert.rejects(f.sessions.publishSummary(scope, 1, { ...publication(scope, 2, 4), ref: { ...publication(scope, 2, 4).ref, id: first.ref.id } }), /session_summary_identity_conflict/);
    const second = await f.sessions.publishSummary(scope, 1, publication(scope, 2, 2)); assert.ok(second, 'same prefix can be rebuilt under a fresh call');
    assert.equal(second.ref.revision, 2); assert.deepEqual(await f.sessions.summaryHead(scope), second);
    const pastInput = publication(scope, 3, 1); const past = await f.sessions.publishSummary(scope, 2, pastInput); assert.ok(past);
    assert.equal(past.ref.revision, 3); assert.deepEqual(await f.sessions.summaryHead(scope), second, 'shorter retained prefix cannot regress the head');
    assert.deepEqual(await f.sessions.publication(scope, 'call-3'), past);
    assert.deepEqual(await f.sessions.publishSummary(scope, 2, pastInput), past);
    assert.equal(await f.sessions.publishSummary(scope, 3, publication(scope, 4, 4)), null, 'CAS uses active physical head, not largest retained revision');
    const fourth = await f.sessions.publishSummary(scope, 2, publication(scope, 4, 4, null, 'b'.repeat(64))); assert.ok(fourth, 'policy change may rebuild without the active summary content');
    assert.equal(fourth.ref.revision, 4);
    const fifth = await f.sessions.publishSummary(scope, 4, publication(scope, 5, 6, first.ref)); assert.ok(fifth, 'reuse of an older existing summary is allowed');
    assert.equal(fifth.ref.revision, 5); assert.equal(await f.sessions.summaryBefore(scope, 1, 'a'.repeat(64)), null);
    assert.deepEqual(await f.sessions.summaryBefore(scope, 2, 'a'.repeat(64)), past);
    assert.deepEqual(await f.sessions.summaryBefore(scope, 6, 'a'.repeat(64)), second, 'equal cutoff selects the latest revision while current input stays raw');
    assert.deepEqual(await f.sessions.summaryBefore(scope, 7, 'a'.repeat(64)), fifth);
    assert.deepEqual(await f.sessions.summaryBefore(scope, 8, 'b'.repeat(64)), fourth);
    assert.equal(await f.sessions.summaryBefore(scope, 8, 'c'.repeat(64)), null);
    assert.deepEqual(await f.sessions.summaryHead(scope), fifth);
    assert.deepEqual(await f.sessions.summary(scope, first.ref.id), first, 'same-cutoff replacement preserves the old immutable record');
  } finally { f.close(); }
});

test('summary history can find an older same-cutoff revision before falling back to an earlier prefix', async () => {
  const f = fixture();
  try {
    const { scope } = await f.sessions.open(owner, { route: 'cli', now: 1 }); for (let n = 1; n <= 5; n++) await receive(f, scope, n);
    const first = await f.sessions.publishSummary(scope, 0, publication(scope, 1, 2)); assert.ok(first);
    const second = await f.sessions.publishSummary(scope, 1, publication(scope, 2, 2)); assert.ok(second);
    const earlier = await f.sessions.publishSummary(scope, 2, publication(scope, 3, 1)); assert.ok(earlier);
    const bound = (record: { ref: SessionSummaryRef }) => ({ throughSequence: record.ref.throughSequence, revision: record.ref.revision });
    assert.deepEqual(await f.sessions.summaryBefore(scope, 5, 'a'.repeat(64)), second);
    assert.deepEqual(await f.sessions.summaryBefore(scope, 5, 'a'.repeat(64), bound(second)), first);
    assert.deepEqual(await f.sessions.summaryBefore(scope, 5, 'a'.repeat(64), bound(first)), earlier, 'earlier cutoff wins regardless of its larger revision');
    assert.equal(await f.sessions.summaryBefore(scope, 5, 'a'.repeat(64), bound(earlier)), null);
    assert.equal(await f.sessions.summaryBefore(scope, 5, 'b'.repeat(64), bound(second)), null);
    for (const before of [{ throughSequence: 0, revision: 1 }, { throughSequence: 5, revision: 1 }, { throughSequence: 6, revision: 1 },
      { throughSequence: 1.5, revision: 1 }, { throughSequence: 2, revision: 0 }, { throughSequence: 2, revision: 1.5 },
      { throughSequence: 2, revision: Number.MAX_SAFE_INTEGER + 1 }]) {
      await assert.rejects(f.sessions.summaryBefore(scope, 5, 'a'.repeat(64), before));
    }
    assert.deepEqual(await f.sessions.summaryHead(scope), second, 'candidate traversal never changes the active head');
  } finally { f.close(); }
});

test('policy reconstruction can retain several bounded prefixes below a newer physical head, then replace the same cutoff', async () => {
  const f = fixture();
  try {
    const { scope } = await f.sessions.open(owner, { route: 'cli', now: 1 }); for (let n = 1; n <= 7; n++) await receive(f, scope, n);
    const original = await f.sessions.publishSummary(scope, 0, publication(scope, 1, 6)); assert.ok(original);
    const before = await f.sessions.get(scope); const changedPolicy = 'b'.repeat(64);
    const first = await f.sessions.publishSummary(scope, original.ref.revision, publication(scope, 2, 2, null, changedPolicy)); assert.ok(first);
    assert.deepEqual(await f.sessions.summaryHead(scope), original);
    const second = await f.sessions.publishSummary(scope, original.ref.revision, publication(scope, 3, 4, first.ref, changedPolicy)); assert.ok(second);
    assert.deepEqual(await f.sessions.summaryHead(scope), original);
    assert.deepEqual(await f.sessions.summaryBefore(scope, 7, changedPolicy), second);
    const rebuilt = await f.sessions.publishSummary(scope, original.ref.revision, publication(scope, 4, 6, second.ref, changedPolicy)); assert.ok(rebuilt);
    assert.equal(rebuilt.ref.revision, 4); assert.deepEqual(await f.sessions.summaryHead(scope), rebuilt);
    f.reopen(); assert.deepEqual(await f.sessions.summaryHead(scope), rebuilt); assert.deepEqual(await f.sessions.summary(scope, original.ref.id), original);
    assert.deepEqual(await f.sessions.get(scope), before); assert.equal((await f.sessions.history(scope, policy, { limit: 10 })).entries.length, 7);
  } finally { f.close(); }
});

test('summary previous refs and scopes cannot substitute another agent, user or session', async () => {
  const f = fixture();
  try {
    const { scope } = await f.sessions.open(owner, { route: 'cli', now: 1 }); for (let n = 1; n <= 5; n++) await receive(f, scope, n);
    const other = await f.sessions.open({ ...owner, principalId: 'other-person' }, { route: 'cli', now: 1 });
    for (let n = 1; n <= 4; n++) await receive(f, other.scope, n);
    const foreign = await f.sessions.publishSummary(other.scope, 0, publication(other.scope, 9, 2)); assert.ok(foreign);
    assert.equal(await f.sessions.summary(scope, foreign.ref.id), null); assert.equal(await f.sessions.publication(scope, foreign.callId), null);
    await assert.rejects(f.sessions.publishSummary(scope, 0, publication(scope, 1, 4, foreign.ref)), /session_summary_previous_unavailable/);
    const one = await f.sessions.publishSummary(scope, 0, publication(scope, 1, 2)); assert.ok(one);
    await assert.rejects(f.sessions.publishSummary(scope, 1, publication(scope, 2, 4, { ...one.ref, digest: 'e'.repeat(64) })), /session_summary_previous_unavailable/);
    await assert.rejects(f.sessions.publishSummary(scope, 1, publication(scope, 2, 4, { ...one.ref, throughSequence: 4 })), /invalid_session_summary/);
    await assert.rejects(f.sessions.publishSummary(scope, 1, publication(other.scope, 2, 4)), /session_summary_scope_mismatch/);
    for (const changed of [{ agentId: 'other-agent' }, { principalId: 'missing-person' }, { tenantId: 'missing-tenant' }, { sessionId: 'missing-session' }]) {
      const wrong = { ...scope, ...changed };
      await assert.rejects(f.sessions.summaryHead(wrong), /session_unavailable/);
      await assert.rejects(f.sessions.summary(wrong, one.ref.id), /session_unavailable/);
      await assert.rejects(f.sessions.publication(wrong, one.callId), /session_unavailable/);
      await assert.rejects(f.sessions.publishSummary(wrong, 0, publication(wrong, 3, 4)), /session_unavailable/);
    }
    await assert.rejects(f.sessions.publishSummary(scope, 1, publication(scope, 2, 6)), /invalid_session_summary/);
    const invalid = publication(scope, 2, 4); invalid.prefix.throughSequence = 3;
    await assert.rejects(f.sessions.publishSummary(scope, 1, invalid), /invalid_session_summary/);
    await assert.rejects(f.sessions.publishSummary(scope, 1, { ...publication(scope, 2, 4), content: { narrative: 'x'.repeat(32001), retained: [] } }));
    assert.deepEqual(await f.sessions.summaryHead(scope), one);
  } finally { f.close(); }
});

test('compact publish refuses missing or foreign channel owners before adding extension tables', async () => {
  for (const mode of ['missing', 'foreign-agent', 'wrong-kind'] as const) {
    const f = fixture(mode !== 'missing');
    try {
      const { scope } = await f.sessions.open(owner, { route: 'cli', now: 1 }); await receive(f, scope, 1);
      if (mode === 'foreign-agent') inspect(f.path, db => db.exec("UPDATE agent_storage_owner SET agent_id='other-agent'"));
      if (mode === 'wrong-kind') inspect(f.path, db => db.exec("UPDATE agent_storage_owner SET kind='memory'"));
      const state = await f.sessions.get(scope);
      assert.equal(await f.sessions.summaryHead(scope), null);
      await assert.rejects(f.sessions.publishSummary(scope, 0, publication(scope, 1, 1)), mode === 'missing' ? /agent_storage_owner_missing/ : /agent_storage_owner_mismatch/);
      assert.deepEqual(compactTables(f.path), []); assert.deepEqual(await f.sessions.get(scope), state);
      assert.equal((await f.sessions.history(scope, policy, { limit: 10 })).entries[0]?.text, 'original message 1');
    } finally { f.close(); }
  }
});

test('summary publication rollback preserves head and receipt; failed first publication rolls back its schema migration', async () => {
  const f = fixture();
  try {
    const { scope } = await f.sessions.open(owner, { route: 'cli', now: 1 }); for (let n = 1; n <= 5; n++) await receive(f, scope, n);
    const missing: SessionSummaryRef = { id: 'missing', revision: 1, throughSequence: 1, digest: 'a'.repeat(64), policyDigest: 'a'.repeat(64) };
    await assert.rejects(f.sessions.publishSummary(scope, 0, publication(scope, 1, 2, missing)), /session_summary_previous_unavailable/);
    assert.deepEqual(compactTables(f.path), []);
    const first = await f.sessions.publishSummary(scope, 0, publication(scope, 1, 2)); assert.ok(first);
    inspect(f.path, db => db.exec("CREATE TRIGGER fail_summary_receipt BEFORE INSERT ON session_summary_publications BEGIN SELECT RAISE(ABORT,'injected_summary_receipt_failure'); END;"));
    const next = publication(scope, 2, 4, first.ref);
    await assert.rejects(f.sessions.publishSummary(scope, 1, next), /injected_summary_receipt_failure/);
    assert.deepEqual(await f.sessions.summaryHead(scope), first); assert.equal(await f.sessions.summary(scope, next.ref.id), null); assert.equal(await f.sessions.publication(scope, next.callId), null);
    inspect(f.path, db => db.exec('DROP TRIGGER fail_summary_receipt'));
    const second = await f.sessions.publishSummary(scope, 1, next); assert.equal(second?.ref.revision, 2);
    inspect(f.path, db => db.exec('UPDATE session_compact_schema SET version=99'));
    await assert.rejects(f.sessions.summaryHead(scope), /unsupported_session_compact_schema/);
    await assert.rejects(f.sessions.publishSummary(scope, 2, publication(scope, 3, 5)), /unsupported_session_compact_schema/);
    assert.equal(inspect(f.path, db => db.prepare('SELECT COUNT(*) AS n FROM session_summaries').get()?.['n']), 2);
  } finally { f.close(); }
});

test('two channel connections compete by summary CAS and recheck a changed owner before reading published summaries', async () => {
  const f = fixture(); let peer: LocalChannel | undefined;
  try {
    const { scope } = await f.sessions.open(owner, { route: 'cli', now: 1 }); for (let n = 1; n <= 4; n++) await receive(f, scope, n);
    peer = new LocalChannel(f.path, owner.agentId);
    const results = await Promise.all([f.sessions.publishSummary(scope, 0, publication(scope, 1, 2)), peer.sessions!.publishSummary(scope, 0, publication(scope, 2, 3))]);
    assert.equal(results.filter(Boolean).length, 1); const winner = results.find(Boolean)!;
    assert.deepEqual(await peer.sessions!.summaryHead(scope), winner);
    assert.equal(inspect(f.path, db => db.prepare('SELECT COUNT(*) AS n FROM session_summaries').get()?.['n']), 1);
    inspect(f.path, db => db.exec("UPDATE agent_storage_owner SET agent_id='changed-owner'"));
    await assert.rejects(f.sessions.summaryHead(scope), /agent_storage_owner_mismatch/);
    await assert.rejects(peer.sessions!.publication(scope, winner.callId), /agent_storage_owner_mismatch/);
  } finally { peer?.close(); f.close(); }
});
