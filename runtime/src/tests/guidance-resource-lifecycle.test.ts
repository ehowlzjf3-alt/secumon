import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Json, Policy, TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import type { GuidanceManifest, GuidanceSource } from '../application/guidance.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { ToolResultSchema } from '../application/contracts.js';
import { validateScenario } from '../application/fixtures.js';
import { newWork } from '../application/new-work.js';
import { RESOURCE_TOOL_IDS } from '../application/resource-tools.js';
import { transact } from '../application/work-transactions.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { canonical, RandomIds, Sha256Digester, sha256 } from '../infrastructure/digest.js';
import { FakeClock, FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';

const families = ['documents-simple', 'observations-simple'] as const;
type Family = typeof families[number];
const workId = 'guidance-resource-work';
const body = 'ORIGINAL_GUIDANCE_BODY_원문';
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const loadArgs = { id: 'core.guide', version: '1', kind: 'lookup', reason: 'Read the selected original', maxBytes: 65536 };
function manifest(id = 'core.guide'): GuidanceManifest {
  return { id, version: '1', title: `지침 ${id}`, summary: '원본 근거와 시간을 확인합니다. '.repeat(7), source: `fixture://${id}`,
    tenantId: 'synthetic', labels: ['synthetic'], supportedKinds: ['lookup', 'compare'], requiredRules: ['Keep original source provenance.'],
    byteLength: Buffer.byteLength(body), sha256: sha256(body) };
}
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
class Source implements GuidanceSource {
  manifests = [manifest()]; revision = 'source-1'; lists = 0; reads = 0; validations = 0; originalBytes = 0;
  readHook: ((signal?: AbortSignal) => Promise<void>) | null = null;
  validateHook: ((signal?: AbortSignal) => Promise<void>) | null = null;
  async list() { this.lists++; return structuredClone(this.manifests); }
  async listSnapshot(_input: { cursor: string | null; signal: AbortSignal }) {
    this.lists++; return { revision: this.revision, manifests: structuredClone(this.manifests), nextCursor: null };
  }
  async read(_id: string, _version: string, signal?: AbortSignal) {
    this.reads++; await this.readHook?.(signal); this.originalBytes += Buffer.byteLength(body); return new TextEncoder().encode(body);
  }
  async validate(value: GuidanceManifest, signal?: AbortSignal) {
    this.validations++; await this.validateHook?.(signal); this.originalBytes += Buffer.byteLength(body);
    const current = this.manifests.find(m => m.id === value.id && m.version === value.version);
    return Boolean(current && canonical(current as unknown as Json) === canonical(value as unknown as Json) && sha256(body) === value.sha256);
  }
}
async function setup(family: Family) {
  const scenario = validateScenario(JSON.parse(readFileSync(new URL(`../../fixtures/${family}.json`, import.meta.url), 'utf8')));
  const state = new MemoryStateRepository(); const artifacts = new MemoryArtifactStore(); const source = new Source(); const clock = new FakeClock(1788566400000);
  const initial = newWork({ id: workId, now: clock.now(), goal: scenario.goal, policy: { ...scenario.policy, allowedTools: [...RESOURCE_TOOL_IDS] },
    limits: { toolCalls: 20, modelCalls: 3, tokens: 10000, replans: 10, wallTimeMs: 100000 } });
  await state.commit({ workId, expectedRevision: 0, commandId: 'accept', commandDigest: 'synthetic-guidance-resource', next: initial,
    events: [{ type: 'accepted', at: clock.now(), data: {} }], deliveries: [] });
  const composed = await composeRuntime({ services: { state, artifacts, clock, tools: [], planner: new ScriptedPlanner([]),
    ids: new RandomIds(), digester: new Sha256Digester(), sink: new FakeSink() }, schemas: new AjvSchemas(), guidanceSource: source, owner: 'guidance-resource-test', enablePlanning: false });
  let calls = 0;
  const task = (toolId: string, input: Record<string, Json>): TaskSpec => ({ id: `guidance-call-${++calls}`, description: 'Read synthetic guidance through its resource contract',
    toolId, toolVersion: '1', input, effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: [] });
  const invoke = async (toolId: string, input: Record<string, Json>, policy?: Policy, signal = new AbortController().signal) => {
    const current = await composed.runtime.state(workId); const selected = task(toolId, input);
    return composed.contracts.get(toolId, '1')!.tool.execute(selected, { workId, attemptId: selected.id, policy: policy ?? current.policy, signal });
  };
  const execute = async (input: Record<string, Json>) => {
    const current = await composed.runtime.state(workId); const selected = task('core.guidance.load', input);
    await composed.runtime.submitPlan(workId, `plan:${selected.id}`, { baseStateRevision: current.revision, baseGoalRevision: current.goal.revision,
      basePlanRevision: current.plan?.revision ?? 0, reason: 'Load a selected version through the execution ledger', tasks: [selected], hypotheses: [] });
    const reserved = await composed.runtime.reserve(workId, selected.id); await composed.runtime.execute(workId, reserved.id); await composed.runtime.adopt(workId, reserved.id);
    const after = await composed.runtime.state(workId); const attempt = after.attempts.find(a => a.id === reserved.id)!;
    assert.equal(attempt.adopted, true); assert.ok(attempt.resultArtifact); assert.ok(await state.receipt(workId, `dispatch:${attempt.id}`));
    const result = ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(await artifacts.get(attempt.resultArtifact, after.policy))));
    assert.equal(result.status, 'success'); return result;
  };
  return { ...composed, state, source, invoke, execute };
}
type Harness = Awaited<ReturnType<typeof setup>>;
async function edit(f: Harness, id: string, change: (state: WorkState) => void) { await transact(f.services, workId, id, 'synthetic_guidance_resource_change', { id }, change); }
function output(result: ToolResult): Record<string, Json> { assert.ok(result.output && typeof result.output === 'object' && !Array.isArray(result.output)); return result.output; }
function unavailable(result: ToolResult) {
  assert.ok(result.status === 'error' || result.status === 'cancelled'); assert.equal(result.output, null); assert.deepEqual(result.artifacts, []);
  assert.doesNotMatch(JSON.stringify(result), /ORIGINAL_GUIDANCE_BODY/);
}

for (const family of families) {
  test(`guidance resources ${family}: cold and hot runtime loads retain provenance and report original I/O separately`, async t => {
    const f = await setup(family); const before = await f.runtime.state(workId);
    const cold = await f.execute(loadArgs); const coldMetrics = f.guidance.metrics(); const coldBytes = f.source.originalBytes;
    const hot = await f.execute({ ...loadArgs, reason: 'Review the current source again', kind: 'compare' }); const hotMetrics = f.guidance.metrics();
    assert.equal(output(cold)['body'], body); assert.equal(output(hot)['body'], body); assert.deepEqual(cold.artifacts, hot.artifacts);
    assert.equal(output(hot)['role'], 'guidance_only'); assert.equal(output(hot)['grantsPermissions'], false);
    assert.equal((output(hot)['selectedFor'] as Record<string, Json>)['reason'], 'Review the current source again');
    assert.equal((output(hot)['method'] as Record<string, Json>)['id'], 'core.evidence-comparison');
    assert.equal(coldMetrics.sourceReadCalls, 1); assert.equal(hotMetrics.sourceReadCalls, 1);
    assert.equal(coldMetrics.sourceValidateCalls, 1); assert.equal(hotMetrics.sourceValidateCalls, 2);
    assert.equal(hotMetrics.artifactPutCalls, 1); assert.equal(hotMetrics.bodyDecodes, 1); assert.equal(hotMetrics.cacheHits, 1);
    assert.equal(coldBytes, Buffer.byteLength(body) * 2); assert.equal(f.source.originalBytes - coldBytes, Buffer.byteLength(body));
    const after = await f.runtime.state(workId); assert.equal(after.budget.used.toolCalls, 2); assert.equal(after.evidence.length, 0);
    assert.deepEqual(after.policy, before.policy); assert.deepEqual(after.goal, before.goal);
    t.diagnostic(JSON.stringify({ family, coldOriginalBytes: coldBytes, hotOriginalBytes: f.source.originalBytes - coldBytes, coldMetrics, hotMetrics }));
  });

  test(`guidance resources ${family}: policy revocation during a hot validation suppresses the cached body`, async () => {
    const f = await setup(family); assert.equal((await f.invoke('core.guidance.load', loadArgs)).status, 'success');
    f.source.validateHook = async () => { await edit(f, 'revoke-label', state => { state.policy.allowedLabels = ['public']; }); };
    unavailable(await f.invoke('core.guidance.load', loadArgs)); assert.equal(f.source.reads, 1);
  });

  test(`guidance resources ${family}: a goal change while the source read waits cannot return the previous selection`, async () => {
    const f = await setup(family);
    f.source.readHook = async () => { await edit(f, 'change-goal', state => { state.goal = { ...state.goal, revision: state.goal.revision + 1, scope: 'new-guidance-scope' }; }); };
    unavailable(await f.invoke('core.guidance.load', loadArgs));
  });

  test(`guidance resources ${family}: a refreshed version cannot be replaced by an in-flight older load`, async () => {
    const f = await setup(family);
    f.source.readHook = async () => {
      f.source.manifests = [{ ...manifest(), version: '2', requiredRules: ['New version rule'] }]; f.source.revision = 'source-2';
      await f.guidance.refresh();
    };
    unavailable(await f.invoke('core.guidance.load', loadArgs));
    assert.equal(f.guidance.describe(await f.runtime.state(workId), 'core.guide', '2').version, '2');
    assert.equal(f.guidance.metrics().cachedBodies, 0);
  });

  test(`guidance resources ${family}: cancellation reaches a pending source and returns no late body`, { timeout: 3000 }, async () => {
    const f = await setup(family); const entered = gate<AbortSignal | undefined>(); const finish = gate<void>(); const controller = new AbortController();
    f.source.readHook = async signal => { entered.resolve(signal); await finish.promise; };
    const pending = f.invoke('core.guidance.load', loadArgs, undefined, controller.signal);
    try {
      assert.equal(await entered.promise, controller.signal); controller.abort(); unavailable(await pending);
      assert.equal(f.guidance.metrics().artifactPutCalls, 0); assert.equal(f.guidance.metrics().cachedBodies, 0);
    } finally { controller.abort(); finish.resolve(); await pending; }
  });
}

test('guidance resources: paginated cards respect the complete output byte budget and never read guidance bodies', async () => {
  const f = await setup('documents-simple');
  const visible = Array.from({ length: 9 }, (_, n) => manifest(`core.guide-${n}`));
  f.source.manifests = [...visible, { ...manifest('core.secret'), labels: ['restricted'] }, { ...manifest('core.foreign'), tenantId: 'other' },
    { ...manifest('core.wrong-kind'), supportedKinds: ['followup'] }]; await f.guidance.refresh();
  const found: string[] = []; let cursor: string | null = null; let pages = 0;
  do {
    const result = await f.invoke('core.guidance.find', { kind: 'lookup', limit: 20, maxBytes: 1800, cursor }); const page = output(result);
    assert.equal(page['status'], 'available'); assert.ok(bytes(page) <= 1800); assert.equal(page['byteLength'], bytes(page));
    const cards = page['cards'] as Record<string, Json>[]; assert.ok(cards.length > 0); found.push(...cards.map(card => card['id'] as string));
    const more = page['hasMore'] as boolean; assert.equal(result.status, more ? 'partial' : 'success'); assert.equal(result.coverage, more ? 'partial' : 'complete');
    cursor = page['nextCursor'] as string | null; assert.equal(cursor !== null, more); assert.ok(++pages < 10);
  } while (cursor !== null);
  assert.ok(pages > 1); assert.deepEqual(found, visible.map(m => m.id)); assert.equal(new Set(found).size, visible.length);
  assert.equal(f.source.reads, 0); assert.equal(f.source.validations, 0);
  const small = await f.invoke('core.guidance.find', { kind: 'lookup', limit: 20, maxBytes: 256 }); const page = output(small);
  assert.equal(small.status, 'partial'); assert.equal(page['status'], 'too_large'); assert.deepEqual(page['cards'], []);
  assert.equal(page['nextCursor'], null); assert.ok(bytes(page) <= 256); assert.equal(f.source.reads, 0);
});

test('guidance resources: cursors cannot cross kind, caller labels, owner or a refreshed listing', async () => {
  const f = await setup('observations-simple'); f.source.manifests = [manifest('core.first'), manifest('core.second')]; await f.guidance.refresh();
  const first = output(await f.invoke('core.guidance.find', { kind: 'lookup', limit: 1, maxBytes: 4096 }));
  const cursor = first['nextCursor']; assert.equal(typeof cursor, 'string'); const policy = (await f.runtime.state(workId)).policy;
  unavailable(await f.invoke('core.guidance.find', { kind: 'compare', limit: 1, maxBytes: 4096, cursor: cursor! }));
  for (const current of [{ ...policy, allowedLabels: [] }, { ...policy, principalId: 'other-owner' }]) {
    unavailable(await f.invoke('core.guidance.find', { kind: 'lookup', limit: 1, maxBytes: 4096, cursor: cursor! }, current));
  }
  const hidden = output(await f.invoke('core.guidance.find', { kind: 'lookup', limit: 1, maxBytes: 4096 }, { ...policy, allowedLabels: [] }));
  assert.deepEqual(hidden['cards'], []); assert.equal(hidden['hasMore'], false);
  await f.guidance.refresh(); unavailable(await f.invoke('core.guidance.find', { kind: 'lookup', limit: 1, maxBytes: 4096, cursor: cursor! }));
  assert.equal(f.source.reads, 0);
});

test('guidance resources: legacy discovery keeps its original shape and current method in both work families', async () => {
  for (const family of families) {
    const f = await setup(family); const before = await f.runtime.state(workId);
    const result = await f.invoke('core.guidance.find', { kind: 'lookup', limit: 20 }); const reply = output(result);
    assert.deepEqual(Object.keys(reply).sort(), ['cards', 'hasMore', 'method']);
    assert.deepEqual(reply, { ...f.guidance.list(before, 'lookup', 20), method: f.guidance.method(before, 'lookup') });
    assert.equal(result.status, 'success'); assert.equal(f.source.reads, 0); assert.equal(f.source.validations, 0);
    assert.deepEqual(await f.runtime.state(workId), before);
  }
});

test('guidance resources: optional paging fields are strict and pre-aborted discovery performs no original reads', async () => {
  const f = await setup('documents-simple'); const entry = f.contracts.get('core.guidance.find', '1')!;
  for (const args of [{ kind: 'lookup', limit: 20 }, { kind: 'lookup', limit: 20, maxBytes: 256, cursor: null }]) assert.equal(entry.input(args), true);
  for (const args of [{ kind: 'lookup', limit: 21 }, { kind: 'lookup', limit: 1, maxBytes: 255 }, { kind: 'lookup', limit: 1, cursor: '' },
    { kind: 'lookup', limit: 1, cursor: 'x'.repeat(1025) }, { kind: 'lookup', limit: 1, principalId: 'other-owner' }]) assert.equal(entry.input(args), false);
  const controller = new AbortController(); controller.abort(); const result = await f.invoke('core.guidance.find', { kind: 'lookup', limit: 1, maxBytes: 4096 }, undefined, controller.signal);
  assert.equal(result.status, 'cancelled'); assert.equal(result.output, null); assert.equal(f.source.reads, 0); assert.equal(f.source.validations, 0);
});
