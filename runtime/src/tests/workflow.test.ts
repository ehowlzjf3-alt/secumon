import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WorkflowRuntime } from '../application/workflow-runtime.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { PlanningRuntime } from '../application/planning-runtime.js';
import { ConversationService } from '../application/conversation-service.js';
import { OutboxDispatcher } from '../application/outbox.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { validateScenario } from '../application/fixtures.js';
import { transact } from '../application/work-transactions.js';
import { FakeClock, FakeSink, FixtureReadTool, ScriptedPlanner } from '../infrastructure/fakes.js';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { Sha256Digester, RandomIds } from '../infrastructure/digest.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import type { MessageSink } from '../application/ports.js';

const actor = { tenantId: 'synthetic', principalId: 'learner' };
async function setup(family = 'documents-simple', sink: MessageSink = new FakeSink(), automatic = true) {
  const scenario = validateScenario(JSON.parse(readFileSync(new URL(`../../fixtures/${family}.json`, import.meta.url), 'utf8')));
  const source = family === 'documents-simple' ? 'doc-current' : 'collection-complete'; const tool = new FixtureReadTool(scenario.evidence);
  const planner = new ScriptedPlanner([packet => ({ status: 'ok', provider: 'scripted', model: 'fixture', inputTokens: 100, outputTokens: 30,
    proposal: { baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision, basePlanRevision: packet.plan?.revision ?? 0,
      reason: 'Read the declared synthetic source', hypotheses: [], tasks: [{ id: 'read-source', description: 'Read original', dependsOn: [], toolId: 'fixture.read', toolVersion: '1',
        input: { evidenceIds: [source] }, effect: 'read', maxAttempts: 2, satisfies: packet.goal.criteria.map(c => c.id) }] } })]);
  const services = { state: new MemoryStateRepository(), artifacts: new MemoryArtifactStore(), clock: new FakeClock(1788566400000),
    ids: new RandomIds(), digester: new Sha256Digester(), planner, tools: [tool], sink };
  const contracts = new ToolContracts([tool], new AjvSchemas()); const conversation = new ConversationService(services);
  const create = (owner: string) => {
    const execution = new ExecutionRuntime(services, contracts, owner); const planning = automatic ? new PlanningRuntime(services, contracts, execution, owner) : null;
    return { execution, planning, workflow: new WorkflowRuntime(services, execution, planning, conversation, new OutboxDispatcher(services, owner)) };
  };
  const current = create('first-owner');
  const request = { messageId: 'request-1', binding: { ...actor, channel: 'test' as const, conversationId: 'workflow-chat', recipientId: actor.principalId, destination: 'local' },
    goal: scenario.goal, policy: scenario.policy, limits: { toolCalls: 10, modelCalls: 4, tokens: 1000000, replans: 4, wallTimeMs: 120000 }, completionRequiresDelivery: true };
  const accepted = await current.workflow.accept(actor, request);
  return { ...current, services, planner, tool, conversation, create, request, workId: accepted.workId };
}

for (const family of ['documents-simple', 'observations-simple']) {
  test(`${family}: restarted workflow adopts a stored model response and reaches delivered completion without another planner call`, async () => {
    const sink = new FakeSink(); const f = await setup(family, sink); let observedSteps = 0;
    const first = await f.workflow.run(f.workId, actor, { maxSteps: 2, onStep: async () => { observedSteps++; } });
    assert.equal(first.control.kind, 'yield'); assert.equal(first.steps, 2); assert.equal(observedSteps, 2);
    assert.equal((await f.execution.state(f.workId)).modelCalls[0]!.status, 'received'); assert.equal(f.planner.inputs.length, 1);
    const resumed = f.create('second-owner'); const result = await resumed.workflow.run(f.workId, actor, { previousPacket: first.checkpoint });
    assert.equal(result.resumeDisposition, 'reused');
    assert.equal(result.control.kind, 'complete'); assert.equal((await resumed.execution.state(f.workId)).status, 'completed');
    assert.equal(f.planner.inputs.length, 1); assert.equal(f.tool.invocations.length, 1);
    assert.equal([...sink.delivered.values()].filter(d => d.kind === 'ack').length, 1);
    assert.equal([...sink.delivered.values()].filter(d => d.kind === 'result').length, 1);
    const repeated = await resumed.workflow.run(f.workId, actor); assert.equal(repeated.control.kind, 'complete');
    assert.equal(f.planner.inputs.length, 1); assert.equal(f.tool.invocations.length, 1);
  });
}

test('an unknown result delivery causes bounded waiting and only one receipt lookup on the next explicit run', async () => {
  const delivered = new FakeSink(); let sends = 0; let lookups = 0;
  const sink: MessageSink = { capabilities: { idempotentSend: true }, async send(d) {
    if (d.kind === 'result') { sends++; return { status: 'unknown' }; } return delivered.send(d);
  }, async lookup() { lookups++; return { status: 'unknown' }; } };
  const f = await setup('documents-simple', sink); const first = await f.workflow.run(f.workId, actor);
  assert.equal(first.control.kind, 'wait'); assert.equal(first.reason, 'result_delivery_pending'); assert.equal(sends, 1); assert.equal(lookups, 0);
  const resumed = await f.workflow.run(f.workId, actor, { maxSteps: 50 });
  assert.equal(resumed.control.kind, 'wait'); assert.equal(resumed.steps, 1); assert.equal(lookups, 1); assert.equal(sends, 1);
  assert.equal(f.planner.inputs.length, 1); assert.equal(f.tool.invocations.length, 1);
  assert.notEqual((await f.execution.state(f.workId)).status, 'completed');
});

test('a workflow without a planner returns a planning requirement and does not create an inferred plan', async () => {
  const f = await setup('documents-simple', new FakeSink(), false); const result = await f.workflow.run(f.workId, actor);
  assert.equal(result.control.kind, 'replan'); assert.equal(result.reason, 'plan_required'); assert.equal(result.steps, 1);
  assert.equal(f.planner.inputs.length, 0); assert.equal(f.tool.invocations.length, 0);
});

test('workflow entry requires the full persisted execution policy rather than a narrower read-only view', async () => {
  const f = await setup();
  for (const restriction of [{ allowedLabels: [] }, { allowedTools: [] }, { allowedDestinations: [] }]) {
    await assert.rejects(f.workflow.run(f.workId, { ...actor, ...restriction }), /workflow_policy_insufficient/);
  }
  await transact(f.services, f.workId, 'writes-enabled', 'policy_changed', {}, state => { state.policy.allowWrites = true; });
  await assert.rejects(f.workflow.run(f.workId, { ...actor, allowWrites: false }), /workflow_policy_insufficient/);
  await assert.rejects(f.workflow.accept({ ...actor, allowedTools: [] }, { ...f.request, messageId: 'not-accepted' }), /workflow_policy_insufficient/);
  await assert.rejects(f.workflow.run(f.workId, { ...actor, principalId: 'other' }), /work_unavailable/);
  assert.equal(f.planner.inputs.length, 0); assert.equal(f.tool.invocations.length, 0);
});

test('user cancellation between workflow steps preserves terminal state and cancels an unsent model reservation', async () => {
  const f = await setup(); let changed = false;
  const result = await f.workflow.run(f.workId, actor, { onStep: async () => {
    if (!changed) { changed = true; await f.execution.command(f.workId, 'cancel', actor, 1, { kind: 'cancel', reason: 'Stop the workflow' }); }
  } });
  assert.equal(result.control.kind, 'cancelled'); assert.equal(f.planner.inputs.length, 0); assert.equal(f.tool.invocations.length, 0);
  const state = await f.execution.state(f.workId); assert.equal(state.budget.reservedModelCalls, 0); assert.equal(state.budget.reservedTokens, 0);
  assert.equal(state.status, 'cancelled');
});

test('scoped actors cannot enter execution even when their current limits equal the work policy', async () => {
  const f = await setup(); const state = await f.execution.state(f.workId);
  await assert.rejects(f.workflow.run(f.workId, { ...actor, allowedTools: [...state.policy.allowedTools] }), /workflow_scoped_execution_not_supported/);
  assert.equal(f.planner.inputs.length, 0); assert.equal(f.tool.invocations.length, 0);
});

test('final checkpoint cannot report old completion when a goal change arrives during checkpoint storage', async () => {
  const f = await setup(); const put = f.services.artifacts.put.bind(f.services.artifacts); let changed = false;
  f.services.artifacts.put = async (bytes, attributes) => {
    const value = JSON.parse(new TextDecoder().decode(bytes).startsWith('{') ? new TextDecoder().decode(bytes) : '{}') as { kind?: string; runtime?: { status?: string } };
    if (!changed && value.kind === 'runtime_resume' && value.runtime?.status === 'completed') {
      changed = true; await f.execution.command(f.workId, 'new-goal-at-checkpoint', actor, 1, { kind: 'goal', expectedControlRevision: (await f.execution.state(f.workId)).executionControl?.revision ?? 1, goal: { ...f.request.goal, revision: 2, description: 'New goal' } });
    }
    return put(bytes, attributes);
  };
  const result = await f.workflow.run(f.workId, actor); assert.equal(changed, true); assert.notEqual(result.control.kind, 'complete');
  assert.equal((await f.execution.state(f.workId)).goal.revision, 2);
  const restored = await f.workflow.recovery.restore(f.workId, actor, result.checkpoint); assert.equal(restored.disposition, 'reused'); assert.equal(restored.packet.context.goal.revision, 2);
});
