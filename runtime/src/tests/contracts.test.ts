import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ContextPacketSchema, ContractError, GoalSchema, PlanProposalSchema, ToolResultSchema, WorkStateSchema, parseContract } from '../application/contracts.js';
import { validateScenario } from '../application/fixtures.js';
import { newWork } from '../application/new-work.js';

const scenario = validateScenario(JSON.parse(readFileSync(new URL('../../fixtures/documents-simple.json', import.meta.url), 'utf8')));
const limits = { toolCalls: 10, modelCalls: 3, tokens: 10000, replans: 2, wallTimeMs: 60000 };
test('canonical state has explicit nulls, bounded revisions and no provider/SQL objects', () => {
  const state = newWork({ id: 'test-work', goal: scenario.goal, policy: scenario.policy, limits, now: 1000 });
  assert.deepEqual(parseContract(WorkStateSchema, JSON.parse(JSON.stringify(state))), state);
  assert.throws(() => parseContract(WorkStateSchema, { ...state, revision: 0 }), ContractError);
  assert.throws(() => parseContract(WorkStateSchema, { ...state, postgresConnection: {} }), ContractError);
  assert.throws(() => newWork({ id: 'x', goal: scenario.goal, policy: scenario.policy, limits: { ...limits, tokens: -1 }, now: 0 }), ContractError);
});
test('goal validation cannot silently drop unknown authorization fields or empty completion rules', () => {
  assert.throws(() => parseContract(GoalSchema, { ...scenario.goal, criteria: [] }), ContractError);
  assert.throws(() => parseContract(GoalSchema, { ...scenario.goal, allowAllTools: true }), ContractError);
});
test('partial result is distinct from complete result and API errors are not evidence of absence', () => {
  const partial = { resultId: 'r1', attemptId: 'a1', status: 'partial', effectState: 'none', evidence: [], artifacts: [], output: null, error: null, cursor: 'page-2', coverage: 'partial' };
  assert.equal(parseContract(ToolResultSchema, partial).status, 'partial');
  assert.throws(() => parseContract(ToolResultSchema, { ...partial, status: 'success' }), ContractError);
  assert.throws(() => parseContract(ToolResultSchema, { ...partial, status: 'error' }), ContractError);
  const failure = parseContract(ToolResultSchema, { ...partial, status: 'error', error: { code: 'permission_denied', retryable: false }, coverage: 'unknown' });
  assert.equal(failure.evidence.length, 0);
  assert.equal(failure.coverage, 'unknown');
});
test('plan and context explicitly bind state and goal revisions', () => {
  const proposal = { baseStateRevision: 1, baseGoalRevision: 1, basePlanRevision: 0, reason: 'Read known source', tasks: [], hypotheses: [] };
  assert.equal(parseContract(PlanProposalSchema, proposal).basePlanRevision, 0);
  assert.throws(() => parseContract(PlanProposalSchema, { ...proposal, baseStateRevision: undefined }), ContractError);
  const packet = { schemaVersion: 1, workId: 'work', stateRevision: 1, goal: scenario.goal, policy: scenario.policy, plan: null, hypotheses: [], obligations: [], evidence: [], activeToolIds: [], purpose: 'plan' };
  assert.equal(parseContract(ContextPacketSchema, packet).purpose, 'plan');
});
test('invalid provider content is not included in validation error text', () => {
  const marker = 'SYNTHETIC_PRIVATE_CONTENT';
  try { parseContract(GoalSchema, { secret: marker }); assert.fail('expected rejection'); }
  catch (error) { assert.ok(error instanceof ContractError); assert.ok(!String(error).includes(marker)); assert.ok(!JSON.stringify(error.paths).includes(marker)); }
});
