import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ComputerDriver } from '../application/computer-use-ports.js';
import { ComputerOperationIdentitySchema, ComputerOperationLookupResultSchema, ComputerOperationReceiptSchema } from '../application/computer-operation-contracts.js';
import { SyntheticComputerClock, SyntheticComputerDriver } from '../infrastructure/synthetic-computer-driver.js';
import type { ComputerOperationCrashMarker } from './helpers/computer-operation-crash-child.js';

async function stoppedChild(directory: string, stage: ComputerOperationCrashMarker['stage']): Promise<ComputerOperationCrashMarker> {
  const child = fork(new URL('./helpers/computer-operation-crash-child.js', import.meta.url), [directory, stage], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout!.resume(); let stderr = ''; let timedOut = false;
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 30000);
  try {
    const [code, signal] = await once(child, 'exit');
    assert.equal(timedOut, false, `The requested durable input boundary was not reached: ${stderr}`);
    assert.equal(code, null, stderr); assert.equal(signal, 'SIGKILL', stderr);
    const marker = JSON.parse(await readFile(join(directory, 'operation-crash-marker.json'), 'utf8')) as ComputerOperationCrashMarker;
    assert.equal(marker.schemaVersion, 1); assert.equal(marker.stage, stage); assert.equal(marker.driver.version, '2');
    assert.equal(marker.identity.workId, 'receipt-work'); assert.equal(marker.identity.attemptId, 'original-input-attempt');
    assert.equal(marker.identity.operationId, 'original-save'); assert.equal(marker.epoch, marker.identity.epoch);
    assert.deepEqual(ComputerOperationIdentitySchema.parse(marker.identity), marker.identity);
    assert.equal(marker.targetActCalled, stage === 'receipt-durable');
    return marker;
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit').catch(() => {}); }
  }
}

async function reopen(t: TestContext, stage: ComputerOperationCrashMarker['stage']) {
  const directory = await mkdtemp(join(tmpdir(), 'computer-operation-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = await stoppedChild(directory, stage); const stateFile = join(directory, 'app.json');
  const file = JSON.parse(await readFile(stateFile, 'utf8')) as { version: number; epoch: number;
    app: { inputCount: number; saveCount: number; note: string; savedNote: string }; receipts: unknown[] };
  assert.equal(file.version, 2); assert.equal(file.epoch, marker.epoch); assert.ok(Array.isArray(file.receipts));
  assert.equal(file.app.inputCount, marker.inputCount); assert.equal(file.app.saveCount, marker.saveCount);
  const receipts = file.receipts.map(value => ComputerOperationReceiptSchema.parse(value));
  const clock = new SyntheticComputerClock(marker.at);
  const driver = new SyntheticComputerDriver({ clock, stateFile }); const port: ComputerDriver = driver;
  assert.ok(port.lookup, 'The reopened driver must expose receipt lookup'); const lookup = port.lookup.bind(port);
  assert.ok(driver.snapshot().epoch > marker.epoch);
  const lease = await driver.acquire({ sessionId: marker.identity.sessionId, workId: marker.identity.workId,
    attemptId: 'new-receipt-read-attempt', deadlineAt: clock.now() + 1000 }, new AbortController().signal);
  assert.equal(lease.workId, marker.identity.workId); assert.notEqual(lease.attemptId, marker.identity.attemptId); assert.notEqual(lease.epoch, marker.identity.epoch);
  const persistedBeforeLookup = await readFile(stateFile);
  return { driver, lookup, lease, marker, stateFile, file, receipts, persistedBeforeLookup };
}

test('SIGKILL after durable Save permits exact original receipt lookup in a new epoch without replaying input', { timeout: 45000 }, async t => {
  const f = await reopen(t, 'receipt-durable');
  assert.equal(f.marker.inputCount, 2); assert.equal(f.marker.saveCount, 1); assert.equal(f.file.app.savedNote, 'persisted receipt note');
  const persisted = f.receipts.find(value => value.identity.operationId === f.marker.identity.operationId); assert.ok(persisted);
  assert.deepEqual(persisted.identity, f.marker.identity); assert.deepEqual(persisted.driver, f.marker.driver);
  assert.equal(persisted.outcome, 'applied'); assert.equal(persisted.effectSequence, 2);
  let authorizations = 0; const authorizeRead = async () => { authorizations++; };
  for (let repeat = 0; repeat < 2; repeat++) {
    const response = ComputerOperationLookupResultSchema.parse(await f.lookup(f.lease, { identity: structuredClone(f.marker.identity) }, new AbortController().signal, authorizeRead));
    assert.equal(response.status, 'found'); assert.ok(response.status === 'found');
    assert.deepEqual(response.receipt, persisted); assert.equal(response.receipt.outcome, 'applied'); assert.equal(response.receipt.effectSequence, 2);
    assert.equal(response.usage.transportCalls, 1); assert.equal(response.usage.imageBytes, 0); assert.equal(response.usage.waitMs, 0);
  }
  assert.equal(authorizations, 2);
  for (const identity of [{ ...f.marker.identity, epoch: f.lease.epoch }, { ...f.marker.identity, operationId: 'different-operation' }]) {
    const response = await f.lookup(f.lease, { identity }, new AbortController().signal, authorizeRead);
    assert.equal(response.status, 'unknown'); assert.equal(response.receipt, null);
  }
  assert.deepEqual(await readFile(f.stateFile), f.persistedBeforeLookup);
  assert.equal(f.driver.snapshot().inputCount, 2); assert.equal(f.driver.snapshot().saveCount, 1);
  assert.equal(f.driver.snapshot().savedNote, 'persisted receipt note'); assert.deepEqual(f.driver.snapshot().invocations, []);
  await f.driver.release(f.lease);
  assert.equal(f.driver.snapshot().inputCount, 2); assert.equal(f.driver.snapshot().saveCount, 1);
});

test('SIGKILL before Save leaves an absent receipt unknown rather than inventing a not-applied receipt', { timeout: 45000 }, async t => {
  const f = await reopen(t, 'before-input');
  assert.equal(f.marker.inputCount, 1); assert.equal(f.marker.saveCount, 0);
  assert.equal(f.file.app.note, 'persisted receipt note'); assert.equal(f.file.app.savedNote, '');
  assert.equal(f.receipts.some(value => value.identity.operationId === f.marker.identity.operationId), false);
  assert.ok(f.receipts.some(value => value.identity.operationId === 'prepare-note' && value.outcome === 'applied'));
  for (let repeat = 0; repeat < 2; repeat++) {
    const response = ComputerOperationLookupResultSchema.parse(await f.lookup(f.lease, { identity: f.marker.identity }, new AbortController().signal, async () => {}));
    assert.equal(response.status, 'unknown'); assert.equal(response.receipt, null);
    assert.equal(response.usage.transportCalls, 1); assert.equal(response.usage.imageBytes, 0); assert.equal(response.usage.waitMs, 0);
  }
  assert.deepEqual(await readFile(f.stateFile), f.persistedBeforeLookup);
  assert.equal(f.driver.snapshot().inputCount, 1); assert.equal(f.driver.snapshot().saveCount, 0); assert.deepEqual(f.driver.snapshot().invocations, []);
  await f.driver.release(f.lease);
});
