import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactRef, Evidence, TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import type { ArtifactStore, StateRepository, Tool } from '../application/ports.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { ToolResultSchema } from '../application/contracts.js';
import { RESOURCE_TOOL_IDS } from '../application/resource-tools.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { FakeClock, FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { StructuredPlannerAdapter, type StructuredPlannerRequest } from '../infrastructure/structured-planner.js';
import { IoMeter } from './read-collection-io-helpers.js';
import { adapters, command, initial, openRepository, type Adapter } from './state-conformance-helpers.js';

const workId = 'resource-io';
const marker = 'SYNTHETIC_ORIGINAL_RESOURCE_BODY';
const text = `${marker}\n${'Original record. '.repeat(100)}`;
const encoder = new TextEncoder();
const limits = { callId: 'io-context', maxOutputTokens: 512, maxInputBytes: 1024 * 1024, maxInputTokens: 2 * 1024 * 1024 };
function task(id: string, toolId: string, input: TaskSpec['input']): TaskSpec {
  return { id, description: id, toolId, toolVersion: '1', input, effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: [] };
}
class HookedArtifacts implements ArtifactStore {
  afterGet: ((ref: ArtifactRef) => Promise<void>) | null = null;
  afterExists: ((ref: ArtifactRef) => Promise<void>) | null = null;
  afterPut: ((ref: ArtifactRef) => Promise<void>) | null = null;
  readonly gets: string[] = [];
  constructor(readonly backing: ArtifactStore) {}
  get: ArtifactStore['get'] = async (ref, policy) => {
    const body = await this.backing.get(ref, policy); this.gets.push(ref.id); await this.afterGet?.(ref); return body;
  };
  exists: ArtifactStore['exists'] = async ref => {
    const found = await this.backing.exists(ref); await this.afterExists?.(ref); return found;
  };
  put: ArtifactStore['put'] = async (body, attributes) => {
    const ref = await this.backing.put(body, attributes); await this.afterPut?.(ref); return ref;
  };
}
async function setup(t: TestContext, adapter: Adapter, copies = 0) {
  const directory = await mkdtemp(join(tmpdir(), 'resource-io-'));
  const repository = openRepository(adapter, directory); const meter = new IoMeter();
  t.after(async () => { await repository.close(); await rm(directory, { recursive: true, force: true }); });
  const fileArtifacts = new FileArtifactStore(join(directory, 'artifacts'));
  const artifacts = new HookedArtifacts(meter.artifacts(fileArtifacts));
  const stateHooks: { afterGet: ((value: WorkState | null) => Promise<void>) | null } = { afterGet: null };
  const measuredState = meter.state(repository);
  const state: StateRepository = new Proxy(measuredState, { get(target, property) {
    if (property === 'get') return async (id: string) => { const value = await target.get(id); await stateHooks.afterGet?.(value); return value; };
    const value: unknown = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const seed = initial(workId); seed.policy.allowedTools = ['fixture.read', ...RESOURCE_TOOL_IDS];
  seed.budget.limits = { ...seed.budget.limits, toolCalls: 20, modelCalls: 4, tokens: 10000000, replans: 10 };
  const original = await artifacts.put(encoder.encode(text), { tenantId: seed.policy.tenantId, labels: ['synthetic'], mediaType: 'text/plain' });
  const evidence: Evidence[] = Array.from({ length: 4 }, (_, index) => ({ id: `source-evidence-${index}`, tenantId: seed.policy.tenantId,
    scope: seed.goal.scope, sourceId: `source-${index}`, lineageId: `lineage-${index}`, locator: `fixture://io/${index}`,
    observedAt: 1000, recordedAt: 1000, labels: ['synthetic'], coverage: 'complete', status: 'accepted', supersedes: [], derivedFrom: [],
    facts: { detail: marker, index }, artifact: original }));
  let calls = 0;
  const source: Tool = { definition: { provider: 'fixture', id: 'fixture.read', version: '1', description: 'Read a shared original artifact',
    inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object' }, effect: 'read', destination: 'local', labels: ['synthetic'] },
  async execute(_task, context) { calls++; return { resultId: `${context.attemptId}:result`, attemptId: context.attemptId, status: 'success', effectState: 'none',
    evidence: structuredClone(evidence), artifacts: [original], output: { body: text }, error: null, cursor: null, coverage: 'complete' }; } };
  assert.equal((await state.commit(command(seed, 'seed'))).kind, 'committed');
  const composed = await composeRuntime({ services: { state, artifacts, clock: new FakeClock(1000), tools: [source], planner: new ScriptedPlanner([]),
    ids: new RandomIds(), digester: new Sha256Digester(), sink: new FakeSink() }, schemas: new AjvSchemas(),
    guidanceSource: { list: async () => [], read: async () => { throw new Error('no_guidance'); } }, owner: 'resource-io', enablePlanning: false });
  const run = async (selected: TaskSpec) => {
    const current = await composed.runtime.state(workId);
    await composed.runtime.submitPlan(workId, `plan:${selected.id}`, { baseStateRevision: current.revision, baseGoalRevision: current.goal.revision,
      basePlanRevision: current.plan?.revision ?? 0, reason: 'Verify original and copied resource I/O', tasks: [selected], hypotheses: [] });
    const reserved = await composed.runtime.reserve(workId, selected.id);
    await composed.runtime.execute(workId, reserved.id); await composed.runtime.adopt(workId, reserved.id);
    const after = await composed.runtime.state(workId); const attempt = after.attempts.find(a => a.id === reserved.id)!;
    assert.equal(attempt.adopted, true); assert.ok(attempt.resultArtifact);
    const result = ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(await artifacts.get(attempt.resultArtifact, after.policy))));
    return { attempt, result, task: selected };
  };
  const chain = [await run(task('source', source.definition.id, {}))];
  for (let index = 0; index < copies; index++) chain.push(await run(task(`copy-${index + 1}`, 'core.calls.get', { attemptId: chain.at(-1)!.attempt.id, maxBytes: 65536 })));
  const current = await composed.runtime.state(workId); artifacts.gets.length = 0;
  return { ...composed, state, stateHooks, directory, meter, artifacts, fileArtifacts, original, evidence, source, chain, policy: current.policy, calls: () => calls };
}
type Harness = Awaited<ReturnType<typeof setup>>;
const blob = (h: Harness) => join(h.directory, 'artifacts', `${h.original.id}.blob`);
function originalFrom(result: ToolResult): ToolResult {
  let current = result;
  while (current.evidence.length === 0) {
    const output = current.output as unknown as { value: { result: ToolResult } };
    assert.ok(output.value?.result); current = output.value.result;
  }
  return current;
}

for (const adapter of adapters) {
  test(`${adapter}: text originals use one verified body read and no cross-call availability cache`, async t => {
    const h = await setup(t, adapter); const source = h.evidence[0]!;
    const { value, measurement } = await h.meter.measure('original', () => h.resources.original(workId, h.policy, source.id, 65536));
    assert.equal(value.status, 'available'); assert.ok('content' in value); assert.equal(value.content, text);
    assert.equal(value.observedAt, source.observedAt); assert.equal(value.locator, source.locator); assert.deepEqual(value.artifact, h.original);
    assert.equal(measurement.artifactApi.get.calls, 1); assert.equal(measurement.artifactApi.exists.calls, 0);
    assert.equal(measurement.physical?.['bodyReadOperations'], 1); assert.equal(measurement.physical?.['bodyReadBytes'], h.original.byteLength);
    assert.equal(measurement.physical?.['hashCalls'], 1); assert.equal(measurement.physical?.['hashBytes'], h.original.byteLength);
    const again = await h.meter.measure('original-again', () => h.resources.original(workId, h.policy, source.id, 65536));
    assert.deepEqual(again.value, value); assert.equal(again.measurement.artifactApi.get.calls, 1);
    await writeFile(blob(h), Buffer.alloc(h.original.byteLength, 88));
    await assert.rejects(h.resources.original(workId, h.policy, source.id, 65536), /evidence_unavailable/);
    t.diagnostic(JSON.stringify({ adapter, operation: 'original', ...measurement }));
  });

  test(`${adapter}: one result materialization deduplicates repeated originals and preserves a final real verification`, async t => {
    const h = await setup(t, adapter); const source = h.chain[0]!;
    const { value, measurement } = await h.meter.measure('result', () => h.resources.resultWithDependencies(workId, h.policy, source.attempt.id, 65536));
    assert.deepEqual(value.materialized.result, source.result); assert.deepEqual(value.materialized.task, source.task);
    assert.equal(value.materialized.dispatchRevision, (await h.state.receipt(workId, `dispatch:${source.attempt.id}`))!.state.revision);
    assert.deepEqual(value.materialized.reads, { artifacts: 2, receipts: 1, parses: 1 });
    assert.equal(value.materialized.verifiedArtifacts.length, 2);
    assert.equal(h.artifacts.gets.filter(id => id === h.original.id).length, 1);
    assert.equal(measurement.artifactApi.get.calls, 2); assert.equal(measurement.artifactApi.exists.calls, 1);
    assert.equal(measurement.physical?.['bodyReadOperations'], 3);
    assert.equal(measurement.physical?.['bodyReadBytes'], source.attempt.resultArtifact!.byteLength + 2 * h.original.byteLength);
    assert.equal(measurement.physical?.['hashCalls'], 3); assert.equal(measurement.stateApi.receipt, 1);
    assert.equal(value.output.status, 'available'); assert.doesNotMatch(JSON.stringify(value.output), /materialized|sourceTasks|dispatchRevision|verifiedArtifacts/);
    assert.deepEqual(value.materialized.result.evidence.map(e => ({ id: e.id, observedAt: e.observedAt, recordedAt: e.recordedAt })),
      h.evidence.map(e => ({ id: e.id, observedAt: e.observedAt, recordedAt: e.recordedAt })));
    t.diagnostic(JSON.stringify({ adapter, operation: 'result', ...measurement }));
  });

  test(`${adapter}: a two-copy chain decodes and reads each dispatch once per materialization`, async t => {
    const h = await setup(t, adapter, 2); const last = h.chain.at(-1)!;
    const { value, measurement } = await h.meter.measure('copy-chain', () => h.resources.resultWithDependencies(workId, h.policy, last.attempt.id, 65536));
    assert.deepEqual(value.materialized.result, last.result); assert.deepEqual(value.materialized.task, last.task);
    assert.deepEqual(value.materialized.sourceTasks, [...h.chain].reverse().map(item => ({ attemptId: item.attempt.id, task: item.task })));
    assert.deepEqual(value.materialized.reads, { artifacts: 4, receipts: 3, parses: 3 });
    assert.equal(measurement.stateApi.receipt, 3); assert.equal(measurement.artifactApi.get.calls, 4); assert.equal(measurement.artifactApi.exists.calls, 1);
    assert.deepEqual(originalFrom(value.materialized.result), h.chain[0]!.result); assert.equal(h.calls(), 1);
    t.diagnostic(JSON.stringify({ adapter, operation: 'copy-chain', ...measurement }));
  });

  test(`${adapter}: context uses verified copy materialization without rereading its dispatch pair`, async t => {
    const h = await setup(t, adapter, 2); const state = await h.runtime.state(workId);
    const { value, measurement } = await h.meter.measure('context', () => h.context.prepare(state, limits));
    assert.equal(measurement.stateApi.receipt, 6); // source + first copy's two sources + second copy's three sources.
    assert.equal(measurement.artifactApi.get.calls, 9); // Eight source reads plus the staged context frame's mandatory readback.
    assert.equal(h.artifacts.gets.filter(id => id === value.head.artifact.id).length, 1);
    assert.equal(h.artifacts.gets.filter(id => id !== value.head.artifact.id).length, 8);
    assert.ok(measurement.artifactApi.exists.calls >= 4); // Reused source/result references are checked after staging.
    for (const entry of h.chain) {
      const observation = value.packet.toolObservations?.find(o => o.attemptId === entry.attempt.id); assert.ok(observation);
      assert.equal(observation.representation, 'full'); assert.deepEqual(observation.output, entry.result.output); assert.deepEqual(observation.input, entry.task.input);
    }
    assert.deepEqual(value.packet.evidence.map(e => ({ id: e.id, observedAt: e.observedAt })), h.evidence.map(e => ({ id: e.id, observedAt: e.observedAt })));
    assert.doesNotMatch(JSON.stringify(value.packet), /materialized|sourceTasks|dispatchRevision|verifiedArtifacts|actorDigest/);
    const requests: StructuredPlannerRequest[] = [];
    const planner = new StructuredPlannerAdapter({ identity: { provider: 'local-fixture', model: 'wire-recorder', revision: '1' }, destination: 'local',
      capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 2 * 1024 * 1024 }, maxRequestBytes: 4 * 1024 * 1024 }, {
      async invoke(request) { requests.push(structuredClone(request)); return { finish: 'refused', content: null, usage: { inputTokens: 0, outputTokens: 0 },
        provider: 'local-fixture', model: 'wire-recorder' }; },
    });
    await planner.propose(value.packet, new AbortController().signal, value.options);
    assert.equal(requests.length, 1); assert.deepEqual(requests[0]!.packet, value.packet);
    assert.doesNotMatch(JSON.stringify(requests), /materialized|sourceTasks|dispatchRevision|verifiedArtifacts|actorDigest/);
    assert.deepEqual(await h.runtime.state(workId), state); assert.equal(h.calls(), 1);
    t.diagnostic(JSON.stringify({ adapter, operation: 'context', ...measurement }));
  });

  test(`${adapter}: adapter argument mutation and returned metadata cannot change private reference snapshots`, async t => {
    const h = await setup(t, adapter, 1); const last = h.chain.at(-1)!;
    const sourceIds = new Set([h.original.id, ...h.chain.map(item => item.attempt.resultArtifact!.id)]);
    const mutateArgument = async (ref: ArtifactRef) => { if (sourceIds.has(ref.id)) { ref.labels.push('port-mutation'); ref.byteLength = 0; } };
    h.artifacts.afterGet = mutateArgument; h.artifacts.afterExists = mutateArgument;
    const first = await h.resources.resultWithDependencies(workId, h.policy, last.attempt.id, 65536);
    assert.deepEqual(first.materialized.result, last.result); assert.deepEqual(first.materialized.task, last.task);
    first.materialized.result.output = { changed: true }; first.materialized.task.input = { changed: true };
    first.materialized.sourceTasks[0]!.task.input = { changed: true };
    first.materialized.verifiedArtifacts[0]!.labels.push('caller-mutation');
    const second = await h.resources.resultWithDependencies(workId, h.policy, last.attempt.id, 65536);
    assert.deepEqual(second.materialized.result, last.result); assert.deepEqual(second.materialized.task, last.task);
    assert.deepEqual(second.materialized.sourceTasks, [...h.chain].reverse().map(item => ({ attemptId: item.attempt.id, task: item.task })));
    assert.ok(second.materialized.verifiedArtifacts.every(ref => ref.labels.length === 1 && ref.byteLength > 0));
    const state = await h.runtime.state(workId); const before = structuredClone(state);
    const prepared = await h.context.prepare(state, { ...limits, callId: 'immutable-input' });
    assert.deepEqual(state, before); assert.ok(prepared.packet.toolObservations!.every(o => o.resultArtifact.labels.length === 1));
    assert.equal(h.calls(), 1);
  });

  for (const loss of ['deleted', 'corrupted'] as const) test(`${adapter}: cached original is rejected if ${loss} during a later state read`, async t => {
    const h = await setup(t, adapter); const before = await h.runtime.state(workId); let changed = false;
    h.stateHooks.afterGet = async () => {
      if (!changed && h.artifacts.gets.includes(h.original.id)) {
        changed = true;
        if (loss === 'deleted') await rm(blob(h)); else await writeFile(blob(h), Buffer.alloc(h.original.byteLength, 88));
      }
    };
    await assert.rejects(h.resources.resultWithDependencies(workId, h.policy, h.chain[0]!.attempt.id, 65536), /invocation_unavailable/);
    assert.equal(changed, true); assert.deepEqual(await h.runtime.state(workId), before); assert.equal(h.calls(), 1);
  });

  test(`${adapter}: context rechecks metadata-reused originals after its staging await`, async t => {
    const h = await setup(t, adapter, 1); const before = await h.runtime.state(workId); let changed = false;
    h.artifacts.afterPut = async () => { if (!changed) { changed = true; await rm(blob(h)); } };
    await assert.rejects(h.context.prepare(before, limits), /context_source_unavailable/);
    assert.equal(changed, true); assert.deepEqual(await h.runtime.state(workId), before); assert.equal(h.calls(), 1);
  });

  test(`${adapter}: context rechecks ordinary cached originals after staging without a calls.get copy`, async t => {
    const h = await setup(t, adapter); const before = await h.runtime.state(workId); let changed = false;
    assert.equal(before.attempts.length, 1); assert.equal(before.attempts[0]!.toolId, 'fixture.read');
    h.artifacts.afterPut = async () => { if (!changed) { changed = true; await rm(blob(h)); } };
    await assert.rejects(h.context.prepare(before, limits), /context_source_unavailable/);
    assert.equal(h.artifacts.gets.filter(id => id === h.original.id).length, 1);
    assert.equal(changed, true); assert.deepEqual(await h.runtime.state(workId), before); assert.equal(h.calls(), 1);
  });

  for (const change of ['contract', 'policy', 'unrelated'] as const) test(`${adapter}: final cached-source check retains ${change} authority handling`, async t => {
    const h = await setup(t, adapter); const policy = structuredClone(h.policy); let changed = false;
    h.artifacts.afterExists = async ref => {
      if (changed || ref.id !== h.original.id) return; changed = true;
      if (change === 'policy') policy.allowedLabels = [];
      else if (change === 'contract') h.contracts.replaceProvider('fixture', [{ ...h.source, definition: { ...h.source.definition, description: 'Changed original contract' } }],
        { expectedEpoch: 1, sourceRevision: 'changed' });
      else h.contracts.replaceProvider('unrelated', [{ ...h.source, definition: { ...h.source.definition, provider: 'unrelated', id: 'unrelated.read' } }],
        { expectedEpoch: 0, sourceRevision: 'new' });
    };
    const pending = h.resources.resultWithDependencies(workId, policy, h.chain[0]!.attempt.id, 65536);
    if (change === 'unrelated') assert.equal((await pending).output.status, 'available');
    else await assert.rejects(pending, change === 'policy' ? /resource_state_changed/ : /invocation_unavailable/);
    assert.equal(changed, true); assert.equal(h.calls(), 1);
  });
}
