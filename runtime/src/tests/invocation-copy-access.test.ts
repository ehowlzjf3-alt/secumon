import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ArtifactRef, Policy, TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import type { KnowledgeDependency } from '../domain/knowledge.js';
import { DEFAULT_PROGRESS_POLICY } from '../domain/work-progress.js';
import type { StateRepository, Tool } from '../application/ports.js';
import type { KnowledgeValidator } from '../application/services.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { ToolResultSchema } from '../application/contracts.js';
import { validateScenario } from '../application/fixtures.js';
import { GuidanceCatalog, type GuidanceSource } from '../application/guidance.js';
import { newWork } from '../application/new-work.js';
import { taskDigest } from '../application/plan-validator.js';
import { RESOURCE_TOOL_IDS } from '../application/resource-tools.js';
import { WorkResources } from '../application/work-resources.js';
import { transact } from '../application/work-transactions.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { RandomIds, Sha256Digester, sha256 } from '../infrastructure/digest.js';
import { FakeClock, FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';

const workId = 'copied-invocations'; const marker = 'ORIGINAL_COPIED_BODY';
const actor = { tenantId: 'synthetic', principalId: 'learner' };
class SelectiveArtifacts extends MemoryArtifactStore {
  unavailable = new Set<string>();
  override async get(ref: ArtifactRef, policy: Policy) {
    if (this.unavailable.has(ref.id)) throw new Error('artifact_integrity_failure');
    return super.get(ref, policy);
  }
}
const source = (version = '1', body = marker): GuidanceSource => ({
  list: async () => [{ id: 'core.copy-guide', version, title: 'Synthetic copy guidance', summary: 'A selected synthetic guide',
    source: 'fixture://copy-guide', tenantId: actor.tenantId, labels: ['synthetic'], supportedKinds: ['lookup'],
    byteLength: Buffer.byteLength(body), sha256: sha256(body) }],
  read: async () => new TextEncoder().encode(body),
});
const task = (id: string, toolId: string, input: TaskSpec['input']): TaskSpec => ({
  id, description: id, toolId, toolVersion: '1', input, effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: [],
});
async function setup(kind: 'source' | 'guidance' | 'catalog' = 'source', count = 2, copyBytes = 65536) {
  const scenario = validateScenario(JSON.parse(readFileSync(new URL('../../fixtures/documents-simple.json', import.meta.url), 'utf8')));
  const state = new MemoryStateRepository(); const artifacts = new SelectiveArtifacts(); const clock = new FakeClock(1788566400000);
  const original = await artifacts.put(new TextEncoder().encode(marker), { tenantId: actor.tenantId, labels: ['synthetic'], mediaType: 'text/plain' });
  const sourceTool: Tool = { definition: { provider: 'fixture', id: 'fixture.private', version: '1', description: `Synthetic schema ${marker}`,
    effect: 'read', destination: 'local', labels: ['synthetic'], inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object' } },
  async execute(_task, context) { return { resultId: `${context.attemptId}:result`, attemptId: context.attemptId, status: 'success', effectState: 'none',
    evidence: [], artifacts: [original], output: { body: marker }, error: null, cursor: null, coverage: 'complete' }; } };
  const initial = newWork({ id: workId, now: clock.now(), goal: scenario.goal,
    policy: { ...scenario.policy, allowedTools: [sourceTool.definition.id, ...RESOURCE_TOOL_IDS] },
    limits: { toolCalls: 100, modelCalls: 2, tokens: 10000, replans: 100, wallTimeMs: 100000 } });
  // This fixture must reach the 64-node custody boundary even though copies add no progress.
  initial.progress = { schemaVersion: 1, goalRevision: initial.goal.revision,
    policy: { ...DEFAULT_PROGRESS_POLICY, maxUnproductiveSteps: 100 }, processed: [], knownKeys: [],
    consecutiveUnproductive: 0, productiveSteps: 0, unproductiveSteps: 0, failures: [], saturated: false };
  await state.commit({ workId, expectedRevision: 0, commandId: 'accept', commandDigest: 'synthetic-copy-accept', next: initial,
    events: [{ type: 'accepted', at: clock.now(), data: {} }], deliveries: [] });
  const baseServices = { state, artifacts, clock, tools: [sourceTool], planner: new ScriptedPlanner([]),
    digester: new Sha256Digester(), ids: new RandomIds(), sink: new FakeSink() };
  const composed = await composeRuntime({ services: baseServices, schemas: new AjvSchemas(), guidanceSource: source(), owner: 'copy-test', enablePlanning: false });
  let plans = 0;
  const execute = async (selected: TaskSpec) => {
    const current = await composed.runtime.state(workId);
    await composed.runtime.submitPlan(workId, `plan-${++plans}`, { baseStateRevision: current.revision, baseGoalRevision: current.goal.revision,
      basePlanRevision: current.plan?.revision ?? 0, reason: 'Exercise a canonical historical copy', tasks: [selected], hypotheses: [] });
    const attempt = await composed.runtime.reserve(workId, selected.id);
    await composed.runtime.execute(workId, attempt.id); await composed.runtime.adopt(workId, attempt.id);
    const after = await composed.runtime.state(workId); const saved = after.attempts.find(a => a.id === attempt.id)!; assert.ok(saved.resultArtifact);
    const result = ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(await artifacts.get(saved.resultArtifact, after.policy))));
    assert.ok(['success', 'partial'].includes(result.status), JSON.stringify(result.error));
    const receipt = await state.receipt(workId, `dispatch:${attempt.id}`); assert.ok(receipt);
    assert.equal(taskDigest(receipt.state.plan!.tasks[0]!, baseServices.digester), saved.inputDigest);
    return { attempt: saved, result };
  };
  const selected = kind === 'source' ? task('original', sourceTool.definition.id, {}) : kind === 'guidance'
    ? task('original', 'core.guidance.load', { id: 'core.copy-guide', version: '1', kind: 'lookup', reason: 'Read selected guide', maxBytes: 65536 })
    : task('original', 'core.catalog.get', { id: sourceTool.definition.id, version: '1', maxBytes: 65536 });
  const first = await execute(selected); const copies: typeof first[] = [];
  for (let index = 0; index < count; index++) copies.push(await execute(task(`copy-${index}`, 'core.calls.get', { attemptId: copies.at(-1)?.attempt.id ?? first.attempt.id, maxBytes: copyBytes })));
  return { ...composed, state, artifacts, original, sourceTool, baseServices, first, copies, execute };
}
type Harness = Awaited<ReturnType<typeof setup>>;
const read = (f: Harness, resources = f.resources) => resources.result(workId, actor, f.copies.at(-1)!.attempt.id, 65536);
async function edit(f: Harness, id: string, change: (state: WorkState) => void) {
  await transact(f.services, workId, id, 'synthetic_copy_test_change', { id }, change);
}
function resources(f: Harness, store: StateRepository = f.state, knowledge?: KnowledgeValidator, guidance = f.guidance) {
  return new WorkResources(store, f.artifacts, f.contracts, f.baseServices.digester, knowledge, guidance);
}
function receipts(f: Harness, transform: (value: Awaited<ReturnType<StateRepository['receipt']>>, commandId: string) => Awaited<ReturnType<StateRepository['receipt']>>) {
  return new Proxy(f.state, { get(target, key) {
    if (key === 'receipt') return async (id: string, commandId: string) => transform(await target.receipt(id, commandId), commandId);
    const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
async function replaceResult(f: Harness, which: typeof f.first, editResult: (result: ToolResult) => void) {
  const value = structuredClone(which.result); editResult(value); const old = which.attempt.resultArtifact!;
  const ref = await f.artifacts.put(new TextEncoder().encode(JSON.stringify(value)), { tenantId: old.tenantId, labels: old.labels, mediaType: old.mediaType });
  await edit(f, `replace-${which.attempt.id}`, state => { state.attempts.find(a => a.id === which.attempt.id)!.resultArtifact = ref; });
}

test('invocation copies: two real canonical copies expose the still-authorized original without executing it again', async () => {
  const f = await setup(); const before = await f.runtime.state(workId); const result = await read(f);
  assert.equal(result.status, 'available'); assert.match(JSON.stringify(result), new RegExp(marker));
  assert.equal(before.attempts.length, 3); assert.equal(before.budget.used.toolCalls, 3);
  assert.deepEqual(await f.runtime.state(workId), before);
});

test('invocation copies: retaining only calls.get permission does not restore a revoked source tool', async () => {
  const f = await setup(); await edit(f, 'revoke-source', state => { state.policy.allowedTools = ['core.calls.get']; });
  await assert.rejects(read(f), /invocation_unavailable/);
  const current = await f.runtime.state(workId); const wrapper = f.contracts.get('core.calls.get', '1')!.tool;
  const result = await wrapper.execute(task('blocked-copy', 'core.calls.get', { attemptId: f.copies[1]!.attempt.id, maxBytes: 65536 }), {
    workId, attemptId: 'blocked-copy-attempt', policy: current.policy, signal: new AbortController().signal,
  });
  assert.equal(result.status, 'error'); assert.equal(result.output, null); assert.deepEqual(result.error, { code: 'resource_unavailable', retryable: false });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(marker));
});

test('invocation copies: current guidance version replacement blocks the copied earlier guide', async () => {
  const f = await setup('guidance'); assert.match(JSON.stringify(await read(f)), new RegExp(marker));
  const restored = await composeRuntime({ services: f.baseServices, schemas: new AjvSchemas(), guidanceSource: source('2', 'replacement guide'), owner: 'restored-copy-test', enablePlanning: false });
  await assert.rejects(read(f, restored.resources), /invocation_unavailable/);
  await assert.rejects(read(f, new WorkResources(f.state, f.artifacts, f.contracts, f.baseServices.digester)), /invocation_unavailable/);
});

test('invocation copies: same-version manifest replacement and new guidance labels also block nested bodies', async () => {
  const f = await setup('guidance');
  const changed = await GuidanceCatalog.create(source('1', 'changed guide under old version'));
  await assert.rejects(read(f, resources(f, f.state, undefined, changed)), /invocation_unavailable/);
  const original = source(); const restricted = await GuidanceCatalog.create({ list: async () => (await original.list()).map(m => ({ ...m, labels: ['restricted'] })), read: original.read });
  await assert.rejects(read(f, resources(f, f.state, undefined, restricted)), /invocation_unavailable/);
});

for (const change of ['permission', 'version', 'definition'] as const) test(`invocation copies: catalog target ${change} is rechecked through both copies`, async () => {
  const f = await setup('catalog'); assert.match(JSON.stringify(await read(f)), new RegExp(marker));
  if (change === 'permission') {
    await edit(f, 'revoke-catalog-target', state => { state.policy.allowedTools = state.policy.allowedTools.filter(id => id !== 'fixture.private'); });
    await assert.rejects(read(f), /invocation_unavailable/);
  } else {
    const changed: Tool = { ...f.sourceTool, definition: { ...f.sourceTool.definition,
      ...(change === 'version' ? { version: '2' } : { description: 'Changed schema under an unchanged version' }) } };
    const restored = await composeRuntime({ services: { ...f.baseServices, tools: [changed] }, schemas: new AjvSchemas(), guidanceSource: source(), owner: 'changed-catalog', enablePlanning: false });
    await assert.rejects(read(f, restored.resources), /invocation_unavailable/);
  }
});

for (const change of ['missing', 'foreign-owner', 'foreign-tenant', 'foreign-work', 'input-digest'] as const) test(`invocation copies: a ${change} canonical source receipt is rejected`, async () => {
  const f = await setup();
  const port = receipts(f, (value, commandId) => {
    if (!value || commandId !== `dispatch:${f.first.attempt.id}`) return value;
    if (change === 'missing') return null;
    if (change === 'foreign-owner') value.state.policy.principalId = 'other-owner';
    if (change === 'foreign-tenant') value.state.policy.tenantId = 'other-tenant';
    if (change === 'foreign-work') value.state.id = 'other-work';
    if (change === 'input-digest') value.state.plan!.tasks[0]!.input = { forged: true };
    return value;
  });
  await assert.rejects(read(f, resources(f, port)), /invocation_unavailable/);
});

test('invocation copies: missing source artifacts invalidate copied bodies even when copy artifacts remain readable', async () => {
  const f = await setup(); f.artifacts.unavailable.add(f.original.id);
  assert.ok(await f.artifacts.exists(f.copies[1]!.attempt.resultArtifact!));
  await assert.rejects(read(f), /invocation_unavailable/);
});

test('invocation copies: a modified copied body must still equal its canonical source result', async () => {
  const f = await setup();
  await replaceResult(f, f.copies[1]!, result => {
    const output = result.output as { value: { result: { output: unknown } } }; output.value.result.output = { body: 'UNRELATED_FOREIGN_BODY' };
  });
  await assert.rejects(read(f), /invocation_unavailable/);
});

test('invocation copies: source knowledge is validated and propagated even if an older copy omitted its dependency metadata', async () => {
  const f = await setup();
  const dependency: KnowledgeDependency = { tenantId: actor.tenantId, knowledgeId: 'source-memory', knowledgeRevision: 1, actorDigest: 'a'.repeat(64), parents: [],
    sources: [{ workId, evidenceId: 'source-evidence', sourceVersion: 'b'.repeat(64), generation: 0, workRevision: 1, policyDigest: 'c'.repeat(64) }] };
  await replaceResult(f, f.first, result => { result.knowledgeDependencies = [dependency]; });
  let validated = 0;
  const valid = resources(f, f.state, { validate: async values => { validated++; assert.deepEqual(values, [dependency]); return true; } });
  const result = await valid.resultWithDependencies(workId, actor, f.copies[1]!.attempt.id, 65536);
  assert.ok(validated > 0); assert.deepEqual(result.knowledgeDependencies, [dependency]);
  assert.doesNotMatch(JSON.stringify(result.output), /knowledgeDependencies|actorDigest/);
  await assert.rejects(read(f, resources(f, f.state, { validate: async () => false })), /invocation_unavailable/);
});

test('invocation copies: permission changes during a source receipt read prevent returning the already-read copy', async () => {
  const f = await setup(); let changed = false;
  const port = new Proxy(f.state, { get(target, key) {
    if (key === 'receipt') return async (id: string, commandId: string) => {
      const value = await target.receipt(id, commandId);
      if (!changed && commandId === `dispatch:${f.first.attempt.id}`) { changed = true; await edit(f, 'late-revocation', state => { state.policy.allowedTools = ['core.calls.get']; }); }
      return value;
    };
    const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  await assert.rejects(read(f, resources(f, port)), /resource_state_changed/); assert.equal(changed, true);
});

test('invocation copies: a canonical input cycle is rejected before following the same receipt twice', async () => {
  const f = await setup(); const last = f.copies[1]!; const canonical = (await f.state.receipt(workId, `dispatch:${last.attempt.id}`))!;
  canonical.state.plan!.tasks[0]!.input['attemptId'] = last.attempt.id;
  await edit(f, 'cycle-input-digest', state => { state.attempts.find(a => a.id === last.attempt.id)!.inputDigest = taskDigest(canonical.state.plan!.tasks[0]!, f.baseServices.digester); });
  const port = receipts(f, (value, commandId) => commandId === `dispatch:${last.attempt.id}` ? canonical : value);
  await assert.rejects(read(f, resources(f, port)), /invocation_unavailable/);
});

test('invocation copies: the 64-node source boundary accepts 63 copies and rejects one further copy', async () => {
  const f = await setup('source', 64, 256);
  assert.equal((await f.resources.result(workId, actor, f.copies[62]!.attempt.id, 65536)).status, 'available');
  await assert.rejects(read(f), /invocation_unavailable/);
});
