import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ComputerDriver } from '../application/computer-use-ports.js';
import type { ComputerLease, ComputerView } from '../domain/computer-use.js';
import type { ComputerOperationReceipt } from '../domain/computer-operation.js';
import { computerOperationIdentity, ComputerOperationLookupResultSchema } from '../application/computer-operation-contracts.js';
import { SyntheticComputerClock, SyntheticComputerDriver } from '../infrastructure/synthetic-computer-driver.js';

const signal = () => new AbortController().signal;
const authorize = async () => {};
const limits = { maxElements: 40, maxBytes: 32768 };
type Request = Parameters<ComputerDriver['act']>[1];
type Stored = { epoch: number; app: { note: string; inputCount: number; resultsReady: boolean }; receipts: ComputerOperationReceipt[] };
async function fixture(t: TestContext, searchDelayMs = 0) {
  const directory = await mkdtemp(join(tmpdir(), 'synthetic-computer-storage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = join(directory, 'app.json'); const clock = new SyntheticComputerClock(100);
  const driver = new SyntheticComputerDriver({ stateFile, clock, searchDelayMs });
  const lease = await acquire(driver, 'original-writer');
  return { directory, stateFile, clock, driver, lease };
}
function acquire(driver: SyntheticComputerDriver, attemptId: string): Promise<ComputerLease> {
  return driver.acquire({ sessionId: driver.sessionId, workId: 'work', attemptId, deadlineAt: 2000 }, signal());
}
function request(view: ComputerView, name: string, operationId: string, value?: string): Request {
  const element = view.elements.find(item => item.name === name); assert.ok(element);
  const target = { role: element.role, name: element.name };
  return { operationId, basis: structuredClone(view), targetRef: element.ref,
    action: value === undefined ? { kind: 'click', target } : { kind: 'fill', target, value }, deadlineAt: 1500 };
}

test('synthetic computer storage: reopening prevents the stale owner from publishing its old app as a fresh observation', { concurrency: false }, async t => {
  const h = await fixture(t); const before = await h.driver.observe(h.lease, limits, signal());
  const resumed = new SyntheticComputerDriver({ stateFile: h.stateFile, clock: h.clock });
  resumed.mutate({ note: 'current reopened app' }); const reader = await acquire(resumed, 'new-owner');
  const bytes = await readFile(h.stateFile); const current = await resumed.observe(reader, limits, signal());
  assert.ok(current.view.epoch > before.view.epoch);
  assert.equal(current.view.elements.find(element => element.name === 'Note')?.value, 'current reopened app');
  await assert.rejects(h.driver.observe(h.lease, limits, signal()), /computer_stale_session/);
  assert.deepEqual(await readFile(h.stateFile), bytes);
  assert.equal(resumed.snapshot().inputCount, 0, 'observation and ownership checks must not manufacture an input');
});

test('synthetic computer storage: stale delayed search interrupts waiters without throwing or overwriting the reopened file', { concurrency: false, timeout: 5000 }, async t => {
  const h = await fixture(t, 100); const initial = await h.driver.observe(h.lease, limits, signal());
  const search = request(initial.view, 'Search', 'delayed-search');
  assert.equal((await h.driver.act(h.lease, search, signal(), authorize)).status, 'applied');
  const waitingView = await h.driver.observe(h.lease, limits, signal()); assert.equal(waitingView.view.facts.resultsReady, false);
  const pending = h.driver.wait(h.lease, { afterRevision: waitingView.view.revision, maxWaitMs: 500, deadlineAt: 1500 }, signal());
  const resumed = new SyntheticComputerDriver({ stateFile: h.stateFile, clock: h.clock }); resumed.mutate({ note: 'new owner retained state' });
  const bytes = await readFile(h.stateFile); const snapshot = resumed.snapshot();
  assert.doesNotThrow(() => h.clock.advance(700), 'the old scheduled write must not abort remaining clock callbacks');
  assert.equal((await pending).status, 'interrupted'); assert.equal(h.driver.snapshot().lease, null);
  assert.deepEqual(await readFile(h.stateFile), bytes); assert.equal(resumed.snapshot().note, snapshot.note);
  assert.equal(resumed.snapshot().inputCount, 1); assert.equal(resumed.snapshot().resultsReady, false);
  assert.doesNotThrow(() => h.clock.advance(100)); assert.deepEqual(await readFile(h.stateFile), bytes);
});

test('synthetic computer storage: lost directory-sync acknowledgement preserves an applied receipt while blocking new inputs', { concurrency: false }, async t => {
  const h = await fixture(t); const observed = await h.driver.observe(h.lease, limits, signal());
  const input = request(observed.view, 'Note', 'rename-before-sync-failure', 'persisted before acknowledgement');
  const identity = computerOperationIdentity(h.lease, input); const originalSync = fs.fsyncSync;
  let failedDirectorySyncs = 0;
  try {
    fs.fsyncSync = fd => {
      if (fs.fstatSync(fd).isDirectory()) { failedDirectorySyncs++; throw new Error('injected_directory_sync_failure'); }
      originalSync(fd);
    };
    syncBuiltinESMExports();
    const response = await h.driver.act(h.lease, input, signal(), authorize);
    assert.equal(response.status, 'unknown'); assert.equal(response.reason, 'computer_driver_failure');
  } finally {
    fs.fsyncSync = originalSync; syncBuiltinESMExports();
  }
  assert.equal(failedDirectorySyncs, 1, 'the failure occurs after the temp file sync and rename');
  assert.strictEqual(fs.fsyncSync, originalSync);
  const bytes = await readFile(h.stateFile); const persisted = JSON.parse(bytes.toString()) as Stored;
  assert.equal(persisted.app.note, 'persisted before acknowledgement'); assert.equal(persisted.app.inputCount, 1);
  assert.equal(persisted.receipts.length, 1); assert.equal(persisted.receipts[0]!.outcome, 'applied');
  const lookup = ComputerOperationLookupResultSchema.parse(await h.driver.lookup(h.lease, { identity }, signal(), authorize));
  assert.equal(lookup.status, 'found'); assert.ok(lookup.receipt); assert.equal(lookup.receipt.outcome, 'applied');
  assert.deepEqual(lookup.receipt.identity, identity); assert.equal(lookup.receipt.effectSequence, 1);
  await assert.rejects(h.driver.observe(h.lease, limits, signal()), /computer_storage_uncertain/);
  const refused = await h.driver.act(h.lease, request(observed.view, 'Note', 'new-input-after-storage-uncertain', 'must not overwrite'), signal(), authorize);
  assert.notEqual(refused.status, 'applied'); assert.deepEqual(await readFile(h.stateFile), bytes);
  const afterRefusal = await h.driver.lookup(h.lease, { identity }, signal(), authorize);
  assert.equal(afterRefusal.status, 'found'); assert.equal(afterRefusal.receipt?.outcome, 'applied');
  assert.deepEqual(await readFile(h.stateFile), bytes);
  const resumed = new SyntheticComputerDriver({ stateFile: h.stateFile, clock: h.clock }); const reader = await acquire(resumed, 'recovery-reader');
  const recovered = await resumed.lookup(reader, { identity }, signal(), authorize);
  assert.equal(recovered.status, 'found'); assert.equal(recovered.receipt?.outcome, 'applied');
  assert.equal(resumed.snapshot().inputCount, 1); assert.equal(resumed.snapshot().note, persisted.app.note);
});
