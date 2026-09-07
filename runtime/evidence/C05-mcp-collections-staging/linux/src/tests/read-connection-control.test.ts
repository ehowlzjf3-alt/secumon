import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Control } from '../domain/control.js';
import type { TaskSpec, WorkState } from '../domain/model.js';
import type { ReadItem, ReadLimits, ReadResponse } from '../domain/read-collection.js';
import type { ReadCollectionBinding, Tool } from '../application/ports.js';
import type { RuntimeServices } from '../application/services.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { ToolBroker } from '../application/tool-broker.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { createReadCollectionTool } from '../application/read-collections.js';
import { inspectReadConnectionControl } from '../application/read-connection-control.js';
import { decideExecution } from '../application/execution-decision.js';
import { createExecutionAuthority } from '../application/execution-authority.js';
import { transact } from '../application/work-transactions.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { FakeClock, FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { RandomIds, Sha256Digester, sha256 } from '../infrastructure/digest.js';
import { adapters, command, initial, openRepository, type Adapter } from './state-conformance-helpers.js';

const base: Control = { kind: 'replan', reason: 'plan_cannot_complete_goal' };
type Mode = 'partial' | 'permanent' | 'deferred' | 'nonfinal' | 'complete' | 'intent' | 'rejected';
async function fixture(t: TestContext, mode: Mode = 'partial', bounds: Partial<ReadLimits> = {}, backend: Adapter = 'sqlite') {
  const directory = await mkdtemp(join(tmpdir(), 'read-connection-control-')), repository = openRepository(backend, directory);
  t.after(async () => { try { await repository.close(); } finally { await rm(directory, { recursive: true, force: true }); } });
  const clock = new FakeClock(1000), schemas = new AjvSchemas(), work = initial('connection-control');
  work.policy.allowedTools = ['fixture.collection', 'fixture.independent'];
  const stop = new Error('fixture_stopped_after_committed_checkpoint'); let interrupted = false, calls = 0;
  const state = new Proxy(repository, { get(target, property) {
    if (property === 'commit') return async (...args: Parameters<typeof repository.commit>) => {
      const result = await target.commit(...args), next = args[0].next;
      const progress = next.attempts[0]?.readProgress;
      if (!interrupted && result.kind === 'committed' && args[0].commandId.startsWith('read:') && progress &&
        (mode === 'intent' && progress.unknownCalls === 1 || mode === 'nonfinal' && progress.completedPages === 1 && progress.unknownCalls === 0)) {
        interrupted = true; throw stop;
      }
      return result;
    };
    const value: unknown = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const services: RuntimeServices = { state, artifacts: new FileArtifactStore(join(directory, 'artifacts')), clock,
    ids: new RandomIds(), digester: new Sha256Digester(), tools: [], planner: new ScriptedPlanner([]), sink: new FakeSink() };
  const key = (id: string) => ({ id, inputDigest: sha256(id) });
  const item = (id: string, failed = false): ReadItem => ({ ...key(id), status: failed ? 'error' : 'success', output: failed ? null : { id },
    evidence: [], artifacts: [], coverage: failed ? 'unknown' : 'complete', error: failed ? { code: 'fixture_failed', retryable: mode !== 'permanent' } : null });
  const definition: ReadCollectionBinding['definition'] = { provider: 'fixture', id: 'fixture.collection', version: '1', description: 'Explicit local collection fixture',
    effect: 'read', destination: 'local', labels: ['synthetic'], inputSchema: { type: 'object', properties: { query: { const: 'fixed' } }, required: ['query'], additionalProperties: false },
    outputSchema: { type: 'object' }, collection: { kind: mode === 'nonfinal' ? 'paged' : 'batch', limits: {
      maxPages: 4, maxItems: 4, maxCalls: 4, maxPageBytes: 65536, maxCheckpointBytes: 524288, pageSize: 2, ...bounds } } };
  // Only this source is synthetic. Checkpoint/response bytes, dispatch receipts and revalidation use the real core and repositories.
  const binding: ReadCollectionBinding = { definition, source: { manifest: () => [key('a'), key('b')],
    async fetch(_task, request): Promise<ReadResponse> {
      calls++;
      if (mode === 'rejected') throw new Error('fixture_remote_failed');
      if (mode === 'deferred') return { kind: 'read_deferral', requestId: request.requestId, reason: 'rate_limited', dueAt: 5000 };
      return { requestId: request.requestId, sourceSnapshot: 'fixed-source', cursor: request.cursor,
        nextCursor: mode === 'nonfinal' ? 'next-page' : null, exhausted: mode !== 'nonfinal', totalItems: mode === 'nonfinal' ? 4 : 2,
        expected: [key('a'), key('b')], items: [item('a'), item('b', mode === 'partial' || mode === 'permanent')] };
    } } };
  const core = await composeRuntime({ services, schemas, owner: 'connection-worker', enablePlanning: false, collectionTools: [binding],
    guidanceSource: { list: async () => [], read: async () => { throw new Error('unused_guidance'); } } });
  await state.commit(command(work, 'accept'));
  const task: TaskSpec = { id: 'collect', description: 'Read fixed records', toolId: definition.id, toolVersion: definition.version,
    input: { query: 'fixed' }, effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: [] };
  await core.runtime.submitPlan(work.id, 'plan', { baseStateRevision: work.revision, baseGoalRevision: work.goal.revision,
    basePlanRevision: 0, reason: 'Check the connection fallback without a model', tasks: [task], hypotheses: [] });
  const attempt = await core.runtime.reserve(work.id, task.id); await core.runtime.dispatch(work.id, attempt.id);
  const invoked = new ToolBroker(state, core.contracts, services.digester, clock).invoke(work.id, attempt.id, core.runtime.owner, new AbortController().signal);
  if (mode === 'nonfinal' || mode === 'intent') {
    await assert.rejects(invoked, error => error === stop);
    clock.advance(attempt.leaseUntil - clock.now() + 1); await core.runtime.recover(work.id, attempt.id);
  } else {
    const result = await invoked;
    await core.runtime.receive(work.id, attempt.id, result, 'invoked'); await core.runtime.adopt(work.id, attempt.id);
  }
  const tool = createReadCollectionTool(binding, () => core.readCollections);
  const stored: Tool = { ...tool, availability: 'stored_only' }, contracts = new ToolContracts([stored], schemas);
  const current = () => core.runtime.state(work.id);
  const inspect = async (control: Control = base, supplied?: WorkState) => inspectReadConnectionControl(services, contracts, supplied ?? await current(), control);
  return { directory, repository, services, schemas, clock, core, contracts, binding, stored, task, attempt, current, inspect, calls: () => calls };
}

for (const backend of adapters) for (const mode of ['partial', 'nonfinal'] as const)
  test(`${backend}: ${mode === 'partial' ? 'adopted partial' : 'settled running checkpoint'} requires a connection without changing originals or accounting`, async t => {
    const f = await fixture(t, mode, {}, backend), before = await f.current();
    assert.equal(before.attempts[0]!.adopted, mode === 'partial');
    assert.equal(before.attempts[0]!.readProgress!.phase, mode === 'partial' ? 'partial' : 'running');
    const events = await f.repository.events(before.id, 0), count = f.calls(); let allocations = 0, reads = 0;
    t.mock.method(f.services.ids, 'next', () => { allocations++; assert.fail('inspection allocated a durable ID'); });
    const get = f.services.artifacts.get.bind(f.services.artifacts);
    t.mock.method(f.services.artifacts, 'get', async (...args: Parameters<typeof get>) => { reads++; return get(...args); });
    assert.deepEqual(await f.inspect(), { kind: 'wait', reason: 'connection_required', wakeAt: null });
    assert.ok(reads > 0, 'the new executor inspection reads real checkpoint/response bytes; it is not a free summary lookup');
    assert.equal(allocations, 0); assert.equal(f.calls(), count); assert.deepEqual(await f.current(), before);
    assert.deepEqual(await f.repository.events(before.id, 0), events); assert.equal(before.modelCalls.length, 0);
  });

for (const backend of adapters) test(`${backend}: ordinary executor resume preserves a previously published connection wait`, async t => {
  const f = await fixture(t, 'partial', {}, backend), before = await f.current(), count = f.calls();
  f.core.contracts.replaceProvider('fixture', [f.stored],
    { expectedEpoch: f.core.contracts.providerEpoch('fixture'), sourceRevision: 'stored-only' });
  t.mock.method(f.services.planner, 'propose', async () => assert.fail('a connection wait must not request a new model plan'));
  const expected = { kind: 'wait', reason: 'connection_required', wakeAt: null };
  assert.deepEqual(await f.core.runtime.runUntilYield(before.id), expected);
  const waiting = await f.current(), events = await f.repository.events(before.id, 0);
  assert.equal(waiting.status, 'waiting'); assert.equal(waiting.statusReason, 'connection_required');
  // Use the real executor's control publication and repeat its ordinary entry without forcing the status back to ready.
  for (let resume = 0; resume < 2; resume++) {
    assert.deepEqual(await f.core.runtime.runUntilYield(before.id), expected);
    assert.deepEqual(await f.current(), waiting);
    assert.deepEqual(await f.repository.events(before.id, 0), events);
  }
  assert.equal(f.calls(), count); assert.equal(waiting.modelCalls.length, 0);
  assert.deepEqual(waiting.attempts, before.attempts); assert.deepEqual(waiting.budget, before.budget);
});

test('a verified deferral retains its original deadline then needs a connection when due', async t => {
  const f = await fixture(t, 'deferred');
  assert.deepEqual(await f.inspect(), { kind: 'wait', reason: 'read_retry_wait', wakeAt: 5000 });
  f.clock.advance(4000);
  assert.deepEqual(await f.inspect(), { kind: 'wait', reason: 'connection_required', wakeAt: null });
  assert.equal(f.calls(), 1);
});

for (const [mode, bounds] of [
  ['permanent', {}], ['partial', { maxCalls: 1 }], ['nonfinal', { maxPages: 1 }], ['nonfinal', { maxItems: 2 }],
  ['complete', {}], ['intent', {}], ['rejected', {}],
] as const) test(`${mode}/${JSON.stringify(bounds)} keeps the original replan when no proven next request exists`, async t => {
  const f = await fixture(t, mode, bounds); assert.equal(await f.inspect(), base);
});

test('independent control and review decisions never trigger an extra checkpoint read', async t => {
  const f = await fixture(t), supplied = await f.current();
  const independent: Tool = { definition: { provider: 'fixture', id: 'fixture.independent', version: '1', description: 'Independent local read',
    effect: 'read', destination: 'local', labels: ['synthetic'], inputSchema: { type: 'object' }, outputSchema: { type: 'object' } },
    execute: async () => assert.fail('control inspection must not invoke the independent task') };
  f.contracts.replaceProvider('fixture', [f.stored, independent], { expectedEpoch: f.contracts.providerEpoch('fixture'), sourceRevision: 'with-independent' });
  supplied.plan!.tasks.push({ id: 'independent', description: 'Read independently', toolId: independent.definition.id, toolVersion: '1',
    effect: 'read', input: {}, dependsOn: [], maxAttempts: 1, satisfies: [] });
  const selected = decideExecution(supplied, f.clock.now(), f.services.digester, task => f.contracts.checkExecution(task, supplied.policy));
  assert.deepEqual(selected, { kind: 'continue', action: 'reserve', id: 'independent', reason: 'task_ready' });
  t.mock.method(f.services.artifacts, 'get', async () => assert.fail('base control has priority'));
  assert.equal(await f.inspect(selected, supplied), selected);
  for (const control of [
    { kind: 'continue', action: 'reserve', id: 'independent', reason: 'task_ready' },
    { kind: 'replan', reason: 'hypothesis_review_required' }, { kind: 'replan', reason: 'session_input_requires_review' },
    { kind: 'replan', reason: 'external_notification_requires_review' }, { kind: 'blocked', reason: 'deadline_exceeded' },
  ] satisfies Control[]) assert.equal(await f.inspect(control), control);
});

test('a changed current task or successor tip cannot create a connection wait', async t => {
  const f = await fixture(t), original = await f.current();
  const changedTask = structuredClone(original); changedTask.plan!.tasks[0]!.input = { query: 'other' };
  assert.equal(await f.inspect(base, changedTask), base);
  const successor = structuredClone(original); successor.attempts[0]!.readProgress!.successorAttemptId = 'another-attempt';
  assert.equal(await f.inspect(base, successor), base);
  const inaccessible = structuredClone(original); inaccessible.policy.allowedLabels = [];
  assert.equal(await f.inspect(base, inaccessible), base);
});

test('corrupt original checkpoint bytes remain an error rather than an ordinary connection wait', async t => {
  const f = await fixture(t), state = await f.current();
  await writeFile(join(f.directory, 'artifacts', `${state.attempts[0]!.readProgress!.head.id}.blob`), '{}');
  await assert.rejects(f.inspect(), /artifact_integrity_failure/);
});

for (const change of ['state', 'registration'] as const) test(`${change} changes during original read cannot leave a stale connection wait`, async t => {
  const f = await fixture(t), get = f.services.artifacts.get.bind(f.services.artifacts); let changed = false;
  t.mock.method(f.services.artifacts, 'get', async (...args: Parameters<typeof get>) => {
    const value = await get(...args);
    if (!changed) {
      changed = true;
      if (change === 'state') await transact(f.services, (await f.current()).id, 'fixture-policy-change',
        'fixture_policy_changed', {}, state => { state.policy.allowedLabels = []; });
      else f.contracts.replaceProvider('fixture', [{ ...f.stored, availability: 'available' }],
        { expectedEpoch: f.contracts.providerEpoch('fixture'), sourceRevision: 'reconnected' });
    }
    return value;
  });
  await assert.rejects(f.inspect(), /read_checkpoint_unavailable/); assert.equal(changed, true);
});

for (const timing of ['before_read', 'during_read'] as const) test(`host authority revoked ${timing} cannot become a connection wait`, async t => {
  const f = await fixture(t), before = await f.current(), events = await f.repository.events(before.id, 0), count = f.calls();
  const controller = new AbortController();
  f.services.executionAuthority = createExecutionAuthority({ actor: before.policy, scope: before.goal.scope, signal: controller.signal });
  const get = f.services.artifacts.get.bind(f.services.artifacts); let reads = 0;
  t.mock.method(f.services.artifacts, 'get', async (...args: Parameters<typeof get>) => {
    reads++;
    if (timing === 'before_read') assert.fail('revoked authority must be checked before reading original bytes');
    const value = await get(...args);
    controller.abort();
    return value;
  });
  if (timing === 'before_read') controller.abort();
  await assert.rejects(f.inspect(), /execution_authority_denied/);
  assert.equal(reads > 0, timing === 'during_read'); assert.equal(f.calls(), count);
  assert.deepEqual(await f.current(), before); assert.deepEqual(await f.repository.events(before.id, 0), events);
  assert.equal(before.modelCalls.length, 0);
});
