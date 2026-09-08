import test from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { compareCollaboration, runCollaborationComparison } from '../application/collaboration-evaluation.js';
import { scoreEvaluation } from '../application/execution-evaluation.js';
import { PEER_TOOL_IDS } from '../application/peer-agents.js';
import { ToolResultSchema } from '../application/contracts.js';
import { peerObject } from './peer-deployment-entry-fixture.js';
import { collaborationProfileTrialFixture, TRIAL_ANSWER, TRIAL_ORIGINAL, TRIAL_QUESTION, TRIAL_SOURCE } from './collaboration-profile-trial-fixture.js';

// One recorded synthetic pair is an integration observation, not a claim that collaboration generally improves quality or cost.
test('actual isolated profiles compare the same ordinary question and preserve complete original participant costs without recounting duplicate ledgers', { timeout: 120000 }, async t => {
  const f = collaborationProfileTrialFixture(t), signal = new AbortController().signal;
  t.diagnostic(`Original profile trial records: ${f.output}`);
  const report = await runCollaborationComparison(f.run, signal);
  f.persist('comparison.json', report);
  const single = f.recorded.get('single'), collaborative = f.recorded.get('collaborative'); assert.ok(single && collaborative);
  const legacySingle = structuredClone(single.trial.primary), legacyCollaborative = structuredClone(collaborative.trial.primary);
  // The old evidence-only oracle must not silently treat an ordinary response goal as a fabricated criterion goal.
  delete legacySingle.case.oracle.response; delete legacyCollaborative.case.oracle.response;
  const legacy = { single: scoreEvaluation(legacySingle), collaborative: scoreEvaluation(legacyCollaborative) };
  f.persist('legacy-evidence-only-scores.json', legacy);
  const left = single.trial.primary.observations.at(-1)!.state, right = collaborative.trial.primary.observations.at(-1)!.state;
  const originals = structuredClone({ single: single.trial, collaborative: collaborative.trial });
  assert.equal(single.exchanges.length, 0); assert.equal(collaborative.exchanges.length, 1);
  assert.equal(single.peer, null); assert.ok(collaborative.peer);
  const participants = [...single.participants, ...collaborative.participants];
  assert.equal(new Set(participants.map(value => value.profile.agentId)).size, 3);
  assert.equal(new Set(participants.map(value => value.root)).size, 3);
  const objects = participants.map(value => { assert.equal(value.profile.stateBackend, 'sqlite'); const stats = statSync(value.statePath); return [stats.dev, stats.ino]; });
  assert.equal(new Set(objects.map(value => JSON.stringify(value))).size, 3);
  assert.notEqual(left.id, right.id); assert.notEqual(left.conversation?.session?.scope.sessionId, right.conversation?.session?.scope.sessionId);
  for (const [recorded, state] of [[single, left], [collaborative, right]] as const) {
    assert.equal(recorded.trial.primary.runError, null); assert.equal(recorded.trial.primary.finalControl, 'complete'); assert.equal(state.status, 'completed');
    assert.equal(state.goal.description, TRIAL_QUESTION); assert.equal(state.goal.mode, 'auto'); assert.deepEqual(state.goal.criteria, []);
    assert.ok(state.goal.responseRequirement); assert.equal(recorded.originalInput?.text, TRIAL_QUESTION); assert.equal(recorded.originalInput?.status, 'applied');
    assert.equal(recorded.answer?.text, TRIAL_ANSWER); assert.deepEqual(state.generatedAnswer?.evidenceIds, [TRIAL_ORIGINAL.id]);
    assert.deepEqual(state.evidence.map(value => ({ id: value.id, sourceId: value.sourceId, lineageId: value.lineageId, observedAt: value.observedAt })), [TRIAL_ORIGINAL]);
    assert.ok(state.evidence.every(value => value.scope === state.goal.scope && value.derivedFrom.length === 0 && value.facts.days === 30));
    const direct = state.attempts.filter(value => value.toolId === TRIAL_SOURCE); assert.equal(direct.length, 1); assert.equal(direct[0]!.adopted, true);
    // Actual committed running snapshots, rather than a fabricated final count, support every charged tool entry.
    for (const attempt of state.attempts) assert.ok(recorded.trial.primary.observations.some(value => value.state.attempts.some(prior => prior.id === attempt.id && prior.status === 'running')));
    const delivered = recorded.finalDeliveries.get(state.id)?.filter(value => value.kind === 'result'); assert.equal(delivered?.length, 1);
    assert.equal(delivered![0]!.status, 'delivered'); assert.deepEqual(delivered![0]!.context?.evidenceIds, [TRIAL_ORIGINAL.id]);
    assert.equal(delivered![0]!.context?.binding.session?.sessionId, state.conversation?.session?.scope.sessionId);
    assert.ok(recorded.trial.primary.observations.some(value => value.deliveries.some(delivery => delivery.kind === 'result' && delivery.status === 'delivered')));
    assert.equal(recorded.trial.participantInventoryComplete, true);
  }
  const exchange = collaborative.exchanges[0]!; assert.ok(exchange.reply); assert.equal(exchange.reply.status, 'answer');
  assert.equal(exchange.request.kind, 'consult'); assert.equal(exchange.request.text, TRIAL_QUESTION);
  const receiver = collaborative.trial.participants.find(value => value.id === exchange.ticket.workId); assert.ok(receiver);
  assert.equal(receiver.status, 'completed'); assert.deepEqual(receiver.evidence, []); assert.equal(receiver.budget.used.modelCalls, 1); assert.equal(receiver.budget.used.toolCalls, 0);
  assert.notEqual(receiver.conversation?.session?.scope.sessionId, right.conversation?.session?.scope.sessionId);
  assert.equal(await collaborative.primary.services.state.get(receiver.id), null); assert.equal(await collaborative.peer.services.state.get(right.id), null);
  const receiverDelivery = collaborative.finalDeliveries.get(receiver.id)?.find(value => value.kind === 'result'); assert.ok(receiverDelivery);
  assert.equal(receiverDelivery.status, 'delivered'); assert.equal(receiverDelivery.context?.binding.channel, 'peer');
  const request = right.attempts.find(value => value.toolId === PEER_TOOL_IDS[0]); assert.ok(request?.resultArtifact);
  const stored = ToolResultSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await collaborative.primary.services.artifacts.get(request.resultArtifact, right.policy))));
  assert.deepEqual(stored.evidence, []); assert.equal(peerObject(stored.output)?.interpretation, 'peer_assessment_not_independent_evidence');
  const source = right.attempts.find(value => value.toolId === TRIAL_SOURCE); assert.ok(source);
  const peerReceipt = await collaborative.primary.services.state.receipt(right.id, `peer-response:${request.id}`), sourceDispatch = await collaborative.primary.services.state.receipt(right.id, `dispatch:${source.id}`);
  assert.ok(peerReceipt && sourceDispatch); assert.ok(sourceDispatch.state.revision > peerReceipt.state.revision);
  for (const participant of participants) {
    const memory = await participant.profile.personalKnowledge(participant.profile.actor);
    const found = await memory.search({ namespace: 'personal', scope: 'personal', kinds: ['personal'], text: '', limit: 10 });
    assert.equal(found.index.status, 'ready'); assert.equal(found.index.complete, true); assert.deepEqual(found.cards, []);
  }
  for (const value of Object.values(legacy)) { assert.equal(value.goalCompleted, false); assert.ok(value.failures.includes('completion_criteria_missing')); }
  assert.equal(report.single.score.contractPassed, true, JSON.stringify(report.single.score.failures));
  assert.equal(report.collaborative.score.contractPassed, true, JSON.stringify(report.collaborative.score.failures));
  assert.equal(report.single.score.goalCompleted, true); assert.equal(report.collaborative.score.goalCompleted, true);
  assert.equal(report.single.participatingWorks, 1); assert.equal(report.collaborative.participatingWorks, 2);
  for (const dimension of ['toolCalls', 'modelCalls', 'tokens', 'replans', 'unmeasuredModelCalls'] as const)
    assert.equal(report.collaborative.usage[dimension], right.budget.used[dimension] + receiver.budget.used[dimension]);
  assert.equal(report.interpretation.addedVerifiedCompletion, false); assert.equal(report.interpretation.comparableCost, true);
  const duplicate = compareCollaboration(single.trial, { ...collaborative.trial, participants: [...collaborative.trial.participants, structuredClone(receiver), structuredClone(right)] });
  assert.deepEqual(duplicate.collaborative.usage, report.collaborative.usage); assert.equal(duplicate.collaborative.participatingWorks, 2);
  const omitted = compareCollaboration(single.trial, { ...collaborative.trial, participants: [right], participantInventoryComplete: false });
  assert.equal(omitted.collaborative.usageComplete, false); assert.equal(omitted.interpretation.comparableCost, false);
  f.persist('inventory-boundary.json', { duplicate, omitted });
  assert.deepEqual({ single: single.trial, collaborative: collaborative.trial }, originals);
  assert.deepEqual(await collaborative.peer.runtime.state(receiver.id), receiver); assert.deepEqual(await collaborative.primary.runtime.state(right.id), right);
});
