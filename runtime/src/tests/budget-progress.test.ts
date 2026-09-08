import test from 'node:test';
import assert from 'node:assert/strict';
import type { BudgetGrant } from '../domain/budget-delegation.js';
import { budgetSummary, ownExposure } from '../domain/budget-delegation.js';
import type { Json, TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import type { RuntimeServices } from '../application/services.js';
import type { Tool } from '../application/ports.js';
import { createBudgetTools, BUDGET_TOOL_IDS } from '../application/budget-tools.js';
import { collaborationToolKind } from '../application/collaboration-tool-identity.js';
import { snapshotTool } from '../application/tool-contracts.js';
import { acceptedToolProgressKeys, captureProgress, progressGate } from '../application/work-progress.js';
import { asJson } from '../application/plan-validator.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { artifact, attempt, initial } from './state-conformance-helpers.js';

const digester = new Sha256Digester();
// Native factory/identity and adopted-result classification only; the separate entry suite executes the real router and stores.
const tools = createBudgetTools({ services: {} as RuntimeServices,
  execution: () => { throw new Error('unit_does_not_execute'); }, workflow: () => { throw new Error('unit_does_not_execute'); } });
function state() {
  const value = initial('budget-progress'); value.policy.allowedTools.push(...BUDGET_TOOL_IDS); return value;
}
function grant(value: WorkState, suffix = '1'): BudgetGrant {
  return { id: 'grant-' + suffix, childWorkId: 'child-' + suffix, parentGoalRevision: value.goal.revision,
    childScope: 'recipient-scope', childPolicyDigest: 'b'.repeat(64), deadlineAt: 60000, status: 'active',
    childAddress: { tenantId: value.policy.tenantId, principalId: value.policy.principalId, scope: 'recipient-scope', workId: 'child-' + suffix },
    allocated: { toolCalls: 3, modelCalls: 2, tokens: 1000, replans: 1 },
    accounted: { toolCalls: 0, modelCalls: 0, tokens: 0, replans: 0 }, reserved: { toolCalls: 0, modelCalls: 0, tokens: 0, replans: 0 },
    unmeasuredModelCalls: 0, childStateRevision: 2 };
}
function status(value: WorkState) {
  return { own: ownExposure(value), limits: value.budget.limits, summary: budgetSummary(value) ?? null,
    grants: (value.budgetGrants ?? []).map(({ id, childWorkId, status, allocated, accounted, reserved, unmeasuredModelCalls }) =>
      ({ id, childWorkId, status, allocated, accounted, reserved, unmeasuredModelCalls })), nextOffset: null,
    recipients: [{ id: 'reviewer', scope: 'recipient-scope' }], requests: value.obligations.filter(item => item.id.startsWith('budget-request:')),
    delegatedRequests: [] as { grantId: string; requestId: string; extra: { toolCalls: number; modelCalls: number; tokens: number; replans: number }; reason?: string }[] };
}
function adopted(operation: string, value = state(), output: unknown = status(value), input: TaskSpec['input'] = {}) {
  const tool = tools.find(item => item.definition.id === 'core.budget.' + operation); assert.ok(tool);
  const id = 'step-' + value.attempts.length;
  const task: TaskSpec = { id, description: 'Use actual resource metadata', toolId: tool.definition.id, toolVersion: '1',
    effect: 'read', input, dependsOn: [], satisfies: [], maxAttempts: 1 };
  const result: ToolResult = { resultId: id + ':result', attemptId: id, status: 'success', effectState: 'none', output: asJson(output),
    evidence: [], artifacts: [], cursor: null, error: null, coverage: 'complete' };
  const ownAttempt = { ...attempt('succeeded'), id, taskId: id, toolId: task.toolId, toolVersion: '1',
    scope: value.goal.scope, goalRevision: value.goal.revision, adopted: true, resultId: result.resultId };
  value.attempts.push(ownAttempt);
  const keys = (selected: Tool | undefined = tool) => acceptedToolProgressKeys(value, task, result, digester, false, selected);
  return { state: value, tool, task, result, ownAttempt, keys,
    capture: () => captureProgress(value, digester, id + ':settled', 1000, { additionalKeys: keys() }) };
}
function allocation(value: WorkState, selected: BudgetGrant) {
  return adopted('allocate', value, { workId: selected.childWorkId, grantId: selected.id, status: 'ready', sessionLifetimeChanged: false },
    { recipientId: 'reviewer', goal: asJson({ ...value.goal, scope: selected.childScope }),
      limits: { ...selected.allocated, wallTimeMs: 60000 } });
}

test('budget progress: only native factory identity survives snapshots; identical metadata grants no preparation', () => {
  assert.equal(tools.length, 8);
  for (const tool of tools) {
    assert.equal(collaborationToolKind(tool), 'budget');
    assert.equal(collaborationToolKind(snapshotTool(snapshotTool(tool))), 'budget');
    const copied = { ...tool, definition: structuredClone(tool.definition) };
    assert.equal(collaborationToolKind(copied), undefined);
  }
  const item = adopted('status'); assert.equal(item.keys().length, 2);
  assert.deepEqual(item.keys(snapshotTool(item.tool)), item.keys());
  assert.deepEqual(item.keys({ ...item.tool, definition: structuredClone(item.tool.definition) }), []);
  assert.deepEqual(acceptedToolProgressKeys(item.state, item.task, item.result, digester), []);
});

test('budget progress: repeated status ignores query, task IDs, revisions and caller costs and retains the default three-step stop', () => {
  const value = state(), first = adopted('status', value); assert.equal(first.capture().productiveSteps, 1);
  for (let i = 1; i <= 3; i++) {
    value.revision++; value.updatedAt++; value.budget.used.toolCalls++; value.budget.used.modelCalls++; value.budget.used.tokens += 20;
    const again = adopted('status', value, status(value), { offset: i, limit: 20 });
    assert.notEqual(again.task.id, first.task.id); assert.deepEqual(again.keys(), first.keys());
    assert.equal(again.capture().productiveSteps, 1);
  }
  assert.equal(value.progress?.policy.maxUnproductiveSteps, 3);
  assert.deepEqual(progressGate(value, 1000), { kind: 'blocked', reason: 'no_progress_limit' });
  assert.deepEqual(value.evidence, []); assert.equal(value.generatedAnswer, undefined);
  const changed = status(value); changed.recipients.push({ id: 'researcher', scope: 'another-recipient' });
  assert.equal(adopted('status', value, changed).keys().length, 3);
});

test('budget progress: actual allocation is productive but changing generated grant, work or criterion IDs cannot mint the same allocation again', () => {
  const value = state(), selected = grant(value); value.budgetGrants = [selected];
  const first = allocation(value, selected), firstKeys = first.keys(); assert.equal(firstKeys.length, 2); assert.equal(first.capture().productiveSteps, 1);
  const repeatedGrant = grant(value, 'new-command'); value.budgetGrants = [repeatedGrant];
  const repeated = allocation(value, repeatedGrant);
  const repeatedGoal = repeated.task.input['goal'] as Record<string, Json>;
  repeatedGoal['revision'] = 12;
  (repeatedGoal['criteria'] as Record<string, Json>[])[0]!['id'] = 'display-only-criterion';
  repeatedGrant.childStateRevision = 10; repeatedGrant.deadlineAt += 1000;
  assert.deepEqual(repeated.keys(), firstKeys); assert.equal(repeated.capture().productiveSteps, 1);
  const distinct = allocation(value, repeatedGrant);
  (distinct.task.input['goal'] as Record<string, Json>)['description'] = 'A different explicit task';
  assert.notDeepEqual(distinct.keys(), firstKeys);
  const malformed = allocation(value, repeatedGrant); (malformed.result.output as Record<string, Json>)['workId'] = 'foreign-work';
  assert.deepEqual(malformed.keys(), []); assert.deepEqual(value.evidence, []);
});

test('budget progress: increase, draining, known usage and settlement credit only the matching current grant state', () => {
  const value = state(), selected = grant(value); value.budgetGrants = [selected];
  const read = () => adopted('reconcile', value, { grant: structuredClone(selected) }, { grantId: selected.id });
  const first = read(), firstKeys = first.keys(); first.capture();
  selected.childStateRevision = selected.childStateRevision! + 1;
  const unchanged = read(); assert.deepEqual(unchanged.keys(), firstKeys); assert.equal(unchanged.capture().productiveSteps, 1);
  selected.allocated.toolCalls++;
  const increased = adopted('increase', value, { grant: selected }, { grantId: selected.id, extra: { toolCalls: 1, modelCalls: 0, tokens: 0, replans: 0 } });
  assert.notDeepEqual(increased.keys(), firstKeys); assert.equal(increased.capture().productiveSteps, 2);
  selected.status = 'draining'; selected.unmeasuredModelCalls = 1; selected.reserved.tokens = 500;
  const unknown = adopted('revoke', value, { grant: selected }, { grantId: selected.id }), unknownKeys = unknown.keys(); assert.equal(unknown.capture().productiveSteps, 3);
  const held = read(); assert.deepEqual(held.keys(), unknownKeys); assert.equal(held.capture().productiveSteps, 3);
  selected.unmeasuredModelCalls = 0; selected.reserved.tokens = 0; selected.accounted.tokens = 120; selected.accounted.modelCalls = 1; selected.status = 'settled';
  const settled = read(); assert.equal(settled.capture().productiveSteps, 4);
  assert.notDeepEqual(settled.keys(), unknownKeys);
  const stale = read(); selected.accounted.tokens++;
  assert.deepEqual(stale.keys(), [], 'a saved output is not the changed current ledger');
  const wrong = read(); wrong.task.input['grantId'] = 'different-grant'; assert.deepEqual(wrong.keys(), []);
  assert.deepEqual(value.evidence, []);
});

test('budget progress: requests expose numeric preparation once while request IDs and private wording cannot renew credit', () => {
  const value = state(), extra = { toolCalls: 1, modelCalls: 0, tokens: 0, replans: 0 };
  const own = (suffix: string, reason: string) => {
    const obligation = { id: 'budget-request:' + suffix, kind: 'response' as const, reason: JSON.stringify({ extra, reason }),
      status: 'pending' as const, wakeKey: 'budget-request:' + suffix, dueAt: null, mode: 'waiting' as const };
    value.obligations = [obligation];
    return adopted('request', value, { requestId: obligation.id, status: 'pending', sponsorWorkId: null, allowanceChanged: false }, { extra, reason });
  };
  const first = own('one', 'Private first wording'), firstKeys = first.keys(); first.capture();
  const repeated = own('two', 'Different private wording'); assert.deepEqual(repeated.keys(), firstKeys); assert.equal(repeated.capture().productiveSteps, 1);
  const selected = grant(value); value.budgetGrants = [selected]; value.obligations = [];
  const page = status(value); page.delegatedRequests = [{ grantId: selected.id, requestId: 'budget-request:one', extra }];
  const observed = adopted('status', value, page);
  page.delegatedRequests = [{ grantId: selected.id, requestId: 'budget-request:two', extra, reason: 'Not part of numeric progress' }];
  const again = adopted('status', value, page); assert.deepEqual(again.keys(), observed.keys());
  page.delegatedRequests[0]!.extra = { ...extra, toolCalls: 2 };
  assert.notDeepEqual(adopted('status', value, page).keys(), observed.keys());
  page.delegatedRequests[0]!.grantId = 'unrelated'; assert.deepEqual(adopted('status', value, page).keys(), []);
  assert.deepEqual(value.evidence, []);
});

test('budget progress: unadopted, failed, reused, denied, foreign-goal and malformed observations cannot claim progress', () => {
  for (const fault of ['unadopted', 'failed', 'reused', 'denied', 'foreign-goal', 'artifacts', 'malformed', 'wrong-current-card'] as const) {
    const value = state(), selected = grant(value); value.budgetGrants = [selected];
    const item = adopted('status', value);
    if (fault === 'unadopted') item.ownAttempt.adopted = false;
    if (fault === 'failed') { item.result.status = 'error'; item.result.error = { code: 'budget_authority_denied', retryable: false }; }
    if (fault === 'reused') item.result.reuse = { attemptId: 'prior', resultId: 'prior', resultArtifact: artifact(), observedAt: 999, cacheKey: 'a'.repeat(64) };
    if (fault === 'denied') value.policy.allowedTools = [];
    if (fault === 'foreign-goal') item.ownAttempt.goalRevision++;
    if (fault === 'artifacts') item.result.artifacts = [artifact()];
    if (fault === 'malformed') item.result.output = { recipients: [{ id: 'reviewer', scope: 'recipient-scope' }] };
    if (fault === 'wrong-current-card') selected.allocated.toolCalls++;
    assert.deepEqual(item.keys(), [], fault);
  }
});
