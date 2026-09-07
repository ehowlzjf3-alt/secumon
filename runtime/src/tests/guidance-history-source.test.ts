import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskSpec } from '../domain/model.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { RESOURCE_TOOL_IDS } from '../application/resource-tools.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { RandomIds, Sha256Digester, sha256 } from '../infrastructure/digest.js';
import { FakeClock, FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { FileGuidanceSource } from '../infrastructure/file-guidance.js';
import { adapters, command, initial, openRepository, type Adapter } from './state-conformance-helpers.js';

const marker = 'SYNTHETIC_GUIDANCE_ORIGINAL_FOR_HISTORY';
const body = `# Synthetic guide\n\n${marker}\nPreserve original observations and their timestamps.\n`;
const bodyBytes = new TextEncoder().encode(body).byteLength;
function task(id: string, toolId: string, input: TaskSpec['input']): TaskSpec {
  return { id, description: id, toolId, toolVersion: '1', input, effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: [] };
}
async function setup(t: TestContext, adapter: Adapter) {
  const directory = await mkdtemp(join(tmpdir(), 'guidance-history-source-')); const state = openRepository(adapter, directory);
  t.after(async () => { await state.close(); await rm(directory, { recursive: true, force: true }); });
  const packDirectory = join(directory, 'guidance'); await mkdir(packDirectory);
  const bodyPath = join(packDirectory, 'guide.md'); const catalogPath = join(packDirectory, 'catalog.json');
  const pack = { schemaVersion: 1, entries: [{ id: 'core.history-guide', version: '1', title: 'Synthetic history guide',
    summary: 'A file source whose original custody is checked through historical copies', source: 'fixture://history-guide',
    tenantId: 'tenant-a', labels: ['synthetic'], supportedKinds: ['lookup'], sha256: sha256(body), byteLength: bodyBytes,
    requiredRules: ['Preserve original source custody'], bodyFile: 'guide.md' }] };
  await writeFile(bodyPath, body); await writeFile(catalogPath, JSON.stringify(pack));
  const source = new FileGuidanceSource(packDirectory); const artifacts = new FileArtifactStore(join(directory, 'artifacts'));
  const seed = initial(); seed.policy.allowedTools = [...RESOURCE_TOOL_IDS];
  assert.equal((await state.commit(command(seed, 'accept-guidance-history'))).kind, 'committed');
  const c = await composeRuntime({ services: { state, artifacts, clock: new FakeClock(seed.createdAt), tools: [],
    planner: new ScriptedPlanner([]), ids: new RandomIds(), digester: new Sha256Digester(), sink: new FakeSink() },
    schemas: new AjvSchemas(), guidanceSource: source, owner: 'history-worker', enablePlanning: false });
  const run = async (selected: TaskSpec) => {
    const current = await c.runtime.state(seed.id);
    await c.runtime.submitPlan(seed.id, `plan:${selected.id}`, { baseStateRevision: current.revision, baseGoalRevision: current.goal.revision,
      basePlanRevision: current.plan?.revision ?? 0, reason: 'Read original guidance and exact historical copies', tasks: [selected], hypotheses: [] });
    const reserved = await c.runtime.reserve(seed.id, selected.id);
    await c.runtime.execute(seed.id, reserved.id); await c.runtime.adopt(seed.id, reserved.id);
    const saved = (await c.runtime.state(seed.id)).attempts.find(attempt => attempt.id === reserved.id)!;
    assert.equal(saved.adopted, true); assert.equal(saved.status, 'succeeded'); assert.ok(saved.resultArtifact);
    assert.ok(await state.receipt(seed.id, `dispatch:${saved.id}`)); return saved;
  };
  const original = await run(task('original', 'core.guidance.load', { id: 'core.history-guide', version: '1', kind: 'lookup', reason: 'Read the original guide', maxBytes: 65536 }));
  const copyOne = await run(task('copy-one', 'core.calls.get', { attemptId: original.id, maxBytes: 65536 }));
  const copyTwo = await run(task('copy-two', 'core.calls.get', { attemptId: copyOne.id, maxBytes: 65536 }));
  const before = await c.runtime.state(seed.id);
  for (const attempt of [original, copyTwo]) {
    const result = await c.resources.resultWithDependencies(seed.id, before.policy, attempt.id, 65536);
    assert.equal(result.output.status, 'available'); assert.ok(JSON.stringify(result.output).includes(marker));
  }
  return { ...c, source, state, artifacts, pack, bodyPath, catalogPath, original, copyTwo, before, workId: seed.id };
}

for (const adapter of adapters) {
  test(`${adapter}: valid original guidance remains readable through two historical copies and records actual file probe bytes`, async t => {
    const f = await setup(t, adapter); const revision = f.guidance.revision;
    for (const attempt of [f.original, f.copyTwo]) {
      const before = f.source.metrics(); const applicationBefore = f.guidance.validationMetrics();
      const result = await f.resources.resultWithDependencies(f.workId, f.before.policy, attempt.id, 65536);
      assert.equal(result.output.status, 'available'); assert.ok(JSON.stringify(result.output).includes(marker));
      assert.match(JSON.stringify(result.output), /"newObservation":false/);
      const after = f.source.metrics(); const probes = after.bodyReads - before.bodyReads;
      assert.ok(probes > 0); assert.equal(after.bodyBytes - before.bodyBytes, probes * bodyBytes);
      assert.ok(after.validateCalls > before.validateCalls); assert.ok(after.catalogReads > before.catalogReads);
      assert.ok(after.catalogBytes > before.catalogBytes); assert.equal(after.readCalls, before.readCalls);
      assert.ok(f.guidance.validationMetrics().calls > applicationBefore.calls);
    }
    assert.equal(f.guidance.revision, revision); assert.deepEqual(await f.runtime.state(f.workId), f.before);
    assert.equal(f.before.budget.used.toolCalls, 3);
  });

  for (const change of ['body-edited', 'body-deleted', 'catalog-rules-changed'] as const) {
    test(`${adapter}: ${change} without refresh invalidates original guidance history and two stored copies`, async t => {
      const f = await setup(t, adapter); const revision = f.guidance.revision; const cachedManifest = f.guidance.describe(f.before, 'core.history-guide', '1');
      if (change === 'body-edited') await writeFile(f.bodyPath, `${body}Changed original content.\n`);
      if (change === 'body-deleted') await rm(f.bodyPath);
      if (change === 'catalog-rules-changed') {
        f.pack.entries[0]!.requiredRules = ['A different required rule under the same id and version'];
        await writeFile(f.catalogPath, JSON.stringify(f.pack));
      }
      assert.equal(f.guidance.revision, revision);
      assert.deepEqual(f.guidance.describe(f.before, 'core.history-guide', '1'), cachedManifest);
      for (const attempt of [f.original, f.copyTwo]) {
        const before = f.source.metrics();
        await assert.rejects(f.resources.resultWithDependencies(f.workId, f.before.policy, attempt.id, 65536), /invocation_unavailable/);
        const after = f.source.metrics();
        assert.ok(after.validateCalls > before.validateCalls); assert.ok(after.catalogReads > before.catalogReads);
        if (change === 'body-edited') { assert.ok(after.bodyReads > before.bodyReads); assert.ok(after.bodyBytes > before.bodyBytes); }
        assert.equal(after.readCalls, before.readCalls);
        assert.ok(await f.artifacts.exists(attempt.resultArtifact!));
      }
      assert.equal(f.guidance.revision, revision); assert.deepEqual(await f.runtime.state(f.workId), f.before);
    });
  }
}
