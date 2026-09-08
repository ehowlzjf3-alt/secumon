import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { EvaluationSample } from '../domain/execution-evaluation.js';
import type { ArtifactRef } from '../domain/model.js';
import { scoreEvaluation } from '../application/execution-evaluation.js';
import { artifact, initial, modelCall } from './state-conformance-helpers.js';

const text = '회의는 오후 세 시에 시작합니다.';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const original = (): ArtifactRef => ({ ...artifact(), id: 'answer-original', mediaType: 'text/plain', sha256: hash(text), byteLength: Buffer.byteLength(text) });

// Recorded oracle samples only; actual intake, model/tool dispatch and delivery are covered by the independent-profile trial.
function sample(): EvaluationSample {
  const state = initial('response-work'), ref = original();
  state.goal.criteria = []; state.goal.responseRequirement = { version: 1, requestMessageId: 'request', requestTextDigest: hash('request'), format: 'text' };
  state.status = 'completed'; state.statusReason = 'criteria_verified'; state.revision = 2; state.updatedAt = 1100;
  const input = { scope: { tenantId: state.policy.tenantId, principalId: state.policy.principalId, agentId: 'response-agent', sessionId: 'response-session' },
    input: { messageId: 'request', sequence: 1, digest: hash('applied-request') } };
  const binding = { id: 'binding', tenantId: state.policy.tenantId, principalId: state.policy.principalId, channel: 'test' as const,
    conversationId: 'conversation', recipientId: state.policy.principalId, destination: 'local', session: input.scope };
  state.conversation = { bindings: [binding], primaryBindingId: binding.id, completionRequiresDelivery: true, result: null, session: input, sessionReviewRequired: false };
  const call = { ...modelCall('accepted'), purpose: 'agent_turn' as const, semanticVersion: 4 as const, agentTurnPromptDigest: hash('prompt'),
    replyArtifact: { ...artifact(), id: 'reply' }, inputTokens: 1, outputTokens: 2, usageStatus: 'reported' as const,
    finishedAt: 1050, outcome: 'ok' as const, reason: 'agent_answer_stored' };
  state.modelCalls = [call]; state.budget.used.modelCalls = 1; state.budget.used.tokens = 3;
  state.generatedAnswer = { id: 'answer', callId: call.id, goalRevision: 1, planRevision: 0, dataGeneration: 0, input,
    inputArtifact: call.inputArtifact, promptDigest: call.agentTurnPromptDigest, basisDigest: hash('basis'), artifact: ref,
    evidenceIds: [], observedEvidenceIds: [], assessment: { type: 'model_self_review', verdict: 'satisfied', rationale: 'Fixture claim only.', missing: [], counterarguments: [] }, createdAt: 1060 };
  return { case: { id: 'response-oracle', family: 'document_comparison', fixtureId: 'fixed-response', backend: 'recorded', mode: 'auto', variant: 'simple',
    oracle: { expectedFinal: 'complete', completionEligible: true, requiredEvidenceIds: [], originals: [], facts: {}, finalHypothesis: null,
      forbiddenEvidenceIds: [], noCompletionBefore: null, response: { kind: 'exact_text', text, sha256: hash(text) } } },
    observations: [{ at: 1100, stage: 'recorded-response', state, eventTypes: [], response: { artifact: structuredClone(ref), text },
      deliveries: [{ id: 'result', workId: state.id, goalRevision: 1, destination: 'local', kind: 'result', text, status: 'delivered', externalId: 'local-result', dispatch: null,
        context: { binding, labels: ['synthetic'], sourceRevision: 1, dataGeneration: 0, responseId: 'result', evidenceIds: [], evidenceDigest: hash('evidence'),
          generatedAnswerDigest: hash('answer'), obligationIds: [], artifact: ref } }] }],
    entries: [], finalControl: 'complete', startedAt: 1000, finishedAt: 1100, wallElapsedMs: 5, runError: null };
}
const final = (value: EvaluationSample) => value.observations.at(-1)!;
const rejected = (value: EvaluationSample) => { const score = scoreEvaluation(value); assert.equal(score.contractPassed, false, JSON.stringify(score)); assert.equal(score.goalCompleted, false); };

test('response oracle: explicit fixed original text supports a generic response; the legacy evidence-only oracle remains strict', () => {
  const value = sample(), before = structuredClone(value), score = scoreEvaluation(value);
  assert.equal(score.contractPassed, true, JSON.stringify(score)); assert.equal(score.goalCompleted, true);
  assert.equal(score.latency.firstEvidenceMs, null); assert.equal(score.latency.firstUsefulAnswerMs, 100);
  assert.deepEqual(value, before);
  const legacy = structuredClone(value); delete legacy.case.oracle.response; rejected(legacy);
  assert.ok(scoreEvaluation(legacy).failures.some(failure => failure.includes('completion_criteria_missing')));
});

test('response oracle: completion and self-review cannot substitute for the captured original answer and fixed text/hash', () => {
  for (const change of [
    (value: EvaluationSample) => { delete final(value).response; },
    (value: EvaluationSample) => { final(value).response!.text = '다른 답변'; },
    (value: EvaluationSample) => { final(value).response!.artifact.sha256 = '0'.repeat(64); },
    (value: EvaluationSample) => { value.case.oracle.response!.sha256 = '0'.repeat(64); },
    (value: EvaluationSample) => { final(value).state.generatedAnswer!.assessment.verdict = 'needs_work'; },
    (value: EvaluationSample) => { final(value).state.generatedAnswer!.assessment.missing.push('unresolved requirement'); },
  ]) { const value = sample(); change(value); rejected(value); }
});

test('response oracle: wrong goal, caller input, unsettled call and revoked original cannot qualify as the current answer', () => {
  for (const change of [
    (value: EvaluationSample) => { delete final(value).state.goal.responseRequirement; },
    (value: EvaluationSample) => { final(value).state.generatedAnswer!.goalRevision++; },
    (value: EvaluationSample) => { final(value).state.generatedAnswer!.input = { ...final(value).state.generatedAnswer!.input,
      scope: { ...final(value).state.generatedAnswer!.input.scope, principalId: 'another-user' } }; },
    (value: EvaluationSample) => { final(value).state.modelCalls[0]!.status = 'received'; },
    (value: EvaluationSample) => { final(value).state.policy.allowedLabels = []; },
    (value: EvaluationSample) => { final(value).state.generatedAnswer!.dataGeneration++; },
    (value: EvaluationSample) => { final(value).state.generatedAnswer!.observedEvidenceIds = ['unobserved']; },
    (value: EvaluationSample) => { final(value).state.conversation!.sessionReviewRequired = true; },
  ]) { const value = sample(); change(value); rejected(value); }
});

test('response oracle: delivered content, recipient and source artifact must match the original answer', () => {
  for (const change of [
    (value: EvaluationSample) => { final(value).deliveries[0]!.text = '다른 사람의 결과'; },
    (value: EvaluationSample) => { final(value).deliveries[0]!.context!.binding.recipientId = 'another-user'; },
    (value: EvaluationSample) => { final(value).deliveries[0]!.context!.artifact = { ...original(), id: 'unrelated-original' }; },
    (value: EvaluationSample) => { final(value).deliveries = []; },
  ]) { const value = sample(); change(value); rejected(value); }
});

test('response oracle: an expected answer does not replace required independent facts or clear counterevidence', () => {
  const value = sample(), record = { id: 'source', tenantId: 'tenant-a', scope: 'fixture', sourceId: 'record-source', lineageId: 'record-lineage',
    locator: 'fixture://original', observedAt: 900, recordedAt: 950, labels: ['synthetic'], coverage: 'complete' as const, status: 'accepted' as const,
    supersedes: [], derivedFrom: [], facts: { days: 30 }, artifact: null };
  value.case.oracle.requiredEvidenceIds = ['source']; value.case.oracle.originals = [{ id: record.id, sourceId: record.sourceId, lineageId: record.lineageId, observedAt: 900 }];
  value.case.oracle.facts = { days: 30 }; final(value).state.evidence = [record];
  final(value).state.generatedAnswer!.evidenceIds = ['source']; final(value).state.generatedAnswer!.observedEvidenceIds = ['source'];
  final(value).deliveries[0]!.context!.evidenceIds = ['source'];
  assert.equal(scoreEvaluation(value).contractPassed, true, JSON.stringify(scoreEvaluation(value)));
  const absent = structuredClone(value); final(absent).state.evidence = []; rejected(absent);
  const contrary = structuredClone(value); final(contrary).state.evidence[0]!.facts['days'] = 90; rejected(contrary);
  const uncited = structuredClone(value); final(uncited).state.generatedAnswer!.evidenceIds = []; rejected(uncited);
});

test('response oracle: changing the captured answer at the same revision is visible even when the last answer is correct', () => {
  const value = sample(), wrong = structuredClone(final(value)); wrong.response!.text = 'earlier wrong original';
  value.observations.unshift(wrong); const score = scoreEvaluation(value);
  assert.equal(score.goalCompleted, true); assert.equal(score.contractPassed, false);
  assert.ok(score.failures.includes('same_revision_changed'), JSON.stringify(score));
});

test('response oracle: readable derived citations are allowed without replacing independent original requirements', () => {
  const value = sample(), state = final(value).state;
  const source = { id: 'original', tenantId: 'tenant-a', scope: 'fixture', sourceId: 'record', lineageId: 'record', locator: 'fixture://record',
    observedAt: 900, recordedAt: 950, labels: ['synthetic'], coverage: 'complete' as const, status: 'accepted' as const,
    supersedes: [], derivedFrom: [] as string[], facts: { days: 30 }, artifact: null };
  state.evidence = [source, { ...source, id: 'derived', sourceId: 'derived', derivedFrom: ['original'] }];
  state.generatedAnswer!.evidenceIds = ['original', 'derived']; state.generatedAnswer!.observedEvidenceIds = ['original', 'derived'];
  final(value).deliveries[0]!.context!.evidenceIds = ['original', 'derived'];
  value.case.oracle.requiredEvidenceIds = ['original']; value.case.oracle.facts = { days: 30 };
  value.case.oracle.originals = [{ id: 'original', sourceId: 'record', lineageId: 'record', observedAt: 900 }];
  assert.equal(scoreEvaluation(value).contractPassed, true, JSON.stringify(scoreEvaluation(value)));
  for (const change of [
    (v: EvaluationSample) => { final(v).state.evidence[0]!.status = 'retracted'; },
    (v: EvaluationSample) => { final(v).state.evidence[1]!.derivedFrom = ['missing']; },
    (v: EvaluationSample) => { final(v).state.evidence[1]!.derivedFrom = ['derived']; },
    (v: EvaluationSample) => { final(v).state.evidence.push(structuredClone(final(v).state.evidence[1]!)); },
    (v: EvaluationSample) => { final(v).state.evidence[1]!.labels = ['private']; },
    (v: EvaluationSample) => { v.case.oracle.requiredEvidenceIds = ['derived']; },
  ]) { const changed = structuredClone(value); change(changed); rejected(changed); }
});

test('response oracle: correct answer text cannot hide an unfinished plan or unreviewed notification', () => {
  const planned = sample(); final(planned).state.plan = { revision: 0, goalRevision: 1, reason: 'Required outstanding task', tasks: [
    { id: 'pending', toolId: 'fixture.read', toolVersion: '1', effect: 'read', description: 'Required source', input: {}, dependsOn: [], satisfies: [], maxAttempts: 1 },
  ] }; rejected(planned);
  const notified = sample(); final(notified).state.notifications = [{ id: 'unread', subscriptionId: 'subscription', provider: 'mission',
    resourceId: 'source', referenceId: 'event', goalRevision: 1, observedPlanRevision: 0, receivedAt: 1090 }]; rejected(notified);
});
