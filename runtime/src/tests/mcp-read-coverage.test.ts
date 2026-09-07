import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Attempt, TaskSpec, WorkState } from '../domain/model.js';
import { evaluateResultReadiness } from '../domain/completion.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { transact } from '../application/work-transactions.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { FakeClock, FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { McpStdioClient } from '../infrastructure/mcp-stdio-client.js';
import { createMcpReadCollection } from '../infrastructure/mcp-read-collections.js';
import { adapters, command, initial, openRepository, type Adapter } from './state-conformance-helpers.js';
import { collectionBinding, type CollectionFamily } from './helpers/mcp-collection-binding.js';

async function fixture(t: TestContext, backend: Adapter, family: CollectionFamily, mode: 'normal' | 'partial' = 'normal', coverage = true) {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-coverage-')); let state = openRepository(backend, directory);
  const artifacts = new FileArtifactStore(join(directory, 'artifacts')); const clock = new FakeClock(1000);
  const sink = new FakeSink(); const planner = new ScriptedPlanner([]); const digester = new Sha256Digester();
  const client = new McpStdioClient({ endpointId: 'coverage-fixture', command: process.execPath,
    args: [fileURLToPath(new URL('./helpers/mcp-collection-fixture-server.js', import.meta.url)), '--mode', mode,
      '--audit-file', join(directory, 'audit.jsonl')], cwd: directory, env: { TMPDIR: tmpdir() }, timeoutMs: 5000 });
  let pid: number | null = null;
  t.after(async () => { await client.close(); await state.close();
    if (pid !== null) assert.throws(() => process.kill(pid!, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
    await rm(directory, { recursive: true, force: true }); });
  const host = collectionBinding(family); if (coverage) host.definition.collection!.coverage = 'manifest-v1';
  const session = await client.discover([host.remote], new AbortController().signal); pid = client.snapshot().pid;
  const services = { state, artifacts, clock, sink, planner, digester, ids: new RandomIds(), tools: [] };
  const source = createMcpReadCollection(host, session, client, services, new AjvSchemas());
  const compose = () => composeRuntime({ services, schemas: new AjvSchemas(), owner: 'coverage-owner', collectionTools: [source],
    guidanceSource: { list: async () => [], read: async () => { throw new Error('unused'); } } });
  let core = await compose(); const work = initial(); const actor = { tenantId: work.policy.tenantId, principalId: work.policy.principalId };
  const access = { channel: 'test' as const, conversationId: 'coverage-chat', destination: 'local', recipientId: actor.principalId, allowDiagnostics: false };
  work.policy.allowedTools = [source.definition.id];
  const input = { ids: ['a', 'b', 'c', 'd'] };
  work.goal.criteria[0] = { id: 'criterion', description: 'Verify the fact after collecting every requested record', key: 'value', operator: 'equals',
    equals: family === 'documents' ? 30 : 1, minIndependentSources: 1, requireCompleteCoverage: true,
    requireCollection: { queryDigest: digester.digest({ toolId: source.definition.id, toolVersion: source.definition.version, input }) } };
  work.conversation = { primaryBindingId: 'main', bindings: [{ id: 'main', ...actor, ...access }], completionRequiresDelivery: false, result: null };
  delete (work.conversation.bindings[0] as unknown as Record<string, unknown>)['allowDiagnostics'];
  assert.equal((await state.commit(command(work, 'accept'))).kind, 'committed');
  const current = () => state.get(work.id).then(value => value!);
  const run = async (id: string, parent?: Attempt) => {
    const before = await current(); const task: TaskSpec = { id, description: 'Collect the exact approved manifest',
      toolId: source.definition.id, toolVersion: source.definition.version, input, effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: [],
      ...(parent ? { readResume: { attemptId: parent.id, checkpointId: parent.readProgress!.head.id } } : {}) };
    await core.runtime.submitPlan(work.id, `plan:${id}`, { baseStateRevision: before.revision, baseGoalRevision: before.goal.revision,
      basePlanRevision: before.plan?.revision ?? 0, reason: 'Read the required query', tasks: [task], hypotheses: [] });
    const attempt = await core.runtime.reserve(work.id, id); await core.runtime.execute(work.id, attempt.id); await core.runtime.settlePending(attempt.id);
    const result = await core.runtime.adopt(work.id, attempt.id); return result.attempts.find(value => value.id === attempt.id)!;
  };
  const readiness = (value: WorkState) => evaluateResultReadiness(value.goal, value.evidence, value.obligations, value.policy, value.attempts);
  return { directory, current, run, readiness, actor, access, source, client, sink, planner, work, services,
    get core() { return core; }, reopen: async () => { await state.close(); state = openRepository(backend, directory); services.state = state; core = await compose(); } };
}

for (const backend of adapters) for (const family of ['documents', 'observations'] as const) {
  test(`${backend}: full ${family} coverage gates partial facts and survives exact-manifest resume and restoration`, { timeout: 30000 }, async t => {
    const f = await fixture(t, backend, family, 'partial'); const parent = await f.run('partial'); const partial = await f.current();
    assert.equal(parent.status, 'partial'); assert.equal(parent.adopted, true); assert.ok(partial.evidence.length > 0);
    assert.equal(f.readiness(partial).complete, false); assert.equal(parent.readProgress!.coverage!.complete, false);
    assert.equal((await f.core.conversation.snapshot(f.work.id, f.actor)).analysisReady, false);
    assert.equal(await f.core.conversation.prepare(f.work.id, f.actor), null);
    const original = structuredClone(partial.evidence); const calls = f.client.snapshot().toolCalls;
    await f.core.recovery.restore(f.work.id, f.actor); assert.equal(f.client.snapshot().toolCalls, calls);
    await f.reopen(); const child = await f.run('remaining', parent); const complete = await f.current();
    assert.equal(child.status, 'succeeded'); assert.equal(f.readiness(complete).complete, true);
    assert.equal(child.readProgress!.coverage!.completedItems, 4); assert.equal(child.readProgress!.coverage!.expectedItems, 4);
    for (const evidence of original) assert.deepEqual(complete.evidence.find(value => value.id === evidence.id), evidence);
    assert.equal(new Set(complete.evidence.map(value => value.lineageId)).size, 1);
    assert.equal(complete.evidence.length, 4); assert.equal(f.planner.inputs.length, 0);
    const restored = await f.core.recovery.restore(f.work.id, f.actor); assert.ok(restored.artifact);
    assert.equal((await f.core.conversation.snapshot(f.work.id, f.actor)).analysisReady, true);
    const view = await f.core.workView.read(f.work.id, f.actor, f.access, { level: 'conversation' });
    assert.equal(view.kind, 'snapshot'); if (view.kind === 'snapshot') assert.equal(view.view.progress.analysisReady, true);
  });
}

test('MCP coverage: successful EOF without an approved manifest cannot discharge the full-query condition', async t => {
  const f = await fixture(t, 'sqlite', 'observations', 'normal', false); const attempt = await f.run('normal');
  assert.equal(attempt.status, 'succeeded'); assert.equal(attempt.readProgress!.coverage, undefined);
  assert.equal(f.readiness(await f.current()).complete, false); assert.equal(await f.core.conversation.prepare(f.work.id, f.actor), null);
});

for (const damage of ['missing-raw', 'wrong-summary'] as const) test(`MCP coverage: ${damage} invalidates completion, public result and delivery`, async t => {
  const f = await fixture(t, 'sqlite', 'documents'); const attempt = await f.run('normal');
  assert.ok(await f.core.conversation.prepare(f.work.id, f.actor)); const before = await f.current(); const calls = f.client.snapshot().toolCalls;
  if (damage === 'missing-raw') {
    const checkpoint = await f.core.readCheckpoints.read(before, attempt.id, attempt.readProgress!.head);
    await rm(join(f.directory, 'artifacts', `${checkpoint.collection.pages[0]!.rawArtifact!.id}.blob`));
  } else await transact(f.core.services, f.work.id, 'wrong-summary', 'summary_changed', {}, next => {
    const progress = next.attempts.find(value => value.id === attempt.id)!.readProgress!;
    progress.completedItems = 3; progress.coverage!.completedItems = 3; progress.coverage!.expectedItems = 3;
  });
  assert.equal((await f.core.conversation.snapshot(f.work.id, f.actor)).analysisReady, false);
  const view = await f.core.workView.read(f.work.id, f.actor, f.access, { level: 'conversation' });
  assert.equal(view.kind, 'snapshot'); if (view.kind === 'snapshot') assert.equal(view.view.progress.analysisReady, false);
  await assert.rejects(f.core.runtime.step(f.work.id)); await assert.rejects(f.core.conversation.prepare(f.work.id, f.actor));
  await f.core.outbox.flush(f.work.id, f.actor); assert.equal(f.sink.delivered.size, 0);
  assert.equal(f.client.snapshot().toolCalls, calls); assert.equal(f.planner.inputs.length, 0);
});
