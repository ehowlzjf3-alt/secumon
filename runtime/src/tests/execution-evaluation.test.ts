import test from 'node:test';
import assert from 'node:assert/strict';
import type { EvaluationObservation, EvaluationSample } from '../domain/execution-evaluation.js';
import type { Delivery, Evidence, WorkState } from '../domain/model.js';
import { scoreEvaluation, summarizeEvaluations } from '../application/execution-evaluation.js';
import { newWork } from '../application/new-work.js';
import { artifact, attempt, modelCall } from './state-conformance-helpers.js';

const original = (id: string): Evidence => ({ id, tenantId: 'tenant-a', scope: 'fixture', sourceId: `source-${id}`, lineageId: `lineage-${id}`,
  locator: `fixture://${id}`, observedAt: 900, recordedAt: 950, labels: ['synthetic'], coverage: 'complete', status: 'accepted',
  supersedes: [], derivedFrom: [], facts: { days: 30 }, artifact: null });
function state(): WorkState {
  return newWork({ id: 'work', now: 1000, goal: { revision: 1, description: 'Compare two current original records', scope: 'fixture', mode: 'auto',
    criteria: [{ id: 'days', description: 'Verify the current period', key: 'days', operator: 'present', equals: null, minIndependentSources: 2, requireCompleteCoverage: true }] },
  policy: { tenantId: 'tenant-a', principalId: 'person-a', allowedTools: ['fixture.read'], allowedLabels: ['synthetic'], allowedDestinations: ['local'], allowWrites: false },
  limits: { toolCalls: 10, modelCalls: 10, tokens: 10000, replans: 4, wallTimeMs: 10000 } });
}
function delivery(kind: 'ack' | 'result', status: Delivery['status'] = 'delivered'): Delivery {
  return { id: kind, workId: 'work', goalRevision: 1, destination: 'local', kind, text: kind, status, externalId: status === 'delivered' ? `local:${kind}` : null,
    context: { binding: { id: 'binding', channel: 'test', conversationId: 'test', recipientId: 'person-a', destination: 'local', tenantId: 'tenant-a', principalId: 'person-a' },
      labels: ['synthetic'], sourceRevision: 1, responseId: kind === 'result' ? 'result' : null, evidenceIds: kind === 'result' ? ['a', 'b'] : [],
      evidenceDigest: kind === 'result' ? 'fixture-digest' : null, obligationIds: [], artifact: null }, dispatch: null };
}
function observation(value: WorkState, at: number, revision: number, deliveries: Delivery[] = [], eventTypes: string[] = []): EvaluationObservation {
  return { at, stage: `revision-${revision}`, state: { ...structuredClone(value), revision, updatedAt: at }, eventTypes, deliveries: structuredClone(deliveries) };
}
function complete(id = 'complete', answerAt = 1300): EvaluationSample {
  const base = state(); const evidence = { ...structuredClone(base), evidence: [original('a'), original('b')] };
  const done = { ...structuredClone(evidence), status: 'completed' as const, statusReason: 'criteria_verified' };
  return { case: { id, family: 'document_comparison', fixtureId: 'independent-oracle', backend: 'sqlite', mode: 'auto', variant: 'simple',
    oracle: { expectedFinal: 'complete', completionEligible: true, requiredEvidenceIds: ['a', 'b'],
      originals: ['a', 'b'].map(id => ({ id, sourceId: `source-${id}`, lineageId: `lineage-${id}`, observedAt: 900 })),
      facts: { days: 30 }, finalHypothesis: null, forbiddenEvidenceIds: ['stale'], noCompletionBefore: null } },
    observations: [observation(base, 1000, 1), observation(base, 1050, 2, [delivery('ack')]), observation(evidence, 1100, 3, [delivery('ack')]),
      observation(evidence, answerAt, 4, [delivery('ack'), delivery('result')]), observation(done, answerAt + 100, 5, [delivery('ack'), delivery('result')])],
    entries: [], finalControl: 'complete', startedAt: 1000, finishedAt: answerAt + 100, wallElapsedMs: 8, runError: null };
}
function blocked(id = 'blocked'): EvaluationSample {
  const sample = complete(id); sample.case.oracle.expectedFinal = 'blocked'; sample.case.oracle.completionEligible = false;
  sample.case.variant = 'source_missing'; sample.finalControl = 'blocked';
  const base = state(); sample.observations = [observation(base, 1000, 1), observation({ ...base, status: 'blocked', statusReason: 'source_missing' }, 1400, 2, [delivery('ack')])];
  return sample;
}
const failure = (sample: EvaluationSample, fragment: string) => assert.ok(scoreEvaluation(sample).failures.some(value => value.includes(fragment)), JSON.stringify(scoreEvaluation(sample)));

test('evaluation: fixture truth distinguishes acknowledgement, first original, delivered useful answer and verified completion', () => {
  const score = scoreEvaluation(complete()); assert.equal(score.contractPassed, true); assert.equal(score.goalCompleted, true);
  assert.deepEqual(score.falseCompletionRevisions, []);
  assert.deepEqual(score.latency, { ackMs: 50, firstEvidenceMs: 100, firstUsefulAnswerMs: 300, verifiedCompletionMs: 400, simulatedElapsedMs: 400, wallElapsedMs: 8 });
});

test('evaluation: a runtime completed flag cannot replace the fixed expected facts', () => {
  const sample = complete(); for (const item of sample.observations) for (const record of item.state.evidence) record.facts['days'] = 90;
  const score = scoreEvaluation(sample); assert.equal(score.goalCompleted, false); assert.equal(score.contractPassed, false);
  assert.deepEqual(score.falseCompletionRevisions, [4, 5]); assert.equal(score.latency.firstUsefulAnswerMs, null); failure(sample, 'expected_fact_missing:days');
});

test('evaluation: absent expected facts do not count as verified evidence or a useful answer', () => {
  const sample = complete(); for (const item of sample.observations) for (const record of item.state.evidence) delete record.facts['days'];
  const score = scoreEvaluation(sample); assert.equal(score.goalCompleted, false); assert.equal(score.latency.firstEvidenceMs, null); assert.equal(score.latency.firstUsefulAnswerMs, null);
});

test('evaluation: early delivered answers remain false completion even if the final state later becomes correct', () => {
  const sample = complete(); const early = observation(state(), 1070, 3, [delivery('ack'), delivery('result')]);
  sample.observations.splice(2, 0, early); sample.observations.slice(3).forEach(item => { item.state.revision++; });
  const score = scoreEvaluation(sample); assert.equal(score.goalCompleted, true); assert.equal(score.contractPassed, false);
  assert.deepEqual(score.falseCompletionRevisions, [3]); assert.equal(score.latency.firstUsefulAnswerMs, null);
});

test('evaluation: a correct result before a declared late-evidence release fails the fixed timeline oracle', () => {
  const sample = complete(); sample.case.oracle.noCompletionBefore = 1500;
  failure(sample, 'completion_before_release'); assert.equal(scoreEvaluation(sample).latency.firstUsefulAnswerMs, null);
});

for (const [name, mutate] of [
  ['wrong source identity', (record: Evidence) => { record.sourceId = 'different'; }],
  ['wrong lineage identity', (record: Evidence) => { record.lineageId = 'different'; }],
  ['wrong observation time', (record: Evidence) => { record.observedAt = 901; }],
  ['wrong tenant', (record: Evidence) => { record.tenantId = 'other'; }],
  ['wrong scope', (record: Evidence) => { record.scope = 'other'; }],
  ['restricted label', (record: Evidence) => { record.labels = ['restricted']; }],
  ['restricted access', (record: Evidence) => { record.access = 'restricted'; }],
  ['retracted source', (record: Evidence) => { record.status = 'retracted'; }],
  ['copied source', (record: Evidence) => { record.derivedFrom = ['a']; }],
  ['partial coverage', (record: Evidence) => { record.coverage = 'partial'; }],
] as const) test(`evaluation: ${name} cannot satisfy an original named by the fixture oracle`, () => {
  const sample = complete(); for (const item of sample.observations) if (item.state.evidence[1]) mutate(item.state.evidence[1]);
  const score = scoreEvaluation(sample); assert.equal(score.goalCompleted, false); assert.equal(score.contractPassed, false); assert.equal(score.latency.firstUsefulAnswerMs, null);
});

test('evaluation: two required records from one lineage cannot satisfy a two-source criterion even with matching facts', () => {
  const sample = complete(); sample.case.oracle.originals[1]!.lineageId = 'lineage-a';
  for (const item of sample.observations) if (item.state.evidence[1]) item.state.evidence[1].lineageId = 'lineage-a';
  failure(sample, 'independent_sources_missing');
});

test('evaluation: duplicate source IDs, current forbidden evidence and unresolved counterevidence fail independently', () => {
  for (const kind of ['duplicate', 'forbidden', 'counter']) {
    const sample = complete(); for (const item of sample.observations.filter(value => value.state.evidence.length)) {
      const record = original(kind === 'duplicate' ? 'a' : kind === 'forbidden' ? 'stale' : 'counter');
      if (kind === 'counter') record.facts['days'] = 90; item.state.evidence.push(record);
    }
    assert.equal(scoreEvaluation(sample).goalCompleted, false); assert.equal(scoreEvaluation(sample).contractPassed, false);
  }
});

test('evaluation: a pinned replacement must remain readable, accepted, original and complete without resurrecting its withdrawn predecessor', () => {
  for (const kind of ['access', 'label', 'retracted', 'copied', 'partial']) {
    const sample = complete();
    sample.case.oracle.requiredEvidenceIds.push('replacement');
    sample.case.oracle.originals.push({ id: 'replacement', sourceId: 'source-counter', lineageId: 'lineage-counter', observedAt: 900 });
    for (const item of sample.observations.filter(value => value.state.evidence.length)) {
      const counter = original('counter'); counter.facts['days'] = 90;
      const replacement = { ...original('replacement'), sourceId: counter.sourceId, lineageId: counter.lineageId, supersedes: [counter.id] };
      if (kind === 'access') replacement.access = 'restricted';
      if (kind === 'label') replacement.labels = ['restricted'];
      if (kind === 'retracted') replacement.status = 'retracted';
      if (kind === 'copied') replacement.derivedFrom = ['a'];
      if (kind === 'partial') replacement.coverage = 'partial';
      item.state.evidence.push(counter, replacement);
    }
    const score = scoreEvaluation(sample);
    failure(sample, kind === 'partial' ? 'original_coverage_incomplete:replacement' : 'required_original_missing:replacement');
    assert.equal(score.goalCompleted, false, kind);
    assert.ok(!score.failures.some(value => value.includes('counterevidence_unresolved')), 'Withdrawn predecessors must not become current again');
  }
});

test('evaluation: hypothesis status and current original support are checked against the pinned final hypothesis', () => {
  const sample = complete(); sample.case.oracle.finalHypothesis = { id: 'period', status: 'refuted' };
  failure(sample, 'final_hypothesis_incorrect');
  for (const item of sample.observations.filter(value => value.state.evidence.length)) {
    item.state.hypotheses = [{ id: 'period', question: 'Which period?', claim: '90 days', predictedObservation: '90', falsifier: '30', status: 'refuted', supportIds: [], counterIds: ['a'], reason: 'Both originals say 30' }];
    item.state.hypothesisAssessment = { goalRevision: 1, evidenceIds: ['a', 'b'] };
  }
  assert.equal(scoreEvaluation(sample).contractPassed, true);
  sample.observations.at(-1)!.state.hypothesisAssessment!.evidenceIds = ['a']; failure(sample, 'hypotheses_not_current');
});

test('evaluation: answer delivery requires authorized routing and explicit required evidence references', () => {
  for (const kind of ['recipient', 'destination', 'missing-reference', 'forbidden-reference']) {
    const sample = complete(); for (const item of sample.observations) for (const value of item.deliveries.filter(value => value.kind === 'result')) {
      if (kind === 'recipient') value.context!.binding.recipientId = 'other';
      if (kind === 'destination') value.destination = 'external';
      if (kind === 'missing-reference') value.context!.evidenceIds = ['a'];
      if (kind === 'forbidden-reference') value.context!.evidenceIds.push('stale');
    }
    failure(sample, 'result_delivery_proof_invalid'); assert.equal(scoreEvaluation(sample).latency.firstUsefulAnswerMs, null);
  }
});

test('evaluation: waiting with an unknown delivery reports no useful answer latency and preserves its delivery obligation', () => {
  const sample = complete(); sample.case.variant = 'unknown_delivery'; sample.case.oracle.expectedFinal = 'wait'; sample.finalControl = 'wait';
  for (const item of sample.observations) for (const value of item.deliveries) if (value.kind === 'result') value.status = 'unknown';
  const final = sample.observations.at(-1)!; final.state.status = 'waiting'; final.state.statusReason = 'result_delivery_pending';
  final.state.obligations.push({ id: 'delivery', kind: 'delivery', status: 'pending', reason: 'receipt unknown', wakeKey: 'delivery', dueAt: 11000 });
  const score = scoreEvaluation(sample); assert.equal(score.contractPassed, true); assert.equal(score.goalCompleted, false);
  assert.equal(score.latency.firstUsefulAnswerMs, null); assert.equal(score.latency.verifiedCompletionMs, null);
});

test('evaluation: run errors and mismatched final control remain failures even for an expected blocked case', () => {
  const sample = blocked(); assert.equal(scoreEvaluation(sample).contractPassed, true);
  sample.runError = 'source_permission_error'; failure(sample, 'run_error:source_permission_error');
  sample.runError = null; sample.finalControl = 'wait'; failure(sample, 'unexpected_final_control');
});

test('evaluation: completed states with pending obligations or an undelivered required response are false completion', () => {
  const sample = complete(); const final = sample.observations.at(-1)!.state;
  final.obligations.push({ id: 'reply', kind: 'evidence', status: 'pending', reason: 'Wait for reply', wakeKey: 'reply', dueAt: null });
  failure(sample, 'completion_obligation_pending');
  final.obligations = []; final.conversation = { bindings: [delivery('result').context!.binding], primaryBindingId: 'binding', completionRequiresDelivery: true, result: null };
  sample.observations.at(-1)!.deliveries = [delivery('ack')]; failure(sample, 'completed_without_delivery_proof');
});

test('evaluation: status-only observation of an existing completed work is not a new completion or answer', () => {
  const sample = complete(); sample.case.oracle.expectedFinal = 'unchanged'; sample.case.variant = 'status_only';
  const snapshot = sample.observations.at(-1)!; sample.observations = [snapshot, structuredClone(snapshot)];
  const score = scoreEvaluation(sample); assert.equal(score.contractPassed, true); assert.equal(score.goalCompleted, false); assert.deepEqual(score.falseCompletionRevisions, []);
  assert.equal(score.latency.firstUsefulAnswerMs, null); assert.equal(score.latency.verifiedCompletionMs, null);
  sample.entries.push({ kind: 'lookup', at: 1400, id: 'result', sourceKey: null }); failure(sample, 'status_only_mutated_or_invoked');
  sample.entries = []; sample.observations[1]!.state.revision++; failure(sample, 'status_only_mutated_or_invoked');
});

test('evaluation: cumulative costs cannot disappear and unknown model usage cannot become fabricated zero after resume', () => {
  const sample = blocked(); const pending = observation(state(), 1200, 2); const call = modelCall('unknown'); call.usageStatus = 'unknown'; call.inputTokens = 7; call.outputTokens = null;
  pending.state.modelCalls = [call]; pending.state.budget.used.modelCalls = 1; pending.state.budget.used.tokens = 7;
  pending.state.budget.used.unmeasuredModelCalls = 1; pending.state.budget.reservedTokens = call.tokenReservation;
  const final = observation(pending.state, 1400, 3); final.state.status = 'blocked'; final.state.statusReason = 'model_usage_unknown';
  sample.observations = [sample.observations[0]!, pending, final]; assert.equal(scoreEvaluation(sample).contractPassed, true);
  final.state.budget.used.tokens = 0; failure(sample, 'budget_used_decreased:tokens');
  final.state.budget.used.tokens = 7; final.state.budget.used.unmeasuredModelCalls = 0; final.state.budget.reservedTokens = 0;
  final.state.modelCalls[0]!.usageStatus = 'not_called'; failure(sample, 'unknown_usage_erased');
});

test('evaluation: a real late usage report may resolve unknown reservations while preserving known and additional charges', () => {
  const sample = blocked(); const prior = observation(state(), 1200, 2); const call = modelCall('unknown'); call.usageStatus = 'unknown';
  prior.state.modelCalls = [call]; prior.state.budget.used.modelCalls = 1; prior.state.budget.used.unmeasuredModelCalls = 1; prior.state.budget.reservedTokens = call.tokenReservation;
  const final = observation(prior.state, 1400, 3); final.state.status = 'blocked'; final.state.statusReason = 'stopped';
  Object.assign(final.state.modelCalls[0]!, { status: 'rejected', usageStatus: 'reported', inputTokens: 8, outputTokens: 2, replyArtifact: artifact() });
  final.state.budget.used.tokens = 10; final.state.budget.used.unmeasuredModelCalls = 0; final.state.budget.reservedTokens = 0;
  sample.observations = [sample.observations[0]!, prior, final]; assert.equal(scoreEvaluation(sample).contractPassed, true);
  final.state.deadlineAt++; failure(sample, 'deadline_extended');
});

test('evaluation: a gate failure before dispatch costs zero, while a dispatched call denied before invocation remains charged', () => {
  for (const dispatched of [false, true]) {
    const sample = blocked(); const reserved = observation(state(), 1100, 2, [], ['attempt_reserved']);
    reserved.state.attempts = [attempt('reserved')]; reserved.state.budget.reservedToolCalls = 1;
    const running = observation(reserved.state, 1200, 3, [], ['attempt_dispatched']);
    running.state.attempts[0]!.status = 'running'; running.state.budget.reservedToolCalls = 0; running.state.budget.used.toolCalls = 1;
    const failed = observation(dispatched ? running.state : reserved.state, 1400, dispatched ? 4 : 3, [], ['execution_gate_rejected']);
    const finalAttempt = failed.state.attempts[0]!; finalAttempt.status = 'failed'; finalAttempt.error = { code: 'tool_permission_denied', retryable: false };
    finalAttempt.execution = { mode: 'not_invoked', implementationCalls: 0, usage: { transportCalls: 0, internalOperations: 0, imageBytes: 0, waitMs: 0 } };
    failed.state.budget.reservedToolCalls = 0; failed.state.status = 'blocked'; failed.state.statusReason = 'tool_permission_denied';
    sample.observations = [sample.observations[0]!, reserved, ...(dispatched ? [running] : []), failed];
    const score = scoreEvaluation(sample); assert.equal(score.contractPassed, true, JSON.stringify(score)); assert.equal(score.usage.used.toolCalls, dispatched ? 1 : 0);
    if (dispatched) { failed.state.budget.used.toolCalls = 0; failure(sample, 'usage_ledger_mismatch'); }
    else { failed.state.budget.used.toolCalls = 1; failure(sample, 'usage_ledger_mismatch'); }
  }
});

test('evaluation: observations and source queries can repeat without duplicating intervention or context accounting', () => {
  const sample = blocked(); const middle = observation(state(), 1100, 2, [], ['user_command']);
  middle.state.executionControl!.strategy = 'investigate';
  sample.observations = [sample.observations[0]!, middle, structuredClone(middle), { ...sample.observations[1]!, state: { ...sample.observations[1]!.state, revision: 3, executionControl: middle.state.executionControl } }];
  sample.entries = [
    { kind: 'tool', id: 'one', at: 1100, sourceKey: 'source:1' }, { kind: 'tool', id: 'two', at: 1200, sourceKey: 'source:1' },
    { kind: 'tool', id: 'three', at: 1300, sourceKey: 'source:2' }, { kind: 'model', id: 'model', at: 1350, sourceKey: null },
    { kind: 'send', id: 'ack', at: 1050, sourceKey: null }, { kind: 'lookup', id: 'ack', at: 1400, sourceKey: null },
  ];
  const score = scoreEvaluation(sample); assert.equal(score.interventions, 1); assert.equal(score.promotions, 1);
  assert.deepEqual(score.calls, { modelEntries: 1, toolEntries: 3, sends: 1, lookups: 1, uniqueQueries: 2, repeatedQueries: 1, adoptedTools: 0, reusedTools: 0 });
  sample.observations[2]!.state.statusReason = 'changed without a commit'; failure(sample, 'same_revision_changed');
});

test('evaluation: context cost comes from unique persisted model calls and remains distinct from reported token usage', () => {
  const sample = blocked(); const middle = observation(state(), 1200, 2); const call = modelCall('accepted');
  Object.assign(call, { inputTokens: 80, outputTokens: 20, usageStatus: 'reported', replyArtifact: artifact(), finishedAt: 1200,
    contextMetrics: { baselinePacketBytes: 3000, baselineToolBytes: 1000, packetBytes: 1700, toolBytes: 100, envelopeBytes: 200,
      requestBytes: 2000, estimatedTokens: 600, estimateMethod: 'synthetic', outputTokenReservation: 10, sourceReads: 3, extraModelCalls: 0, evictions: 2, reloads: 1 } });
  middle.state.modelCalls = [call]; middle.state.budget.used.modelCalls = 1; middle.state.budget.used.tokens = 100;
  const final = observation(middle.state, 1400, 3); final.state.status = 'blocked'; final.state.statusReason = 'source_missing';
  sample.observations = [sample.observations[0]!, middle, structuredClone(middle), final];
  const score = scoreEvaluation(sample); assert.equal(score.contractPassed, true); assert.equal(score.usage.used.tokens, 100);
  assert.deepEqual(score.context, { requestBytes: 2000, estimatedTokens: 600, sourceReads: 3, evictions: 2, reloads: 1 });
  assert.deepEqual(summarizeEvaluations([sample]).overall.context, score.context);
});

test('evaluation summary: contract success, all-case completion and eligible completion use different explicit denominators', () => {
  const one = complete('one'); const two = blocked('two'); const three = blocked('three'); three.case.oracle.completionEligible = true;
  const result = summarizeEvaluations([one, two, three]);
  assert.deepEqual(result.overall.contract, { numerator: 3, denominator: 3, rate: 1 });
  assert.deepEqual(result.overall.completionAll, { numerator: 1, denominator: 3, rate: 1 / 3 });
  assert.deepEqual(result.overall.completionEligible, { numerator: 1, denominator: 2, rate: 0.5 });
  assert.equal(result.overall.excludedFromEligible, 1); assert.equal(result.overall.incomplete, 2); assert.equal(result.cohorts.length, 2);
  assert.deepEqual(result.overall.latency.firstUsefulAnswerMs, { n: 1, p50: 300, p95: 300 });
});

test('evaluation summary: nearest-rank p50/p95 include answer samples only and report the sample count', () => {
  const samples = [1, 2, 3, 4].map((value, index) => complete(`answer-${index}`, 1100 + value * 100)); samples.push(blocked('no-answer'));
  const result = summarizeEvaluations(samples);
  assert.equal(result.quantiles, 'nearest_rank'); assert.deepEqual(result.overall.latency.firstUsefulAnswerMs, { n: 4, p50: 300, p95: 500 });
  const empty = summarizeEvaluations([]); assert.deepEqual(empty.overall.completionEligible, { numerator: 0, denominator: 0, rate: null });
  assert.deepEqual(empty.overall.latency.firstUsefulAnswerMs, { n: 0, p50: null, p95: null }); assert.deepEqual(JSON.parse(JSON.stringify(empty)), empty);
});

test('evaluation summary: supplied scores join by case ID and cannot silently replace missing or duplicate cases', () => {
  const samples = [complete('one'), blocked('two')]; const scores = samples.map(scoreEvaluation).reverse();
  assert.deepEqual(summarizeEvaluations(samples, scores), summarizeEvaluations(samples));
  assert.throws(() => summarizeEvaluations(samples, [scores[0]!, scores[0]!]), /evaluation_scores_mismatch/);
  assert.throws(() => summarizeEvaluations([samples[0]!, samples[0]!]), /duplicate_evaluation_case/);
  assert.throws(() => scoreEvaluation({ ...samples[0]!, observations: [] }), /evaluation_observations_missing/);
});
