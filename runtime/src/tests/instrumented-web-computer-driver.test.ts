import test from 'node:test';
import assert from 'node:assert/strict';
import type { ComputerLease, ComputerView } from '../domain/computer-use.js';
import { InstrumentedWebComputerDriver, createPlaywrightWebComputerTransport, type WebComputerCommand, type WebComputerPage } from '../infrastructure/instrumented-web-computer-driver.js';
import { computerOperationIdentity } from '../application/computer-operation-contracts.js';

const lease: ComputerLease = { sessionId: 'web', epoch: 1, surfaceId: 'doc', fence: 1, workId: 'work', attemptId: 'attempt', expiresAt: 10000 };
const view: ComputerView = { sessionId: 'web', epoch: 1, surfaceId: 'doc', revision: 0, focusRevision: 0, observedAt: 1,
  elements: [{ ref: 'note-1', role: 'textbox', name: 'Note', value: '', visible: true, enabled: true }], facts: {}, partial: false, omittedCount: 0 };
const request = { operationId: 'op', basis: view, targetRef: 'note-1', action: { kind: 'fill' as const, target: { role: 'textbox', name: 'Note' }, value: 'reviewed' }, deadlineAt: 9000 };
const signal = () => new AbortController().signal;
const usage = { transportCalls: 1, internalOperations: 1, imageBytes: 0, waitMs: 0 };
const applied = () => ({ operationId: 'op', status: 'applied', reason: null, usage });

test('web adapter: rejected current authority sends no browser input', async () => {
  const calls: WebComputerCommand[] = [];
  const driver = new InstrumentedWebComputerDriver({ async request(command) { calls.push(command); return applied(); } });
  const result = await driver.act(lease, request, signal(), async () => { throw new Error('changed policy'); });
  assert.equal(result.status, 'not_applied'); assert.equal(result.reason, 'computer_input_authorization_failed'); assert.deepEqual(calls, []);
});
test('web adapter: cancellation while authority is awaited sends no input', async () => {
  const controller = new AbortController(); let calls = 0;
  const driver = new InstrumentedWebComputerDriver({ async request() { calls++; return applied(); } });
  const result = await driver.act(lease, request, controller.signal, async () => { controller.abort(); });
  assert.equal(result.status, 'not_applied'); assert.equal(calls, 0);
});
test('web adapter: loss after dispatch is unknown and duplicate operation never sends again', async () => {
  let calls = 0;
  const driver = new InstrumentedWebComputerDriver({ async request() { calls++; throw new Error('lost response after DOM input'); } });
  const first = await driver.act(lease, request, signal(), async () => {});
  const again = await driver.act(lease, request, signal(), async () => {});
  assert.equal(first.status, 'unknown'); assert.deepEqual(again, first); assert.equal(calls, 1);
  assert.equal(first.usage.internalOperations, null); assert.equal(first.usage.waitMs, null);
});
test('web adapter: same operation id with changed action is unknown without another transport', async () => {
  let calls = 0;
  const driver = new InstrumentedWebComputerDriver({ async request() { calls++; return applied(); } });
  assert.equal((await driver.act(lease, request, signal(), async () => {})).status, 'applied');
  const result = await driver.act(lease, { ...request, action: { ...request.action, value: 'different' } }, signal(), async () => {});
  assert.equal(result.status, 'unknown'); assert.equal(result.reason, 'computer_operation_conflict'); assert.equal(calls, 1);
});
test('web adapter: concurrent duplicate joins the original operation', async () => {
  let calls = 0; let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  const driver = new InstrumentedWebComputerDriver({ async request() { calls++; await pending; return applied(); } });
  const first = driver.act(lease, request, signal(), async () => {});
  const second = driver.act(lease, request, signal(), async () => {}); release();
  assert.deepEqual(await first, await second); assert.equal(calls, 1);
});
test('web adapter: malformed or wrong operation response is uncertain', async () => {
  for (const result of [{ ...applied(), operationId: 'other' }, { ...applied(), extra: 'untrusted' }, { ...applied(), reason: 'x'.repeat(150000) }]) {
    const driver = new InstrumentedWebComputerDriver({ async request() { return result; } });
    assert.equal((await driver.act(lease, request, signal(), async () => {})).status, 'unknown');
  }
});
test('web adapter: observation from another document cannot become a current view', async () => {
  const driver = new InstrumentedWebComputerDriver({ async request() { return { view: { ...view, epoch: 2 }, usage }; } });
  await assert.rejects(driver.observe(lease, { maxElements: 40, maxBytes: 32768 }, signal()), /computer_web_view_mismatch/);
});
test('web adapter: observation bounds apply after the remote response', async () => {
  const driver = new InstrumentedWebComputerDriver({ async request() { return { view, usage }; } });
  await assert.rejects(driver.observe(lease, { maxElements: 0, maxBytes: 32768 }, signal()), /computer_observation_limit/);
});
test('web adapter: missing receipt remains unknown and lookup does not send act', async () => {
  const commands: WebComputerCommand[] = [];
  const driver = new InstrumentedWebComputerDriver({ async request(command) { commands.push(command); return { status: 'unknown', receipt: null, reason: 'missing', usage }; } });
  const result = await driver.lookup(lease, { identity: computerOperationIdentity(lease, request) }, signal(), async () => {});
  assert.equal(result.status, 'unknown'); assert.deepEqual(commands.map(value => value.kind), ['lookup']);
});
test('web adapter: lookup rejects another work and altered receipt identity', async () => {
  let calls = 0;
  const identity = computerOperationIdentity(lease, request);
  const driver = new InstrumentedWebComputerDriver({ async request() { calls++; return { status: 'found', reason: null, usage,
    receipt: { schemaVersion: 1, kind: 'computer_operation_receipt', driver: { id: 'instrumented-web-document-app', version: '1' },
      identity: { ...identity, operationId: 'different' }, outcome: 'applied', decidedAt: 1, effectSequence: 1 } }; } });
  await assert.rejects(driver.lookup(lease, { identity: { ...identity, workId: 'other' } }, signal(), async () => {}), /computer_operation_scope_mismatch/);
  assert.equal(calls, 0);
  await assert.rejects(driver.lookup(lease, { identity }, signal(), async () => {}), /computer_web_receipt_mismatch/);
});
test('web adapter: navigation outside the registered loopback document is rejected before evaluation', async () => {
  let calls = 0;
  const page: WebComputerPage = { url: () => 'http://127.0.0.1:1234/other', async evaluate() { calls++; return null; } };
  const transport = createPlaywrightWebComputerTransport(page, 'http://127.0.0.1:1234/');
  await assert.rejects(transport.request({ kind: 'release', lease }, signal()), /computer_web_navigation_changed/); assert.equal(calls, 0);
  assert.throws(() => createPlaywrightWebComputerTransport(page, 'https://example.com/'), /computer_web_local_origin_required/);
});
test('web transport: abort stops waiting but does not claim to retract a sent renderer command', async () => {
  let delivered = 0; let resolve!: (value: unknown) => void;
  const page: WebComputerPage = { url: () => 'http://127.0.0.1:1234/', async evaluate() { delivered++; return new Promise(done => { resolve = done; }); } };
  const driver = new InstrumentedWebComputerDriver(createPlaywrightWebComputerTransport(page, page.url()));
  const controller = new AbortController(); const pending = driver.act(lease, request, controller.signal, async () => {});
  await new Promise<void>(done => setImmediate(done)); controller.abort();
  const result = await pending; assert.equal(delivered, 1); assert.equal(result.status, 'unknown');
  resolve(applied());
  assert.equal((await driver.act(lease, request, signal(), async () => {})).status, 'unknown'); assert.equal(delivered, 1);
});
test('web adapter: caller mutations during authorization cannot change the pinned DOM command', async () => {
  const mutableRequest = structuredClone(request); const mutableLease = structuredClone(lease); let sent: WebComputerCommand | null = null;
  const driver = new InstrumentedWebComputerDriver({ async request(command) { sent = command; return applied(); } });
  const result = await driver.act(mutableLease, mutableRequest, signal(), async () => {
    mutableRequest.action.value = 'changed during await'; mutableRequest.operationId = 'wrong'; mutableLease.workId = 'different'; mutableRequest.basis.revision = 88;
  });
  assert.equal(result.status, 'applied'); assert.deepEqual(sent, { kind: 'act', lease, request });
});
test('web adapter: read authorization cannot change the receipt identity or work being looked up', async () => {
  const identity = computerOperationIdentity(lease, request); const original = structuredClone(identity); const mutableLease = structuredClone(lease);
  let sent: WebComputerCommand | null = null;
  const driver = new InstrumentedWebComputerDriver({ async request(command) { sent = command; return { status: 'unknown', receipt: null, reason: 'missing', usage }; } });
  await driver.lookup(mutableLease, { identity }, signal(), async () => { identity.workId = 'different'; mutableLease.workId = 'different'; });
  assert.deepEqual(sent, { kind: 'lookup', lease, request: { identity: original } });
});
