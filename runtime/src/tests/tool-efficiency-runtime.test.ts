import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { composeRuntime } from '../application/compose-runtime.js';
import { newWork } from '../application/new-work.js';
import { validateScenario } from '../application/fixtures.js';
import type { ArtifactStore, Tool, ToolDefinition } from '../application/ports.js';
import type { TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import { taskDigest } from '../application/plan-validator.js';
import { summarizeToolExecution } from '../application/tool-execution-usage.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { FixtureReadTool, FakeClock, FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { adapters, openRepository, command, type Adapter } from './state-conformance-helpers.js';

const families = [['documents-simple', 'doc-current'], ['observations-simple', 'collection-complete']] as const;
type Options = { reuse?: ToolDefinition['reuse']; fresh?: boolean; usage?: boolean; transform?: (result: ToolResult) => ToolResult };
async function setup(t: TestContext, adapter: Adapter = 'sqlite', family: typeof families[number] = families[0], options: Options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tool-efficiency-')); let repository = openRepository(adapter, directory);
  t.after(async () => { await repository.close(); await rm(directory, { recursive: true, force: true }); });
  const scenario = validateScenario(JSON.parse(readFileSync(new URL(`../../fixtures/${family[0]}.json`, import.meta.url), 'utf8')));
  const fixture = new FixtureReadTool(scenario.evidence); const clock = new FakeClock(1788566400000);
  const originalArtifacts = new FileArtifactStore(join(directory, 'artifacts')); let artifacts: ArtifactStore = originalArtifacts;
  const tool: Tool = { definition: { ...fixture.definition, ...(options.reuse ? { reuse: options.reuse } : {}) }, async execute(task, c) {
    let result = await fixture.execute(task, c);
    if (options.usage) result.usage = { transportCalls: 2, internalOperations: 3, imageBytes: 512, waitMs: 4 };
    if (options.transform) result = options.transform(result); return result;
  } };
  const seed = newWork({ id: 'work', goal: { ...scenario.goal, criteria: [...scenario.goal.criteria,
    { id: 'later', description: 'Require a later independent review', key: 'later.review', operator: 'present', equals: null, minIndependentSources: 1, requireCompleteCoverage: true }] },
    policy: { ...scenario.policy, allowedTools: [...scenario.policy.allowedTools, 'core.calls.get', 'core.catalog.search'] },
    limits: { toolCalls: 20, modelCalls: 5, tokens: 500000, replans: 5, wallTimeMs: 100000 }, now: clock.now() });
  assert.equal((await repository.commit(command(seed, 'seed'))).kind, 'committed');
  const compose = () => composeRuntime({ services: { state: repository, artifacts, clock, tools: [tool], ids: new RandomIds(),
    digester: new Sha256Digester(), planner: new ScriptedPlanner([]), sink: new FakeSink() }, schemas: new AjvSchemas(),
    guidanceSource: { list: async () => [], read: async () => { throw new Error('no_guidance'); } }, owner: 'efficiency', enablePlanning: false });
  let c = await compose();
  const tasks: TaskSpec[] = ['first', 'second', 'third'].map((id, index) => ({ id, description: 'Revisit the same source', toolId: 'fixture.read', toolVersion: '1',
    input: { evidenceIds: [family[1]] }, effect: 'read', maxAttempts: 1, satisfies: [], dependsOn: index ? [index === 1 ? 'first' : 'second'] : [],
    ...(options.fresh && index === 1 ? { freshness: 'fresh' as const } : {}) }));
  await c.runtime.submitPlan(seed.id, 'plan', { baseStateRevision: seed.revision, baseGoalRevision: 1, basePlanRevision: 0, reason: 'Measure reuse with evidence provenance', tasks, hypotheses: [] });
  const state = () => c.runtime.state(seed.id);
  const run = async (id: string) => { const a = await c.runtime.reserve(seed.id, id); await c.runtime.execute(seed.id, a.id); await c.runtime.adopt(seed.id, a.id); return (await state()).attempts.find(x => x.id === a.id)!; };
  const mutate = async (edit: (s: WorkState) => void) => { const next = await state(); next.revision++; edit(next); assert.equal((await repository.commit(command(next, `edit-${next.revision}`))).kind, 'committed'); };
  return { c: () => c, state, run, mutate, clock, fixture, tool, tasks, originalArtifacts,
    reopen: async () => { await repository.close(); repository = openRepository(adapter, directory); c = await compose(); },
    wrapArtifacts: async (value: ArtifactStore) => { artifacts = value; c = await compose(); } };
}

for (const adapter of adapters) for (const family of families) {
  test(`${adapter}/${family[0]}: durable reuse keeps evidence identity and charges source costs once after reopen`, async t => {
    const h = await setup(t, adapter, family, { reuse: { mode: 'immutable', sourceVersion: 'fixture-snapshot-1' }, usage: true });
    const first = await h.run('first'); await h.reopen(); const second = await h.run('second'); const third = await h.run('third');
    assert.equal(h.fixture.invocations.length, 1); assert.equal(first.execution?.mode, 'invoked');
    assert.equal(second.reuse?.attemptId, first.id); assert.equal(third.reuse?.attemptId, first.id);
    assert.equal(second.reuse?.observedAt, first.startedAt); assert.equal(second.execution?.implementationCalls, 0);
    const s = await h.state(); assert.equal(s.budget.used.toolCalls, 3); assert.equal(s.budget.reservedToolCalls, 0); assert.equal(s.evidence.length, 1);
    assert.deepEqual(summarizeToolExecution(s), { logicalAttempts: 3, invoked: 1, reused: 2, notInvoked: 0, unknownInvocations: 0,
      transportCalls: { measured: 2, unknown: 0 }, internalOperations: { measured: 3, unknown: 0 }, imageBytes: { measured: 512, unknown: 0 }, waitMs: { measured: 4, unknown: 0 } });
    const history = await h.c().resources.result('work', s.policy, second.id, 65536);
    assert.equal(history.status, 'available'); assert.match(JSON.stringify(history), /"newObservation":false/);
    const context = await h.c().context.prepare(s, { callId: 'warm-context', maxOutputTokens: 1024, maxInputBytes: 1000000, maxInputTokens: 1000000 });
    assert.equal(context.packet.toolObservations?.find(o => o.attemptId === second.id)?.reuse?.attemptId, first.id);
    assert.equal(h.fixture.invocations.length, 1);
  });
}

for (const adapter of adapters) {
  test(`${adapter}: default deny and fresh request perform actual reads, unreported adapter costs stay unknown`, async t => {
    const h = await setup(t, adapter); await h.run('first'); await h.run('second');
    assert.equal(h.fixture.invocations.length, 2); assert.deepEqual(summarizeToolExecution(await h.state()).transportCalls, { measured: 0, unknown: 2 });
    const fresh = await setup(t, adapter, families[0], { reuse: { mode: 'immutable', sourceVersion: '1' }, fresh: true });
    await fresh.run('first'); assert.equal((await fresh.run('second')).execution?.mode, 'invoked'); assert.equal(fresh.fixture.invocations.length, 2);
  });
  test(`${adapter}: TTL boundary makes a new read and adoption after expiry rejects an already-stored hit`, async t => {
    const h = await setup(t, adapter, families[0], { reuse: { mode: 'ttl', maxAgeMs: 100 } }); await h.run('first');
    h.clock.advance(99); const a = await h.c().runtime.reserve('work', 'second'); await h.c().runtime.execute('work', a.id);
    assert.equal((await h.state()).attempts[1]!.execution?.mode, 'reused'); h.clock.advance(1);
    await h.c().runtime.adopt('work', a.id); assert.equal((await h.state()).attempts[1]!.adopted, false);
    assert.equal((await h.state()).attempts[1]!.error?.code, 'reuse_source_changed'); assert.equal(h.fixture.invocations.length, 1);
    const expired = await setup(t, adapter, families[0], { reuse: { mode: 'ttl', maxAgeMs: 100 } }); await expired.run('first'); expired.clock.advance(100);
    assert.equal((await expired.run('second')).execution?.mode, 'invoked'); assert.equal(expired.fixture.invocations.length, 2);
  });
  test(`${adapter}: a changed principal cannot reuse a result obtained under the old policy`, async t => {
    const h = await setup(t, adapter, families[0], { reuse: { mode: 'immutable', sourceVersion: '1' } }); await h.run('first');
    await h.mutate(s => { s.policy.principalId = 'different-person'; });
    assert.equal((await h.run('second')).execution?.mode, 'invoked'); assert.equal(h.fixture.invocations.length, 2);
  });
  test(`${adapter}: contract changes before dispatch fail without invoking; unrelated registry changes keep a selected contract usable`, async t => {
    const h = await setup(t, adapter); const c = h.c(); const a = await c.runtime.reserve('work', 'first');
    c.contracts.replaceProvider('fixture', [{ ...h.tool, definition: { ...h.tool.definition, description: 'changed selected contract' } }], { expectedEpoch: 1, sourceRevision: '2' });
    await assert.rejects(c.runtime.execute('work', a.id), /tool_contract_changed/); assert.equal(h.fixture.invocations.length, 0);
    assert.equal((await h.state()).budget.used.toolCalls, 0);
    assert.deepEqual(await c.runtime.step('work'), { kind: 'blocked', reason: 'tool_contract_changed' });
    assert.equal((await h.state()).budget.reservedToolCalls, 0); assert.equal((await h.state()).attempts[0]!.status, 'failed');
    const stable = await setup(t, adapter); const attempt = await stable.c().runtime.reserve('work', 'first');
    stable.c().contracts.replaceProvider('other', [{ ...stable.tool, definition: { ...stable.tool.definition, provider: 'other', id: 'other.read' } }], { expectedEpoch: 0, sourceRevision: '1' });
    await stable.c().runtime.execute('work', attempt.id); assert.equal(stable.fixture.invocations.length, 1);
  });
  test(`${adapter}: a reuse clone cannot survive source custody removal in history, copies, or context`, async t => {
    const h = await setup(t, adapter, families[0], { reuse: { mode: 'immutable', sourceVersion: '1' } });
    const first = await h.run('first'); const second = await h.run('second');
    const before = await h.state(); const blocked = first.resultArtifact!.id;
    await h.mutate(s => { s.dataLifecycle = { generation: 1, blockedArtifactIds: [blocked], changes: [] }; });
    await assert.rejects(h.c().resources.result('work', before.policy, second.id, 65536), /invocation_unavailable/);
    await assert.rejects(h.c().context.prepare(await h.state(), { callId: 'blocked', maxOutputTokens: 256, maxInputBytes: 100000, maxInputTokens: 100000 }), /invocation_unavailable/);
    assert.equal(h.fixture.invocations.length, 1);
  });
  test(`${adapter}: original artifact is rechecked at the adoption commit boundary`, async t => {
    const h = await setup(t, adapter, families[0], { reuse: { mode: 'ttl', maxAgeMs: 100 } }); await h.run('first');
    const a = await h.c().runtime.reserve('work', 'second'); await h.c().runtime.execute('work', a.id);
    let checked = false;
    await h.wrapArtifacts({ put: h.originalArtifacts.put.bind(h.originalArtifacts), get: h.originalArtifacts.get.bind(h.originalArtifacts),
      async exists(ref) { if (!checked) { checked = true; h.clock.advance(100); } return h.originalArtifacts.exists(ref); } });
    await h.c().runtime.adopt('work', a.id); assert.equal(checked, true);
    assert.equal((await h.state()).attempts[1]!.adopted, false); assert.equal((await h.state()).attempts[1]!.error?.code, 'reuse_source_changed');
  });
  test(`${adapter}: a dispatched call without a received measurement remains unknown after reopen`, async t => {
    const h = await setup(t, adapter); const a = await h.c().runtime.reserve('work', 'first'); await h.c().runtime.dispatch('work', a.id); await h.reopen();
    const metrics = summarizeToolExecution(await h.state()); assert.equal(metrics.logicalAttempts, 1); assert.equal(metrics.invoked, 0); assert.equal(metrics.unknownInvocations, 1);
    assert.equal(h.fixture.invocations.length, 0);
  });
  test(`${adapter}: unsent cancellation and legacy reservation expiry do not create unknown execution costs`, async t => {
    const h = await setup(t, adapter); await h.c().runtime.reserve('work', 'first'); const before = await h.state();
    await h.c().runtime.command('work', 'pause-reservation', before.policy, before.goal.revision, { kind: 'pause', reason: 'Pause before sending' });
    const cancelled = await h.state(); const cost = summarizeToolExecution(cancelled);
    assert.equal(cost.logicalAttempts, 0); assert.equal(cost.unknownInvocations, 0); assert.equal(cost.notInvoked, 0); assert.equal(h.fixture.invocations.length, 0);
    const legacy = structuredClone(cancelled); const a = legacy.attempts[0]!; delete a.execution; delete a.contractDigest;
    a.status = 'failed'; a.error = { code: 'reservation_expired', retryable: true };
    assert.deepEqual(summarizeToolExecution(legacy), cost);
  });
  test(`${adapter}: emitted observation source contracts are checked even when that tool schema is not selected`, async t => {
    const h = await setup(t, adapter, families[0], { reuse: { mode: 'immutable', sourceVersion: '1' } }); await h.run('first'); await h.run('second');
    const s = await h.state(); const prepared = await h.c().context.prepare(s, { callId: 'source-pins', maxOutputTokens: 512, maxInputBytes: 1000000, maxInputTokens: 1000000 });
    const options = { ...prepared.options, tools: prepared.options.tools.filter(d => d.id !== 'fixture.read') };
    assert.ok(prepared.packet.toolObservations!.some(o => o.sourceContracts?.some(p => p.id === 'fixture.read')));
    assert.equal(h.c().context.definitionsCurrent(prepared.packet, options, s), true);
    h.c().contracts.replaceProvider('other', [], { expectedEpoch: 0, sourceRevision: '1' });
    assert.equal(h.c().context.definitionsCurrent(prepared.packet, options, s), true);
    h.c().contracts.replaceProvider('fixture', [], { expectedEpoch: 1, sourceRevision: '2' });
    assert.equal(h.c().context.definitionsCurrent(prepared.packet, options, s), false);
  });
  test(`${adapter}: registry removal while a context frame is staged prevents returning the prepared input`, async t => {
    const h = await setup(t, adapter); await h.run('first'); let removed = false;
    await h.wrapArtifacts({ get: h.originalArtifacts.get.bind(h.originalArtifacts), exists: h.originalArtifacts.exists.bind(h.originalArtifacts), async put(bytes, attributes) {
      if (!removed) { removed = true; h.c().contracts.replaceProvider('fixture', [], { expectedEpoch: 1, sourceRevision: '2' }); }
      return h.originalArtifacts.put(bytes, attributes);
    } });
    await assert.rejects(h.c().context.prepare(await h.state(), { callId: 'during-frame', maxOutputTokens: 512, maxInputBytes: 1000000, maxInputTokens: 1000000 }), /context_state_changed/);
    assert.equal(removed, true); assert.equal((await h.state()).contextHead ?? null, null);
  });
}

test('adapter-supplied reuse metadata cannot claim an invocation was avoided', async t => {
  const h = await setup(t, 'sqlite', families[0], { reuse: { mode: 'immutable', sourceVersion: '1' }, transform: result => ({ ...result,
    reuse: { attemptId: 'invented', resultId: 'invented', resultArtifact: { id: 'invented', sha256: 'a'.repeat(64), byteLength: 0,
      mediaType: 'application/json', tenantId: 'synthetic', labels: [] }, observedAt: 0, cacheKey: 'b'.repeat(64) } }) });
  const a = await h.run('first'); assert.equal(a.adopted, false); assert.equal(a.execution?.mode, 'invoked'); assert.equal(a.execution?.implementationCalls, 1);
  assert.equal(a.error?.code, 'invalid_tool_result'); assert.equal(a.reuse, undefined);
});

test('a write tool cannot declare reuse and changing freshness changes the immutable task digest', async () => {
  const fixture = new FixtureReadTool([]);
  assert.throws(() => new ToolContracts([{ definition: { ...fixture.definition, effect: 'write', reuse: { mode: 'ttl', maxAgeMs: 1 } }, execute: fixture.execute.bind(fixture) }], new AjvSchemas()), /invalid_contract/);
  const digest = new Sha256Digester(); const task: TaskSpec = { id: 't', description: 'Read', toolId: 'fixture.read', toolVersion: '1',
    input: { evidenceIds: ['record'] }, effect: 'read', maxAttempts: 1, satisfies: [], dependsOn: [] };
  assert.notEqual(taskDigest(task, digest), taskDigest({ ...task, freshness: 'fresh' }, digest));
});
