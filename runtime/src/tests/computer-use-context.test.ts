import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ComputerCheckpoint, ComputerObservationRecord, ComputerProgress } from '../domain/computer-use.js';
import type { ContextPacket, Json, TaskSpec } from '../domain/model.js';
import type { ArtifactStore, Tool } from '../application/ports.js';
import type { RuntimeServices } from '../application/services.js';
import { ContextCompiler } from '../application/context-compiler.js';
import { buildContextPacket } from '../application/context-packet.js';
import { ContextRecovery } from '../application/context-recovery.js';
import { ComputerCheckpointSchema, ComputerObservationRecordSchema, COMPUTER_ACT_INPUT_SCHEMA } from '../application/computer-use-contracts.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { asJson } from '../application/plan-validator.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { transact } from '../application/work-transactions.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { FakeClock, FakeSink, ScriptedPlanner, SequenceIds } from '../infrastructure/fakes.js';
import { adapters, command, initial, openRepository, type Adapter } from './state-conformance-helpers.js';

const actor = { tenantId: 'tenant-a', principalId: 'person-a' };
const options = { callId: 'computer-context', maxOutputTokens: 100, maxInputBytes: 100000, maxInputTokens: 1000000, forceCompact: true };
const rawMarker = 'COMPUTER_ORIGINAL_VIEW_IS_NOT_A_CONTEXT_SUMMARY';
const zeroUsage = { transportCalls: 0, internalOperations: 0, imageBytes: 0, waitMs: 0 };

async function setup(backend: Adapter, phase: 'running' | 'unknown' = 'running') {
  const directory = await mkdtemp(join(tmpdir(), 'computer-context-')); const state = openRepository(backend, directory);
  try {
    const artifacts = new FileArtifactStore(join(directory, 'artifacts')); const clock = new FakeClock(1000);
    const planner = new ScriptedPlanner([]); let toolCalls = 0; let knowledgeCurrent = true;
    const tool: Tool = { definition: { provider: 'fixture', id: 'fixture.ui.act', version: '1', description: 'Explicit synthetic typed action',
      effect: 'write', inputSchema: COMPUTER_ACT_INPUT_SCHEMA, outputSchema: { type: 'object' }, destination: 'local', labels: ['synthetic'] },
      execute: async () => { toolCalls++; throw new Error('context_must_not_execute_tool'); } };
    const services: RuntimeServices = { state, artifacts, clock, planner, tools: [tool], ids: new SequenceIds(), digester: new Sha256Digester(), sink: new FakeSink(),
      knowledge: { validate: async () => knowledgeCurrent } };
    const contracts = new ToolContracts([tool], new AjvSchemas()); const runtime = new ExecutionRuntime(services, contracts, 'computer-context-worker');
    const work = initial(); work.policy.allowedTools = ['fixture.ui.act']; work.policy.allowWrites = true;
    assert.equal((await state.commit(command(work, 'create'))).kind, 'committed');
    const observation: ComputerObservationRecord = ComputerObservationRecordSchema.parse({ schemaVersion: 1, kind: 'computer_observation',
      workId: work.id, attemptId: 'original-observer', goalRevision: work.goal.revision, scope: work.goal.scope,
      policyDigest: services.digester.digest(asJson(work.policy)), lifecycleGeneration: 0, driver: { id: 'fixture-driver', version: '1' }, usage: zeroUsage,
      view: { sessionId: 'fixture-session', epoch: 1, surfaceId: 'fixture-window', revision: 1, focusRevision: 1, observedAt: clock.now(),
        elements: [{ ref: 'note', role: 'textbox', name: 'Note', value: rawMarker, visible: true, enabled: true }], facts: {}, partial: false, omittedCount: 0 } });
    const put = (value: unknown) => artifacts.put(new TextEncoder().encode(JSON.stringify(value)), { tenantId: work.policy.tenantId, labels: work.policy.allowedLabels, mediaType: 'application/json' });
    const raw = await put(observation);
    const step = { action: { kind: 'fill' as const, target: { role: 'textbox', name: 'Note' }, value: 'reviewed' },
      condition: { kind: 'element_value' as const, target: { role: 'textbox', name: 'Note' }, value: 'reviewed' } };
    const task: TaskSpec = { id: 'computer-task', description: 'Fill the reviewed value', toolId: 'fixture.ui.act', toolVersion: '1',
      dependsOn: [], effect: 'write', maxAttempts: 1, satisfies: [], input: asJson({ observationId: raw.id, steps: [step], timeoutMs: 1000 }) as Record<string, Json> };
    await runtime.submitPlan(work.id, 'plan', { baseStateRevision: work.revision, baseGoalRevision: work.goal.revision, basePlanRevision: 0,
      reason: 'Explicit fixture input', tasks: [task], hypotheses: [] });
    const reserved = await runtime.reserve(work.id, task.id); assert.equal(await runtime.dispatch(work.id, reserved.id), true);
    const dispatched = await runtime.state(work.id); const attempt = dispatched.attempts.find(value => value.id === reserved.id)!;
    const checkpoint: ComputerCheckpoint = ComputerCheckpointSchema.parse({ schemaVersion: 1, kind: 'computer_checkpoint', workId: work.id,
      attemptId: attempt.id, goalRevision: attempt.goalRevision, scope: attempt.scope, policyDigest: observation.policyDigest, lifecycleGeneration: 0,
      taskDigest: attempt.inputDigest, contractDigest: attempt.contractDigest, driver: observation.driver, sessionId: observation.view.sessionId,
      epoch: observation.view.epoch, deadlineAt: Math.min(attempt.leaseUntil, clock.now() + 1000), initialObservation: raw, latestObservation: raw,
      steps: [{ index: 0, operationId: 'pending-input', ...step, before: raw, after: null, status: phase === 'running' ? 'intent' : 'unknown',
        verified: false, errorCode: phase === 'running' ? null : 'response_unknown' }], phase, stopReason: phase === 'running' ? null : 'response_unknown', usage: zeroUsage });
    const head = await put(checkpoint);
    const progress: ComputerProgress = { head, phase, completedSteps: 0, pendingOperationId: 'pending-input' };
    // Seed the durable post-intent crash boundary through the real dispatch and state commit paths; runner input is tested separately.
    await transact(services, work.id, 'computer-head', 'computer_checkpoint_stored', { attemptId: attempt.id, checkpointId: head.id }, current => {
      current.artifacts.push(raw, head); const pending = current.attempts.find(value => value.id === attempt.id)!;
      pending.computerUse = progress;
      pending.knowledgeDependencies = [{ tenantId: current.policy.tenantId, knowledgeId: 'fixture-memory', knowledgeRevision: 1, actorDigest: 'a'.repeat(64),
        sources: [{ workId: 'source-work', evidenceId: 'source-evidence', sourceVersion: 'b'.repeat(64), generation: 0, workRevision: 1, policyDigest: 'c'.repeat(64) }], parents: [] }];
      if (phase === 'unknown') {
        pending.status = 'unknown'; pending.finishedAt = clock.now(); pending.error = { code: 'response_unknown', retryable: false };
        current.obligations.push({ id: 'reconcile-input', kind: 'effect_reconciliation', reason: 'input_response_unknown', status: 'pending', wakeKey: null, dueAt: null });
        current.status = 'blocked'; current.statusReason = 'effect_unknown';
      }
    });
    let closed = false;
    return { backend, directory, state, artifacts, services, contracts, runtime, planner, tool, head, raw, progress, attemptId: attempt.id,
      compiler: new ContextCompiler(services, contracts), recovery: new ContextRecovery(services, contracts), toolCalls: () => toolCalls,
      invalidateKnowledge: () => { knowledgeCurrent = false; },
      closeState: async () => { if (!closed) { closed = true; await state.close(); } } };
  } catch (error) { await state.close(); await rm(directory, { recursive: true, force: true }); throw error; }
}
type Harness = Awaited<ReturnType<typeof setup>>;
async function fixture(backend: Adapter, run: (h: Harness) => Promise<void>, phase: 'running' | 'unknown' = 'running') {
  const h = await setup(backend, phase); try { await run(h); } finally { await h.closeState(); await rm(h.directory, { recursive: true, force: true }); }
}
function assertHead(packet: ContextPacket, h: Harness) {
  assert.deepEqual(packet.execution!.attempts.find(attempt => attempt.id === h.attemptId)!.computerUse, h.progress);
  assert.equal(JSON.stringify(packet).includes(rawMarker), false);
  assert.equal(JSON.stringify(packet).includes('fixture-memory'), false, 'internal knowledge custody is not copied into the public attempt');
}
async function publish(h: Harness, prepared: Awaited<ReturnType<ContextCompiler['prepare']>>) {
  return transact(h.services, 'work-1', `compact-${prepared.head.cycle}`, 'context_compacted', {}, state => { state.contextHead = prepared.head; });
}

for (const backend of adapters) for (const phase of ['running', 'unknown'] as const) test(`computer context ${backend}: five compactions and restart preserve ${phase} input metadata`, async () => {
  await fixture(backend, async h => {
    const original = await h.runtime.state('work-1'); const protectedDigests = new Set<string>();
    for (let cycle = 1; cycle <= 5; cycle++) {
      const current = await h.runtime.state('work-1'); const prepared = await h.compiler.prepare(current, { ...options, callId: `cycle-${cycle}` });
      assertHead(prepared.packet, h); assert.equal(prepared.frame.memo.cycle, cycle); protectedDigests.add(prepared.frame.protectedDigest);
      assert.equal(await h.compiler.sourcesCurrent(prepared.packet, current), true); assert.equal(prepared.frame.metrics.extraModelCalls, 0);
      assert.deepEqual(await h.runtime.state('work-1'), current); await publish(h, prepared);
    }
    assert.equal(protectedDigests.size, 1); await h.closeState(); const reopened = openRepository(backend, h.directory);
    try {
      const services = { ...h.services, state: reopened, artifacts: new FileArtifactStore(join(h.directory, 'artifacts')) };
      const state = await reopened.get('work-1'); assert.ok(state);
      assert.deepEqual(state.attempts, original.attempts); assert.deepEqual(state.obligations, original.obligations); assert.deepEqual(state.artifacts, original.artifacts);
      const prepared = await new ContextCompiler(services, h.contracts).prepare(state, { ...options, callId: 'reopened' });
      assertHead(prepared.packet, h); assert.equal(prepared.frame.memo.cycle, 6);
      const restored = await new ContextRecovery(services, h.contracts).restore(state.id, actor); assertHead(restored.packet.context, h);
      assert.deepEqual(restored.packet.runtime.attempts.find(attempt => attempt.id === h.attemptId)!.computerUse, h.progress);
      assert.ok(restored.packet.runtime.artifacts.some(ref => ref.id === h.head.id)); assert.deepEqual(await reopened.get(state.id), state);
      assert.equal(h.toolCalls(), 0); assert.equal(h.planner.inputs.length, 0);
    } finally { await reopened.close(); }
  }, phase);
});

for (const backend of adapters) for (const fault of ['deleted', 'modified'] as const) test(`computer context ${backend}: ${fault} head blocks compaction, source fence and restore`, async () => {
  await fixture(backend, async h => {
    const state = await h.runtime.state('work-1'); const prepared = await h.compiler.prepare(state, options);
    const path = join(h.directory, 'artifacts', `${h.head.id}.blob`);
    if (fault === 'deleted') await rm(path);
    else { const bytes = await readFile(path); bytes[0] = bytes[0] === 123 ? 91 : 123; await writeFile(path, bytes); }
    assert.equal(await h.compiler.sourcesCurrent(prepared.packet, state), false);
    await assert.rejects(h.compiler.prepare(state, { ...options, callId: 'after-source-loss' }));
    await assert.rejects(h.recovery.restore(state.id, actor), /resume_original_unavailable/);
    assert.deepEqual(await h.runtime.state(state.id), state); assert.equal(h.toolCalls(), 0); assert.equal(h.planner.inputs.length, 0);
  });
});

for (const backend of adapters) test(`computer context ${backend}: mandatory input metadata cannot be evicted, altered or reassigned to a later goal`, async () => {
  await fixture(backend, async h => {
    const state = await h.runtime.state('work-1'); const prepared = await h.compiler.prepare(state, options);
    const missing = structuredClone(prepared.packet); delete missing.execution!.attempts[0]!.computerUse;
    const altered = structuredClone(prepared.packet); altered.execution!.attempts[0]!.computerUse!.pendingOperationId = 'another-input';
    assert.equal(await h.compiler.sourcesCurrent(missing, state), false); assert.equal(await h.compiler.sourcesCurrent(altered, state), false);
    await assert.rejects(h.compiler.prepare(state, { ...options, maxInputBytes: prepared.estimate.bytes - 1 }), /model_input_limit/);
    await transact(h.services, state.id, 'later-goal', 'fixture_changed', {}, next => { next.goal.revision++; next.goal.scope = 'later-scope'; next.plan = null; });
    const later = await h.runtime.state(state.id); const packet = buildContextPacket(later, h.contracts); assertHead(packet, h);
    assert.equal(packet.execution!.attempts[0]!.scope, state.goal.scope); assert.equal(packet.execution!.attempts[0]!.goalRevision, state.goal.revision);
    assert.equal(packet.goal.scope, 'later-scope'); assert.equal(await h.compiler.sourcesCurrent(packet, later), true);
    assert.equal(h.toolCalls(), 0);
  }, 'unknown');
});

for (const backend of adapters) for (const derived of ['model_context', 'runtime_resume'] as const) test(`computer context ${backend}: head loss during ${derived} staging is checked before return`, async () => {
  await fixture(backend, async h => {
    const state = await h.runtime.state('work-1'); let changed = false;
    const artifacts: ArtifactStore = { get: (...args) => h.artifacts.get(...args), exists: ref => h.artifacts.exists(ref), put: async (bytes, attributes) => {
      const ref = await h.artifacts.put(bytes, attributes);
      if (!changed && JSON.parse(new TextDecoder().decode(bytes)).kind === derived) {
        changed = true; await rm(join(h.directory, 'artifacts', `${h.head.id}.blob`));
      }
      return ref;
    } };
    const services = { ...h.services, artifacts };
    if (derived === 'model_context') await assert.rejects(new ContextCompiler(services, h.contracts).prepare(state, options), /context_guidance_unavailable/);
    else await assert.rejects(new ContextRecovery(services, h.contracts).restore(state.id, actor), /resume_computer_checkpoint_unavailable/);
    assert.equal(changed, true); assert.deepEqual(await h.runtime.state(state.id), state); assert.equal(h.planner.inputs.length, 0); assert.equal(h.toolCalls(), 0);
  });
});

for (const backend of adapters) test(`computer context ${backend}: current knowledge, source lifecycle and read permissions still fence metadata`, async () => {
  await fixture(backend, async h => {
    const state = await h.runtime.state('work-1'); const prepared = await h.compiler.prepare(state, options);
    h.invalidateKnowledge(); assert.equal(await h.compiler.sourcesCurrent(prepared.packet, state), false);
    await assert.rejects(h.compiler.prepare(state, options), /context_state_changed/);
    await assert.rejects(h.recovery.restore(state.id, actor), /resume_knowledge_dependency_changed/);
    const blocked = structuredClone(state); blocked.dataLifecycle = { generation: 1, blockedArtifactIds: [h.head.id], changes: [] };
    assert.equal(buildContextPacket(blocked, h.contracts).execution!.attempts[0]!.computerUse, undefined);
    assert.equal(await h.compiler.sourcesCurrent(prepared.packet, blocked), false);
    const denied = structuredClone(state); denied.policy.allowedLabels = ['other'];
    assert.equal(buildContextPacket(denied, h.contracts).execution!.attempts[0]!.computerUse, undefined);
    assert.equal(await h.compiler.sourcesCurrent(prepared.packet, denied), false);
    assert.deepEqual(await h.runtime.state(state.id), state);
  });
});
