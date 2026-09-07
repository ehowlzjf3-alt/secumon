import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ComputerDriver } from '../../application/computer-use-ports.js';
import type { ComputerReconciliation } from '../../domain/computer-reconciliation.js';
import { asJson } from '../../application/plan-validator.js';
import { SyntheticComputerClock, SyntheticComputerDriver } from '../../infrastructure/synthetic-computer-driver.js';
import { computerActor, computerActInput, computerHarness, observeComputer, saveNoteSteps, submitComputerTask,
  type ComputerBackend } from '../computer-use-helpers.js';

export type ReconciliationCrashStage = 'reserved' | 'dispatched' | 'received' | 'settled';
export interface ReconciliationCrashMarker {
  schemaVersion: 1;
  stage: ReconciliationCrashStage;
  backend: ComputerBackend;
  workId: string;
  commandId: string;
  record: ComputerReconciliation;
  sourceDigest: string;
  sourceHeadDigest: string;
  sourceResultDigest: string;
  at: number;
  epoch: number;
  lookupCalls: number;
  inputCount: number;
  saveCount: number;
}

const directory = process.argv[2]; const backend = process.argv[3]; const stage = process.argv[4];
if (!directory || (backend !== 'sqlite' && backend !== 'file-journal') ||
  !['reserved', 'dispatched', 'received', 'settled'].includes(stage ?? '')) throw new Error('invalid_reconciliation_crash_arguments');
const clock = new SyntheticComputerClock(1000);
const driver = new SyntheticComputerDriver({ clock, stateFile: join(directory, 'app.json') });
let lookupCalls = 0; let reconciliationId = ''; let sourceDigest = ''; let sourceHeadDigest = ''; let sourceResultDigest = '';
const commandId = 'explicit-before-crash';
const adapter: ComputerDriver = {
  identity: driver.identity, acquire: driver.acquire.bind(driver), observe: driver.observe.bind(driver),
  act: driver.act.bind(driver), wait: driver.wait.bind(driver), release: driver.release.bind(driver),
  async lookup(...args) {
    lookupCalls++;
    const result = await driver.lookup(...args);
    // The read reached the driver, but its response has not reached the runtime receive commit.
    if (stage === 'dispatched') await crash();
    return result;
  },
};
const h = await computerHarness(backend, { directory, clock, driver: adapter });

async function crash(): Promise<never> {
  const state = await h.state.get(h.workId); assert.ok(state);
  const record = state.computerReconciliations?.find(value => value.id === reconciliationId); assert.ok(record);
  const snapshot = driver.snapshot();
  assert.equal(record.status, stage === 'dispatched' ? 'running' : stage);
  assert.ok(await h.state.receipt(h.workId, `reconcile-reserve:${record.id}`));
  if (stage !== 'reserved') assert.ok(await h.state.receipt(h.workId, `reconcile-dispatch:${record.id}`));
  assert.equal(Boolean(await h.state.receipt(h.workId, `reconcile-receive:${record.id}`)), stage === 'received' || stage === 'settled');
  assert.equal(Boolean(await h.state.receipt(h.workId, `reconcile-settle:${record.id}`)), stage === 'settled');
  assert.equal(snapshot.inputCount, 2); assert.equal(snapshot.saveCount, 1);
  assert.equal(lookupCalls, stage === 'reserved' ? 0 : 1);
  const marker: ReconciliationCrashMarker = { schemaVersion: 1, stage: stage as ReconciliationCrashStage,
    backend: backend as ComputerBackend, workId: h.workId, commandId, record, sourceDigest, sourceHeadDigest, sourceResultDigest,
    at: clock.now(), epoch: snapshot.epoch, lookupCalls, inputCount: snapshot.inputCount, saveCount: snapshot.saveCount };
  const fd = openSync(join(directory!, 'reconciliation-crash-marker.json'), 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(marker)); fsyncSync(fd); } finally { closeSync(fd); }
  const folder = openSync(directory!, 'r'); try { fsyncSync(folder); } finally { closeSync(folder); }
  process.kill(process.pid, 'SIGKILL');
  throw new Error('reconciliation_crash_signal_did_not_stop_process');
}

driver.injectNextAction({}); driver.injectNextAction({ outcome: 'applied_unknown' });
const observed = await observeComputer(h);
const attempt = await submitComputerTask(h, 'act', computerActInput(observed.observationId, saveNoteSteps));
await h.runtime.execute(h.workId, attempt.id); await h.runtime.settlePending(attempt.id); await h.runtime.adopt(h.workId, attempt.id);
assert.deepEqual(await h.runtime.step(h.workId), { kind: 'blocked', reason: 'effect_unknown' });
const state = await h.state.get(h.workId); assert.ok(state);
const source = state.attempts.find(value => value.id === attempt.id)!;
assert.ok(source.computerUse); assert.ok(source.resultArtifact); assert.equal(source.adopted, false); assert.equal(source.effectState, 'unknown');
sourceDigest = h.services.digester.digest(asJson(source));
sourceHeadDigest = createHash('sha256').update(await h.artifacts.get(source.computerUse.head, state.policy)).digest('hex');
sourceResultDigest = createHash('sha256').update(await h.artifacts.get(source.resultArtifact, state.policy)).digest('hex');
const record = await h.computerReconciliations.reserve(h.workId, commandId, computerActor,
  { attemptId: source.id, checkpointId: source.computerUse.head.id });
reconciliationId = record.id; assert.equal(record.status, 'reserved');
if (stage === 'reserved') await crash();
const received = await h.computerReconciliations.execute(h.workId, record.id, computerActor);
if (stage === 'dispatched') throw new Error('reconciliation_lookup_crash_hook_was_not_reached');
assert.equal(received.status, 'received'); assert.equal(received.outcome, 'applied'); assert.ok(received.responseArtifact);
if (stage === 'received') await crash();
const settled = await h.computerReconciliations.settle(h.workId, record.id, computerActor);
assert.equal(settled.status, 'settled'); assert.equal(await h.computerReconciliations.current((await h.state.get(h.workId))!), true);
await crash();
