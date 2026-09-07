import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evaluateCompletion } from '../domain/completion.js';
import { executionControl } from '../domain/execution-policy.js';
import { summarizeToolExecution } from '../application/tool-execution-usage.js';
import { SyntheticComputerClock, SyntheticComputerDriver } from '../infrastructure/synthetic-computer-driver.js';
import { computerActor, computerActInput, computerHarness, computerResult, saveNoteSteps, submitComputerTask,
  type ComputerBackend, type ComputerHarness } from './computer-use-helpers.js';
import type { ComputerCrashMarker } from './helpers/computer-use-crash-child.js';

const backends: ComputerBackend[] = ['sqlite', 'file-journal'];
async function killedChild(directory: string, backend: ComputerBackend, stage: ComputerCrashMarker['stage']): Promise<ComputerCrashMarker> {
  const child = fork(new URL('./helpers/computer-use-crash-child.js', import.meta.url), [directory, backend, stage],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout!.resume(); let stderr = ''; let timedOut = false;
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 30000);
  try {
    const [code, signal] = await once(child, 'exit');
    assert.equal(timedOut, false, `The selected durable boundary was not reached: ${stderr}`);
    assert.equal(code, null, stderr); assert.equal(signal, 'SIGKILL', stderr);
    const marker = JSON.parse(await readFile(join(directory, 'crash-marker.json'), 'utf8')) as ComputerCrashMarker;
    assert.equal(marker.schemaVersion, 1); assert.equal(marker.backend, backend); assert.equal(marker.stage, stage);
    assert.ok(marker.attemptId && marker.observationId); assert.equal(marker.workId, 'computer-work');
    assert.equal(marker.inputCount, 2); assert.equal(marker.saveCount, 1);
    const persistedApp = JSON.parse(await readFile(join(directory, 'app.json'), 'utf8')) as {
      version: number; epoch: number; app: { inputCount: number; saveCount: number; savedNote: string };
    };
    assert.equal(persistedApp.version, 2); assert.equal(persistedApp.epoch, marker.epoch);
    assert.equal(persistedApp.app.inputCount, 2); assert.equal(persistedApp.app.saveCount, 1); assert.equal(persistedApp.app.savedNote, 'reviewed');
    return marker;
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit').catch(() => {}); }
  }
}

async function reopened(t: TestContext, backend: ComputerBackend, stage: ComputerCrashMarker['stage']) {
  const directory = await mkdtemp(join(tmpdir(), 'computer-recovery-')); let h: ComputerHarness | null = null;
  t.after(async () => { try { if (h) await h.close(false); } finally { await rm(directory, { recursive: true, force: true }); } });
  const marker = await killedChild(directory, backend, stage);
  const clock = new SyntheticComputerClock(marker.at);
  const driver = new SyntheticComputerDriver({ clock, stateFile: join(directory, 'app.json') });
  assert.ok(driver.snapshot().epoch > marker.epoch, 'a reopened app has a new session epoch');
  h = await computerHarness(backend, { directory, clock, driver });
  return { h, marker, clock, driver };
}

async function inspectWithoutMutation(h: ComputerHarness, attemptId: string) {
  const before = await h.runtime.state(h.workId); const events = await h.state.events(h.workId, 0);
  const inspected = await h.computerUse.inspect(h.workId, computerActor, attemptId);
  assert.deepEqual(await h.runtime.state(h.workId), before); assert.deepEqual(await h.state.events(h.workId, 0), events);
  return inspected;
}

for (const backend of backends) {
  test(`${backend}: SIGKILL after Save leaves committed intent unknown across recovery, goal change and cancellation without replay`, { timeout: 45000 }, async t => {
    const { h, marker, clock, driver } = await reopened(t, backend, 'save-applied');
    assert.ok(marker.operationId); assert.equal(marker.resultArtifactId, null);
    const stopped = await h.runtime.state(h.workId); const attempt = stopped.attempts.find(value => value.id === marker.attemptId)!;
    assert.equal(attempt.status, 'running'); assert.equal(attempt.resultArtifact, null); assert.equal(attempt.adopted, false);
    assert.ok(attempt.computerUse); assert.equal(attempt.computerUse.pendingOperationId, marker.operationId);
    assert.ok(await h.state.receipt(h.workId, `dispatch:${attempt.id}`));
    assert.equal(await h.state.receipt(h.workId, `receive:${attempt.id}`), null);
    const trace = await inspectWithoutMutation(h, attempt.id);
    assert.deepEqual(trace.checkpoint.steps.map(step => [step.status, step.verified]), [['applied', true], ['intent', false]]);
    assert.equal(trace.checkpoint.steps[1]!.operationId, marker.operationId); assert.equal(trace.checkpoint.steps[1]!.after, null);
    assert.equal(trace.checkpoint.epoch, marker.epoch);

    await assert.rejects(h.runtime.recover(h.workId, attempt.id), /attempt_not_expired/);
    assert.deepEqual(await h.runtime.state(h.workId), stopped);
    clock.advance(marker.leaseUntil - clock.now() + 1);
    const recovered = await h.runtime.recover(h.workId, attempt.id); const settled = recovered.attempts.find(value => value.id === attempt.id)!;
    assert.equal(settled.status, 'unknown'); assert.equal(settled.effectState, 'unknown'); assert.equal(settled.error?.code, 'lease_expired');
    assert.equal(settled.leaseUntil, marker.leaseUntil); assert.equal(settled.resultArtifact, null); assert.equal(settled.adopted, false);
    assert.equal(recovered.budget.used.toolCalls, 2); assert.equal(recovered.budget.reservedToolCalls, 0);
    assert.ok(recovered.obligations.some(value => value.kind === 'effect_reconciliation' && value.status === 'pending'));
    assert.equal(summarizeToolExecution(recovered).unknownInvocations, 1);
    assert.equal(evaluateCompletion(recovered.goal, recovered.evidence, recovered.obligations, recovered.policy).complete, false);
    await h.runtime.recover(h.workId, attempt.id); await h.runtime.execute(h.workId, attempt.id);
    assert.deepEqual(await h.runtime.state(h.workId), recovered);
    assert.deepEqual(await h.runtime.step(h.workId), { kind: 'blocked', reason: 'effect_unknown' });
    await assert.rejects(submitComputerTask(h, 'act', computerActInput(marker.observationId, saveNoteSteps)), /effect_unknown/);

    const beforeGoal = await h.runtime.state(h.workId);
    await h.runtime.command(h.workId, 'new-goal-retains-old-input-intent', computerActor, beforeGoal.goal.revision, {
      kind: 'goal', expectedControlRevision: executionControl(beforeGoal).revision,
      goal: { ...beforeGoal.goal, revision: beforeGoal.goal.revision + 1, description: 'An explicit new goal still needs the earlier effect reconciled' },
    });
    const historical = await inspectWithoutMutation(h, attempt.id);
    assert.equal(historical.checkpoint.goalRevision, stopped.goal.revision); assert.equal(historical.progress.pendingOperationId, marker.operationId);
    const changed = await h.runtime.state(h.workId);
    await h.runtime.command(h.workId, 'cancel-with-unresolved-computer-intent', computerActor, changed.goal.revision, { kind: 'cancel', reason: 'Stop synthetic input' });
    await inspectWithoutMutation(h, attempt.id); await h.runtime.execute(h.workId, attempt.id);
    const final = await h.runtime.state(h.workId);
    assert.equal(final.status, 'cancelled'); assert.equal(final.modelCalls.length, 0);
    assert.ok(final.obligations.some(value => value.kind === 'effect_reconciliation' && value.status === 'pending'));
    assert.equal(driver.snapshot().inputCount, 2); assert.equal(driver.snapshot().saveCount, 1);
    assert.equal(driver.snapshot().usage.transportCalls, 0); assert.deepEqual(driver.snapshot().sessionCalls, { acquire: 0, release: 0 });
    assert.deepEqual(driver.snapshot().invocations, []);
  });

  test(`${backend}: SIGKILL after received result permits one adoption and rejects an old-epoch observation for a new input`, { timeout: 45000 }, async t => {
    const { h, marker, driver } = await reopened(t, backend, 'result-stored');
    assert.equal(marker.operationId, null); assert.ok(marker.resultArtifactId);
    const stopped = await h.runtime.state(h.workId); const attempt = stopped.attempts.find(value => value.id === marker.attemptId)!;
    assert.equal(attempt.status, 'received'); assert.equal(attempt.adopted, false); assert.equal(attempt.resultArtifact?.id, marker.resultArtifactId);
    assert.ok(await h.state.receipt(h.workId, `receive:${attempt.id}`)); assert.equal(await h.state.receipt(h.workId, `adopt:${attempt.id}`), null);
    const stored = await computerResult(h, attempt.id);
    assert.equal(stored.status, 'success'); assert.equal(stored.effectState, 'confirmed'); assert.equal(stored.evidence[0]!.facts['savedNote'], 'reviewed');
    assert.equal(Object.hasOwn(stored.evidence[0]!.facts, 'resultsReady'), false, 'only the verified Save condition becomes evidence');
    const trace = await inspectWithoutMutation(h, attempt.id);
    assert.equal(trace.progress.phase, 'complete'); assert.equal(trace.progress.completedSteps, 2); assert.equal(trace.checkpoint.epoch, marker.epoch);
    assert.ok(trace.checkpoint.steps.every(step => step.status === 'applied' && step.verified && step.after !== null));
    await h.runtime.execute(h.workId, attempt.id);
    assert.deepEqual(await h.runtime.state(h.workId), stopped);
    await h.runtime.adopt(h.workId, attempt.id);
    const adopted = await h.runtime.state(h.workId); const settled = adopted.attempts.find(value => value.id === attempt.id)!;
    assert.equal(settled.adopted, true); assert.equal(settled.status, 'succeeded'); assert.equal(settled.effectState, 'confirmed');
    assert.equal(settled.resultArtifact?.id, marker.resultArtifactId); assert.equal(adopted.evidence.length, 1);
    assert.equal(adopted.budget.used.toolCalls, 2); assert.equal(adopted.budget.reservedToolCalls, 0);
    assert.equal(adopted.obligations.some(value => value.kind === 'effect_reconciliation' && value.status === 'pending'), false);
    assert.equal(evaluateCompletion(adopted.goal, adopted.evidence, adopted.obligations, adopted.policy).complete, false, 'the separate Search goal remains unmet');
    await h.runtime.adopt(h.workId, attempt.id); await h.runtime.execute(h.workId, attempt.id);
    assert.deepEqual(await h.runtime.state(h.workId), adopted); assert.deepEqual(await computerResult(h, attempt.id), stored);
    assert.equal(driver.snapshot().usage.transportCalls, 0); assert.deepEqual(driver.snapshot().sessionCalls, { acquire: 0, release: 0 });

    const stale = await submitComputerTask(h, 'act', computerActInput(marker.observationId, saveNoteSteps));
    assert.equal(stale.goalRevision, attempt.goalRevision, 'the original goal is unchanged, so refusal must reach the session epoch check');
    await h.runtime.execute(h.workId, stale.id); await h.runtime.settlePending(stale.id);
    const rejected = await computerResult(h, stale.id);
    assert.equal(rejected.status, 'error'); assert.equal(rejected.effectState, 'none'); assert.equal(rejected.error?.code, 'computer_view_changed');
    assert.deepEqual(rejected.evidence, []); assert.equal(driver.snapshot().sessionCalls.acquire, 1);
    assert.deepEqual(driver.snapshot().invocations, []); assert.equal(driver.snapshot().inputCount, 2); assert.equal(driver.snapshot().saveCount, 1);
    await h.runtime.adopt(h.workId, stale.id); const final = await h.runtime.state(h.workId);
    assert.equal(final.modelCalls.length, 0); assert.equal(final.budget.used.toolCalls, 3);
    assert.equal(final.attempts.find(value => value.id === stale.id)!.adopted, false);
    assert.equal(final.obligations.some(value => value.kind === 'effect_reconciliation' && value.status === 'pending'), false);
  });
}
