import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openAgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { SYNTHETIC_AGENT_TURN_REQUESTS as texts } from '../infrastructure/synthetic-agent-turn.js';
import { agentTurnRequestCurrent } from '../application/agent-turn-request.js';
import { readGeneratedAnswer } from '../application/generated-answer.js';
import { executionControl } from '../domain/execution-policy.js';

test('goal command original remains verifiable after compact and reconnect, without accepting ordinary input as a goal receipt', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'goal-command-compact-'))), directory = join(base, 'agent');
  const hostOptions = { models: new Map(), identityRegistryDirectory: join(base, 'registry') };
  let p = await openAgentTurnProfile(directory, { provider: 'synthetic', compactProvider: 'synthetic' }, hostOptions);
  try {
    const session = await p.sessions.open(p.actor, { channel: 'test', conversationId: 'main' });
    const accepted = await p.turns.accept(p.actor, { sessionId: session.scope.sessionId, messageId: 'initial', rawText: texts.question,
      mode: 'auto', scope: p.scope, policy: p.policy, limits: p.limits,
      binding: { tenantId: p.actor.tenantId, principalId: p.actor.principalId, channel: 'test', conversationId: 'main', destination: 'local', recipientId: p.actor.principalId } });
    await p.workflow.run(accepted.workId, p.executionActor);
    const old = await p.runtime.state(accepted.workId);
    await p.turns.changeGoal(p.actor, { sessionId: session.scope.sessionId, workId: old.id, messageId: 'new-goal', rawText: texts.rewrite,
      expectedGoalRevision: 1, expectedControlRevision: executionControl(old).revision });
    await p.turns.followUp(p.actor, { sessionId: session.scope.sessionId, workId: old.id, messageId: 'latest', rawText: texts.rewrite,
      expectedGoalRevision: 2, action: { kind: 'continue' } });
    const original = await p.sessions.repository.input(session.scope, 'new-goal'); assert.equal(original!.kind, 'command');
    const before = await p.sessions.history(p.actor, session.scope.sessionId, p.policy, { limit: 100 });
    const call = await p.compactPlanning!.requestCompact(old.id, { force: true, requestId: 'compact-new-goal', expectedGoalRevision: 2 }); assert.ok(call);
    for (let n = 0; n < 4; n++) {
      const current = await p.runtime.state(old.id);
      if (!current.modelCalls.some(item => item.id === call.id && ['reserved', 'running', 'received'].includes(item.status))) break;
      await p.compactPlanning!.compactStep(old.id, { auto: false });
    }
    const compacted = await p.runtime.state(old.id);
    assert.equal(compacted.modelCalls.find(item => item.id === call.id)!.status, 'accepted');
    const context = await p.sessions.context(compacted); assert.equal(context!.schemaVersion, 2);
    assert.equal(context!.entries.some(entry => entry.sourceId === 'new-goal'), false, 'the changed goal is no longer in the raw tail');
    assert.equal(context!.entries.some(entry => entry.sourceId === 'latest'), true);
    assert.deepEqual(await p.sessions.history(p.actor, session.scope.sessionId, p.policy, { limit: 100 }), before);
    assert.equal(await agentTurnRequestCurrent(p.services, p.sessions.repository, compacted), true);
    const originalInput = p.sessions.repository.input.bind(p.sessions.repository);
    for (const alteration of [
      { kind: 'input' as const }, { status: 'rejected' as const }, { text: 'different text' },
      { payload: { expectedGoalRevision: 1, command: { kind: 'input', reason: 'ordinary input' } } },
    ]) {
      p.sessions.repository.input = async (scope, messageId) => {
        const receipt = await originalInput(scope, messageId);
        return receipt && messageId === 'new-goal' ? { ...receipt, ...alteration } : receipt;
      };
      assert.equal(await agentTurnRequestCurrent(p.services, p.sessions.repository, compacted), false);
    }
    p.sessions.repository.input = originalInput;
    await p.close(); p = await openAgentTurnProfile(directory, { provider: 'synthetic', compactProvider: 'synthetic' }, hostOptions);
    assert.equal((await p.workflow.run(old.id, p.executionActor, { expectedGoalRevision: 2 })).control.kind, 'complete');
    const done = await p.runtime.state(old.id);
    assert.ok(await readGeneratedAnswer(p.services, done)); assert.equal(done.goal.responseRequirement!.requestMessageId, 'new-goal');
    assert.equal(done.generatedAnswer!.input.input.messageId, 'latest'); assert.equal(done.goal.revision, 2);
    assert.deepEqual(await p.sessions.repository.input(session.scope, 'new-goal'), original);
    assert.equal(done.budget.reservedTokens, 0); assert.equal(done.budget.reservedModelCalls, 0);
  } finally { await p.close(); rmSync(base, { recursive: true, force: true }); }
});
