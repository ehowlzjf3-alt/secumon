import test from 'node:test';
import assert from 'node:assert/strict';
import type { Attempt, Evidence, Hypothesis, Mode, PlanProposal, TaskSpec, WorkState } from '../domain/model.js';
import { autoExpansionReason, effectiveExecutionLimits, executionControl, newExecutionControl, validateExecutionPlan } from '../domain/execution-policy.js';
import { ExecutionControlSchema, ExecutionPolicySchema } from '../application/execution-policy-contracts.js';
import { newWork } from '../application/new-work.js';

function work(mode: Mode = 'auto'): WorkState {
  return newWork({ id: 'work', now: 1000,
    goal: { revision: 1, description: 'Compare the applicable policy', scope: 'policies', mode,
      criteria: [{ id: 'period', description: 'Two independent sources agree', key: 'period', operator: 'equals', equals: 30, minIndependentSources: 2, requireCompleteCoverage: true }] },
    policy: { tenantId: 'tenant', principalId: 'owner', allowedLabels: ['internal'], allowedTools: ['read'], allowedDestinations: ['local'], allowWrites: false },
    limits: { toolCalls: 10, modelCalls: 8, tokens: 10000, replans: 4, wallTimeMs: 50000 } });
}
function task(id: string): TaskSpec {
  return { id, description: `Read ${id}`, dependsOn: [], toolId: 'read', toolVersion: '1', input: { id }, effect: 'read', maxAttempts: 1, satisfies: ['period'] };
}
function proposal(state: WorkState, tasks = [task('next')], hypotheses: Hypothesis[] = []): PlanProposal {
  return { baseStateRevision: state.revision, baseGoalRevision: state.goal.revision, basePlanRevision: state.plan?.revision ?? 0,
    reason: 'Collect current independent evidence', tasks, hypotheses };
}
function attempt(id: string, overrides: Partial<Attempt> = {}): Attempt {
  return { id: `attempt-${id}`, taskId: id, planRevision: 1, goalRevision: 1, toolId: 'read', toolVersion: '1', inputDigest: `digest-${id}`, scope: 'policies',
    effect: 'read', effectState: 'none', status: 'succeeded', owner: 'executor', leaseUntil: 2000, startedAt: 1000, finishedAt: 1100,
    resultId: `result-${id}`, resultArtifact: null, adopted: true, error: null, ...overrides };
}
function evidence(id: string, overrides: Partial<Evidence> = {}): Evidence {
  return { id, tenantId: 'tenant', scope: 'policies', sourceId: `source-${id}`, lineageId: `lineage-${id}`, locator: id,
    observedAt: 900, recordedAt: 1100, labels: ['internal'], coverage: 'complete', status: 'accepted', supersedes: [], derivedFrom: [], facts: { period: 30 }, artifact: null, ...overrides };
}
function hypothesis(): Hypothesis {
  return { id: 'h', question: 'Do the policies agree?', claim: 'The period is 30', predictedObservation: 'Independent sources report 30',
    falsifier: 'An applicable source reports another period', status: 'open', supportIds: [], counterIds: [], reason: 'Needs evidence' };
}

test('local versioned defaults select direct auto/fast and investigate deep without allocating work', () => {
  for (const mode of ['auto', 'fast', 'deep'] as const) {
    const control = newExecutionControl(mode);
    assert.equal(control.requestedMode, mode); assert.equal(control.strategy, mode === 'deep' ? 'investigate' : 'direct');
    assert.equal(control.revision, 1); assert.equal(control.pending, null); assert.equal(control.policy.version, 'local-v1');
    assert.deepEqual(control.policy.fast, { toolCalls: 2, modelCalls: 2, replans: 0, maxPendingTasks: 1, maxHypotheses: 0 });
    assert.equal(ExecutionControlSchema.safeParse(control).success, true);
  }
});

test('new controls snapshot caller policy and never expose the default policy for mutation', () => {
  const custom = newExecutionControl('auto').policy; custom.version = 'custom'; custom.fast.maxPendingTasks = 3;
  const control = newExecutionControl('fast', custom); custom.fast.toolCalls = 900;
  assert.equal(control.policy.fast.toolCalls, 2);
  control.policy.fast.modelCalls = 900;
  assert.equal(newExecutionControl('fast').policy.fast.modelCalls, 2);
});

test('legacy goals supply initial mode while a saved control overrides it without mutating state', () => {
  const state = work('deep'); delete state.executionControl; const before = structuredClone(state);
  assert.equal(executionControl(state).strategy, 'investigate'); assert.deepEqual(state, before);
  state.executionControl = newExecutionControl('fast');
  const returned = executionControl(state); returned.policy.fast.toolCalls = 900;
  assert.equal(state.goal.mode, 'deep'); assert.equal(state.executionControl.policy.fast.toolCalls, 2);
  assert.equal(executionControl(state).requestedMode, 'fast');
});

test('effective fast limits are absolute work caps and retain token/time limits', () => {
  for (const mode of ['fast'] as const) {
    const state = work(mode); state.budget.used = { toolCalls: 1, modelCalls: 1, tokens: 100, replans: 0, unmeasuredModelCalls: 0 };
    state.budget.reservedToolCalls = 1; state.budget.reservedModelCalls = 1; state.budget.reservedTokens = 200;
    const before = structuredClone(state); const limits = effectiveExecutionLimits(state);
    assert.deepEqual(limits, { toolCalls: 2, modelCalls: 2, tokens: 10000, replans: 0, wallTimeMs: 50000 });
    assert.equal(limits.toolCalls - state.budget.used.toolCalls - state.budget.reservedToolCalls, 0);
    assert.equal(limits.modelCalls - state.budget.used.modelCalls - state.budget.reservedModelCalls, 0);
    limits.tokens = 0; assert.deepEqual(state, before);
  }
});

test('auto starts direct while retaining the user work limits before evidence or strategy expansion', () => {
  const state = work(); state.budget.used.toolCalls = 2; state.budget.reservedToolCalls = 1;
  assert.equal(executionControl(state).strategy, 'direct'); assert.equal(autoExpansionReason(state), null);
  assert.deepEqual(effectiveExecutionLimits(state), state.budget.limits);
  assert.equal(effectiveExecutionLimits(state).toolCalls - state.budget.used.toolCalls - state.budget.reservedToolCalls, 7);
});

test('explicit work caps beat mode policy and mode changes cannot grant a fresh allowance', () => {
  const state = work('deep'); state.budget.limits.toolCalls = 1; state.budget.limits.modelCalls = 0;
  state.budget.used.toolCalls = 1; state.executionControl = newExecutionControl('fast');
  assert.equal(effectiveExecutionLimits(state).toolCalls, 1); assert.equal(effectiveExecutionLimits(state).modelCalls, 0);
  state.budget.limits.toolCalls = 10; state.budget.used.toolCalls = 7; state.budget.reservedToolCalls = 1;
  const limits = effectiveExecutionLimits(state);
  assert.equal(limits.toolCalls, 2); assert.ok(state.budget.used.toolCalls + state.budget.reservedToolCalls > limits.toolCalls);
  assert.equal(state.goal.revision, 1); assert.equal(state.budget.used.toolCalls, 7);
});

test('investigate strategies retain explicit work limits and pending mode requests have no effect yet', () => {
  const state = work('deep'); state.executionControl = newExecutionControl('auto'); state.executionControl.strategy = 'investigate';
  state.executionControl.pending = { mode: 'fast', reason: 'Apply after the current response' };
  assert.deepEqual(effectiveExecutionLimits(state), state.budget.limits);
  assert.equal(executionControl(state).requestedMode, 'auto');
  state.executionControl = newExecutionControl('fast'); state.executionControl.pending = { mode: 'deep', reason: 'Needs review' };
  assert.equal(effectiveExecutionLimits(state).toolCalls, 2);
});

test('fast allows completed history plus one pending task and counts only current adopted successes', () => {
  const state = work('fast'); const completed = Array.from({ length: 100 }, (_, index) => task(`done-${index}`));
  state.attempts = completed.map(value => attempt(value.id));
  assert.deepEqual(validateExecutionPlan(state, proposal(state, [...completed, task('next')])), { strategy: 'direct', reason: 'fast_plan' });
  for (const override of [{ adopted: false }, { status: 'partial' as const }, { goalRevision: 2 }, { scope: 'another' }]) {
    const changed = structuredClone(state); Object.assign(changed.attempts[0]!, override);
    assert.throws(() => validateExecutionPlan(changed, proposal(changed, [...completed, task('next')])), /fast_scope_exceeded/);
  }
});

test('fast rejects an oversized pending graph or hypotheses without mutating or silently escalating', () => {
  const state = work('fast'); const before = structuredClone(state);
  assert.throws(() => validateExecutionPlan(state, proposal(state, [task('a'), task('b')])), /fast_scope_exceeded/);
  assert.throws(() => validateExecutionPlan(state, proposal(state, [], [hypothesis()])), /fast_scope_exceeded/);
  assert.deepEqual(state, before);
});

test('fast preserves and reviews existing hypotheses while rejecting new optional hypotheses', () => {
  const state = work('fast'); state.hypotheses = [hypothesis(), { ...hypothesis(), id: 'existing-2' }];
  const reassessed = state.hypotheses.map(value => ({ ...value, status: 'inconclusive' as const, reason: 'Current evidence remains insufficient' }));
  assert.equal(validateExecutionPlan(state, proposal(state, [task('next')], reassessed)).strategy, 'direct');
  assert.throws(() => validateExecutionPlan(state, proposal(state, [], [...reassessed, { ...hypothesis(), id: 'new' }])), /fast_scope_exceeded/);
  assert.equal(state.hypotheses.length, 2);
});

test('policy-specific scope limits are used instead of hard coded local defaults', () => {
  const state = work('fast'); state.executionControl = newExecutionControl('fast');
  state.executionControl.policy = { version: 'evaluation-2', fast: { toolCalls: 4, modelCalls: 3, replans: 1, maxPendingTasks: 2, maxHypotheses: 1 } };
  assert.equal(validateExecutionPlan(state, proposal(state, [task('a'), task('b')], [hypothesis()])).strategy, 'direct');
  assert.throws(() => validateExecutionPlan(state, proposal(state, [task('a'), task('b'), task('c')])), /fast_scope_exceeded/);
  assert.equal(effectiveExecutionLimits(state).toolCalls, 4);
});

test('auto expands only validated plan scope and preserves investigate strategy on smaller subsequent plans', () => {
  const state = work(); assert.equal(validateExecutionPlan(state, proposal(state)).strategy, 'direct');
  assert.deepEqual(validateExecutionPlan(state, proposal(state, [task('a'), task('b')])), { strategy: 'investigate', reason: 'plan_scope_expanded' });
  assert.deepEqual(validateExecutionPlan(state, proposal(state, [], [hypothesis()])), { strategy: 'investigate', reason: 'plan_hypotheses_expanded' });
  state.executionControl = newExecutionControl('auto'); state.executionControl.strategy = 'investigate';
  assert.deepEqual(validateExecutionPlan(state, proposal(state)), { strategy: 'investigate', reason: 'investigation_retained' });
});

test('deep permits a simple or empty plan without manufacturing tasks or hypotheses', () => {
  const state = work('deep'); const plan = proposal(state, []); const before = structuredClone(plan);
  assert.deepEqual(validateExecutionPlan(state, plan), { strategy: 'investigate', reason: 'deep_plan' });
  assert.deepEqual(plan, before); assert.equal(state.attempts.length, 0); assert.equal(state.modelCalls.length, 0);
});

test('automatic expansion requires available relevant new evidence and an unmet criterion', () => {
  const state = work(); assert.equal(autoExpansionReason(state), null);
  state.evidence = [evidence('a')]; assert.equal(autoExpansionReason(state), 'new_evidence_incomplete');
  state.hypothesisAssessment = { goalRevision: 1, evidenceIds: ['a'] }; assert.equal(autoExpansionReason(state), null);
  state.hypothesisAssessment = { goalRevision: 2, evidenceIds: ['a'] }; assert.equal(autoExpansionReason(state), 'new_evidence_incomplete');
  state.evidence.push(evidence('b')); assert.equal(autoExpansionReason(state), null);
});

test('irrelevant, inaccessible, retracted and another-scope facts cannot justify expansion', () => {
  for (const overrides of [{ facts: { unrelated: 30 } }, { labels: ['private'] }, { status: 'retracted' as const },
    { access: 'restricted' as const }, { access: 'deleted' as const }, { scope: 'another' }, { tenantId: 'another' }]) {
    const state = work(); state.evidence = [evidence('a', overrides)]; assert.equal(autoExpansionReason(state), null);
  }
});

test('current counterevidence justifies investigation even if it has already been assessed', () => {
  const state = work(); state.evidence = [evidence('a'), evidence('counter', { facts: { period: 90 } })];
  state.hypothesisAssessment = { goalRevision: 1, evidenceIds: ['a', 'counter'] };
  assert.equal(autoExpansionReason(state), 'counterevidence_requires_investigation');
  state.evidence[1]!.access = 'restricted'; assert.equal(autoExpansionReason(state), null);
});

test('current hypotheses allow review but sufficiently assessed completed goals do not expand', () => {
  const state = work(); state.hypotheses = [hypothesis()];
  assert.equal(autoExpansionReason(state), 'hypotheses_require_investigation');
  state.evidence = [evidence('a'), evidence('b')];
  state.hypothesisAssessment = { goalRevision: 1, evidenceIds: ['a', 'b'] }; assert.equal(autoExpansionReason(state), null);
  state.hypothesisAssessment = null; assert.equal(autoExpansionReason(state), 'hypotheses_require_investigation');
});

test('permission failure, empty responses and exhausted budgets are not independent escalation evidence', () => {
  const state = work(); state.budget.used.toolCalls = 2; state.budget.used.modelCalls = 2;
  state.attempts = [attempt('failed', { status: 'failed', adopted: false, error: { code: 'permission_denied', retryable: false } })];
  assert.equal(autoExpansionReason(state), null);
  state.attempts[0]!.error = { code: 'source_empty', retryable: false }; assert.equal(autoExpansionReason(state), null);
});

test('pending obligations, active calls, terminal states and explicit modes suppress automatic expansion', () => {
  const base = work(); base.evidence = [evidence('a')];
  for (const status of ['blocked', 'waiting', 'paused', 'cancelled', 'failed', 'completed'] as const) {
    const state = structuredClone(base); state.status = status; assert.equal(autoExpansionReason(state), null);
  }
  for (const kind of ['response', 'evidence', 'effect_reconciliation'] as const) {
    const state = structuredClone(base); state.obligations = [{ id: 'wait', kind, reason: 'External dependency', status: 'pending', wakeKey: 'ready', dueAt: 2000 }];
    assert.equal(autoExpansionReason(state), null);
  }
  for (const status of ['reserved', 'running', 'received'] as const) {
    const state = structuredClone(base); state.attempts = [attempt('active', { status, adopted: false })]; assert.equal(autoExpansionReason(state), null);
  }
  for (const mode of ['fast', 'deep'] as const) {
    const state = structuredClone(base); state.executionControl = newExecutionControl(mode); assert.equal(autoExpansionReason(state), null);
  }
  base.executionControl = newExecutionControl('auto'); base.executionControl.pending = { mode: 'fast', reason: 'At next boundary' };
  assert.equal(autoExpansionReason(base), null);
});

test('delivery waiting does not manufacture completion or suppress investigation of unmet criteria', () => {
  const state = work(); state.evidence = [evidence('a')];
  state.obligations = [{ id: 'deliver', kind: 'delivery', reason: 'Result delivery required', status: 'pending', wakeKey: 'deliver', dueAt: 2000 }];
  assert.equal(autoExpansionReason(state), 'new_evidence_incomplete');
  state.evidence.push(evidence('b')); assert.equal(autoExpansionReason(state), null);
});

test('a reserved, running or received model prevents expansion until its existing call is settled', () => {
  const state = work(); state.evidence = [evidence('a')];
  state.modelCalls = [{ id: 'model', provider: 'fixture', model: 'local', adapterRevision: '1', destination: 'local', owner: 'executor',
    goalRevision: 1, baseStateRevision: 1, basePlanRevision: 0, semanticDigest: 'digest',
    inputArtifact: { id: 'input', sha256: 'a'.repeat(64), byteLength: 0, tenantId: 'tenant', labels: ['internal'], mediaType: 'application/json' },
    replyArtifact: null, inputEstimate: 100, maxOutputTokens: 20, tokenReservation: 120, inputTokens: null, outputTokens: null,
    usageStatus: 'reserved', status: 'reserved', startedAt: 1000, leaseUntil: 2000, finishedAt: null, expired: false, outcome: null, reason: 'fixture' }];
  for (const status of ['reserved', 'running', 'received'] as const) {
    state.modelCalls[0]!.status = status; const before = structuredClone(state);
    assert.equal(autoExpansionReason(state), null); assert.deepEqual(state, before);
  }
  state.modelCalls[0]!.status = 'accepted'; state.modelCalls[0]!.usageStatus = 'reported';
  assert.equal(autoExpansionReason(state), 'new_evidence_incomplete');
});

test('policy contracts reject unknown fields, unsafe counts and blank versions while allowing explicit zero caps', () => {
  const policy = newExecutionControl('auto').policy;
  for (const value of [{ ...policy, extra: true }, { ...policy, version: ' ' }, { ...policy, fast: { ...policy.fast, unbounded: true } }])
    assert.equal(ExecutionPolicySchema.safeParse(value).success, false);
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
    const invalid = { ...policy, fast: { ...policy.fast, toolCalls: value } };
    assert.equal(ExecutionPolicySchema.safeParse(invalid).success, false); assert.throws(() => newExecutionControl('auto', invalid), /invalid_execution_policy/);
  }
  const zero = { version: 'zero', fast: { toolCalls: 0, modelCalls: 0, replans: 0, maxPendingTasks: 0, maxHypotheses: 0 } };
  assert.equal(ExecutionPolicySchema.safeParse(zero).success, true);
  const state = work('fast'); state.executionControl = newExecutionControl('fast', zero);
  assert.throws(() => validateExecutionPlan(state, proposal(state)), /fast_scope_exceeded/);
});

test('control contracts enforce current mode strategy and preserve distinct pending requests', () => {
  const base = newExecutionControl('fast');
  for (const value of [{ ...base, revision: 0 }, { ...base, revision: 1.5 }, { ...base, strategy: 'investigate' },
    { ...base, requestedMode: 'deep' }, { ...base, lastReason: ' ' }, { ...base, unknown: true },
    { ...base, pending: { mode: 'fast', reason: '', extra: true } }]) assert.equal(ExecutionControlSchema.safeParse(value).success, false);
  const pending = { ...base, pending: { mode: 'deep', reason: 'After the response' } };
  assert.deepEqual(ExecutionControlSchema.parse(pending), pending);
});
