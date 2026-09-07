import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { composeRuntime } from '../application/compose-runtime.js';
import { newWork } from '../application/new-work.js';
import { transact } from '../application/work-transactions.js';
import { refreshKnowledge, knowledgeInputsCurrent } from '../application/knowledge-state.js';
import { RESOURCE_TOOL_IDS } from '../application/resource-tools.js';
import { KNOWLEDGE_TOOL_IDS } from '../application/knowledge-tools.js';
import { ToolResultSchema } from '../application/contracts.js';
import type { StateRepository, Tool } from '../application/ports.js';
import type { RuntimeServices } from '../application/services.js';
import type { ContextPacket, Evidence, Goal, Policy, TaskSpec, ToolResult } from '../domain/model.js';
import type { TrustedKnowledgeActor } from '../domain/knowledge.js';
import { SqliteKnowledgeRepository } from '../infrastructure/sqlite-knowledge.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { FakeClock, FakeSink, FixtureReadTool, ScriptedPlanner } from '../infrastructure/fakes.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { adapters, openRepository, type Adapter } from './state-conformance-helpers.js';

const actor = { tenantId: 'synthetic', principalId: 'learner' };
const marker = 'RECALLED_SYNTHETIC_MEMORY_MARKER';
const goal: Goal = { revision: 1, description: 'Summarize a synthetic observation', scope: 'fixture', mode: 'auto', criteria: [
  { id: 'note', description: 'Observed note', key: 'note', operator: 'present', equals: null, minIndependentSources: 1, requireCompleteCoverage: true },
] };
const policy: Policy = { ...actor, allowedTools: ['fixture.read', 'fixture.effect', ...RESOURCE_TOOL_IDS, ...KNOWLEDGE_TOOL_IDS],
  allowedLabels: ['synthetic'], allowedDestinations: ['local'], allowWrites: true };
const limits = { toolCalls: 30, modelCalls: 10, tokens: 1000000, replans: 20, wallTimeMs: 1000000 };
const guidanceSource = { list: async () => [], read: async () => { throw new Error('no_fixture_guidance'); } };
const memory = (workId: string) => ({ id: 'remembered-note', commandId: 'create-note', namespace: 'team', scope: 'fixture', kind: 'experience' as const,
  title: 'Prior synthetic observation', body: marker, labels: [] as string[], sources: [{ workId, evidenceId: 'source' }], expiresAt: null });
function task(id: string, toolId: string, input: TaskSpec['input'], effect: TaskSpec['effect'] = 'read'): TaskSpec {
  return { id, description: 'Synthetic integration step', toolId, toolVersion: '1', input, effect, dependsOn: [], satisfies: [], maxAttempts: 1 };
}
async function setup(t: TestContext, adapter: Adapter, sameWork = false) {
  const directory = await mkdtemp(join(tmpdir(), 'knowledge-runtime-'));
  let states = openRepository(adapter, directory); let repository = new SqliteKnowledgeRepository(join(directory, 'knowledge.sqlite'));
  const artifacts = new FileArtifactStore(join(directory, 'artifacts'));
  const raw = await artifacts.put(new TextEncoder().encode(marker), { tenantId: actor.tenantId, labels: ['synthetic'], mediaType: 'text/plain' });
  const source: Evidence = { id: 'source', tenantId: actor.tenantId, scope: 'fixture', sourceId: 'synthetic-source', lineageId: 'synthetic-source', locator: 'fixture://source',
    observedAt: 1000, recordedAt: 1001, labels: ['synthetic'], coverage: 'complete', status: 'accepted', supersedes: [], derivedFrom: [], facts: { seed: true }, artifact: raw };
  const derived: Evidence = { ...source, id: 'derived-note', sourceId: 'synthetic-derived', lineageId: 'synthetic-derived', locator: 'fixture://derived', facts: { note: marker } };
  const readTool = new FixtureReadTool([derived]); const effects: string[] = [];
  const effectTool: Tool = { definition: { provider: 'fixture', id: 'fixture.effect', version: '1', description: 'Record a local synthetic effect count', effect: 'write',
    destination: 'local', labels: ['synthetic'], inputSchema: { type: 'object', properties: {}, additionalProperties: false }, outputSchema: { type: 'object' } },
    async execute(_task, context) { effects.push(context.attemptId); return { resultId: `${context.attemptId}:result`, attemptId: context.attemptId, status: 'success', effectState: 'confirmed',
      evidence: [], artifacts: [], output: { recorded: true }, error: null, cursor: null, coverage: 'complete' }; } };
  const trusted: TrustedKnowledgeActor = { ...actor, allowedLabels: ['synthetic'], allowedNamespaces: ['team'], allowedScopes: ['fixture'], canReview: false, canPublish: true };
  const actors = { current: async () => structuredClone(trusted) };
  const clock = new FakeClock(1100); const planner = new ScriptedPlanner([]); const sink = new FakeSink(); const digester = new Sha256Digester();
  const services = (state: StateRepository = states): RuntimeServices => ({ state, artifacts, clock, planner, sink, digester, ids: new RandomIds(), tools: [readTool, effectTool] });
  const compose = (withKnowledge = true, state: StateRepository = states) => composeRuntime({ services: services(state), schemas: new AjvSchemas(), guidanceSource, owner: 'memory-runtime',
    ...(withKnowledge ? { knowledge: { repository, actors } } : {}) });
  const c = await compose();
  const accepted = await c.conversation.accept(actor, { messageId: 'memory-integration', binding: { ...actor, recipientId: actor.principalId, channel: 'test', conversationId: 'memory-integration', destination: 'local' },
    goal, policy, limits, completionRequiresDelivery: true });
  const workId = accepted.workId; const sourceWorkId = sameWork ? workId : 'source-work';
  if (sameWork) await transact(c.services, workId, 'seed-source', 'source_seeded', {}, state => { state.evidence.push(source); });
  else {
    const state = newWork({ id: sourceWorkId, goal, policy, limits, now: clock.now() }); state.evidence = [source];
    assert.equal((await states.commit({ workId: sourceWorkId, expectedRevision: 0, commandId: 'source', commandDigest: 'source', next: state,
      events: [{ type: 'source_seeded', at: clock.now(), data: {} }], deliveries: [] })).kind, 'committed');
  }
  await c.knowledge!.create(memory(sourceWorkId));
  let commandNumber = 0;
  const plan = async (step: TaskSpec, runtime = c.runtime) => {
    const state = await runtime.state(workId);
    await runtime.submitPlan(workId, `plan-${++commandNumber}`, { baseStateRevision: state.revision, baseGoalRevision: state.goal.revision,
      basePlanRevision: state.plan?.revision ?? 0, reason: 'Explicit synthetic integration plan', tasks: [step], hypotheses: [] });
  };
  const run = async (step: TaskSpec) => {
    await plan(step); const attempt = await c.runtime.reserve(workId, step.id);
    await c.runtime.execute(workId, attempt.id); const state = await c.runtime.adopt(workId, attempt.id);
    assert.equal(state.attempts.find(a => a.id === attempt.id)?.adopted, true);
    return state.attempts.find(a => a.id === attempt.id)!;
  };
  const recall = () => run(task('recall', 'core.memory.get', { id: 'remembered-note', maxBytes: 8192 }));
  const copy = (attemptId: string) => run(task('copy', 'core.calls.get', { attemptId, maxBytes: 16384 }));
  const newGoal = async (requireFuture = false) => {
    const state = await c.runtime.state(workId);
    await c.runtime.command(workId, `new-goal-${++commandNumber}`, actor, state.goal.revision, { kind: 'goal', expectedControlRevision: state.executionControl?.revision ?? 1, goal: { ...state.goal, revision: state.goal.revision + 1,
      ...(requireFuture ? { criteria: [...state.goal.criteria, { id: 'future', description: 'A later observation', key: 'future', operator: 'present', equals: null, minIndependentSources: 1, requireCompleteCoverage: true }] } : {}) } });
  };
  const removeSource = () => c.dataLifecycle.change(sourceWorkId, actor, 'delete-source', { action: 'delete', evidenceIds: ['source'], expectedGeneration: 0,
    reason: 'Remove a synthetic source', replacement: null });
  const storedResult = async (attemptId: string): Promise<ToolResult> => {
    const state = await states.get(workId); const attempt = state!.attempts.find(a => a.id === attemptId)!;
    return ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(await artifacts.get(attempt.resultArtifact!, state!.policy))));
  };
  const reopen = async (withKnowledge: boolean) => {
    await states.close(); await repository.close(); states = openRepository(adapter, directory); repository = new SqliteKnowledgeRepository(join(directory, 'knowledge.sqlite'));
    return compose(withKnowledge);
  };
  t.after(async () => { await states.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); });
  return { c, directory, workId, sourceWorkId, source, derived, effects, readTool, planner, sink, artifacts, clock, compose, plan, run, recall, copy, newGoal, removeSource, storedResult, reopen,
    states: () => states, repository: () => repository };
}

for (const adapter of adapters) {
  test(`${adapter}: same-work recall survives dispatch, receipt and unrelated revision bookkeeping`, async t => {
    const h = await setup(t, adapter, true); const selected = task('recall', 'core.memory.get', { id: 'remembered-note', maxBytes: 8192 });
    await h.plan(selected); const attempt = await h.c.runtime.reserve(h.workId, selected.id);
    await h.c.runtime.execute(h.workId, attempt.id);
    const received = await h.c.runtime.state(h.workId); assert.equal(received.attempts[0]!.status, 'received');
    const result = await h.storedResult(attempt.id); assert.equal(result.knowledgeDependencies?.length, 1);
    assert.equal(result.knowledgeDependencies![0]!.sources[0]!.workId, h.workId);
    await transact(h.c.services, h.workId, 'diagnostic', 'diagnostic_recorded', {}, () => {});
    const adopted = await h.c.runtime.adopt(h.workId, attempt.id);
    assert.ok(adopted.revision > received.revision); assert.equal(adopted.attempts[0]!.adopted, true); assert.equal(adopted.dataLifecycle?.generation ?? 0, 0);
    assert.equal(await knowledgeInputsCurrent(h.c.services, adopted), true);
    const read = await h.c.resources.result(h.workId, actor, attempt.id, 16384); assert.ok(JSON.stringify(read).includes(marker));
  });

  test(`${adapter}: cross-work memory copy keeps custody across a goal change and blocks a prepared result after source deletion`, async t => {
    const h = await setup(t, adapter); const recalled = await h.recall(); const copied = await h.copy(recalled.id);
    const storedCopy = await h.storedResult(copied.id); assert.ok(JSON.stringify(storedCopy.output).includes(marker));
    assert.ok(storedCopy.knowledgeDependencies?.some(d => d.knowledgeId === 'remembered-note'));
    assert.doesNotMatch(JSON.stringify(storedCopy.output), /knowledgeDependencies|actorDigest|policyDigest/);
    await h.newGoal(); const derived = await h.run(task('derive', 'fixture.read', { evidenceIds: ['derived-note'] }));
    assert.ok(derived.knowledgeDependencies?.length);
    const prepared = await h.c.conversation.prepare(h.workId, actor); assert.equal(prepared?.kind, 'result'); assert.ok(prepared!.text.includes(marker));
    assert.equal((await h.c.resources.original(h.workId, actor, h.derived.id, 16384)).status, 'available');
    await h.removeSource();
    await assert.rejects(h.c.resources.original(h.workId, actor, h.derived.id, 16384), /resource_state_changed|evidence_unavailable/);
    await assert.rejects(h.c.resources.evidence(h.workId, actor, h.derived.id, 16384), /resource_state_changed|evidence_unavailable/);
    await h.c.outbox.flush(h.workId, actor);
    assert.equal([...h.sink.delivered.values()].some(d => d.id === prepared!.id), false);
    assert.equal((await h.c.conversation.snapshot(h.workId, actor)).resultReady, false);
    const fresh = await refreshKnowledge(h.c.services, h.workId); assert.equal(fresh.status, 'blocked');
    assert.ok(fresh.evidence.every(e => e.access === 'restricted' && Object.keys(e.facts).length === 0));
    const restored = await h.c.recovery.restore(h.workId, actor); assert.equal(JSON.stringify(restored.packet).includes(marker), false);
    await assert.rejects(h.c.resources.result(h.workId, actor, copied.id, 16384), /invocation_unavailable/);
  });

  test(`${adapter}: source deletion after a cross-goal copied memory cancels a reserved effect before invocation`, async t => {
    const h = await setup(t, adapter); const recalled = await h.recall(); await h.copy(recalled.id); await h.newGoal();
    const effect = task('effect', 'fixture.effect', {}, 'write'); await h.plan(effect);
    const attempt = await h.c.runtime.reserve(h.workId, effect.id); await h.removeSource();
    await assert.rejects(h.c.runtime.execute(h.workId, attempt.id), /attempt_not_dispatchable/);
    assert.deepEqual(h.effects, []); const state = await h.c.runtime.state(h.workId);
    assert.equal(state.status, 'blocked'); assert.equal(state.attempts.find(a => a.id === attempt.id)?.status, 'cancelled');
    assert.equal(state.budget.reservedToolCalls, 0); assert.equal(state.budget.used.toolCalls, 2);
    assert.equal((await h.c.runtime.step(h.workId)).kind, 'blocked'); assert.deepEqual(h.effects, []);
  });

  test(`${adapter}: stored model input contains recalled bodies while hiding internal custody metadata`, async t => {
    const h = await setup(t, adapter); const recalled = await h.recall(); await h.copy(recalled.id); await h.newGoal();
    const call = await h.c.planning!.reserve(h.workId); const state = await h.c.runtime.state(h.workId);
    const text = new TextDecoder().decode(await h.artifacts.get(call.inputArtifact, state.policy));
    const input = JSON.parse(text) as { packet: ContextPacket };
    assert.ok(input.packet.retrievedKnowledge?.entries.length); assert.ok(JSON.stringify(input.packet.retrievedKnowledge).includes(marker));
    assert.equal(input.packet.retrievedKnowledge!.interpretation, 'prior_observations_not_fresh_evidence');
    assert.doesNotMatch(text, /knowledgeDependencies|actorDigest|policyDigest|"sources"/);
    assert.equal(h.planner.inputs.length, 0); assert.equal(state.budget.used.modelCalls, 0); assert.equal(state.budget.reservedModelCalls, 1);
  });

  test(`${adapter}: reopening without a knowledge validator blocks retained originals and reserved effects`, async t => {
    const h = await setup(t, adapter); await h.recall(); await h.run(task('derive', 'fixture.read', { evidenceIds: ['derived-note'] }));
    await h.newGoal(true); const effect = task('effect', 'fixture.effect', {}, 'write'); await h.plan(effect);
    const pending = await h.c.runtime.reserve(h.workId, effect.id);
    const reopened = await h.reopen(false); assert.equal(reopened.knowledge, null); assert.equal(reopened.services.knowledge, undefined);
    assert.equal((await h.repository().get(actor.tenantId, 'remembered-note'))!.status, 'active');
    await assert.rejects(reopened.resources.original(h.workId, actor, h.derived.id, 16384), /resource_state_changed|evidence_unavailable/);
    assert.equal((await reopened.runtime.step(h.workId)).kind, 'blocked'); assert.deepEqual(h.effects, []);
    const state = await reopened.runtime.state(h.workId); assert.equal(state.attempts.find(a => a.id === pending.id)?.status, 'cancelled');
    assert.equal(state.budget.reservedToolCalls, 0); assert.equal((await reopened.conversation.snapshot(h.workId, actor)).resultReady, false);
    const packet = await reopened.recovery.restore(h.workId, actor); assert.equal(JSON.stringify(packet.packet).includes(marker), false);
  });

  test(`${adapter}: deleting another work's source while adopt commit waits quarantines the copied evidence before return`, async t => {
    const h = await setup(t, adapter); await h.recall(); const selected = task('derive', 'fixture.read', { evidenceIds: ['derived-note'] });
    await h.plan(selected); const attempt = await h.c.runtime.reserve(h.workId, selected.id); await h.c.runtime.execute(h.workId, attempt.id);
    let started!: () => void; let release!: () => void; let first = true;
    const paused = new Promise<void>(resolve => { started = resolve; }); const resumed = new Promise<void>(resolve => { release = resolve; });
    const port = new Proxy(h.states(), { get(target, key) {
      if (key === 'commit') return async (...args: Parameters<StateRepository['commit']>) => {
        if (first && args[0].workId === h.workId && args[0].commandId === `adopt:${attempt.id}`) { first = false; started(); await resumed; }
        return target.commit(...args);
      };
      const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const late = await h.compose(true, port); const pending = late.runtime.adopt(h.workId, attempt.id);
    await paused; await h.removeSource(); release();
    const state = await pending; assert.equal(state.status, 'blocked'); assert.equal(state.attempts.find(a => a.id === attempt.id)?.adopted, false);
    assert.ok(state.evidence.every(e => e.access === 'restricted' && Object.keys(e.facts).length === 0));
    await assert.rejects(late.resources.original(h.workId, actor, h.derived.id, 16384), /evidence_unavailable|resource_state_changed/);
    const packet = await late.recovery.restore(h.workId, actor); assert.equal(JSON.stringify(packet.packet).includes(marker), false);
  });
}
