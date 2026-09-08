import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ArtifactRef, Evidence, TaskSpec } from '../domain/model.js';
import type { TrustedKnowledgeActor } from '../domain/knowledge.js';
import type { ArtifactStore, StateRepository, Tool } from '../application/ports.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { PlanningRuntime } from '../application/planning-runtime.js';
import { RESOURCE_TOOL_IDS } from '../application/resource-tools.js';
import { KNOWLEDGE_TOOL_IDS } from '../application/knowledge-tools.js';
import { knowledgeInputsCurrent } from '../application/knowledge-validity.js';
import { transact } from '../application/work-transactions.js';
import { artifactBlocked } from '../domain/data-lifecycle.js';
import { SqliteKnowledgeRepository } from '../infrastructure/sqlite-knowledge.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { Sha256Digester, RandomIds } from '../infrastructure/digest.js';
import { FakeClock, FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { adapters, command, initial, openRepository, type Adapter } from './state-conformance-helpers.js';

const actor = { tenantId: 'tenant-a', principalId: 'person-a' };
const marker = 'SYNTHETIC_CONTEXT_RESERVATION_MEMORY';
function task(id: string, toolId: string, input: TaskSpec['input'], toolVersion = '1'): TaskSpec {
  return { id, description: 'Synthetic context reservation boundary', toolId, toolVersion, input, dependsOn: [], effect: 'read', maxAttempts: 1, satisfies: [] };
}
function statePort(backing: StateRepository, overrides: Partial<StateRepository>): StateRepository {
  return { get: backing.get.bind(backing), receipt: backing.receipt.bind(backing), commit: backing.commit.bind(backing), events: backing.events.bind(backing),
    eventPage: backing.eventPage.bind(backing), recentEventMetadata: backing.recentEventMetadata.bind(backing), conversationWorkPage: backing.conversationWorkPage.bind(backing),
    deliveries: backing.deliveries.bind(backing), workIdsForConversation: backing.workIdsForConversation.bind(backing), runnable: backing.runnable.bind(backing), close: backing.close.bind(backing), ...overrides };
}
async function fixture(t: TestContext, adapter: Adapter) {
  const directory = await mkdtemp(join(tmpdir(), 'context-reservation-'));
  const state = openRepository(adapter, directory); const repository = new SqliteKnowledgeRepository(join(directory, 'knowledge.sqlite'));
  t.after(async () => { await state.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); });
  const artifacts = new FileArtifactStore(join(directory, 'artifacts')); const planner = new ScriptedPlanner([]);
  const clock = new FakeClock(1100); const versions: Tool[] = ['1', '2'].map(version => ({
    definition: { provider: 'fixture', id: 'fixture.versioned', version, description: `Synthetic version ${version}`, effect: 'read', destination: 'local', labels: ['synthetic'],
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, outputSchema: { type: 'object' } },
    execute: async () => { throw new Error('versioned_tool_must_not_execute'); },
  }));
  const work = initial('consumer'); work.policy.allowedTools = ['fixture.versioned', ...RESOURCE_TOOL_IDS, ...KNOWLEDGE_TOOL_IDS];
  work.budget.limits = { toolCalls: 20, modelCalls: 10, tokens: 1000000, replans: 20, wallTimeMs: 60000 };
  assert.equal((await state.commit(command(work, 'seed-consumer'))).kind, 'committed');
  const sourceWork = initial('source-work');
  const original = await artifacts.put(Buffer.from(marker), { tenantId: actor.tenantId, labels: ['synthetic'], mediaType: 'text/plain' });
  const source: Evidence = { id: 'source', tenantId: actor.tenantId, scope: 'fixture', sourceId: 'synthetic-source', lineageId: 'synthetic-source', locator: 'fixture:source',
    observedAt: 1000, recordedAt: 1000, labels: ['synthetic'], coverage: 'complete', status: 'accepted', supersedes: [], derivedFrom: [], facts: { seed: true }, artifact: original };
  sourceWork.evidence = [source]; assert.equal((await state.commit(command(sourceWork, 'seed-source'))).kind, 'committed');
  const trusted: TrustedKnowledgeActor = { ...actor, allowedLabels: ['synthetic'], allowedNamespaces: ['local'], allowedScopes: ['fixture'], canReview: false, canPublish: false };
  const c = await composeRuntime({ services: { state, artifacts, planner, tools: versions, clock, digester: new Sha256Digester(), ids: new RandomIds(), sink: new FakeSink() },
    schemas: new AjvSchemas(), guidanceSource: { list: async () => [], read: async () => { throw new Error('no_guidance'); } }, owner: 'context-reservation',
    knowledge: { repository, actors: { current: async () => structuredClone(trusted) } } });
  let serial = 0;
  const plan = async (step: TaskSpec) => {
    const current = (await state.get(work.id))!;
    await c.runtime.submitPlan(work.id, `plan-${++serial}`, { baseStateRevision: current.revision, baseGoalRevision: current.goal.revision,
      basePlanRevision: current.plan?.revision ?? 0, reason: 'Synthetic context test plan', tasks: [step], hypotheses: [] });
  };
  const run = async (step: TaskSpec) => {
    await plan(step); const attempt = await c.runtime.reserve(work.id, step.id); await c.runtime.execute(work.id, attempt.id); await c.runtime.adopt(work.id, attempt.id);
    assert.equal((await state.get(work.id))!.attempts.find(a => a.id === attempt.id)!.adopted, true); return attempt.id;
  };
  const recall = async () => {
    await c.knowledge!.create({ id: 'remembered-source', commandId: 'remember-source', namespace: 'local', scope: 'fixture', kind: 'experience', title: 'Synthetic source',
      body: marker, labels: [], sources: [{ workId: sourceWork.id, evidenceId: source.id }], expiresAt: null });
    await run(task('recall', 'core.memory.get', { id: 'remembered-source', maxBytes: 8192 }));
    const current = (await state.get(work.id))!;
    assert.ok(current.attempts.some(a => a.knowledgeDependencies?.length)); assert.equal(await knowledgeInputsCurrent(c.services, current), true);
  };
  const removeSource = () => c.dataLifecycle.change(sourceWork.id, actor, 'remove-source', { action: 'delete', evidenceIds: [source.id], expectedGeneration: 0,
    reason: 'Synthetic source deletion at a reservation boundary', replacement: null });
  return { c, state, artifacts, planner, directory, workId: work.id, sourceWorkId: sourceWork.id, plan, run, recall, removeSource };
}

for (const adapter of adapters) {
  test(`${adapter}: source deletion during the context head exists check prevents reservation and head publication`, async t => {
    const f = await fixture(t, adapter); await f.recall(); const before = (await f.state.get(f.workId))!;
    let candidate: ArtifactRef | undefined; let fired = false;
    const artifacts: ArtifactStore = { get: f.artifacts.get.bind(f.artifacts),
      put: async (bytes, attributes) => {
        const ref = await f.artifacts.put(bytes, attributes);
        if (JSON.parse(new TextDecoder().decode(bytes))['kind'] === 'model_context') candidate = ref;
        return ref;
      },
      exists: async ref => {
        const available = await f.artifacts.exists(ref);
        if (ref.id === candidate?.id && !fired) { fired = true; assert.equal(available, true); await f.removeSource(); }
        return available;
      },
    };
    const planning = new PlanningRuntime({ ...f.c.services, artifacts }, f.c.contracts, f.c.runtime, 'context-reservation');
    await assert.rejects(planning.reserve(f.workId), /context_state_changed/);
    assert.equal(fired, true); assert.ok(candidate); assert.equal(await f.artifacts.exists(candidate), true);
    assert.deepEqual(await f.state.get(f.workId), before);
    assert.equal((await f.state.events(f.workId, 0)).some(e => e.type === 'model_call_reserved'), false);
    assert.equal((await f.state.get(f.sourceWorkId))!.evidence[0]!.access, 'deleted'); assert.deepEqual(f.planner.inputs, []);
  });

  test(`${adapter}: source deletion inside repository commit retires the published head and cancels the model reservation before returning`, async t => {
    const f = await fixture(t, adapter); await f.recall(); let candidate: ArtifactRef | undefined; let fired = false;
    const state = statePort(f.state, { commit: async request => {
      const result = await f.state.commit(request);
      if (!fired && request.workId === f.workId && request.events.some(e => e.type === 'model_call_reserved') && result.kind === 'committed') {
        fired = true; candidate = result.state.contextHead?.artifact; assert.ok(candidate);
        assert.equal(result.state.modelCalls[0]!.status, 'reserved'); await f.removeSource();
      }
      return result;
    } });
    const planning = new PlanningRuntime({ ...f.c.services, state }, f.c.contracts, f.c.runtime, 'context-reservation');
    await assert.rejects(planning.reserve(f.workId), /context_state_changed/);
    assert.equal(fired, true); assert.ok(candidate); const current = (await f.state.get(f.workId))!;
    assert.equal(current.contextHead, null); assert.equal(current.dataLifecycle!.generation, 1); assert.equal(artifactBlocked(current, candidate), true);
    assert.equal(current.modelCalls.length, 1); assert.equal(current.modelCalls[0]!.status, 'cancelled'); assert.equal(current.modelCalls[0]!.usageStatus, 'not_called');
    assert.equal(artifactBlocked(current, current.modelCalls[0]!.inputArtifact), true);
    assert.equal(current.budget.reservedModelCalls, 0); assert.equal(current.budget.reservedTokens, 0); assert.equal(current.budget.used.modelCalls, 0);
    assert.deepEqual((await f.state.events(f.workId, 0)).filter(e => ['model_call_reserved', 'knowledge_dependencies_invalidated'].includes(e.type)).map(e => e.type),
      ['model_call_reserved', 'knowledge_dependencies_invalidated']);
    assert.deepEqual(f.planner.inputs, []);
  });

  test(`${adapter}: losing the prior frame does not turn an old catalog request into a conflict with the current task version`, async t => {
    const f = await fixture(t, adapter);
    await f.run(task('load-v1', 'core.catalog.get', { id: 'fixture.versioned', version: '1', maxBytes: 8192 }));
    const limits = { callId: 'initial-context', maxOutputTokens: 128, maxInputBytes: 65536, maxInputTokens: 100000 };
    const initialFrame = await f.c.context.prepare((await f.state.get(f.workId))!, limits);
    await transact(f.c.services, f.workId, 'publish-context', 'context_compacted', {}, current => {
      assert.equal(current.revision, initialFrame.head.basisRevision); current.contextHead = initialFrame.head;
    });
    await f.plan(task('pending-v2', 'fixture.versioned', {}, '2')); const before = (await f.state.get(f.workId))!;
    const present = await f.c.context.prepare(before, { ...limits, callId: 'with-prior-frame' });
    assert.deepEqual(present.options.tools.filter(tool => tool.id === 'fixture.versioned').map(tool => tool.version), ['2']);
    await rm(join(f.directory, 'artifacts', `${initialFrame.head.artifact.id}.blob`));
    const regenerated = await f.c.context.prepare(before, { ...limits, callId: 'without-prior-frame' });
    assert.deepEqual(regenerated.options.tools.filter(tool => tool.id === 'fixture.versioned').map(tool => tool.version), ['2']);
    assert.equal(regenerated.frame.memo.cycle, 1); assert.equal(regenerated.head.basisRevision, before.revision);
    assert.deepEqual(regenerated.packet.plan, present.packet.plan); assert.deepEqual(await f.state.get(f.workId), before); assert.deepEqual(f.planner.inputs, []);
  });
}
