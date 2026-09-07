import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionCompactCandidate, SessionCompactInput } from '../domain/session-compact.js';
import { SessionService } from '../application/session-service.js';
import { transact } from '../application/work-transactions.js';
import { actor, initialize, openCompact, seedCompletedXAndActiveY, compactOnce, preparedSession, request,
  preservation, longText, compactUsage, type CompactFlow } from './session-compact-flow-helpers.js';

async function fixture(t: TestContext, backend: 'sqlite' | 'file-journal' = 'sqlite') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'session-compact-source-')));
  mkdirSync(join(base, 'engine'), { mode: 0o700 }); initialize(base, backend);
  const f = await openCompact(base);
  t.after(async () => { await f.close(); rmSync(base, { recursive: true, force: true }); });
  return { ...f, ...await seedCompletedXAndActiveY(f) };
}

async function rejectedCandidate(f: CompactFlow, workId: string, requestId: string,
  change: (candidate: SessionCompactCandidate, input: SessionCompactInput) => void, reason: string) {
  const original = f.planner.compact.bind(f.planner);
  f.planner.compact = async (...args) => {
    const reply = await original(...args);
    if (reply.status === 'ok') change(reply.candidate, args[0]);
    return reply;
  };
  try {
    const call = await f.compactPlanning!.requestCompact(workId, { requestId, force: true, expectedGoalRevision: 1 }); assert(call);
    const before = await f.runtime.state(workId);
    await f.compactPlanning!.execute(workId, call.id);
    assert.equal(await f.compactPlanning!.adopt(workId, call.id), false);
    const after = await f.runtime.state(workId), settled = after.modelCalls.find(item => item.id === call.id)!;
    assert.equal(settled.status, 'rejected'); assert.equal(settled.reason, reason);
    assert.equal(after.budget.used.tokens - before.budget.used.tokens, compactUsage.inputTokens + compactUsage.outputTokens);
    assert.equal(after.budget.reservedTokens, 0);
    assert.equal(await f.stores.sessions.publication(after.conversation!.session!.scope, call.id), null);
    return { call, after };
  } finally { f.planner.compact = original; }
}

test('compact source rejects a history entry whose text differs from its immutable intake receipt', async t => {
  const f = await fixture(t), state = await f.runtime.state(f.y.workId), fixed = await f.sessions!.context(state);
  const original = f.stores.sessions.history.bind(f.stores.sessions);
  f.stores.sessions.history = async (...args) => {
    const page = await original(...args);
    return { ...page, entries: page.entries.map(entry => entry.sourceId === 'x' ? { ...entry, text: `${entry.text}\nchanged entry` } : entry) };
  };
  try {
    assert.equal(await f.sessions!.current(state, fixed!), false);
    await assert.rejects(f.sessions!.context(state), /session_original_invalid/);
    await assert.rejects(f.compactPlanning!.requestCompact(state.id, { force: true }), /session_original_invalid/);
    assert.equal((await f.runtime.state(state.id)).modelCalls.length, 0); assert.equal(f.planner.inputs.length, 0);
  } finally { f.stores.sessions.history = original; }
  assert.equal((await f.stores.sessions.input(f.session.scope, 'x'))!.text, longText(preservation[0].quote));
  assert.equal(await f.sessions!.current(await f.runtime.state(state.id), fixed!), true);
});

test('matching altered history and receipt text still fail the original intake digest check', async t => {
  const f = await fixture(t), state = await f.runtime.state(f.y.workId);
  const input = f.stores.sessions.input.bind(f.stores.sessions), history = f.stores.sessions.history.bind(f.stores.sessions);
  const original = (await input(f.session.scope, 'x'))!;
  const changed = `${original.text}\nmodified without updating the intake digest`;
  f.stores.sessions.input = async (...args) => { const receipt = await input(...args); return receipt?.messageId === 'x' ? { ...receipt, text: changed } : receipt; };
  f.stores.sessions.history = async (...args) => {
    const page = await history(...args); return { ...page, entries: page.entries.map(entry => entry.sourceId === 'x' ? { ...entry, text: changed } : entry) };
  };
  try {
    const altered = (await f.stores.sessions.input(f.session.scope, 'x'))!;
    assert.equal(altered.digest, original.digest); assert.equal(altered.text, changed);
    await assert.rejects(f.sessions!.context(state), /session_original_invalid/);
    await assert.rejects(f.compactPlanning!.requestCompact(state.id, { force: true }), /session_original_invalid/);
    assert.equal((await f.runtime.state(state.id)).budget.used.modelCalls, 0);
  } finally { f.stores.sessions.input = input; f.stores.sessions.history = history; }
  assert.deepEqual(await f.stores.sessions.input(f.session.scope, 'x'), original);
});

test('the first compact cannot publish an empty retained list for a segment containing user text', async t => {
  const f = await fixture(t), original = await f.stores.sessions.history(f.session.scope, request('y').policy, { limit: 256 });
  await rejectedCandidate(f, f.y.workId, 'empty-anchor', candidate => { candidate.content = { narrative: '정리됨', retained: [] }; }, 'session_compact_source_anchor_missing');
  assert.equal(await f.stores.sessions.summaryHead(f.session.scope), null);
  assert.deepEqual(await f.stores.sessions.history(f.session.scope, request('y').policy, { limit: 256 }), original);
});

test('repeated compact rejects deleting a retained item or changing its status without a new source', async t => {
  for (const violation of ['delete', 'change'] as const) {
    const f = await fixture(t); const first = await compactOnce(f, f.y.workId, `accepted-${violation}`);
    await f.sessions!.input(actor, { sessionId: f.session.scope.sessionId, workId: f.y.workId, messageId: `next-${violation}`,
      rawText: longText(preservation[3].quote), expectedGoalRevision: 1 });
    await rejectedCandidate(f, f.y.workId, `invalid-${violation}`, (candidate, input) => {
      assert.equal(input.previous!.ref.id, first.summary.ref.id);
      if (violation === 'delete') candidate.content.retained = candidate.content.retained.filter(item => item.id !== 'format');
      else { const retained = candidate.content.retained.find(item => item.id === 'format')!; retained.status = 'resolved'; delete retained.changedBy; }
    }, violation === 'delete' ? 'session_compact_protected_item_missing' : 'session_compact_unproven_change');
    assert.equal((await f.stores.sessions.summaryHead(f.session.scope))!.ref.id, first.summary.ref.id);
  }
});

test('a valid source anchor does not permit an additional fabricated quotation', async t => {
  const f = await fixture(t);
  await rejectedCandidate(f, f.y.workId, 'fabricated-quote', (candidate, input) => {
    const source = input.entries.find(entry => entry.role === 'user')!;
    candidate.content.retained.push({ id: 'fabricated', kind: 'counterargument', text: 'Unsupported quotation', status: 'active', citations: [
      { sequence: source.sequence, sourceId: source.sourceId, role: source.role, quote: 'This sentence never occurred in the original.' },
    ] });
  }, 'session_compact_quote_unavailable');
  assert.equal(await f.stores.sessions.summaryHead(f.session.scope), null);
});

test('fixed raw v1 and fixed summary v2 contexts remain current when only the summary head advances', async t => {
  const f = await fixture(t);
  // One-entry segments create two publications for the same applied input without manufacturing new conversation text.
  const narrow = new SessionService(f.services, f.stores.sessions, f.stores.profile.identity.agentId, f.conversation,
    { maxContextBytes: 20000, maxContextEntries: 24, keepRecentEntries: 4, maxCompactInputBytes: 28000, maxCompactEntries: 1, maxSummaryBytes: 4096 });
  f.services.sessions = narrow; f.services.sessionCompacts = narrow;
  const state = await f.runtime.state(f.y.workId), raw = await narrow.context(state); assert.equal(raw!.schemaVersion, 1);
  const first = await compactOnce(f, f.y.workId, 'first-small-prefix');
  const fixed = await narrow.context(await f.runtime.state(f.y.workId)); assert.equal(fixed!.schemaVersion, 2);
  if (!fixed || fixed.schemaVersion !== 2) throw new Error('missing_summary');
  const second = await compactOnce(f, f.y.workId, 'second-small-prefix');
  assert.notEqual(second.summary.ref.id, first.summary.ref.id); assert(second.summary.ref.throughSequence > first.summary.ref.throughSequence);
  const latest = await f.runtime.state(f.y.workId);
  assert.deepEqual(latest.conversation!.session, state.conversation!.session);
  assert.equal(await narrow.current(latest, raw!), true); assert.equal(await narrow.current(latest, fixed!), true);
  const next = await narrow.context(latest); assert.equal(next!.schemaVersion, 2);
  if (!next || next.schemaVersion !== 2) throw new Error('missing_summary');
  assert.equal(next.summary.ref.id, second.summary.ref.id);
  const { summary: _summary, ...withoutSummary } = fixed;
  const missingSummary = { ...withoutSummary, schemaVersion: 1 as const };
  assert.equal(await narrow.current(latest, missingSummary), false, 'omitting summary text does not turn its head into a valid raw packet');
});

test('source policy withdrawal or actual original artifact loss invalidates an accepted derived summary', async t => {
  for (const boundary of ['policy', 'artifact'] as const) {
    const f = await fixture(t, boundary === 'policy' ? 'sqlite' : 'file-journal');
    const compact = await compactOnce(f, f.y.workId, `before-${boundary}`);
    const { prepared } = await preparedSession(f, f.y.workId, `pinned-${boundary}`);
    const fixed = prepared.packet.session!; assert.equal(fixed.schemaVersion, 2);
    if (boundary === 'policy') {
      await transact(f.services, f.x.workId, 'source-model-access-revoked', 'policy_changed', {}, next => { next.policy.allowedDestinations = []; });
    } else {
      const history = await f.stores.sessions.history(f.session.scope, request('y').policy, { limit: 256 });
      const source = history.entries.find(entry => entry.workId === f.x.workId && entry.kind === 'result')!.artifact; assert(source);
      unlinkSync(join(f.stores.profile.paths.artifacts, `${source.id}.blob`));
      assert.equal(await f.stores.artifacts.exists(source), false);
    }
    const latest = await f.runtime.state(f.y.workId);
    assert.equal(await f.stores.artifacts.exists(prepared.head.artifact), true, 'a readable derived frame is insufficient without original authority');
    assert.equal((await f.stores.sessions.summary(f.session.scope, compact.summary.ref.id))!.ref.id, compact.summary.ref.id);
    assert.equal(await f.sessions!.current(latest, fixed), false);
    assert.equal(await f.context.sourcesCurrent(prepared.packet, latest), false);
    if (boundary === 'artifact') await assert.rejects(f.sessions!.context(latest), /session_source_unavailable/);
    else {
      const allowed = await f.sessions!.context(latest); assert.equal(allowed!.schemaVersion, 1);
      assert(!allowed!.entries.some(entry => entry.workId === f.x.workId));
    }
    assert.equal(f.planner.inputs.length, 1); assert.equal(latest.budget.used.modelCalls, 1);
  }
});
