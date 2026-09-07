import assert from 'node:assert/strict';
import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ComputerDriverIdentity, ComputerLease } from '../../domain/computer-use.js';
import type { ComputerOperationIdentity } from '../../domain/computer-operation.js';
import { computerOperationIdentity } from '../../application/computer-operation-contracts.js';
import { SyntheticComputerClock, SyntheticComputerDriver } from '../../infrastructure/synthetic-computer-driver.js';

export interface ComputerOperationCrashMarker {
  schemaVersion: 1;
  stage: 'before-input' | 'receipt-durable';
  driver: ComputerDriverIdentity;
  identity: ComputerOperationIdentity;
  originalLease: ComputerLease;
  epoch: number;
  at: number;
  inputCount: number;
  saveCount: number;
  targetActCalled: boolean;
}

const directory = process.argv[2]; const stage = process.argv[3];
if (!directory || (stage !== 'before-input' && stage !== 'receipt-durable')) throw new Error('invalid_operation_crash_arguments');
const clock = new SyntheticComputerClock(1000); const signal = new AbortController().signal;
const authorize = async () => {};
let original: ComputerOperationIdentity | null = null;
let originalLease: ComputerLease | null = null;
let targetActCalled = false;

function crash(): never {
  assert.ok(original && originalLease);
  const snapshot = driver.snapshot();
  const marker: ComputerOperationCrashMarker = { schemaVersion: 1, stage: stage as ComputerOperationCrashMarker['stage'],
    driver: driver.identity, identity: original, originalLease, epoch: snapshot.epoch, at: clock.now(),
    inputCount: snapshot.inputCount, saveCount: snapshot.saveCount, targetActCalled };
  assert.equal(marker.inputCount, stage === 'before-input' ? 1 : 2);
  assert.equal(marker.saveCount, stage === 'before-input' ? 0 : 1);
  const file = openSync(join(directory!, 'operation-crash-marker.json'), 'wx', 0o600);
  try { writeFileSync(file, JSON.stringify(marker)); fsyncSync(file); } finally { closeSync(file); }
  const folder = openSync(directory!, 'r'); try { fsyncSync(folder); } finally { closeSync(folder); }
  process.kill(process.pid, 'SIGKILL');
  throw new Error('operation_crash_signal_did_not_stop_process');
}

const driver = new SyntheticComputerDriver({ clock, stateFile: join(directory, 'app.json'), onActApplied: event => {
  if (event.action.kind === 'click' && event.action.target.name === 'Save') {
    assert.equal(stage, 'receipt-durable'); assert.equal(event.operationId, original!.operationId);
    assert.equal(event.attemptId, original!.attemptId); assert.equal(event.inputCount, 2); assert.equal(event.saveCount, 1);
    crash();
  }
} });
originalLease = await driver.acquire({ sessionId: driver.sessionId, workId: 'receipt-work', attemptId: 'original-input-attempt', deadlineAt: 2000 }, signal);
let view = (await driver.observe(originalLease, { maxElements: 20, maxBytes: 20000 }, signal)).view;
const note = view.elements.find(value => value.role === 'textbox' && value.name === 'Note')!;
const prepared = await driver.act(originalLease, { operationId: 'prepare-note', basis: view, targetRef: note.ref,
  action: { kind: 'fill', target: { role: note.role, name: note.name }, value: 'persisted receipt note' }, deadlineAt: 2000 }, signal, authorize);
assert.equal(prepared.status, 'applied');
view = (await driver.observe(originalLease, { maxElements: 20, maxBytes: 20000 }, signal)).view;
const save = view.elements.find(value => value.role === 'button' && value.name === 'Save')!;
const request = { operationId: 'original-save', basis: view, targetRef: save.ref,
  action: { kind: 'click' as const, target: { role: save.role, name: save.name } }, deadlineAt: 2000 };
original = computerOperationIdentity(originalLease, request);
if (stage === 'before-input') crash();
targetActCalled = true;
await driver.act(originalLease, request, signal, authorize);
throw new Error('operation_durable_crash_hook_was_not_reached');
