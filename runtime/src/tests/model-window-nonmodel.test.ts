import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Planner } from '../application/ports.js';
import { readGeneratedAnswer } from '../application/generated-answer.js';
import { openAgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { SYNTHETIC_AGENT_TURN_REQUESTS as requests, SYNTHETIC_AGENT_TURN_CORRECTION } from '../infrastructure/synthetic-agent-turn.js';
import { modelContextPreviewEnvelope } from '../application/model-context-preview.js';
import { windowActor, windowFixture } from './session-window-helpers.js';

/** Uses the existing explicit synthetic main/compact provider and C01 stores, with invocation counters only. */
async function fixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'model-window-nonmodel-')));
  const profile = await openAgentTurnProfile(join(base, 'agent'), { provider: 'synthetic', compactProvider: 'synthetic' });
  t.after(async () => { await profile.close(); rmSync(base, { recursive: true, force: true }); });
  const planning = profile.planning!, original = planning.services.planner, calls = { turn: 0, compact: 0 };
  const planner: Planner = { identity: original.identity!, destination: original.destination, capabilities: { ...original.capabilities },
    prompt: original.prompt!, ...(original.inputEstimation ? { inputEstimation: original.inputEstimation } : {}),
    ...(original.estimateInput ? { estimateInput: original.estimateInput.bind(original) } : {}),
    ...(original.estimateContextPreview ? { estimateContextPreview: original.estimateContextPreview.bind(original) } : {}),
    estimateTurnInput: original.estimateTurnInput!.bind(original), estimateCompactInput: original.estimateCompactInput!.bind(original),
    propose: original.propose.bind(original),
    turn: async (...args) => { calls.turn++; return original.turn!(...args); },
    compact: async (...args) => { calls.compact++; return original.compact!(...args); } };
  planning.services.planner = planner; profile.services.planner = planner;
  assert.equal(profile.compactPlanning, planning); assert.ok(planner.compact);
  const session = await profile.sessions.open(profile.actor, { channel: 'test', conversationId: 'nonmodel' });
  const accept = (rawText: string) => profile.turns.accept(profile.actor, { sessionId: session.scope.sessionId, messageId: 'request', rawText,
    mode: 'deep', binding: { ...profile.executionActor, channel: 'test', conversationId: 'nonmodel', recipientId: profile.actor.principalId, destination: 'local' },
    scope: profile.scope, policy: profile.policy, limits: profile.limits });
  return { profile, planning, planner, calls, accept };
}

test('an accepted plan still reserves, executes and adopts its ready tool after the model input capacity falls to one token', { timeout: 60000 }, async t => {
  const f = await fixture(t), accepted = await f.accept(requests.read);
  const call = await f.planning.reserve(accepted.workId); await f.planning.execute(accepted.workId, call.id);
  assert.equal(await f.planning.adopt(accepted.workId, call.id), true);
  const planned = await f.profile.runtime.state(accepted.workId); assert.equal(planned.modelCalls[0]!.status, 'accepted');
  assert.equal(planned.plan!.tasks.length, 1); assert.equal(planned.plan!.tasks[0]!.toolId, 'fixture.read');
  f.planner.capabilities.maxInputTokens = 1;
  assert.equal(await f.planning.compactStep(accepted.workId), null);
  const actions: string[] = [];
  for (let step = 0; step < 3; step++) {
    const control = await f.planning.step(accepted.workId); assert.equal(control.kind, 'continue');
    if (control.kind !== 'continue') assert.fail('ready tool did not progress');
    actions.push(control.action);
  }
  assert.deepEqual(actions, ['reserve', 'dispatch', 'adopt']);
  const state = await f.profile.runtime.state(accepted.workId);
  assert.equal(state.attempts.length, 1); assert.equal(state.attempts[0]!.status, 'succeeded'); assert.equal(state.attempts[0]!.adopted, true);
  assert.ok(state.evidence.some(evidence => evidence.id === 'doc-current'));
  assert.equal(state.budget.used.toolCalls, 1); assert.equal(state.budget.used.modelCalls, 1);
  assert.equal(state.budget.used.tokens, planned.budget.used.tokens); assert.equal(state.modelCalls.length, 1);
  assert.deepEqual(f.calls, { turn: 1, compact: 0 });
  assert.equal(state.budget.reservedTokens, 0); assert.equal(state.budget.reservedToolCalls, 0); assert.equal(state.budget.reservedModelCalls, 0);
  // Producing the later answer needs another model turn; this test stops at the already authorized tool result.
});

test('an accepted answer completes and is delivered with compact enabled after capacity falls, without another model invocation', { timeout: 60000 }, async t => {
  const f = await fixture(t), accepted = await f.accept(requests.rewrite);
  const call = await f.planning.reserve(accepted.workId); await f.planning.execute(accepted.workId, call.id);
  assert.equal(await f.planning.adopt(accepted.workId, call.id), true);
  const before = await f.profile.runtime.state(accepted.workId); assert.equal(before.status, 'ready'); assert.ok(before.generatedAnswer);
  const originalReply = before.modelCalls[0]!.replyArtifact, originalAnswer = before.generatedAnswer!.artifact;
  f.planner.capabilities.maxInputTokens = 1;
  const finished = await f.profile.workflow.run(accepted.workId, f.profile.executionActor, { maxSteps: 10 });
  assert.equal(finished.control.kind, 'complete');
  const state = await f.profile.runtime.state(accepted.workId); assert.equal(state.status, 'completed');
  assert.equal(state.modelCalls.length, 1); assert.equal(state.modelCalls[0]!.status, 'accepted');
  assert.deepEqual(state.modelCalls[0]!.replyArtifact, originalReply); assert.deepEqual(state.generatedAnswer!.artifact, originalAnswer);
  const text = (await readGeneratedAnswer(f.planning.services, state))?.text;
  assert.equal(text, `[합성 규칙 결과] ${SYNTHETIC_AGENT_TURN_CORRECTION}`);
  const results = (await f.profile.services.state.deliveries(state.id)).filter(delivery => delivery.kind === 'result');
  assert.equal(results.length, 1); assert.equal(results[0]!.status, 'delivered'); assert.equal(results[0]!.text, text);
  assert.deepEqual(f.calls, { turn: 1, compact: 0 });
  assert.equal(state.budget.used.tokens, before.budget.used.tokens); assert.equal(state.budget.used.modelCalls, 1);
  assert.equal(state.budget.reservedTokens, 0); assert.equal(state.budget.reservedModelCalls, 0);
});

test('a compact-only workflow never gates a disabled main model; a small fitting compact proceeds and yields for a manual plan', { timeout: 60000 }, async t => {
  const f = await windowFixture(t, 4, { maxContextEntries: 3, keepRecentEntries: 1 });
  assert.equal(f.planning, null); assert.ok(f.compactPlanning);
  const before = await f.current(), originalHistory = await f.history(), counts = { preview: 0, full: 0 };
  f.planner.capabilities.maxInputTokens = 100;
  f.planner.estimateContextPreview = (preview, options) => { counts.preview++;
    return { tokens: 1000000, bytes: Buffer.byteLength(JSON.stringify(modelContextPreviewEnvelope(preview, options))), method: 'disabled_main_model_overflow' }; };
  f.planner.estimateInput = () => { counts.full++; throw new Error('disabled_main_model_must_not_be_measured'); };
  // windowFixture's compact estimator reports exactly 100 tokens for its full compact envelope.
  const result = await f.workflow.run(f.workId, windowActor, { maxSteps: 8 });
  assert.equal(result.control.kind, 'replan');
  const state = await f.current(); assert.equal(state.plan, null); assert.notEqual(state.status, 'blocked');
  assert.equal(state.modelCalls.length, 1); assert.equal(state.modelCalls[0]!.purpose, 'session_compact');
  assert.equal(state.modelCalls[0]!.status, 'accepted'); assert.equal(state.modelCalls[0]!.inputEstimate, 100);
  assert.equal(f.planner.inputs.length, 1); assert.deepEqual(counts, { preview: 0, full: 0 });
  assert.equal(state.budget.used.modelCalls, 1); assert.equal(state.budget.used.tokens, 10);
  assert.equal(state.budget.reservedTokens, 0); assert.equal(state.budget.reservedModelCalls, 0);
  const context = await f.sessions.context(state); assert.equal(context?.schemaVersion, 2);
  assert.equal(context!.entries.at(-1)!.sourceId, before.conversation!.session!.input.messageId);
  const afterHistory = await f.history();
  assert.deepEqual(afterHistory.entries.filter(entry => entry.sequence <= before.conversation!.session!.input.sequence), originalHistory.entries);
});
