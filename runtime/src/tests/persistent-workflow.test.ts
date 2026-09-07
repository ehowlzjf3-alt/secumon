import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ContextPacket, Hypothesis, TaskSpec } from '../domain/model.js';
import type { ModelReply } from '../application/ports.js';
import { validateScenario } from '../application/fixtures.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { PlanningRuntime } from '../application/planning-runtime.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { ConversationService } from '../application/conversation-service.js';
import { OutboxDispatcher } from '../application/outbox.js';
import { WorkflowRuntime } from '../application/workflow-runtime.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { FakeClock, FixtureReadTool, ScriptedPlanner } from '../infrastructure/fakes.js';
import { LocalChannel } from '../infrastructure/local-channel.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { adapters, openRepository, type Adapter } from './state-conformance-helpers.js';

const actor = { tenantId: 'synthetic', principalId: 'learner' };
const task = (id: string): TaskSpec => ({ id, description: 'Read the declared synthetic source', toolId: 'fixture.read', toolVersion: '1', input: { evidenceIds: [id] }, dependsOn: [], effect: 'read', maxAttempts: 2, satisfies: [] });
function scenarioReply(family: string, packet: ContextPacket): ModelReply {
  const known = new Set(packet.evidence.map(e => e.id)); let tasks: TaskSpec[]; let hypotheses: Hypothesis[] = [];
  if (family === 'documents-complex') {
    const base: Hypothesis = { id: 'period', question: 'What is the current period?', claim: 'Current period is 90', predictedObservation: 'Two current sources report 90', falsifier: 'A current source specifies 30', status: 'open', supportIds: [], counterIds: [], reason: 'Check source and amendment' };
    tasks = known.has('doc-a-old') ? ['doc-a-old', 'doc-b', 'doc-a-amendment'].map(task) : [task('doc-a-old')];
    hypotheses = [known.has('doc-a-amendment') ? { ...base, status: 'refuted', counterIds: ['doc-b', 'doc-a-amendment'] } : known.has('doc-b') ? { ...base, status: 'contested', supportIds: ['doc-a-old'], counterIds: ['doc-b'] } : known.has('doc-a-old') ? { ...base, status: 'supported', supportIds: ['doc-a-old'] } : base];
  } else if (family === 'observations-complex') {
    const base: Hypothesis = { id: 'approved', question: 'Is the observed change approved?', claim: 'The change is approved', predictedObservation: 'A matching authorization record exists', falsifier: 'A current denial or missing authorization record', status: 'open', supportIds: [], counterIds: [], reason: 'Check observation and authorization' };
    tasks = [task('signal'), task('maintenance-ticket')]; hypotheses = [known.has('maintenance-ticket') ? { ...base, status: 'supported', supportIds: ['maintenance-ticket'] } : base];
  } else tasks = [task(family === 'documents-simple' ? 'doc-current' : 'collection-complete')];
  return { status: 'ok', provider: 'scripted', model: 'fixture', inputTokens: 100, outputTokens: 50,
    proposal: { baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision, basePlanRevision: packet.plan?.revision ?? 0, reason: 'Deterministic synthetic proposal, not model inference', tasks, hypotheses } };
}
function open(adapter: Adapter, directory: string, family: string, owner: string) {
  const scenario = validateScenario(JSON.parse(readFileSync(new URL(`../../fixtures/${family}.json`, import.meta.url), 'utf8')));
  const state = openRepository(adapter, directory); const sink = new LocalChannel(join(directory, 'channel.sqlite'));
  const planner = new ScriptedPlanner(Array.from({ length: 10 }, () => (packet: ContextPacket) => scenarioReply(family, packet)));
  const tool = new FixtureReadTool(scenario.evidence); const services = { state, sink, planner, tools: [tool], artifacts: new FileArtifactStore(join(directory, 'artifacts')),
    clock: new FakeClock(1788566400000), ids: new RandomIds(), digester: new Sha256Digester() };
  const contracts = new ToolContracts([tool], new AjvSchemas()); const execution = new ExecutionRuntime(services, contracts, owner);
  const conversation = new ConversationService(services); const planning = new PlanningRuntime(services, contracts, execution, owner);
  return { scenario, services, planner, tool, execution, workflow: new WorkflowRuntime(services, execution, planning, conversation, new OutboxDispatcher(services, owner)),
    close: async () => { await state.close(); sink.close(); } };
}

for (const adapter of adapters) for (const family of ['documents-simple', 'documents-complex', 'observations-simple', 'observations-complex']) {
  test(`${adapter}/${family}: same model/tool/evidence/conversation workflow resumes on persistent state without a new model call for the stored reply`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'persistent-workflow-')); const first = open(adapter, dir, family, 'first'); let firstClosed = false;
    try {
      const accepted = await first.workflow.accept(actor, { messageId: 'persistent', binding: { ...actor, channel: 'test', conversationId: 'persistent', recipientId: actor.principalId, destination: 'local' },
        goal: first.scenario.goal, policy: first.scenario.policy, limits: { toolCalls: 20, modelCalls: 10, tokens: 1000000, replans: 5, wallTimeMs: 120000 }, completionRequiresDelivery: true });
      const partial = await first.workflow.run(accepted.workId, actor, { maxSteps: 2 }); assert.equal(partial.control.kind, 'yield');
      assert.equal((await first.execution.state(accepted.workId)).modelCalls[0]!.status, 'received'); assert.equal(first.planner.inputs.length, 1);
      await first.close(); firstClosed = true;
      const second = open(adapter, dir, family, 'second');
      try {
        const result = await second.workflow.run(accepted.workId, actor, { previousPacket: partial.checkpoint });
        assert.equal(result.control.kind, 'complete'); assert.equal(result.resumeDisposition, 'reused');
        const state = await second.execution.state(accepted.workId);
        const complex = family.endsWith('complex'); const expectedModels = complex ? (family === 'documents-complex' ? 4 : 3) : 1; const expectedTools = complex ? (family === 'documents-complex' ? 3 : 2) : 1;
        assert.equal(state.budget.used.modelCalls, expectedModels); assert.equal(state.budget.used.toolCalls, expectedTools);
        assert.equal(second.planner.inputs.length, expectedModels - 1); assert.equal(second.tool.invocations.length, expectedTools);
        if (family === 'documents-complex') { assert.equal(state.hypotheses[0]!.status, 'refuted'); assert.deepEqual(state.hypotheses[0]!.counterIds, ['doc-b', 'doc-a-amendment']); assert.equal(state.budget.used.replans, 1); }
        if (family === 'observations-complex') { assert.equal(state.hypotheses[0]!.status, 'supported'); assert.deepEqual(state.hypotheses[0]!.supportIds, ['maintenance-ticket']); }
        const messages = await second.services.sink.messages(actor, 'test', 'persistent'); assert.deepEqual(messages.map(m => m.kind), ['ack', 'result']);
        await second.workflow.run(accepted.workId, actor, { previousPacket: result.checkpoint });
        assert.equal((await second.execution.state(accepted.workId)).budget.used.modelCalls, expectedModels); assert.equal((await second.services.sink.messages(actor, 'test', 'persistent')).length, 2);
      } finally { await second.close(); }
    } finally { if (!firstClosed) await first.close(); await rm(dir, { recursive: true, force: true }); }
  });
}
