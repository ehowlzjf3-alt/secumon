import test from 'node:test';
import assert from 'node:assert/strict';
import type { ArtifactRef, Attempt, Criterion, Evidence, ModelCall, Obligation, TaskSpec, WorkState } from '../domain/model.js';
import { evaluateCompletion, evaluateResultReadiness } from '../domain/completion.js';
import { decide } from '../domain/control.js';
import { autoExpansionReason } from '../domain/execution-policy.js';
import { GoalSchema, WorkStateSchema } from '../application/contracts.js';
import { newWork } from '../application/new-work.js';
import { applyValidatedPlan, validatePlan } from '../application/plan-validator.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { Sha256Digester } from '../infrastructure/digest.js';

const digest = (character = 'a') => character.repeat(64);
const criterion: Criterion = { id: 'period', description: 'Two independent sources agree on the period', key: 'period',
  operator: 'equals', equals: 30, minIndependentSources: 2, requireCompleteCoverage: true };
function work(response = true, mode: 'auto' | 'fast' = 'auto'): WorkState {
  const state = newWork({ id: 'work', now: 1000,
    goal: { revision: 1, description: 'Explain the requested topic', scope: 'policy', mode, criteria: response ? [] : [criterion],
      ...(response ? { responseRequirement: { version: 1 as const, requestMessageId: 'request', requestTextDigest: digest(), format: 'text' as const } } : {}) },
    policy: { tenantId: 'tenant', principalId: 'person', allowedLabels: ['internal'], allowedTools: ['read'], allowedDestinations: ['local'], allowWrites: false },
    limits: { toolCalls: 10, modelCalls: 8, tokens: 10000, replans: 4, wallTimeMs: 50000 } });
  if (response) state.conversation = { primaryBindingId: 'binding', completionRequiresDelivery: false, result: null,
    bindings: [{ id: 'binding', channel: 'test', conversationId: 'conversation', recipientId: 'person', destination: 'local', tenantId: 'tenant', principalId: 'person',
      session: { tenantId: 'tenant', agentId: 'agent', principalId: 'person', sessionId: 'session' } }],
    session: { scope: { tenantId: 'tenant', agentId: 'agent', principalId: 'person', sessionId: 'session' }, input: { messageId: 'request', sequence: 1, digest: digest('b') } } };
  return state;
}
function artifact(id: string): ArtifactRef {
  return { id, sha256: digest(), byteLength: 128, mediaType: 'application/json', tenantId: 'tenant', labels: ['internal'] };
}
function evidence(id: string, overrides: Partial<Evidence> = {}): Evidence {
  return { id, tenantId: 'tenant', scope: 'policy', sourceId: `source-${id}`, lineageId: `lineage-${id}`, locator: id,
    observedAt: 900, recordedAt: 1000, labels: ['internal'], coverage: 'complete', status: 'accepted', supersedes: [], derivedFrom: [], facts: { period: 30 }, artifact: null, ...overrides };
}
function answer(state: WorkState): void {
  const inputArtifact = artifact('input');
  const call: ModelCall = { id: 'answer-call', purpose: 'agent_turn', provider: 'synthetic', model: 'domain-fixture', adapterRevision: '1', destination: 'local', owner: 'runtime',
    goalRevision: state.goal.revision, baseStateRevision: state.revision, basePlanRevision: state.plan?.revision ?? 0,
    semanticDigest: digest(), semanticVersion: 3, inputArtifact, replyArtifact: artifact('reply'), inputEstimate: 20, maxOutputTokens: 30, tokenReservation: 50,
    inputTokens: 20, outputTokens: 20, usageStatus: 'reported', status: 'accepted', startedAt: 1000, leaseUntil: 2000, finishedAt: 1100, expired: false, outcome: 'ok', reason: 'answer' };
  state.modelCalls = [call];
  state.generatedAnswer = { id: 'answer', callId: call.id, goalRevision: state.goal.revision, planRevision: state.plan?.revision ?? 0,
    dataGeneration: state.dataLifecycle?.generation ?? 0, input: structuredClone(state.conversation!.session!), inputArtifact, promptDigest: digest(), basisDigest: digest(), artifact: artifact('answer'),
    evidenceIds: state.evidence.map(value => value.id), observedEvidenceIds: state.evidence.map(value => value.id),
    assessment: { type: 'model_self_review', verdict: 'satisfied', rationale: 'The answer addresses the requested explanation.', missing: [], counterarguments: [] }, createdAt: 1100 };
}
const check = (state: WorkState) => evaluateCompletion(state.goal, state.evidence, state.obligations, state.policy, state.attempts, state);
const readiness = (state: WorkState) => evaluateResultReadiness(state.goal, state.evidence, state.obligations, state.policy, state.attempts, state);
function obligation(kind: Obligation['kind']): Obligation {
  return { id: kind, kind, status: 'pending', reason: 'An actual unresolved obligation', wakeKey: `wake-${kind}`, dueAt: 4000 };
}
function task(): TaskSpec {
  return { id: 'read', description: 'Read the original source', dependsOn: [], toolId: 'read', toolVersion: '1', input: {}, effect: 'read', maxAttempts: 1, satisfies: [] };
}
function succeeded(): Attempt {
  return { id: 'attempt', taskId: 'read', planRevision: 1, goalRevision: 1, toolId: 'read', toolVersion: '1', inputDigest: digest(), scope: 'policy',
    effect: 'read', effectState: 'none', status: 'succeeded', owner: 'executor', leaseUntil: 2000, startedAt: 1000, finishedAt: 1100,
    resultId: 'result', resultArtifact: null, adopted: true, error: null };
}

test('legacy fact-only goals preserve serialized bytes and the existing completion result', () => {
  const state = work(false); state.evidence = [evidence('a'), evidence('b')];
  const goalBytes = JSON.stringify(state.goal), stateBytes = JSON.stringify(state);
  assert.equal(JSON.stringify(GoalSchema.parse(state.goal)), goalBytes);
  const parsed = WorkStateSchema.parse(state);
  assert.equal(Object.hasOwn(parsed.goal, 'responseRequirement'), false);
  assert.equal(Object.hasOwn(parsed, 'generatedAnswer'), false);
  const expected = { complete: true, criteria: [{ id: 'period', met: true, evidenceIds: ['a', 'b'], reasons: [] }], blockers: [] };
  assert.deepEqual(evaluateCompletion(state.goal, state.evidence, [], state.policy), expected);
  assert.deepEqual(check(state), expected); assert.equal(JSON.stringify(state), stateBytes);
  state.goal.criteria = [];
  assert.equal(GoalSchema.safeParse(state.goal).success, false);
  assert.deepEqual(check(state), { complete: false, criteria: [], blockers: ['no_completion_criteria'] });
});

test('a response-only goal needs a host-adopted answer, not an empty criterion list or a fabricated fact', () => {
  const state = work(); assert.equal(GoalSchema.safeParse(state.goal).success, true);
  assert.deepEqual(check(state), { complete: false, criteria: [], blockers: ['generated_answer_required'] });
  state.evidence = [evidence('irrelevant', { facts: { done: true } })];
  assert.equal(check(state).complete, false);
  answer(state);
  assert.deepEqual(evaluateCompletion(state.goal, state.evidence, [], state.policy), { complete: false, criteria: [], blockers: ['generated_answer_state_required'] });
  const before = structuredClone(state);
  assert.deepEqual(check(state), { complete: true, criteria: [], blockers: [] });
  assert.deepEqual(state, before);
});

test('only the unique accepted main-turn call with the same input reference can support an answer', () => {
  const mutations: ((state: WorkState) => void)[] = [
    state => { state.modelCalls = []; },
    state => { state.modelCalls.push(structuredClone(state.modelCalls[0]!)); },
    state => { state.modelCalls[0]!.status = 'received'; },
    state => { state.modelCalls[0]!.status = 'rejected'; },
    state => { state.modelCalls[0]!.purpose = 'planning'; },
    state => { delete state.modelCalls[0]!.purpose; },
    state => { state.modelCalls[0]!.goalRevision++; },
    state => { state.modelCalls[0]!.basePlanRevision++; },
    state => { state.generatedAnswer!.inputArtifact = { ...state.generatedAnswer!.inputArtifact, sha256: digest('c') }; },
  ];
  for (const mutate of mutations) {
    const state = work(); answer(state); mutate(state);
    assert.equal(check(state).complete, false); assert.ok(check(state).blockers.includes('generated_answer_call_unaccepted'));
  }
});

test('goal, graph, data generation and each session input identity change invalidate a previously accepted answer', () => {
  const mutations: ((state: WorkState) => void)[] = [
    state => { state.goal.revision++; },
    state => { state.plan = { revision: 1, goalRevision: 1, reason: 'A new plan', tasks: [] }; },
    state => { state.dataLifecycle = { generation: 1, blockedArtifactIds: [], changes: [] }; },
    state => { state.conversation!.session!.scope.tenantId = 'other'; },
    state => { state.conversation!.session!.scope.agentId = 'other'; },
    state => { state.conversation!.session!.scope.principalId = 'other'; },
    state => { state.conversation!.session!.scope.sessionId = 'other'; },
    state => { state.conversation!.session!.input.messageId = 'followup'; },
    state => { state.conversation!.session!.input.sequence++; },
    state => { state.conversation!.session!.input.digest = digest('c'); },
    state => { delete state.conversation!.session; },
  ];
  for (const mutate of mutations) { const state = work(); answer(state); mutate(state); assert.equal(check(state).complete, false); }
  const followedUp = work(); followedUp.conversation!.session!.input = { messageId: 'followup', sequence: 3, digest: digest('c') };
  answer(followedUp); assert.equal(check(followedUp).complete, true, 'The latest applied reply can satisfy the original request.');
});

test('new, removed, restricted or retracted evidence requires a fresh answer even when it was not cited', () => {
  const state = work(); state.evidence = [evidence('a'), evidence('b')]; answer(state);
  state.generatedAnswer!.evidenceIds = ['a']; state.generatedAnswer!.observedEvidenceIds.reverse();
  assert.equal(check(state).complete, true);
  const changes: ((copy: WorkState) => void)[] = [
    copy => { copy.evidence.push(evidence('new', { facts: { period: 90 } })); },
    copy => { copy.evidence.pop(); },
    copy => { copy.evidence[1]!.access = 'restricted'; },
    copy => { copy.evidence[1]!.status = 'retracted'; },
    copy => { copy.generatedAnswer!.observedEvidenceIds.push('a'); },
  ];
  for (const change of changes) {
    const copy = structuredClone(state); change(copy);
    assert.ok(check(copy).blockers.includes('generated_answer_evidence_changed')); assert.equal(check(copy).complete, false);
  }
  state.generatedAnswer!.evidenceIds = ['unknown'];
  assert.ok(check(state).blockers.includes('generated_answer_evidence_unavailable'));
});

test('model self-review cannot replace independent evidence or dismiss factual counterevidence', () => {
  const state = work(); state.goal.criteria = [criterion]; answer(state);
  assert.ok(check(state).criteria[0]!.reasons.includes('insufficient_independent_evidence'));
  state.evidence = [evidence('a'), evidence('derived', { derivedFrom: ['a'] })]; answer(state);
  assert.equal(check(state).complete, false);
  state.evidence = [evidence('a'), evidence('b')]; answer(state); assert.equal(check(state).complete, true);
  state.evidence.push(evidence('counter', { facts: { period: 90 } })); answer(state);
  assert.equal(check(state).complete, false); assert.ok(check(state).criteria[0]!.reasons.includes('unresolved_counterevidence'));
});

test('considered counterarguments are retained while any missing requirement or needs-work verdict blocks completion', () => {
  const state = work(); answer(state);
  state.generatedAnswer!.assessment.counterarguments = ['A shorter explanation omits the trade-off; this answer includes it.'];
  assert.equal(check(state).complete, true);
  state.generatedAnswer!.assessment.missing = ['The requested example is still absent.'];
  assert.ok(check(state).blockers.includes('generated_answer_assessment_incomplete'));
  state.generatedAnswer!.assessment.missing = []; state.generatedAnswer!.assessment.verdict = 'needs_work';
  assert.equal(check(state).complete, false);
});

test('result readiness excludes only delivery; response, evidence, effect and budget obligations remain required', () => {
  const state = work(); answer(state); state.obligations = [obligation('delivery')];
  assert.equal(check(state).complete, false); assert.equal(readiness(state).complete, true);
  assert.equal(decide(state, 1200).reason, 'result_delivery_pending');
  for (const kind of ['response', 'evidence', 'effect_reconciliation', 'budget_reconciliation'] as const) {
    state.obligations = [obligation('delivery'), obligation(kind)];
    assert.equal(readiness(state).complete, false); assert.ok(readiness(state).blockers.includes(`pending_obligation:${kind}`));
  }
  state.obligations = [obligation('response')];
  assert.deepEqual(decide(state, 1200), { kind: 'wait', reason: 'pending_obligation', wakeAt: 4000 });
});

test('transient model and tool calls cannot be hidden by an otherwise accepted answer', () => {
  for (const status of ['reserved', 'running', 'received'] as const) {
    const state = work(); answer(state); state.modelCalls.push({ ...state.modelCalls[0]!, id: 'pending', status });
    assert.ok(readiness(state).blockers.includes('model_call_pending')); assert.equal(check(state).complete, false);
    state.modelCalls.pop(); state.attempts = [{ ...succeeded(), status, adopted: false }];
    assert.ok(readiness(state).blockers.includes('attempt_pending')); assert.equal(check(state).complete, false);
  }
});

test('fresh session, memory and hypothesis reviews remain gates before response completion', () => {
  const state = work(); answer(state);
  state.conversation!.sessionReviewRequired = true; assert.ok(check(state).blockers.includes('session_input_requires_review'));
  state.conversation!.sessionReviewRequired = false; state.personalMemoryReviewRequired = true;
  assert.ok(check(state).blockers.includes('personal_memory_requires_review')); state.personalMemoryReviewRequired = false;
  state.hypotheses = [{ id: 'h', question: 'What alternative explains this?', claim: 'An alternative is possible', predictedObservation: 'Another cause is observed',
    falsifier: 'The alternate cause is absent', status: 'inconclusive', supportIds: [], counterIds: [], reason: 'Needs review' }];
  assert.ok(check(state).blockers.includes('hypothesis_review_required'));
  state.hypothesisAssessment = { goalRevision: 1, evidenceIds: [] }; assert.equal(check(state).complete, true);
});

test('blocked or no-longer-authorized answer and input artifacts cannot complete a response', () => {
  for (const id of ['answer', 'input']) {
    const state = work(); answer(state); state.dataLifecycle = { generation: 0, blockedArtifactIds: [id], changes: [] };
    assert.ok(check(state).blockers.includes('generated_answer_artifact_unavailable'));
  }
  const state = work(); answer(state); state.policy.allowedLabels = [];
  assert.equal(check(state).complete, false);
});

test('fast work progresses from main turn to tool to synthesis without charging a graph replan', () => {
  const state = work(true, 'fast'); const initialBudget = structuredClone(state.budget);
  assert.deepEqual(decide(state, 1200), { kind: 'replan', reason: 'agent_turn_required' });
  state.plan = { revision: 1, goalRevision: 1, reason: 'Read once', tasks: [task()] };
  assert.deepEqual(decide(state, 1200), { kind: 'continue', action: 'reserve', id: 'read', reason: 'task_ready' });
  state.attempts = [succeeded()]; state.evidence = [evidence('source')];
  assert.deepEqual(decide(state, 1200), { kind: 'replan', reason: 'agent_answer_required' });
  assert.deepEqual(state.budget, initialBudget); assert.equal(state.generatedAnswer, undefined);
  answer(state); assert.deepEqual(decide(state, 1200), { kind: 'complete', reason: 'criteria_verified' });
});

test('answer synthesis does not bypass a failed task, unmet factual criteria, allocation gate or deadline', () => {
  const state = work(true, 'fast'); state.plan = { revision: 1, goalRevision: 1, reason: 'Read once', tasks: [task()] };
  state.attempts = [{ ...succeeded(), status: 'failed', adopted: false, error: { code: 'read_failed', retryable: false } }];
  assert.equal(decide(state, 1200).reason, 'fast_replan_budget_exhausted');
  state.attempts = [succeeded()]; state.goal.criteria = [criterion];
  assert.equal(decide(state, 1200).reason, 'fast_replan_budget_exhausted');
  state.goal.criteria = [];
  assert.deepEqual(decide(state, 1200, () => ({ kind: 'blocked', reason: 'budget_not_allocated' })), { kind: 'blocked', reason: 'budget_not_allocated' });
  assert.equal(decide(state, state.deadlineAt).reason, 'deadline_exceeded');
});

test('an accepted satisfied answer cannot complete while planned tasks are unstarted, failed or have no current adopted success', () => {
  const attempts: Attempt[][] = [[], [{ ...succeeded(), status: 'failed', adopted: false, error: { code: 'read_failed', retryable: false } }],
    [{ ...succeeded(), adopted: false }], [{ ...succeeded(), goalRevision: 2 }]];
  for (const values of attempts) {
    const state = work(); state.plan = { revision: 1, goalRevision: 1, reason: 'Original source is required', tasks: [task()] };
    state.attempts = values; answer(state);
    assert.equal(check(state).complete, false); assert.ok(check(state).blockers.includes('response_plan_incomplete'));
    assert.equal(readiness(state).complete, false); assert.notEqual(decide(state, 1200).kind, 'complete');
    assert.notEqual(decide(state, 1200).reason, 'result_delivery_pending');
  }
});

test('an explicit validated plan removal preserves the failed attempt and permits a fresh answer at the new plan revision', () => {
  const state = work(); state.plan = { revision: 1, goalRevision: 1, reason: 'Original read plan', tasks: [task()] };
  state.attempts = [{ ...succeeded(), status: 'failed', adopted: false, error: { code: 'read_failed', retryable: false } }];
  answer(state); assert.ok(readiness(state).blockers.includes('response_plan_incomplete'));
  const digester = new Sha256Digester();
  const replacement = validatePlan({ baseStateRevision: state.revision, baseGoalRevision: state.goal.revision, basePlanRevision: 1,
    reason: 'The clarified request no longer requires the source lookup; retain its failure history.', tasks: [], hypotheses: [] },
  state, new ToolContracts([], new AjvSchemas()), digester);
  applyValidatedPlan(state, replacement, digester);
  assert.equal(state.plan.revision, 2); assert.equal(state.budget.used.replans, 1); assert.equal(state.attempts[0]!.status, 'failed');
  assert.ok(check(state).blockers.includes('generated_answer_stale')); assert.equal(check(state).complete, false);
  answer(state); assert.equal(readiness(state).complete, true); assert.equal(decide(state, 1200).kind, 'complete');
});

test('waiting for an answer alone does not expand auto investigation, but current factual counterevidence still does', () => {
  const state = work(); assert.equal(autoExpansionReason(state), null);
  state.hypotheses = [{ id: 'h', question: 'Which explanation fits?', claim: 'Several interpretations', predictedObservation: 'Compare them',
    falsifier: 'A mismatch', status: 'inconclusive', supportIds: [], counterIds: [], reason: 'Already considered' }];
  state.hypothesisAssessment = { goalRevision: 1, evidenceIds: [] }; assert.equal(autoExpansionReason(state), null);
  state.goal.criteria = [criterion]; state.evidence = [evidence('a'), evidence('counter', { facts: { period: 90 } })];
  assert.equal(autoExpansionReason(state), 'counterevidence_requires_investigation');
});
