import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TaskSpec } from '../domain/model.js';
import type { ReadCheckpoint, ReadProgress } from '../domain/read-checkpoint.js';
import type { ReadLimits, ReadPage } from '../domain/read-collection.js';
import type { Tool } from '../application/ports.js';
import type { RuntimeServices } from '../application/services.js';
import { ContextCompiler } from '../application/context-compiler.js';
import { ContextRecovery } from '../application/context-recovery.js';
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
import { artifact, command, initial, openRepository, type Adapter } from './state-conformance-helpers.js';

// Reuses the existing read-collection-context fixture's committed dispatch/page/checkpoint boundary.
const limits: ReadLimits = { maxPages: 4, maxItems: 10, maxCalls: 8, maxPageBytes: 65536, maxCheckpointBytes: 262144, pageSize: 2 };
export const bodyMarker = 'ORIGINAL_PAGE_BODY_MUST_STAY_IN_CHECKPOINT';
export const cursorMarker = 'OPAQUE_PROVIDER_CURSOR_MUST_STAY_IN_CHECKPOINT';
export const contextOptions = { callId: 'context-call', maxOutputTokens: 100, maxInputBytes: 100000, maxInputTokens: 1000000, forceCompact: true };
const progress = (extras: Partial<ReadProgress> = {}): ReadProgress => ({ operationId: 'operation', head: artifact(), callCount: 1,
  remainingCalls: 7, completedPages: 0, completedItems: 1, pendingItems: 1, unknownCalls: 0, phase: 'partial', successorAttemptId: null, ...extras });

export async function resumeOptionFixture(backend: Adapter, complete = false) {
  const directory = await mkdtemp(join(tmpdir(), 'secumon-read-context-')); const state = openRepository(backend, directory);
  try {
    const artifacts = new FileArtifactStore(join(directory, 'artifacts')); const clock = new FakeClock(1000); const planner = new ScriptedPlanner([packet => {
      const parent = packet.readCollections?.[0], original = packet.plan?.tasks.find(value => value.id === parent?.taskId);
      if (!parent || !original) throw new Error('fixture_resume_option_missing');
      return { status: 'ok', provider: 'scripted', model: 'fixture', inputTokens: 13, outputTokens: 5, proposal: {
        baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision, basePlanRevision: packet.plan?.revision ?? 0,
        reason: 'Consume the verified complete collection', hypotheses: [], tasks: [{ ...original, id: 'resume-task',
          readResume: { attemptId: parent.attemptId, checkpointId: parent.progress.head.id } }] } };
    }]);
    let entries = 0;
    const tool: Tool = { definition: { provider: 'fixture', id: 'fixture.read', version: '1', description: 'Read a bounded synthetic collection', effect: 'read',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, outputSchema: { type: 'object' }, destination: 'local', labels: ['synthetic'],
      collection: { kind: 'paged', limits } }, execute: async () => { entries++; throw new Error('fixture_must_not_invoke'); } };
    const services: RuntimeServices = { state, artifacts, clock, planner, tools: [tool], ids: new SequenceIds(), digester: new Sha256Digester(), sink: new FakeSink() };
    const contracts = new ToolContracts(services.tools, new AjvSchemas()); const runtime = new ExecutionRuntime(services, contracts, 'context-fixture');
    const work = initial(); work.budget.limits.tokens = 100000;
    assert.equal((await state.commit(command(work, 'create'))).kind, 'committed');
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
      task, attemptId: reserved.id, entries: () => entries, closeState: async () => { if (!stateClosed) { stateClosed = true; await state.close(); } } };
  } catch (error) { await state.close(); await rm(directory, { recursive: true, force: true }); throw error; }
}
