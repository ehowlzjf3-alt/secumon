import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ArtifactRef, TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import { acceptedToolProgressKeys, captureProgress } from '../application/work-progress.js';
import { evaluateCompletion } from '../domain/completion.js';
import { asJson } from '../application/plan-validator.js';
import { RESOURCE_TOOL_IDS } from '../application/resource-tools.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { validateScenario } from '../application/fixtures.js';
import { newWork } from '../application/new-work.js';
import { FileGuidanceSource } from '../infrastructure/file-guidance.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { FakeClock, FakeSink, FixtureReadTool, ScriptedPlanner } from '../infrastructure/fakes.js';
import { RandomIds, Sha256Digester, sha256 } from '../infrastructure/digest.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { adapters, attempt, command, initial, openRepository, type Adapter } from './state-conformance-helpers.js';

const digester = new Sha256Digester();
const definition = { provider: 'fixture', id: 'fixture.read', version: '1', description: 'Read local synthetic evidence', effect: 'read' as const,
  destination: 'local', labels: ['synthetic'], inputSchema: { type: 'object' }, outputSchema: { type: 'object' } };
const card = { provider: definition.provider, id: definition.id, version: definition.version, description: definition.description, effect: definition.effect,
  contractDigest: digester.digest(asJson(definition)) };
const body = '# Synthetic guidance\nCheck the original source.';
const manifest = { id: 'core.synthetic-guide', version: '1', title: 'Synthetic guidance', summary: 'Check the source', source: 'local:synthetic-guide',
  tenantId: 'tenant-a', labels: ['synthetic'], supportedKinds: ['lookup' as const], sha256: sha256(body), byteLength: new TextEncoder().encode(body).byteLength, requiredRules: ['Preserve provenance'] };
const guideCard = { id: manifest.id, version: manifest.version, title: manifest.title, summary: manifest.summary, sha256: manifest.sha256, byteLength: manifest.byteLength };
const guideArtifact: ArtifactRef = { id: 'guide-original', sha256: manifest.sha256, byteLength: manifest.byteLength, mediaType: 'text/markdown', tenantId: manifest.tenantId, labels: manifest.labels };
function task(id: string, toolId: string, input: TaskSpec['input'], dependsOn: string[] = []): TaskSpec {
  return { id, description: 'Synthetic resource preparation', toolId, toolVersion: '1', input, dependsOn, effect: 'read', maxAttempts: 1, satisfies: [] };
}
function localState() { const state = initial('resource-progress'); state.policy.allowedTools.push(...RESOURCE_TOOL_IDS); return state; }
function accepted(state: WorkState, selected: TaskSpec, output: unknown, artifacts: ArtifactRef[] = [], partial = false) {
  const id = `attempt-${state.attempts.length}`; const result: ToolResult = { resultId: `${id}:result`, attemptId: id, status: partial ? 'partial' : 'success',
    effectState: 'none', evidence: [], artifacts, output: asJson(output), error: null, cursor: null, coverage: partial ? 'partial' : 'complete' };
  state.attempts.push({ ...attempt(partial ? 'partial' : 'succeeded'), id, taskId: selected.id, toolId: selected.toolId, toolVersion: selected.toolVersion,
    scope: state.goal.scope, resultId: result.resultId, adopted: true });
  for (const ref of artifacts) if (!state.artifacts.some(value => value.id === ref.id)) state.artifacts.push(ref);
  return { selected, result, keys: () => acceptedToolProgressKeys(state, selected, result, digester),
    capture: () => captureProgress(state, digester, `${id}:settled`, 1000, { additionalKeys: acceptedToolProgressKeys(state, selected, result, digester) }) };
}
function loadOutput(state: WorkState) {
  return { status: 'available', manifest, artifact: guideArtifact, body, selectedFor: { workId: state.id, goalRevision: state.goal.revision, kind: 'lookup', reason: 'Check provenance' },
    method: { id: 'core.direct-lookup', version: '1' }, role: 'guidance_only', grantsPermissions: false };
}

test('resource progress: legacy and paged catalog cards share a stable preparation key independent of query and cursor metadata', () => {
  const state = localState(); const one = accepted(state, task('one', 'core.catalog.search', { query: 'fixture', limit: 2 }), { cards: [card], hasMore: false });
  const two = accepted(state, task('two', 'core.catalog.search', { query: 'local', limit: 20, cursor: 'later' }), {
    status: 'available', cards: [{ ...card, description: 'Changed display text' }], hasMore: true, nextCursor: 'changed', snapshotRevision: 999, byteLength: 999 });
  assert.equal(one.keys().length, 1); assert.deepEqual(two.keys(), one.keys()); one.capture(); assert.equal(two.capture().productiveSteps, 1);
  assert.equal(state.evidence.length, 0); assert.equal(evaluateCompletion(state.goal, state.evidence, state.obligations, state.policy).complete, false);
});

test('resource progress: exact schema loading earns a distinct credit and also records discovery so reverse-order searches add none', () => {
  const state = localState(); const schema = accepted(state, task('schema', 'core.catalog.get', { id: definition.id, version: '1', maxBytes: 4096 }),
    { status: 'available', card, byteLength: 300, definition });
  assert.equal(schema.keys().length, 2); schema.capture();
  const discovery = accepted(state, task('search', 'core.catalog.search', { query: 'fixture', limit: 2 }), { cards: [card], hasMore: false });
  assert.equal(discovery.capture().productiveSteps, 1); assert.equal(state.progress!.consecutiveUnproductive, 1);
  const state2 = localState(); accepted(state2, task('search', 'core.catalog.search', { query: 'fixture', limit: 2 }), { cards: [card], hasMore: false }).capture();
  assert.equal(accepted(state2, schema.selected, schema.result.output).capture().productiveSteps, 2);
});

test('resource progress: forged, mismatched or denied tool metadata and too-large responses do not earn preparation credit', () => {
  for (const fault of ['digest', 'requested-id', 'permission', 'too-large', 'malformed'] as const) {
    const state = localState(); const item = accepted(state, task('schema', 'core.catalog.get', { id: fault === 'requested-id' ? 'other' : definition.id, version: '1', maxBytes: 4096 }),
      { status: fault === 'too-large' ? 'too_large' : 'available', card: fault === 'malformed' ? { id: definition.id } : { ...card, contractDigest: fault === 'digest' ? 'a'.repeat(64) : card.contractDigest }, definition });
    if (fault === 'permission') state.policy.allowedTools = state.policy.allowedTools.filter(id => id !== definition.id);
    assert.deepEqual(item.keys(), [], fault);
  }
});

test('resource progress: guidance listing metadata does not reset progress and exact body loading subsumes the card', () => {
  const state = localState(); const load = accepted(state, task('load', 'core.guidance.load', { id: manifest.id, version: '1', kind: 'lookup', reason: 'Initial reason', maxBytes: 4096 }),
    loadOutput(state), [guideArtifact]);
  assert.equal(load.keys().length, 2); load.capture();
  const list = accepted(state, task('find', 'core.guidance.find', { kind: 'lookup', limit: 20, maxBytes: 65536 }), {
    status: 'available', cards: [{ ...guideCard, title: 'Changed title', summary: 'Changed summary', byteLength: 999 }], hasMore: true,
    nextCursor: 'new-cursor', snapshotRevision: 99, byteLength: 999, method: { id: 'different-method' } }, [], true);
  assert.equal(list.capture().productiveSteps, 1);
  const again = accepted(state, task('load-again', 'core.guidance.load', { ...load.selected.input, reason: 'A different reason' }),
    { ...loadOutput(state), selectedFor: { ...loadOutput(state).selectedFor, reason: 'A different reason' } }, [guideArtifact]);
  assert.deepEqual(again.keys(), load.keys()); assert.equal(again.capture().productiveSteps, 1);
});

test('resource progress: guidance body credit requires permitted manifest, matching indexed original and canonical selection identity', () => {
  for (const fault of ['tenant', 'labels', 'blocked', 'missing-reference', 'missing-index', 'selection', 'body-size', 'grants-permission'] as const) {
    const state = localState(); const output = structuredClone(loadOutput(state));
    if (fault === 'tenant') output.manifest.tenantId = 'other';
    if (fault === 'labels') output.manifest.labels = ['restricted'];
    if (fault === 'selection') output.selectedFor.workId = 'other';
    if (fault === 'body-size') output.body += 'changed';
    if (fault === 'grants-permission') output.grantsPermissions = true;
    const item = accepted(state, task('load', 'core.guidance.load', { id: manifest.id, version: '1', kind: 'lookup', reason: 'Read', maxBytes: 4096 }), output,
      fault === 'missing-reference' ? [] : [guideArtifact]);
    if (fault === 'missing-index') state.artifacts = [];
    if (fault === 'blocked') state.dataLifecycle = { generation: 1, blockedArtifactIds: [guideArtifact.id], changes: [] };
    assert.deepEqual(item.keys(), [], fault);
  }
});

test('resource progress: empty results, history/evidence reads and arbitrary new artifacts cannot fabricate preparation', () => {
  const state = localState();
  for (const toolId of ['core.catalog.search', 'core.guidance.find']) assert.deepEqual(accepted(state, task(toolId, toolId, {}), { cards: [], hasMore: false }).keys(), []);
  for (const toolId of ['core.calls.find', 'core.calls.get', 'core.evidence.find', 'core.evidence.get', 'fixture.read'])
    assert.deepEqual(accepted(state, task(toolId, toolId, {}), { status: 'available', cards: [card], manifest, body }, [guideArtifact]).keys(), []);
});

test('resource progress: replayed, reused and unadopted resource results cannot earn a new preparation key', () => {
  for (const fault of ['result-reuse', 'attempt-reuse', 'not-adopted', 'foreign-goal', 'wrong-result', 'error'] as const) {
    const state = localState(); const item = accepted(state, task('search', 'core.catalog.search', { query: 'fixture', limit: 2 }), { cards: [card], hasMore: false });
    if (fault === 'result-reuse') item.result.reuse = { attemptId: 'prior', resultId: 'prior-result', resultArtifact: guideArtifact, observedAt: 1000, cacheKey: 'a'.repeat(64) };
    if (fault === 'attempt-reuse') state.attempts[0]!.reuse = { attemptId: 'prior', resultId: 'prior-result', resultArtifact: guideArtifact, observedAt: 1000, cacheKey: 'a'.repeat(64) };
    if (fault === 'not-adopted') state.attempts[0]!.adopted = false;
    if (fault === 'foreign-goal') state.attempts[0]!.goalRevision++;
    if (fault === 'wrong-result') state.attempts[0]!.resultId = 'other';
    if (fault === 'error') item.result.status = 'error';
    assert.deepEqual(item.keys(), [], fault);
  }
});

async function integration(adapter: Adapter, family: string, run: (f: Awaited<ReturnType<typeof open>>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'secumon-resource-progress-')); const repository = openRepository(adapter, directory);
  async function open() {
    const scenario = validateScenario(JSON.parse(readFileSync(new URL(`../../fixtures/${family}.json`, import.meta.url), 'utf8')));
    const original = new FixtureReadTool(scenario.evidence); const planner = new ScriptedPlanner([]); const work = newWork({ id: 'resource-work',
      goal: scenario.goal, policy: { ...scenario.policy, allowedTools: [...scenario.policy.allowedTools, ...RESOURCE_TOOL_IDS] },
      limits: { toolCalls: 20, modelCalls: 5, tokens: 1000000, replans: 10, wallTimeMs: 120000 }, now: 1788566400000 });
    assert.equal((await repository.commit(command(work, 'create'))).kind, 'committed');
    const core = await composeRuntime({ services: { state: repository, artifacts: new FileArtifactStore(join(directory, 'artifacts')), clock: new FakeClock(work.createdAt),
      digester, ids: new RandomIds(), planner, tools: [original], sink: new FakeSink() }, schemas: new AjvSchemas(), owner: 'resource-progress',
      guidanceSource: new FileGuidanceSource(fileURLToPath(new URL('../../guidance/', import.meta.url))) });
    const plan = async (tasks: TaskSpec[]) => {
      const current = await core.runtime.state(work.id); await core.runtime.submitPlan(work.id, `plan:${current.revision}`, {
        baseStateRevision: current.revision, baseGoalRevision: current.goal.revision, basePlanRevision: current.plan?.revision ?? 0,
        reason: 'Bounded synthetic resource preparation', tasks, hypotheses: [] });
    };
    return { core, original, planner, scenario, work, plan };
  }
  try { await run(await open()); } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
}

for (const adapter of adapters) {
  for (const [family, source] of [['documents-simple', 'doc-current'], ['observations-simple', 'collection-complete']] as const)
    test(`resource progress ${adapter}/${family}: default no-progress policy allows discovery, schemas and guidance before the real source`, async () => {
      await integration(adapter, family, async f => {
        const tasks = [task('catalog', 'core.catalog.search', { query: 'fixture.read', limit: 2 }),
          task('schema', 'core.catalog.get', { id: 'fixture.read', version: '1', maxBytes: 4096 }, ['catalog']),
          task('find', 'core.guidance.find', { kind: 'lookup', limit: 20, ...(family === 'observations-simple' ? { maxBytes: 65536 } : {}) }, ['schema']),
          task('guide', 'core.guidance.load', { id: 'core.evidence-review', version: '1', kind: 'lookup', reason: 'Check original evidence', maxBytes: 4096 }, ['find']),
          task('source', 'fixture.read', { evidenceIds: [source] }, ['guide'])];
        await f.plan(tasks);
        for (const selected of tasks.slice(0, 4)) {
          const attempt = await f.core.runtime.reserve(f.work.id, selected.id); await f.core.runtime.execute(f.work.id, attempt.id); await f.core.runtime.settlePending(attempt.id);
          const current = await f.core.runtime.adopt(f.work.id, attempt.id); assert.equal(current.evidence.length, 0); assert.equal(current.progress!.consecutiveUnproductive, 0);
          assert.equal(evaluateCompletion(current.goal, current.evidence, current.obligations, current.policy).complete, false);
        }
        assert.equal((await f.core.runtime.runUntilYield(f.work.id, 10)).kind, 'complete'); const final = await f.core.runtime.state(f.work.id);
        assert.equal(final.progress!.policy.maxUnproductiveSteps, 3); assert.equal(final.progress!.productiveSteps, 5); assert.equal(final.budget.used.toolCalls, 5);
        assert.equal(final.evidence.length, 1); assert.deepEqual(final.goal, f.work.goal); assert.deepEqual(final.policy, f.work.policy);
        assert.equal(f.original.invocations.length, 1); assert.equal(f.planner.inputs.length, 0);
      });
    });

  for (const kind of ['catalog', 'guidance'] as const) test(`resource progress ${adapter}: repeated identical ${kind} preparation stops after the first credit and three empty steps`, async () => {
    await integration(adapter, 'documents-simple', async f => {
      const tasks = Array.from({ length: 5 }, (_, index) => task(`repeat-${index}`, kind === 'catalog' ? 'core.catalog.search' : 'core.guidance.load', kind === 'catalog'
        ? { query: index % 2 ? 'synthetic evidence' : 'fixture.read', limit: 20 }
        : { id: 'core.evidence-review', version: '1', kind: 'lookup', reason: `Changed explanation ${index}`, maxBytes: 4096 }, index ? [`repeat-${index - 1}`] : []));
      await f.plan(tasks); const result = await f.core.runtime.runUntilYield(f.work.id, 30); assert.equal(result.kind, 'blocked'); assert.equal(result.reason, 'no_progress_limit');
      const final = await f.core.runtime.state(f.work.id); assert.equal(final.progress!.productiveSteps, 1); assert.equal(final.progress!.consecutiveUnproductive, 3);
      assert.equal(final.budget.used.toolCalls, 4); assert.equal(final.attempts.filter(value => value.adopted).length, 4); assert.equal(final.evidence.length, 0);
      assert.equal(f.original.invocations.length, 0); assert.equal(f.planner.inputs.length, 0);
    });
  });

  test(`resource progress ${adapter}: empty searches with different query and task IDs stop at the default limit`, async () => {
    await integration(adapter, 'documents-simple', async f => {
      await f.plan(Array.from({ length: 4 }, (_, index) => task(`empty-${index}`, 'core.catalog.search', { query: `absent-synthetic-match-${index}`, limit: 20, maxBytes: 4096 },
        index ? [`empty-${index - 1}`] : [])));
      const result = await f.core.runtime.runUntilYield(f.work.id, 30); assert.equal(result.reason, 'no_progress_limit');
      const final = await f.core.runtime.state(f.work.id); assert.equal(final.progress!.productiveSteps, 0); assert.deepEqual(final.progress!.knownKeys, []);
      assert.equal(final.budget.used.toolCalls, 3); assert.equal(final.attempts.filter(value => value.adopted).length, 3); assert.equal(final.evidence.length, 0);
      assert.equal(f.original.invocations.length, 0); assert.equal(f.planner.inputs.length, 0);
    });
  });
}
