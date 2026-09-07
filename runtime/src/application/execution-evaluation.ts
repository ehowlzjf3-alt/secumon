import type { EvaluationCase, EvaluationObservation, EvaluationSample, EvaluationScore } from '../domain/execution-evaluation.js';
import type { Delivery, Evidence, WorkState } from '../domain/model.js';

const dimensions = ['toolCalls', 'modelCalls', 'tokens', 'replans'] as const;
const knownNumber = (value: number) => Number.isSafeInteger(value) && value >= 0;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function readableOriginals(state: WorkState): Evidence[] {
  const counts = new Map<string, number>();
  for (const record of state.evidence) counts.set(record.id, (counts.get(record.id) ?? 0) + 1);
  const permitted = (value: { tenantId: string; labels: string[] }) => value.tenantId === state.policy.tenantId && value.labels.every(label => state.policy.allowedLabels.includes(label));
  const readable = (record: Evidence) => counts.get(record.id) === 1 && record.status === 'accepted' && (record.access ?? 'available') === 'available' &&
    record.derivedFrom.length === 0 && record.scope === state.goal.scope && permitted(record) &&
    (!record.artifact || permitted(record.artifact) && !state.dataLifecycle?.blockedArtifactIds.includes(record.artifact.id));
  const superseded = new Set<string>();
  for (const replacement of state.evidence) for (const id of replacement.supersedes) {
    const prior = state.evidence.find(value => value.id === id);
    // Supersession is a monotone withdrawal: a later loss of access to the amendment does not make its old source current again.
    if (prior && counts.get(id) === 1 && counts.get(replacement.id) === 1 && prior.id !== replacement.id &&
      prior.tenantId === replacement.tenantId && prior.scope === replacement.scope && prior.sourceId === replacement.sourceId &&
      prior.lineageId === replacement.lineageId && prior.observedAt <= replacement.observedAt &&
      prior.observedAt <= prior.recordedAt && replacement.observedAt <= replacement.recordedAt) superseded.add(id);
  }
  return state.evidence.filter(record => !superseded.has(record.id) && readable(record));
}

function firstVerifiedOriginal(observation: EvaluationObservation, oracle: EvaluationCase['oracle']): boolean {
  return readableOriginals(observation.state).some(record => {
    const expected = oracle.originals.find(value => value.id === record.id);
    return oracle.requiredEvidenceIds.includes(record.id) && expected && record.sourceId === expected.sourceId && record.lineageId === expected.lineageId &&
      record.observedAt === expected.observedAt && record.observedAt <= record.recordedAt && record.recordedAt <= observation.at && record.coverage === 'complete' &&
      Object.entries(oracle.facts).some(([key, value]) => Object.hasOwn(record.facts, key) && record.facts[key] === value);
  });
}

/** Fixture truth is checked independently of the runtime's completion implementation. */
function oracleFailures(observation: EvaluationObservation, oracle: EvaluationCase['oracle'], delivery: Delivery | null): string[] {
  const { state, at } = observation; const failures: string[] = [];
  const originals = readableOriginals(state); const selected = originals.filter(record => oracle.requiredEvidenceIds.includes(record.id));
  if (!oracle.requiredEvidenceIds.length || !Object.keys(oracle.facts).length) failures.push('oracle_has_no_completion_evidence');
  if (!oracle.completionEligible) failures.push('completion_not_eligible');
  if (oracle.noCompletionBefore !== null && at < oracle.noCompletionBefore) failures.push('completion_before_release');
  for (const id of oracle.requiredEvidenceIds) {
    const expected = oracle.originals.find(record => record.id === id); const actual = selected.find(record => record.id === id);
    if (!actual) failures.push(`required_original_missing:${id}`);
    else if (!expected || actual.sourceId !== expected.sourceId || actual.lineageId !== expected.lineageId || actual.observedAt !== expected.observedAt)
      failures.push(`original_identity_changed:${id}`);
    else if (actual.coverage !== 'complete') failures.push(`original_coverage_incomplete:${id}`);
    else if (actual.observedAt > actual.recordedAt || actual.recordedAt > at) failures.push(`original_time_invalid:${id}`);
  }
  for (const id of oracle.forbiddenEvidenceIds) if (originals.some(record => record.id === id)) failures.push(`forbidden_original_current:${id}`);
  for (const [key, expected] of Object.entries(oracle.facts)) {
    if (!selected.some(record => Object.hasOwn(record.facts, key) && record.facts[key] === expected)) failures.push(`expected_fact_missing:${key}`);
    if (originals.some(record => Object.hasOwn(record.facts, key) && record.facts[key] !== expected)) failures.push(`counterevidence_unresolved:${key}`);
  }
  if (!state.goal.criteria.length) failures.push('completion_criteria_missing');
  for (const criterion of state.goal.criteria) {
    const matching = originals.filter(record => Object.hasOwn(record.facts, criterion.key) &&
      (criterion.operator === 'present' || record.facts[criterion.key] === criterion.equals) && (!criterion.requireCompleteCoverage || record.coverage === 'complete'));
    if (new Set(matching.map(record => record.lineageId)).size < criterion.minIndependentSources) failures.push(`independent_sources_missing:${criterion.id}`);
  }
  if (oracle.finalHypothesis) {
    const hypothesis = state.hypotheses.find(value => value.id === oracle.finalHypothesis!.id);
    if (!hypothesis || hypothesis.status !== oracle.finalHypothesis.status) failures.push('final_hypothesis_incorrect');
    else if ([...hypothesis.supportIds, ...hypothesis.counterIds].some(id => !originals.some(record => record.id === id)) ||
      hypothesis.status === 'supported' && (!hypothesis.supportIds.length || hypothesis.counterIds.length > 0) ||
      hypothesis.status === 'refuted' && !hypothesis.counterIds.length) failures.push('final_hypothesis_without_original');
  }
  if (state.hypotheses.length) {
    const assessment = state.hypothesisAssessment;
    const currentIds = originals.map(record => record.id).sort();
    if (!assessment || assessment.goalRevision !== state.goal.revision || !same([...assessment.evidenceIds].sort(), currentIds)) failures.push('hypotheses_not_current');
  }
  if (state.obligations.some(value => value.status === 'pending' && (delivery === null || value.kind !== 'delivery'))) failures.push('completion_obligation_pending');
  if (state.attempts.some(value => ['reserved', 'running', 'received'].includes(value.status)) ||
    state.modelCalls.some(value => ['reserved', 'running', 'received'].includes(value.status))) failures.push('completion_operation_pending');
  if (delivery === null && state.conversation?.completionRequiresDelivery && !observation.deliveries.some(value =>
    value.kind === 'result' && value.status === 'delivered' && oracleFailures(observation, oracle, value).length === 0)) failures.push('completed_without_delivery_proof');
  if (delivery) {
    const context = delivery.context; const binding = context?.binding;
    if (delivery.workId !== state.id || delivery.goalRevision !== state.goal.revision || !state.policy.allowedDestinations.includes(delivery.destination) ||
      !context || !binding || binding.tenantId !== state.policy.tenantId || binding.principalId !== state.policy.principalId ||
      binding.recipientId !== state.policy.principalId || binding.destination !== delivery.destination ||
      context.labels.some(label => !state.policy.allowedLabels.includes(label)) || context.sourceRevision > state.revision ||
      context.responseId !== delivery.id || oracle.requiredEvidenceIds.some(id => !context.evidenceIds.includes(id)) ||
      oracle.forbiddenEvidenceIds.some(id => context.evidenceIds.includes(id))) failures.push('result_delivery_proof_invalid');
    if (context?.artifact && (context.artifact.tenantId !== state.policy.tenantId || context.artifact.labels.some(label => !state.policy.allowedLabels.includes(label)) ||
      state.dataLifecycle?.blockedArtifactIds.includes(context.artifact.id))) failures.push('result_delivery_artifact_denied');
  }
  return failures;
}

function budgetFailures(state: WorkState, prior: WorkState | null, observedToolCharges: number): string[] {
  const failures: string[] = []; const budget = state.budget;
  if (dimensions.some(key => !knownNumber(budget.used[key]) || !knownNumber(budget.limits[key])) ||
    !knownNumber(budget.used.unmeasuredModelCalls) || !knownNumber(budget.reservedModelCalls) || !knownNumber(budget.reservedToolCalls) || !knownNumber(budget.reservedTokens)) failures.push('budget_number_invalid');
  if (prior) {
    for (const key of dimensions) if (budget.used[key] < prior.budget.used[key]) failures.push(`budget_used_decreased:${key}`);
    if (state.deadlineAt > prior.deadlineAt) failures.push('deadline_extended');
    for (const call of prior.modelCalls) if (!state.modelCalls.some(value => value.id === call.id)) failures.push('model_usage_history_dropped');
    for (const attempt of prior.attempts) if (!state.attempts.some(value => value.id === attempt.id)) failures.push('tool_usage_history_dropped');
    for (const call of prior.modelCalls.filter(value => value.usageStatus === 'unknown')) {
      const next = state.modelCalls.find(value => value.id === call.id);
      if (next && next.usageStatus !== 'unknown' && !(next.usageStatus === 'reported' && next.inputTokens !== null && next.outputTokens !== null && next.replyArtifact)) failures.push('unknown_usage_erased');
    }
  }
  const reservedModels = state.modelCalls.filter(value => value.status === 'reserved').length;
  const reservedTools = state.attempts.filter(value => value.status === 'reserved').length;
  const reservedTokens = state.modelCalls.filter(value => value.usageStatus === 'reserved' || value.usageStatus === 'unknown').reduce((sum, value) => sum + value.tokenReservation, 0);
  const unknown = state.modelCalls.filter(value => value.usageStatus === 'unknown').length;
  const knownTokens = state.modelCalls.reduce((sum, value) => sum + (value.inputTokens ?? 0) + (value.outputTokens ?? 0), 0);
  const usedModels = state.modelCalls.filter(value => value.status !== 'reserved' && value.usageStatus !== 'not_called').length;
  if (budget.reservedModelCalls !== reservedModels || budget.reservedToolCalls !== reservedTools || budget.reservedTokens !== reservedTokens) failures.push('reservation_ledger_mismatch');
  if (budget.used.unmeasuredModelCalls !== unknown) failures.push('unknown_usage_ledger_mismatch');
  if (budget.used.tokens !== knownTokens || budget.used.modelCalls !== usedModels || budget.used.toolCalls !== observedToolCharges) failures.push('usage_ledger_mismatch');
  return failures;
}

export function scoreEvaluation(sample: EvaluationSample): EvaluationScore {
  if (!sample.observations.length) throw new Error('evaluation_observations_missing');
  const observations = sample.observations; const first = observations[0]!; const last = observations.at(-1)!;
  const unchanged = sample.case.oracle.expectedFinal === 'unchanged';
  const failures = new Set<string>(); const falseRevisions = new Set<number>(); const visitedRevisions = new Map<number, EvaluationObservation>();
  const deliveredResults = new Set<string>(); const queryKeys = new Set<string>();
  // An initial historical snapshot carries prior charges. Later charges require an observed durable dispatch, including invocations subsequently denied by the broker.
  let observedToolCharges = first.state.budget.used.toolCalls;
  const dispatched = new Set(first.state.attempts.filter(attempt => attempt.status !== 'reserved').map(attempt => attempt.id));
  let ackMs: number | null = null; let firstEvidenceMs: number | null = null; let firstUsefulAnswerMs: number | null = null; let verifiedCompletionMs: number | null = null;
  let prior: EvaluationObservation | null = null; let interventions = 0; let promotions = 0;
  if (sample.runError !== null) failures.add(`run_error:${sample.runError}`);
  if (!knownNumber(sample.startedAt) || !knownNumber(sample.finishedAt) || sample.finishedAt < sample.startedAt || !Number.isFinite(sample.wallElapsedMs) || sample.wallElapsedMs < 0) failures.add('evaluation_time_invalid');
  for (const observation of observations) {
    const { state, at } = observation;
    if (!knownNumber(at) || at < sample.startedAt || at > sample.finishedAt || prior && at < prior.at) failures.add('observation_time_invalid');
    if (state.id !== first.state.id || prior && state.revision < prior.state.revision) failures.add('observation_state_identity_invalid');
    const previousRevision = visitedRevisions.get(state.revision);
    if (previousRevision && (!same(previousRevision.state, state) || !same(previousRevision.deliveries, observation.deliveries))) failures.add('same_revision_changed');
    if (!previousRevision) {
      if (observation.eventTypes.includes('user_command')) interventions++;
      if (prior?.state.executionControl?.strategy === 'direct' && state.executionControl?.strategy === 'investigate') promotions++;
      visitedRevisions.set(state.revision, observation);
    }
    for (const attempt of state.attempts) if (attempt.status === 'running' && !dispatched.has(attempt.id)) { dispatched.add(attempt.id); observedToolCharges++; }
    for (const failure of budgetFailures(state, prior?.state ?? null, observedToolCharges)) failures.add(failure);
    if (firstEvidenceMs === null && firstVerifiedOriginal(observation, sample.case.oracle)) firstEvidenceMs = at - sample.startedAt;
    for (const delivery of observation.deliveries) {
      if (delivery.kind === 'ack' && delivery.status === 'delivered' && ackMs === null) ackMs = at - sample.startedAt;
      if (unchanged || delivery.kind !== 'result' || delivery.status !== 'delivered' || deliveredResults.has(delivery.id)) continue;
      deliveredResults.add(delivery.id);
      const invalid = oracleFailures(observation, sample.case.oracle, delivery);
      if (invalid.length) { falseRevisions.add(state.revision); invalid.forEach(failure => failures.add(`false_completion:${failure}`)); }
      else if (firstUsefulAnswerMs === null) firstUsefulAnswerMs = at - sample.startedAt;
    }
    if (!unchanged && state.status === 'completed' && !previousRevision) {
      const invalid = oracleFailures(observation, sample.case.oracle, null);
      if (invalid.length) { falseRevisions.add(state.revision); invalid.forEach(failure => failures.add(`false_completion:${failure}`)); }
      else if (verifiedCompletionMs === null) verifiedCompletionMs = at - sample.startedAt;
    }
    prior = observation;
  }
  for (const entry of sample.entries) {
    if (!knownNumber(entry.at) || entry.at < sample.startedAt || entry.at > sample.finishedAt) failures.add('entry_time_invalid');
    if (entry.kind === 'tool' && entry.sourceKey !== null) queryKeys.add(entry.sourceKey);
  }
  const finalTruth = oracleFailures(last, sample.case.oracle, null);
  const goalCompleted = !unchanged && last.state.status === 'completed' && finalTruth.length === 0;
  if (unchanged) {
    if (sample.entries.length || observations.some(observation => observation.state.revision !== first.state.revision || !same(observation.state, first.state) || !same(observation.deliveries, first.deliveries))) failures.add('status_only_mutated_or_invoked');
    ackMs = null; firstEvidenceMs = null; firstUsefulAnswerMs = null; verifiedCompletionMs = null;
  } else {
    if (sample.finalControl !== sample.case.oracle.expectedFinal) failures.add('unexpected_final_control');
    const status = sample.case.oracle.expectedFinal === 'complete' ? 'completed' : sample.case.oracle.expectedFinal === 'wait' ? 'waiting' : sample.case.oracle.expectedFinal;
    if (last.state.status !== status) failures.add('unexpected_final_status');
    if (sample.case.oracle.expectedFinal === 'complete' && !goalCompleted) { failures.add('expected_completion_missing'); finalTruth.forEach(failure => failures.add(failure)); }
  }
  const final = last.state; const keyedQueries = sample.entries.filter(entry => entry.kind === 'tool' && entry.sourceKey !== null).length;
  const context = { requestBytes: 0, estimatedTokens: 0, sourceReads: 0, evictions: 0, reloads: 0 };
  for (const call of final.modelCalls) if (call.contextMetrics) for (const key of Object.keys(context) as (keyof typeof context)[]) context[key] += call.contextMetrics[key];
  return { caseId: sample.case.id, contractPassed: failures.size === 0, goalCompleted, falseCompletionRevisions: [...falseRevisions].sort((a, b) => a - b),
    failures: [...failures].sort(), finalControl: sample.finalControl, usage: structuredClone(final.budget),
    calls: { modelEntries: sample.entries.filter(entry => entry.kind === 'model').length, toolEntries: sample.entries.filter(entry => entry.kind === 'tool').length,
      sends: sample.entries.filter(entry => entry.kind === 'send').length, lookups: sample.entries.filter(entry => entry.kind === 'lookup').length,
      uniqueQueries: queryKeys.size, repeatedQueries: keyedQueries - queryKeys.size,
      adoptedTools: final.attempts.filter(attempt => attempt.adopted && ['succeeded', 'partial'].includes(attempt.status)).length,
      reusedTools: final.attempts.filter(attempt => attempt.execution?.mode === 'reused').length },
    context, latency: { ackMs, firstEvidenceMs, firstUsefulAnswerMs, verifiedCompletionMs,
      simulatedElapsedMs: sample.finishedAt - sample.startedAt, wallElapsedMs: sample.wallElapsedMs }, interventions, promotions };
}

export interface EvaluationDistribution { n: number; p50: number | null; p95: number | null }
export interface EvaluationRate { numerator: number; denominator: number; rate: number | null }
export interface EvaluationCohortMetrics {
  samples: number;
  contract: EvaluationRate;
  completionAll: EvaluationRate;
  completionEligible: EvaluationRate;
  excludedFromEligible: number;
  incomplete: number;
  falseCompletionCases: number;
  falseCompletionRevisions: number;
  runErrors: number;
  calls: EvaluationScore['calls'];
  context: EvaluationScore['context'];
  usage: { toolCalls: number; modelCalls: number; tokens: number; replans: number; unmeasuredModelCalls: number; reservedToolCalls: number; reservedModelCalls: number; reservedTokens: number };
  latency: { [Key in keyof EvaluationScore['latency']]: EvaluationDistribution };
  interventions: number;
  promotions: number;
}
export interface EvaluationSummary {
  quantiles: 'nearest_rank';
  overall: EvaluationCohortMetrics;
  cohorts: { family: EvaluationCase['family']; backend: string; mode: EvaluationCase['mode']; variant: EvaluationCase['variant']; metrics: EvaluationCohortMetrics }[];
}
const rate = (numerator: number, denominator: number): EvaluationRate => ({ numerator, denominator, rate: denominator ? numerator / denominator : null });
function distribution(values: (number | null)[]): EvaluationDistribution {
  const sorted = values.filter((value): value is number => value !== null && Number.isFinite(value)).sort((a, b) => a - b);
  return { n: sorted.length, p50: sorted.length ? sorted[Math.ceil(sorted.length * 0.5) - 1]! : null, p95: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1]! : null };
}
function aggregate(rows: { sample: EvaluationSample; score: EvaluationScore }[]): EvaluationCohortMetrics {
  const eligible = rows.filter(row => row.sample.case.oracle.completionEligible && row.sample.case.oracle.expectedFinal !== 'unchanged');
  const calls: EvaluationScore['calls'] = { modelEntries: 0, toolEntries: 0, sends: 0, lookups: 0, uniqueQueries: 0, repeatedQueries: 0, adoptedTools: 0, reusedTools: 0 };
  const context: EvaluationScore['context'] = { requestBytes: 0, estimatedTokens: 0, sourceReads: 0, evictions: 0, reloads: 0 };
  const usage = { toolCalls: 0, modelCalls: 0, tokens: 0, replans: 0, unmeasuredModelCalls: 0, reservedToolCalls: 0, reservedModelCalls: 0, reservedTokens: 0 };
  for (const { score } of rows) {
    for (const key of Object.keys(calls) as (keyof typeof calls)[]) calls[key] += score.calls[key];
    for (const key of Object.keys(context) as (keyof typeof context)[]) context[key] += score.context[key];
    for (const key of dimensions) usage[key] += score.usage.used[key];
    usage.unmeasuredModelCalls += score.usage.used.unmeasuredModelCalls;
    usage.reservedToolCalls += score.usage.reservedToolCalls; usage.reservedModelCalls += score.usage.reservedModelCalls; usage.reservedTokens += score.usage.reservedTokens;
  }
  return { samples: rows.length, contract: rate(rows.filter(row => row.score.contractPassed).length, rows.length),
    completionAll: rate(rows.filter(row => row.score.goalCompleted).length, rows.length),
    completionEligible: rate(eligible.filter(row => row.score.goalCompleted).length, eligible.length), excludedFromEligible: rows.length - eligible.length,
    incomplete: rows.filter(row => !row.score.goalCompleted).length,
    falseCompletionCases: rows.filter(row => row.score.falseCompletionRevisions.length > 0).length,
    falseCompletionRevisions: rows.reduce((sum, row) => sum + row.score.falseCompletionRevisions.length, 0), runErrors: rows.filter(row => row.sample.runError !== null).length,
    calls, context, usage,
    latency: { ackMs: distribution(rows.map(row => row.score.latency.ackMs)), firstEvidenceMs: distribution(rows.map(row => row.score.latency.firstEvidenceMs)),
      firstUsefulAnswerMs: distribution(rows.map(row => row.score.latency.firstUsefulAnswerMs)), verifiedCompletionMs: distribution(rows.map(row => row.score.latency.verifiedCompletionMs)),
      simulatedElapsedMs: distribution(rows.map(row => row.score.latency.simulatedElapsedMs)), wallElapsedMs: distribution(rows.map(row => row.score.latency.wallElapsedMs)) },
    interventions: rows.reduce((sum, row) => sum + row.score.interventions, 0), promotions: rows.reduce((sum, row) => sum + row.score.promotions, 0) };
}

export function summarizeEvaluations(samples: EvaluationSample[], scores?: EvaluationScore[]): EvaluationSummary {
  if (new Set(samples.map(sample => sample.case.id)).size !== samples.length) throw new Error('duplicate_evaluation_case');
  const chosen = scores ?? samples.map(scoreEvaluation);
  if (chosen.length !== samples.length || new Set(chosen.map(score => score.caseId)).size !== chosen.length || chosen.some(score => !samples.some(sample => sample.case.id === score.caseId))) throw new Error('evaluation_scores_mismatch');
  const rows = samples.map(sample => ({ sample, score: chosen.find(score => score.caseId === sample.case.id)! }));
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const value = row.sample.case; const key = JSON.stringify([value.family, value.backend, value.mode, value.variant]);
    const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
  }
  return { quantiles: 'nearest_rank', overall: aggregate(rows), cohorts: [...groups].sort(([left], [right]) => left.localeCompare(right, 'en')).map(([, group]) => {
    const value = group[0]!.sample.case; return { family: value.family, backend: value.backend, mode: value.mode, variant: value.variant, metrics: aggregate(group) };
  }) };
}
