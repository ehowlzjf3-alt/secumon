import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ContextPacket, Hypothesis, Limits, Mode, PlanProposal, TaskSpec } from '../domain/model.js';
import type { CommitRequest, ModelCallOptions, ModelReply, Planner, ReadCollectionBinding, Tool } from '../application/ports.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { validateScenario } from '../application/fixtures.js';
import { newWork } from '../application/new-work.js';
import { executionControl, effectiveExecutionLimits } from '../domain/execution-policy.js';
import { hypothesesRequireReview } from '../domain/hypotheses.js';
import { prepareExecutionBoundary } from '../application/execution-control.js';
import { transact } from '../application/work-transactions.js';
import { asJson } from '../application/plan-validator.js';
import { dataGeneration } from '../domain/data-lifecycle.js';
import { FakeClock, FakeSink, FixtureReadTool } from '../infrastructure/fakes.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { RandomIds, Sha256Digester, sha256 } from '../infrastructure/digest.js';
import { adapters, openRepository, command, type Adapter } from './state-conformance-helpers.js';

const actor = { tenantId: 'synthetic', principalId: 'learner' };
const workId = 'mode-work';
const simpleFamilies = [['documents-simple', 'doc-current'], ['observations-simple', 'collection-complete']] as const;
const complexFamilies = [['documents-complex', ['doc-a-old', 'doc-b', 'doc-a-amendment']], ['observations-complex', ['signal', 'maintenance-ticket']]] as const;
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function task(id: string, evidenceId: string, dependsOn: string[] = []): TaskSpec {
  return { id, description: 'Read the next synthetic source', toolId: 'fixture.read', toolVersion: '1', effect: 'read',
    input: { evidenceIds: [evidenceId] }, dependsOn, maxAttempts: 1, satisfies: [] };
}
function proposal(packet: Pick<ContextPacket, 'stateRevision' | 'goal' | 'plan'>, tasks: TaskSpec[], hypotheses: Hypothesis[] = []): PlanProposal {
  return { baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision, basePlanRevision: packet.plan?.revision ?? 0,
    reason: 'Evaluate the same synthetic request under explicit execution controls', tasks, hypotheses };
}
function reply(packet: ContextPacket, tasks: TaskSpec[], hypotheses: Hypothesis[] = []): ModelReply {
  return { status: 'ok', provider: 'mode-fixture', model: 'local', inputTokens: 100, outputTokens: 50, proposal: proposal(packet, tasks, hypotheses) };
}
class LocalPlanner implements Planner {
  readonly identity = { provider: 'mode-fixture', model: 'local', revision: '1' };
  readonly destination = 'local';
  readonly capabilities = { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 1000000 };
  readonly calls: { packet: ContextPacket; signal: AbortSignal }[] = [];
  handler: (packet: ContextPacket, signal: AbortSignal) => Promise<ModelReply> = async () => { throw new Error('unexpected_fixture_model'); };
  estimateInput(packet: ContextPacket, options: ModelCallOptions) {
    const bytes = new TextEncoder().encode(JSON.stringify({ packet, options })).byteLength;
    return { tokens: bytes, bytes, method: 'fixture_utf8_estimate' };
  }
  async propose(packet: ContextPacket, signal: AbortSignal) {
    this.calls.push({ packet: structuredClone(packet), signal }); return this.handler(packet, signal);
  }
}
async function setup(t: TestContext, adapter: Adapter, options: { family?: string; mode?: Mode; holdCompletion?: boolean; reuse?: boolean;
  limits?: Partial<Limits>; collection?: ReadCollectionBinding; legacy?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'secumon-execution-modes-')); let repository = openRepository(adapter, directory);
  t.after(async () => { await repository.close(); await rm(directory, { recursive: true, force: true }); });
  const scenario = validateScenario(JSON.parse(readFileSync(new URL(`../../fixtures/${options.family ?? 'documents-simple'}.json`, import.meta.url), 'utf8')));
  const clock = new FakeClock(1788566400000); const planner = new LocalPlanner(); const fixture = new FixtureReadTool(scenario.evidence);
  const tool: Tool = { definition: { ...fixture.definition, ...(options.reuse ? { reuse: { mode: 'immutable' as const, sourceVersion: 'fixture-1' } } : {}) },
    execute: (selected, context) => fixture.execute(selected, context) };
  const artifacts = new FileArtifactStore(join(directory, 'artifacts')); const sink = new FakeSink();
  const initial = newWork({ id: workId, now: clock.now(), goal: { ...scenario.goal, mode: options.mode ?? 'auto',
    criteria: [...scenario.goal.criteria, ...(options.holdCompletion ? [{ id: 'later', description: 'A later independent confirmation is still required',
      key: 'later.confirmed', operator: 'present' as const, equals: null, minIndependentSources: 1, requireCompleteCoverage: true }] : [])] },
    policy: { ...scenario.policy, allowedTools: [...scenario.policy.allowedTools, ...(options.collection ? [options.collection.definition.id] : [])] },
    limits: { toolCalls: 20, modelCalls: 10, tokens: 1000000, replans: 10, wallTimeMs: 1000000, ...options.limits } });
  if (options.legacy) delete initial.executionControl;
  assert.equal((await repository.commit(command(initial, 'accepted'))).kind, 'committed');
  const compose = () => composeRuntime({ services: { state: repository, artifacts, planner, tools: [tool], clock, sink, ids: new RandomIds(), digester: new Sha256Digester() },
    schemas: new AjvSchemas(), guidanceSource: { list: async () => [], read: async () => { throw new Error('unused_guidance'); } }, owner: 'mode-executor',
    ...(options.collection ? { collectionTools: [options.collection] } : {}) });
  let current = await compose();
  const state = () => current.runtime.state(workId);
  const submit = async (tasks: TaskSpec[], hypotheses: Hypothesis[] = []) => {
    const value = await state(); return current.runtime.submitPlan(workId, `plan-${value.revision}`,
      proposal({ stateRevision: value.revision, goal: value.goal, plan: value.plan }, tasks, hypotheses));
  };
  const runTask = async (id: string) => {
    const reserved = await current.runtime.reserve(workId, id); await current.runtime.execute(workId, reserved.id);
    await current.runtime.settlePending(reserved.id); await current.runtime.adopt(workId, reserved.id);
    return (await state()).attempts.find(value => value.id === reserved.id)!;
  };
  const mode = async (selected: Mode, id?: string) => {
    const value = await state(); return current.runtime.command(workId, id ?? `mode-${value.revision}`, actor, value.goal.revision,
      { kind: 'mode', mode: selected, reason: `Requested ${selected}`, expectedControlRevision: executionControl(value).revision });
  };
  return { c: () => current, state, submit, runTask, mode, planner, fixture, tool, artifacts, clock, scenario, initial,
    reopen: async () => { await repository.close(); repository = openRepository(adapter, directory); current = await compose(); } };
}
type Harness = Awaited<ReturnType<typeof setup>>;
function interceptCommit(f: Harness, matches: (request: CommitRequest) => boolean, before: () => Promise<void>): () => boolean {
  const repository = f.c().services.state; let entered = false;
  f.c().services.state = new Proxy(repository, { get(target, key) {
    if (key === 'commit') return async (request: CommitRequest) => {
      if (!entered && matches(request)) { entered = true; await before(); }
      return target.commit(request);
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return () => entered;
}

for (const adapter of adapters) {
  for (const [family, source] of simpleFamilies) for (const mode of ['auto', 'fast', 'deep'] as const) {
    test(`${adapter}/${family}/${mode}: one necessary plan and observation complete with no extra investigation`, async t => {
      const f = await setup(t, adapter, { family, mode }); f.planner.handler = async packet => reply(packet, [task('read', source)]);
      const result = await f.c().workflow.run(workId, actor); const state = await f.state();
      assert.equal(result.control.kind, 'complete'); assert.equal(state.status, 'completed');
      assert.equal(f.planner.calls.length, 1); assert.equal(f.fixture.invocations.length, 1);
      assert.equal(state.budget.used.modelCalls, 1); assert.equal(state.budget.used.toolCalls, 1); assert.equal(state.budget.used.tokens, 150);
      assert.equal(state.budget.reservedTokens, 0); assert.equal(state.budget.reservedModelCalls, 0); assert.equal(state.budget.reservedToolCalls, 0);
      assert.equal(executionControl(state).requestedMode, mode); assert.deepEqual(state.hypotheses, []);
      await f.reopen(); assert.equal((await f.c().workflow.run(workId, actor, { previousPacket: result.checkpoint })).control.kind, 'complete');
      assert.equal(f.planner.calls.length, 1); assert.equal(f.fixture.invocations.length, 1);
    });
  }

  for (const [family, sources] of complexFamilies) for (const mode of ['auto', 'fast', 'deep'] as const) {
    test(`${adapter}/${family}/${mode}: complex scope is either validated for investigation or rejected without false completion`, async t => {
      const f = await setup(t, adapter, { family, mode }); const tasks = sources.map((source, index) => task(`read-${index}`, source, index ? [`read-${index - 1}`] : []));
      f.planner.handler = async packet => reply(packet, tasks);
      if (mode === 'fast') {
        const call = await f.c().planning!.reserve(workId); await f.c().planning!.execute(workId, call.id);
        assert.equal(await f.c().planning!.adopt(workId, call.id), false);
        const state = await f.state(); assert.equal(state.modelCalls[0]!.reason, 'fast_scope_exceeded');
        assert.equal(state.plan, null); assert.equal(executionControl(state).strategy, 'direct');
        assert.equal((await f.c().conversation.snapshot(workId, actor)).analysisReady, false); assert.equal(f.fixture.invocations.length, 0);
      } else {
        const result = await f.c().workflow.run(workId, actor); const state = await f.state();
        assert.equal(result.control.kind, 'complete'); assert.equal(executionControl(state).strategy, 'investigate');
        assert.equal(f.planner.calls.length, 1); assert.equal(f.fixture.invocations.length, sources.length);
        assert.equal(state.budget.used.toolCalls, sources.length); assert.equal(state.goal.mode, mode);
      }
    });
  }

  test(`${adapter}: mode commands enforce owner and both revisions, remain idempotent, and preserve goal and costs`, async t => {
    const f = await setup(t, adapter, { mode: 'deep' }); const initial = await f.state();
    const input = { kind: 'mode' as const, mode: 'fast' as const, reason: 'Shorten remaining optional work', expectedControlRevision: 1 };
    await assert.rejects(f.c().runtime.command(workId, 'wrong-owner', { ...actor, principalId: 'other' }, 1, input), /actor_not_authorized/);
    await assert.rejects(f.c().runtime.command(workId, 'wrong-goal', actor, 2, input), /stale_user_command/);
    await assert.rejects(f.c().runtime.command(workId, 'wrong-control', actor, 1, { ...input, expectedControlRevision: 2 }), /stale_execution_control/);
    assert.equal((await f.state()).revision, initial.revision);
    await f.c().runtime.command(workId, 'shorten', actor, 1, input); const changed = await f.state();
    await f.c().runtime.command(workId, 'shorten', actor, 1, input); assert.deepEqual(await f.state(), changed);
    await assert.rejects(f.c().runtime.command(workId, 'stale-mode', actor, 1, input), /stale_execution_control/);
    await f.reopen(); await f.mode('auto'); const restored = await f.state();
    assert.deepEqual(restored.goal, initial.goal); assert.deepEqual(restored.budget, initial.budget); assert.equal(restored.deadlineAt, initial.deadlineAt);
    assert.equal(executionControl(restored).requestedMode, 'auto'); assert.equal(executionControl(restored).revision, 3);
  });

  test(`${adapter}: lowering to fast after two paid reads cannot reset usage or oversubscribe the next reservation`, async t => {
    const f = await setup(t, adapter, { mode: 'deep', holdCompletion: true });
    const tasks = ['first', 'second', 'third'].map((id, index) => task(id, 'doc-current', index ? [['first', 'second'][index - 1]!] : []));
    await f.submit(tasks); await f.runTask('first'); const second = await f.c().runtime.reserve(workId, 'second');
    let state = await f.state(); assert.equal(state.budget.used.toolCalls, 1); assert.equal(state.budget.reservedToolCalls, 1);
    await assert.rejects(f.c().runtime.reserve(workId, 'third'), /task_not_ready/); assert.equal((await f.state()).budget.reservedToolCalls, 1);
    await f.c().runtime.execute(workId, second.id); await f.c().runtime.adopt(workId, second.id); const before = await f.state();
    await f.mode('fast'); await f.reopen();
    await assert.rejects(f.c().runtime.reserve(workId, 'third'), /task_not_ready|fast_/); state = await f.state();
    assert.deepEqual(state.goal, before.goal); assert.deepEqual(state.budget.used, before.budget.used);
    assert.equal(state.budget.used.toolCalls, 2); assert.equal(effectiveExecutionLimits(state).toolCalls, 2); assert.equal(state.budget.reservedToolCalls, 0);
    assert.equal(f.fixture.invocations.length, 2); assert.notEqual(state.status, 'completed');
  });

  test(`${adapter}: explicit model cap and fast cap include reservations and do not reopen paid capacity`, async t => {
    for (const cap of [1, 5]) {
      const f = await setup(t, adapter, { mode: 'fast', limits: { modelCalls: cap } });
      f.planner.handler = async () => ({ status: 'error', code: 'synthetic_unavailable', inputTokens: 100, outputTokens: 10 });
      const maximum = Math.min(cap, 2);
      for (let index = 0; index < maximum; index++) {
        const call = await f.c().planning!.reserve(workId); const held = await f.state();
        assert.equal(held.budget.used.modelCalls, index); assert.equal(held.budget.reservedModelCalls, 1);
        await assert.rejects(f.c().planning!.reserve(workId), /model_not_needed/);
        await f.c().planning!.execute(workId, call.id); assert.equal(await f.c().planning!.adopt(workId, call.id), false);
        f.clock.advance(200);
      }
      await f.reopen(); await assert.rejects(f.c().planning!.reserve(workId), /model_budget_exhausted/);
      const state = await f.state(); assert.equal(state.budget.used.modelCalls, maximum); assert.equal(state.budget.used.tokens, maximum * 110);
      assert.equal(state.budget.reservedModelCalls, 0); assert.equal(state.budget.reservedTokens, 0); assert.equal(f.planner.calls.length, maximum);
    }
  });

  test(`${adapter}: a running model keeps its pending mode request and late reply accounting until the next safe boundary`, { timeout: 8000 }, async t => {
    const f = await setup(t, adapter, { mode: 'deep' }); const entered = gate<void>(); const released = gate<void>();
    f.planner.handler = async packet => { entered.resolve(); await released.promise; return reply(packet, [task('read', 'doc-current')]); };
    const call = await f.c().planning!.reserve(workId); const running = f.c().planning!.execute(workId, call.id); await entered.promise;
    try {
      const before = await f.state(); await f.mode('fast'); const pending = await f.state();
      assert.deepEqual(pending.goal, before.goal); assert.equal(executionControl(pending).requestedMode, 'deep');
      assert.equal(executionControl(pending).pending?.mode, 'fast'); assert.equal(f.planner.calls[0]!.signal.aborted, false);
    } finally { released.resolve(); }
    await running; assert.equal(await f.c().planning!.adopt(workId, call.id), true);
    assert.equal((await f.state()).budget.used.tokens, 150); assert.equal(executionControl(await f.state()).requestedMode, 'deep');
    await prepareExecutionBoundary(f.c().services, workId); const applied = await f.state();
    assert.equal(executionControl(applied).requestedMode, 'fast'); assert.equal(executionControl(applied).pending, null);
    assert.equal(applied.goal.mode, 'deep'); assert.equal(applied.modelCalls[0]!.status, 'accepted');
    assert.equal((await f.c().workflow.run(workId, actor)).control.kind, 'complete'); assert.equal(f.planner.calls.length, 1);
  });

  test(`${adapter}: a pending mode survives reserved model restart without invalidating its stored input`, async t => {
    const f = await setup(t, adapter, { mode: 'deep' }); f.planner.handler = async packet => reply(packet, [task('read', 'doc-current')]);
    const call = await f.c().planning!.reserve(workId); await f.mode('fast'); const checkpoint = await f.c().recovery.restore(workId, actor);
    const before = await f.state(); await f.reopen();
    assert.equal(executionControl(await f.state()).pending?.mode, 'fast'); assert.deepEqual((await f.state()).modelCalls[0]!.inputArtifact, call.inputArtifact);
    const result = await f.c().workflow.run(workId, actor, { previousPacket: checkpoint.artifact });
    assert.equal(result.control.kind, 'complete'); const state = await f.state();
    assert.deepEqual(state.goal, before.goal); assert.equal(executionControl(state).requestedMode, 'fast');
    assert.equal(f.planner.calls.length, 1); assert.equal(f.fixture.invocations.length, 1); assert.equal(state.budget.used.tokens, 150);
  });

  test(`${adapter}: cancel overrides a pending mode without discarding late measured model costs`, { timeout: 8000 }, async t => {
    const f = await setup(t, adapter, { mode: 'deep' }); const entered = gate<void>(); const released = gate<void>();
    f.planner.handler = async packet => { entered.resolve(); await released.promise; return reply(packet, [task('read', 'doc-current')]); };
    const call = await f.c().planning!.reserve(workId); const running = f.c().planning!.execute(workId, call.id); await entered.promise;
    try { await f.mode('fast'); await f.c().runtime.command(workId, 'cancel', actor, 1, { kind: 'cancel', reason: 'Stop this request' }); }
    finally { released.resolve(); }
    await running; await f.c().planning!.settlePending(); assert.equal(await f.c().planning!.adopt(workId, call.id), false);
    const state = await f.state(); assert.equal(state.status, 'cancelled'); assert.equal(state.plan, null);
    assert.equal(state.budget.used.tokens, 150); assert.equal(state.budget.reservedTokens, 0); assert.equal(state.budget.used.unmeasuredModelCalls, 0);
    assert.equal(f.planner.calls[0]!.signal.aborted, true); assert.equal(f.fixture.invocations.length, 0);
    await prepareExecutionBoundary(f.c().services, workId); assert.equal((await f.state()).status, 'cancelled');
  });

  test(`${adapter}: deep to fast retains original goal, completed tasks, checkpoint and result reuse after reopen`, async t => {
    const f = await setup(t, adapter, { mode: 'deep', holdCompletion: true, reuse: true });
    await f.submit([task('first', 'doc-current'), task('second', 'doc-current', ['first'])]); const first = await f.runTask('first');
    const checkpoint = await f.c().recovery.restore(workId, actor); const before = await f.state();
    await f.mode('fast'); await f.reopen(); const restored = await f.c().recovery.restore(workId, actor, checkpoint.artifact);
    assert.equal(restored.disposition, 'regenerated'); const second = await f.runTask('second'); const state = await f.state();
    assert.deepEqual(state.goal, before.goal); assert.equal(state.plan!.revision, before.plan!.revision); assert.equal(first.goalRevision, second.goalRevision);
    assert.equal(second.reuse?.attemptId, first.id); assert.equal(second.execution?.mode, 'reused'); assert.equal(f.fixture.invocations.length, 1);
    assert.deepEqual(state.evidence, before.evidence); assert.equal(state.budget.used.toolCalls, 2); assert.equal(state.budget.used.replans, 0);
  });

  test(`${adapter}: fast keeps mandatory review of existing hypotheses and cannot replace it with premature completion`, async t => {
    const f = await setup(t, adapter, { mode: 'deep' });
    const existing: Hypothesis = { id: 'existing', question: 'Is the current policy available?', claim: 'The current source establishes the policy',
      predictedObservation: 'Read the current document', falsifier: 'The current source contradicts the document', status: 'open', supportIds: [], counterIds: [], reason: 'Read the original first' };
    const selected = task('read', 'doc-current'); await f.submit([selected], [existing]); await f.runTask(selected.id); await f.mode('fast');
    let state = await f.state(); assert.equal(hypothesesRequireReview(state), true); assert.equal(state.hypotheses.length, 1);
    assert.equal((await f.c().conversation.snapshot(workId, actor)).analysisReady, false);
    f.planner.handler = async packet => reply(packet, [selected], [{ ...existing, status: 'supported', supportIds: ['doc-current'], reason: 'The current original supports the claim' }]);
    const outcome = await f.c().workflow.run(workId, actor); state = await f.state();
    assert.equal(outcome.control.kind, 'complete'); assert.equal(state.hypotheses[0]!.status, 'supported'); assert.deepEqual(state.hypotheses[0]!.supportIds, ['doc-current']);
    assert.equal(hypothesesRequireReview(state), false); assert.equal(state.budget.used.replans, 0); assert.equal(f.planner.calls.length, 1); assert.equal(f.fixture.invocations.length, 1);
  });

  test(`${adapter}: legacy model reservations keep their version-one basis when a pending mode first materializes control`, async t => {
    const f = await setup(t, adapter, { mode: 'deep', legacy: true }); f.planner.handler = async packet => reply(packet, [task('read', 'doc-current')]);
    const reserved = await f.c().planning!.reserve(workId); const current = await f.state();
    const input = JSON.parse(new TextDecoder().decode(await f.artifacts.get(reserved.inputArtifact, current.policy))) as { packet: ContextPacket; options: ModelCallOptions };
    if (input.packet.execution) { delete input.packet.execution.control; delete input.packet.execution.progress; }
    const inputArtifact = await f.artifacts.put(new TextEncoder().encode(JSON.stringify(input)), { tenantId: current.policy.tenantId, labels: current.policy.allowedLabels, mediaType: 'application/json' });
    await transact(f.c().services, workId, 'legacy-model-basis', 'fixture_legacy_model', {}, state => {
      const call = state.modelCalls.find(value => value.id === reserved.id)!; delete call.semanticVersion; call.inputArtifact = inputArtifact;
      call.semanticDigest = f.c().services.digester.digest(asJson({ goal: state.goal, policy: state.policy, plan: state.plan, attempts: state.attempts,
        evidence: state.evidence, hypotheses: state.hypotheses, hypothesisAssessment: state.hypothesisAssessment,
        obligations: state.obligations, dataGeneration: dataGeneration(state) }));
    });
    assert.equal((await f.state()).executionControl, undefined); await f.mode('fast'); await f.reopen();
    assert.equal(executionControl(await f.state()).pending?.mode, 'fast');
    await f.c().planning!.execute(workId, reserved.id); assert.equal(await f.c().planning!.adopt(workId, reserved.id), true);
    await prepareExecutionBoundary(f.c().services, workId); const state = await f.state();
    assert.equal(executionControl(state).requestedMode, 'fast'); assert.equal(state.goal.mode, 'deep');
    assert.equal(state.budget.used.tokens, 150); assert.equal(f.planner.calls.length, 1);
  });

  for (const change of ['mode', 'cancel'] as const) test(`${adapter}: a newer ${change} wins a pending-mode boundary CAS race`, async t => {
    const f = await setup(t, adapter, { mode: 'deep', holdCompletion: true }); await f.submit([task('first', 'doc-current')]);
    const reserved = await f.c().runtime.reserve(workId, 'first'); await f.mode('fast');
    await f.c().runtime.execute(workId, reserved.id); await f.c().runtime.adopt(workId, reserved.id);
    const before = await f.state(); assert.equal(executionControl(before).pending?.mode, 'fast');
    const intercepted = interceptCommit(f, request => request.commandId.startsWith('execution-boundary:'), async () => {
      if (change === 'mode') await f.mode('auto');
      else await f.c().runtime.command(workId, 'cancel-at-boundary', actor, 1, { kind: 'cancel', reason: 'Stop before next allocation' });
    });
    const latest = await prepareExecutionBoundary(f.c().services, workId); assert.equal(intercepted(), true);
    assert.equal(executionControl(latest).requestedMode, change === 'mode' ? 'auto' : 'deep');
    assert.equal(latest.status, change === 'mode' ? 'ready' : 'cancelled'); assert.deepEqual(latest.goal, before.goal);
    assert.deepEqual(latest.budget.used, before.budget.used); assert.equal(f.planner.calls.length, 0); assert.equal(f.fixture.invocations.length, 1);
  });

  test(`${adapter}: cancellation during model backoff publication returns current control without failing the workflow`, async t => {
    const f = await setup(t, adapter, { mode: 'deep' });
    f.planner.handler = async () => ({ status: 'error', code: 'synthetic_failure', inputTokens: 10, outputTokens: 2 });
    const call = await f.c().planning!.reserve(workId); await f.c().planning!.execute(workId, call.id); await f.c().planning!.adopt(workId, call.id);
    const intercepted = interceptCommit(f, request => request.commandId.startsWith('model-progress-gate:'), async () => {
      await f.c().runtime.command(workId, 'cancel-at-backoff', actor, 1, { kind: 'cancel', reason: 'Cancel before retry scheduling' });
    });
    const outcome = await f.c().planning!.step(workId); assert.equal(intercepted(), true); assert.equal(outcome.kind, 'cancelled');
    const state = await f.state(); assert.equal(state.status, 'cancelled'); assert.equal(state.budget.used.tokens, 12);
    assert.equal(state.budget.used.modelCalls, 1); assert.equal(f.planner.calls.length, 1); assert.equal(f.fixture.invocations.length, 0);
  });

  test(`${adapter}: auto mode change and reopen preserve a partial collection's original goal and explicit resume chain`, async t => {
    let failNext = true; const fetched: (string | null)[] = [];
    const binding: ReadCollectionBinding = { definition: { provider: 'fixture', id: 'fixture.collection', version: '1', description: 'Read two synthetic pages',
      effect: 'read', destination: 'local', labels: ['synthetic'], inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object' },
      collection: { kind: 'paged', limits: { maxPages: 4, maxItems: 4, maxCalls: 5, maxPageBytes: 65536, maxCheckpointBytes: 1048576, pageSize: 1 } } },
      source: { async fetch(_task, request) {
        fetched.push(request.cursor); if (request.cursor !== null && failNext) { failNext = false; throw new Error('synthetic_page_unavailable'); }
        const id = request.cursor === null ? 'first' : 'second';
        return { requestId: request.requestId, sourceSnapshot: 'synthetic-v1', cursor: request.cursor, nextCursor: id === 'first' ? 'next' : null,
          exhausted: id === 'second', totalItems: 2, expected: [{ id, inputDigest: sha256(id) }],
          items: [{ id, inputDigest: sha256(id), status: 'success', output: { page: id }, evidence: [], artifacts: [], coverage: 'complete', error: null }],
          usage: { transportCalls: 1, internalOperations: 0, imageBytes: 0, waitMs: 0 } };
      } } };
    const f = await setup(t, adapter, { mode: 'deep', holdCompletion: true, collection: binding });
    const firstTask: TaskSpec = { id: 'collection-first', description: 'Collect synthetic pages', toolId: 'fixture.collection', toolVersion: '1', input: {}, effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: [] };
    await f.submit([firstTask]); const first = await f.runTask(firstTask.id); assert.equal(first.status, 'partial'); assert.equal(first.readProgress!.phase, 'partial');
    const proof = await f.c().readCheckpoints.read(await f.state(), first.id); const checkpoint = await f.c().recovery.restore(workId, actor);
    const originalGoal = structuredClone((await f.state()).goal); await f.mode('auto'); await f.reopen();
    await f.c().recovery.restore(workId, actor, checkpoint.artifact);
    const same = await f.c().readCheckpoints.read(await f.state(), first.id); assert.deepEqual(same.goal, proof.goal);
    const resumed: TaskSpec = { ...firstTask, id: 'collection-resume', readResume: { attemptId: first.id, checkpointId: first.readProgress!.head.id } };
    await f.submit([resumed]); const second = await f.runTask(resumed.id); const state = await f.state();
    assert.equal(second.readProgress!.phase, 'complete'); assert.equal(second.adopted, true);
    assert.deepEqual(state.goal, originalGoal); assert.equal(executionControl(state).requestedMode, 'auto');
    assert.equal(second.readProgress!.operationId, first.readProgress!.operationId); assert.deepEqual(fetched, [null, 'next', 'next']);
    assert.equal(state.attempts.find(value => value.id === first.id)!.readProgress!.successorAttemptId, second.id);
  });
}
