import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ComputerDriver } from '../application/computer-use-ports.js';
import { computerOperationIdentity, ComputerOperationLookupResultSchema, ComputerOperationReceiptSchema } from '../application/computer-operation-contracts.js';
import type { ComputerOperationIdentity, ComputerOperationLookupResult, ComputerOperationReceipt } from '../domain/computer-operation.js';
import type { ComputerAction, ComputerLease, ComputerView } from '../domain/computer-use.js';
import { SyntheticComputerClock, SyntheticComputerDriver, type SyntheticComputerOptions } from '../infrastructure/synthetic-computer-driver.js';

const authorize = async () => {};
const signal = () => new AbortController().signal;
const limits = { maxElements: 40, maxBytes: 32768 };
type Request = Parameters<ComputerDriver['act']>[1];
type Options = SyntheticComputerOptions & { receiptLimit?: number };
type Stored = { version: number; epoch: number; app: { query: string; note: string; resultsReady: boolean; savedNote: string; saveCount: number; inputCount: number };
  receipts: ComputerOperationReceipt[] };

async function file(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'synthetic-receipts-'));
  t.after(() => rm(directory, { recursive: true, force: true })); return join(directory, 'app.json');
}
async function fixture(options: Options = {}) {
  const clock = options.clock ?? new SyntheticComputerClock(100);
  const driver = new SyntheticComputerDriver({ ...options, clock });
  const lease = await driver.acquire({ sessionId: driver.sessionId, workId: 'work-1', attemptId: 'writer-1', deadlineAt: 1000 }, signal());
  return { driver, clock, lease };
}
function request(view: ComputerView, name: string, operationId: string, value?: string): Request {
  const element = view.elements.find(item => item.name === name); assert.ok(element);
  const target = { role: element.role, name: element.name };
  const action: ComputerAction = value === undefined ? { kind: 'click', target } : { kind: 'fill', target, value };
  return { operationId, basis: structuredClone(view), targetRef: element.ref, action, deadlineAt: 1000 };
}
async function act(driver: SyntheticComputerDriver, lease: ComputerLease, name: string, operationId: string, value?: string) {
  const { view } = await driver.observe(lease, limits, signal()); const input = request(view, name, operationId, value);
  const identity = computerOperationIdentity(lease, input);
  const result = await driver.act(lease, input, signal(), authorize); return { identity, input, result };
}
async function lookup(driver: SyntheticComputerDriver, lease: ComputerLease, identity: ComputerOperationIdentity,
  readSignal = signal(), authorizeRead: () => Promise<void> = authorize): Promise<ComputerOperationLookupResult> {
  const port: ComputerDriver = driver; assert.equal(typeof port.lookup, 'function', 'the registered synthetic driver provides receipt lookup');
  const result = await port.lookup!(lease, { identity }, readSignal, authorizeRead);
  assert.equal(ComputerOperationLookupResultSchema.safeParse(result).success, true);
  return result;
}
function found(result: ComputerOperationLookupResult, identity: ComputerOperationIdentity, outcome: ComputerOperationReceipt['outcome']) {
  assert.equal(result.status, 'found'); assert.ok(result.receipt); assert.equal(result.reason, null);
  assert.deepEqual(result.receipt.identity, identity); assert.equal(result.receipt.outcome, outcome);
  assert.equal(ComputerOperationReceiptSchema.safeParse(result.receipt).success, true);
  assert.deepEqual(result.receipt.driver, { id: 'synthetic-document-app', version: '2' });
  assert.equal(result.usage.transportCalls, 1); assert.ok(result.usage.internalOperations! >= 1);
  assert.equal(result.usage.imageBytes, 0); assert.equal(result.usage.waitMs, 0);
  return result.receipt;
}
function unknown(result: ComputerOperationLookupResult) {
  assert.equal(result.status, 'unknown'); assert.equal(result.receipt, null);
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0 && result.reason.length <= 256);
}
function app(driver: SyntheticComputerDriver) {
  const state = driver.snapshot();
  return { query: state.query, note: state.note, savedNote: state.savedNote, resultsReady: state.resultsReady,
    inputCount: state.inputCount, saveCount: state.saveCount, epoch: state.epoch, revision: state.viewRevision,
    focusRevision: state.focusRevision, owner: state.owner, lease: state.lease };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test('synthetic receipts: applied and explicitly not-applied records are durable before response and lookup changes no app bytes', async t => {
  const stateFile = await file(t); let observedAtomicSave = false;
  const { driver, lease } = await fixture({ stateFile, onActApplied: event => {
    if (event.action.kind !== 'click' || event.action.target.name !== 'Save') return;
    const persisted = JSON.parse(readFileSync(stateFile, 'utf8')) as Stored;
    assert.equal(persisted.version, 2); assert.equal(persisted.app.inputCount, event.inputCount); assert.equal(persisted.app.saveCount, event.saveCount);
    assert.equal(persisted.receipts.find(receipt => receipt.identity.operationId === event.operationId)?.outcome, 'applied');
    observedAtomicSave = true;
  } });
  const filled = await act(driver, lease, 'Note', 'fill', 'reviewed'); assert.equal(filled.result.status, 'applied');
  driver.injectNextAction({ outcome: 'not_applied_timeout' });
  const refused = await act(driver, lease, 'Save', 'refused-save'); assert.equal(refused.result.status, 'not_applied');
  const saved = await act(driver, lease, 'Save', 'save'); assert.equal(saved.result.status, 'applied'); assert.equal(observedAtomicSave, true);
  const before = app(driver); const bytes = await readFile(stateFile); const calls = driver.snapshot().usage.transportCalls;
  assert.equal(found(await lookup(driver, lease, filled.identity), filled.identity, 'applied').effectSequence, 1);
  assert.equal(found(await lookup(driver, lease, refused.identity), refused.identity, 'not_applied').effectSequence, 1);
  assert.equal(found(await lookup(driver, lease, saved.identity), saved.identity, 'applied').effectSequence, 2);
  assert.equal(driver.snapshot().usage.transportCalls - calls, 3); assert.deepEqual(app(driver), before); assert.deepEqual(await readFile(stateFile), bytes);
  const persisted = JSON.parse(bytes.toString()) as Stored; assert.equal(persisted.receipts.length, 3);
});

test('synthetic receipts: applied-unknown and negative receipts remain queryable by their original epoch after restart', async t => {
  const stateFile = await file(t); const original = await fixture({ stateFile });
  await act(original.driver, original.lease, 'Note', 'fill', 'retained note');
  original.driver.injectNextAction({ outcome: 'not_applied_timeout' }); const refused = await act(original.driver, original.lease, 'Save', 'refused');
  original.driver.injectNextAction({ outcome: 'applied_unknown' }); const saved = await act(original.driver, original.lease, 'Save', 'uncertain-save');
  assert.equal(saved.result.status, 'unknown'); assert.equal(original.driver.snapshot().saveCount, 1);
  const first = found(await lookup(original.driver, original.lease, saved.identity), saved.identity, 'applied');
  const restarted = new SyntheticComputerDriver({ stateFile, clock: original.clock });
  assert.ok(restarted.snapshot().epoch > original.lease.epoch);
  const reader = await restarted.acquire({ sessionId: restarted.sessionId, workId: 'work-1', attemptId: 'reader-2', deadlineAt: 1000 }, signal());
  assert.notEqual(reader.attemptId, saved.identity.attemptId); assert.notEqual(reader.epoch, saved.identity.epoch);
  const bytes = await readFile(stateFile); const before = app(restarted);
  assert.deepEqual(found(await lookup(restarted, reader, saved.identity), saved.identity, 'applied'), first);
  found(await lookup(restarted, reader, refused.identity), refused.identity, 'not_applied');
  assert.deepEqual(app(restarted), before); assert.deepEqual(await readFile(stateFile), bytes);
  assert.equal(restarted.snapshot().inputCount, 2); assert.equal(restarted.snapshot().saveCount, 1);
  assert.deepEqual(restarted.snapshot().invocations, []);
});

test('synthetic receipts: missing identities and changed action, target, view or focus never inherit another receipt', async () => {
  const { driver, lease } = await fixture(); const saved = await act(driver, lease, 'Note', 'exact-input', 'same visible value');
  const original = found(await lookup(driver, lease, saved.identity), saved.identity, 'applied');
  const alternatives: ComputerOperationIdentity[] = [
    { ...saved.identity, operationId: 'never-sent' }, { ...saved.identity, attemptId: 'never-ran' },
    { ...saved.identity, epoch: saved.identity.epoch + 1 }, { ...saved.identity, surfaceId: 'other-surface' },
    { ...saved.identity, viewRevision: saved.identity.viewRevision + 1 }, { ...saved.identity, focusRevision: saved.identity.focusRevision + 1 },
    { ...saved.identity, targetRef: 'another-ref' },
    { ...saved.identity, action: { kind: 'fill', target: saved.identity.action.target, value: 'changed input' } },
  ];
  const before = app(driver);
  for (const identity of alternatives) { unknown(await lookup(driver, lease, identity)); assert.deepEqual(app(driver), before); }
  const conflict = await driver.act(lease, { ...saved.input, targetRef: 'another-ref' }, signal(), authorize);
  assert.equal(conflict.status, 'unknown'); assert.deepEqual(app(driver), before);
  assert.deepEqual(found(await lookup(driver, lease, saved.identity), saved.identity, 'applied'), original);
});

test('synthetic receipts: another work cannot read an original receipt even with a valid current session grant', async () => {
  const { driver, lease } = await fixture(); const saved = await act(driver, lease, 'Save', 'private-operation');
  await driver.release(lease);
  const foreign = await driver.acquire({ sessionId: driver.sessionId, workId: 'work-2', attemptId: 'foreign-reader', deadlineAt: 1000 }, signal());
  const before = app(driver);
  unknown(await lookup(driver, foreign, saved.identity));
  unknown(await lookup(driver, foreign, { ...saved.identity, workId: 'work-2' }));
  unknown(await lookup(driver, { ...foreign, workId: 'work-1' }, saved.identity));
  assert.deepEqual(app(driver), before); assert.equal(driver.snapshot().inputCount, 1); assert.equal(driver.snapshot().saveCount, 1);
});

test('synthetic receipts: denied or missing read authority, cancelled signals and expired grants disclose no receipt', async () => {
  for (const reason of ['denied', 'missing-authority', 'cancelled', 'expired'] as const) {
    const { driver, lease, clock } = await fixture(); const saved = await act(driver, lease, 'Save', 'save'); const abort = new AbortController();
    if (reason === 'cancelled') abort.abort(); if (reason === 'expired') clock.advance(900);
    const before = app(driver);
    const authorizeRead = reason === 'denied' ? async () => { throw new Error('private permission detail must not escape'); } :
      reason === 'missing-authority' ? undefined as unknown as () => Promise<void> : authorize;
    const result = reason === 'missing-authority'
      ? await (driver as ComputerDriver).lookup!(lease, { identity: saved.identity }, abort.signal, authorizeRead)
      : await lookup(driver, lease, saved.identity, abort.signal, authorizeRead);
    assert.equal(ComputerOperationLookupResultSchema.safeParse(result).success, true);
    unknown(result); assert.equal(result.reason?.includes('private permission detail'), false); assert.deepEqual(app(driver), before);
  }
});

test('synthetic receipts: cancellation, expiry and owner replacement during read authorization are checked again', async () => {
  for (const reason of ['cancelled', 'expired', 'new-owner', 'handoff'] as const) {
    const { driver, lease, clock } = await fixture(); const saved = await act(driver, lease, 'Save', 'save'); const abort = new AbortController();
    const entered = deferred(); const release = deferred();
    const reading = lookup(driver, lease, saved.identity, abort.signal, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    if (reason === 'cancelled') abort.abort();
    if (reason === 'expired') clock.advance(900);
    if (reason === 'new-owner') { await driver.release(lease); await driver.acquire({ sessionId: driver.sessionId, workId: 'work-2', attemptId: 'new-reader', deadlineAt: 1000 }, signal()); }
    if (reason === 'handoff') driver.handoff();
    const before = app(driver); release.resolve(); unknown(await reading); assert.deepEqual(app(driver), before);
  }
});

test('synthetic receipts: a pending input lookup returns unknown without joining or executing the action', { timeout: 5000 }, async () => {
  const { driver, lease, clock } = await fixture(); const { view } = await driver.observe(lease, limits, signal());
  const input = request(view, 'Save', 'still-pending'); const identity = computerOperationIdentity(lease, input);
  driver.injectNextAction({ delayBeforeInputMs: 20 }); const pending = driver.act(lease, input, signal(), authorize);
  unknown(await lookup(driver, lease, identity)); assert.equal(clock.now(), 100); assert.equal(driver.snapshot().inputCount, 0);
  clock.advance(20); assert.equal((await pending).status, 'applied');
  found(await lookup(driver, lease, identity), identity, 'applied'); assert.equal(driver.snapshot().inputCount, 1); assert.equal(driver.snapshot().saveCount, 1);
});

test('synthetic receipts: legacy app contents migrate without inventing operation proofs from saved values or counts', async t => {
  const stateFile = await file(t);
  await writeFile(stateFile, JSON.stringify({ version: 1, epoch: 10, app: {
    query: '', note: 'legacy note', resultsReady: false, savedNote: 'legacy note', saveCount: 1, inputCount: 2,
  } }), { mode: 0o600 });
  const { driver, lease } = await fixture({ stateFile }); const { view } = await driver.observe(lease, limits, signal());
  const historical = { ...computerOperationIdentity(lease, request(view, 'Save', 'unrecorded-legacy-save')), epoch: 10, attemptId: 'legacy-attempt' };
  const bytes = await readFile(stateFile); const migrated = JSON.parse(bytes.toString()) as Stored;
  assert.equal(migrated.version, 2); assert.equal(migrated.epoch, 11); assert.deepEqual(migrated.receipts, []);
  unknown(await lookup(driver, lease, historical)); assert.deepEqual(await readFile(stateFile), bytes);
  assert.equal(driver.snapshot().savedNote, 'legacy note'); assert.equal(driver.snapshot().inputCount, 2); assert.equal(driver.snapshot().saveCount, 1);
});

test('synthetic receipts: a full bounded ledger rejects new input, keeps old proofs and remains full after reopen', async t => {
  for (const receiptLimit of [0, -1, 257, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
    assert.throws(() => new SyntheticComputerDriver({ receiptLimit } as Options));
  for (const receiptLimit of [1, 256]) assert.doesNotThrow(() => new SyntheticComputerDriver({ receiptLimit } as Options));
  const stateFile = await file(t); const { driver, lease, clock } = await fixture({ stateFile, receiptLimit: 2 });
  const filled = await act(driver, lease, 'Note', 'fill', 'saved'); const saved = await act(driver, lease, 'Save', 'save');
  const bytes = await readFile(stateFile); const before = app(driver);
  const limited = await act(driver, lease, 'Note', 'capacity-denied', 'not written'); assert.equal(limited.result.status, 'not_applied');
  assert.deepEqual(app(driver), before); unknown(await lookup(driver, lease, limited.identity));
  found(await lookup(driver, lease, filled.identity), filled.identity, 'applied'); found(await lookup(driver, lease, saved.identity), saved.identity, 'applied');
  assert.deepEqual(await readFile(stateFile), bytes); assert.equal((JSON.parse(bytes.toString()) as Stored).receipts.length, 2);
  await driver.release(lease);
  const restarted = new SyntheticComputerDriver({ stateFile, receiptLimit: 2, clock } as Options);
  const reader = await restarted.acquire({ sessionId: restarted.sessionId, workId: 'work-1', attemptId: 'reader', deadlineAt: 1000 }, signal());
  found(await lookup(restarted, reader, saved.identity), saved.identity, 'applied');
  assert.equal((await act(restarted, reader, 'Save', 'still-full')).result.status, 'not_applied');
  assert.equal(restarted.snapshot().inputCount, 2); assert.equal(restarted.snapshot().saveCount, 1);
});

test('synthetic receipts: a reopened full ledger cannot relabel an old applied command as not-applied', async t => {
  const stateFile = await file(t); const original = await fixture({ stateFile, receiptLimit: 1 });
  const saved = await act(original.driver, original.lease, 'Save', 'original-save'); assert.equal(saved.result.status, 'applied');
  const proof = structuredClone(found(await lookup(original.driver, original.lease, saved.identity), saved.identity, 'applied'));
  const restarted = new SyntheticComputerDriver({ stateFile, receiptLimit: 1, clock: original.clock });
  const bytes = await readFile(stateFile);
  const repeated = await restarted.act(original.lease, saved.input, signal(), authorize);
  assert.equal(repeated.status, 'unknown'); assert.ok(repeated.reason);
  assert.equal(restarted.snapshot().inputCount, 1); assert.equal(restarted.snapshot().saveCount, 1);
  assert.deepEqual(await readFile(stateFile), bytes);
  const reader = await restarted.acquire({ sessionId: restarted.sessionId, workId: 'work-1', attemptId: 'new-reader', deadlineAt: 1000 }, signal());
  assert.deepEqual(found(await lookup(restarted, reader, saved.identity), saved.identity, 'applied'), proof);
  assert.deepEqual(await readFile(stateFile), bytes);
  const persisted = JSON.parse(bytes.toString()) as Stored; assert.deepEqual(persisted.receipts, [proof]);
});

test('synthetic receipts: hundreds of distinct refused operations keep diagnostics bounded and preserve the original proof', async t => {
  const stateFile = await file(t); const { driver, lease } = await fixture({ stateFile, receiptLimit: 1 });
  const saved = await act(driver, lease, 'Save', 'original-save'); assert.equal(saved.result.status, 'applied');
  const original = structuredClone(found(await lookup(driver, lease, saved.identity), saved.identity, 'applied'));
  const bytes = await readFile(stateFile); const before = app(driver); const { view } = await driver.observe(lease, limits, signal());
  for (let index = 0; index < 300; index++) {
    const refused = await driver.act(lease, request(view, 'Note', `refused-${index}`, 'never written'), signal(), authorize);
    assert.equal(refused.status, 'not_applied');
  }
  const after = driver.snapshot();
  assert.deepEqual(app(driver), before); assert.equal(after.inputCount, 1); assert.equal(after.saveCount, 1);
  assert.ok(after.invocations.length <= 256); assert.ok(after.invocationsOmitted > 0);
  assert.deepEqual(await readFile(stateFile), bytes);
  const persisted = JSON.parse(bytes.toString()) as Stored;
  assert.equal(persisted.receipts.length, 1); assert.deepEqual(persisted.receipts[0], original);
  assert.deepEqual(found(await lookup(driver, lease, saved.identity), saved.identity, 'applied'), original);
});

test('synthetic receipts: pending operation memory caps authorization waits and retains the first response without duplicate input', { timeout: 5000 }, async () => {
  const { driver, lease } = await fixture(); const { view } = await driver.observe(lease, limits, signal());
  const gate = deferred(); let entered = 0;
  const authorizeInput = async () => { entered++; await gate.promise; };
  const requests = Array.from({ length: 300 }, (_, index) => request(view, 'Note', `pending-${index}`, 'one physical input'));
  const responses = requests.map(input => driver.act(lease, input, signal(), authorizeInput));
  assert.equal(entered, 256);
  const refused = await Promise.all(responses.slice(256));
  assert.equal(refused.length, 44); assert.ok(refused.every(result => result.status === 'not_applied'));
  assert.equal(entered, 256); assert.equal(driver.snapshot().inputCount, 0);
  const firstIdentity = computerOperationIdentity(lease, requests[0]!);
  const refusedIdentity = computerOperationIdentity(lease, requests[299]!);
  unknown(await lookup(driver, lease, firstIdentity)); unknown(await lookup(driver, lease, refusedIdentity));
  assert.equal(driver.snapshot().inputCount, 0);
  gate.resolve(); const settled = await Promise.all(responses.slice(0, 256));
  assert.equal(settled.filter(result => result.status === 'applied').length, 1);
  assert.equal(settled[0]!.status, 'applied');
  assert.ok(settled.slice(1).every(result => result.status === 'not_applied' &&
    (result.reason === 'computer_focus_changed' || result.reason === 'computer_stale_view')));
  assert.equal(entered, 256); assert.equal(driver.snapshot().inputCount, 1); assert.equal(driver.snapshot().note, 'one physical input');
  found(await lookup(driver, lease, firstIdentity), firstIdentity, 'applied');
  unknown(await lookup(driver, lease, refusedIdentity));
  const duplicate = await driver.act(lease, requests[0]!, signal(), authorizeInput);
  assert.equal(duplicate.status, 'applied'); assert.equal(entered, 256); assert.equal(driver.snapshot().inputCount, 1);
});

test('synthetic receipts: delayed concurrent operations cannot overfill a one-record ledger', { timeout: 5000 }, async t => {
  const stateFile = await file(t); const { driver, lease, clock } = await fixture({ stateFile, receiptLimit: 1 });
  const { view } = await driver.observe(lease, limits, signal());
  const firstRequest = request(view, 'Note', 'first', 'first value'); const secondRequest = request(view, 'Note', 'second', 'second value');
  driver.injectNextAction({ delayBeforeInputMs: 10 }); const first = driver.act(lease, firstRequest, signal(), authorize);
  driver.injectNextAction({ delayBeforeInputMs: 20 }); const second = driver.act(lease, secondRequest, signal(), authorize);
  clock.advance(10); assert.equal((await first).status, 'applied'); clock.advance(10); assert.equal((await second).status, 'not_applied');
  assert.equal(driver.snapshot().inputCount, 1); assert.equal(driver.snapshot().note, 'first value');
  assert.equal((JSON.parse(await readFile(stateFile, 'utf8')) as Stored).receipts.length, 1);
  found(await lookup(driver, lease, computerOperationIdentity(lease, firstRequest)), computerOperationIdentity(lease, firstRequest), 'applied');
  unknown(await lookup(driver, lease, computerOperationIdentity(lease, secondRequest)));
});

test('synthetic receipts: malformed, duplicate and oversized persisted receipt sets fail before replacing the file', async t => {
  const stateFile = await file(t); const { driver, lease } = await fixture({ stateFile }); await act(driver, lease, 'Save', 'save');
  const valid = JSON.parse(await readFile(stateFile, 'utf8')) as Stored; assert.equal(valid.version, 2); const receipt = valid.receipts[0]!;
  const invalid: unknown[] = [
    { ...valid, receipts: [receipt, receipt] },
    { ...valid, receipts: [{ ...receipt, outcome: 'unknown' }] },
    { ...valid, receipts: [{ ...receipt, effectSequence: -1 }] },
    { ...valid, receipts: [{ ...receipt, identity: { ...receipt.identity, epoch: 0 } }] },
    { ...valid, receipts: [{ ...receipt, unexpected: true }] },
    { ...valid, receipts: Array.from({ length: 257 }, (_, index) => ({ ...receipt, identity: { ...receipt.identity, operationId: `oversized-${index}` } })) },
  ];
  for (const value of invalid) {
    const bytes = JSON.stringify(value); await writeFile(stateFile, bytes);
    assert.throws(() => new SyntheticComputerDriver({ stateFile })); assert.equal(await readFile(stateFile, 'utf8'), bytes);
  }
});

test('synthetic receipts: an older instance cannot overwrite the newer epoch or its existing receipt file', async t => {
  const stateFile = await file(t); const old = await fixture({ stateFile }); const saved = await act(old.driver, old.lease, 'Save', 'save');
  const { view } = await old.driver.observe(old.lease, limits, signal());
  const restarted = new SyntheticComputerDriver({ stateFile, clock: old.clock }); assert.ok(restarted.snapshot().epoch > old.lease.epoch);
  const bytes = await readFile(stateFile);
  const rejected = await old.driver.act(old.lease, request(view, 'Save', 'old-writer'), signal(), authorize);
  assert.equal(rejected.status, 'not_applied'); assert.deepEqual(await readFile(stateFile), bytes);
  assert.equal(old.driver.snapshot().inputCount, 1); assert.equal(restarted.snapshot().inputCount, 1);
  const reader = await restarted.acquire({ sessionId: restarted.sessionId, workId: 'work-1', attemptId: 'reader', deadlineAt: 1000 }, signal());
  found(await lookup(restarted, reader, saved.identity), saved.identity, 'applied'); assert.deepEqual(await readFile(stateFile), bytes);
});

test('synthetic receipts: mutable lookup inputs and returned receipts cannot change the pinned identity or cached proof', async () => {
  const { driver, lease } = await fixture(); const saved = await act(driver, lease, 'Note', 'original', 'real note');
  const expected = structuredClone(found(await lookup(driver, lease, saved.identity), saved.identity, 'applied'));
  const input = structuredClone(saved.identity); const entered = deferred(); const release = deferred();
  const reading = lookup(driver, lease, input, signal(), async () => { entered.resolve(); await release.promise; }); await entered.promise;
  input.workId = 'other-work'; input.targetRef = 'another-ref'; input.action = { kind: 'fill', target: input.action.target, value: 'mutated caller' };
  release.resolve(); const received = found(await reading, saved.identity, 'applied'); assert.deepEqual(received, expected);
  received.identity.targetRef = 'poisoned-ref'; received.identity.action = { kind: 'fill', target: received.identity.action.target, value: 'poisoned body' };
  received.effectSequence = 999; received.outcome = 'not_applied';
  assert.deepEqual(found(await lookup(driver, lease, saved.identity), saved.identity, 'applied'), expected);
  assert.equal(driver.snapshot().note, 'real note'); assert.equal(driver.snapshot().inputCount, 1);
});
