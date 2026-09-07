import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Attempt, ContextPacket, TaskSpec } from '../domain/model.js';
import type { ReadCheckpoint, ReadProgress } from '../domain/read-checkpoint.js';
import type { ReadLimits, ReadPage } from '../domain/read-collection.js';
import { readCollectionContext } from '../domain/context.js';
import type { ArtifactStore, Tool } from '../application/ports.js';
import type { RuntimeServices } from '../application/services.js';
import { ContextCompiler } from '../application/context-compiler.js';
import { ContextRecovery } from '../application/context-recovery.js';
import { buildContextPacket } from '../application/context-packet.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { ReadCheckpointSchema } from '../application/read-checkpoint-contracts.js';
import { ReadCheckpoints } from '../application/read-checkpoints.js';
import { acceptPage, initialize, nextRequest } from '../application/read-collection-validation.js';
import { asJson } from '../application/plan-validator.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { transact } from '../application/work-transactions.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { FakeClock, FakeSink, ScriptedPlanner, SequenceIds } from '../infrastructure/fakes.js';
import { adapters, attempt, artifact, command, initial, openRepository, type Adapter } from './state-conformance-helpers.js';

const limits: ReadLimits = { maxPages: 4, maxItems: 10, maxCalls: 8, maxPageBytes: 65536, maxCheckpointBytes: 262144, pageSize: 2 };
const bodyMarker = 'ORIGINAL_PAGE_BODY_MUST_STAY_IN_CHECKPOINT';
const cursorMarker = 'OPAQUE_PROVIDER_CURSOR_MUST_STAY_IN_CHECKPOINT';
const options = { callId: 'context-call', maxOutputTokens: 100, maxInputBytes: 100000, maxInputTokens: 1000000, forceCompact: true };
const actor = { tenantId: 'tenant-a', principalId: 'person-a' };
const progress = (extras: Partial<ReadProgress> = {}): ReadProgress => ({ operationId: 'operation', head: artifact(), callCount: 1,
  remainingCalls: 7, completedPages: 0, completedItems: 1, pendingItems: 1, unknownCalls: 0, phase: 'partial', successorAttemptId: null, ...extras });

test('read collection context: only visible current goal and scope tips survive; complete unadopted tips remain resumable', () => {
  const state = initial();
  const withProgress = (id: string, extras: Partial<Attempt> = {}): Attempt => ({ ...attempt('partial'), id, taskId: `task-${id}`, readProgress: progress(), ...extras });
  state.attempts = [withProgress('partial'), withProgress('orphan-complete', { status: 'failed', readProgress: progress({ phase: 'complete', pendingItems: 0 }) }),
    withProgress('adopted-complete', { adopted: true, status: 'succeeded', readProgress: progress({ phase: 'complete', pendingItems: 0 }) }),
    withProgress('parent', { readProgress: progress({ successorAttemptId: 'child' }) }), withProgress('old-goal', { goalRevision: 2 }),
    withProgress('other-scope', { scope: 'other' }), withProgress('blocked', { readProgress: progress({ head: { ...artifact(), id: 'blocked' } }) }),
    withProgress('other-tenant', { readProgress: progress({ head: { ...artifact(), tenantId: 'other-tenant' } }) }),
    withProgress('revoked-label', { readProgress: progress({ head: { ...artifact(), labels: ['revoked'] } }) })];
  state.dataLifecycle = { generation: 1, blockedArtifactIds: ['blocked'], changes: [] };
  const before = structuredClone(state); const projected = readCollectionContext(state);
  assert.deepEqual(projected.map(value => value.attemptId), ['partial', 'orphan-complete']);
  assert.deepEqual(state, before); projected[0]!.progress.head.labels.push('mutated');
  assert.deepEqual(state, before, 'a model view cannot mutate a canonical resume head');
});

test('read collection context: the common packet removes denied head metadata from both execution and resume projections', () => {
  const state = initial(); const head = { ...artifact(), id: 'forbidden-checkpoint-marker', labels: ['revoked'] };
  state.attempts = [{ ...attempt('running'), readProgress: progress({ head }) }];
  const packet = buildContextPacket(state, new ToolContracts([], new AjvSchemas()));
  assert.deepEqual(packet.readCollections, []); assert.equal(packet.execution!.attempts[0]!.readProgress, undefined);
  assert.equal(JSON.stringify(packet).includes(head.id), false);
});

async function setup(backend: Adapter, complete = false) {
  const directory = await mkdtemp(join(tmpdir(), 'secumon-read-context-')); const state = openRepository(backend, directory);
  try {
    const artifacts = new FileArtifactStore(join(directory, 'artifacts')); const clock = new FakeClock(1000); const planner = new ScriptedPlanner([]);
    let entries = 0;
    const tool: Tool = { definition: { provider: 'fixture', id: 'fixture.read', version: '1', description: 'Read a bounded synthetic collection', effect: 'read',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, outputSchema: { type: 'object' }, destination: 'local', labels: ['synthetic'],
      collection: { kind: 'paged', limits } }, execute: async () => { entries++; throw new Error('fixture_must_not_invoke'); } };
    const services: RuntimeServices = { state, artifacts, clock, planner, tools: [tool], ids: new SequenceIds(), digester: new Sha256Digester(), sink: new FakeSink() };
    const contracts = new ToolContracts(services.tools, new AjvSchemas()); const runtime = new ExecutionRuntime(services, contracts, 'context-fixture');
    assert.equal((await state.commit(command(initial(), 'create'))).kind, 'committed');
    const task: TaskSpec = { id: 'read-task', description: 'Retrieve the synthetic collection', dependsOn: [], toolId: 'fixture.read', toolVersion: '1',
      input: {}, effect: 'read', maxAttempts: 3, satisfies: [] };
    const before = await runtime.state('work-1');
    await runtime.submitPlan(before.id, 'plan', { baseStateRevision: before.revision, baseGoalRevision: 1, basePlanRevision: 0, reason: 'Read local fixture', tasks: [task], hypotheses: [] });
    const reserved = await runtime.reserve(before.id, task.id); assert.equal(await runtime.dispatch(before.id, reserved.id), true);
    const dispatched = await runtime.state(before.id); const started = initialize('paged'); const request = nextRequest(started, 'page-request-1', limits); assert.ok(request);
    const keys = [{ id: 'a', inputDigest: 'a'.repeat(64) }, { id: 'b', inputDigest: 'b'.repeat(64) }];
    const page: ReadPage = { requestId: request.requestId, sourceSnapshot: 'source-snapshot-1', cursor: request.cursor,
      nextCursor: complete ? null : cursorMarker, exhausted: complete, totalItems: complete ? 2 : 3, expected: keys,
      items: keys.map((key, index) => ({ ...key, status: !complete && index === 1 ? 'partial' : 'success',
        output: { value: `${bodyMarker}:${key.id}` }, evidence: [], artifacts: [], coverage: !complete && index === 1 ? 'partial' : 'complete', error: null })),
      usage: { transportCalls: 1, internalOperations: 2, imageBytes: 0, waitMs: 0 } };
    const put = (value: unknown) => artifacts.put(new TextEncoder().encode(JSON.stringify(value)), { tenantId: dispatched.policy.tenantId,
      labels: dispatched.policy.allowedLabels, mediaType: 'application/json' });
    const raw = await put(page); clock.advance(1);
    const checkpoint: ReadCheckpoint = ReadCheckpointSchema.parse({ schemaVersion: 1, kind: 'read_checkpoint', operationId: 'operation-1', workId: dispatched.id,
      rootAttemptId: reserved.id, attemptId: reserved.id, goal: dispatched.goal, policy: dispatched.policy, lifecycleGeneration: 0,
      toolId: task.toolId, toolVersion: task.toolVersion, queryDigest: services.digester.digest(asJson({ toolId: task.toolId, toolVersion: task.toolVersion, input: task.input })),
      contractDigest: reserved.contractDigest, limits, collection: acceptPage(started, request, page, limits),
      calls: [{ request, attemptId: reserved.id, status: 'accepted', response: raw, dispatchedAt: reserved.startedAt, receivedAt: clock.now(), errorCode: null }],
      parent: null, artifacts: [raw], knowledgeDependencies: [], phase: complete ? 'complete' : 'partial', stopReason: complete ? null : 'read_page_partial',
      createdAt: reserved.startedAt, updatedAt: clock.now() });
    const head = await put(checkpoint);
    // Seed a committed post-page crash boundary through the real repository and dispatch receipt; the runner is tested separately.
    await transact(services, dispatched.id, 'checkpoint', 'read_checkpoint_published', { head: head.id }, next => {
      next.artifacts.push(raw, head); const current = next.attempts.find(value => value.id === reserved.id)!;
      current.status = complete ? 'failed' : 'partial'; current.finishedAt = clock.now(); current.error = { code: 'fixture_after_checkpoint', retryable: true };
      current.readProgress = progress({ operationId: checkpoint.operationId, head, completedPages: complete ? 1 : 0,
        completedItems: complete ? 2 : 1, pendingItems: complete ? 0 : 1, phase: checkpoint.phase });
      next.status = 'ready'; next.statusReason = 'fixture_checkpoint_available';
    });
    const compiler = new ContextCompiler(services, contracts); const recovery = new ContextRecovery(services, contracts);
    assert.deepEqual(await new ReadCheckpoints(services, contracts).read(await runtime.state(dispatched.id), reserved.id), checkpoint);
    let stateClosed = false;
    return { backend, directory, state, artifacts, services, contracts, compiler, recovery, runtime, planner, clock, tool, head, raw, checkpoint,
      attemptId: reserved.id, entries: () => entries, closeState: async () => { if (!stateClosed) { stateClosed = true; await state.close(); } } };
  } catch (error) { await state.close(); await rm(directory, { recursive: true, force: true }); throw error; }
}
type Harness = Awaited<ReturnType<typeof setup>>;
async function fixture(backend: Adapter, run: (f: Harness) => Promise<void>, complete = false) {
  const f = await setup(backend, complete); try { await run(f); } finally { await f.closeState(); await rm(f.directory, { recursive: true, force: true }); }
}
function assertMetadata(packet: ContextPacket, expected: ReturnType<typeof readCollectionContext>, expectedMode: 'stored_complete' | null) {
  const rows = packet.readCollections; assert.ok(rows);
  assert.deepEqual(rows.map(({ resumeMode: _mode, ...canonical }) => canonical), expected);
  for (const [index, row] of rows.entries()) {
    const original = expected[index]!;
    assert.deepEqual(row.progress, original.progress, 'the complete progress object and exact head remain canonical');
    assert.equal(Object.hasOwn(row, 'resumeMode'), expectedMode !== null);
    if (expectedMode === null) assert.equal(row.resumeMode, undefined);
    else {
      assert.equal(original.attemptStatus, 'failed'); assert.equal(original.progress.phase, 'complete');
      assert.equal(original.progress.successorAttemptId, null);
      assert.equal(row.resumeMode, expectedMode, "only this fixture's complete unadopted orphan advertises local consumption");
      assert.ok(packet.plan?.tasks.some(task => task.id === original.taskId), 'the original query task remains in the supplied frontier');
    }
  }
  const json = JSON.stringify(packet);
  assert.equal(json.includes(bodyMarker), false); assert.equal(json.includes(cursorMarker), false);
  assert.equal(json.includes('source-snapshot-1'), false);
}
async function publish(f: Harness, prepared: Awaited<ReturnType<ContextCompiler['prepare']>>) {
  return transact(f.services, 'work-1', `compact:${prepared.head.cycle}`, 'context_compacted', { head: prepared.head.artifact.id }, next => {
    assert.equal(next.revision, prepared.head.basisRevision); next.contextHead = prepared.head;
  });
}
async function adoptComplete(f: Harness) {
  assert.equal(f.checkpoint.phase, 'complete');
  await transact(f.services, 'work-1', 'deliver-orphan', 'fixture_changed', {}, state => {
    const attempt = state.attempts.find(value => value.id === f.attemptId)!;
    attempt.status = 'running'; attempt.finishedAt = null; attempt.error = null; state.status = 'running';
  });
  const result = await new ReadCheckpoints(f.services, f.contracts).project(f.checkpoint, f.head);
  await f.runtime.receive('work-1', f.attemptId, result); const state = await f.runtime.adopt('work-1', f.attemptId);
  assert.equal(state.attempts.find(value => value.id === f.attemptId)!.adopted, true);
  assert.deepEqual(readCollectionContext(state), []); return state;
}

for (const backend of adapters) for (const complete of [false, true]) test(`read collection context ${backend}: five compactions and reopen retain ${complete ? 'complete orphan' : 'partial'} resume metadata without page bodies`, async () => {
  await fixture(backend, async f => {
    const original = await f.runtime.state('work-1'); const expected = readCollectionContext(original); assert.equal(expected.length, 1);
    const parent = original.attempts.find(value => value.id === f.attemptId)!;
    const expectedMode = complete ? 'stored_complete' : null;
    assert.equal(parent.status, complete ? 'failed' : 'partial'); assert.equal(parent.adopted, false);
    assert.deepEqual(parent.readProgress!.head, f.head); assert.equal(parent.readProgress!.successorAttemptId, null);
    assert.equal(f.checkpoint.phase, complete ? 'complete' : 'partial'); assert.equal(f.checkpoint.collection.exhausted, complete);
    assert.ok(f.checkpoint.calls.every(call => call.status === 'accepted'));
    const protectedDigests = new Set<string>();
    for (let cycle = 1; cycle <= 5; cycle++) {
      const current = await f.runtime.state('work-1'); const prepared = await f.compiler.prepare(current, { ...options, callId: `cycle-${cycle}` });
      assertMetadata(prepared.packet, expected, expectedMode); assert.deepEqual(prepared.packet.plan?.tasks, original.plan?.tasks);
      assert.equal(prepared.frame.memo.cycle, cycle); protectedDigests.add(prepared.frame.protectedDigest);
      assert.deepEqual(await f.runtime.state('work-1'), current); assert.equal(prepared.frame.metrics.extraModelCalls, 0);
      const installed = await publish(f, prepared); assert.equal(installed.committed, true);
      assert.deepEqual(installed.state.attempts, original.attempts); assert.deepEqual(installed.state.artifacts, original.artifacts);
      assert.equal(installed.state.artifacts.some(ref => ref.id === prepared.head.artifact.id), false);
    }
    assert.equal(protectedDigests.size, 1); assert.equal(f.entries(), 0); assert.equal(f.planner.inputs.length, 0);
    await f.closeState(); const reopened = openRepository(backend, f.directory);
    try {
      const services = { ...f.services, state: reopened, artifacts: new FileArtifactStore(join(f.directory, 'artifacts')) };
      const contracts = new ToolContracts([f.tool], new AjvSchemas()); const compiler = new ContextCompiler(services, contracts);
      const state = await reopened.get('work-1'); assert.ok(state);
      const prepared = await compiler.prepare(state, { ...options, callId: 'after-restart' }); assertMetadata(prepared.packet, expected, expectedMode);
      assert.deepEqual(prepared.packet.plan?.tasks, original.plan?.tasks);
      assert.equal(prepared.frame.memo.cycle, 6); assert.equal(protectedDigests.has(prepared.frame.protectedDigest), true);
      const restored = await new ContextRecovery(services, contracts).restore('work-1', actor);
      // Runtime recovery rebuilds a canonical view; only the compiler's model working set advertises the planning option.
      assertMetadata(restored.packet.context, expected, null);
      assert.deepEqual(restored.packet.context.readCollections, expected);
      assert.deepEqual(restored.packet.context.plan?.tasks, original.plan?.tasks);
      assert.ok(restored.packet.runtime.artifacts.some(ref => ref.id === f.head.id));
      assert.deepEqual(restored.packet.runtime.attempts.find(value => value.id === f.attemptId)!.readProgress, expected[0]!.progress);
      assert.equal(f.entries(), 0); assert.equal(f.planner.inputs.length, 0);
    } finally { await reopened.close(); }
  }, complete);
});

for (const backend of adapters) test(`read collection context ${backend}: lost derived frame regenerates while lost original raw response blocks context and recovery`, async () => {
  await fixture(backend, async f => {
    const prepared = await f.compiler.prepare(await f.runtime.state('work-1'), options); await publish(f, prepared);
    await rm(join(f.directory, 'artifacts', `${prepared.head.artifact.id}.blob`));
    const current = await f.runtime.state('work-1'); assert.equal((await f.compiler.frames.previous(current)).disposition, 'regenerated');
    const regenerated = await f.compiler.prepare(current, { ...options, callId: 'regenerated' }); assertMetadata(regenerated.packet, readCollectionContext(current), null);
    assert.equal(await f.compiler.sourcesCurrent(regenerated.packet, current), true);
    await rm(join(f.directory, 'artifacts', `${f.raw.id}.blob`));
    assert.equal(await f.artifacts.exists(f.head), true, 'the intact checkpoint copy cannot substitute for its original raw response');
    assert.equal(await f.compiler.sourcesCurrent(regenerated.packet, current), false);
    await assert.rejects(f.compiler.prepare(current, { ...options, callId: 'missing-original' }));
    await assert.rejects(f.recovery.restore('work-1', actor), /resume_original_unavailable/);
    assert.deepEqual(await f.runtime.state('work-1'), current); assert.equal(f.entries(), 0);
  });
});

for (const backend of adapters) test(`read collection context ${backend}: source gate rejects omitted, altered, and canonically inconsistent resume metadata`, async () => {
  await fixture(backend, async f => {
    const state = await f.runtime.state('work-1'); const prepared = await f.compiler.prepare(state, options);
    assert.equal(await f.compiler.sourcesCurrent(prepared.packet, state), true);
    const missing = structuredClone(prepared.packet); missing.readCollections = [];
    const altered = structuredClone(prepared.packet); altered.readCollections![0]!.progress.pendingItems++;
    assert.equal(await f.compiler.sourcesCurrent(missing, state), false); assert.equal(await f.compiler.sourcesCurrent(altered, state), false);
    await transact(f.services, state.id, 'inconsistent-summary', 'fixture_changed', {}, next => { next.attempts[0]!.readProgress!.completedItems++; });
    const inconsistent = await f.runtime.state(state.id); const packet = buildContextPacket(inconsistent, f.contracts);
    assert.equal(await f.compiler.sourcesCurrent(packet, inconsistent), false, 'matching the latest summary is insufficient without raw replay');
    await assert.rejects(f.recovery.restore(state.id, actor), /resume_read_collection_unavailable/);
    assert.equal(f.planner.inputs.length, 0);
  });
});

for (const backend of adapters) test(`read collection context ${backend}: resume metadata is mandatory input and cannot be evicted to satisfy a smaller byte budget`, async () => {
  await fixture(backend, async f => {
    const state = await f.runtime.state('work-1'); const prepared = await f.compiler.prepare(state, options); const estimates: ContextPacket[] = [];
    const planner = Object.assign(new ScriptedPlanner([]), { estimateInput: (packet: ContextPacket, callOptions: unknown) => {
      estimates.push(structuredClone(packet)); const bytes = new TextEncoder().encode(JSON.stringify({ packet, options: callOptions })).byteLength;
      return { tokens: bytes, bytes, method: 'test-envelope' };
    } });
    const compiler = new ContextCompiler({ ...f.services, planner }, f.contracts);
    await assert.rejects(compiler.prepare(state, { ...options, maxInputBytes: 1 }), /model_input_limit/);
    assert.equal(estimates.length, 1); assertMetadata(estimates[0]!, readCollectionContext(state), null);
    assert.deepEqual(await f.runtime.state('work-1'), state); assert.equal(planner.inputs.length, 0);
    assert.equal(await f.compiler.sourcesCurrent(prepared.packet, state), true);
  });
});

for (const backend of adapters) test(`read collection context ${backend}: source lifecycle change during checkpoint read prevents staged frame publication`, async () => {
  await fixture(backend, async f => {
    const state = await f.runtime.state('work-1'); let changed = false;
    const store: ArtifactStore = { put: (...args) => f.artifacts.put(...args), exists: ref => f.artifacts.exists(ref), get: async (ref, policy) => {
      const bytes = await f.artifacts.get(ref, policy);
      if (ref.id === f.head.id && !changed) {
        changed = true; await transact(f.services, state.id, 'source-lifecycle-change', 'fixture_changed', {}, next => {
          next.dataLifecycle = { generation: 1, blockedArtifactIds: [f.head.id, f.raw.id], changes: [] };
        });
      }
      return bytes;
    } };
    const compiler = new ContextCompiler({ ...f.services, artifacts: store }, f.contracts);
    await assert.rejects(compiler.prepare(state, options), /context_state_changed/); assert.equal(changed, true);
    const latest = await f.runtime.state('work-1'); assert.equal(latest.contextHead, undefined); assert.deepEqual(readCollectionContext(latest), []);
    assert.equal(f.entries(), 0); assert.equal(f.planner.inputs.length, 0);
  });
});

for (const backend of adapters) for (const change of ['contract', 'original'] as const) test(`read collection context ${backend}: ${change} change during derived resume put is checked before return`, async () => {
  await fixture(backend, async f => {
    const state = await f.runtime.state('work-1'); const prepared = await f.compiler.prepare(state, options);
    const withoutSelectedTool = { ...prepared.options, tools: [] };
    assert.equal(f.compiler.definitionsCurrent(prepared.packet, withoutSelectedTool, state), true);
    let changed = false;
    const store: ArtifactStore = { get: (...args) => f.artifacts.get(...args), exists: ref => f.artifacts.exists(ref), put: async (bytes, attributes) => {
      const ref = await f.artifacts.put(bytes, attributes);
      if (!changed && JSON.parse(new TextDecoder().decode(bytes)).kind === 'runtime_resume') {
        changed = true;
        if (change === 'original') await rm(join(f.directory, 'artifacts', `${f.raw.id}.blob`));
        else f.contracts.replaceProvider('fixture', [{ ...f.tool, definition: { ...f.tool.definition, description: 'Changed collection contract' } }],
          { expectedEpoch: f.contracts.providerEpoch('fixture'), sourceRevision: 'changed-during-resume-put' });
      }
      return ref;
    } };
    await assert.rejects(new ContextRecovery({ ...f.services, artifacts: store }, f.contracts).restore(state.id, actor), /resume_read_collection_unavailable/);
    assert.equal(changed, true); assert.deepEqual(await f.runtime.state(state.id), state);
    if (change === 'contract') {
      assert.equal(f.compiler.definitionsCurrent(prepared.packet, withoutSelectedTool, state), false,
        'a checkpoint contract remains pinned even if the active schema list does not contain its tool');
      assert.equal(await f.compiler.sourcesCurrent(prepared.packet, state), false);
    }
    assert.equal(f.entries(), 0); assert.equal(f.planner.inputs.length, 0);
  });
});

for (const backend of adapters) test(`read collection context ${backend}: completed adopted output retains original proof requirements after leaving the resume list`, async () => {
  await fixture(backend, async f => {
    const state = await adoptComplete(f); const prepared = await f.compiler.prepare(state, options);
    assert.deepEqual(prepared.packet.readCollections ?? [], []);
    assert.ok(prepared.packet.toolObservations?.some(value => value.attemptId === f.attemptId && value.representation === 'full'));
    assert.match(JSON.stringify(prepared.packet), new RegExp(bodyMarker));
    assert.equal(await f.compiler.sourcesCurrent(prepared.packet, state), true);
    await rm(join(f.directory, 'artifacts', `${f.raw.id}.blob`));
    assert.equal(await f.artifacts.exists(state.attempts.find(value => value.id === f.attemptId)!.resultArtifact!), true);
    assert.equal(await f.compiler.sourcesCurrent(prepared.packet, state), false);
    await assert.rejects(f.compiler.prepare(state, { ...options, callId: 'lost-adopted-original' }), /context_source_unavailable/);
    assert.equal(f.planner.inputs.length, 0); assert.deepEqual(await f.runtime.state('work-1'), state);
  }, true);
});

for (const backend of adapters) test(`read collection context ${backend}: raw loss during frame staging suppresses completed adopted copies`, async () => {
  await fixture(backend, async f => {
    const state = await adoptComplete(f); let removed = false;
    const artifacts: ArtifactStore = { get: (...args) => f.artifacts.get(...args), exists: ref => f.artifacts.exists(ref), put: async (bytes, attributes) => {
      const ref = await f.artifacts.put(bytes, attributes);
      if (!removed && JSON.parse(new TextDecoder().decode(bytes)).kind === 'model_context') {
        removed = true; await rm(join(f.directory, 'artifacts', `${f.raw.id}.blob`));
      }
      return ref;
    } };
    await assert.rejects(new ContextCompiler({ ...f.services, artifacts }, f.contracts).prepare(state, options), /context_guidance_unavailable/);
    assert.equal(removed, true); assert.deepEqual(await f.runtime.state('work-1'), state); assert.equal(state.contextHead, undefined);
    assert.equal(f.planner.inputs.length, 0);
  }, true);
});
