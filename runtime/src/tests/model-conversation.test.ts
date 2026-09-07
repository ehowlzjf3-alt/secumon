import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ConversationService, resultProof } from '../application/conversation-service.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { PlanningRuntime } from '../application/planning-runtime.js';
import { OutboxDispatcher } from '../application/outbox.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { transact } from '../application/work-transactions.js';
import { validateScenario } from '../application/fixtures.js';
import { FakeClock, FakeSink, FixtureReadTool, ScriptedPlanner } from '../infrastructure/fakes.js';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { Sha256Digester, RandomIds } from '../infrastructure/digest.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';

const actor = { tenantId: 'synthetic', principalId: 'learner' };
const scenario = validateScenario(JSON.parse(readFileSync(new URL('../../fixtures/documents-simple.json', import.meta.url), 'utf8')));
async function setup() {
  const tool = new FixtureReadTool(scenario.evidence); const sink = new FakeSink();
  const planner = new ScriptedPlanner([packet => ({ status: 'ok', provider: 'scripted', model: 'fixture', inputTokens: 120, outputTokens: 60,
    proposal: { baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision, basePlanRevision: packet.plan?.revision ?? 0,
      reason: 'Existing observations still support the retained explanation', tasks: packet.plan?.tasks ?? [], hypotheses: packet.hypotheses } })]);
  const services = { state: new MemoryStateRepository(), artifacts: new MemoryArtifactStore(), clock: new FakeClock(1788566400000),
    ids: new RandomIds(), digester: new Sha256Digester(), tools: [tool], sink, planner };
  const tools = new ToolContracts([tool], new AjvSchemas()); const execution = new ExecutionRuntime(services, tools, 'executor');
  const conversation = new ConversationService(services); const outbox = new OutboxDispatcher(services, 'sender');
  const planning = new PlanningRuntime(services, tools, execution, 'planner');
  const { workId } = await conversation.accept(actor, { messageId: 'request', binding: { ...actor, channel: 'test', conversationId: 'model-chat', recipientId: actor.principalId, destination: 'local' },
    goal: scenario.goal, policy: scenario.policy, limits: { toolCalls: 10, modelCalls: 3, tokens: 100000, replans: 3, wallTimeMs: 60000 }, completionRequiresDelivery: true });
  await outbox.flush(workId, actor);
  const state = await execution.state(workId);
  await execution.submitPlan(workId, 'source-plan', { baseStateRevision: state.revision, baseGoalRevision: 1, basePlanRevision: 0, reason: 'Collect the current synthetic source', hypotheses: [],
    tasks: [{ id: 'source', description: 'Read the current source', dependsOn: [], toolId: 'fixture.read', toolVersion: '1', input: { evidenceIds: ['doc-current'] }, effect: 'read', maxAttempts: 1, satisfies: state.goal.criteria.map(c => c.id) }] });
  assert.equal((await execution.runUntilYield(workId)).kind, 'wait');
  return { services, execution, planning, conversation, outbox, tool, sink, workId };
}
async function requireReview(f: Awaited<ReturnType<typeof setup>>) {
  await transact(f.services, f.workId, 'review-required', 'hypothesis_introduced', {}, state => {
    state.hypotheses = [{ id: 'h1', question: 'Does the source apply to this comparison?', claim: 'The current source applies',
      predictedObservation: 'Current source contains the required facts', falsifier: 'A newer source withdraws those facts',
      status: 'supported', supportIds: ['doc-current'], counterIds: [], reason: 'Review the collected source against the proposed explanation' }];
    state.hypothesisAssessment = null; state.status = 'ready'; state.statusReason = 'hypothesis_review_required';
  });
}

test('verified facts remain visible while hypothesis review prevents response readiness and preparation', async () => {
  const f = await setup(); await requireReview(f);
  const state = await f.execution.state(f.workId); const proof = resultProof(state);
  assert.ok(proof.readiness.criteria.every(c => c.met)); assert.equal(proof.readiness.complete, false);
  assert.ok(proof.readiness.blockers.includes('hypothesis_review_required')); assert.deepEqual(proof.ids, ['doc-current']);
  assert.equal(await f.conversation.prepare(f.workId, actor), null);
  const snapshot = await f.conversation.snapshot(f.workId, actor); assert.equal(snapshot.analysisReady, false); assert.equal(snapshot.resultReady, false);
  assert.equal((await f.services.state.deliveries(f.workId)).filter(d => d.kind === 'result').length, 0); assert.equal(f.tool.invocations.length, 1);
});

test('reserved, running and stored model replies cannot produce a result; accepted review resumes preparation', async () => {
  const f = await setup(); await requireReview(f); const call = await f.planning.reserve(f.workId);
  async function assertWaiting(status: string) {
    const state = await f.execution.state(f.workId); assert.equal(state.modelCalls[0]!.status, status);
    const proof = resultProof(state); assert.ok(proof.readiness.criteria.every(c => c.met)); assert.equal(proof.readiness.complete, false);
    assert.ok(proof.readiness.blockers.includes('model_call_pending')); assert.equal(await f.conversation.prepare(f.workId, actor), null);
  }
  await assertWaiting('reserved'); await f.planning.dispatch(f.workId, call.id); await assertWaiting('running');
  const state = await f.execution.state(f.workId);
  await f.planning.receive(f.workId, call.id, { status: 'ok', provider: 'scripted', model: 'fixture', inputTokens: 120, outputTokens: 60,
    proposal: { baseStateRevision: call.baseStateRevision, baseGoalRevision: call.goalRevision, basePlanRevision: call.basePlanRevision,
      reason: 'The same facts remain sufficient after review', tasks: state.plan!.tasks, hypotheses: state.hypotheses } });
  await assertWaiting('received'); assert.equal(await f.planning.adopt(f.workId, call.id), true);
  assert.equal(resultProof(await f.execution.state(f.workId)).readiness.complete, true);
  const result = await f.conversation.prepare(f.workId, actor); assert.equal(result?.kind, 'result');
  await f.outbox.flush(f.workId, actor); assert.equal((await f.execution.runUntilYield(f.workId)).kind, 'complete');
  assert.equal(f.tool.invocations.length, 1); assert.equal([...f.sink.delivered.values()].filter(d => d.kind === 'result').length, 1);
});

test('pending model work suppresses question preparation while preserving existing obligation blockers', async () => {
  const f = await setup(); await requireReview(f); const call = await f.planning.reserve(f.workId);
  await f.execution.command(f.workId, 'clarify', actor, 1, { kind: 'wait', obligation: { id: 'clarification', kind: 'response', reason: 'Confirm the requested comparison scope',
    status: 'pending', wakeKey: 'clarification-reply', dueAt: null } });
  const proof = resultProof(await f.execution.state(f.workId));
  assert.ok(proof.readiness.blockers.includes('pending_obligation:clarification')); assert.ok(proof.readiness.blockers.includes('model_call_pending'));
  assert.equal(await f.conversation.prepare(f.workId, actor), null);
  await f.planning.recover(f.workId, call.id, true);
  assert.equal((await f.conversation.prepare(f.workId, actor))?.kind, 'question');
});

test('an already prepared result is withheld during review and can be prepared again after accepted model assessment', async () => {
  const f = await setup(); const original = await f.conversation.prepare(f.workId, actor); assert.equal(original?.kind, 'result');
  await requireReview(f); const call = await f.planning.reserve(f.workId);
  await f.outbox.flush(f.workId, actor);
  assert.equal([...f.sink.delivered.values()].filter(d => d.kind === 'result').length, 0);
  assert.equal((await f.services.state.deliveries(f.workId)).find(d => d.id === original!.id)!.status, 'superseded');
  assert.equal((await f.conversation.snapshot(f.workId, actor)).resultReady, false);
  await f.planning.execute(f.workId, call.id); assert.equal(await f.planning.adopt(f.workId, call.id), true);
  const resumed = await f.conversation.prepare(f.workId, actor); assert.equal(resumed?.id, original!.id);
  await f.outbox.flush(f.workId, actor);
  assert.equal([...f.sink.delivered.values()].filter(d => d.kind === 'result').length, 1); assert.equal(f.services.planner.inputs.length, 1);
  assert.equal(f.tool.invocations.length, 1); assert.equal((await f.execution.runUntilYield(f.workId)).kind, 'complete');
});
