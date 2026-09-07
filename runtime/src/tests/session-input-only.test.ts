import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actor, finish, initialize, open, request, scenario } from './session-flow-helpers.js';

async function fixture(t: TestContext, backend: 'sqlite' | 'file-journal' = 'sqlite') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'session-input-only-')));
  mkdirSync(join(base, 'engine'), { mode: 0o700 }); initialize(base, backend);
  let f = await open(base);
  t.after(async () => { try { await f.close(); } finally { rmSync(base, { recursive: true, force: true }); } });
  const session = await f.sessions!.open(actor, { channel: 'test', conversationId: 'single-input' });
  const accepted = await f.sessions!.accept(actor, { sessionId: session.scope.sessionId, rawText: '현재 자료를 보고 설명해 주세요.', request: request('original') });
  const input = { sessionId: session.scope.sessionId, messageId: 'correction', workId: accepted.workId,
    rawText: '답변 형식은 한국어 설명과 근거를 함께 제시하는 것으로 정정합니다.', expectedGoalRevision: 1 };
  return { base, session, accepted, input, get f() { return f; },
    async reopen() { await f.close(); f = await open(base); },
    async receiveThenLose(messageId: string, operation: () => Promise<unknown>) {
      const receive = f.stores.sessions.receive.bind(f.stores.sessions), interruption = new Error('after_durable_input_before_application');
      f.stores.sessions.receive = async intake => { const result = await receive(intake); if (intake.messageId === messageId) throw interruption; return result; };
      try { await assert.rejects(operation(), error => error === interruption); }
      finally { f.stores.sessions.receive = receive; }
      const stored = await f.stores.sessions.input(session.scope, messageId); assert.equal(stored?.status, 'pending'); return stored!;
    },
  };
}

for (const backend of ['sqlite', 'file-journal'] as const) {
  test(`${backend}: inputOnly resumes the same original once and still acknowledges it after completed work`, async t => {
    const h = await fixture(t, backend);
    const pending = await h.receiveThenLose(h.input.messageId, () => h.f.sessions!.inputOnly(actor, h.input));
    await h.reopen();
    const applied = await h.f.sessions!.inputOnly(actor, h.input);
    assert.equal(applied.created, false); assert.equal(applied.input.sequence, pending.sequence); assert.equal(applied.input.status, 'applied');
    assert.equal((await h.f.runtime.state(h.accepted.workId)).conversation!.session!.input.messageId, h.input.messageId);
    await finish(h.f, h.accepted.workId);
    const completed = await h.f.runtime.state(h.accepted.workId); assert.equal(completed.status, 'completed');
    await h.reopen();
    const duplicate = await h.f.sessions!.inputOnly(actor, h.input);
    assert.equal(duplicate.created, false); assert.deepEqual(duplicate.input, applied.input);
    assert.deepEqual(await h.f.runtime.state(h.accepted.workId), completed);
    const history = await h.f.sessions!.history(actor, h.session.scope.sessionId, scenario.policy, { limit: 100 });
    const originals = history.entries.filter(entry => entry.role === 'user' && entry.sourceId === h.input.messageId);
    assert.equal(originals.length, 1); assert.equal(originals[0]!.text, h.input.rawText);
    const snapshot = await h.f.stores.sessions.get(h.session.scope);
    await assert.rejects(h.f.sessions!.inputOnly(actor, { ...h.input, rawText: '같은 ID의 다른 원문' }), /session_input_identity_conflict/);
    assert.deepEqual(await h.f.stores.sessions.get(h.session.scope), snapshot);
  });

  test(`${backend}: inputOnly leaves later work and command intakes pending, while ordinary resume still applies both`, async t => {
    const h = await fixture(t, backend);
    const other = await h.f.sessions!.accept(actor, { sessionId: h.session.scope.sessionId, rawText: '별도 업무는 그대로 대기하세요.', request: request('other') });
    const beforeOther = await h.f.runtime.state(other.workId);
    await h.receiveThenLose(h.input.messageId, () => h.f.sessions!.inputOnly(actor, h.input));
    const laterWork = await h.receiveThenLose('later-work', () => h.f.sessions!.accept(actor, {
      sessionId: h.session.scope.sessionId, rawText: '나중에 처리할 새 업무입니다.', request: request('later-work') }));
    await h.receiveThenLose('later-command', () => h.f.sessions!.command(actor, { ...h.input, messageId: 'later-command', workId: other.workId,
      rawText: '별도 업무를 취소합니다.', command: { kind: 'cancel', reason: 'explicit_later_cancel' } }));
    const result = await h.f.sessions!.inputOnly(actor, h.input); assert.equal(result.input.status, 'applied');
    assert.equal(await h.f.stores.state.get(laterWork.workId), null);
    assert.deepEqual(await h.f.runtime.state(other.workId), beforeOther);
    assert.deepEqual((await h.f.stores.sessions.pending(h.session.scope, 10)).map(input => input.messageId), ['later-work', 'later-command']);
    const current = await h.f.runtime.state(h.accepted.workId);
    assert.equal(current.attempts.length, 0); assert.equal(current.modelCalls.length, 0); assert.equal(current.budget.used.toolCalls, 0);
    assert.equal((await h.f.sessions!.inputOnly(actor, h.input)).created, false);
    assert.equal(await h.f.stores.state.get(laterWork.workId), null);
    await h.f.sessions!.resume(actor, h.session.scope.sessionId);
    assert.ok(await h.f.stores.state.get(laterWork.workId));
    assert.equal((await h.f.runtime.state(other.workId)).status, 'cancelled');
    assert.deepEqual(await h.f.stores.sessions.pending(h.session.scope, 10), []);
  });
}

test('inputOnly does not overtake an earlier pending work or automatically create another original', async t => {
  const h = await fixture(t);
  const earlier = await h.receiveThenLose('earlier', () => h.f.sessions!.accept(actor, {
    sessionId: h.session.scope.sessionId, rawText: '앞서 접수되어 아직 적용되지 않은 업무입니다.', request: request('earlier') }));
  const state = await h.f.runtime.state(h.accepted.workId), session = await h.f.stores.sessions.get(h.session.scope);
  await assert.rejects(h.f.sessions!.inputOnly(actor, h.input), /session_input_pending/);
  assert.equal(await h.f.stores.sessions.input(h.session.scope, h.input.messageId), null);
  assert.equal(await h.f.stores.state.get(earlier.workId), null);
  assert.deepEqual(await h.f.stores.sessions.get(h.session.scope), session);
  assert.deepEqual(await h.f.runtime.state(h.accepted.workId), state);
  // Model a receipt from a prior interrupted ordinary intake behind the predecessor.
  const target = await h.receiveThenLose(h.input.messageId, () => h.f.sessions!.input(actor, h.input));
  await assert.rejects(h.f.sessions!.inputOnly(actor, h.input), /session_input_pending/);
  assert.deepEqual(await h.f.stores.sessions.input(h.session.scope, h.input.messageId), target);
  assert.equal(await h.f.stores.state.get(earlier.workId), null);
  await h.f.sessions!.resume(actor, h.session.scope.sessionId);
  assert.equal((await h.f.sessions!.inputOnly(actor, h.input)).input.status, 'applied');
});

test('inputOnly catches a predecessor arriving between its preflight and durable receive', async t => {
  const h = await fixture(t);
  const receive = h.f.stores.sessions.receive.bind(h.f.stores.sessions);
  let injected = false, predecessorWorkId = '';
  h.f.stores.sessions.receive = async intake => {
    if (intake.messageId === 'predecessor') {
      const result = await receive(intake); predecessorWorkId = result.input.workId; throw new Error('predecessor_response_lost');
    }
    if (intake.messageId === h.input.messageId && !injected) {
      injected = true;
      await assert.rejects(h.f.sessions!.accept(actor, { sessionId: h.session.scope.sessionId, rawText: '동시에 먼저 도착한 업무', request: request('predecessor') }), /predecessor_response_lost/);
    }
    return receive(intake);
  };
  try { await assert.rejects(h.f.sessions!.inputOnly(actor, h.input), /session_input_pending/); }
  finally { h.f.stores.sessions.receive = receive; }
  const pending = await h.f.stores.sessions.pending(h.session.scope, 10);
  assert.deepEqual(pending.map(input => input.messageId), ['predecessor', h.input.messageId]);
  assert.equal(await h.f.stores.state.get(predecessorWorkId), null);
  assert.equal((await h.f.runtime.state(h.accepted.workId)).conversation!.session!.input.messageId, 'original');
});

test('inputOnly recovers a committed work command whose inbox settlement was interrupted', async t => {
  const h = await fixture(t), settle = h.f.stores.sessions.settle.bind(h.f.stores.sessions);
  h.f.stores.sessions.settle = async (...args) => { if (args[1] === h.input.messageId) throw new Error('before_inbox_settlement'); return settle(...args); };
  try { await assert.rejects(h.f.sessions!.inputOnly(actor, h.input), /before_inbox_settlement/); }
  finally { h.f.stores.sessions.settle = settle; }
  const committed = await h.f.runtime.state(h.accepted.workId);
  assert.equal(committed.conversation!.session!.input.messageId, h.input.messageId);
  assert.equal((await h.f.stores.sessions.input(h.session.scope, h.input.messageId))!.status, 'pending');
  await h.reopen();
  const result = await h.f.sessions!.inputOnly(actor, h.input); assert.equal(result.input.status, 'applied'); assert.equal(result.created, false);
  assert.deepEqual(await h.f.runtime.state(h.accepted.workId), committed);
});

test('inputOnly keeps authorization, session binding, and stale revision rejection before memory capture', async t => {
  const h = await fixture(t), before = await h.f.stores.sessions.get(h.session.scope);
  await assert.rejects(h.f.sessions!.inputOnly({ ...actor, principalId: 'other-user' }, h.input), /work_unavailable/);
  const otherSession = await h.f.sessions!.open(actor, { channel: 'test', conversationId: 'other-session', newSession: true });
  await assert.rejects(h.f.sessions!.inputOnly(actor, { ...h.input, sessionId: otherSession.scope.sessionId }), /session_work_unavailable/);
  assert.deepEqual(await h.f.stores.sessions.get(h.session.scope), before);
  await assert.rejects(h.f.sessions!.inputOnly(actor, { ...h.input, expectedGoalRevision: 2 }), /stale_user_command/);
  const rejected = await h.f.stores.sessions.input(h.session.scope, h.input.messageId);
  assert.equal(rejected!.status, 'rejected'); assert.equal(rejected!.rejection, 'stale_user_command');
  assert.equal((await h.f.runtime.state(h.accepted.workId)).conversation!.session!.input.messageId, 'original');
  await assert.rejects(h.f.sessions!.inputOnly(actor, { ...h.input, expectedGoalRevision: 2 }), /stale_user_command/);
  assert.deepEqual(await h.f.stores.sessions.input(h.session.scope, h.input.messageId), rejected);
});
