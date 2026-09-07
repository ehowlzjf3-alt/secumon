import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { SYNTHETIC_AGENT_TURN_REQUESTS as requests, SYNTHETIC_AGENT_TURN_CORRECTION } from '../infrastructure/synthetic-agent-turn.js';
import { openAgentTurnProfile, type AgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { AgentTurnInputSchema } from '../application/agent-turn-contracts.js';
import { readGeneratedAnswer } from '../application/generated-answer.js';
import type { SessionSummaryRecord } from '../domain/session-compact.js';

const runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
const correction = `[합성 규칙 결과] ${SYNTHETIC_AGENT_TURN_CORRECTION}`;
async function compact(profile: AgentTurnProfile, workId: string, requestId: string): Promise<SessionSummaryRecord> {
  const planning = profile.compactPlanning!;
  const call = await planning.requestCompact(workId, { force: true, requestId, expectedGoalRevision: 1 }); assert.ok(call);
  for (let step = 0; step < 4; step++) {
    const state = await profile.runtime.state(workId);
    if (!state.modelCalls.some(value => value.id === call.id && ['reserved', 'running', 'received'].includes(value.status))) break;
    const result = await planning.compactStep(workId, { auto: false });
    if (!result || result.kind !== 'continue') break;
  }
  const state = await profile.runtime.state(workId), stored = state.modelCalls.find(value => value.id === call.id)!;
  assert.equal(stored.status, 'accepted', JSON.stringify({ reason: stored.reason, status: stored.status }));
  assert.equal(stored.purpose, 'session_compact'); assert.equal(stored.inputEstimate, 1);
  assert.equal(state.budget.reservedTokens, 0); assert.equal(state.budget.reservedModelCalls, 0);
  const ref = await profile.sessions.compactStatus(profile.actor, state.conversation!.session!.scope.sessionId); assert.ok(ref);
  const summary = await profile.sessions.repository.summary(state.conversation!.session!.scope, ref.id); assert.ok(summary); return summary;
}

for (const backend of ['sqlite', 'file-journal'] as const) test(`${backend}: generic correction survives repeated compact as an exact assistant citation and a later command-backed answer`, { timeout: 60000 }, async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-turn-compact-'))), directory = join(base, 'agent');
  const hostOptions = { models: new Map(), identityRegistryDirectory: join(base, 'registry') };
  const initialized = new FileAgentProfileStore(runtimeRoot).initialize(directory);
  if (backend === 'file-journal') writeFileSync(join(directory, 'config.json'), JSON.stringify({ ...initialized.config,
    storage: { ...initialized.config.storage, state: backend } }), { mode: 0o600 });
  let profile = await openAgentTurnProfile(directory, { provider: 'synthetic', compactProvider: 'synthetic' }, hostOptions);
  try {
    const session = await profile.sessions.open(profile.actor, { channel: 'test', conversationId: 'compact-main' });
    async function accept(messageId: string, rawText: string) {
      return profile.turns.accept(profile.actor, { sessionId: session.scope.sessionId, messageId, rawText, mode: 'auto',
        binding: { ...profile.executionActor, channel: 'test', conversationId: 'compact-main', recipientId: profile.actor.principalId, destination: 'local' },
        scope: profile.scope, policy: profile.policy, limits: profile.limits });
    }
    const x = await accept('X', requests.rewrite);
    assert.equal((await profile.workflow.run(x.workId, profile.executionActor)).control.kind, 'complete');
    const xBefore = await profile.runtime.state(x.workId);
    const y = await accept('Y', requests.question);
    assert.equal((await profile.workflow.run(y.workId, profile.executionActor)).control.kind, 'wait');
    const waiting = await profile.runtime.state(y.workId);
    const question = waiting.obligations.find(value => value.kind === 'response' && value.status === 'pending'); assert.ok(question);
    await profile.turns.followUp(profile.actor, { sessionId: session.scope.sessionId, messageId: 'Y-reply', workId: y.workId,
      rawText: requests.followup, expectedGoalRevision: 1, action: { kind: 'clarify', obligationId: question.id } });
    const before = await profile.sessions.history(profile.actor, session.scope.sessionId, profile.policy, { limit: 100 });
    const first = await compact(profile, y.workId, 'compact-Y');
    assert.deepEqual(await profile.sessions.history(profile.actor, session.scope.sessionId, profile.policy, { limit: 100 }), before);
    const retainedCorrection = first.content.retained.find(item => item.kind === 'outcome' && item.citations.some(citation => citation.role === 'assistant' && citation.quote === correction));
    assert.ok(retainedCorrection);
    for (const citation of retainedCorrection.citations) assert.ok(before.entries.some(entry => entry.role === citation.role &&
      entry.sequence === citation.sequence && entry.sourceId === citation.sourceId && entry.text.includes(citation.quote)));
    const stateAfterCompact = await profile.runtime.state(y.workId);
    const context = await profile.sessions.context(stateAfterCompact); assert.equal(context?.schemaVersion, 2);
    assert.ok(context!.entries.some(entry => entry.role === 'user' && entry.kind === 'command' && entry.sourceId === 'Y-reply' && entry.text === requests.followup));
    assert.ok(!context!.entries.some(entry => entry.sourceId === 'X' || entry.sourceId === 'Y'));
    assert.equal(stateAfterCompact.goal.responseRequirement!.requestMessageId, 'Y');
    assert.equal(stateAfterCompact.goal.responseRequirement!.requestTextDigest, profile.services.digester.digest(requests.question));
    const callsBeforeRetry = stateAfterCompact.modelCalls.length;
    assert.equal((await profile.compactPlanning!.requestCompact(y.workId, { force: true, requestId: 'compact-Y', expectedGoalRevision: 1 }))!.id,
      stateAfterCompact.modelCalls.find(call => call.purpose === 'session_compact')!.id);
    assert.equal((await profile.runtime.state(y.workId)).modelCalls.length, callsBeforeRetry);

    await profile.close(); profile = await openAgentTurnProfile(directory, { provider: 'synthetic', compactProvider: 'synthetic' }, hostOptions);
    assert.equal((await profile.workflow.run(y.workId, profile.executionActor)).control.kind, 'complete');
    const yDone = await profile.runtime.state(y.workId);
    assert.equal((await readGeneratedAnswer(profile.services, yDone))!.text, correction);
    assert.equal(yDone.generatedAnswer!.input.input.messageId, 'Y-reply');
    const saved = JSON.parse(new TextDecoder().decode(await profile.services.artifacts.get(yDone.generatedAnswer!.inputArtifact, yDone.policy)));
    const actual = AgentTurnInputSchema.parse(saved.turn).packet.session; assert.equal(actual?.schemaVersion, 2);
    if (actual?.schemaVersion !== 2) assert.fail('saved main-turn input did not use the summary');
    assert.deepEqual(actual.summary.ref, first.ref); assert.ok(actual.summary.content.retained.some(item => item.id === retainedCorrection.id));
    assert.ok(actual.entries.some(entry => entry.sourceId === 'Y-reply' && entry.kind === 'command'));
    assert.ok(!actual.entries.some(entry => entry.sourceId === 'Y'));
    assert.equal(yDone.budget.used.modelCalls, 3); assert.equal(yDone.budget.used.toolCalls, 0);
    assert.deepEqual((await profile.runtime.state(x.workId)).budget, xBefore.budget);

    const z = await accept('Z', requests.followup);
    const beforeSecond = await profile.sessions.history(profile.actor, session.scope.sessionId, profile.policy, { limit: 100 });
    const second = await compact(profile, z.workId, 'compact-Z');
    assert.equal(second.previous!.id, first.ref.id); assert.ok(second.ref.throughSequence > first.ref.throughSequence);
    assert.deepEqual(await profile.sessions.history(profile.actor, session.scope.sessionId, profile.policy, { limit: 100 }), beforeSecond);
    assert.ok(second.content.retained.some(item => item.citations.some(citation => citation.role === 'user' && citation.sourceId === 'Y-reply' &&
      citation.quote === requests.followup && citation.sequence > first.ref.throughSequence)), 'the previous command is an exact new source anchor');
    const updatedCorrection = second.content.retained.find(item => item.id === retainedCorrection.id); assert.ok(updatedCorrection);
    assert.ok(updatedCorrection.changedBy && updatedCorrection.changedBy.role === 'assistant' && updatedCorrection.changedBy.quote === correction &&
      updatedCorrection.changedBy.sequence > first.ref.throughSequence);
    assert.equal((await profile.workflow.run(z.workId, profile.executionActor)).control.kind, 'complete');
    const zDone = await profile.runtime.state(z.workId);
    assert.equal((await readGeneratedAnswer(profile.services, zDone))!.text, correction);
    assert.equal(zDone.budget.used.modelCalls, 2); assert.equal(zDone.budget.used.toolCalls, 0);
    assert.deepEqual((await profile.runtime.state(y.workId)).budget, yDone.budget);
  } finally { await profile.close(); rmSync(base, { recursive: true, force: true }); }
});
