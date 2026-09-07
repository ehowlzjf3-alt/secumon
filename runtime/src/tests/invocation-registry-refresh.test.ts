import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactRef, Policy, TaskSpec } from '../domain/model.js';
import { DEFAULT_PROGRESS_POLICY } from '../domain/work-progress.js';
import type { ArtifactStore, StateRepository, Tool } from '../application/ports.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { ToolResultSchema } from '../application/contracts.js';
import { validateScenario } from '../application/fixtures.js';
import { GuidanceCatalog, type GuidanceSource } from '../application/guidance.js';
import { newWork } from '../application/new-work.js';
import { asJson, taskDigest } from '../application/plan-validator.js';
import { RESOURCE_TOOL_IDS } from '../application/resource-tools.js';
import { WorkResources } from '../application/work-resources.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { RandomIds, Sha256Digester, sha256 } from '../infrastructure/digest.js';
import { FakeClock, FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { adapters, command, openRepository, type Adapter } from './state-conformance-helpers.js';

const workId = 'registry-copy'; const marker = 'PRIVATE_SOURCE_BODY_DURING_REGISTRY_REFRESH';
function gate() {
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }); const waiting = new Promise<void>(resolve => { release = resolve; });
  return { started, release, pause: async () => { entered(); await waiting; } };
}
class GatedArtifacts implements ArtifactStore {
  beforeReturn: ((ref: ArtifactRef) => Promise<void>) | null = null;
  constructor(readonly backing: ArtifactStore) {}
  put: ArtifactStore['put'] = (bytes, attributes) => this.backing.put(bytes, attributes);
  exists: ArtifactStore['exists'] = ref => this.backing.exists(ref);
  async get(ref: ArtifactRef, policy: Policy) {
    const bytes = await this.backing.get(ref, policy); await this.beforeReturn?.(ref); return bytes;
  }
  pause(ref: ArtifactRef, occurrence = 1) {
    const control = gate(); let remaining = occurrence;
    this.beforeReturn = async current => {
      if (current.id === ref.id && --remaining === 0) { this.beforeReturn = null; await control.pause(); }
    };
    return control;
  }
}
function source(requiredRules = ['Check provenance']): GuidanceSource {
  return { list: async () => [{ id: 'core.registry-guide', version: '1', title: 'Registry guide', summary: 'Synthetic source guidance',
    source: 'fixture://registry-guide', tenantId: 'synthetic', labels: ['synthetic'], supportedKinds: ['lookup'],
    byteLength: new TextEncoder().encode(marker).length, sha256: sha256(marker), requiredRules }], read: async () => new TextEncoder().encode(marker) };
}
function task(id: string, toolId: string, input: TaskSpec['input']): TaskSpec {
  return { id, description: id, toolId, toolVersion: '1', input, effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: [] };
}
async function setup(t: TestContext, adapter: Adapter, kind: 'source' | 'catalog' | 'guidance' = 'source') {
  const directory = await mkdtemp(join(tmpdir(), 'invocation-registry-')); const state = openRepository(adapter, directory);
  t.after(async () => { await state.close(); await rm(directory, { recursive: true, force: true }); });
  const artifacts = new GatedArtifacts(new FileArtifactStore(join(directory, 'artifacts'))); const clock = new FakeClock(1788566400000);
  const original = await artifacts.put(new TextEncoder().encode(marker), { tenantId: 'synthetic', labels: ['synthetic'], mediaType: 'text/plain' });
  let invocations = 0;
  const originalTool: Tool = { definition: { provider: 'fixture', id: 'fixture.private', version: '1', description: `Private schema ${marker}`,
    effect: 'read', destination: 'local', labels: ['synthetic'], inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object' } },
  async execute(_task, context) { invocations++; return { resultId: `${context.attemptId}:result`, attemptId: context.attemptId,
    status: 'success', effectState: 'none', evidence: [], artifacts: [original], output: { body: marker }, error: null, cursor: null, coverage: 'complete' }; } };
  const scenario = validateScenario(JSON.parse(readFileSync(new URL('../../fixtures/documents-simple.json', import.meta.url), 'utf8')));
  const seed = newWork({ id: workId, now: clock.now(), goal: scenario.goal, policy: { ...scenario.policy, allowedTools: [originalTool.definition.id, ...RESOURCE_TOOL_IDS] },
    limits: { toolCalls: 20, modelCalls: 2, tokens: 500000, replans: 10, wallTimeMs: 100000 } });
  // This fixture must reach a registry change during nested copies, which add no progress.
  seed.progress = { schemaVersion: 1, goalRevision: seed.goal.revision,
    policy: { ...DEFAULT_PROGRESS_POLICY, maxUnproductiveSteps: 100 }, processed: [], knownKeys: [],
    consecutiveUnproductive: 0, productiveSteps: 0, unproductiveSteps: 0, failures: [], saturated: false };
  assert.equal((await state.commit(command(seed, 'seed'))).kind, 'committed');
  const c = await composeRuntime({ services: { state, artifacts, clock, tools: [originalTool], planner: new ScriptedPlanner([]), ids: new RandomIds(), digester: new Sha256Digester(), sink: new FakeSink() },
    schemas: new AjvSchemas(), guidanceSource: source(), owner: 'registry-reader', enablePlanning: false });
  let plans = 0;
  const plan = async (selected: TaskSpec) => {
    const current = await c.runtime.state(workId);
    await c.runtime.submitPlan(workId, `plan-${++plans}`, { baseStateRevision: current.revision, baseGoalRevision: current.goal.revision,
      basePlanRevision: current.plan?.revision ?? 0, reason: 'Read canonical source and copies', tasks: [selected], hypotheses: [] });
    return c.runtime.reserve(workId, selected.id);
  };
  const run = async (selected: TaskSpec) => {
    const reserved = await plan(selected); await c.runtime.execute(workId, reserved.id); await c.runtime.adopt(workId, reserved.id);
    const after = await c.runtime.state(workId); const attempt = after.attempts.find(a => a.id === reserved.id)!;
    assert.equal(attempt.adopted, true); const receipt = await state.receipt(workId, `dispatch:${attempt.id}`); assert.ok(receipt);
    assert.equal(taskDigest(receipt.state.plan!.tasks[0]!, c.services.digester), attempt.inputDigest); return attempt;
  };
  const first = await run(kind === 'source' ? task('source', originalTool.definition.id, {}) : kind === 'catalog'
    ? task('source', 'core.catalog.get', { id: originalTool.definition.id, version: '1', maxBytes: 65536 })
    : task('source', 'core.guidance.load', { id: 'core.registry-guide', version: '1', kind: 'lookup', reason: 'Read guide', maxBytes: 65536 }));
  const one = await run(task('copy-one', 'core.calls.get', { attemptId: first.id, maxBytes: 65536 }));
  const two = await run(task('copy-two', 'core.calls.get', { attemptId: one.id, maxBytes: 65536 }));
  const current = await c.runtime.state(workId);
  return { ...c, state, artifacts, original, originalTool, first, one, two, policy: current.policy, plan, invocations: () => invocations };
}
type Harness = Awaited<ReturnType<typeof setup>>;
function replace(h: Harness, change: 'remove' | 'labels' | 'description' | 'unrelated') {
  if (change === 'unrelated') {
    h.contracts.replaceProvider('other', [{ ...h.originalTool, definition: { ...h.originalTool.definition, provider: 'other', id: 'other.unrelated' } }], { expectedEpoch: 0, sourceRevision: 'new' });
  } else h.contracts.replaceProvider('fixture', change === 'remove' ? [] : [{ ...h.originalTool,
    definition: { ...h.originalTool.definition, ...(change === 'labels' ? { labels: ['synthetic', 'restricted'] } : { description: 'Changed contract' }) } }],
  { expectedEpoch: 1, sourceRevision: 'updated' });
}

for (const adapter of adapters) {
  for (const change of ['remove', 'labels', 'description', 'unrelated'] as const) test(`${adapter}: two invocation copies recheck ${change} registry change after source artifact read`, { timeout: 10000 }, async t => {
    const h = await setup(t, adapter); const before = await h.runtime.state(workId);
    const ordinary = await h.resources.resultWithDependencies(workId, h.policy, h.two.id, 65536);
    assert.equal(ordinary.output.status, 'available'); assert.match(JSON.stringify(ordinary.output), new RegExp(marker));
    assert.deepEqual(ordinary.toolContracts.map(value => value.id).sort(), ['core.calls.get', 'fixture.private']);
    for (const value of ordinary.toolContracts) assert.equal(value.digest, h.services.digester.digest(asJson(h.contracts.get(value.id, value.version)!.tool.definition)));
    assert.doesNotMatch(JSON.stringify(ordinary.output), /toolContracts/);
    const waiting = h.artifacts.pause(h.original); t.after(waiting.release);
    const pending = h.resources.resultWithDependencies(workId, h.policy, h.two.id, 65536);
    await waiting.started; replace(h, change); waiting.release();
    if (change === 'unrelated') { const read = await pending; assert.equal(read.output.status, 'available'); assert.match(JSON.stringify(read.output), new RegExp(marker)); }
    else await assert.rejects(pending, /invocation_unavailable/);
    assert.equal((await h.runtime.state(workId)).revision, before.revision); assert.equal(h.invocations(), 1);
  });

  test(`${adapter}: an executed third calls.get stores no private body when source is removed during its read`, { timeout: 10000 }, async t => {
    const h = await setup(t, adapter); const attempt = await h.plan(task('copy-three', 'core.calls.get', { attemptId: h.two.id, maxBytes: 65536 }));
    const waiting = h.artifacts.pause(h.original); t.after(waiting.release); const pending = h.runtime.execute(workId, attempt.id);
    await waiting.started; replace(h, 'remove'); waiting.release(); await pending; await h.runtime.adopt(workId, attempt.id);
    const after = await h.runtime.state(workId); const received = after.attempts.find(a => a.id === attempt.id)!;
    assert.equal(received.adopted, false); assert.ok(received.resultArtifact);
    const result = ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(await h.artifacts.get(received.resultArtifact, after.policy))));
    assert.equal(result.status, 'error'); assert.equal(result.output, null); assert.doesNotMatch(JSON.stringify(result), new RegExp(marker)); assert.equal(h.invocations(), 1);
  });

  test(`${adapter}: catalog target pin is rechecked after final asynchronous state validation`, { timeout: 10000 }, async t => {
    const h = await setup(t, adapter, 'catalog'); const waiting = gate(); t.after(waiting.release); let sourceRead = false; let paused = false;
    h.artifacts.beforeReturn = async ref => { if (ref.id === h.first.resultArtifact!.id) sourceRead = true; };
    const state: StateRepository = new Proxy(h.state, { get(target, key) {
      if (key === 'get') return async (id: string) => { const value = await target.get(id); if (sourceRead && !paused) { paused = true; await waiting.pause(); } return value; };
      const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const resources = new WorkResources(state, h.artifacts, h.contracts, h.services.digester, h.services.knowledge, h.guidance);
    const pending = resources.resultWithDependencies(workId, h.policy, h.two.id, 65536);
    await waiting.started; replace(h, 'description'); waiting.release(); await assert.rejects(pending, /invocation_unavailable/);
    assert.equal(paused, true);
  });

  test(`${adapter}: a same-version guidance manifest change cannot survive copied body verification`, { timeout: 10000 }, async t => {
    const h = await setup(t, adapter, 'guidance'); const changed = await GuidanceCatalog.create(source(['Updated required rule'])); let current = h.guidance;
    const guidance = new Proxy(h.guidance, { get(target, key) {
      if (key === 'describe') return (...args: Parameters<GuidanceCatalog['describe']>) => current.describe(...args);
      const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const resources = new WorkResources(h.state, h.artifacts, h.contracts, h.services.digester, h.services.knowledge, guidance);
    const firstResult = ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(await h.artifacts.get(h.first.resultArtifact!, h.policy))));
    const waiting = h.artifacts.pause(firstResult.artifacts[0]!, 2); t.after(waiting.release);
    const pending = resources.resultWithDependencies(workId, h.policy, h.two.id, 65536);
    await waiting.started; current = changed; waiting.release(); await assert.rejects(pending, /invocation_unavailable/);
  });
}
