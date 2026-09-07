import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentTurnService, type AgentTurnFollowUp, type AgentTurnRequest } from '../application/agent-turn-service.js';
import { actor, initialize, open, request } from './session-flow-helpers.js';

async function fixture(t: TestContext, backend: 'sqlite' | 'file-journal' = 'sqlite') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-turn-intake-')));
  mkdirSync(join(base, 'engine'), { mode: 0o700 }); initialize(base, backend);
  let runtime = await open(base);
  t.after(async () => { try { await runtime.close(); } finally { rmSync(base, { recursive: true, force: true }); } });
  const session = await runtime.sessions!.open(actor, { channel: 'test', conversationId: 'conversation' });
  return { base, session, get f() { return runtime; },
    get turns() { return new AgentTurnService(runtime.sessions!, runtime.services.digester); },
    input(messageId: string, rawText: string): AgentTurnRequest {
      const host = request(messageId);
      return { sessionId: session.scope.sessionId, messageId, rawText, binding: host.binding, policy: host.policy,
        limits: host.limits, scope: 'general-host-scope', mode: 'auto' };
    },
    async reopen() { await runtime.close(); runtime = await open(base); },
  };
}

for (const backend of ['sqlite', 'file-journal'] as const) {
  test(`${backend}: original text is durable before normal work and acknowledgement; receipt retry preserves one work`, async t => {
    const h = await fixture(t, backend), input = h.input('original', '  오래 유지하는 담당 에이전트를 설명해 줘.\n후속 입력도 이어서 받을 거야.  ');
    const commit = h.f.stores.state.commit.bind(h.f.stores.state); let observedBeforeCommit = false;
    h.f.stores.state.commit = async proposal => {
      if (proposal.commandId === 'conversation.accept') {
        const receipt = await h.f.stores.sessions.input(h.session.scope, input.messageId);
        assert.equal(receipt?.text, input.rawText); assert.equal(receipt?.status, 'pending');
        assert.equal(receipt?.workId, proposal.workId); assert.equal(await h.f.stores.state.get(proposal.workId), null);
        observedBeforeCommit = true;
      }
      return commit(proposal);
    };
    let accepted: Awaited<ReturnType<AgentTurnService['accept']>>;
    try { accepted = await h.turns.accept(actor, input); }
    finally { h.f.stores.state.commit = commit; }
    assert.equal(observedBeforeCommit, true); assert.equal(accepted.accepted, true);
    assert.equal(accepted.state.goal.description, input.rawText); assert.equal(accepted.state.goal.scope, input.scope);
    assert.deepEqual(accepted.state.goal.criteria, []);
    assert.deepEqual(accepted.state.goal.responseRequirement, { version: 1, requestMessageId: input.messageId,
      requestTextDigest: h.f.services.digester.digest(input.rawText), format: 'text' });
    assert.deepEqual(accepted.state.policy, input.policy); assert.deepEqual(accepted.state.budget.limits, input.limits);
    assert.equal(accepted.state.conversation!.session!.scope.agentId, h.f.stores.profile.identity.agentId);
    assert.equal(accepted.state.modelCalls.length, 0); assert.equal(accepted.state.attempts.length, 0); assert.equal(h.f.tool.invocations.length, 0);
    const deliveries = await h.f.stores.state.deliveries(accepted.workId);
    assert.deepEqual(deliveries.map(delivery => delivery.kind), ['ack']);
    assert.equal(accepted.state.obligations.find(obligation => obligation.kind === 'delivery')?.status, 'pending');
    const original = await h.f.stores.sessions.input(h.session.scope, input.messageId); assert.equal(original?.status, 'applied');
    await h.reopen();
    const duplicate = await h.turns.accept(actor, input);
    assert.equal(duplicate.workId, accepted.workId); assert.equal(duplicate.accepted, false); assert.equal(duplicate.sequence, accepted.sequence);
    assert.deepEqual(await h.f.stores.sessions.input(h.session.scope, input.messageId), original);
    assert.equal((await h.f.stores.state.events(accepted.workId, 0)).filter(event => event.type === 'request_accepted').length, 1);
    assert.equal((await h.f.stores.state.deliveries(accepted.workId)).length, 1);
    await assert.rejects(h.turns.accept(actor, { ...input, rawText: '같은 메시지 ID의 바뀐 내용' }), /conflict/);
  });

  test(`${backend}: interruption after receipt publication resumes identical input without a second work or model call`, async t => {
    const h = await fixture(t, backend), input = h.input('resume', '저장한 원문으로 다시 이어가 줘.');
    const receive = h.f.stores.sessions.receive.bind(h.f.stores.sessions), interruption = new Error('after_durable_receipt');
    h.f.stores.sessions.receive = async value => { await receive(value); throw interruption; };
    try { await assert.rejects(h.turns.accept(actor, input), error => error === interruption); }
    finally { h.f.stores.sessions.receive = receive; }
    const pending = await h.f.stores.sessions.input(h.session.scope, input.messageId);
    assert.equal(pending?.status, 'pending'); assert.equal(pending?.text, input.rawText);
    assert.equal(await h.f.stores.state.get(pending!.workId), null);
    await h.reopen();
    const resumed = await h.turns.accept(actor, input);
    assert.equal(resumed.accepted, false); assert.equal(resumed.workId, pending!.workId); assert.equal(resumed.sequence, pending!.sequence);
    assert.equal((await h.f.stores.sessions.pending(h.session.scope, 1)).length, 0);
    assert.equal(resumed.state.modelCalls.length, 0); assert.equal(resumed.state.attempts.length, 0);
    assert.equal((await h.f.stores.state.events(resumed.workId, 0)).filter(event => event.type === 'request_accepted').length, 1);
  });
}

test('clarifying an actual question advances the applied reply while preserving the original requirement across retry', async t => {
  const h = await fixture(t), initial = h.input('original', '최신 운영 정책의 차이를 설명해 줘.');
  const accepted = await h.turns.accept(actor, initial), requirement = structuredClone(accepted.state.goal.responseRequirement);
  // Seed the same ordinary response obligation a main-turn question adopts; no provider is called here.
  const obligationId = 'agent-question:synthetic-call';
  await h.f.runtime.command(accepted.workId, 'question', actor, 1, { kind: 'wait', obligation: {
    id: obligationId, kind: 'response', reason: '어떤 운영 정책을 말하나요?', status: 'pending', wakeKey: obligationId, dueAt: null,
  } });
  const reply: AgentTurnFollowUp = { sessionId: h.session.scope.sessionId, messageId: 'clarification', workId: accepted.workId,
    rawText: '접근 권한 검토 주기를 말하는 거야.', expectedGoalRevision: 1, action: { kind: 'clarify', obligationId } };
  const result = await h.turns.followUp(actor, reply); const state = await h.f.runtime.state(accepted.workId);
  assert.equal(result.input.status, 'applied'); assert.equal(result.input.kind, 'command');
  assert.equal(state.obligations.find(value => value.id === obligationId)?.status, 'satisfied');
  assert.deepEqual(state.goal.responseRequirement, requirement); assert.equal(state.goal.description, initial.rawText);
  assert.equal(state.conversation!.session!.input.messageId, reply.messageId);
  assert(state.conversation!.session!.input.sequence > accepted.sequence);
  assert.notEqual(state.conversation!.session!.input.digest, requirement!.requestTextDigest);
  const context = await h.f.sessions!.context(state);
  assert(context!.entries.some(entry => entry.sourceId === initial.messageId && entry.text === initial.rawText));
  assert(context!.entries.some(entry => entry.sourceId === reply.messageId && entry.text === reply.rawText));
  const events = await h.f.stores.state.events(accepted.workId, 0);
  await h.reopen();
  const duplicate = await h.turns.followUp(actor, reply);
  assert.equal(duplicate.created, false); assert.deepEqual(duplicate.input, result.input);
  assert.deepEqual(await h.f.runtime.state(accepted.workId), state); assert.deepEqual(await h.f.stores.state.events(accepted.workId, 0), events);
  assert.equal(state.modelCalls.length, 0); assert.equal(state.attempts.length, 0);
});

test('continue retains work and budget while an explicit accept creates a separate work in the same session', async t => {
  const h = await fixture(t), initial = h.input('X', '첫 업무를 설명해 줘.');
  const first = await h.turns.accept(actor, initial);
  const followUp: AgentTurnFollowUp = { sessionId: h.session.scope.sessionId, messageId: 'X-more', workId: first.workId,
    rawText: '예시도 같이 넣어 줘.', expectedGoalRevision: 1, action: { kind: 'continue' } };
  const continued = await h.turns.followUp(actor, followUp), current = await h.f.runtime.state(first.workId);
  assert.equal(continued.workId, first.workId); assert.equal(continued.input.kind, 'input');
  assert.deepEqual(current.goal, first.state.goal); assert.deepEqual(current.budget, first.state.budget);
  assert.equal(current.conversation!.sessionReviewRequired, true);
  const second = await h.turns.accept(actor, h.input('Y', '이제 별도의 두 번째 업무를 설명해 줘.'));
  assert.notEqual(second.workId, first.workId); assert.equal(second.state.goal.responseRequirement!.requestMessageId, 'Y');
  assert.deepEqual(second.state.evidence, []); assert.deepEqual(second.state.attempts, []); assert.deepEqual(second.state.modelCalls, []);
  assert.equal(second.state.budget.used.tokens, 0);
  assert.equal(second.state.conversation!.session!.scope.sessionId, first.state.conversation!.session!.scope.sessionId);
  const context = await h.f.sessions!.context(second.state);
  assert(context!.entries.some(entry => entry.sourceId === followUp.messageId && entry.text === followUp.rawText));
});

test('host authority and explicit input schemas reject injected work, goal and cross-user or cross-session mutations', async t => {
  const h = await fixture(t), input = h.input('valid', '호스트가 지정한 권한으로 설명해 줘.');
  for (const injected of [{ workId: 'chosen-by-model' }, { goal: request('fake').goal }, { responseRequirement: { format: 'text' } }])
    await assert.rejects(h.turns.accept(actor, { ...input, ...injected } as AgentTurnRequest));
  await assert.rejects(h.turns.accept(actor, { ...input, rawText: ' \n ' }));
  await assert.rejects(h.turns.accept({ ...actor, principalId: 'other' }, input), /authorized/);
  await assert.rejects(h.turns.accept({ ...actor, allowedTools: [] }, input), /authorized/);
  await assert.rejects(h.turns.accept({ ...actor, allowWrites: false }, { ...input, policy: { ...input.policy, allowWrites: true } }), /authorized/);
  assert.equal((await h.f.stores.sessions.get(h.session.scope)).lastSequence, 0);
  const accepted = await h.turns.accept(actor, input);
  const followUp: AgentTurnFollowUp = { sessionId: h.session.scope.sessionId, messageId: 'more', workId: accepted.workId,
    rawText: '권한 없는 추가 입력', expectedGoalRevision: 1, action: { kind: 'continue' } };
  await assert.rejects(h.turns.followUp({ ...actor, principalId: 'other' }, followUp), /work_unavailable/);
  const otherSession = await h.f.sessions!.open(actor, { channel: 'test', conversationId: 'other', newSession: true });
  await assert.rejects(h.turns.followUp(actor, { ...followUp, sessionId: otherSession.scope.sessionId }), /session_work_unavailable/);
  assert.equal(await h.f.stores.sessions.input(h.session.scope, followUp.messageId), null);
  assert.equal((await h.f.runtime.state(accepted.workId)).conversation!.session!.input.messageId, input.messageId);
});

test('stale or non-resolvable clarification is durably rejected and cannot silently become a new work', async t => {
  const h = await fixture(t), accepted = await h.turns.accept(actor, h.input('original', '추가 질문 전에는 원래 요청을 유지해 줘.'));
  const followUp: AgentTurnFollowUp = { sessionId: h.session.scope.sessionId, messageId: 'unknown-question', workId: accepted.workId,
    rawText: '없는 질문에 대한 응답', expectedGoalRevision: 1, action: { kind: 'clarify', obligationId: 'missing' } };
  await assert.rejects(h.turns.followUp(actor, followUp), /obligation_not_resolvable/);
  const rejected = await h.f.stores.sessions.input(h.session.scope, followUp.messageId); assert.equal(rejected?.status, 'rejected');
  await assert.rejects(h.turns.followUp(actor, { ...followUp, messageId: 'stale', expectedGoalRevision: 2, action: { kind: 'continue' } }), /stale_user_command/);
  assert.deepEqual(await h.f.conversation.list(actor, 'test', 'conversation'), [accepted.workId]);
  const state = await h.f.runtime.state(accepted.workId); assert.equal(state.conversation!.session!.input.messageId, 'original');
  assert.equal(state.modelCalls.length, 0); assert.equal(state.attempts.length, 0);
});
