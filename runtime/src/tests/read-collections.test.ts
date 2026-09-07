import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Attempt, Evidence, TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import type { ReadCheckpoint } from '../domain/read-checkpoint.js';
import type { ReadItem, ReadKey, ReadLimits, ReadPage, ReadRequest } from '../domain/read-collection.js';
import type { ReadCollectionBinding, ReadCollectionSource } from '../application/ports.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { ToolResultSchema } from '../application/contracts.js';
import { ReadCheckpointReader } from '../application/read-checkpoint-store.js';
import { validateScenario } from '../application/fixtures.js';
import { newWork } from '../application/new-work.js';
import { transact } from '../application/work-transactions.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { RandomIds, Sha256Digester, sha256 } from '../infrastructure/digest.js';
import { FakeClock, FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { adapters, openRepository, type Adapter } from './state-conformance-helpers.js';

const families = ['documents-simple', 'observations-simple'] as const;
type Family = typeof families[number];
const workId = 'durable-read-work';
const toolId = 'fixture.collection';
const limits: ReadLimits = { maxPages: 5, maxItems: 20, maxCalls: 6, maxPageBytes: 65536, maxCheckpointBytes: 262144, pageSize: 5 };
const usage = { transportCalls: 1, internalOperations: 2, imageBytes: 0, waitMs: 3 };
type FetchContext = Parameters<ReadCollectionSource['fetch']>[2];
type FetchHandler = (task: TaskSpec, request: ReadRequest, context: FetchContext) => Promise<ReadPage>;

function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function page(request: ReadRequest, items: ReadItem[], nextCursor: string | null, totalItems: number): ReadPage {
  return { requestId: request.requestId, sourceSnapshot: request.snapshot ?? 'synthetic-snapshot-1', cursor: request.cursor,
    nextCursor, exhausted: nextCursor === null, totalItems, expected: items.map(({ id, inputDigest }) => ({ id, inputDigest })), items, usage: { ...usage } };
}
class Source implements ReadCollectionSource {
  readonly requests: { request: ReadRequest; attemptId: string }[] = [];
  expected: ReadKey[] = [];
  handler: FetchHandler = async () => { throw new Error('unexpected_synthetic_fetch'); };
  manifest() { return structuredClone(this.expected); }
  async fetch(task: TaskSpec, request: ReadRequest, context: FetchContext) {
    this.requests.push({ request: structuredClone(request), attemptId: context.attemptId });
    return this.handler(task, request, context);
  }
}
async function setup(t: TestContext, adapter: Adapter, family: Family, options: { kind?: 'batch' | 'paged'; limits?: Partial<ReadLimits> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'secumon-read-collections-')); let state = openRepository(adapter, directory);
  t.after(async () => { await state.close(); await rm(directory, { recursive: true, force: true }); });
  const scenario = validateScenario(JSON.parse(readFileSync(new URL(`../../fixtures/${family}.json`, import.meta.url), 'utf8')));
  const clock = new FakeClock(1788566400000); const source = new Source(); const artifacts = new FileArtifactStore(join(directory, 'artifacts'));
  const bounds = { ...limits, ...options.limits };
  const definition: ReadCollectionBinding['definition'] = { provider: 'fixture', id: toolId, version: '1', description: 'Collect synthetic source observations',
    effect: 'read', destination: 'local', labels: ['synthetic'], inputSchema: { type: 'object', properties: { dataset: { type: 'string' }, query: { type: 'string' } },
      required: ['dataset', 'query'], additionalProperties: false }, outputSchema: { type: 'object' }, collection: { kind: options.kind ?? 'paged', limits: bounds } };
  const initial = newWork({ id: workId, now: clock.now(), goal: scenario.goal, policy: { ...scenario.policy, allowedTools: [toolId] },
    limits: { toolCalls: 20, modelCalls: 2, tokens: 10000, replans: 20, wallTimeMs: 1000000 } });
  await state.commit({ workId, expectedRevision: 0, commandId: 'accept', commandDigest: 'synthetic-collection-work', next: initial,
    events: [{ type: 'accepted', at: clock.now(), data: {} }], deliveries: [] });
  const compose = () => composeRuntime({ services: { state, artifacts, clock, tools: [], planner: new ScriptedPlanner([]), ids: new RandomIds(), digester: new Sha256Digester(), sink: new FakeSink() },
    schemas: new AjvSchemas(), guidanceSource: { list: async () => [], read: async () => { throw new Error('unused_guidance'); } },
    owner: 'collection-test', enablePlanning: false, collectionTools: [{ definition, source }] });
  let composed = await compose();
  const key = (id: string): ReadKey => ({ id, inputDigest: sha256(`${family}:${id}`) });
  const evidence = (id: string): Evidence => ({ id: `${family}:${id}`, tenantId: scenario.policy.tenantId, scope: scenario.goal.scope,
    sourceId: `source:${id}`, lineageId: `lineage:${id}`, locator: `fixture://${family}/${id}`, observedAt: initial.createdAt - 100, recordedAt: initial.createdAt,
    labels: ['synthetic'], coverage: 'complete', status: 'accepted', access: 'available', supersedes: [], derivedFrom: [],
    facts: family === 'documents-simple' ? { 'collection.record': id, title: `합성 문서 ${id}` } : { 'collection.record': id, sensor: `합성 관측 ${id}` }, artifact: null });
  const item = (id: string, status: ReadItem['status'] = 'success'): ReadItem => ({ ...key(id), status,
    output: status === 'success' ? { family, value: id } : null, evidence: status === 'success' ? [evidence(id)] : [], artifacts: [],
    coverage: status === 'success' ? 'complete' : status === 'partial' ? 'partial' : 'unknown',
    error: status === 'error' ? { code: 'synthetic_item_failed', retryable: true } : null });
  const task = (id: string, parent?: Attempt): TaskSpec => ({ id, description: 'Read the selected synthetic collection', toolId, toolVersion: '1',
    input: { dataset: family, query: 'synthetic records only' }, effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: [],
    ...(parent ? { readResume: { attemptId: parent.id, checkpointId: parent.readProgress!.head.id } } : {}) });
  const submit = async (selected: TaskSpec) => {
    const current = await composed.runtime.state(workId);
    return composed.runtime.submitPlan(workId, `plan:${selected.id}:${current.revision}`, { baseStateRevision: current.revision, baseGoalRevision: current.goal.revision,
      basePlanRevision: current.plan?.revision ?? 0, reason: 'Verify durable explicit collection progress', tasks: [selected], hypotheses: [] });
  };
  const result = async (attempt: Attempt): Promise<ToolResult> => {
    const current = await composed.runtime.state(workId); assert.ok(attempt.resultArtifact);
    return ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(await artifacts.get(attempt.resultArtifact, current.policy))));
  };
  const run = async (selected: TaskSpec) => {
    await submit(selected); const reserved = await composed.runtime.reserve(workId, selected.id);
    await composed.runtime.execute(workId, reserved.id); await composed.runtime.settlePending(reserved.id); await composed.runtime.adopt(workId, reserved.id);
    const current = await composed.runtime.state(workId); const attempt = current.attempts.find(a => a.id === reserved.id)!;
    return { state: current, attempt, result: await result(attempt) };
  };
  const checkpoint = async (attempt: Attempt): Promise<ReadCheckpoint> => {
    assert.ok(attempt.readProgress); const current = await composed.runtime.state(workId);
    return new ReadCheckpointReader(current, artifacts, new Sha256Digester()).load(attempt.readProgress.head);
  };
  return { get runtime() { return composed.runtime; }, get services() { return composed.services; }, get repository() { return state; },
    directory, source, artifacts, clock, definition, bounds, key, evidence, item, task, submit, run, result, checkpoint,
    reopen: async () => { await state.close(); state = openRepository(adapter, directory); composed = await compose(); } };
}
type Harness = Awaited<ReturnType<typeof setup>>;
function items(result: ToolResult): ReadItem[] {
  assert.ok(result.output && typeof result.output === 'object' && !Array.isArray(result.output));
  assert.ok(Array.isArray(result.output['items'])); return result.output['items'] as unknown as ReadItem[];
}
async function edit(f: Harness, id: string, change: (state: WorkState) => void) { await transact(f.services, workId, id, 'synthetic_collection_change', { id }, change); }
async function denied(f: Harness, selected: TaskSpec) {
  const calls = f.source.requests.length; let failure: unknown;
  try { const completed = await f.run(selected); assert.equal(completed.attempt.adopted, false); assert.equal(completed.result.status, 'error'); }
  catch (error) { failure = error; }
  if (failure) assert.match(failure instanceof Error ? failure.message : String(failure), /read_|checkpoint|resume|invalid_tool|invalid_contract|permission|task_id_contract_changed/);
  assert.equal(f.source.requests.length, calls, 'an invalid resume must not call the source');
}

for (const adapter of adapters) {
  test(`durable collections ${adapter}: a process crash after intent becomes an unknown call on explicit resume`, { timeout: 15000 }, async t => {
    const f = await setup(t, adapter, 'observations-simple'); const selected = f.task('crashed-parent');
    await f.submit(selected); const reserved = await f.runtime.reserve(workId, selected.id);
    const url = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
    const worker = `
      import { composeRuntime } from ${url('../application/compose-runtime.js')};
      import { openRepository } from ${url('./state-conformance-helpers.js')};
      import { FileArtifactStore } from ${url('../infrastructure/file-artifacts.js')};
      import { AjvSchemas } from ${url('../infrastructure/ajv-schemas.js')};
      import { RandomIds, Sha256Digester } from ${url('../infrastructure/digest.js')};
      import { FakeClock, FakeSink, ScriptedPlanner } from ${url('../infrastructure/fakes.js')};
      const state = openRepository(${JSON.stringify(adapter)}, ${JSON.stringify(f.directory)});
      const source = { async fetch(_task, request) {
        process.send({ kind: 'durable-intent', request });
        await new Promise(() => {});
        throw new Error('unreachable');
      } };
      const composed = await composeRuntime({ services: { state, artifacts: new FileArtifactStore(${JSON.stringify(join(f.directory, 'artifacts'))}),
        clock: new FakeClock(${f.clock.now()}), tools: [], planner: new ScriptedPlanner([]), ids: new RandomIds(), digester: new Sha256Digester(), sink: new FakeSink() },
        schemas: new AjvSchemas(), guidanceSource: { list: async () => [], read: async () => { throw new Error('unused'); } },
        owner: 'collection-test', enablePlanning: false, collectionTools: [{ definition: ${JSON.stringify(f.definition)}, source }] });
      await composed.runtime.execute(${JSON.stringify(workId)}, ${JSON.stringify(reserved.id)});
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let diagnostics = ''; child.stderr!.on('data', chunk => { diagnostics += String(chunk); });
    try {
      const message = await Promise.race([
        once(child, 'message', { signal: AbortSignal.timeout(8000) }).then(([value]) => value as { kind: string; request: ReadRequest }),
        once(child, 'exit').then(([code]) => { throw new Error(`intent_worker_exited:${String(code)}:${diagnostics}`); }),
      ]);
      assert.equal(message.kind, 'durable-intent'); const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
      await f.reopen(); const crashed = (await f.runtime.state(workId)).attempts.find(a => a.id === reserved.id)!;
      assert.equal(crashed.status, 'running'); assert.equal(crashed.readProgress!.callCount, 1);
      assert.equal((await f.checkpoint(crashed)).calls[0]!.status, 'intent'); f.clock.advance(30001);
      await f.runtime.recover(workId, crashed.id); const recovered = (await f.runtime.state(workId)).attempts.find(a => a.id === crashed.id)!;
      assert.equal(recovered.status, 'failed'); assert.equal(recovered.error!.code, 'lease_expired');
      f.source.handler = async (_task, request) => {
        assert.notEqual(request.requestId, message.request.requestId); return page(request, [f.item('a')], null, 1);
      };
      const resumed = await f.run(f.task('after-crash', recovered)); assert.equal(resumed.result.status, 'success'); assert.equal(f.source.requests.length, 1);
      assert.equal(resumed.attempt.readProgress!.callCount, 2); assert.equal(resumed.attempt.readProgress!.unknownCalls, 1);
      assert.equal(resumed.attempt.readProgress!.remainingCalls, f.bounds.maxCalls - 2); assert.deepEqual(resumed.result.usage, usage);
      const checkpoint = await f.checkpoint(resumed.attempt); assert.deepEqual(checkpoint.calls.map(call => call.status), ['unknown', 'accepted']);
      assert.equal(checkpoint.calls[0]!.request.requestId, message.request.requestId); assert.equal(checkpoint.calls[0]!.response, null);
      assert.equal(checkpoint.calls[1]!.attemptId, resumed.attempt.id); assert.equal(checkpoint.collection.calls, 1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    }
  });

  test(`durable collections ${adapter}: a batch retries only unfinished manifest items after reopening`, async t => {
    const f = await setup(t, adapter, 'documents-simple', { kind: 'batch' }); f.source.expected = [f.key('a'), f.key('b')];
    f.source.handler = async (_task, request) => {
      if (request.retryItems) { assert.deepEqual(request.retryItems, [f.key('b')]); return page(request, [f.item('b')], null, 2); }
      return page(request, [f.item('a'), f.item('b', 'error')], null, 2);
    };
    const parent = await f.run(f.task('batch')); assert.equal(parent.result.status, 'partial'); assert.equal(f.source.requests.length, 1);
    await assert.rejects(f.runtime.reserve(workId, 'batch'), /task_not_ready/); assert.equal(f.source.requests.length, 1);
    await f.reopen(); const resumed = await f.run(f.task('batch-explicit-retry', parent.attempt));
    assert.equal(resumed.result.status, 'success'); assert.equal(f.source.requests.length, 2); assert.deepEqual(resumed.result.usage, usage);
    assert.deepEqual(items(resumed.result)[0], items(parent.result)[0]); assert.equal(resumed.attempt.readProgress!.completedPages, 1);
    assert.equal(resumed.attempt.readProgress!.completedItems, 2); assert.deepEqual((await f.checkpoint(resumed.attempt)).collection.batchExpected, f.source.expected);
  });

  test(`durable collections ${adapter}: source failures consume the persisted call budget across explicit retries`, async t => {
    const f = await setup(t, adapter, 'observations-simple', { limits: { maxCalls: 2 } });
    f.source.handler = async () => { throw new Error('PRIVATE_SOURCE_ERROR_MUST_NOT_ESCAPE'); };
    const first = await f.run(f.task('failed-source')); assert.equal(first.result.status, 'partial'); assert.equal(first.attempt.readProgress!.callCount, 1);
    assert.equal(first.attempt.readProgress!.remainingCalls, 1); assert.equal(f.source.requests.length, 1);
    const firstCheckpoint = await f.checkpoint(first.attempt); assert.equal(firstCheckpoint.calls[0]!.status, 'rejected');
    assert.equal(firstCheckpoint.calls[0]!.errorCode, 'read_source_failed'); assert.doesNotMatch(JSON.stringify(firstCheckpoint), /PRIVATE_SOURCE_ERROR/);
    await f.reopen(); const second = await f.run(f.task('retry-source', first.attempt));
    assert.equal(second.result.status, 'partial'); assert.equal(second.attempt.readProgress!.callCount, 2); assert.equal(second.attempt.readProgress!.remainingCalls, 0);
    const last = await f.checkpoint(second.attempt); assert.equal(last.calls.length, 2); assert.equal(last.collection.calls, 0);
    assert.ok(last.calls.every(call => call.status === 'rejected' && call.errorCode === 'read_source_failed'));
    assert.equal(new Set(last.calls.map(call => call.request.requestId)).size, 2); assert.deepEqual(second.state.evidence, []);
    await f.reopen(); const exhausted = await f.run(f.task('budget-exhausted-retry', second.attempt));
    assert.equal(exhausted.result.status, 'partial'); assert.equal(exhausted.attempt.readProgress!.callCount, 2); assert.equal(f.source.requests.length, 2);
    assert.equal((await f.checkpoint(exhausted.attempt)).stopReason, 'read_call_limit');
  });

  test(`durable collections ${adapter}: a source that answers after cancellation cannot commit its late page`, { timeout: 5000 }, async t => {
    const f = await setup(t, adapter, 'documents-simple'); const entered = gate<FetchContext>(); const release = gate<void>();
    f.source.handler = async (_task, request, context) => { entered.resolve(context); await release.promise; return page(request, [f.item('late')], null, 1); };
    const selected = f.task('cancel-in-flight'); await f.submit(selected); const reserved = await f.runtime.reserve(workId, selected.id);
    const execution = f.runtime.execute(workId, reserved.id);
    try {
      const context = await entered.promise; const pending = (await f.runtime.state(workId)).attempts.find(a => a.id === reserved.id)!;
      assert.equal((await f.checkpoint(pending)).calls.at(-1)!.status, 'intent'); f.runtime.interrupt(workId); assert.equal(context.signal.aborted, true);
      await execution; release.resolve(); await f.runtime.settlePending(reserved.id); await f.runtime.adopt(workId, reserved.id);
      const after = await f.runtime.state(workId); const attempt = after.attempts.find(a => a.id === reserved.id)!;
      assert.deepEqual(after.evidence, []); assert.equal(attempt.readProgress!.completedItems, 0);
      const checkpoint = await f.checkpoint(attempt); assert.ok(checkpoint.calls.every(call => call.status !== 'accepted'));
      if (attempt.resultArtifact) assert.deepEqual((await f.result(attempt)).evidence, []);
    } finally { release.resolve(); f.runtime.interrupt(workId); await execution; await f.runtime.settlePending(reserved.id); }
  });

  test(`durable collections ${adapter}: policy revocation while the source waits suppresses the response`, async t => {
    const f = await setup(t, adapter, 'observations-simple');
    f.source.handler = async (_task, request) => {
      await edit(f, 'revoke-during-fetch', state => { state.policy.allowedLabels = ['public']; });
      return page(request, [f.item('revoked')], null, 1);
    };
    const completed = await f.run(f.task('permission-race')); assert.equal(f.source.requests.length, 1); assert.deepEqual(completed.state.evidence, []);
    assert.equal(completed.attempt.readProgress!.completedItems, 0); assert.deepEqual(completed.result.evidence, []);
    assert.doesNotMatch(JSON.stringify(completed.result.output), /source:revoked|합성 관측 revoked/);
    assert.notEqual(completed.result.status, 'success');
  });
}

for (const change of ['query', 'fresh', 'same-task-id', 'policy', 'goal', 'generation'] as const) {
  test(`durable collections: ${change} cannot resume a checkpoint under a changed contract`, async t => {
    const f = await setup(t, 'sqlite', 'documents-simple');
    f.source.handler = async (_task, request) => page(request, [f.item('a', 'partial')], null, 1);
    const parent = await f.run(f.task('original')); const selected = f.task('changed-resume', parent.attempt);
    if (change === 'query') selected.input['query'] = 'different source selection';
    if (change === 'fresh') selected.freshness = 'fresh';
    if (change === 'same-task-id') selected.id = 'original';
    if (change === 'policy') await edit(f, 'different-owner', state => { state.policy.principalId = 'different-owner'; });
    if (change === 'goal') await edit(f, 'different-goal', state => { state.goal.revision++; state.goal.description = 'A new goal revision'; });
    if (change === 'generation') await edit(f, 'new-data-generation', state => { state.dataLifecycle = { generation: 1, blockedArtifactIds: [], changes: [] }; });
    if (change === 'same-task-id') await assert.rejects(f.submit(selected), { message: 'task_id_contract_changed' });
    else await denied(f, selected);
    assert.equal(f.source.requests.length, 1);
  });
}

for (const adapter of adapters) for (const family of families) {
  test(`durable collections ${adapter} ${family}: complete pages advance automatically and survive reopening`, async t => {
    const f = await setup(t, adapter, family); const observedIntents: string[] = [];
    f.source.handler = async (_task, request, context) => {
      const current = await f.runtime.state(workId); const attempt = current.attempts.find(a => a.id === context.attemptId)!;
      const saved = await f.checkpoint(attempt); const intent = saved.calls.at(-1)!;
      assert.equal(intent.status, 'intent'); assert.equal(intent.request.requestId, request.requestId); assert.equal(intent.attemptId, context.attemptId);
      assert.ok(await f.repository.receipt(workId, `dispatch:${context.attemptId}`)); observedIntents.push(request.requestId);
      return request.cursor === null ? page(request, [f.item('a')], 'page-2', 2) : page(request, [f.item('b')], null, 2);
    };
    const completed = await f.run(f.task('initial')); assert.equal(completed.result.status, 'success'); assert.equal(completed.result.coverage, 'complete');
    assert.equal(completed.result.cursor, null); assert.equal(completed.attempt.adopted, true); assert.equal(completed.attempt.status, 'succeeded');
    assert.equal(f.source.requests.length, 2); assert.equal(new Set(observedIntents).size, 2);
    assert.deepEqual(f.source.requests.map(call => call.request.cursor), [null, 'page-2']);
    assert.deepEqual(f.source.requests.map(call => call.request.snapshot), [null, 'synthetic-snapshot-1']);
    assert.deepEqual(items(completed.result).map(item => item.id), ['a', 'b']);
    assert.deepEqual(completed.result.evidence, [f.evidence('a'), f.evidence('b')]);
    assert.deepEqual(completed.result.usage, { transportCalls: 2, internalOperations: 4, imageBytes: 0, waitMs: 6 });
    const progress = completed.attempt.readProgress!; assert.equal(progress.phase, 'complete'); assert.equal(progress.callCount, 2);
    assert.equal(progress.completedPages, 2); assert.equal(progress.completedItems, 2); assert.equal(progress.pendingItems, 0); assert.equal(progress.unknownCalls, 0);
    assert.equal(progress.remainingCalls, f.bounds.maxCalls - 2); assert.equal(progress.successorAttemptId, null);
    const checkpoint = await f.checkpoint(completed.attempt); assert.equal(checkpoint.collection.exhausted, true); assert.equal(checkpoint.calls.length, 2);
    for (const call of checkpoint.calls) { assert.equal(call.status, 'accepted'); assert.ok(call.response); assert.ok(await f.artifacts.exists(call.response)); }
    await f.reopen(); const restored = (await f.runtime.state(workId)).attempts.find(a => a.id === completed.attempt.id)!;
    assert.deepEqual(restored.readProgress, progress); assert.deepEqual(await f.result(restored), completed.result);
    assert.deepEqual(await f.checkpoint(restored), checkpoint); await denied(f, f.task('complete-resume', restored));
  });

  test(`durable collections ${adapter} ${family}: partial stops until a new task explicitly resumes after reopening`, async t => {
    const f = await setup(t, adapter, family);
    f.source.handler = async (_task, request) => {
      if (request.retryItems) { assert.deepEqual(request.retryItems, [f.key('b')]); assert.equal(request.cursor, null); return page(request, [f.item('b')], 'page-2', 3); }
      return request.cursor === null ? page(request, [f.item('a'), f.item('b', 'partial')], 'page-2', 3) : page(request, [f.item('c')], null, 3);
    };
    const parent = await f.run(f.task('initial')); assert.equal(parent.result.status, 'partial'); assert.equal(parent.result.coverage, 'partial');
    assert.equal(parent.attempt.status, 'partial'); assert.equal(parent.attempt.adopted, true); assert.equal(f.source.requests.length, 1);
    assert.deepEqual(parent.result.error, { code: 'read_collection_partial', retryable: false }); assert.equal(parent.result.cursor, parent.attempt.readProgress!.head.id);
    assert.equal(parent.attempt.readProgress!.pendingItems, 1); assert.equal(parent.attempt.readProgress!.callCount, 1);
    const original = structuredClone(items(parent.result).find(item => item.id === 'a')!); const parentCheckpoint = await f.checkpoint(parent.attempt);
    await f.reopen(); assert.equal(f.source.requests.length, 1, 'reopening alone does not retry the source');
    const restored = (await f.runtime.state(workId)).attempts.find(a => a.id === parent.attempt.id)!;
    assert.deepEqual(await f.checkpoint(restored), parentCheckpoint); f.clock.advance(50);
    const resumed = await f.run(f.task('explicit-successor', restored)); assert.equal(resumed.result.status, 'success'); assert.equal(resumed.attempt.adopted, true);
    assert.equal(f.source.requests.length, 3); assert.notEqual(f.source.requests[0]!.request.requestId, f.source.requests[1]!.request.requestId);
    assert.deepEqual(f.source.requests.map(call => call.attemptId), [parent.attempt.id, resumed.attempt.id, resumed.attempt.id]);
    assert.deepEqual(items(resumed.result).map(item => item.id), ['a', 'b', 'c']); assert.deepEqual(items(resumed.result)[0], original);
    assert.deepEqual(resumed.state.evidence, [f.evidence('a'), f.evidence('b'), f.evidence('c')]);
    assert.deepEqual(parent.result.usage, usage); assert.deepEqual(resumed.result.usage, { transportCalls: 2, internalOperations: 4, imageBytes: 0, waitMs: 6 });
    assert.deepEqual(resumed.attempt.execution!.usage, resumed.result.usage);
    assert.equal(resumed.attempt.readProgress!.callCount, 3); assert.equal(resumed.attempt.readProgress!.completedPages, 2);
    assert.equal(resumed.attempt.readProgress!.completedItems, 3); assert.equal(resumed.attempt.readProgress!.pendingItems, 0);
    assert.equal(resumed.attempt.readProgress!.operationId, parent.attempt.readProgress!.operationId);
    const previous = resumed.state.attempts.find(a => a.id === parent.attempt.id)!; assert.equal(previous.readProgress!.successorAttemptId, resumed.attempt.id);
    const checkpoint = await f.checkpoint(resumed.attempt); assert.equal(checkpoint.parent!.attemptId, parent.attempt.id);
    assert.deepEqual(checkpoint.parent!.checkpoint, parent.attempt.readProgress!.head); assert.equal(checkpoint.calls.length, 3);
    await f.reopen(); assert.deepEqual(await f.checkpoint(resumed.attempt), checkpoint); await denied(f, f.task('old-parent-branch', previous));
  });
}
