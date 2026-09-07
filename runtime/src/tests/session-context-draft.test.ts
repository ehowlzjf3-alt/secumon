import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionService } from '../application/session-service.js';
import { SessionContextSchema } from '../application/session-contracts.js';
import { windowFixture } from './session-window-helpers.js';

test('session inspection publishes no head, artifact or work change; only a validated complete draft can materialize', async t => {
  const f = await windowFixture(t, 4), state = await f.current();
  const before = await f.repository.get(f.session.scope), history = await f.history();
  const counts = { publish: 0, retain: 0, put: 0 };
  const publish = f.repository.publishHead.bind(f.repository), retain = f.repository.retainHead.bind(f.repository), put = f.services.artifacts.put.bind(f.services.artifacts);
  f.repository.publishHead = async (...args) => { counts.publish++; return publish(...args); };
  f.repository.retainHead = async (...args) => { counts.retain++; return retain(...args); };
  f.services.artifacts.put = async (...args) => { counts.put++; return put(...args); };
  const draft = await f.sessions.inspectContext(state); assert.ok(draft); assert.equal(draft.status, 'complete');
  assert.equal(SessionContextSchema.safeParse(draft).success, false, 'a draft never masquerades as a stored context');
  assert.equal(await f.sessions.draftCurrent(state, draft), true);
  assert.deepEqual(counts, { publish: 0, retain: 0, put: 0 });
  assert.deepEqual(await f.repository.get(f.session.scope), before); assert.deepEqual(await f.current(), state); assert.deepEqual(await f.history(), history);
  if (draft.status !== 'complete') throw new Error('expected_complete_draft');
  const materialized = await f.sessions.materializeContext(state, draft);
  assert.deepEqual(materialized.entries, draft.entries); assert.equal(materialized.head.digest, draft.candidate.digest);
  assert.deepEqual(counts, { publish: 1, retain: 0, put: 0 }); assert.equal(await f.sessions.current(state, materialized), true);
  assert.deepEqual(await f.sessions.materializeContext(state, draft), materialized); assert.equal(counts.publish, 1);
});

test('capacity draft validates the whole source manifest and latest raw input without returning partial entries', async t => {
  const f = await windowFixture(t, 8, { maxContextEntries: 3, keepRecentEntries: 1 }), state = await f.current();
  await assert.rejects(f.sessions.context(state), /session_context_capacity/);
  const before = await f.repository.get(f.session.scope), draft = await f.sessions.inspectContext(state); assert.ok(draft);
  assert.equal(draft.status, 'capacity'); assert.equal(draft.totalEntries, 8); assert.equal(draft.sourceManifest.entries, 8);
  assert.equal(draft.sourceManifest.throughSequence, state.conversation!.session!.input.sequence);
  assert.equal(draft.currentInput.sourceId, 'source-7'); assert.equal(draft.currentInput.text, (await f.repository.input(f.session.scope, 'source-7'))!.text);
  assert.equal('entries' in draft, false); assert.equal('candidate' in draft, false); assert.equal('head' in draft, false);
  await assert.rejects(f.sessions.materializeContext(state, draft), /session_context_capacity/);
  assert.deepEqual(await f.repository.get(f.session.scope), before); assert.deepEqual(await f.current(), state);
  const history = f.repository.history.bind(f.repository);
  f.repository.history = async (...args) => { const page = await history(...args); return { ...page,
    entries: page.entries.map(entry => entry.sourceId === 'source-6' ? { ...entry, text: 'corrupted after the capacity threshold' } : entry) }; };
  await assert.rejects(f.sessions.inspectContext(state), /session_original_invalid/);
  assert.equal(await f.sessions.draftCurrent(state, draft), false);
});

test('a current input larger than the session capacity remains whole in the diagnostic and cannot materialize', async t => {
  const f = await windowFixture(t, 1, { maxContextBytes: 1024 }, 6000), state = await f.current();
  const draft = await f.sessions.inspectContext(state); assert.ok(draft); assert.equal(draft.status, 'capacity');
  if (draft.status !== 'capacity') throw new Error('expected_capacity');
  assert.equal(draft.reason, 'bytes'); assert.equal(draft.currentInput.text, (await f.repository.input(f.session.scope, 'source-0'))!.text);
  assert.ok(draft.currentInput.text.length > 1024); assert.equal('entries' in draft, false);
  await assert.rejects(f.sessions.materializeContext(state, draft), /session_context_capacity/);
  assert.equal((await f.repository.get(f.session.scope)).head, null); assert.equal((await f.current()).modelCalls.length, 0);
});

test('new applied input and tampered preparation cannot publish a stale session head', async t => {
  const f = await windowFixture(t, 4), state = await f.current(), draft = await f.sessions.inspectContext(state); assert.ok(draft);
  assert.equal(draft.status, 'complete'); if (draft.status !== 'complete') throw new Error('expected_complete');
  const tampered = structuredClone(draft); tampered.entries[0]!.text = 'invented original';
  assert.equal(await f.sessions.draftCurrent(state, tampered), false);
  await assert.rejects(f.sessions.materializeContext(state, tampered), /session_context_changed/);
  await f.append(); assert.equal(await f.sessions.draftCurrent(state, draft), false);
  await assert.rejects(f.sessions.materializeContext(state, draft), /session_context_changed/);
  assert.equal((await f.repository.get(f.session.scope)).head, null);
  const cancelled = new AbortController(); cancelled.abort();
  assert.equal(await f.sessions.draftCurrent(await f.current(), draft, cancelled.signal), false);
});

test('capacity inspection retains an accepted summary and verifies its original sources before reuse', async t => {
  const f = await windowFixture(t, 5);
  const call = await f.compactPlanning!.requestCompact(f.workId, { force: true }); assert.ok(call);
  await f.compactPlanning!.execute(f.workId, call.id); assert.equal(await f.compactPlanning!.adopt(f.workId, call.id), true);
  await f.append(); await f.append(); await f.append();
  const small = new SessionService(f.services, f.repository, 'window-agent', f.conversation, { maxContextEntries: 2, keepRecentEntries: 1 });
  const state = await f.current(), draft = await small.inspectContext(state); assert.ok(draft); assert.equal(draft.status, 'capacity');
  const summary = await f.repository.publication(f.session.scope, call.id); assert.ok(summary);
  assert.deepEqual(draft.summary, { ref: summary.ref, content: summary.content });
  assert.equal(draft.currentInput.sourceId, 'source-7'); assert.equal(await small.draftCurrent(state, draft), true);
  const history = f.repository.history.bind(f.repository);
  f.repository.history = async (...args) => { const page = await history(...args); return { ...page,
    entries: page.entries.map(entry => entry.sourceId === 'source-0' ? { ...entry, text: 'changed summarized original' } : entry) }; };
  assert.equal(await small.draftCurrent(state, draft), false);
  await assert.rejects(small.inspectContext(state), /session_original_invalid/);
});
