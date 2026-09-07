import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentTurnService, type AgentTurnGoalChange } from '../application/agent-turn-service.js';
import { executionControl } from '../domain/execution-policy.js';
import { readGeneratedAnswer } from '../application/generated-answer.js';
import { actor, initialize, open, request } from './session-flow-helpers.js';
import { fixture as agentFixture, replaceTurn, answer } from './agent-turn-flow-helpers.js';
import { SYNTHETIC_AGENT_TURN_REQUESTS as texts } from '../infrastructure/synthetic-agent-turn.js';

async function fixture(t: TestContext, backend: 'sqlite' | 'file-journal' = 'sqlite') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-goal-change-')));
  mkdirSync(join(base, 'engine'), { mode: 0o700 }); initialize(base, backend);
  let f = await open(base);
  t.after(async () => { try { await f.close(); } finally { rmSync(base, { recursive: true, force: true }); } });
  const session = await f.sessions!.open(actor, { channel: 'test', conversationId: 'conversation' });
  const host = request('initial');
  const turns = () => new AgentTurnService(f.sessions!, f.services.digester);
  const accepted = await turns().accept(actor, { sessionId: session.scope.sessionId, messageId: 'initial', rawText: '원래 문서를 비교해 줘.',
    binding: host.binding, scope: 'general', mode: 'auto', policy: host.policy, limits: host.limits });
  const change: AgentTurnGoalChange = { sessionId: session.scope.sessionId, workId: accepted.workId, messageId: 'new-goal',
    rawText: '  확인한 차이를 보고서로 작성해 줘.\n원문과 사용량은 유지해 줘.  ',
    expectedGoalRevision: 1, expectedControlRevision: executionControl(accepted.state).revision };
  return { session, accepted, change, get f() { return f; }, get turns() { return turns(); },
    async reopen() { await f.close(); f = await open(base); } };
}

for (const backend of ['sqlite', 'file-journal'] as const) {
  test(`${backend}: explicit goal intake preserves work, original transcript and budget; replay uses the first command`, async t => {
    const h = await fixture(t, backend);
    const basis = await h.turns.goalChangeBasis(actor, { sessionId: h.change.sessionId, workId: h.change.workId });
    assert.deepEqual(basis.expectedInput, h.accepted.state.conversation!.session!.input);
    const changed = await h.turns.changeGoal(actor, h.change), state = await h.f.runtime.state(h.change.workId);
    assert.equal(changed.created, true); assert.equal(changed.input.status, 'applied');
    assert.equal(state.goal.revision, 2); assert.equal(executionControl(state).revision, basis.expectedControlRevision + 1);
    assert.equal(state.goal.description, h.change.rawText); assert.equal(state.goal.scope, 'general'); assert.deepEqual(state.goal.criteria, []);
    assert.deepEqual(state.goal.responseRequirement, { version: 1, requestMessageId: h.change.messageId,
      requestTextDigest: h.f.services.digester.digest(h.change.rawText), format: 'text' });
    assert.deepEqual(state.policy, h.accepted.state.policy); assert.deepEqual(state.budget, h.accepted.state.budget);
    assert.equal(state.deadlineAt, h.accepted.state.deadlineAt); assert.equal(state.modelCalls.length, 0);
    assert.equal(state.conversation!.sessionReviewRequired, true);
    assert.equal(state.obligations.find(item => item.id === 'response-delivery:1')!.status, 'waived');
    assert.equal(state.obligations.find(item => item.id === 'response-delivery:2')!.status, 'pending');
    const context = await h.f.sessions!.context(state);
    assert.deepEqual(context!.entries.filter(entry => entry.role === 'user').map(entry => entry.text), ['원래 문서를 비교해 줘.', h.change.rawText]);
    await h.reopen();
    await h.f.runtime.command(state.id, 'later-mode', actor, 2, { kind: 'mode', mode: 'deep', reason: 'later mode', expectedControlRevision: executionControl(state).revision });
    const beforeReplay = await h.f.runtime.state(state.id);
    const replay = await h.turns.changeGoal(actor, h.change);
    assert.equal(replay.created, false); assert.deepEqual(replay.input, changed.input);
    assert.deepEqual(await h.f.runtime.state(state.id), beforeReplay);
    for (const edit of [{ rawText: '다른 내용' }, { mode: 'fast' as const }, { expectedControlRevision: 99 },
      { expectedGoalRevision: 2 }, { expectedInput: { ...basis.expectedInput, sequence: 99 } }])
      await assert.rejects(h.turns.changeGoal(actor, { ...h.change, ...edit }), /session_input_identity_conflict/);
    assert.equal((await h.f.stores.state.events(state.id, 0)).filter(event => event.type === 'user_command' &&
      (event.data['payload'] as { command: { kind: string } }).command.kind === 'goal').length, 1);
  });

  for (const interruption of ['after_receive', 'after_commit'] as const) test(`${backend}: ${interruption} resumes the original goal command after reconnect`, async t => {
    const h = await fixture(t, backend), fault = new Error(interruption);
    if (interruption === 'after_receive') {
      const receive = h.f.stores.sessions.receive.bind(h.f.stores.sessions);
      h.f.stores.sessions.receive = async value => { await receive(value); throw fault; };
      try { await assert.rejects(h.turns.changeGoal(actor, h.change), error => error === fault); }
      finally { h.f.stores.sessions.receive = receive; }
    } else {
      const settle = h.f.stores.sessions.settle.bind(h.f.stores.sessions);
      h.f.stores.sessions.settle = async () => { throw fault; };
      try { await assert.rejects(h.turns.changeGoal(actor, h.change), error => error === fault); }
      finally { h.f.stores.sessions.settle = settle; }
    }
    const receipt = await h.f.stores.sessions.input(h.session.scope, h.change.messageId);
    assert.equal(receipt!.status, 'pending'); assert.equal(receipt!.text, h.change.rawText);
    assert.equal((await h.f.runtime.state(h.change.workId)).goal.revision, interruption === 'after_receive' ? 1 : 2);
    await h.reopen(); const resumed = await h.turns.changeGoal(actor, h.change);
    assert.equal(resumed.created, false); assert.equal(resumed.input.digest, receipt!.digest); assert.equal(resumed.input.sequence, receipt!.sequence);
    assert.equal(resumed.input.status, 'applied'); assert.equal((await h.f.runtime.state(h.change.workId)).goal.revision, 2);
    assert.equal((await h.f.stores.sessions.pending(h.session.scope, 1)).length, 0);
  });
}

test('a newer applied input rejects the old editor basis durably without changing goal or transcript head', async t => {
  const h = await fixture(t), basis = await h.turns.goalChangeBasis(actor, { sessionId: h.change.sessionId, workId: h.change.workId });
  await h.turns.followUp(actor, { sessionId: h.change.sessionId, workId: h.change.workId, messageId: 'followup', rawText: '반드시 원본을 확인해 줘.',
    expectedGoalRevision: 1, action: { kind: 'continue' } });
  const before = await h.f.runtime.state(h.change.workId);
  assert.equal(before.goal.revision, basis.expectedGoalRevision); assert.equal(executionControl(before).revision, basis.expectedControlRevision);
  const stale = { ...h.change, expectedInput: basis.expectedInput };
  await assert.rejects(h.turns.changeGoal(actor, stale), /stale_session_input/);
  assert.deepEqual(await h.f.runtime.state(before.id), before);
  const receipt = await h.f.stores.sessions.input(h.session.scope, stale.messageId);
  assert.equal(receipt!.status, 'rejected'); assert.equal(receipt!.rejection, 'stale_session_input'); assert.equal(receipt!.text, stale.rawText);
  await h.reopen(); await assert.rejects(h.turns.changeGoal(actor, stale), /stale_session_input/);
  const fresh = await h.turns.goalChangeBasis(actor, { sessionId: h.change.sessionId, workId: h.change.workId });
  await h.turns.changeGoal(actor, { ...h.change, messageId: 'fresh-goal', expectedInput: fresh.expectedInput });
  assert.equal((await h.f.runtime.state(before.id)).goal.revision, 2);
});

test('a control change inside the goal commit CAS is rechecked and cannot overwrite the newer mode', async t => {
  const h = await fixture(t), commit = h.f.stores.state.commit.bind(h.f.stores.state); let raced = false;
  h.f.stores.state.commit = async proposal => {
    if (!raced && proposal.next.goal.revision === 2) {
      raced = true;
      await h.f.runtime.command(h.change.workId, 'concurrent-mode', actor, 1, { kind: 'mode', mode: 'deep', reason: 'concurrent mode', expectedControlRevision: h.change.expectedControlRevision });
    }
    return commit(proposal);
  };
  try { await assert.rejects(h.turns.changeGoal(actor, h.change), /stale_execution_control/); }
  finally { h.f.stores.state.commit = commit; }
  const state = await h.f.runtime.state(h.change.workId);
  assert.equal(raced, true); assert.equal(state.goal.revision, 1); assert.equal(executionControl(state).requestedMode, 'deep');
  assert.equal(state.conversation!.session!.input.messageId, 'initial');
  assert.equal((await h.f.stores.sessions.input(h.session.scope, h.change.messageId))!.rejection, 'stale_execution_control');
});

test('goal intake validates authority, selected session, original IDs, and server-owned fields before receipt publication', async t => {
  const h = await fixture(t), other = await h.f.sessions!.open(actor, { channel: 'test', conversationId: 'other', newSession: true });
  for (const denied of [{ ...actor, tenantId: 'other' }, { ...actor, principalId: 'other' }]) {
    await assert.rejects(h.turns.changeGoal(denied, h.change), /work_unavailable/);
    await assert.rejects(h.turns.goalChangeBasis(denied, { sessionId: h.change.sessionId, workId: h.change.workId }), /work_unavailable/);
  }
  await assert.rejects(h.turns.goalChangeBasis({ ...actor, allowedLabels: [] }, { sessionId: h.change.sessionId, workId: h.change.workId }), /session_work_unavailable/);
  await assert.rejects(h.turns.changeGoal({ ...actor, allowedLabels: [] }, h.change), /session_work_unavailable/);
  await assert.rejects(h.turns.changeGoal(actor, { ...h.change, sessionId: other.scope.sessionId }), /session_work_unavailable/);
  for (const injection of [{ goal: h.accepted.state.goal }, { scope: 'other' }, { policy: h.accepted.state.policy }, { criteria: [] }])
    await assert.rejects(h.turns.changeGoal(actor, { ...h.change, ...injection } as AgentTurnGoalChange));
  await assert.rejects(h.turns.changeGoal(actor, { ...h.change, rawText: ' \n ' }));
  await assert.rejects(h.turns.changeGoal(actor, { ...h.change, messageId: 'initial' }), /session_input_identity_conflict/);
  assert.equal(await h.f.stores.sessions.input(h.session.scope, h.change.messageId), null);
  assert.deepEqual(await h.f.runtime.state(h.change.workId), h.accepted.state);
});

test('cancelled work stays terminal; rejected input remains auditable and cannot become another work', async t => {
  const h = await fixture(t);
  await h.f.runtime.command(h.change.workId, 'cancel', actor, 1, { kind: 'cancel', reason: 'user cancelled' });
  await assert.rejects(h.turns.changeGoal(actor, h.change), /work_terminal/);
  assert.equal((await h.f.runtime.state(h.change.workId)).status, 'cancelled');
  assert.equal((await h.f.stores.sessions.input(h.session.scope, h.change.messageId))!.rejection, 'work_terminal');
  assert.deepEqual(await h.f.conversation.list(actor, 'test', 'conversation'), [h.change.workId]);
});

test('completed response can receive an explicit new goal while old answer, read artifacts and actual usage remain historical', async t => {
  const h = await agentFixture(); t.after(h.close); const p = h.profile;
  const accepted = await h.accept(texts.read); await p.workflow.run(accepted.workId, p.executionActor);
  const old = await p.runtime.state(accepted.workId); assert.equal(old.status, 'completed'); assert.ok(old.generatedAnswer);
  const oldAnswer = await p.services.artifacts.get(old.generatedAnswer.artifact, old.policy);
  const basis = await p.turns.goalChangeBasis(p.actor, { sessionId: h.session.scope.sessionId, workId: old.id });
  await p.turns.changeGoal(p.actor, { workId: old.id, expectedGoalRevision: basis.expectedGoalRevision,
    expectedControlRevision: basis.expectedControlRevision, expectedInput: basis.expectedInput,
    sessionId: h.session.scope.sessionId, messageId: 'rewrite-goal', rawText: texts.rewrite });
  const next = await p.runtime.state(old.id);
  assert.equal(next.status, 'ready'); assert.equal(await readGeneratedAnswer(p.services, next), null);
  assert.deepEqual(next.generatedAnswer, old.generatedAnswer); assert.deepEqual(next.evidence, old.evidence); assert.deepEqual(next.attempts, old.attempts);
  assert.deepEqual(next.modelCalls, old.modelCalls); assert.deepEqual(next.budget, old.budget); assert.equal(next.deadlineAt, old.deadlineAt);
  assert.deepEqual(await p.services.artifacts.get(old.generatedAnswer.artifact, next.policy), oldAnswer);
  await p.workflow.run(old.id, p.executionActor, { expectedGoalRevision: 2 });
  const done = await p.runtime.state(old.id); assert.equal(done.status, 'completed'); assert.equal(done.goal.revision, 2);
  assert.equal(done.modelCalls.length, old.modelCalls.length + 1); assert.equal(done.attempts.length, old.attempts.length);
  assert.equal(done.generatedAnswer!.goalRevision, 2); assert.equal(done.generatedAnswer!.input.input.messageId, 'rewrite-goal');
  const deliveries = await p.services.state.deliveries(old.id);
  assert.deepEqual(deliveries.filter(item => item.kind === 'result' && item.status === 'delivered').map(item => item.goalRevision).sort(), [1, 2]);
});

test('only an accepted old main-turn question is superseded; external response and evidence obligations survive', async t => {
  const h = await agentFixture(); t.after(h.close); const p = h.profile;
  const accepted = await h.accept(texts.question); await p.workflow.run(accepted.workId, p.executionActor);
  const old = await p.runtime.state(accepted.workId), question = old.obligations.find(item => item.id.startsWith('agent-question:'))!;
  assert.equal(question.status, 'pending');
  for (const obligation of [
    { id: 'external-response', kind: 'response' as const }, { id: 'external-evidence', kind: 'evidence' as const },
    { id: 'agent-question:unregistered', kind: 'response' as const },
  ]) await p.runtime.command(old.id, `wait:${obligation.id}`, p.actor, 1, { kind: 'wait',
    obligation: { ...obligation, status: 'pending', reason: 'independent obligation', wakeKey: obligation.id, dueAt: null } });
  const state = await p.runtime.state(old.id);
  await p.turns.changeGoal(p.actor, { sessionId: h.session.scope.sessionId, workId: old.id, messageId: 'new-goal', rawText: texts.rewrite,
    expectedGoalRevision: 1, expectedControlRevision: executionControl(state).revision });
  const changed = await p.runtime.state(old.id);
  assert.equal(changed.obligations.find(item => item.id === question.id)!.status, 'waived');
  assert.equal(changed.obligations.find(item => item.id === question.id)!.reason, 'agent_question_superseded_by_goal_change');
  for (const id of ['external-response', 'external-evidence', 'agent-question:unregistered'])
    assert.equal(changed.obligations.find(item => item.id === id)!.status, 'pending');
  assert.deepEqual(changed.modelCalls, state.modelCalls); assert.deepEqual(changed.budget, state.budget);
  const events = await p.services.state.events(old.id, 0);
  assert(events.some(event => event.type === 'model_turn_accepted' &&
    (event.data['payload'] as { callId: string; kind: string }).kind === 'question'));
  assert.equal((await p.services.state.deliveries(old.id)).filter(item => item.kind === 'question' && item.goalRevision === 1).length, 1);
  await assert.rejects(p.turns.followUp(p.actor, { sessionId: h.session.scope.sessionId, workId: old.id, messageId: 'old-reply', rawText: texts.clarification,
    expectedGoalRevision: 1, action: { kind: 'clarify', obligationId: question.id } }), /stale_user_command/);
});

test('narrowed policy at dispatch is rejected instead of expanding the caller authority', async t => {
  const h = await fixture(t);
  await assert.rejects(h.turns.changeGoal({ ...actor, allowedTools: [] }, h.change), /stale_work_policy/);
  const state = await h.f.runtime.state(h.change.workId); assert.deepEqual(state, h.accepted.state);
  const original = await h.f.stores.sessions.input(h.session.scope, h.change.messageId);
  assert.equal(original!.rejection, 'stale_work_policy');
});

for (const stage of ['reserved', 'received'] as const) test(`goal replacement invalidates an old ${stage} model call and preserves actual accounting`, async t => {
  const h = await agentFixture(); t.after(h.close); const p = h.profile;
  replaceTurn(p, async input => answer(input, 'answer for the old goal'));
  const accepted = await h.accept('first goal', 'first', 'deep');
  const call = await p.planning!.reserve(accepted.workId);
  if (stage === 'received') await p.planning!.execute(accepted.workId, call.id);
  const before = await p.runtime.state(accepted.workId);
  await p.turns.changeGoal(p.actor, { sessionId: h.session.scope.sessionId, workId: accepted.workId, messageId: 'replacement', rawText: 'new goal',
    expectedGoalRevision: 1, expectedControlRevision: executionControl(before).revision });
  if (stage === 'received') assert.equal(await p.planning!.adopt(accepted.workId, call.id), false);
  const state = await p.runtime.state(accepted.workId);
  assert.equal(state.goal.revision, 2); assert.equal(state.generatedAnswer, undefined);
  assert.equal(state.modelCalls[0]!.status, stage === 'reserved' ? 'cancelled' : 'rejected');
  assert.equal(state.budget.used.modelCalls, stage === 'reserved' ? 0 : 1);
  assert.equal(state.budget.used.tokens, stage === 'reserved' ? 0 : 10);
  assert.equal(state.budget.reservedModelCalls, 0); assert.equal(state.budget.reservedTokens, 0);
  assert.equal((await p.services.state.deliveries(state.id)).some(item => item.kind === 'result'), false);
});
