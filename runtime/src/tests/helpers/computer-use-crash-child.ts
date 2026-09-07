import assert from 'node:assert/strict';
import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { executionControl } from '../../domain/execution-policy.js';
import { SyntheticComputerClock, SyntheticComputerDriver } from '../../infrastructure/synthetic-computer-driver.js';
import { computerActor, computerActInput, computerHarness, observeComputer, saveNoteSteps, submitComputerTask,
  type ComputerBackend } from '../computer-use-helpers.js';

export interface ComputerCrashMarker {
  schemaVersion: 1;
  stage: 'save-applied' | 'result-stored';
  backend: ComputerBackend;
  workId: string;
  attemptId: string;
  observationId: string;
  operationId: string | null;
  resultArtifactId: string | null;
  leaseUntil: number;
  at: number;
  epoch: number;
  inputCount: number;
  saveCount: number;
}

const directory = process.argv[2];
const backend = process.argv[3];
const stage = process.argv[4];
if (!directory || (backend !== 'sqlite' && backend !== 'file-journal') || (stage !== 'save-applied' && stage !== 'result-stored'))
  throw new Error('invalid_computer_crash_arguments');
const clock = new SyntheticComputerClock(1000);
let observationId = ''; let attemptId = ''; let leaseUntil = 0;

function crash(operationId: string | null, resultArtifactId: string | null): never {
  const snapshot = driver.snapshot();
  const marker: ComputerCrashMarker = { schemaVersion: 1, stage: stage as ComputerCrashMarker['stage'], backend: backend as ComputerBackend,
    workId: 'computer-work', attemptId, observationId, operationId, resultArtifactId, leaseUntil, at: clock.now(),
    epoch: snapshot.epoch, inputCount: snapshot.inputCount, saveCount: snapshot.saveCount };
  assert.ok(attemptId && observationId); assert.equal(snapshot.inputCount, 2); assert.equal(snapshot.saveCount, 1);
  const fd = openSync(join(directory!, 'crash-marker.json'), 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(marker)); fsyncSync(fd); } finally { closeSync(fd); }
  const folder = openSync(directory!, 'r'); try { fsyncSync(folder); } finally { closeSync(folder); }
  process.kill(process.pid, 'SIGKILL');
  throw new Error('computer_crash_signal_did_not_stop_process');
}

const driver = new SyntheticComputerDriver({ clock, stateFile: join(directory, 'app.json'), onActApplied: event => {
  if (stage === 'save-applied' && event.action.kind === 'click' && event.action.target.name === 'Save') {
    assert.equal(event.attemptId, attemptId); assert.equal(event.saveCount, 1);
    crash(event.operationId, null);
  }
} });
const h = await computerHarness(backend, { directory, clock, driver });
if (stage === 'result-stored') {
  // Leave a genuine unmet condition after Save so a new same-goal task can reach the stale-epoch gate.
  const initial = await h.runtime.state(h.workId);
  await h.runtime.command(h.workId, 'require-search-after-save', computerActor, initial.goal.revision, {
    kind: 'goal', expectedControlRevision: executionControl(initial).revision,
    goal: { ...initial.goal, revision: initial.goal.revision + 1, criteria: [...initial.goal.criteria, {
      id: 'searched', description: 'The separate search result is ready', key: 'resultsReady', operator: 'equals', equals: true,
      minIndependentSources: 1, requireCompleteCoverage: true,
    }] },
  });
}
const observation = await observeComputer(h); observationId = observation.observationId;
const attempt = await submitComputerTask(h, 'act', computerActInput(observationId, saveNoteSteps));
attemptId = attempt.id; leaseUntil = attempt.leaseUntil;
await h.runtime.execute(h.workId, attemptId); await h.runtime.settlePending(attemptId);
if (stage === 'save-applied') throw new Error('computer_save_crash_hook_was_not_reached');
const state = await h.runtime.state(h.workId); const received = state.attempts.find(value => value.id === attemptId)!;
assert.equal(received.status, 'received'); assert.equal(received.adopted, false); assert.ok(received.resultArtifact);
assert.ok(await h.state.receipt(h.workId, `receive:${attemptId}`));
crash(null, received.resultArtifact.id);
