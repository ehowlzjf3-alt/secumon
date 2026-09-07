import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { decideExecution } from '../application/execution-decision.js';
import { progressGate } from '../application/work-progress.js';
import type { ComputerReconciliation } from '../domain/computer-reconciliation.js';
import type { ComputerResume } from '../domain/computer-continuation.js';
import { evaluateCompletion } from '../domain/completion.js';
import type { Attempt, TaskSpec } from '../domain/model.js';
import { SyntheticComputerDriver } from '../infrastructure/synthetic-computer-driver.js';
import { computerActor, computerActInput, computerHarness, computerResult, observeComputer, saveNoteSteps, submitComputerTask,
  type ComputerBackend, type ComputerHarness } from './computer-use-helpers.js';

async function plan(h: ComputerHarness, kind: 'continue' | 'verify', input: ComputerResume) {
  const state = await h.runtime.state(h.workId);
  const task: TaskSpec = { id: `${kind}-${state.revision}`, toolId: `synthetic.ui.${kind}`, toolVersion: '1',
    description: `Explicit ${kind} after source validation`, input: {}, computerResume: input, dependsOn: [],
    effect: kind === 'continue' ? 'write' : 'read', maxAttempts: 1, satisfies: ['saved'] };
  await h.runtime.submitPlan(h.workId, `plan-${task.id}`, { baseStateRevision: state.revision, baseGoalRevision: state.goal.revision,
    basePlanRevision: state.plan?.revision ?? 0, reason: 'Validate the original effect before allocating a successor', tasks: [task], hypotheses: [] });
  return task;
}

async function run(h: ComputerHarness, attempt: Attempt) {
  await h.runtime.execute(h.workId, attempt.id); await h.runtime.settlePending(attempt.id); await h.runtime.adopt(h.workId, attempt.id);
  return (await h.runtime.state(h.workId)).attempts.find(value => value.id === attempt.id)!;
}

async function fixture(t: TestContext, backend: ComputerBackend) {
  const unavailable = new Set<string>();
  const h = await computerHarness(backend, { continuations: true, leaseMs: 60000, artifacts: store => ({
    put: (...args) => store.put(...args), exists: ref => store.exists(ref),
    get: async (ref, policy) => {
      if (unavailable.has(ref.id)) throw new Error('synthetic_proof_read_unavailable');
      return store.get(ref, policy);
    },
  }) });
  t.after(() => h.close()); assert.ok(h.driver instanceof SyntheticComputerDriver); const driver = h.driver;
  driver.injectNextAction({}); driver.injectNextAction({ outcome: 'not_applied_timeout' });
  const observation = await observeComputer(h);
  const parent = await run(h, await submitComputerTask(h, 'act', computerActInput(observation.observationId, saveNoteSteps)));
  assert.equal(parent.status, 'partial'); assert.equal(parent.effectState, 'confirmed'); assert.ok(parent.computerUse);
  const task = await plan(h, 'continue', { attemptId: parent.id, checkpointId: parent.computerUse.head.id, reconciliation: null });
  driver.injectNextAction({ outcome: 'applied_unknown' });
  const child = await run(h, await h.runtime.reserve(h.workId, task.id));
  const before = await h.runtime.state(h.workId); assert.equal(child.status, 'unknown'); assert.equal(child.adopted, false);
  assert.ok(child.computerUse); assert.deepEqual(before.evidence, []); assert.ok(before.progress);
  assert.equal(before.progress.consecutiveUnproductive, before.progress.policy.maxUnproductiveSteps);
  assert.deepEqual(progressGate(before, h.clock.now()), { kind: 'blocked', reason: 'no_progress_limit' });
  assert.equal(driver.snapshot().inputCount, 2); assert.equal(driver.snapshot().saveCount, 1);
  return { h, driver, unavailable, before, parent, child, input: { attemptId: child.id, checkpointId: child.computerUse.head.id } };
}

async function assertNoCompletion(f: Awaited<ReturnType<typeof fixture>>) {
  const state = await f.h.runtime.state(f.h.workId);
  assert.deepEqual(state.evidence, []); assert.equal(evaluateCompletion(state.goal, state.evidence, state.obligations, state.policy).complete, false);
  assert.deepEqual(state.attempts.find(value => value.id === f.parent.id), f.parent);
  assert.deepEqual(state.attempts.find(value => value.id === f.child.id), f.child);
  assert.equal(state.modelCalls.length, 0); assert.equal(f.driver.snapshot().inputCount, 2); assert.equal(f.driver.snapshot().saveCount, 1);
  return state;
}

async function settle(f: Awaited<ReturnType<typeof fixture>>, commandId = 'first-effect-settlement'): Promise<ComputerReconciliation> {
  const record = await f.h.computerReconciliations.reconcile(f.h.workId, commandId, computerActor, f.input);
  assert.equal(record.status, 'settled'); assert.equal(record.outcome, 'applied'); assert.ok(record.proofArtifact); return record;
}

for (const backend of ['sqlite', 'file-journal'] as const) {
  test(`${backend}: first verified effect settlement clears the no-progress gate and permits a read-only verification without creating evidence itself`, async t => {
    const f = await fixture(t, backend); const proof = await settle(f); const state = await assertNoCompletion(f);
    assert.equal(state.progress!.productiveSteps, f.before.progress!.productiveSteps + 1);
    assert.equal(state.progress!.consecutiveUnproductive, 0); assert.equal(progressGate(state, f.h.clock.now()), null);
    assert.equal(state.obligations.find(value => value.id === proof.obligationId)!.status, 'satisfied');
    assert.equal(await f.h.computerReconciliations.proofsCurrent(state), true); assert.equal(await f.h.computerContinuations.current(state), true);
    const task = await plan(f.h, 'verify', { ...f.input, reconciliation: { id: proof.id, proofId: proof.proofArtifact!.id } });
    const ready = await f.h.runtime.state(f.h.workId);
    assert.deepEqual(decideExecution(ready, f.h.clock.now(), f.h.services.digester), { kind: 'continue', action: 'reserve', id: task.id, reason: 'task_ready' });
    const attempt = await run(f.h, await f.h.runtime.reserve(f.h.workId, task.id)); const result = await computerResult(f.h, attempt.id);
    assert.equal(result.status, 'success'); assert.equal(result.effectState, 'none'); assert.equal(attempt.adopted, true);
    assert.equal((await f.h.runtime.step(f.h.workId)).kind, 'complete');
    assert.equal(f.driver.snapshot().inputCount, 2); assert.equal(f.driver.snapshot().saveCount, 1);
  });

  test(`${backend}: duplicate settle and replay of the same reconciliation command add no progress, lookup or budget use`, async t => {
    const f = await fixture(t, backend); const proof = await settle(f); const state = await assertNoCompletion(f); const driver = f.driver.snapshot();
    for (let n = 0; n < 3; n++) assert.deepEqual(await f.h.computerReconciliations.settle(f.h.workId, proof.id, computerActor), proof);
    assert.deepEqual(await f.h.computerReconciliations.reconcile(f.h.workId, 'first-effect-settlement', computerActor, f.input), proof);
    assert.deepEqual(await f.h.runtime.state(f.h.workId), state); assert.deepEqual(f.driver.snapshot(), driver);
    assert.equal(state.progress!.processed.filter(value => value === `reconcile-settle:${proof.id}`).length, 1);
    await assertNoCompletion(f);
  });

  test(`${backend}: re-proving the same source operation after proof-read invalidation cannot earn a second progress credit`, async t => {
    const f = await fixture(t, backend); const first = await settle(f); const initial = await assertNoCompletion(f);
    // Preserve durable bytes while injecting an unavailable proof read, so ordinary invalidation and re-proving can run.
    f.unavailable.add(first.proofArtifact!.id);
    const invalidated = await f.h.computerReconciliations.refresh(f.h.workId);
    assert.equal(invalidated.computerReconciliations!.find(value => value.id === first.id)!.status, 'failed');
    assert.equal(invalidated.obligations.find(value => value.id === first.obligationId)!.status, 'pending');
    assert.deepEqual(invalidated.progress, initial.progress);
    const second = await settle(f, 'same-effect-new-proof'); const restored = await assertNoCompletion(f);
    assert.notEqual(second.id, first.id); assert.notEqual(second.proofArtifact!.id, first.proofArtifact!.id);
    assert.equal(second.sourceAttemptId, first.sourceAttemptId); assert.equal(second.operationId, first.operationId); assert.equal(second.outcome, first.outcome);
    assert.equal(await f.h.computerReconciliations.proofsCurrent(restored), true);
    assert.equal(restored.progress!.productiveSteps, initial.progress!.productiveSteps);
    assert.deepEqual(restored.progress!.knownKeys, initial.progress!.knownKeys);
    assert.equal(restored.progress!.unproductiveSteps, initial.progress!.unproductiveSteps + 1);
    assert.equal(restored.progress!.consecutiveUnproductive, 1);
    assert.equal(restored.progress!.knownKeys.filter(key => key.startsWith('computer-effect:')).length, 1);
    const snapshot = f.driver.snapshot(); await f.h.computerReconciliations.settle(f.h.workId, second.id, computerActor);
    assert.deepEqual(await f.h.runtime.state(f.h.workId), restored); assert.deepEqual(f.driver.snapshot(), snapshot);
  });
}
