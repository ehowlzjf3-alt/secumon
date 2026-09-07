import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { ComputerDriver } from '../application/computer-use-ports.js';
import type { Attempt, TaskSpec } from '../domain/model.js';
import type { ComputerCheckpointV2, ComputerStep } from '../domain/computer-use.js';
import type { ComputerResume } from '../domain/computer-continuation.js';
import { SyntheticComputerClock, SyntheticComputerDriver } from '../infrastructure/synthetic-computer-driver.js';
import { computerActor, computerActInput, computerHarness, computerResult, observeComputer, saveNoteSteps, submitComputerTask,
  type ComputerBackend, type ComputerHarness } from './computer-use-helpers.js';

// These exercise the real runtime, artifact proofs and synthetic driver. They do not control an OS or a browser.
// Logical input deadlines stay at 5000ms; the execution watchdog leaves headroom for parallel disk-heavy proof checks.
const backends: ComputerBackend[] = ['sqlite', 'file-journal'];
async function harness(t: TestContext, backend: ComputerBackend, options: Parameters<typeof computerHarness>[1] = {}) {
  const h = await computerHarness(backend, { ...options, continuations: true, leaseMs: 60000 }); t.after(() => h.close()); return h;
}
function driver(h: ComputerHarness): SyntheticComputerDriver { assert.ok(h.driver instanceof SyntheticComputerDriver); return h.driver; }
function automaticWaits(source: SyntheticComputerDriver, clock: SyntheticComputerClock): ComputerDriver {
  return { identity: source.identity, acquire: source.acquire.bind(source), release: source.release.bind(source),
    observe: source.observe.bind(source), act: source.act.bind(source), lookup: source.lookup.bind(source),
    async wait(lease, request, signal) { const pending = source.wait(lease, request, signal); clock.advance(request.maxWaitMs); return pending; } };
}
async function checkpoint(h: ComputerHarness, attemptId: string): Promise<ComputerCheckpointV2> {
  const inspected = await h.computerUse.inspect(h.workId, computerActor, attemptId);
  assert.equal(inspected.checkpoint.schemaVersion, 2); assert.ok(inspected.checkpoint.schemaVersion === 2); return inspected.checkpoint;
}
async function run(h: ComputerHarness, attempt: Attempt) {
  await h.runtime.execute(h.workId, attempt.id); await h.runtime.settlePending(attempt.id);
  const result = await computerResult(h, attempt.id); await h.runtime.adopt(h.workId, attempt.id);
  return { attempt: (await h.state.get(h.workId))!.attempts.find(value => value.id === attempt.id)!, result, checkpoint: await checkpoint(h, attempt.id) };
}
async function parent(h: ComputerHarness, steps: ComputerStep[] = saveNoteSteps, timeoutMs = 5000) {
  const observed = await observeComputer(h);
  const source = await run(h, await submitComputerTask(h, 'act', computerActInput(observed.observationId, steps, timeoutMs)));
  assert.ok(source.attempt.computerUse); assert.ok(source.attempt.resultArtifact);
  const state = (await h.state.get(h.workId))!;
  return { ...source, headBytes: await h.artifacts.get(source.attempt.computerUse.head, state.policy),
    resultBytes: await h.artifacts.get(source.attempt.resultArtifact, state.policy) };
}
async function resume(h: ComputerHarness, source: Awaited<ReturnType<typeof parent>>): Promise<ComputerResume> {
  const input = { attemptId: source.attempt.id, checkpointId: source.attempt.computerUse!.head.id };
  if (source.result.effectState !== 'unknown') return { ...input, reconciliation: null };
  const record = await h.computerReconciliations.reconcile(h.workId, `reconcile-${source.attempt.id}`, computerActor, input);
  assert.equal(record.status, 'settled'); assert.ok(record.proofArtifact);
  assert.equal((await h.state.get(h.workId))!.obligations.find(value => value.id === record.obligationId)!.status, 'satisfied');
  return { ...input, reconciliation: { id: record.id, proofId: record.proofArtifact.id } };
}
async function plan(h: ComputerHarness, kind: 'continue' | 'verify', input: ComputerResume): Promise<TaskSpec> {
  const state = (await h.state.get(h.workId))!;
  const task: TaskSpec = { id: `continuation-task-${state.revision}`, toolId: `synthetic.ui.${kind}`, toolVersion: '1',
    description: `Explicit synthetic ${kind}`, input: {}, computerResume: input, dependsOn: [], effect: kind === 'continue' ? 'write' : 'read',
    maxAttempts: 1, satisfies: ['saved'] };
  await h.runtime.submitPlan(h.workId, `continuation-plan-${state.revision}`, { baseStateRevision: state.revision, baseGoalRevision: state.goal.revision,
    basePlanRevision: state.plan?.revision ?? 0, reason: 'Explicitly continue only the original remaining typed steps', tasks: [task], hypotheses: [] });
  return task;
}
async function successor(h: ComputerHarness, kind: 'continue' | 'verify', input: ComputerResume) {
  const task = await plan(h, kind, input); return run(h, await h.runtime.reserve(h.workId, task.id));
}
async function unchangedSource(h: ComputerHarness, source: Awaited<ReturnType<typeof parent>>) {
  const state = (await h.state.get(h.workId))!;
  assert.deepEqual(state.attempts.find(value => value.id === source.attempt.id), source.attempt);
  assert.deepEqual(await h.artifacts.get(source.attempt.computerUse!.head, state.policy), source.headBytes);
  assert.deepEqual(await h.artifacts.get(source.attempt.resultArtifact!, state.policy), source.resultBytes);
  assert.equal(state.modelCalls.length, 0); return state;
}
const search: ComputerStep = { action: { kind: 'click', target: { role: 'button', name: 'Search' } },
  condition: { kind: 'fact_equals', key: 'resultsReady', value: true } };

for (const backend of backends) {
  test(`${backend}: an applied-unknown prefix is reconciled once and only the two remaining inputs run`, async t => {
    const h = await harness(t, backend); const app = driver(h); app.injectNextAction({ outcome: 'applied_unknown' });
    const source = await parent(h, [search, ...saveNoteSteps]);
    assert.equal(source.attempt.adopted, false); assert.equal(source.result.effectState, 'unknown'); assert.equal(app.snapshot().inputCount, 1);
    const input = await resume(h, source); assert.equal(app.snapshot().inputCount, 1);
    const child = await successor(h, 'continue', input); const state = await unchangedSource(h, source);
    assert.equal(child.result.status, 'success'); assert.equal(child.result.effectState, 'confirmed'); assert.equal(child.attempt.adopted, true);
    assert.deepEqual(child.checkpoint.steps.map(value => value.action), saveNoteSteps.map(value => value.action));
    assert.deepEqual(child.checkpoint.steps.map(value => value.index), [0, 1]);
    assert.equal(child.checkpoint.continuation!.claim.nextStep, 1); assert.equal(child.checkpoint.continuation!.claim.totalSteps, 3);
    assert.ok(child.checkpoint.entryObservation); assert.ok(child.checkpoint.continuation!.inheritedObservation);
    assert.equal(child.checkpoint.lineage.inputAttemptsUsed, 3); assert.equal(child.checkpoint.lineage.rootAttemptId, source.attempt.id);
    assert.equal(child.checkpoint.lineage.actionDeadlineAt, source.checkpoint.lineage.actionDeadlineAt);
    assert.equal(app.snapshot().inputCount, 3); assert.equal(app.snapshot().saveCount, 1); assert.equal(state.computerContinuations!.length, 1);
    assert.equal(await h.computerContinuations.current(state), true);
    assert.equal((await h.runtime.step(h.workId)).kind, 'complete');
    const before = app.snapshot(); await h.runtime.execute(h.workId, source.attempt.id); await h.runtime.execute(h.workId, child.attempt.id);
    assert.deepEqual(app.snapshot(), before);
  });

  test(`${backend}: an unknown saved input is verified after the old action deadline without saving twice`, async t => {
    const h = await harness(t, backend); const app = driver(h); app.injectNextAction({}); app.injectNextAction({ outcome: 'applied_unknown' });
    const source = await parent(h); const input = await resume(h, source);
    assert.equal(app.snapshot().saveCount, 1); assert.equal(app.snapshot().inputCount, 2);
    h.clock.advance(source.checkpoint.lineage.actionDeadlineAt - h.clock.now() + 1);
    const before = app.snapshot(); const child = await successor(h, 'verify', input);
    assert.equal(child.result.status, 'success'); assert.equal(child.attempt.effect, 'read'); assert.equal(child.result.effectState, 'none');
    assert.equal(child.checkpoint.phase, 'complete'); assert.deepEqual(child.checkpoint.steps, []);
    assert.equal(child.checkpoint.continuation!.claim.nextStep, 2); assert.equal(child.checkpoint.continuation!.claim.totalSteps, 2);
    assert.ok(child.checkpoint.deadlineAt > source.checkpoint.lineage.actionDeadlineAt);
    assert.equal(child.checkpoint.lineage.actionDeadlineAt, source.checkpoint.lineage.actionDeadlineAt);
    assert.equal(child.checkpoint.lineage.inputAttemptsUsed, source.checkpoint.lineage.inputAttemptsUsed);
    assert.ok(child.checkpoint.lineage.observationsUsed > source.checkpoint.lineage.observationsUsed);
    assert.equal(app.snapshot().inputCount, before.inputCount); assert.equal(app.snapshot().saveCount, before.saveCount);
    assert.deepEqual(app.snapshot().invocations, before.invocations); await unchangedSource(h, source);
    assert.equal((await h.runtime.step(h.workId)).kind, 'complete');
  });

  test(`${backend}: a known not-applied input may be retried once while its applied prefix remains immutable`, async t => {
    const h = await harness(t, backend); const app = driver(h); app.injectNextAction({}); app.injectNextAction({ outcome: 'not_applied_timeout' });
    const source = await parent(h); assert.equal(source.result.effectState, 'confirmed'); assert.equal(source.attempt.adopted, true);
    assert.equal(source.checkpoint.steps[1]!.status, 'not_applied'); assert.equal(app.snapshot().inputCount, 1);
    const input = await resume(h, source); assert.equal(input.reconciliation, null);
    const child = await successor(h, 'continue', input); const state = await unchangedSource(h, source);
    assert.equal(child.result.status, 'success'); assert.equal(child.checkpoint.steps.length, 1);
    assert.deepEqual(child.checkpoint.steps[0]!.action, saveNoteSteps[1]!.action);
    assert.equal(child.checkpoint.continuation!.claim.nextStep, 1);
    assert.equal(child.checkpoint.lineage.inputAttemptsUsed, 3, 'the parent failed input reservation cannot be refunded by a new attempt');
    assert.equal(app.snapshot().inputCount, 2); assert.equal(app.snapshot().saveCount, 1);
    assert.equal(state.computerReconciliations?.length ?? 0, 0); assert.equal((await h.runtime.step(h.workId)).kind, 'complete');
  });

  test(`${backend}: a later value supersedes the same field's earlier condition at the continuation frontier`, async t => {
    const h = await harness(t, backend); const app = driver(h);
    const draft: ComputerStep = { action: { kind: 'fill', target: { role: 'textbox', name: 'Note' }, value: 'draft' },
      condition: { kind: 'element_value', target: { role: 'textbox', name: 'Note' }, value: 'draft' } };
    app.injectNextAction({}); app.injectNextAction({}); app.injectNextAction({ outcome: 'not_applied_timeout' });
    const source = await parent(h, [draft, ...saveNoteSteps]);
    assert.equal(app.snapshot().note, 'reviewed'); assert.equal(source.checkpoint.steps[0]!.verified, true); assert.equal(source.checkpoint.steps[1]!.verified, true);
    const child = await successor(h, 'continue', await resume(h, source));
    assert.equal(child.result.status, 'success'); assert.equal(child.checkpoint.continuation!.claim.nextStep, 2);
    assert.deepEqual(child.checkpoint.steps.map(value => value.action), [saveNoteSteps[1]!.action]);
    assert.equal(app.snapshot().inputCount, 3); assert.equal(app.snapshot().saveCount, 1);
    assert.equal(child.checkpoint.lineage.inputAttemptsUsed, 4); await unchangedSource(h, source);
    assert.equal((await h.runtime.step(h.workId)).kind, 'complete');
  });

  test(`${backend}: changed inherited conditions stop a successor without repeating or extending the applied prefix`, async t => {
    const clock = new SyntheticComputerClock(1000); const app = new SyntheticComputerDriver({ clock });
    const h = await harness(t, backend, { clock, driver: automaticWaits(app, clock), limits: { maxObservations: 4 } });
    app.injectNextAction({ outcome: 'applied_unknown' });
    const source = await parent(h); const input = await resume(h, source); app.mutate({ note: 'changed by a person' });
    const before = app.snapshot(); const child = await successor(h, 'continue', input);
    assert.equal(child.result.status, 'partial'); assert.equal(child.checkpoint.phase, 'partial'); assert.deepEqual(child.checkpoint.steps, []);
    assert.ok(['computer_observation_limit', 'computer_lease_expired'].includes(child.result.error?.code ?? ''));
    assert.deepEqual(child.result.evidence, []); assert.equal(app.snapshot().inputCount, before.inputCount);
    assert.equal(app.snapshot().saveCount, 0); assert.deepEqual(app.snapshot().invocations, before.invocations);
    assert.equal(child.checkpoint.lineage.inputAttemptsUsed, source.checkpoint.lineage.inputAttemptsUsed);
    assert.ok(child.checkpoint.lineage.observationsUsed <= child.checkpoint.lineage.maxObservations);
    await unchangedSource(h, source); assert.notEqual((await h.runtime.step(h.workId)).kind, 'complete');
  });

  test(`${backend}: concurrent reservations create at most one successor and consume one work reservation`, async t => {
    const h = await harness(t, backend); const app = driver(h); app.injectNextAction({}); app.injectNextAction({ outcome: 'not_applied_timeout' });
    const source = await parent(h); const input = await resume(h, source); const task = await plan(h, 'continue', input);
    const before = (await h.state.get(h.workId))!; const inputsBefore = app.snapshot().inputCount;
    const replies = await Promise.allSettled([h.runtime.reserve(h.workId, task.id), h.runtime.reserve(h.workId, task.id)]);
    const accepted = replies.filter((reply): reply is PromiseFulfilledResult<Attempt> => reply.status === 'fulfilled');
    assert.ok(accepted.length >= 1); assert.equal(new Set(accepted.map(reply => reply.value.id)).size, 1);
    const reserved = (await h.state.get(h.workId))!;
    assert.equal(reserved.computerContinuations!.filter(value => value.sourceAttemptId === source.attempt.id).length, 1);
    assert.equal(reserved.attempts.length, before.attempts.length + 1); assert.equal(reserved.budget.reservedToolCalls, before.budget.reservedToolCalls + 1);
    assert.equal(reserved.budget.used.toolCalls, before.budget.used.toolCalls); assert.equal(app.snapshot().inputCount, inputsBefore);
    const child = await run(h, accepted[0]!.value); assert.equal(child.result.status, 'success'); await unchangedSource(h, source);
    const another = await plan(h, 'continue', input); const prior = (await h.state.get(h.workId))!; const appBefore = app.snapshot();
    await assert.rejects(h.runtime.reserve(h.workId, another.id));
    assert.deepEqual(await h.state.get(h.workId), prior); assert.deepEqual(app.snapshot(), appBefore);
  });

  test(`${backend}: lineage observation and input budgets stay spent across failed successors`, async t => {
    const observed = await harness(t, backend, { limits: { maxObservations: 1 } }); const observedApp = driver(observed);
    observedApp.injectNextAction({ outcome: 'applied_unknown' }); const observedSource = await parent(observed);
    const observedTask = await plan(observed, 'continue', await resume(observed, observedSource));
    const observedState = (await observed.state.get(observed.workId))!; const observedBefore = observedApp.snapshot();
    assert.equal(observedSource.checkpoint.lineage.observationsUsed, observedSource.checkpoint.lineage.maxObservations);
    await assert.rejects(observed.runtime.reserve(observed.workId, observedTask.id));
    assert.deepEqual(await observed.state.get(observed.workId), observedState); assert.deepEqual(observedApp.snapshot(), observedBefore);

    const input = await harness(t, backend, { limits: { maxSteps: 1 } }); const inputApp = driver(input);
    inputApp.injectNextAction({ outcome: 'not_applied_timeout' }); const inputSource = await parent(input, [saveNoteSteps[0]!]);
    inputApp.injectNextAction({ outcome: 'not_applied_timeout' }); const failed = await successor(input, 'continue', await resume(input, inputSource));
    assert.equal(failed.result.status, 'partial'); assert.equal(failed.checkpoint.lineage.inputAttemptsUsed, 2);
    assert.equal(failed.checkpoint.lineage.maxInputAttempts, 2); assert.equal(inputApp.snapshot().inputCount, 0);
    const next = await plan(input, 'continue', { attemptId: failed.attempt.id, checkpointId: failed.attempt.computerUse!.head.id, reconciliation: null });
    const before = (await input.state.get(input.workId))!; const appBefore = inputApp.snapshot();
    await assert.rejects(input.runtime.reserve(input.workId, next.id));
    assert.deepEqual(await input.state.get(input.workId), before); assert.deepEqual(inputApp.snapshot(), appBefore); await unchangedSource(input, inputSource);
  });

  test(`${backend}: a new successor cannot reset the original action deadline`, async t => {
    const h = await harness(t, backend); const app = driver(h); app.injectNextAction({}); app.injectNextAction({ outcome: 'not_applied_timeout' });
    const source = await parent(h, saveNoteSteps, 100); assert.equal(source.checkpoint.lineage.actionDeadlineAt, 1100);
    h.clock.advance(100); const task = await plan(h, 'continue', await resume(h, source));
    const state = (await h.state.get(h.workId))!; const before = app.snapshot();
    await assert.rejects(h.runtime.reserve(h.workId, task.id));
    assert.deepEqual(await h.state.get(h.workId), state); assert.deepEqual(app.snapshot(), before); await unchangedSource(h, source);
  });
}
