import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile, cp, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactStore, StateRepository, Tool } from '../application/ports.js';
import type { TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import type { GuidanceSource } from '../application/guidance.js';
import { GuidanceCatalog } from '../application/guidance.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { newWork } from '../application/new-work.js';
import { RESOURCE_TOOL_IDS } from '../application/resource-tools.js';
import { validateScenario } from '../application/fixtures.js';
import { ToolCatalog } from '../application/tool-catalog.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { ToolBroker } from '../application/tool-broker.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { FileGuidanceSource } from '../infrastructure/file-guidance.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { SqliteStateRepository } from '../infrastructure/sqlite-state.js';
import { FakeClock, FakeSink, FixtureReadTool, ScriptedPlanner } from '../infrastructure/fakes.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';

const actor = { tenantId: 'synthetic', principalId: 'learner' };
const directory = fileURLToPath(new URL('../../guidance/', import.meta.url));
const load = (family: string) => validateScenario(JSON.parse(readFileSync(new URL(`../../fixtures/${family}.json`, import.meta.url), 'utf8')));
class CountingGuidance implements GuidanceSource {
  bodiesRead = 0;
  constructor(readonly source = new FileGuidanceSource(directory)) {}
  list() { return this.source.list(); }
  read(id: string, version: string) { this.bodiesRead++; return this.source.read(id, version); }
}
async function harness(family = 'documents-simple', store: StateRepository = new MemoryStateRepository(), artifacts: ArtifactStore = new MemoryArtifactStore(), tool?: Tool) {
  const scenario = load(family); const sourceTool = tool ?? new FixtureReadTool(scenario.evidence); const guidance = new CountingGuidance();
  const policy = { ...scenario.policy, allowedTools: [...scenario.policy.allowedTools, ...RESOURCE_TOOL_IDS] };
  const initial = newWork({ id: 'w', goal: scenario.goal, policy, limits: { toolCalls: 20, modelCalls: 4, tokens: 10000, replans: 5, wallTimeMs: 100000 }, now: 1788566400000 });
  await store.commit({ workId: 'w', expectedRevision: 0, commandId: 'accept', commandDigest: 'accept', next: initial, events: [{ type: 'accepted', at: initial.createdAt, data: {} }], deliveries: [] });
  const services = { state: store, artifacts, planner: new ScriptedPlanner([]), clock: new FakeClock(initial.createdAt), ids: new RandomIds(), digester: new Sha256Digester(), tools: [sourceTool], sink: new FakeSink() };
  const composed = await composeRuntime({ services, schemas: new AjvSchemas(), guidanceSource: guidance, owner: 'resources-worker' });
  return { ...composed, services, scenario, sourceTool, source: guidance };
}
function task(id: string, toolId: string, input: TaskSpec['input'], dependsOn: string[] = []): TaskSpec {
  return { id, description: id, toolId, toolVersion: '1', input, dependsOn, effect: 'read', maxAttempts: 1, satisfies: [] };
}
async function plan(h: Awaited<ReturnType<typeof harness>>, tasks: TaskSpec[]) {
  const s = await h.runtime.state('w');
  await h.runtime.submitPlan('w', `plan:${s.revision}`, { baseStateRevision: s.revision, baseGoalRevision: s.goal.revision, basePlanRevision: s.plan?.revision ?? 0, reason: 'load selected resources and verify evidence', tasks, hypotheses: [] });
}
async function mutate(store: StateRepository, edit: (s: WorkState) => void) {
  const s = (await store.get('w'))!; const next = structuredClone(s); next.revision++; edit(next);
  await store.commit({ workId: 'w', expectedRevision: s.revision, commandId: `test-update:${s.revision}`, commandDigest: 'test-update', next,
    events: [{ type: 'test_policy_or_evidence_update', at: next.updatedAt, data: {} }], deliveries: [] });
}

test('catalog filters before ranking, bounds cards, separates providers and loads only an exact schema', () => {
  const fixture = new FixtureReadTool([]); const policy = load('documents-simple').policy;
  const tools: Tool[] = ['alpha', 'beta', 'secret'].map(provider => ({ definition: { ...fixture.definition, provider, id: `${provider}.read`, description: `문서 document read ${provider}`, labels: provider === 'secret' ? ['restricted'] : [] }, execute: fixture.execute.bind(fixture) }));
  const contracts = new ToolContracts(tools, new AjvSchemas()); const catalog = new ToolCatalog(contracts, new Sha256Digester());
  const access = { ...policy, allowedTools: tools.map(t => t.definition.id) };
  const results = catalog.search(access, { query: '문서', limit: 1 });
  assert.equal(results.cards.length, 1); assert.equal(results.hasMore, true); assert.equal(results.cards[0]!.id, 'alpha.read');
  assert.equal('inputSchema' in results.cards[0]!, false);
  assert.deepEqual(catalog.search(access, { query: 'secret', limit: 20 }), { cards: [], hasMore: false });
  assert.equal(catalog.search(access, { query: 'beta.read', limit: 20 }).cards[0]!.provider, 'beta');
  assert.throws(() => catalog.describe(access, { id: 'secret.read', version: '1' }, 4096), /tool_unavailable/);
  assert.throws(() => catalog.describe(access, { id: 'alpha.read', version: 'unknown' }, 4096), /tool_unavailable/);
  const selected = catalog.describe(access, { id: 'beta.read', version: '1' }, 4096);
  assert.equal(selected.status, 'available'); assert.equal(selected.card.provider, 'beta');
  assert.throws(() => catalog.search(access, { query: 'read', limit: 21 }), /invalid_contract/);
  assert.equal(catalog.describe(access, { id: 'beta.read', version: '1' }, 256).status, 'too_large');
});

test('registration snapshots reject namespace/duplicates and cannot be mutated through adapters or catalog results', () => {
  const tool = new FixtureReadTool([]); let compilations = 0; const schemas = new AjvSchemas();
  const contracts = new ToolContracts([tool], { compile: schema => { compilations++; return schemas.compile(schema); } });
  const catalog = new ToolCatalog(contracts, new Sha256Digester()); const policy = load('documents-simple').policy;
  const before = catalog.describe(policy, { id: 'fixture.read', version: '1' }, 4096);
  tool.definition.description = 'modified outer object';
  assert.deepEqual(catalog.describe(policy, { id: 'fixture.read', version: '1' }, 4096), before);
  const entry = contracts.get('fixture.read', '1')!;
  assert.throws(() => { entry.tool.definition.effect = 'write'; }, TypeError);
  if (before.status === 'available') before.definition.description = 'modified returned copy';
  assert.notEqual(catalog.describe(policy, { id: 'fixture.read', version: '1' }, 4096).card.description, 'modified returned copy');
  for (let n = 0; n < 10; n++) contracts.check(task('read', 'fixture.read', { evidenceIds: ['source'] }), policy);
  assert.equal(compilations, 2);
  assert.throws(() => new ToolContracts([tool, tool], schemas), /duplicate_or_invalid_tool/);
  assert.throws(() => new ToolContracts([{ ...tool, definition: { ...tool.definition, provider: 'other' }, execute: tool.execute.bind(tool) }], schemas), /invalid_contract/);
});

for (const [family, source] of [['documents-simple', 'doc-current'], ['observations-simple', 'collection-complete']] as const) {
  test(`${family}: discovery and selected guidance share the execution ledger without adding evidence or permissions`, async () => {
    const h = await harness(family); const initial = await h.runtime.state('w');
    const method = h.guidance.method(initial, 'lookup'); assert.equal(method.id, 'core.direct-lookup'); assert.deepEqual(method.guidanceIds, []);
    assert.equal(h.source.bodiesRead, 0);
    await plan(h, [
      task('catalog', 'core.catalog.search', { query: 'fixture.read', limit: 2 }),
      task('schema', 'core.catalog.get', { id: 'fixture.read', version: '1', maxBytes: 4096 }, ['catalog']),
      task('method', 'core.guidance.find', { kind: 'lookup', limit: 2 }, ['schema']),
      task('guide', 'core.guidance.load', { id: 'core.evidence-review', version: '1', kind: 'lookup', reason: 'explicit learning example for source provenance', maxBytes: 4096 }, ['method']),
      task('source', 'fixture.read', { evidenceIds: [source] }, ['guide']),
    ]);
    assert.equal((await h.runtime.runUntilYield('w', 30)).kind, 'complete');
    const state = await h.runtime.state('w');
    assert.equal(state.budget.used.toolCalls, 5); assert.equal(state.budget.used.modelCalls, 0); assert.equal(h.source.bodiesRead, 1);
    assert.equal((h.sourceTool as FixtureReadTool).invocations.length, 1); assert.equal(state.evidence.length, 1); assert.deepEqual(state.policy, initial.policy);
    const evidence = await h.resources.evidence('w', actor, source, 4096); assert.equal(evidence.status, 'available');
    const calls = await h.resources.calls('w', actor, { toolId: 'fixture.read', toolVersion: '1', inputDigest: null, limit: 2 }); assert.equal(calls.cards.length, 1);
    const result = await h.resources.result('w', actor, calls.cards[0]!.attemptId, 4096); assert.equal(result.status, 'available');
    assert.match(JSON.stringify(result), /historical_tool_result/); assert.match(JSON.stringify(result), /"newObservation":false/);
    assert.equal((h.sourceTool as FixtureReadTool).invocations.length, 1);
    const guideAttempt = state.attempts.find(a => a.taskId === 'guide')!;
    const guideResult = await h.resources.result('w', actor, guideAttempt.id, 16384);
    assert.match(JSON.stringify(guideResult), /guidance_only/); assert.match(JSON.stringify(guideResult), /"grantsPermissions":false/);
    assert.equal(state.artifacts.length, 1);
  });
}

test('simple direct lookup does not load optional guidance or run a hypothesis review', async () => {
  const h = await harness(); const state = await h.runtime.state('w');
  assert.equal(h.guidance.method(state, 'lookup').requiresHypothesisReview, false);
  await plan(h, [task('source', 'fixture.read', { evidenceIds: ['doc-current'] })]);
  await h.runtime.runUntilYield('w'); assert.equal(h.source.bodiesRead, 0);
  assert.equal((await h.runtime.state('w')).budget.used.toolCalls, 1);
});

test('method selection follows contradiction, independence and response needs without model calls', async () => {
  const h = await harness('documents-complex'); const s = await h.runtime.state('w');
  assert.equal(h.guidance.method(s, 'compare').id, 'core.evidence-comparison');
  s.evidence = h.scenario.evidence.filter(e => ['doc-a-old', 'doc-b-current'].includes(e.id));
  if (s.evidence.length !== 2) s.evidence = h.scenario.checkpoints[1]!.evidenceIds.map(id => h.scenario.evidence.find(e => e.id === id)!);
  assert.equal(h.guidance.method(s, 'lookup').id, 'core.hypothesis-inquiry');
  s.evidence = []; s.obligations = [{ id: 'reply', kind: 'response', reason: 'owner needed', status: 'pending', wakeKey: 'reply', dueAt: null }];
  assert.equal(h.guidance.method(s, 'lookup').id, 'core.response-followup');
  assert.equal(h.source.bodiesRead, 0); assert.equal(h.services.planner.inputs.length, 0);
});

test('guidance metadata/limits do not read bodies and wrong version, tenant or applicability are rejected', async () => {
  const h = await harness(); const s = await h.runtime.state('w');
  assert.equal(h.guidance.list(s, 'lookup', 1).cards.length, 1); assert.equal(h.source.bodiesRead, 0);
  const args = { id: 'core.evidence-review', version: '1', kind: 'lookup' as const, reason: 'read explicit instructions', maxBytes: 256 };
  assert.equal((await h.guidance.load(s, h.services.artifacts, args)).status, 'too_large'); assert.equal(h.source.bodiesRead, 0);
  await assert.rejects(h.guidance.load(s, h.services.artifacts, { ...args, version: '2', maxBytes: 4096 }), /guidance_unavailable/);
  await assert.rejects(h.guidance.load({ ...s, policy: { ...s.policy, tenantId: 'another' } }, h.services.artifacts, { ...args, maxBytes: 4096 }), /guidance_unavailable/);
  await assert.rejects(h.guidance.load({ ...s, policy: { ...s.policy, allowedLabels: [] } }, h.services.artifacts, { ...args, maxBytes: 4096 }), /guidance_unavailable/);
  const manifests = await h.source.list(); const restricted = await GuidanceCatalog.create({ list: async () => [{ ...manifests[0]!, supportedKinds: ['compare'] }], read: h.source.read.bind(h.source) });
  await assert.rejects(restricted.load(s, h.services.artifacts, { ...args, maxBytes: 4096 }), /guidance_unavailable/);
});

test('evidence readers distinguish protected/missing, superseded and retracted records; limits preserve provenance', async () => {
  const h = await harness();
  const ref = await h.services.artifacts.put(new TextEncoder().encode('original synthetic text '.repeat(30)), { tenantId: actor.tenantId, labels: ['synthetic'], mediaType: 'text/plain' });
  await mutate(h.services.state, s => { s.evidence = [{ ...h.scenario.evidence[0]!, artifact: ref }]; });
  assert.equal((await h.resources.original('w', actor, 'doc-current', 256)).status, 'too_large');
  const original = await h.resources.original('w', actor, 'doc-current', 4096); assert.equal(original.status, 'available'); assert.equal(original.locator, 'fixture://doc-current');
  assert.equal((await h.resources.evidence('w', actor, 'doc-current', 256)).status, 'too_large');
  await assert.rejects(h.resources.evidence('w', { ...actor, principalId: 'other' }, 'doc-current', 4096), /work_unavailable/);
  await assert.rejects(h.resources.evidence('w', { ...actor, allowedLabels: [] }, 'doc-current', 4096), /evidence_unavailable/);
  await mutate(h.services.state, s => { s.evidence[0]!.status = 'retracted'; });
  await assert.rejects(h.resources.evidence('w', actor, 'doc-current', 4096), /evidence_unavailable/);
  await mutate(h.services.state, s => { s.evidence[0]!.status = 'accepted'; s.evidence.push({ ...s.evidence[0]!, id: 'replacement', supersedes: ['doc-current'] }); });
  await assert.rejects(h.resources.evidence('w', actor, 'doc-current', 4096), /evidence_unavailable/);
  assert.equal((await h.resources.evidence('w', actor, 'replacement', 4096)).status, 'available');
});

test('call result lookup stays historical after retraction and does not restore it to current evidence', async () => {
  const h = await harness(); await plan(h, [task('source', 'fixture.read', { evidenceIds: ['doc-current'] })]); await h.runtime.runUntilYield('w');
  const attempt = (await h.runtime.state('w')).attempts[0]!;
  assert.equal((await h.resources.calls('w', actor, { toolId: 'fixture.read', toolVersion: '1', inputDigest: '0'.repeat(64), limit: 2 })).cards.length, 0);
  await mutate(h.services.state, s => { s.evidence[0]!.status = 'retracted'; });
  const before = await h.runtime.state('w');
  const result = await h.resources.result('w', actor, attempt.id, 4096); assert.match(JSON.stringify(result), /"evidenceCurrent":false/);
  assert.deepEqual(await h.runtime.state('w'), before); assert.equal((h.sourceTool as FixtureReadTool).invocations.length, 1);
  await mutate(h.services.state, s => { s.policy.allowedLabels = []; });
  await assert.rejects(h.resources.result('w', actor, attempt.id, 4096), /invocation_unavailable/);
  assert.equal((await h.resources.calls('w', actor, { toolId: 'core.calls.get', toolVersion: '1', inputDigest: null, limit: 2 })).cards.length, 0);
});

test('broker rejects calls without a committed dispatch or with another owner before reaching a tool', async () => {
  const h = await harness(); const broker = new ToolBroker(h.services.state, h.contracts, h.services.digester, h.services.clock);
  await assert.rejects(broker.invoke('w', 'invented', 'resources-worker', new AbortController().signal), /broker_dispatch_missing/);
  await plan(h, [task('source', 'fixture.read', { evidenceIds: ['doc-current'] })]); const a = await h.runtime.reserve('w', 'source');
  await h.runtime.dispatch('w', a.id);
  await assert.rejects(broker.invoke('w', a.id, 'another-owner', new AbortController().signal), /broker_execution_not_current/);
  assert.equal((h.sourceTool as FixtureReadTool).invocations.length, 0);
});

test('in-flight output is not downgraded to a less restricted artifact when labels are revoked', async () => {
  let release!: (result: ToolResult) => void; let start!: (id: string) => void;
  const started = new Promise<string>(resolve => { start = resolve; });
  const tool: Tool = { definition: new FixtureReadTool([]).definition, execute: async (_task, c) => { start(c.attemptId); return new Promise<ToolResult>(resolve => { release = resolve; }); } };
  const h = await harness('documents-simple', undefined, undefined, tool);
  await plan(h, [task('source', 'fixture.read', { evidenceIds: ['doc-current'] })]); const a = await h.runtime.reserve('w', 'source');
  const executing = h.runtime.execute('w', a.id); await started;
  await mutate(h.services.state, s => { s.policy.allowedLabels = []; });
  release({ resultId: 'r', attemptId: a.id, status: 'success', effectState: 'none', evidence: [], artifacts: [], output: { privateValue: 'synthetic restricted content' }, error: null, cursor: null, coverage: 'complete' });
  await executing; await h.runtime.adopt('w', a.id);
  const state = await h.runtime.state('w'); assert.equal(state.attempts[0]!.adopted, false);
  const bytes = await h.services.artifacts.get(state.attempts[0]!.resultArtifact!, state.policy);
  assert.doesNotMatch(new TextDecoder().decode(bytes), /synthetic restricted content/);
  assert.equal(JSON.parse(new TextDecoder().decode(bytes)).error.code, 'invalid_tool_result');
  assert.equal(state.attempts[0]!.error?.code, 'tool_permission_denied');
});

test('revocation after result storage settles without reading protected bytes or repeatedly getting stuck', async () => {
  const h = await harness(); await plan(h, [task('source', 'fixture.read', { evidenceIds: ['doc-current'] })]);
  const a = await h.runtime.reserve('w', 'source'); await h.runtime.execute('w', a.id);
  const original = (await h.runtime.state('w')).attempts[0]!.resultArtifact!;
  await mutate(h.services.state, s => { s.policy.allowedLabels = []; });
  await h.runtime.adopt('w', a.id); const state = await h.runtime.state('w');
  assert.equal(state.attempts[0]!.status, 'failed'); assert.equal(state.attempts[0]!.error?.code, 'result_permission_revoked');
  assert.deepEqual(state.attempts[0]!.resultArtifact, original); assert.equal(state.evidence.length, 0);
});

test('stored guidance and invocation results can be read after SQLite/artifact/source restart without source execution', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-resource-restart-')); const db = join(dir, 'state.sqlite'); let store = new SqliteStateRepository(db);
  try {
    const h = await harness('documents-simple', store, new FileArtifactStore(join(dir, 'objects')));
    await plan(h, [task('guide', 'core.guidance.load', { id: 'core.evidence-review', version: '1', kind: 'lookup', reason: 'explicit guidance selection', maxBytes: 4096 }), task('source', 'fixture.read', { evidenceIds: ['doc-current'] }, ['guide'])]);
    await h.runtime.runUntilYield('w'); const attempts = (await h.runtime.state('w')).attempts;
    await store.close(); store = new SqliteStateRepository(db);
    const restored = await composeRuntime({ services: { ...h.services, state: store, artifacts: new FileArtifactStore(join(dir, 'objects')) }, schemas: new AjvSchemas(), guidanceSource: new FileGuidanceSource(directory), owner: 'restored' });
    for (const a of attempts) assert.equal((await restored.resources.result('w', actor, a.id, 16384)).status, 'available');
    assert.equal((h.sourceTool as FixtureReadTool).invocations.length, 1);
    assert.equal((await restored.runtime.state('w')).budget.used.toolCalls, 2);
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('guidance source rejects altered content, path escape and symlink replacement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-guidance-integrity-'));
  try {
    await cp(directory, join(dir, 'pack'), { recursive: true }); const pack = join(dir, 'pack');
    const source = new FileGuidanceSource(pack); const manifest = (await source.list())[0]!;
    await writeFile(join(pack, 'evidence-review.md'), 'changed');
    await assert.rejects(source.read(manifest.id, manifest.version), /guidance_integrity_failure/);
    const catalog = JSON.parse(readFileSync(join(pack, 'catalog.json'), 'utf8'));
    catalog.entries[0].bodyFile = '../outside.md'; await writeFile(join(dir, 'outside.md'), 'outside'); await writeFile(join(pack, 'catalog.json'), JSON.stringify(catalog));
    await assert.rejects(new FileGuidanceSource(pack).read(manifest.id, manifest.version), /guidance_path_invalid/);
    catalog.entries[0].bodyFile = 'linked.md'; await writeFile(join(pack, 'catalog.json'), JSON.stringify(catalog)); await symlink(join(dir, 'outside.md'), join(pack, 'linked.md'));
    await assert.rejects(new FileGuidanceSource(pack).read(manifest.id, manifest.version), /guidance_path_invalid/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('model-facing evidence and call readers use the common budget without reexecuting a source or completing a changed goal', async () => {
  const h = await harness(); await plan(h, [task('source', 'fixture.read', { evidenceIds: ['doc-current'] })]); await h.runtime.runUntilYield('w');
  const before = await h.runtime.state('w'); const sourceAttempt = before.attempts[0]!;
  await h.runtime.command('w', 'extend-goal', actor, 1, { kind: 'goal', expectedControlRevision: before.executionControl?.revision ?? 1, goal: { ...before.goal, revision: 2, criteria: [...before.goal.criteria,
    { id: 'review', description: '추가 검토 회신 필요', key: 'review.note', operator: 'present', equals: null, minIndependentSources: 1, requireCompleteCoverage: true }] } });
  await plan(h, [task('evidence-view', 'core.evidence.get', { evidenceId: 'doc-current', detail: 'evidence', maxBytes: 4096 }),
    task('history', 'core.calls.find', { toolId: 'fixture.read', toolVersion: '1', inputDigest: sourceAttempt.inputDigest, limit: 2 }, ['evidence-view']),
    task('stored-result', 'core.calls.get', { attemptId: sourceAttempt.id, maxBytes: 4096 }, ['history'])]);
  assert.deepEqual(await h.runtime.runUntilYield('w'), { kind: 'replan', reason: 'plan_cannot_complete_goal' });
  const state = await h.runtime.state('w');
  assert.equal(state.budget.used.toolCalls, 4); assert.equal((h.sourceTool as FixtureReadTool).invocations.length, 1);
  assert.equal(state.evidence.length, 1); assert.equal(state.attempts.filter(a => a.adopted).length, 4);
  assert.deepEqual(state.evidence, before.evidence);
  assert.equal(state.progress!.policy.maxUnproductiveSteps, 3); assert.equal(state.progress!.consecutiveUnproductive, 2);
  assert.notEqual(state.status, 'completed'); assert.equal(state.goal.revision, 2);
});
