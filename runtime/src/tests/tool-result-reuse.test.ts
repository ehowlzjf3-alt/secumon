import test from 'node:test';
import assert from 'node:assert/strict';
import type { ArtifactRef, Evidence, Policy, TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import type { KnowledgeDependency } from '../domain/knowledge.js';
import type { StateRepository, Tool, ToolDefinition } from '../application/ports.js';
import type { KnowledgeValidator } from '../application/services.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { ToolResultSchema } from '../application/contracts.js';
import { taskDigest } from '../application/plan-validator.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { ToolResultReuse } from '../application/tool-result-reuse.js';
import { WorkResources } from '../application/work-resources.js';
import { transact } from '../application/work-transactions.js';
import { FakeClock, FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';
import { initial, command } from './state-conformance-helpers.js';

class SelectiveArtifacts extends MemoryArtifactStore {
  unavailable = new Set<string>();
  override async get(ref: ArtifactRef, policy: Policy) {
    if (this.unavailable.has(ref.id)) throw new Error('artifact_integrity_failure');
    return super.get(ref, policy);
  }
}
const makeTask = (id: string, freshness?: TaskSpec['freshness']): TaskSpec => ({ id, description: `Synthetic request ${id}`, toolId: 'fixture.reusable', toolVersion: '1',
  input: { query: 'same input', conditions: { region: 'local', optional: null } }, effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: [],
  ...(freshness ? { freshness } : {}) });
async function setup(options: { reuse?: ToolDefinition['reuse']; noReuse?: boolean; freshness?: TaskSpec['freshness']; duration?: number; bytes?: number } = {}) {
  const state = new MemoryStateRepository(); const artifacts = new SelectiveArtifacts(); const clock = new FakeClock(1000); let calls = 0;
  const original = await artifacts.put(new TextEncoder().encode('Original immutable synthetic source'), { tenantId: 'tenant-a', labels: ['synthetic'], mediaType: 'text/plain' });
  const evidence: Evidence = { id: 'original-evidence', tenantId: 'tenant-a', scope: 'fixture', sourceId: 'original-source', lineageId: 'original-lineage',
    locator: 'fixture://original-source', observedAt: 900, recordedAt: 1000, labels: ['synthetic'], coverage: 'complete', status: 'accepted', access: 'available',
    supersedes: [], derivedFrom: [], facts: { observation: 'unchanged', nullable: null }, artifact: original };
  const tool: Tool = { definition: { provider: 'fixture', id: 'fixture.reusable', version: '1', description: 'Read a synthetic source once', effect: 'read',
    destination: 'local', labels: ['synthetic'], inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
    ...(options.noReuse ? {} : { reuse: options.reuse ?? { mode: 'immutable', sourceVersion: 'source-v1' } }) },
  async execute(_task, context) { calls++; clock.advance(options.duration ?? 0); return { resultId: `${context.attemptId}:result`, attemptId: context.attemptId,
    status: 'success', effectState: 'none', evidence: [evidence], artifacts: [original], output: { text: options.bytes ? 'x'.repeat(options.bytes) : 'SYNTHETIC_SOURCE_RESULT', nullable: null },
    cursor: null, coverage: 'complete', error: null, usage: { transportCalls: 2, internalOperations: 3, imageBytes: null, waitMs: null } }; } };
  const seeded = initial(); seeded.policy.allowedTools = [tool.definition.id]; seeded.deadlineAt = 1000000; seeded.budget.limits.wallTimeMs = 999000;
  await state.commit(command(seeded, 'accept'));
  const composed = await composeRuntime({ services: { state, artifacts, clock, tools: [tool], planner: new ScriptedPlanner([]), ids: new RandomIds(), digester: new Sha256Digester(), sink: new FakeSink() },
    schemas: new AjvSchemas(), guidanceSource: { list: async () => [], read: async () => { throw new Error('unused_guidance'); } }, owner: 'reuse-test', enablePlanning: false });
  const submit = async (task: TaskSpec) => {
    const current = await composed.runtime.state(seeded.id);
    await composed.runtime.submitPlan(seeded.id, `plan:${task.id}`, { baseStateRevision: current.revision, baseGoalRevision: current.goal.revision,
      basePlanRevision: current.plan?.revision ?? 0, reason: 'Verify original observation reuse', tasks: [task], hypotheses: [] });
  };
  await submit(makeTask('original-task', 'fresh'));
  const source = await composed.runtime.reserve(seeded.id, 'original-task');
  await composed.runtime.execute(seeded.id, source.id); await composed.runtime.adopt(seeded.id, source.id);
  const after = await composed.runtime.state(seeded.id); const saved = after.attempts.find(a => a.id === source.id)!;
  assert.ok(saved.resultArtifact); assert.equal(saved.adopted, true); assert.equal(calls, 1);
  const result = ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(await artifacts.get(saved.resultArtifact, after.policy))));
  const consumerTask = makeTask('different-task-id', options.freshness); await submit(consumerTask);
  const consumer = await composed.runtime.reserve(seeded.id, consumerTask.id);
  const reuse = new ToolResultReuse(composed.services, composed.contracts, composed.resources);
  return { ...composed, state, artifacts, original, evidence, source: saved, result, consumer, consumerTask, reuse, clock, tool, calls: () => calls };
}
type Harness = Awaited<ReturnType<typeof setup>>;
async function latest(f: Harness) {
  const state = await f.runtime.state('work-1'); return { state, consumer: state.attempts.find(a => a.id === f.consumer.id)! };
}
async function find(f: Harness, reuse = f.reuse) { const { state, consumer } = await latest(f); return reuse.find(state, f.consumerTask, consumer); }
async function valid(f: Harness, result: ToolResult, reuse = f.reuse) { const { state, consumer } = await latest(f); return reuse.validate(state, f.consumerTask, consumer, result); }
async function edit(f: Harness, id: string, change: (state: WorkState) => void) { await transact(f.services, 'work-1', id, 'synthetic_reuse_change', { id }, change); }
async function changeResult(f: Harness, change: (value: ToolResult) => void) {
  const result = structuredClone(f.result); change(result); const old = f.source.resultArtifact!;
  const ref = await f.artifacts.put(new TextEncoder().encode(JSON.stringify(result)), { tenantId: old.tenantId, labels: old.labels, mediaType: old.mediaType });
  await edit(f, 'replace-source-result', state => { state.attempts.find(a => a.id === f.source.id)!.resultArtifact = ref; });
}
function withPorts(f: Harness, state: StateRepository = f.state, knowledge?: KnowledgeValidator) {
  const services = { ...f.services, state, ...(knowledge ? { knowledge } : {}) };
  return new ToolResultReuse(services, f.contracts, new WorkResources(state, f.artifacts, f.contracts, services.digester, knowledge, f.guidance));
}

test('tool reuse: trusted immutable defaults reuse across task IDs while preserving exact original evidence, timing and nullable usage', async () => {
  const f = await setup(); const before = await f.runtime.state('work-1'); const hit = await find(f); assert.ok(hit);
  assert.equal(hit.attemptId, f.consumer.id); assert.equal(hit.resultId, `${f.consumer.id}:result`);
  assert.deepEqual(hit.evidence, f.result.evidence); assert.deepEqual(hit.artifacts, f.result.artifacts); assert.deepEqual(hit.output, f.result.output);
  assert.deepEqual(hit.usage, f.result.usage); assert.equal(hit.reuse?.observedAt, f.source.startedAt);
  assert.equal(hit.reuse?.attemptId, f.source.id); assert.equal(hit.reuse.resultId, f.source.resultId); assert.deepEqual(hit.reuse.resultArtifact, f.source.resultArtifact);
  assert.match(hit.reuse.cacheKey, /^[0-9a-f]{64}$/); assert.equal(await valid(f, hit), true); assert.equal(f.calls(), 1);
  assert.deepEqual(await f.runtime.state('work-1'), before);
});

for (const scenario of ['untrusted-default', 'untrusted-request', 'fresh'] as const) test(`tool reuse: ${scenario} always misses`, async () => {
  const f = await setup({ noReuse: scenario !== 'fresh', ...(scenario === 'untrusted-request' ? { freshness: 'allow_reuse' } : scenario === 'fresh' ? { freshness: 'fresh' } : {}) });
  assert.equal(await find(f), null); assert.equal(f.calls(), 1);
});

test('tool reuse: TTL begins at original start, expires at the exact boundary, and is rechecked before adoption', async () => {
  const f = await setup({ reuse: { mode: 'ttl', maxAgeMs: 300 }, duration: 250 });
  const hit = await find(f); assert.ok(hit); assert.equal(hit.reuse?.observedAt, 1000); assert.equal(await valid(f, hit), true);
  f.clock.advance(50); assert.equal(await find(f), null); assert.equal(await valid(f, hit), false);
});

for (const reason of ['retracted', 'deleted', 'restricted', 'corrected', 'superseded', 'missing'] as const) test(`tool reuse: ${reason} source evidence is never reused`, async () => {
  const f = await setup(); const hit = await find(f); assert.ok(hit);
  await edit(f, `evidence-${reason}`, state => {
    const source = state.evidence.find(e => e.id === f.evidence.id)!;
    if (reason === 'retracted') source.status = 'retracted';
    if (reason === 'deleted' || reason === 'restricted') source.access = reason;
    if (reason === 'corrected') source.facts['observation'] = 'changed';
    if (reason === 'superseded') state.evidence.push({ ...structuredClone(source), id: 'new-version', observedAt: 1001, recordedAt: 1001, supersedes: [source.id] });
    if (reason === 'missing') state.evidence = [];
  });
  assert.equal(await find(f), null); assert.equal(await valid(f, hit), false);
});

for (const reason of ['contract-stamp', 'execution-proof', 'reused', 'not-invoked', 'partial', 'unknown', 'unadopted', 'future'] as const) test(`tool reuse: ${reason} original attempt cannot establish a cache hit`, async () => {
  const f = await setup();
  await edit(f, `attempt-${reason}`, state => {
    const source = state.attempts.find(a => a.id === f.source.id)!;
    if (reason === 'contract-stamp') delete source.contractDigest;
    if (reason === 'execution-proof') delete source.execution;
    if (reason === 'reused' || reason === 'not-invoked') source.execution = { mode: reason === 'reused' ? 'reused' : 'not_invoked', implementationCalls: 0,
      usage: { transportCalls: 0, internalOperations: 0, imageBytes: 0, waitMs: 0 } };
    if (reason === 'partial') source.status = 'partial';
    if (reason === 'unknown') source.effectState = 'unknown';
    if (reason === 'unadopted') source.adopted = false;
    if (reason === 'future') { source.startedAt = f.clock.now() + 1; source.finishedAt = source.startedAt; }
  });
  assert.equal(await find(f), null);
});

for (const reason of ['goal', 'goal-revision', 'scope', 'owner', 'labels', 'permission'] as const) test(`tool reuse: full ${reason} context changes invalidate the old key`, async () => {
  const f = await setup();
  await edit(f, `context-${reason}`, state => {
    if (reason === 'goal') state.goal.description = 'Changed goal with the same revision';
    if (reason === 'goal-revision') state.goal.revision++;
    if (reason === 'scope') state.goal.scope = 'another-scope';
    if (reason === 'owner') state.policy.principalId = 'another-owner';
    if (reason === 'labels') state.policy.allowedLabels.push('additional-label');
    if (reason === 'permission') state.policy.allowedTools = [];
  });
  assert.equal(await find(f), null);
});

test('tool reuse: changed immutable sourceVersion or schema under the same tool version invalidates pinned contracts', async () => {
  const f = await setup();
  for (const definition of [{ ...f.tool.definition, reuse: { mode: 'immutable' as const, sourceVersion: 'source-v2' } },
    { ...f.tool.definition, inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }]) {
    const changed: Tool = { ...f.tool, definition }; const contracts = new ToolContracts([changed], new AjvSchemas());
    assert.equal(contracts.get(changed.definition.id, changed.definition.version)!.input(f.consumerTask.input), true);
    const reuse = new ToolResultReuse(f.services, contracts, new WorkResources(f.state, f.artifacts, contracts, f.services.digester));
    assert.equal(await find(f, reuse), null);
  }
});

test('tool reuse: a different canonical input under the same trusted definition is a cache miss', async () => {
  const f = await setup(); f.consumerTask.input['query'] = 'different input';
  await edit(f, 'change-consumer-input', state => {
    state.plan!.tasks = [structuredClone(f.consumerTask)];
    state.attempts.find(a => a.id === f.consumer.id)!.inputDigest = taskDigest(f.consumerTask, f.services.digester);
  });
  assert.equal(await find(f), null);
});

test('tool reuse: parent retraction invalidates an unchanged derived evidence payload', async () => {
  const f = await setup();
  const derived = { ...f.evidence, derivedFrom: ['parent-evidence'] };
  const parent: Evidence = { ...f.evidence, id: 'parent-evidence', sourceId: 'parent-source', observedAt: 800, recordedAt: 800, artifact: null };
  await changeResult(f, result => { result.evidence = [derived]; });
  await edit(f, 'install-derived-source', state => { state.evidence = [parent, derived]; });
  const hit = await find(f); assert.ok(hit);
  await edit(f, 'retract-parent-source', state => { state.evidence.find(e => e.id === parent.id)!.status = 'retracted'; });
  assert.equal(await find(f), null); assert.equal(await valid(f, hit), false);
});

test('tool reuse: missing or damaged original bytes and oversized results are conservative misses', async () => {
  const f = await setup(); const hit = await find(f); assert.ok(hit); f.artifacts.unavailable.add(f.original.id);
  assert.equal(await find(f), null); assert.equal(await valid(f, hit), false);
  const large = await setup({ bytes: 65536 }); assert.equal(await find(large), null);
});

for (const reason of ['partial', 'cursor', 'reused', 'identity'] as const) test(`tool reuse: a ${reason} canonical result is not an original complete observation`, async () => {
  const f = await setup(); const first = await find(f); assert.ok(first);
  await changeResult(f, result => {
    if (reason === 'partial') { result.status = 'partial'; result.coverage = 'partial'; }
    if (reason === 'cursor') result.cursor = 'more-pages';
    if (reason === 'reused') result.reuse = first.reuse;
    if (reason === 'identity') result.attemptId = 'unrelated-attempt';
  });
  assert.equal(await find(f), null); assert.equal(await valid(f, first), false);
});

test('tool reuse: forged payloads, evidence timing, consumer identity, source stamps and accounting reports fail validation', async () => {
  const f = await setup(); const hit = await find(f); assert.ok(hit);
  const changes: ((value: ToolResult) => void)[] = [
    value => { value.output = { forged: true }; }, value => { value.evidence[0]!.observedAt++; }, value => { value.attemptId = 'other-consumer'; },
    value => { value.resultId = 'other-result'; }, value => { value.reuse!.observedAt++; }, value => { value.reuse!.cacheKey = 'a'.repeat(64); },
    value => { value.reuse!.attemptId = 'foreign-work-attempt'; }, value => { value.reuse!.resultArtifact.sha256 = 'b'.repeat(64); },
    value => { value.usage!.transportCalls = 0; },
  ];
  for (const change of changes) { const forged: ToolResult = structuredClone(hit); change(forged); assert.equal(await valid(f, forged), false); }
});

test('tool reuse: current source knowledge must validate and travels with the reused result', async () => {
  const f = await setup();
  const dependency: KnowledgeDependency = { tenantId: 'tenant-a', knowledgeId: 'knowledge', knowledgeRevision: 1, actorDigest: 'a'.repeat(64), parents: [],
    sources: [{ workId: 'work-1', evidenceId: f.evidence.id, sourceVersion: 'b'.repeat(64), generation: 0, workRevision: 1, policyDigest: 'c'.repeat(64) }] };
  await changeResult(f, result => { result.knowledgeDependencies = [dependency]; });
  const service = withPorts(f, f.state, { validate: async values => { assert.deepEqual(values, [dependency]); return true; } });
  const hit = await find(f, service); assert.ok(hit); assert.deepEqual(hit.knowledgeDependencies, [dependency]); assert.equal(await valid(f, hit, service), true);
  assert.equal(await find(f, withPorts(f, f.state, { validate: async () => false })), null);
});

test('tool reuse: source authority changes while canonical receipt lookup waits prevent a stale hit', async () => {
  const f = await setup(); let changed = false;
  const state = new Proxy(f.state, { get(target, key) {
    if (key === 'receipt') return async (workId: string, commandId: string) => {
      const value = await target.receipt(workId, commandId);
      if (!changed && commandId === `dispatch:${f.source.id}`) { changed = true; await edit(f, 'race-permission', current => { current.policy.allowedTools = []; }); }
      return value;
    };
    const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  assert.equal(await find(f, withPorts(f, state)), null); assert.equal(changed, true);
});

for (const change of ['find-remove', 'validate-source-version', 'validate-labels'] as const) test(`tool reuse: ${change} during the final state read invalidates the registry pin`, async () => {
  const f = await setup(); const hit = await find(f); assert.ok(hit);
  const before = await f.runtime.state('work-1'); let sourceVerified = false; let changed = false;
  const resources = new Proxy(f.resources, { get(target, key) {
    if (key === 'resultWithDependencies') return async (...args: Parameters<WorkResources['resultWithDependencies']>) => {
      const result = await target.resultWithDependencies(...args); sourceVerified = true; return result;
    };
    const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const state = new Proxy(f.state, { get(target, key) {
    if (key === 'get') return async (workId: string) => {
      const snapshot = await target.get(workId);
      if (sourceVerified && !changed) {
        const replacement: Tool = { ...f.tool, definition: { ...f.tool.definition,
          ...(change === 'validate-source-version' ? { reuse: { mode: 'immutable' as const, sourceVersion: 'replacement-source' } } : { labels: ['restricted'] }) } };
        f.contracts.replaceProvider('fixture', change === 'find-remove' ? [] : [replacement], {
          expectedEpoch: f.contracts.providerEpoch('fixture'), sourceRevision: `race-${change}`,
        });
        changed = true;
      }
      return snapshot;
    };
    const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const service = new ToolResultReuse({ ...f.services, state }, f.contracts, resources);
  if (change === 'find-remove') assert.equal(await find(f, service), null);
  else assert.equal(await valid(f, hit, service), false);
  assert.equal(sourceVerified, true); assert.equal(changed, true);
  assert.deepEqual(await f.runtime.state('work-1'), before, 'the work did not change; the final guard must inspect the current registry');
});
