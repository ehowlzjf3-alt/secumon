import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ComputerDriver } from '../../application/computer-use-ports.js';
import { ComputerCheckpointV2Schema } from '../../application/computer-use-contracts.js';
import { asJson } from '../../application/plan-validator.js';
import type { ComputerContinuationClaim } from '../../domain/computer-continuation.js';
import type { ComputerLineage } from '../../domain/computer-use.js';
import type { ArtifactRef, TaskSpec } from '../../domain/model.js';
import { SyntheticComputerClock, SyntheticComputerDriver } from '../../infrastructure/synthetic-computer-driver.js';
import { computerActInput, computerHarness, computerResult, observeComputer, saveNoteSteps, submitComputerTask,
  type ComputerBackend } from '../computer-use-helpers.js';

export type ContinuationCrashStage = 'reserved' | 'observation-reserved' | 'save-applied';
export interface ContinuationCrashMarker {
  schemaVersion: 1;
  stage: ContinuationCrashStage;
  backend: ComputerBackend;
  workId: string;
  parentAttemptId: string;
  parentDigest: string;
  parentHeadDigest: string;
  parentResultDigest: string;
  claim: ComputerContinuationClaim;
  childAttemptId: string;
  childTaskId: string;
  childHead: ArtifactRef | null;
  lineage: ComputerLineage | null;
  entryObservationId: string | null;
  operationId: string | null;
  leaseUntil: number;
  at: number;
  epoch: number;
  inputCount: number;
  saveCount: number;
}

const directory = process.argv[2]; const backend = process.argv[3]; const stage = process.argv[4];
if (!directory || (backend !== 'sqlite' && backend !== 'file-journal') ||
  !['reserved', 'observation-reserved', 'save-applied'].includes(stage ?? '')) throw new Error('invalid_continuation_crash_arguments');
const clock = new SyntheticComputerClock(1000);
const driver = new SyntheticComputerDriver({ clock, stateFile: join(directory, 'app.json') });
let childAttemptId = ''; let parentAttemptId = ''; let parentDigest = ''; let parentHeadDigest = ''; let parentResultDigest = '';
const adapter: ComputerDriver = {
  identity: driver.identity, acquire: driver.acquire.bind(driver), release: driver.release.bind(driver), wait: driver.wait.bind(driver),
  lookup: driver.lookup.bind(driver),
  async observe(...args) {
    if (stage === 'observation-reserved' && args[0].attemptId === childAttemptId) await crash(null);
    return driver.observe(...args);
  },
  async act(...args) {
    const result = await driver.act(...args);
    if (stage === 'save-applied' && args[0].attemptId === childAttemptId) {
      assert.equal(result.status, 'applied'); assert.equal(args[1].action.kind, 'click');
      assert.equal(args[1].action.target.name, 'Save'); await crash(result.operationId);
    }
    return result;
  },
};
const h = await computerHarness(backend, { directory, clock, driver: adapter, continuations: true, leaseMs: 20000 });

async function crash(operationId: string | null): Promise<never> {
  const state = await h.state.get(h.workId); assert.ok(state);
  const child = state.attempts.find(attempt => attempt.id === childAttemptId); assert.ok(child);
  const claim = state.computerContinuations?.find(value => value.successorAttemptId === childAttemptId); assert.ok(claim);
  assert.equal(child.status, stage === 'reserved' ? 'reserved' : 'running'); assert.equal(child.resultArtifact, null);
  assert.ok(await h.state.receipt(h.workId, `reserve:${child.id}`));
  assert.equal(Boolean(await h.state.receipt(h.workId, `dispatch:${child.id}`)), stage !== 'reserved');
  assert.equal(await h.state.receipt(h.workId, `receive:${child.id}`), null);
  const checkpoint = child.computerUse ? ComputerCheckpointV2Schema.parse(JSON.parse(new TextDecoder().decode(
    await h.artifacts.get(child.computerUse.head, state.policy)))) : null;
  if (stage === 'reserved') assert.equal(checkpoint, null);
  else {
    assert.ok(checkpoint); assert.deepEqual(checkpoint.continuation?.claim, claim);
    assert.equal(checkpoint.lineage.observationsUsed, claim.observationsUsed + 1);
    assert.equal(checkpoint.lineage.inputAttemptsUsed, claim.inputAttemptsUsed + (stage === 'save-applied' ? 1 : 0));
    assert.equal(checkpoint.steps.length, stage === 'save-applied' ? 1 : 0);
    if (stage === 'observation-reserved') assert.equal(checkpoint.entryObservation, null);
    else {
      assert.ok(checkpoint.entryObservation); assert.ok(checkpoint.continuation!.inheritedObservation);
      assert.equal(checkpoint.steps[0]!.status, 'intent'); assert.equal(checkpoint.steps[0]!.operationId, operationId);
    }
  }
  const snapshot = driver.snapshot(); assert.equal(snapshot.inputCount, stage === 'save-applied' ? 2 : 1);
  assert.equal(snapshot.saveCount, stage === 'save-applied' ? 1 : 0);
  const marker: ContinuationCrashMarker = { schemaVersion: 1, stage: stage as ContinuationCrashStage, backend: backend as ComputerBackend,
    workId: h.workId, parentAttemptId, parentDigest, parentHeadDigest, parentResultDigest, claim,
    childAttemptId, childTaskId: child.taskId, childHead: child.computerUse?.head ?? null, lineage: checkpoint?.lineage ?? null,
    entryObservationId: checkpoint?.entryObservation?.id ?? null, operationId, leaseUntil: child.leaseUntil, at: clock.now(),
    epoch: snapshot.epoch, inputCount: snapshot.inputCount, saveCount: snapshot.saveCount };
  const fd = openSync(join(directory!, 'continuation-crash-marker.json'), 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(marker)); fsyncSync(fd); } finally { closeSync(fd); }
  const folder = openSync(directory!, 'r'); try { fsyncSync(folder); } finally { closeSync(folder); }
  process.kill(process.pid, 'SIGKILL');
  throw new Error('continuation_crash_signal_did_not_stop_process');
}

driver.injectNextAction({}); driver.injectNextAction({ outcome: 'not_applied_timeout' });
const observed = await observeComputer(h);
const parent = await submitComputerTask(h, 'act', computerActInput(observed.observationId, saveNoteSteps));
await h.runtime.execute(h.workId, parent.id); await h.runtime.settlePending(parent.id); await h.runtime.adopt(h.workId, parent.id);
const state = await h.state.get(h.workId); assert.ok(state);
const source = state.attempts.find(attempt => attempt.id === parent.id)!;
assert.equal(source.status, 'partial'); assert.equal(source.effectState, 'confirmed'); assert.ok(source.computerUse); assert.ok(source.resultArtifact);
assert.deepEqual((await computerResult(h, source.id)).evidence, []);
parentAttemptId = source.id; parentDigest = h.services.digester.digest(asJson(source));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
parentHeadDigest = hash(await h.artifacts.get(source.computerUse.head, state.policy));
parentResultDigest = hash(await h.artifacts.get(source.resultArtifact, state.policy));
const task: TaskSpec = { id: 'continue-before-crash', toolId: 'synthetic.ui.continue', toolVersion: '1', description: 'Continue only the remaining Save input',
  input: {}, computerResume: { attemptId: source.id, checkpointId: source.computerUse.head.id, reconciliation: null },
  dependsOn: [], effect: 'write', maxAttempts: 1, satisfies: ['saved'] };
await h.runtime.submitPlan(h.workId, 'plan-before-continuation-crash', { baseStateRevision: state.revision, baseGoalRevision: state.goal.revision,
  basePlanRevision: state.plan?.revision ?? 0, reason: 'Explicit continuation recovery scenario', tasks: [task], hypotheses: [] });
const child = await h.runtime.reserve(h.workId, task.id); childAttemptId = child.id;
if (stage === 'reserved') await crash(null);
await h.runtime.execute(h.workId, child.id); await h.runtime.settlePending(child.id);
throw new Error('continuation_crash_boundary_not_reached');
