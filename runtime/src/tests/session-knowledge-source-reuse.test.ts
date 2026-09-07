import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WorkState } from '../domain/model.js';
import type { SessionInbox, SessionPage } from '../domain/session.js';
import type { TrustedKnowledgeActor } from '../domain/knowledge.js';
import type { SessionRepository } from '../application/session-ports.js';
import type { StateRepository } from '../application/ports.js';
import { SessionKnowledgeSources } from '../application/session-knowledge-sources.js';
import { ScriptedPlanner } from '../infrastructure/fakes.js';
import { actor, initialize, open, request, scenario } from './session-flow-helpers.js';

const quote = '답변은 한국어로 작성하고 원문과 근거를 구분해 주세요.';
type Hooks = {
  input?: (value: SessionInbox | null, afterHistory: boolean, messageId: string) => SessionInbox | null;
  work?: (value: WorkState | null, afterHistory: boolean) => WorkState | null;
  history?: (value: SessionPage, options: Parameters<SessionRepository['history']>[2]) => SessionPage;
  repeatFirstHistoryPage?: boolean;
};

async function fixture(t: TestContext, backend: 'sqlite' | 'file-journal' = 'sqlite') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'session-source-reuse-')));
  mkdirSync(join(base, 'engine'), { mode: 0o700 }); initialize(base, backend);
  const f = await open(base);
  t.after(async () => { try { await f.close(); } finally { rmSync(base, { recursive: true, force: true }); } });
  const session = await f.sessions!.open(actor, { channel: 'test', conversationId: 'source-reuse' });
  const accepted = await f.sessions!.accept(actor, { sessionId: session.scope.sessionId, rawText: quote, request: request('first') });
  const access: TrustedKnowledgeActor = { ...actor, agentId: f.stores.profile.identity.agentId,
    allowedLabels: [...scenario.policy.allowedLabels], allowedDestinations: [...scenario.policy.allowedDestinations],
    allowedScopes: [scenario.goal.scope], allowedNamespaces: ['local', 'personal'], canReview: true, canPublish: true };
  const ref = { sessionId: session.scope.sessionId, messageId: 'first', quote };
  const input = f.stores.sessions.input.bind(f.stores.sessions), history = f.stores.sessions.history.bind(f.stores.sessions);
  const get = f.stores.state.get.bind(f.stores.state);
  let hooks: Hooks = {}, afterHistory = false;
  const trace: string[] = [];
  // Read actual stored originals, then inject a changed response at the history await boundary.
  // This simulates competing port observations; it does not modify receipt rows or claim cross-store atomicity.
  const repository = new Proxy(f.stores.sessions, { get(target, property) {
    if (property === 'input') return async (...args: Parameters<SessionRepository['input']>) => {
      trace.push(`input:${afterHistory ? 'after' : 'before'}`);
      const value = await input(...args); return hooks.input ? hooks.input(value, afterHistory, args[1]) : value;
    };
    if (property === 'history') return async (...args: Parameters<SessionRepository['history']>) => {
      trace.push('history');
      // An adversarial page source can replay the first real row under a new cursor.
      const { cursor: _cursor, ...range } = args[2];
      const page = await history(args[0], args[1], hooks.repeatFirstHistoryPage ? range : args[2]); afterHistory = true;
      return hooks.history ? hooks.history(page, args[2]) : page;
    };
    const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const states = new Proxy(f.stores.state, { get(target, property) {
    if (property === 'get') return async (...args: Parameters<StateRepository['get']>) => {
      trace.push(`work:${afterHistory ? 'after' : 'before'}`);
      const value = await get(...args); return hooks.work ? hooks.work(value, afterHistory) : value;
    };
    const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const sources = new SessionKnowledgeSources({ ...f.services, state: states }, repository, access.agentId!);
  const originalWork = await get(accepted.workId), originalReceipt = await input(session.scope, 'first');
  assert.ok(originalWork && originalReceipt);
  const originalHistory = await history(session.scope, originalWork.policy, { limit: 64 });
  async function unchanged() {
    assert.deepEqual(await get(accepted.workId), originalWork);
    assert.deepEqual(await input(session.scope, 'first'), originalReceipt);
    assert.deepEqual(await history(session.scope, originalWork!.policy, { limit: 64 }), originalHistory);
    assert.deepEqual(f.tool.invocations, []);
    assert.ok(f.services.planner instanceof ScriptedPlanner); assert.deepEqual(f.services.planner.inputs, []);
  }
  return { f, session, accepted, access, ref, sources, trace, input, originalReceipt, unchanged,
    reset(next: Hooks = {}) { hooks = next; afterHistory = false; trace.length = 0; } };
}

for (const backend of ['sqlite', 'file-journal'] as const) {
  test(`source snapshot reuse ${backend}: each independent current call rereads history and both sides of its authority boundary`, async t => {
    const h = await fixture(t, backend), source = await h.sources.capture(h.access, h.ref);
    let first: Awaited<ReturnType<SessionKnowledgeSources['current']>> | undefined;
    for (let index = 0; index < 3; index++) {
      h.reset(); const stamp = await h.sources.current(source, h.access);
      first ??= stamp; assert.deepEqual(stamp, first);
      const at = h.trace.indexOf('history'); assert.ok(at > 0);
      assert.ok(h.trace.slice(0, at).includes('input:before')); assert.ok(h.trace.slice(0, at).includes('work:before'));
      assert.ok(h.trace.slice(at + 1).includes('input:after')); assert.ok(h.trace.slice(at + 1).includes('work:after'));
    }
    h.reset({ history: page => ({ ...page, entries: [] }) });
    await assert.rejects(h.sources.current(source, h.access), /knowledge_unavailable/);
    assert.ok(h.trace.includes('history'), 'an earlier successful current cannot conceal later original loss');
    h.reset(); assert.deepEqual(await h.sources.current(source, h.access), first);
    assert.equal(source.coverage, 'unknown'); assert.equal(source.type, 'session_user_receipt');
    await h.unchanged();
  });

  test(`source snapshot reuse ${backend}: source policy, generation, basis changes or disappearance during history cannot pass final validation`, async t => {
    const h = await fixture(t, backend), source = await h.sources.capture(h.access, h.ref);
    for (const fault of ['labels', 'destination', 'disclosure', 'scope', 'tenant', 'principal', 'generation', 'basis', 'session-scope', 'missing'] as const) {
      h.reset({ work: (value, changed) => {
        if (!changed || !value) return value;
        if (fault === 'missing') return null;
        const next = structuredClone(value);
        if (fault === 'labels') next.policy.allowedLabels = [];
        if (fault === 'destination') next.policy.allowedDestinations = [];
        if (fault === 'disclosure') next.policy.disclosure = { revision: 'withdrawn', destinations: [], maxReleasesPerWork: 0, maxReleasedBytesPerWork: 0 };
        if (fault === 'scope') next.goal.scope = 'other-scope';
        if (fault === 'tenant') next.policy.tenantId = 'other-tenant';
        if (fault === 'principal') next.policy.principalId = 'other-person';
        if (fault === 'generation') next.dataLifecycle = { generation: 1, blockedArtifactIds: [], changes: [] };
        if (fault === 'basis') next.conversation!.session!.input.digest = '0'.repeat(64);
        if (fault === 'session-scope') next.conversation!.session!.scope.sessionId = 'other-session';
        return next;
      } });
      await assert.rejects(h.sources.current(source, h.access), /knowledge_contention/, fault);
      assert.ok(h.trace.includes('work:after'), fault); assert.ok(h.trace.includes('input:after'), fault);
    }
    await h.unchanged();
  });
}

test('source snapshot reuse: the entire receipt is rechecked after history, including fields outside the text digest', async t => {
  const h = await fixture(t), source = await h.sources.capture(h.access, h.ref);
  for (const fault of ['text', 'labels', 'payload', 'kind', 'work', 'status', 'digest', 'sequence', 'receivedAt', 'missing'] as const) {
    h.reset({ input: (value, changed) => {
      if (!changed || !value) return value;
      if (fault === 'missing') return null;
      const next = structuredClone(value);
      if (fault === 'text') next.text += ' 이후 변경';
      if (fault === 'labels') next.labels = [];
      if (fault === 'payload') next.payload = { altered: true };
      if (fault === 'kind') next.kind = 'command';
      if (fault === 'work') next.workId = 'other-work';
      if (fault === 'status') next.status = 'pending';
      if (fault === 'digest') next.digest = '0'.repeat(64);
      if (fault === 'sequence') next.sequence++;
      if (fault === 'receivedAt') next.receivedAt++;
      return next;
    } });
    await assert.rejects(h.sources.current(source, h.access), /knowledge_contention/, fault);
    assert.ok(h.trace.includes('input:before'), fault); assert.ok(h.trace.includes('input:after'), fault);
  }
  await h.unchanged();
});

test('source snapshot reuse: a single original cannot be absent, duplicated across pages or replaced by mismatched history metadata', async t => {
  const h = await fixture(t);
  for (const fault of ['missing', 'duplicate', 'duplicate-page', 'labels', 'kind', 'work', 'role', 'sequence', 'artifact'] as const) {
    h.reset({ repeatFirstHistoryPage: fault === 'duplicate-page', history: (page, options) => {
      const first = structuredClone(page.entries[0]); assert.ok(first);
      if (fault === 'missing') return { entries: [], nextCursor: null };
      if (fault === 'duplicate') return { entries: [first, structuredClone(first)], nextCursor: null };
      if (fault === 'duplicate-page') return { entries: [first], nextCursor: options.cursor ? null : 'same-original-again' };
      if (fault === 'labels') first.labels = [];
      if (fault === 'kind') first.kind = 'input';
      if (fault === 'work') first.workId = 'other-work';
      if (fault === 'role') first.role = 'assistant';
      if (fault === 'sequence') first.sequence++;
      if (fault === 'artifact') first.artifact = { id: 'not-user-text', sha256: '0'.repeat(64), byteLength: 0,
        mediaType: 'text/plain', tenantId: actor.tenantId, labels: [...first.labels] };
      return { entries: [first], nextCursor: null };
    } });
    await assert.rejects(h.sources.capture(h.access, h.ref), /knowledge_unavailable|session_original_invalid/, fault);
  }
  await h.unchanged();
});

test('source snapshot reuse: a different valid message receipt and its matching history cannot substitute for the requested original', async t => {
  const h = await fixture(t);
  await h.f.sessions!.input(actor, { sessionId: h.session.scope.sessionId, workId: h.accepted.workId, messageId: 'second',
    rawText: `다음 지시: ${quote}`, expectedGoalRevision: 1 });
  const other = await h.input(h.session.scope, 'second'); assert.ok(other && other.status === 'applied');
  assert.ok(other.text.includes(h.ref.quote)); assert.notEqual(other.messageId, h.ref.messageId);
  h.reset({ input: (value, _changed, messageId) => messageId === h.ref.messageId ? structuredClone(other) : value });
  await assert.rejects(h.sources.capture(h.access, h.ref), /knowledge_unavailable|session_original_invalid/);
  assert.deepEqual(await h.input(h.session.scope, 'first'), h.originalReceipt);
  assert.deepEqual(await h.input(h.session.scope, 'second'), other);
  assert.deepEqual(h.f.tool.invocations, []);
  assert.ok(h.f.services.planner instanceof ScriptedPlanner); assert.deepEqual(h.f.services.planner.inputs, []);
});
