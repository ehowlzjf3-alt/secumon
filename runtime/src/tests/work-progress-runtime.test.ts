import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ContextPacket, TaskSpec, ToolResult } from '../domain/model.js';
import type { ModelReply, Tool } from '../application/ports.js';
import type { ProgressPolicy, WorkProgress } from '../domain/work-progress.js';
import { DEFAULT_PROGRESS_POLICY, observeProgress } from '../domain/work-progress.js';
import { newExecutionControl } from '../domain/execution-policy.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { taskFailureKey, modelFailureKey } from '../application/execution-decision.js';
import { transact } from '../application/work-transactions.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { FakeClock, FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { Sha256Digester, RandomIds } from '../infrastructure/digest.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { adapters, command, initial, openRepository, type Adapter } from './state-conformance-helpers.js';

const actor = { tenantId: 'tenant-a', principalId: 'person-a' };
const digester = new Sha256Digester();
const workId = 'progress-runtime';
function blankProgress(overrides: Partial<ProgressPolicy> = {}): WorkProgress {
  return { schemaVersion: 1, goalRevision: 1, policy: { ...DEFAULT_PROGRESS_POLICY, ...overrides }, processed: [], knownKeys: [],
    productiveSteps: 0, unproductiveSteps: 0, consecutiveUnproductive: 0, failures: [], saturated: false };
}
function stalled(): WorkProgress {
  let progress = blankProgress();
  for (let index = 0; index < 3; index++) progress = observeProgress(progress, { goalRevision: 1, operationId: `fixture-settled-${index}`, keys: [], failureKey: null, at: 1000 });
  return progress;
}
type Outcome = 'error' | 'empty' | 'evidence' | 'unknown-write';
async function harness(adapter: Adapter, options: { outcome?: Outcome; progressPolicy?: Partial<ProgressPolicy>; planner?: ScriptedPlanner } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'secumon-progress-runtime-')); const clock = new FakeClock(1000);
  const planner = options.planner ?? new ScriptedPlanner([]); const sink = new FakeSink(); let entries = 0; let owner = 0;
  const outcome = options.outcome ?? 'error'; const effect = outcome === 'unknown-write' ? 'write' : 'read';
  const tool: Tool = { definition: { provider: 'fixture', id: 'fixture.read', version: '1', description: 'Synthetic bounded source', effect,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, outputSchema: { type: 'object' }, labels: ['synthetic'], destination: 'local' },
    execute: async (_task, context): Promise<ToolResult> => {
      entries++; const failed = outcome === 'error' || outcome === 'unknown-write';
      return { resultId: `${context.attemptId}:result`, attemptId: context.attemptId, status: failed ? 'error' : 'success',
        effectState: outcome === 'unknown-write' ? 'unknown' : 'none', error: failed ? { code: 'synthetic_source_unavailable', retryable: outcome === 'error' } : null,
        evidence: outcome === 'evidence' ? [{ id: 'available-original', tenantId: actor.tenantId, scope: 'fixture', sourceId: 'fixture-original', lineageId: 'fixture-original',
          locator: 'local:fixture-original', observedAt: 1000, recordedAt: 1000, labels: ['synthetic'], coverage: 'complete', status: 'accepted', supersedes: [], derivedFrom: [],
          facts: { available: true }, artifact: null }] : [], artifacts: [], output: failed ? null : { available: outcome === 'evidence' }, coverage: failed ? 'unknown' : 'complete', cursor: null,
        usage: { transportCalls: 1, internalOperations: 1, imageBytes: 0, waitMs: 0 } };
    } };
  let repository = openRepository(adapter, directory);
  const open = () => composeRuntime({ services: { state: repository, artifacts: new FileArtifactStore(join(directory, 'artifacts')), clock, planner, sink,
    ids: new RandomIds(), digester, tools: [tool] }, schemas: new AjvSchemas(), owner: `owner-${++owner}`,
    guidanceSource: { list: async () => [], read: async () => { throw new Error('unused_guidance'); } } });
  let composed = await open(); const work = initial(workId); work.goal.mode = 'deep'; work.executionControl = newExecutionControl('deep');
  work.budget.limits = { ...work.budget.limits, toolCalls: 30, modelCalls: 20, tokens: 1000000, replans: 20 };
  work.policy.allowWrites = effect === 'write'; work.progress = blankProgress(options.progressPolicy);
  assert.equal((await repository.commit(command(work, 'create'))).kind, 'committed');
  const task = (id: string): TaskSpec => ({ id, description: `Synthetic request ${id}`, toolId: tool.definition.id, toolVersion: '1', effect,
    input: {}, dependsOn: [], maxAttempts: 10, satisfies: [] });
  const plan = async (id: string) => {
    const current = await composed.runtime.state(workId); const selected = task(id);
    await composed.runtime.submitPlan(workId, `plan:${id}`, { baseStateRevision: current.revision, baseGoalRevision: current.goal.revision,
      basePlanRevision: current.plan?.revision ?? 0, reason: `Synthetic plan ${id}`, tasks: [selected], hypotheses: [] }); return selected;
  };
  const execute = async (id: string, adopt = true) => {
    const attempt = await composed.runtime.reserve(workId, id); await composed.runtime.execute(workId, attempt.id); await composed.runtime.settlePending(attempt.id);
    if (adopt) await composed.runtime.adopt(workId, attempt.id); return attempt;
  };
  return { directory, clock, planner, sink, task, plan, execute, entries: () => entries, get core() { return composed; }, get repository() { return repository; },
    read: () => composed.runtime.state(workId), reopen: async () => { await repository.close(); repository = openRepository(adapter, directory); composed = await open(); },
    close: async () => { await repository.close(); await rm(directory, { recursive: true, force: true }); } };
}
type Harness = Awaited<ReturnType<typeof harness>>;
async function use(adapter: Adapter, options: Parameters<typeof harness>[1], run: (fixture: Harness) => Promise<void>) {
  const fixture = await harness(adapter, options); try { await run(fixture); } finally { await fixture.close(); }
}
async function seedStall(fixture: Harness, id: string) {
  await transact(fixture.core.services, workId, id, 'fixture_allocation_boundary', {}, state => { state.progress = stalled(); });
}
const invalidReply = (packet: ContextPacket): ModelReply => ({ status: 'ok', provider: 'scripted', model: 'fixture', inputTokens: 100, outputTokens: 50,
  proposal: { baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision, basePlanRevision: packet.plan?.revision ?? 0,
    reason: `Invalid proposal at ${packet.stateRevision}`, hypotheses: [], tasks: [{ id: `renamed-invalid-${packet.stateRevision}`, description: 'Same invalid request',
      toolId: 'fixture.read', toolVersion: 'missing', effect: 'read', input: {}, dependsOn: [], maxAttempts: 1, satisfies: [] }] } });

for (const adapter of adapters) {
  test(`progress runtime ${adapter}: renamed tasks share failure history and backoff survives workflow runs and reopening`, async () => {
    await use(adapter, { progressPolicy: { maxUnproductiveSteps: 20 } }, async f => {
      const original = await f.plan('request-a'); const first = await f.execute(original.id); const initial = await f.read();
      const key = taskFailureKey(initial, original, digester); assert.equal(initial.progress!.failures[0]!.key, key); assert.equal(initial.progress!.failures[0]!.count, 1);
      const receipt = await f.repository.receipt(workId, `adopt:${first.id}`); assert.equal(receipt!.state.progress!.failures[0]!.count, 1);
      assert.equal(receipt!.state.attempts.find(a => a.id === first.id)!.status, 'failed');
      await f.core.runtime.adopt(workId, first.id); assert.deepEqual((await f.read()).progress, initial.progress);
      const renamed = await f.plan('request-b'); assert.equal(taskFailureKey(await f.read(), renamed, digester), key);
      assert.deepEqual(await f.core.runtime.step(workId), { kind: 'wait', reason: 'retry_backoff', wakeAt: 1100 });
      assert.equal((await f.read()).retryWakeAt, 1100); assert.deepEqual(await f.repository.runnable(1099), []); assert.deepEqual(await f.repository.runnable(1100), [workId]);
      const beforeWait = (await f.read()).progress; await f.reopen();
      for (let count = 0; count < 2; count++) assert.equal((await f.core.workflow.run(workId, actor)).control.kind, 'wait');
      assert.deepEqual((await f.read()).progress, beforeWait); assert.equal(f.entries(), 1); assert.equal(f.planner.inputs.length, 0);
      f.clock.advance(100); await f.execute(renamed.id); await f.plan('request-c'); f.clock.advance(100); await f.execute('request-c');
      const third = await f.read(); assert.equal(third.progress!.failures.length, 1); assert.equal(third.progress!.failures[0]!.count, 3);
      assert.equal(third.progress!.failures[0]!.deadlineAt, 31000); assert.equal(third.budget.used.toolCalls, 3);
      await f.plan('request-d'); const stopped = await f.core.runtime.step(workId);
      assert.equal(stopped.kind, 'blocked'); assert.equal(stopped.reason, 'repeated_failure_limit');
      await assert.rejects(f.core.runtime.reserve(workId, 'request-d')); assert.equal(f.entries(), 3);
    });
  });

  test(`progress runtime ${adapter}: replanning cannot extend the first semantic request retry deadline`, async () => {
    await use(adapter, { progressPolicy: { maxUnproductiveSteps: 20, maxRepeatedFailures: 10, retryWindowMs: 250 } }, async f => {
      await f.plan('first'); await f.execute('first'); await f.plan('renamed'); f.clock.advance(200); await f.execute('renamed');
      assert.equal((await f.read()).progress!.failures[0]!.deadlineAt, 1250);
      await f.plan('renamed-again'); assert.deepEqual(await f.core.runtime.step(workId), { kind: 'wait', reason: 'retry_backoff', wakeAt: 1250 });
      await f.reopen(); f.clock.advance(50); assert.deepEqual(await f.repository.runnable(f.clock.now()), [workId]);
      const stop = await f.core.runtime.step(workId); assert.equal(stop.kind, 'blocked'); assert.equal(stop.reason, 'retry_deadline_exceeded');
      await f.plan('same-query-new-plan'); assert.equal((await f.core.runtime.step(workId)).reason, 'retry_deadline_exceeded');
      assert.equal((await f.read()).progress!.failures[0]!.deadlineAt, 1250); assert.equal(f.entries(), 2);
    });
  });

  test(`progress runtime ${adapter}: successful empty results still stall and mode, compact, resume and reopening cannot erase that state`, async () => {
    await use(adapter, { outcome: 'empty' }, async f => {
      for (let index = 0; index < 3; index++) { await f.plan(`same-query-${index}`); await f.execute(`same-query-${index}`); }
      const stop = await f.core.runtime.step(workId); assert.equal(stop.reason, 'no_progress_limit');
      const before = await f.read(); assert.equal(before.progress!.consecutiveUnproductive, 3); assert.equal(before.progress!.productiveSteps, 0);
      assert.equal(before.attempts.filter(a => a.adopted).length, 3);
      await f.core.runtime.command(workId, 'mode-auto', actor, 1, { kind: 'mode', mode: 'auto', reason: 'Keep the same goal', expectedControlRevision: before.executionControl!.revision });
      let current = await f.read(); assert.deepEqual(current.progress, before.progress); assert.equal(current.goal.revision, 1); assert.equal(current.deadlineAt, before.deadlineAt);
      const prepared = await f.core.context.prepare(current, { callId: 'synthetic-compact', maxOutputTokens: 128, maxInputBytes: 100000, maxInputTokens: 100000, forceCompact: true });
      await transact(f.core.services, workId, 'save-compact', 'context_compacted', { artifactId: prepared.head.artifact.id }, state => {
        assert.equal(state.revision, current.revision); state.contextHead = prepared.head;
      });
      current = await f.read(); assert.deepEqual(current.progress, before.progress);
      await f.core.runtime.command(workId, 'explicit-resume', actor, 1, { kind: 'resume', reason: 'Inspect the retained boundary' });
      assert.deepEqual((await f.read()).progress, before.progress); await f.reopen();
      const result = await f.core.workflow.run(workId, actor); assert.equal(result.control.kind, 'blocked'); assert.equal(result.reason, 'no_progress_limit');
      assert.deepEqual((await f.read()).progress, before.progress); assert.equal(f.entries(), 3); assert.equal(f.planner.inputs.length, 0);
    });
  });

  test(`progress runtime ${adapter}: a stored tool result settles atomically before allocation gates and verified completion still wins`, async () => {
    await use(adapter, { outcome: 'evidence' }, async f => {
      await f.plan('read'); const attempt = await f.execute('read', false); assert.equal((await f.read()).attempts[0]!.status, 'received');
      await seedStall(f, 'stall-with-received-result'); await f.reopen();
      const adopted = await f.core.runtime.step(workId); assert.equal(adopted.kind, 'continue'); if (adopted.kind === 'continue') assert.equal(adopted.action, 'adopt');
      const receipt = await f.repository.receipt(workId, `adopt:${attempt.id}`); assert.equal(receipt!.state.attempts[0]!.adopted, true);
      assert.ok(receipt!.state.progress!.processed.includes(`attempt:${attempt.id}:settled`)); assert.equal(receipt!.state.evidence[0]!.facts['available'], true);
      const once = (await f.read()).progress; await f.core.runtime.adopt(workId, attempt.id); assert.deepEqual((await f.read()).progress, once);
      await seedStall(f, 'stall-with-complete-evidence'); assert.equal((await f.core.runtime.step(workId)).kind, 'complete');
      assert.equal((await f.core.workflow.run(workId, actor)).control.kind, 'complete'); assert.equal((await f.read()).status, 'completed');
      assert.equal(f.entries(), 1); assert.equal(f.planner.inputs.length, 0);
    });
  });

  test(`progress runtime ${adapter}: a stored model reply settles after reopening even when new allocations are blocked`, async () => {
    const planner = new ScriptedPlanner([packet => ({ status: 'ok', provider: 'scripted', model: 'fixture', inputTokens: 100, outputTokens: 50,
      proposal: { baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision, basePlanRevision: packet.plan?.revision ?? 0,
        reason: 'Stored valid proposal', hypotheses: [], tasks: [{ id: 'planned-read', description: 'Local read', toolId: 'fixture.read', toolVersion: '1', effect: 'read', input: {}, dependsOn: [], maxAttempts: 1, satisfies: [] }] } })]);
    await use(adapter, { planner }, async f => {
      const call = await f.core.planning!.reserve(workId); await f.core.planning!.execute(workId, call.id); assert.equal((await f.read()).modelCalls[0]!.status, 'received');
      await seedStall(f, 'stall-with-received-model'); await f.reopen();
      const step = await f.core.planning!.step(workId); assert.equal(step.kind, 'continue'); assert.equal(step.reason, 'stored_model_reply');
      const settled = await f.read(); assert.equal(settled.modelCalls[0]!.status, 'accepted'); assert.equal(settled.budget.used.modelCalls, 1); assert.equal(settled.budget.used.tokens, 150);
      assert.ok(settled.progress!.processed.includes(`model:${call.id}:settled`)); const before = settled.progress;
      await f.core.planning!.adopt(workId, call.id); assert.deepEqual((await f.read()).progress, before);
      assert.equal((await f.core.planning!.step(workId)).reason, 'no_progress_limit'); assert.equal(f.planner.inputs.length, 1); assert.equal(f.entries(), 0);
    });
  });

  test(`progress runtime ${adapter}: repeated invalid model proposals preserve one failure key and persist model backoff`, async () => {
    const planner = new ScriptedPlanner([invalidReply, invalidReply, invalidReply]);
    await use(adapter, { planner, progressPolicy: { maxUnproductiveSteps: 20 } }, async f => {
      const originalKey = modelFailureKey(await f.read(), planner.identity, planner.destination, digester);
      for (let index = 0; index < 3; index++) {
        const call = await f.core.planning!.reserve(workId); await f.core.planning!.execute(workId, call.id); assert.equal(await f.core.planning!.adopt(workId, call.id), false);
        const current = await f.read(); assert.equal(current.progress!.failures[0]!.key, originalKey); assert.equal(current.progress!.failures[0]!.count, index + 1);
        const receipt = await f.repository.receipt(workId, `model-reject:${call.id}`); assert.equal(receipt!.state.modelCalls.find(c => c.id === call.id)!.status, 'rejected');
        assert.equal(receipt!.state.progress!.failures[0]!.count, index + 1);
        if (index < 2) {
          assert.deepEqual(await f.core.planning!.step(workId), { kind: 'wait', reason: 'retry_backoff', wakeAt: f.clock.now() + 100 });
          assert.deepEqual(await f.repository.runnable(f.clock.now() + 99), []); await f.reopen();
          assert.equal((await f.core.workflow.run(workId, actor)).reason, 'retry_backoff'); assert.equal(planner.inputs.length, index + 1); f.clock.advance(100);
        }
      }
      const stop = await f.core.planning!.step(workId); assert.equal(stop.kind, 'blocked'); assert.equal(stop.reason, 'repeated_failure_limit');
      assert.equal((await f.read()).progress!.failures[0]!.deadlineAt, 31000); assert.equal((await f.read()).budget.used.tokens, 450);
      assert.equal(planner.inputs.length, 3); assert.equal(f.entries(), 0);
    });
  });

  test(`progress runtime ${adapter}: a new goal starts a new streak while preserving usage, processed history and failure deadlines`, async () => {
    await use(adapter, { progressPolicy: { maxUnproductiveSteps: 20 } }, async f => {
      await f.plan('read'); await f.execute('read'); const before = await f.read();
      await f.core.runtime.command(workId, 'new-goal', actor, 1, { kind: 'goal', expectedControlRevision: before.executionControl?.revision ?? 1, goal: { ...before.goal, revision: 2, description: 'Explicitly changed synthetic goal' } });
      const next = await f.read(); assert.equal(next.progress!.goalRevision, 2); assert.equal(next.progress!.consecutiveUnproductive, 0);
      assert.deepEqual(next.progress!.processed, before.progress!.processed); assert.deepEqual(next.progress!.failures, before.progress!.failures);
      assert.deepEqual(next.budget, before.budget); assert.equal(next.deadlineAt, before.deadlineAt); await f.reopen();
      assert.deepEqual((await f.read()).progress, next.progress);
    });
  });

  test(`progress runtime ${adapter}: an unknown synthetic write remains an obligation ahead of a no-progress allocation stop`, async () => {
    await use(adapter, { outcome: 'unknown-write' }, async f => {
      await f.plan('write'); await f.execute('write'); await seedStall(f, 'stall-with-unknown-effect'); await f.reopen();
      const stop = await f.core.workflow.run(workId, actor); assert.equal(stop.control.kind, 'blocked'); assert.equal(stop.reason, 'effect_unknown');
      const saved = await f.read(); assert.equal(saved.attempts[0]!.effectState, 'unknown'); assert.equal(saved.attempts[0]!.adopted, false);
      assert.ok(saved.obligations.some(obligation => obligation.kind === 'effect_reconciliation' && obligation.status === 'pending'));
      assert.equal(f.entries(), 1); assert.equal(f.planner.inputs.length, 0); assert.notEqual(saved.status, 'completed');
    });
  });
}
