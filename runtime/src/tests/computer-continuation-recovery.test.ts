import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { asJson } from '../application/plan-validator.js';
import { evaluateCompletion } from '../domain/completion.js';
import type { ComputerCheckpointV2 } from '../domain/computer-use.js';
import type { TaskSpec } from '../domain/model.js';
import { SyntheticComputerClock, SyntheticComputerDriver } from '../infrastructure/synthetic-computer-driver.js';
import { computerActor, computerHarness, computerResult, type ComputerBackend, type ComputerHarness } from './computer-use-helpers.js';
import type { ContinuationCrashMarker, ContinuationCrashStage } from './helpers/computer-continuation-crash-child.js';

async function killedChild(directory: string, backend: ComputerBackend, stage: ContinuationCrashStage): Promise<ContinuationCrashMarker> {
  const child = fork(new URL('./helpers/computer-continuation-crash-child.js', import.meta.url), [directory, backend, stage],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout!.resume(); let stderr = ''; let timedOut = false;
  child.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-32768); });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 30000);
  try {
    const [code, signal] = await once(child, 'exit');
    assert.equal(timedOut, false, `The selected continuation boundary was not reached: ${stderr}`);
    assert.equal(code, null, stderr); assert.equal(signal, 'SIGKILL', stderr);
    const marker = JSON.parse(await readFile(join(directory, 'continuation-crash-marker.json'), 'utf8')) as ContinuationCrashMarker;
    assert.equal(marker.schemaVersion, 1); assert.equal(marker.backend, backend); assert.equal(marker.stage, stage);
    assert.equal(marker.workId, 'computer-work'); assert.ok(marker.childAttemptId && marker.parentAttemptId);
    assert.equal(marker.claim.sourceAttemptId, marker.parentAttemptId); assert.equal(marker.claim.successorAttemptId, marker.childAttemptId);
    const app = JSON.parse(await readFile(join(directory, 'app.json'), 'utf8')) as {
      version: number; epoch: number; app: { inputCount: number; saveCount: number; savedNote: string };
    };
    assert.equal(app.version, 2); assert.equal(app.epoch, marker.epoch);
    assert.equal(app.app.inputCount, stage === 'save-applied' ? 2 : 1); assert.equal(app.app.saveCount, stage === 'save-applied' ? 1 : 0);
    return marker;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit').catch(() => {}); }
  }
}

async function fixture(t: TestContext, backend: ComputerBackend, stage: ContinuationCrashStage) {
  const directory = await mkdtemp(join(tmpdir(), 'computer-continuation-recovery-')); let h: ComputerHarness | null = null;
  t.after(async () => { try { if (h) await h.close(false); } finally { await rm(directory, { recursive: true, force: true }); } });
  const marker = await killedChild(directory, backend, stage); const clock = new SyntheticComputerClock(marker.at);
  const driver = new SyntheticComputerDriver({ clock, stateFile: join(directory, 'app.json') });
  assert.ok(driver.snapshot().epoch > marker.epoch);
  // Depth-two receipt verification performs local proof I/O; its fixture wait is independent of the retained action deadline.
  h = await computerHarness(backend, { directory, clock, driver, continuations: true, leaseMs: stage === 'save-applied' ? 60000 : 20000 });
  const state = await h.runtime.state(h.workId);
  assert.deepEqual(state.computerContinuations, [marker.claim]);
  assert.deepEqual(state.attempts.find(attempt => attempt.id === marker.childAttemptId)!.computerUse?.head ?? null, marker.childHead);
  assert.equal(driver.snapshot().inputCount, marker.inputCount); assert.equal(driver.snapshot().saveCount, marker.saveCount);
  return { h, marker, clock, driver };
}

async function sourceUnchanged(h: ComputerHarness, marker: ContinuationCrashMarker) {
  const state = await h.runtime.state(h.workId); const source = state.attempts.find(attempt => attempt.id === marker.parentAttemptId)!;
  assert.equal(h.services.digester.digest(asJson(source)), marker.parentDigest); assert.ok(source.computerUse); assert.ok(source.resultArtifact);
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash(await h.artifacts.get(source.computerUse.head, state.policy)), marker.parentHeadDigest);
  assert.equal(hash(await h.artifacts.get(source.resultArtifact, state.policy)), marker.parentResultDigest);
  assert.deepEqual(state.computerContinuations!.find(claim => claim.sourceAttemptId === source.id), marker.claim);
  assert.equal(state.computerContinuations!.filter(claim => claim.sourceAttemptId === source.id).length, 1);
  assert.equal(state.modelCalls.length, 0); return state;
}

async function checkpoint(h: ComputerHarness, attemptId: string): Promise<ComputerCheckpointV2> {
  const before = await h.runtime.state(h.workId); const result = await h.computerUse.inspect(h.workId, computerActor, attemptId);
  assert.deepEqual(await h.runtime.state(h.workId), before); assert.ok(result.checkpoint.schemaVersion === 2); return result.checkpoint;
}

async function noSibling(h: ComputerHarness, marker: ContinuationCrashMarker) {
  const state = await h.runtime.state(h.workId); const receipt = await h.state.receipt(h.workId, `reserve:${marker.childAttemptId}`);
  const task = receipt?.state.plan?.tasks.find(value => value.id === marker.childTaskId); assert.ok(task);
  await assert.rejects(h.computerContinuations.prepare(state, task, 'forbidden-sibling'), /computer_continuation_successor_exists/);
  assert.deepEqual(await h.runtime.state(h.workId), state);
}

for (const backend of ['sqlite', 'file-journal'] as const) {
  test(`${backend}: SIGKILL after continuation reservation preserves one claim and executes only the existing child after restart`, { timeout: 45000 }, async t => {
    const { h, marker, driver } = await fixture(t, backend, 'reserved');
    const reserved = await sourceUnchanged(h, marker); const child = reserved.attempts.find(attempt => attempt.id === marker.childAttemptId)!;
    assert.equal(child.status, 'reserved'); assert.equal(child.computerUse, undefined); assert.equal(marker.lineage, null);
    assert.equal(reserved.budget.reservedToolCalls, 1); assert.equal(await h.state.receipt(h.workId, `dispatch:${child.id}`), null);
    assert.equal(await h.computerContinuations.current(reserved), true); await noSibling(h, marker);
    await h.runtime.execute(h.workId, child.id); await h.runtime.settlePending(child.id);
    const result = await computerResult(h, child.id); assert.equal(result.status, 'success');
    await h.runtime.adopt(h.workId, child.id); const cp = await checkpoint(h, child.id);
    assert.deepEqual(cp.continuation!.claim, marker.claim); assert.equal(cp.epoch, driver.snapshot().epoch);
    assert.equal(cp.lineage.inputAttemptsUsed, marker.claim.inputAttemptsUsed + 1);
    assert.equal(cp.lineage.actionDeadlineAt, marker.claim.actionDeadlineAt); assert.ok(cp.lineage.observationsUsed > marker.claim.observationsUsed);
    assert.equal(cp.steps.length, 1); assert.equal(cp.steps[0]!.action.kind, 'click'); assert.equal(cp.steps[0]!.action.target.name, 'Save');
    assert.equal(driver.snapshot().inputCount, 2); assert.equal(driver.snapshot().saveCount, 1);
    assert.equal((await h.runtime.step(h.workId)).kind, 'complete');
    const completed = await sourceUnchanged(h, marker); const snapshot = driver.snapshot();
    await h.runtime.execute(h.workId, child.id); await h.runtime.adopt(h.workId, child.id); await noSibling(h, marker);
    assert.deepEqual(await h.runtime.state(h.workId), completed); assert.deepEqual(driver.snapshot(), snapshot);
  });

  test(`${backend}: SIGKILL after child observation reservation preserves spent lineage budget without replaying an unreceived observation`, { timeout: 45000 }, async t => {
    const { h, marker, clock, driver } = await fixture(t, backend, 'observation-reserved');
    const stopped = await sourceUnchanged(h, marker); const original = await checkpoint(h, marker.childAttemptId);
    assert.deepEqual(original.lineage, marker.lineage); assert.equal(original.entryObservation, null); assert.deepEqual(original.steps, []);
    assert.equal(original.continuation!.inheritedObservation, null);
    assert.equal(original.lineage.observationsUsed, marker.claim.observationsUsed + 1);
    assert.equal(original.lineage.inputAttemptsUsed, marker.claim.inputAttemptsUsed);
    await noSibling(h, marker); await assert.rejects(h.runtime.recover(h.workId, marker.childAttemptId), /attempt_not_expired/);
    assert.deepEqual(await h.runtime.state(h.workId), stopped);
    clock.advance(marker.leaseUntil - clock.now() + 1);
    const recovered = await h.runtime.recover(h.workId, marker.childAttemptId); const child = recovered.attempts.find(value => value.id === marker.childAttemptId)!;
    assert.equal(child.status, 'unknown'); assert.equal(child.effectState, 'unknown'); assert.equal(child.resultArtifact, null);
    assert.ok(recovered.obligations.some(value => value.id === `effect:${child.id}` && value.status === 'pending'));
    assert.deepEqual((await checkpoint(h, child.id)).lineage, original.lineage); assert.deepEqual(child.computerUse!.head, marker.childHead);
    await h.runtime.execute(h.workId, child.id); await h.runtime.recover(h.workId, child.id);
    assert.deepEqual(await h.runtime.state(h.workId), recovered);
    await assert.rejects(h.computerReconciliations.reserve(h.workId, 'no-input-receipt-to-lookup', computerActor,
      { attemptId: child.id, checkpointId: child.computerUse!.head.id }), /computer_reconciliation_target_unavailable/);
    assert.equal(evaluateCompletion(recovered.goal, recovered.evidence, recovered.obligations, recovered.policy).complete, false);
    assert.equal(driver.snapshot().inputCount, 1); assert.equal(driver.snapshot().saveCount, 0);
    assert.equal(driver.snapshot().usage.transportCalls, 0); assert.deepEqual(driver.snapshot().sessionCalls, { acquire: 0, release: 0 });
    await sourceUnchanged(h, marker); await noSibling(h, marker);
  });

  // The host watchdog covers layered file proofs under full-suite disk contention; logical input and lease limits stay unchanged.
  test(`${backend}: SIGKILL after child Save reconciles its durable receipt and verifies depth two without repeating applied input`, { timeout: 120000 }, async t => {
    const { h, marker, clock, driver } = await fixture(t, backend, 'save-applied');
    const intent = await checkpoint(h, marker.childAttemptId); assert.equal(intent.steps.length, 1);
    assert.equal(intent.steps[0]!.status, 'intent'); assert.equal(intent.steps[0]!.operationId, marker.operationId);
    assert.deepEqual(intent.lineage, marker.lineage); assert.equal(intent.lineage.inputAttemptsUsed, marker.claim.inputAttemptsUsed + 1);
    await sourceUnchanged(h, marker); await noSibling(h, marker);
    clock.advance(marker.leaseUntil - clock.now() + 1); await h.runtime.recover(h.workId, marker.childAttemptId);
    const unknown = await h.runtime.state(h.workId); const child = unknown.attempts.find(value => value.id === marker.childAttemptId)!;
    assert.equal(child.status, 'unknown'); assert.equal(child.resultArtifact, null); assert.equal(child.adopted, false);
    const proof = await h.computerReconciliations.reconcile(h.workId, 'reconcile-killed-child', computerActor,
      { attemptId: child.id, checkpointId: child.computerUse!.head.id });
    assert.equal(proof.status, 'settled'); assert.equal(proof.outcome, 'applied'); assert.ok(proof.proofArtifact);
    const state = await h.runtime.state(h.workId); assert.deepEqual(state.attempts.find(value => value.id === child.id), child);
    assert.equal(state.obligations.find(value => value.id === proof.obligationId)!.status, 'satisfied'); assert.deepEqual(state.evidence, []);
    const task: TaskSpec = { id: 'verify-after-killed-save', toolId: 'synthetic.ui.verify', toolVersion: '1',
      description: 'Verify the already saved note after durable receipt reconciliation', input: {},
      computerResume: { attemptId: child.id, checkpointId: child.computerUse!.head.id, reconciliation: { id: proof.id, proofId: proof.proofArtifact.id } },
      dependsOn: [], effect: 'read', maxAttempts: 1, satisfies: ['saved'] };
    await h.runtime.submitPlan(h.workId, 'plan-verify-killed-child', { baseStateRevision: state.revision, baseGoalRevision: state.goal.revision,
      basePlanRevision: state.plan?.revision ?? 0, reason: 'A read-only successor checks the current condition without repeating Save', tasks: [task], hypotheses: [] });
    const verify = await h.runtime.reserve(h.workId, task.id); await h.runtime.execute(h.workId, verify.id); await h.runtime.settlePending(verify.id);
    const result = await computerResult(h, verify.id); assert.equal(result.status, 'success', JSON.stringify(result)); assert.equal(result.effectState, 'none');
    await h.runtime.adopt(h.workId, verify.id); const verified = await checkpoint(h, verify.id);
    assert.deepEqual(verified.steps, []); assert.equal(verified.lineage.depth, 2); assert.equal(verified.lineage.rootAttemptId, marker.parentAttemptId);
    assert.equal(verified.lineage.inputAttemptsUsed, intent.lineage.inputAttemptsUsed);
    assert.equal(verified.lineage.actionDeadlineAt, marker.claim.actionDeadlineAt); assert.ok(clock.now() > verified.lineage.actionDeadlineAt);
    assert.ok(verified.lineage.observationsUsed > intent.lineage.observationsUsed); assert.ok(verified.entryObservation);
    assert.equal((await h.runtime.step(h.workId)).kind, 'complete'); const final = await sourceUnchanged(h, marker);
    assert.deepEqual(final.attempts.find(value => value.id === child.id), child); assert.equal(final.computerContinuations!.length, 2);
    assert.equal(driver.snapshot().inputCount, 2); assert.equal(driver.snapshot().saveCount, 1); assert.deepEqual(driver.snapshot().invocations, []);
    const snapshot = driver.snapshot(); await h.runtime.execute(h.workId, child.id); await h.runtime.execute(h.workId, verify.id);
    await h.runtime.adopt(h.workId, verify.id); await noSibling(h, marker);
    assert.deepEqual(await h.runtime.state(h.workId), final); assert.deepEqual(driver.snapshot(), snapshot);
  });
}
