import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openAgentTurnProfile, type AgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { SYNTHETIC_AGENT_TURN_REQUESTS as requests } from '../infrastructure/synthetic-agent-turn.js';
import type { AgentTurnInput } from '../application/agent-turn-types.js';
import { fixture, replaceTurn, answer } from './agent-turn-flow-helpers.js';
import { readGeneratedAnswer } from '../application/generated-answer.js';

test('fast general request completes with one model turn, no fake evidence or tools, and next work keeps context', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    const x = await f.accept(requests.rewrite, 'x', 'fast');
    const result = await f.profile.workflow.run(x.workId, f.profile.executionActor);
    assert.equal(result.control.kind, 'complete', JSON.stringify(result));
    const state = await f.profile.runtime.state(x.workId);
    assert.equal(state.status, 'completed'); assert.equal(state.plan, null); assert.deepEqual(state.evidence, []);
    assert.equal(state.budget.used.modelCalls, 1); assert.equal(state.budget.used.toolCalls, 0); assert.equal(state.budget.used.replans, 0);
    assert.equal(state.budget.reservedTokens, 0); assert.equal(state.modelCalls[0]!.semanticVersion, 4);
    assert.match((await readGeneratedAnswer(f.profile.services, state))!.text, /세 시에 시작됩니다/);
    const y = await f.accept(requests.followup, 'y', 'fast');
    const next = await f.profile.workflow.run(y.workId, f.profile.executionActor); assert.equal(next.control.kind, 'complete', JSON.stringify(next));
    const after = await f.profile.runtime.state(y.workId); const packet = JSON.parse(new TextDecoder().decode(await f.profile.services.artifacts.get(after.modelCalls[0]!.inputArtifact, after.policy)));
    assert.ok(packet.turn.packet.session.entries.some((entry: {role:string;text:string}) => entry.role === 'assistant' && entry.text.includes('세 시에 시작됩니다')));
    assert.equal((await f.profile.runtime.state(x.workId)).budget.used.modelCalls, 1);
  } finally { await f.close(); }
});

test('general read uses the existing task executor once and then synthesizes from observed evidence', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    const accepted = await f.accept(requests.read);
    const result = await f.profile.workflow.run(accepted.workId, f.profile.executionActor);
    assert.equal(result.control.kind, 'complete', JSON.stringify(result));
    const state = await f.profile.runtime.state(accepted.workId);
    assert.equal(state.budget.used.toolCalls, 1); assert.equal(state.budget.used.modelCalls, 2); assert.equal(state.budget.used.replans, 0);
    assert.deepEqual(state.generatedAnswer!.evidenceIds, ['doc-current']);
    assert.ok(state.attempts[0]!.adopted); assert.match((await readGeneratedAnswer(f.profile.services, state))!.text, /30일/);
  } finally { await f.close(); }
});

test('question delivery waits and the raw reply resumes the same original response requirement', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    const accepted = await f.accept(requests.question);
    const waiting = await f.profile.workflow.run(accepted.workId, f.profile.executionActor);
    assert.equal(waiting.control.kind, 'wait', JSON.stringify(waiting));
    const before = await f.profile.runtime.state(accepted.workId);
    const question = before.obligations.find(value => value.kind === 'response' && value.status === 'pending')!;
    assert.ok(question); assert.equal(before.budget.used.modelCalls, 1);
    await f.profile.turns.followUp(f.profile.actor, { sessionId: f.session.scope.sessionId, workId: accepted.workId,
      messageId: 'clarification', rawText: requests.clarification, expectedGoalRevision: 1, action: { kind: 'clarify', obligationId: question.id } });
    const result = await f.profile.workflow.run(accepted.workId, f.profile.executionActor);
    assert.equal(result.control.kind, 'complete', JSON.stringify(result));
    const state = await f.profile.runtime.state(accepted.workId);
    assert.deepEqual(state.goal.responseRequirement, before.goal.responseRequirement);
    assert.equal(state.generatedAnswer!.input.input.messageId, 'clarification'); assert.equal(state.budget.used.modelCalls, 2);
    assert.equal((await f.profile.services.state.deliveries(state.id)).filter(value => value.kind === 'question').length, 1);
  } finally { await f.close(); }
});

test('needs_work candidate feeds a later turn and cannot be delivered as a completed answer', { timeout: 60000 }, async () => {
  const f = await fixture(); const inputs: AgentTurnInput[] = [];
  try {
    replaceTurn(f.profile, async input => { inputs.push(input); return answer(input, inputs.length === 1 ? 'draft incomplete' : 'reviewed answer', inputs.length === 1); });
    const accepted = await f.accept('Synthetic iterative response', 'iterative', 'deep');
    const result = await f.profile.workflow.run(accepted.workId, f.profile.executionActor);
    assert.equal(result.control.kind, 'complete', JSON.stringify(result)); assert.equal(inputs.length, 2);
    assert.equal(inputs[1]!.previousAnswer?.result.text, 'draft incomplete');
    assert.deepEqual(inputs[1]!.previousAnswer?.result.assessment.missing, ['revise the response']);
    const deliveries = await f.profile.services.state.deliveries(accepted.workId);
    assert.deepEqual(deliveries.filter(value => value.kind === 'result').map(value => value.text), ['reviewed answer']);
    const state = await f.profile.runtime.state(accepted.workId); assert.equal(state.budget.used.tokens, 20); assert.equal(state.budget.used.replans, 0);
  } finally { await f.close(); }
});

test('reopening after stored response adopts the original charged call and sends one final answer', { timeout: 60000 }, async () => {
  const f = await fixture(); let reopened: AgentTurnProfile | undefined;
  try {
    const accepted = await f.accept(requests.rewrite);
    const call = await f.profile.planning!.reserve(accepted.workId);
    await f.profile.planning!.execute(accepted.workId, call.id);
    assert.equal((await f.profile.runtime.state(accepted.workId)).modelCalls[0]!.status, 'received');
    await f.profile.close(); reopened = await openAgentTurnProfile(join(f.base, 'agent'), { provider: 'synthetic' }, f.hostOptions);
    const result = await reopened.workflow.run(accepted.workId, reopened.executionActor);
    assert.equal(result.control.kind, 'complete', JSON.stringify(result));
    const state = await reopened.runtime.state(accepted.workId); assert.equal(state.modelCalls.length, 1); assert.equal(state.modelCalls[0]!.id, call.id);
    assert.equal(state.budget.used.modelCalls, 1); assert.equal((await reopened.services.state.deliveries(state.id)).filter(value => value.kind === 'result').length, 1);
  } finally { await reopened?.close(); await f.close(); }
});
