import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, replaceTurn, answer } from './agent-turn-flow-helpers.js';
import { SYNTHETIC_AGENT_TURN_REQUESTS as requests } from '../infrastructure/synthetic-agent-turn.js';
import { createAgentTurnPrompt } from '../infrastructure/agent-turn-prompt.js';

for (const command of ['input', 'cancel'] as const) test(`late received answer cannot override ${command}; measured usage remains settled`, { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    replaceTurn(f.profile, async input => answer(input, 'old answer'));
    const accepted = await f.accept('original request', 'original', 'deep');
    const call = await f.profile.planning!.reserve(accepted.workId); await f.profile.planning!.execute(accepted.workId, call.id);
    const before = await f.profile.runtime.state(accepted.workId); assert.equal(before.modelCalls[0]!.status, 'received');
    await f.profile.sessions.command(f.profile.actor, { sessionId: f.session.scope.sessionId, workId: accepted.workId, messageId: 'new-command',
      rawText: command === 'cancel' ? 'cancel this work' : 'use the revised request', expectedGoalRevision: 1, command: { kind: command, reason: 'user_revision' } });
    assert.equal(await f.profile.planning!.adopt(accepted.workId, call.id), false);
    const after = await f.profile.runtime.state(accepted.workId);
    assert.equal(after.generatedAnswer, undefined); assert.equal(after.budget.used.tokens, 10); assert.equal(after.budget.used.modelCalls, 1);
    assert.equal(after.budget.reservedTokens, 0); assert.equal(after.budget.reservedModelCalls, 0);
    assert.equal((await f.profile.services.state.deliveries(after.id)).some(delivery => delivery.kind === 'result'), false);
    if (command === 'cancel') assert.equal(after.status, 'cancelled');
  } finally { await f.close(); }
});

test('same provider identity with a changed prompt rejects a stored response without resetting charged usage', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    replaceTurn(f.profile, async input => answer(input, 'old prompt answer'));
    const accepted = await f.accept('request', 'original', 'deep');
    const call = await f.profile.planning!.reserve(accepted.workId); await f.profile.planning!.execute(accepted.workId, call.id);
    const services = f.profile.planning!.services, prior = services.planner;
    services.planner = { ...prior, prompt: createAgentTurnPrompt({ ...prior.prompt!.profile, purpose: 'changed deployment purpose' }) };
    assert.equal(await f.profile.planning!.adopt(accepted.workId, call.id), false);
    const state = await f.profile.runtime.state(accepted.workId);
    assert.equal(state.modelCalls[0]!.status, 'rejected'); assert.equal(state.budget.used.tokens, 10); assert.equal(state.generatedAnswer, undefined);
  } finally { await f.close(); }
});

test('repeated unfinished self-review is bounded and never creates a deliverable answer', { timeout: 60000 }, async () => {
  const f = await fixture(); let calls = 0;
  try {
    replaceTurn(f.profile, async input => { calls++; return answer(input, `unfinished draft ${calls}`, true); });
    const accepted = await f.accept('bounded unfinished reasoning', 'bounded', 'deep');
    const result = await f.profile.workflow.run(accepted.workId, f.profile.executionActor);
    assert.equal(result.control.kind, 'blocked', JSON.stringify(result)); assert.equal(result.reason, 'no_progress_limit');
    const state = await f.profile.runtime.state(accepted.workId);
    assert.equal(calls, 3); assert.equal(state.budget.used.modelCalls, 3); assert.equal(state.budget.used.tokens, 30);
    assert.equal(state.budget.used.replans, 0); assert.equal(state.budget.reservedTokens, 0);
    assert.equal((await f.profile.services.state.deliveries(state.id)).some(delivery => delivery.kind === 'result'), false);
  } finally { await f.close(); }
});

test('unknown provider usage is retained and prevents an automatic unaccounted retry', { timeout: 60000 }, async () => {
  const f = await fixture(); let calls = 0;
  try {
    replaceTurn(f.profile, async () => { calls++; return { status: 'error', code: 'synthetic_transport_error', inputTokens: null, outputTokens: null }; });
    const accepted = await f.accept(requests.rewrite);
    const result = await f.profile.workflow.run(accepted.workId, f.profile.executionActor);
    assert.equal(result.control.kind, 'blocked', JSON.stringify(result));
    const state = await f.profile.runtime.state(accepted.workId);
    assert.equal(calls, 1); assert.equal(state.budget.used.unmeasuredModelCalls, 1); assert.equal(state.modelCalls[0]!.usageStatus, 'unknown');
    assert.equal(state.generatedAnswer, undefined); assert.equal(state.budget.used.modelCalls, 1);
  } finally { await f.close(); }
});

test('a prior draft disappearing after response reservation prevents accepting a late revision', { timeout: 60000 }, async () => {
  const f = await fixture(); let count = 0;
  try {
    replaceTurn(f.profile, async input => answer(input, ++count === 1 ? 'draft' : 'revised', count === 1));
    const accepted = await f.accept('revise this response', 'revision', 'deep');
    const planning = f.profile.planning!;
    const first = await planning.reserve(accepted.workId); await planning.execute(accepted.workId, first.id); assert.equal(await planning.adopt(accepted.workId, first.id), true);
    const source = (await f.profile.runtime.state(accepted.workId)).generatedAnswer!.artifact;
    const next = await planning.reserve(accepted.workId); await planning.execute(accepted.workId, next.id);
    const actual = planning.services.artifacts;
    planning.services.artifacts = { put: actual.put.bind(actual), exists: actual.exists.bind(actual),
      get: (ref, policy) => ref.id === source.id ? Promise.reject(new Error('source_removed')) : actual.get(ref, policy) };
    assert.equal(await planning.adopt(accepted.workId, next.id), false);
    const state = await f.profile.runtime.state(accepted.workId);
    assert.equal(state.generatedAnswer!.callId, first.id); assert.equal(state.modelCalls.find(call => call.id === next.id)!.status, 'rejected');
    assert.equal(state.budget.used.tokens, 20); assert.equal(state.budget.reservedTokens, 0);
    assert.equal((await f.profile.services.state.deliveries(state.id)).some(delivery => delivery.kind === 'result'), false);
  } finally { await f.close(); }
});
