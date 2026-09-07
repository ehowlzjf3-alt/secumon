import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ArtifactRef, Attempt, Evidence, TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import type { ReadCheckpoint } from '../domain/read-checkpoint.js';
import type { ReadItem, ReadKey, ReadPage } from '../domain/read-collection.js';
import type { ReadCollectionSource } from '../application/ports.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { ToolResultSchema } from '../application/contracts.js';
import { transact } from '../application/work-transactions.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { FakeClock, FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { adapters, command, initial, openRepository, type Adapter } from './state-conformance-helpers.js';

const owner = 'checkpoint-test';
const usage = { transportCalls: 1, internalOperations: 2, imageBytes: 0, waitMs: 3 };
const bounds = { maxPages: 5, maxItems: 20, maxCalls: 8, maxPageBytes: 65536, maxCheckpointBytes: 262144, pageSize: 5 };
const key = (id: string): ReadKey => ({ id, inputDigest: id.repeat(64) });

async function setup(t: TestContext, backend: Adapter, completeImmediately = false) {
  const directory = await mkdtemp(join(tmpdir(), 'secumon-read-proof-')); let state = openRepository(backend, directory);
  t.after(async () => { await state.close(); await rm(directory, { recursive: true, force: true }); });
  const artifacts = new FileArtifactStore(join(directory, 'artifacts')); const clock = new FakeClock(1000);
  const work = initial(); work.policy.allowedTools.push('core.calls.get'); work.budget.limits.replans = 10;
  assert.equal((await state.commit(command(work, 'create'))).kind, 'committed');
  const rawSource = await artifacts.put(new TextEncoder().encode('SYNTHETIC_ORIGINAL_SOURCE'), {
    tenantId: work.policy.tenantId, labels: [...work.policy.allowedLabels], mediaType: 'text/plain' });
  const evidence = (id: string): Evidence => ({ id: `evidence-${id}`, tenantId: work.policy.tenantId, scope: work.goal.scope,
    sourceId: `source-${id}`, lineageId: `lineage-${id}`, locator: `fixture://${id}`, observedAt: 900, recordedAt: 1000,
    labels: ['synthetic'], coverage: 'complete', status: 'accepted', supersedes: [], derivedFrom: [], facts: { record: id }, artifact: rawSource });
  const item = (id: string, success = true): ReadItem => ({ ...key(id), status: success ? 'success' : 'error',
    output: success ? { original: `item-${id}` } : null, evidence: success ? [evidence(id)] : [], artifacts: success ? [rawSource] : [],
    coverage: success ? 'complete' : 'unknown', error: success ? null : { code: 'synthetic_retry', retryable: true } });
  let fetches = 0;
  const source: ReadCollectionSource = { manifest: () => [key('a'), key('b')], fetch: async (_task, request): Promise<ReadPage> => {
    fetches++;
    const items = request.retryItems ? [item('b')] : [item('a'), item('b', completeImmediately)];
    return { requestId: request.requestId, sourceSnapshot: 'immutable-fixture', cursor: request.cursor, nextCursor: null, exhausted: true,
      totalItems: 2, expected: items.map(({ id, inputDigest }) => ({ id, inputDigest })), items, usage };
  } };
  const definition = { provider: 'fixture', id: 'fixture.read', version: '1', description: 'Read a synthetic collection', effect: 'read' as const,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, outputSchema: { type: 'object' }, destination: 'local', labels: ['synthetic'],
    collection: { kind: 'batch' as const, limits: bounds } };
  const compose = () => composeRuntime({ services: { state, artifacts, clock, planner: new ScriptedPlanner([]), tools: [],
    ids: new RandomIds(), digester: new Sha256Digester(), sink: new FakeSink() }, schemas: new AjvSchemas(), owner,
    guidanceSource: { list: async () => [], read: async () => { throw new Error('unused_guidance'); } }, enablePlanning: false,
    collectionTools: [{ definition, source }] });
  let composed = await compose();
  const task = (id: string, parent?: Attempt): TaskSpec => ({ id, description: 'Read fixture records', dependsOn: [], toolId: definition.id,
    toolVersion: definition.version, input: {}, effect: 'read', maxAttempts: 1, satisfies: [],
    ...(parent ? { readResume: { attemptId: parent.id, checkpointId: parent.readProgress!.head.id } } : {}) });
  const run = async (selected: TaskSpec) => {
    const before = await composed.runtime.state(work.id);
    await composed.runtime.submitPlan(work.id, `plan:${selected.id}`, { baseStateRevision: before.revision, baseGoalRevision: before.goal.revision,
      basePlanRevision: before.plan?.revision ?? 0, reason: 'Verify checkpoint custody', tasks: [selected], hypotheses: [] });
    const reserved = await composed.runtime.reserve(work.id, selected.id);
    await composed.runtime.execute(work.id, reserved.id); await composed.runtime.settlePending(reserved.id); await composed.runtime.adopt(work.id, reserved.id);
    const current = await composed.runtime.state(work.id); const attempt = current.attempts.find(value => value.id === reserved.id)!;
    assert.ok(attempt.resultArtifact);
    const result = ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(await artifacts.get(attempt.resultArtifact, current.policy))));
    return { attempt, result, state: current };
  };
  const complete = async () => { const parent = await run(task('parent')); assert.equal(parent.result.status, 'partial');
    const child = await run(task('child', parent.attempt)); assert.equal(child.result.status, 'success'); return { parent, child }; };
  const current = () => composed.runtime.state(work.id);
  const checkpoint = async (attempt: Attempt) => composed.readCheckpoints.read(await current(), attempt.id);
  const edit = (id: string, change: (value: WorkState) => void) => transact(composed.services, work.id, id, 'fixture_change', { id }, change);
  const publishChanged = async (attempt: Attempt, change: (value: ReadCheckpoint) => void) => {
    const value = await checkpoint(attempt); change(value);
    const head = await artifacts.put(new TextEncoder().encode(JSON.stringify(value)), { tenantId: work.policy.tenantId,
      labels: [...work.policy.allowedLabels], mediaType: 'application/json' });
    await edit(`forged:${head.id}`, next => { next.artifacts.push(head); next.attempts.find(item => item.id === attempt.id)!.readProgress!.head = head; });
    return head;
  };
  return { get composed() { return composed; }, directory, artifacts, clock, work, rawSource, task, run, complete, current, checkpoint, edit, publishChanged,
    fetches: () => fetches, remove: (ref: ArtifactRef) => unlink(join(directory, 'artifacts', `${ref.id}.blob`)),
    reopen: async () => { await state.close(); state = openRepository(backend, directory); composed = await compose(); } };
}

for (const backend of adapters) {
  test(`read checkpoint ${backend}: a complete checkpoint survives outer-result loss and resumes without another fetch`, async t => {
    const f = await setup(t, backend, true); const put = f.artifacts.put.bind(f.artifacts); let rejectResult = true;
    f.artifacts.put = async (bytes, attributes) => {
      const value = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      if (rejectResult && typeof value['resultId'] === 'string' && value['resultId'].endsWith(':collection')) throw new Error('synthetic_result_write_lost');
      return put(bytes, attributes);
    };
    await assert.rejects(f.run(f.task('orphan-complete')), /result_persistence_failed/);
    const interrupted = await f.current(); const parent = interrupted.attempts.at(-1)!;
    assert.equal(parent.status, 'running'); assert.equal(parent.resultArtifact, null); assert.equal(parent.adopted, false);
    assert.equal(parent.readProgress!.phase, 'complete'); assert.equal(f.fetches(), 1);
    const original = await f.checkpoint(parent); assert.equal(original.collection.exhausted, true);
    rejectResult = false; await f.reopen(); f.clock.advance(30001);
    await f.composed.runtime.recover(f.work.id, parent.id);
    const resumed = await f.run(f.task('resume-complete-orphan', parent));
    assert.equal(resumed.result.status, 'success'); assert.equal(resumed.attempt.adopted, true); assert.equal(f.fetches(), 1);
    assert.deepEqual(resumed.result.usage, { transportCalls: 0, internalOperations: 0, imageBytes: 0, waitMs: 0 });
    const next = await f.checkpoint(resumed.attempt);
    assert.deepEqual(next.collection, original.collection); assert.deepEqual(next.calls, original.calls);
    assert.equal(next.calls.some(call => call.attemptId === resumed.attempt.id), false);
    assert.equal(resumed.attempt.readProgress!.callCount, 1); assert.equal(resumed.result.evidence[0]!.observedAt, 900);
    assert.equal(await f.composed.readCheckpoints.validateResult(await f.current(), resumed.result), true);
  });

  test(`read checkpoint ${backend}: projection preserves original evidence and charges only the successor's raw response`, async t => {
    const f = await setup(t, backend); const { parent, child } = await f.complete();
    assert.equal(f.fetches(), 2); assert.deepEqual(parent.result.usage, usage); assert.deepEqual(child.result.usage, usage);
    assert.deepEqual(child.result.evidence[0], parent.result.evidence[0]); assert.equal(child.result.evidence[0]!.observedAt, 900);
    const cp = await f.checkpoint(child.attempt); assert.deepEqual(await f.composed.readCheckpoints.project(cp, child.attempt.readProgress!.head), child.result);
    await f.reopen();
    assert.equal(await f.composed.readCheckpoints.validateResult(await f.current(), child.result), true);
    const history = await f.composed.resources.result(f.work.id, f.work.policy, parent.attempt.id, 65536);
    assert.equal(history.status, 'available'); assert.equal(f.fetches(), 2);
    if (history.status === 'available') assert.match(JSON.stringify(history.value), /historical_tool_result/);
  });

  test(`read checkpoint ${backend}: missing proof and altered payload are denied while ordinary failures remain valid`, async t => {
    const f = await setup(t, backend); const { child } = await f.complete(); const current = await f.current();
    const missing = structuredClone(child.result); delete missing.collection;
    assert.equal(await f.composed.readCheckpoints.validateResult(current, missing), false);
    const forged = structuredClone(child.result); forged.output = { operationId: child.result.collection!.operationId, items: [{ injected: true }] };
    assert.equal(await f.composed.readCheckpoints.validateResult(current, forged), false);
    const usageForgery = structuredClone(child.result); usageForgery.usage!.transportCalls = 0;
    assert.equal(await f.composed.readCheckpoints.validateResult(current, usageForgery), false);
    const failure: ToolResult = { resultId: 'ordinary-failure', attemptId: child.attempt.id, status: 'error', effectState: 'none', evidence: [],
      artifacts: [], output: null, error: { code: 'tool_execution_failed', retryable: false }, coverage: 'unknown', cursor: null };
    assert.equal(await f.composed.readCheckpoints.validateResult(current, failure), true);
  });

  test(`read checkpoint ${backend}: an indexed forged merged page cannot replace its accepted raw response`, async t => {
    const f = await setup(t, backend); const { child } = await f.complete();
    await f.publishChanged(child.attempt, cp => { cp.collection.pages[0]!.items[0]!.output = { injected: 'not_in_original_response' }; });
    await assert.rejects(f.composed.readCheckpoints.read(await f.current(), child.attempt.id), /read_checkpoint_unavailable/);
    await assert.rejects(f.composed.resources.result(f.work.id, f.work.policy, child.attempt.id, 65536), /invocation_unavailable/);
    assert.equal(f.fetches(), 2);
  });

  test(`read checkpoint ${backend}: an unchanged original body cannot authorize a changed request identity`, async t => {
    const f = await setup(t, backend); const { child } = await f.complete();
    await f.publishChanged(child.attempt, cp => { cp.calls[0]!.request.itemLimit++; });
    await assert.rejects(f.composed.readCheckpoints.read(await f.current(), child.attempt.id), /read_checkpoint_unavailable/);
    assert.equal(await f.composed.readCheckpoints.validateResult(await f.current(), child.result), false);
  });

  for (const removed of ['raw-response', 'source-artifact'] as const) test(`read checkpoint ${backend}: losing ${removed} blocks result history and copied history`, async t => {
    const f = await setup(t, backend); const { child } = await f.complete();
    const copied = await f.run({ id: 'copy', description: 'Read prior collection result', dependsOn: [], toolId: 'core.calls.get', toolVersion: '1',
      input: { attemptId: child.attempt.id, maxBytes: 65536 }, effect: 'read', maxAttempts: 1, satisfies: [] });
    assert.equal(copied.result.status, 'success');
    const cp = await f.checkpoint(child.attempt);
    await f.remove(removed === 'raw-response' ? cp.calls.find(call => call.status === 'accepted')!.response! : f.rawSource);
    assert.equal(await f.composed.readCheckpoints.validateResult(await f.current(), child.result), false);
    await assert.rejects(f.composed.resources.result(f.work.id, f.work.policy, copied.attempt.id, 65536), /invocation_unavailable/);
    assert.equal(f.fetches(), 2);
  });

  test(`read checkpoint ${backend}: severing the parent's exclusive successor claim rejects the child`, async t => {
    const f = await setup(t, backend); const { parent, child } = await f.complete();
    await f.edit('remove-claim', state => { state.attempts.find(value => value.id === parent.attempt.id)!.readProgress!.successorAttemptId = null; });
    await assert.rejects(f.composed.readCheckpoints.read(await f.current(), child.attempt.id), /read_checkpoint_unavailable/);
    assert.equal(await f.composed.readCheckpoints.validateResult(await f.current(), child.result), false);
    assert.equal(f.fetches(), 2);
  });
}
