import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ContextPacket, PlanProposal, TaskSpec, ToolResult } from '../domain/model.js';
import type { StateRepository, Tool } from '../application/ports.js';
import { decide } from '../domain/control.js';
import { newWork } from '../application/new-work.js';
import { validateScenario } from '../application/fixtures.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { SqliteStateRepository } from '../infrastructure/sqlite-state.js';
import { Sha256Digester, RandomIds } from '../infrastructure/digest.js';
import { FakeClock, FakeSink, FixtureReadTool, ScriptedPlanner } from '../infrastructure/fakes.js';

const actor = { tenantId: 'synthetic', principalId: 'learner' };
const load = (id: string) => validateScenario(JSON.parse(readFileSync(new URL(`../../fixtures/${id}.json`, import.meta.url), 'utf8')));
const docs = load('documents-simple');
function task(evidenceIds = ['doc-current'], id = 'read'): TaskSpec {
  return { id, description: 'Read next source', dependsOn: [], toolId: 'fixture.read', toolVersion: '1', input: { evidenceIds }, effect: 'read', maxAttempts: 2, satisfies: [] };
}
function output(attemptId: string, effectState: ToolResult['effectState'] = 'none'): ToolResult {
  return { resultId: `${attemptId}:result`, attemptId, status: 'success', effectState, evidence: [docs.evidence[0]!], artifacts: [], output: { evidenceIds: ['doc-current'] }, error: null, cursor: null, coverage: 'complete' };
}
async function setup(family = 'documents-simple', override?: Tool, repository: StateRepository = new MemoryStateRepository()) {
  const scenario = load(family); const tool = override ?? new FixtureReadTool(scenario.evidence);
  const state = newWork({ id: 'work', goal: scenario.goal, policy: { ...scenario.policy, allowWrites: tool.definition.effect === 'write' },
    limits: { toolCalls: 10, modelCalls: 3, tokens: 10000, replans: 3, wallTimeMs: 100000 }, now: 1788566400000 });
  await repository.commit({ workId: state.id, expectedRevision: 0, commandId: 'accept', commandDigest: 'accept', next: state, events: [{ type: 'accepted', at: state.createdAt, data: {} }], deliveries: [] });
  const services = { state: repository, artifacts: new MemoryArtifactStore(), clock: new FakeClock(state.createdAt), ids: new RandomIds(),
    digester: new Sha256Digester(), tools: [tool], planner: new ScriptedPlanner([]), sink: new FakeSink() };
  const tools = new ToolContracts([tool], new AjvSchemas());
  const runtime = new ExecutionRuntime(services, tools, 'worker-1', 1000);
  return { runtime, services, tools, tool, scenario };
}
async function proposal(runtime: ExecutionRuntime, tasks: TaskSpec[]): Promise<PlanProposal> {
  const state = await runtime.state('work');
  return { baseStateRevision: state.revision, baseGoalRevision: state.goal.revision, basePlanRevision: state.plan?.revision ?? 0, reason: 'next discriminating source', tasks, hypotheses: [] };
}
async function plan(runtime: ExecutionRuntime, tasks = [task()]) {
  const p = await proposal(runtime, tasks);
  return runtime.submitPlan('work', `plan:${p.baseStateRevision}`, p);
}

for (const [family, source] of [['documents-simple', 'doc-current'], ['observations-simple', 'collection-complete']] as const) {
  test(`${family}: validated plan executes to verified completion without additional planner calls`, async () => {
    const { runtime, services, tool } = await setup(family);
    await plan(runtime, [task([source])]);
    assert.equal((await runtime.runUntilYield('work')).kind, 'complete');
    const state = await runtime.state('work');
    assert.equal(state.status, 'completed'); assert.equal(state.attempts[0]!.adopted, true);
    assert.equal(state.budget.used.toolCalls, 1); assert.equal(state.budget.reservedToolCalls, 0);
    assert.equal(state.budget.used.modelCalls, 0); assert.equal(services.planner.inputs.length, 0);
    assert.equal((tool as FixtureReadTool).invocations.length, 1);
    assert.deepEqual((await services.state.events('work', 0)).map(e => e.type), ['accepted', 'plan_accepted', 'attempt_reserved', 'attempt_dispatched', 'result_received', 'result_settled', 'control_selected']);
  });
}

test('invalid plans fail before budget or execution: stale, cyclic, missing deps, schema, effects, permission and IDs', async () => {
  const { runtime, services } = await setup();
  const valid = await proposal(runtime, [task()]);
  const invalid: [PlanProposal, RegExp][] = [
    [{ ...valid, baseStateRevision: 99 }, /stale_plan/],
    [{ ...valid, tasks: [task(), task()] }, /duplicate_task_id/],
    [{ ...valid, tasks: [{ ...task(), dependsOn: ['absent'] }] }, /invalid_dependency/],
    [{ ...valid, tasks: [{ ...task(), dependsOn: ['read'] }] }, /cyclic_plan/],
    [{ ...valid, tasks: [{ ...task(), input: { evidenceIds: 'wrong' } }] }, /invalid_tool_input/],
    [{ ...valid, tasks: [{ ...task(), toolVersion: '2' }] }, /tool_version_unavailable/],
    [{ ...valid, tasks: [{ ...task(), effect: 'write' }] }, /tool_effect_mismatch/],
    [{ ...valid, tasks: [{ ...task(), satisfies: ['not-a-criterion'] }] }, /unknown_criterion/],
  ];
  for (const [p, error] of invalid) await assert.rejects(runtime.submitPlan('work', 'invalid', p), error);
  assert.equal((await runtime.state('work')).revision, 1);
  assert.equal(services.tools[0] instanceof FixtureReadTool && services.tools[0].invocations.length, 0);
  const denied = structuredClone(await runtime.state('work')); denied.revision++; denied.policy.allowedDestinations = [];
  await services.state.commit({ workId: 'work', expectedRevision: 1, commandId: 'policy-test', commandDigest: 'policy-test', next: denied, events: [{ type: 'policy_changed', at: denied.updatedAt, data: {} }], deliveries: [] });
  await assert.rejects(plan(runtime), /tool_permission_denied/);
});

test('plan commands deduplicate after later state changes; task IDs cannot hide changed inputs', async () => {
  const { runtime, services } = await setup(); const p = await proposal(runtime, [task()]);
  await runtime.submitPlan('work', 'p1', p); await runtime.reserve('work', 'read');
  const before = await runtime.state('work');
  assert.equal((await runtime.submitPlan('work', 'p1', p)).revision, before.revision);
  await assert.rejects(runtime.submitPlan('work', 'p1', { ...p, reason: 'different' }), /idempotency_conflict/);
  services.clock.advance(1001); await runtime.recover('work', before.attempts[0]!.id);
  await assert.rejects(plan(runtime, [task(['doc-partial'])]), /task_id_contract_changed/);
});

test('discarded unexecuted task ID still cannot acquire a different contract', async () => {
  const { runtime } = await setup(); await plan(runtime); await plan(runtime, []);
  await assert.rejects(plan(runtime, [task(['doc-partial'])]), /task_id_contract_changed/);
});

test('scripted planner proposal enters the real validator and executor only when control requests a plan', async () => {
  const { runtime, services } = await setup();
  services.planner = new ScriptedPlanner([packet => ({ status: 'ok', proposal: { baseStateRevision: packet.stateRevision,
    baseGoalRevision: packet.goal.revision, basePlanRevision: packet.plan?.revision ?? 0, reason: 'retrieve original', tasks: [task()], hypotheses: [] },
    inputTokens: 0, outputTokens: 0, provider: 'scripted', model: 'fixture' })]);
  assert.equal((await runtime.step('work')).kind, 'replan');
  const state = await runtime.state('work');
  const packet: ContextPacket = { schemaVersion: 1, workId: state.id, stateRevision: state.revision, goal: state.goal, policy: state.policy,
    plan: state.plan, hypotheses: state.hypotheses, obligations: state.obligations, evidence: state.evidence, activeToolIds: ['fixture.read'], purpose: 'plan' };
  const reply = await services.planner.propose(packet, new AbortController().signal);
  assert.equal(reply.status, 'ok'); if (reply.status !== 'ok') throw new Error('fixture_planner_failed');
  await runtime.submitPlan('work', 'scripted-plan', reply.proposal);
  assert.equal((await runtime.runUntilYield('work')).kind, 'complete');
  assert.equal(services.planner.inputs.length, 1);
});

test('dependencies execute in order; partial observations require another source, not false completion', async () => {
  const { runtime, tool } = await setup();
  await plan(runtime, [{ ...task(['doc-current'], 'complete'), dependsOn: ['partial'] }, task(['doc-partial'], 'partial')]);
  assert.equal((await runtime.runUntilYield('work')).kind, 'replan');
  assert.equal((await runtime.state('work')).attempts[0]!.status, 'partial');
  assert.equal((tool as FixtureReadTool).invocations.length, 1);
  await plan(runtime, [task(['doc-current'], 'next-source')]);
  assert.equal((await runtime.runUntilYield('work')).kind, 'complete');
  assert.equal((await runtime.state('work')).budget.used.replans, 1);
});

test('empty queue is replan; wake conditions, tool budget, deadline and cancellation produce distinct controls', async () => {
  const { runtime, services } = await setup(); await plan(runtime, []);
  assert.equal((await runtime.runUntilYield('work')).kind, 'replan');
  await runtime.command('work', 'wait', actor, 1, { kind: 'wait', obligation: { id: 'reply', kind: 'response', reason: 'need owner confirmation', status: 'pending', wakeKey: 'owner-reply', dueAt: services.clock.now() + 2000 } });
  const revision = (await runtime.state('work')).revision;
  assert.equal((await runtime.runUntilYield('work')).kind, 'wait');
  assert.equal((await runtime.runUntilYield('work')).kind, 'wait');
  assert.equal((await runtime.state('work')).revision, revision);
  await runtime.command('work', 'wake', actor, 1, { kind: 'resolve', obligationId: 'reply', reason: 'reply received' });
  await plan(runtime);
  const snapshot = await runtime.state('work');
  snapshot.budget.used.toolCalls = snapshot.budget.limits.toolCalls;
  assert.equal(decide(snapshot, services.clock.now()).reason, 'tool_budget_exhausted');
  assert.equal(decide(snapshot, snapshot.deadlineAt).reason, 'deadline_exceeded');
  await runtime.command('work', 'cancel', actor, 1, { kind: 'cancel', reason: 'user stop' });
  assert.equal((await runtime.runUntilYield('work')).kind, 'cancelled');
});

test('only authorized current-goal commands mutate state; duplicate cancellation is stable', async () => {
  const { runtime } = await setup();
  await assert.rejects(runtime.command('work', 'bad', { ...actor, principalId: 'another' }, 1, { kind: 'cancel', reason: 'stop' }), /actor_not_authorized/);
  await assert.rejects(runtime.command('work', 'bad', actor, 9, { kind: 'pause', reason: 'hold' }), /stale_user_command/);
  await runtime.command('work', 'stop', actor, 1, { kind: 'cancel', reason: 'stop' });
  const revision = (await runtime.state('work')).revision;
  await runtime.command('work', 'stop', actor, 1, { kind: 'cancel', reason: 'stop' });
  assert.equal((await runtime.state('work')).revision, revision);
});

test('competing executors cannot both reserve or replay dispatch', async () => {
  const { runtime, services, tools, tool } = await setup(); await plan(runtime);
  const peer = new ExecutionRuntime(services, tools, 'worker-2', 1000);
  const attempts = await Promise.allSettled([runtime.reserve('work', 'read'), peer.reserve('work', 'read')]);
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
  const state = await runtime.state('work'); const attempt = state.attempts[0]!;
  const winner = attempt.owner === 'worker-1' ? runtime : peer;
  await Promise.all([winner.execute('work', attempt.id), winner.execute('work', attempt.id)]);
  assert.equal((tool as FixtureReadTool).invocations.length, 1);
  assert.equal((await runtime.state('work')).budget.used.toolCalls, 1);
});

for (const mode of ['cancel', 'goal'] as const) {
  test(`late tool result after ${mode} is recorded without adopting or reversing the command`, { timeout: 2000 }, async () => {
    let deliver!: (value: ToolResult) => void; let started!: (id: string) => void;
    const began = new Promise<string>(resolve => { started = resolve; });
    const delayed: Tool = { definition: new FixtureReadTool([]).definition, execute: async (_task, context) => {
      started(context.attemptId); return new Promise<ToolResult>(resolve => { deliver = resolve; });
    } };
    const { runtime, services } = await setup('documents-simple', delayed); await plan(runtime); const attempt = await runtime.reserve('work', 'read');
    const running = runtime.execute('work', attempt.id); await began;
    if (mode === 'cancel') await runtime.command('work', mode, actor, 1, { kind: 'cancel', reason: 'user stop' });
    else await runtime.command('work', mode, actor, 1, { kind: 'goal', expectedControlRevision: (await runtime.state('work')).executionControl?.revision ?? 1, goal: { ...docs.goal, revision: 2, description: 'changed request' } });
    await running;
    assert.deepEqual(runtime.pendingExecutions(), [attempt.id]);
    deliver(output(attempt.id)); await runtime.settlePending(attempt.id); await runtime.adopt('work', attempt.id);
    const state = await runtime.state('work');
    assert.equal(state.evidence.length, 0); assert.equal(state.attempts[0]!.adopted, false); assert.ok(state.attempts[0]!.resultArtifact);
    assert.equal(state.status, mode === 'cancel' ? 'cancelled' : 'ready');
    assert.equal(state.goal.revision, mode === 'cancel' ? 1 : 2);
    const eventCount = (await services.state.events('work', 0)).length;
    await runtime.receive('work', attempt.id, output(attempt.id));
    assert.equal((await services.state.events('work', 0)).length, eventCount);
    await assert.rejects(runtime.receive('work', attempt.id, { ...output(attempt.id), output: { changed: true } }), /result_identity_conflict/);
  });
}

for (const effect of ['read', 'write'] as const) {
  test(`expired dispatched ${effect} has bounded retry or explicit unknown effect`, async () => {
    const fixture = new FixtureReadTool(docs.evidence);
    const tool: Tool = { definition: { ...fixture.definition, effect }, execute: fixture.execute.bind(fixture) };
    const { runtime, services } = await setup('documents-simple', tool); await plan(runtime, [{ ...task(), effect }]);
    const attempt = await runtime.reserve('work', 'read'); await runtime.dispatch('work', attempt.id);
    services.clock.advance(1001); await runtime.recover('work', attempt.id);
    const state = await runtime.state('work');
    assert.equal(state.attempts[0]!.status, effect === 'read' ? 'failed' : 'unknown');
    const control = decide(state, services.clock.now());
    assert.equal(control.kind, effect === 'read' ? 'continue' : 'blocked');
    if (effect === 'write') {
      await assert.rejects(plan(runtime, [{ ...task([], 'renamed-write'), effect }]), /effect_unknown/);
      assert.equal(state.obligations[0]!.kind, 'effect_reconciliation');
    }
  });
}

test('invalid result identity, labels, references and output cannot become accepted evidence', async () => {
  const variants = [
    (r: ToolResult) => ({ ...r, attemptId: 'other-attempt' }),
    (r: ToolResult) => ({ ...r, output: 'wrong-output-shape' }),
    (r: ToolResult) => ({ ...r, evidence: [{ ...r.evidence[0]!, labels: ['restricted'] }] }),
    (r: ToolResult) => ({ ...r, evidence: [{ ...r.evidence[0]!, tenantId: 'another' }] }),
    (r: ToolResult) => ({ ...r, evidence: [{ ...r.evidence[0]!, derivedFrom: ['nonexistent'] }] }),
    (r: ToolResult) => ({ ...r, evidence: [{ ...r.evidence[0]!, derivedFrom: [r.evidence[0]!.id] }] }),
  ];
  for (const alter of variants) {
    const tool: Tool = { definition: new FixtureReadTool([]).definition, execute: async (_t, c) => alter(output(c.attemptId)) };
    const { runtime } = await setup('documents-simple', tool); await plan(runtime);
    assert.equal((await runtime.runUntilYield('work')).kind, 'replan');
    const state = await runtime.state('work'); assert.equal(state.evidence.length, 0);
    assert.equal(state.attempts[0]!.error?.code, 'invalid_tool_result');
  }
});

test('stored received result resumes in reopened SQLite and artifact stores without invoking tool again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-loop-')); const database = join(dir, 'state.sqlite');
  let repository = new SqliteStateRepository(database);
  try {
    const { runtime, services, tools, tool } = await setup('documents-simple', undefined, repository);
    runtime.services.artifacts = new FileArtifactStore(join(dir, 'objects'));
    await plan(runtime); const a = await runtime.reserve('work', 'read'); await runtime.execute('work', a.id);
    assert.equal((await runtime.state('work')).attempts[0]!.status, 'received');
    await repository.close(); repository = new SqliteStateRepository(database);
    const restored = new ExecutionRuntime({ ...services, state: repository, artifacts: new FileArtifactStore(join(dir, 'objects')) }, tools, 'worker-after-restart');
    assert.equal((await restored.runUntilYield('work')).kind, 'complete');
    assert.equal((tool as FixtureReadTool).invocations.length, 1);
    assert.equal((await restored.state('work')).budget.used.toolCalls, 1);
  } finally { await repository.close(); await rm(dir, { recursive: true, force: true }); }
});

test('tool JSON schema validation compiles once, rejects unsupported schema and preserves inputs', () => {
  const schemas = new AjvSchemas();
  assert.throws(() => schemas.compile({ type: 'object', typoKeyword: true }), /invalid_tool_schema/);
  assert.throws(() => schemas.compile({ $async: true, type: 'object' }), /invalid_tool_schema/);
  assert.throws(() => schemas.compile({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' }), /invalid_tool_schema/);
  const validate = schemas.compile({ type: 'object', properties: { n: { type: 'integer' } }, required: ['n'], additionalProperties: false });
  const value = { n: '3', extra: true }; assert.equal(validate(value), false); assert.deepEqual(value, { n: '3', extra: true });
});

test('successful dependency chain follows DAG order even when task array is reversed', async () => {
  const order: string[] = [];
  const tool: Tool = { definition: new FixtureReadTool([]).definition, execute: async (t, c) => {
    order.push(t.id); const r = output(c.attemptId); return t.id === 'prepare' ? { ...r, evidence: [] } : r;
  } };
  const { runtime } = await setup('documents-simple', tool);
  await plan(runtime, [{ ...task(['doc-current'], 'finish'), dependsOn: ['prepare'] }, task(['doc-current'], 'prepare')]);
  assert.equal((await runtime.runUntilYield('work')).kind, 'complete');
  assert.deepEqual(order, ['prepare', 'finish']);
});

test('pause before dispatch releases reservation; resume and repeated old pause do not cancel new execution', async () => {
  const { runtime } = await setup(); await plan(runtime, [{ ...task(), maxAttempts: 1 }]);
  await runtime.reserve('work', 'read');
  await runtime.command('work', 'pause', actor, 1, { kind: 'pause', reason: 'hold' });
  assert.equal((await runtime.state('work')).budget.reservedToolCalls, 0);
  await runtime.command('work', 'resume', actor, 1, { kind: 'resume', reason: 'continue' });
  await runtime.command('work', 'pause', actor, 1, { kind: 'pause', reason: 'hold' });
  assert.equal((await runtime.runUntilYield('work')).kind, 'complete');
  assert.equal((await runtime.state('work')).budget.used.toolCalls, 1);
});

test('tool failures retry only within attempt budget and repeated empty replans exhaust their own budget', async () => {
  let count = 0;
  const tool: Tool = { definition: new FixtureReadTool([]).definition, execute: async () => { count++; throw new Error('private provider body'); } };
  const { runtime, services } = await setup('documents-simple', tool); await plan(runtime);
  assert.equal((await runtime.runUntilYield('work')).reason, 'retry_backoff'); assert.equal(count, 1);
  services.clock.advance((await runtime.state('work')).progress!.policy.backoffMs);
  assert.equal((await runtime.runUntilYield('work')).kind, 'replan'); assert.equal(count, 2);
  for (let n = 0; n < 3; n++) await plan(runtime, []);
  assert.equal((await runtime.runUntilYield('work')).reason, 'replan_budget_exhausted');
  await assert.rejects(plan(runtime, []), /replan_budget_exhausted/);
  assert.equal((await runtime.state('work')).budget.used.replans, 3);
});

test('unconfirmed write is unknown and cannot satisfy the goal or be retried by a renamed task', async () => {
  const tool: Tool = { definition: { ...new FixtureReadTool([]).definition, effect: 'write' }, execute: async (_t, c) => output(c.attemptId) };
  const { runtime } = await setup('documents-simple', tool); await plan(runtime, [{ ...task(), effect: 'write' }]);
  assert.equal((await runtime.runUntilYield('work')).reason, 'effect_unknown');
  const state = await runtime.state('work'); assert.equal(state.evidence.length, 0); assert.equal(state.attempts[0]!.status, 'unknown');
  await assert.rejects(plan(runtime, [{ ...task(['doc-current'], 'another-write'), effect: 'write' }]), /effect_unknown/);
  await assert.rejects(runtime.command('work', 'waive', actor, 1, { kind: 'resolve', obligationId: state.obligations[0]!.id, reason: 'skip' }), /obligation_not_resolvable/);
});

test('lease timeout yields even for a tool that ignores cancellation; late result cannot finish the goal', { timeout: 2000 }, async () => {
  let finish!: (r: ToolResult) => void;
  const tool: Tool = { definition: new FixtureReadTool([]).definition, execute: async () => new Promise<ToolResult>(resolve => { finish = resolve; }) };
  const { runtime: initial, services, tools } = await setup('documents-simple', tool);
  const runtime = new ExecutionRuntime(services, tools, initial.owner, 20); await plan(runtime);
  const a = await runtime.reserve('work', 'read');
  await runtime.execute('work', a.id);
  assert.deepEqual(runtime.pendingExecutions(), [a.id]);
  services.clock.advance(21); await runtime.recover('work', a.id);
  finish(output(a.id)); await runtime.settlePending(a.id); await runtime.adopt('work', a.id);
  const state = await runtime.state('work'); assert.equal(state.evidence.length, 0); assert.equal(state.attempts[0]!.adopted, false);
  assert.equal(decide(state, services.clock.now()).kind, 'continue');
});

test('permission revocation after reservation is rechecked before dispatch and durably blocks execution', async () => {
  const { runtime, services, tool } = await setup(); await plan(runtime); await runtime.reserve('work', 'read');
  const state = await runtime.state('work'); const next = structuredClone(state); next.revision++; next.policy.allowedTools = [];
  await services.state.commit({ workId: 'work', expectedRevision: state.revision, commandId: 'revoke', commandDigest: 'revoke', next, events: [{ type: 'policy_revoked', at: next.updatedAt, data: {} }], deliveries: [] });
  assert.equal((await runtime.step('work')).reason, 'tool_permission_denied');
  assert.equal((await runtime.state('work')).budget.used.toolCalls, 0);
  assert.equal((await runtime.state('work')).budget.reservedToolCalls, 0);
  assert.equal((tool as FixtureReadTool).invocations.length, 0);
  assert.equal((await runtime.step('work')).kind, 'blocked');
});

for (const backend of ['memory', 'sqlite'] as const) {
  test(`${backend}: waiting execution wakes only for expired lease or received result`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runtime-wake-'));
    const repository = backend === 'sqlite' ? new SqliteStateRepository(join(dir, 'state.sqlite')) : new MemoryStateRepository();
    try {
      const { runtime, services } = await setup('documents-simple', undefined, repository); await plan(runtime);
      const a = await runtime.reserve('work', 'read'); await runtime.dispatch('work', a.id);
      assert.equal((await runtime.step('work')).kind, 'wait');
      assert.deepEqual(await repository.runnable(services.clock.now()), []);
      assert.deepEqual(await repository.runnable(a.leaseUntil), ['work']);
      await runtime.receive('work', a.id, output(a.id));
      assert.deepEqual(await repository.runnable(services.clock.now()), ['work']);
      assert.equal((await runtime.runUntilYield('work')).kind, 'complete');
    } finally { await repository.close(); await rm(dir, { recursive: true, force: true }); }
  });
}
