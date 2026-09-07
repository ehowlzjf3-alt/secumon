import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ContextPacket, Hypothesis, PlanProposal, TaskSpec } from '../domain/model.js';
import type { ArtifactStore, ModelReply, Planner, StateRepository } from '../application/ports.js';
import { validateScenario } from '../application/fixtures.js';
import { newWork } from '../application/new-work.js';
import { PlanningRuntime } from '../application/planning-runtime.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { transact } from '../application/work-transactions.js';
import { FakeClock, FakeSink, FixtureReadTool, ScriptedPlanner } from '../infrastructure/fakes.js';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { SqliteStateRepository } from '../infrastructure/sqlite-state.js';
import { StructuredPlannerAdapter } from '../infrastructure/structured-planner.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';

const actor = { tenantId: 'synthetic', principalId: 'learner' };
const load = (id: string) => validateScenario(JSON.parse(readFileSync(new URL(`../../fixtures/${id}.json`, import.meta.url), 'utf8')));
const task = (id: string, evidenceIds: string[]): TaskSpec => ({ id, description: 'Read discriminating source', toolId: 'fixture.read', toolVersion: '1', effect: 'read', input: { evidenceIds }, dependsOn: [], maxAttempts: 2, satisfies: [] });
const proposal = (packet: ContextPacket, tasks: TaskSpec[], hypotheses: Hypothesis[] = []): PlanProposal => ({ baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision, basePlanRevision: packet.plan?.revision ?? 0, reason: 'Synthetic discriminating question', tasks, hypotheses });
const reply = (packet: ContextPacket, tasks: TaskSpec[], hypotheses: Hypothesis[] = []): ModelReply => ({ status: 'ok', proposal: proposal(packet, tasks, hypotheses), inputTokens: 100, outputTokens: 50, provider: 'scripted', model: 'fixture' });
async function setup(family: string, planner: Planner, state: StateRepository = new MemoryStateRepository(), artifacts: ArtifactStore = new MemoryArtifactStore()) {
  const scenario = load(family); const tool = new FixtureReadTool(scenario.evidence);
  if (!(await state.get('work'))) {
    const initial = newWork({ id: 'work', goal: scenario.goal, policy: scenario.policy, limits: { toolCalls: 20, modelCalls: 10, tokens: 1000000, replans: 5, wallTimeMs: 1000000 }, now: 1788566400000 });
    await state.commit({ workId: 'work', expectedRevision: 0, commandId: 'accept', commandDigest: 'accept', next: initial, events: [{ type: 'accepted', at: initial.createdAt, data: {} }], deliveries: [] });
  }
  const services = { state, artifacts, planner, tools: [tool], clock: new FakeClock(1788566400000), ids: new RandomIds(), sink: new FakeSink(), digester: new Sha256Digester() };
  const contracts = new ToolContracts([tool], new AjvSchemas()); const execution = new ExecutionRuntime(services, contracts, 'executor');
  return { scenario, tool, services, contracts, execution, planning: new PlanningRuntime(services, contracts, execution, 'planner') };
}

for (const [family, source] of [['documents-simple', 'doc-current'], ['observations-simple', 'collection-complete']]) test(`${family}: one model plan executes to completion with usage and no extra hypothesis call`, async () => {
  const planner = new ScriptedPlanner([p => reply(p, [task('read', [source!])])]); const f = await setup(family!, planner);
  assert.equal((await f.planning.runUntilYield('work')).kind, 'complete');
  const state = await f.execution.state('work'); assert.equal(state.status, 'completed'); assert.equal(state.modelCalls[0]!.status, 'accepted');
  assert.equal(state.budget.used.modelCalls, 1); assert.equal(state.budget.used.tokens, 150); assert.equal(state.budget.reservedTokens, 0); assert.equal(state.budget.reservedModelCalls, 0);
  assert.equal(planner.inputs.length, 1); assert.equal(f.tool.invocations.length, 1); assert.deepEqual(state.hypotheses, []);
  assert.equal(planner.inputs[0]!.stateRevision, state.modelCalls[0]!.baseStateRevision);
});

test('late counterevidence revises the hypothesis and only the changed graph consumes a replan', async () => {
  const base: Hypothesis = { id: 'h1', question: 'Do current policies have the same period?', claim: 'The current period is 90 days', predictedObservation: 'Current independent sources say 90', falsifier: 'A current authoritative source specifies a different period', status: 'open', supportIds: [], counterIds: [], reason: 'Not observed yet' };
  const first = task('old', ['doc-a-old']); const rest = [first, task('counter', ['doc-b']), task('amendment', ['doc-a-amendment'])];
  const planner = new ScriptedPlanner([
    p => reply(p, [first], [base]),
    p => reply(p, rest, [{ ...base, status: 'supported', supportIds: ['doc-a-old'], reason: 'Initial source reports 90; seek an independent source' }]),
    p => reply(p, rest, [{ ...base, status: 'contested', supportIds: ['doc-a-old'], counterIds: ['doc-b'], reason: 'Independent source reports 30; retain amendment lookup' }]),
    p => reply(p, rest, [{ ...base, status: 'refuted', counterIds: ['doc-b', 'doc-a-amendment'], reason: 'Amendment supersedes old value; current independent sources agree on 30' }]),
  ]);
  const f = await setup('documents-complex', planner);
  assert.equal((await f.planning.runUntilYield('work')).kind, 'complete'); const state = await f.execution.state('work');
  assert.equal(state.hypotheses[0]!.status, 'refuted'); assert.deepEqual(state.hypotheses[0]!.counterIds, ['doc-b', 'doc-a-amendment']);
  assert.equal(state.budget.used.modelCalls, 4); assert.equal(state.budget.used.replans, 1); assert.equal(state.plan!.revision, 2); assert.equal(f.tool.invocations.length, 3);
  assert.deepEqual(state.modelCalls.map(c => c.reason), ['plan', 'plan', 'assessment', 'assessment']);
  assert.deepEqual(planner.inputs.map(p => p.purpose), ['plan', 'assess', 'assess', 'assess']);
  const events = await f.services.state.events('work', 0); assert.equal(events.filter(e => e.type === 'model_plan_accepted').length, 4);
  assert.ok(JSON.stringify(events).includes('Initial source reports 90'));
});

test('strict structured transport adapter feeds the same validator and execution loop without a provider SDK', async () => {
  let calls = 0;
  const planner = new StructuredPlannerAdapter({ identity: { provider: 'internal-fixture', model: 'local-json', revision: '1' }, destination: 'local',
    capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 100000 } }, { async invoke(request) {
      calls++; return { finish: 'stop', content: JSON.stringify(proposal(request.packet, [task('read', ['doc-current'])])), usage: { inputTokens: 321, outputTokens: 123 }, provider: 'internal-fixture', model: 'local-json' };
    } });
  const f = await setup('documents-simple', planner); assert.equal((await f.planning.runUntilYield('work')).kind, 'complete');
  const state = await f.execution.state('work'); assert.equal(calls, 1); assert.equal(state.budget.used.tokens, 444); assert.equal(state.modelCalls[0]!.provider, 'internal-fixture');
  assert.ok(state.modelCalls[0]!.inputEstimate > 1000); assert.equal(f.tool.invocations.length, 1);
});

test('invalid or truncated responses cannot replace an executable plan or fabricate zero usage', async () => {
  const planner = new ScriptedPlanner([() => ({ status: 'truncated', code: 'synthetic_private_error', inputTokens: 100, outputTokens: null })]);
  const f = await setup('documents-simple', planner); const call = await f.planning.reserve('work'); await f.planning.execute('work', call.id);
  assert.equal(await f.planning.adopt('work', call.id), false); const state = await f.execution.state('work');
  assert.equal(state.plan, null); assert.equal(state.budget.used.tokens, 100); assert.equal(state.budget.used.unmeasuredModelCalls, 1); assert.equal(state.budget.reservedTokens, call.tokenReservation);
  assert.equal((await f.planning.runUntilYield('work')).reason, 'model_usage_unknown'); assert.equal(planner.inputs.length, 1);
  assert.ok(!JSON.stringify(await f.services.state.events('work', 0)).includes('synthetic_private_error'));
});

test('rejected model plans still charge exactly one call and preserve their raw response for an authorized read', async () => {
  const planner = new ScriptedPlanner([p => reply(p, [{ ...task('read', ['doc-current']), toolId: 'not.registered' }])]); const f = await setup('documents-simple', planner);
  const call = await f.planning.reserve('work'); await f.planning.execute('work', call.id); assert.equal(await f.planning.adopt('work', call.id), false);
  await f.planning.adopt('work', call.id); const state = await f.execution.state('work'); assert.equal(state.modelCalls[0]!.status, 'rejected'); assert.equal(state.budget.used.tokens, 150);
  assert.equal(state.budget.used.modelCalls, 1); assert.equal(state.plan, null); assert.equal(f.tool.invocations.length, 0); assert.ok(state.modelCalls[0]!.replyArtifact);
});

test('bookkeeping changes do not stale a response but goal and evidence changes do', async () => {
  const planner = new ScriptedPlanner([p => reply(p, [task('read', ['doc-current'])])]); const f = await setup('documents-simple', planner);
  const call = await f.planning.reserve('work'); await f.planning.execute('work', call.id);
  await transact(f.services, 'work', 'bookkeeping', 'diagnostic_recorded', {}, () => {});
  assert.equal(await f.planning.adopt('work', call.id), true);
  const other = await setup('documents-simple', new ScriptedPlanner([p => reply(p, [task('read', ['doc-current'])]) ]));
  const pending = await other.planning.reserve('work'); await other.planning.execute('work', pending.id);
  await transact(other.services, 'work', 'new-evidence', 'evidence_arrived', {}, s => { s.evidence.push(other.scenario.evidence.find(e => e.id === 'doc-current')!); });
  assert.equal(await other.planning.adopt('work', pending.id), false); assert.equal((await other.execution.state('work')).modelCalls[0]!.reason, 'model_snapshot_stale');
});

test('received model result resumes after SQLite and artifact reopen with no additional model call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-restart-')); let store = new SqliteStateRepository(join(dir, 'state.sqlite'));
  try {
    const planner = new ScriptedPlanner([p => reply(p, [task('read', ['doc-current'])])]);
    const first = await setup('documents-simple', planner, store, new FileArtifactStore(join(dir, 'artifacts')));
    const call = await first.planning.reserve('work'); await first.planning.execute('work', call.id); assert.equal((await store.get('work'))!.modelCalls[0]!.status, 'received');
    await store.close(); store = new SqliteStateRepository(join(dir, 'state.sqlite'));
    const unused = new ScriptedPlanner([]); const reopened = await setup('documents-simple', unused, store, new FileArtifactStore(join(dir, 'artifacts')));
    assert.deepEqual(await store.runnable(reopened.services.clock.now()), ['work']);
    assert.equal((await reopened.planning.runUntilYield('work')).kind, 'complete'); assert.equal(unused.inputs.length, 0); assert.equal(planner.inputs.length, 1);
    assert.equal((await reopened.execution.state('work')).budget.used.tokens, 150);
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a new scope archives the old hypothesis in prior events and permits a fresh plan', async () => {
  const h: Hypothesis = { id: 'old-scope', question: 'Is the policy 30?', claim: 'Policy is 30', predictedObservation: 'Source says 30', falsifier: 'Source says another number', status: 'open', supportIds: [], counterIds: [], reason: 'Need source' };
  const planner = new ScriptedPlanner([p => reply(p, [task('read', ['doc-current'])], [h]), p => reply(p, [task('new-scope-task', ['collection-complete'])])]);
  const f = await setup('documents-simple', planner); const call = await f.planning.reserve('work'); await f.planning.execute('work', call.id); assert.equal(await f.planning.adopt('work', call.id), true);
  const other = load('observations-simple'); await f.execution.command('work', 'goal-change', actor, 1, { kind: 'goal', expectedControlRevision: (await f.execution.state('work')).executionControl?.revision ?? 1, goal: { ...other.goal, revision: 2 } });
  assert.deepEqual((await f.execution.state('work')).hypotheses, []);
  const next = await f.planning.reserve('work'); await f.planning.execute('work', next.id); assert.equal(await f.planning.adopt('work', next.id), true);
  assert.ok(JSON.stringify(await f.services.state.events('work', 0)).includes('old-scope'));
});

test('unsupported hypotheses and erased counterevidence are rejected without changing the current assessment', async () => {
  const base: Hypothesis = { id: 'h', question: 'Do sources agree?', claim: 'Current period is 90', predictedObservation: 'Sources say 90', falsifier: 'Current source says 30', status: 'contested', supportIds: ['doc-a-old'], counterIds: ['doc-b'], reason: 'Sources disagree' };
  const planner = new ScriptedPlanner([p => reply(p, p.plan!.tasks, [{ ...base, status: 'supported', counterIds: [], reason: 'Ignore counterevidence' }])]);
  const f = await setup('documents-complex', planner);
  await transact(f.services, 'work', 'evidence', 'evidence_arrived', {}, state => { state.evidence.push(...f.scenario.evidence.filter(e => ['doc-a-old', 'doc-b'].includes(e.id))); });
  const state = await f.execution.state('work'); await f.execution.submitPlan('work', 'initial-plan', { baseStateRevision: state.revision, baseGoalRevision: 1, basePlanRevision: 0, reason: 'Review conflict', tasks: [], hypotheses: [base] });
  const call = await f.planning.reserve('work'); await f.planning.execute('work', call.id); assert.equal(await f.planning.adopt('work', call.id), false);
  assert.equal((await f.execution.state('work')).modelCalls[0]!.reason, 'hypothesis_evidence_dropped'); assert.equal((await f.execution.state('work')).hypotheses[0]!.status, 'contested');
  const emptySupport = { ...base, status: 'supported' as const, supportIds: [], counterIds: [] };
  const latest = await f.execution.state('work'); await assert.rejects(f.execution.submitPlan('work', 'unsupported', { baseStateRevision: latest.revision, baseGoalRevision: 1, basePlanRevision: 1, reason: 'No support', tasks: [], hypotheses: [emptySupport] }), /hypothesis_status_without_evidence/);
});

test('validator feedback reaches the next model proposal and invalid plans never dispatch their tools', async () => {
  const planner = new ScriptedPlanner([
    p => reply(p, [{ ...task('invalid', ['doc-current']), toolVersion: 'missing' }]),
    p => { assert.equal(p.planningFeedback?.[0]?.reason, 'tool_version_unavailable'); return reply(p, [task('valid', ['doc-current'])]); },
  ]);
  const f = await setup('documents-simple', planner);
  assert.equal((await f.planning.runUntilYield('work')).reason, 'retry_backoff');
  assert.equal(planner.inputs.length, 1); assert.equal(f.tool.invocations.length, 0);
  f.services.clock.advance((await f.execution.state('work')).progress!.policy.backoffMs);
  assert.equal((await f.planning.runUntilYield('work')).kind, 'complete');
  assert.equal(planner.inputs.length, 2); assert.equal(f.tool.invocations.length, 1); assert.equal((await f.execution.state('work')).budget.used.tokens, 300);
});

test('permission revocation during reply storage preserves usage but never downgrades the model body', async () => {
  const planner = new ScriptedPlanner([p => reply(p, [task('read', ['doc-current'])])]); const f = await setup('documents-simple', planner);
  const original = f.services.artifacts; let revoked = false;
  f.services.artifacts = { get: (ref, policy) => original.get(ref, policy), exists: ref => original.exists(ref), async put(bytes, attributes) {
    const artifact = await original.put(bytes, attributes);
    if (!revoked && new TextDecoder().decode(bytes).includes('"status":"ok"')) {
      revoked = true; await transact(f.services, 'work', 'revoke-during-store', 'policy_changed', {}, state => { state.policy.allowedLabels = []; });
    }
    return artifact;
  } };
  const call = await f.planning.reserve('work'); await f.planning.execute('work', call.id);
  const state = await f.execution.state('work'); assert.equal(state.modelCalls[0]!.status, 'received'); assert.equal(state.budget.used.tokens, 150); assert.equal(state.budget.used.unmeasuredModelCalls, 0);
  const record = state.modelCalls[0]!; assert.deepEqual(record.replyArtifact!.labels, []);
  const body = new TextDecoder().decode(await original.get(record.replyArtifact!, state.policy)); assert.doesNotMatch(body, /Synthetic discriminating question|doc-current/);
  assert.equal(await f.planning.adopt('work', call.id), false); assert.equal((await f.execution.state('work')).plan, null);
});
