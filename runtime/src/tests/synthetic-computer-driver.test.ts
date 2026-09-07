import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComputerAction, ComputerLease, ComputerView } from '../domain/computer-use.js';
import type { ComputerDriver } from '../application/computer-use-ports.js';
import { SyntheticComputerClock, SyntheticComputerDriver, type SyntheticComputerOptions } from '../infrastructure/synthetic-computer-driver.js';

const limits = { maxElements: 20, maxBytes: 20_000 };
const authorize = async () => {};
function signal(): AbortSignal { return new AbortController().signal; }
async function fixture(options: SyntheticComputerOptions = {}, deadlineAt = 1000) {
  const clock = options.clock ?? new SyntheticComputerClock(); const driver = new SyntheticComputerDriver({ ...options, clock });
  const lease = await driver.acquire({ sessionId: driver.sessionId, workId: 'work-1', attemptId: 'attempt-1', deadlineAt }, signal());
  const { view } = await driver.observe(lease, limits, signal()); return { driver, clock, lease, view };
}
function request(view: ComputerView, name: string, operationId = 'operation-1', value?: string): Parameters<ComputerDriver['act']>[1] {
  const target = view.elements.find(element => element.name === name)!;
  const selector = { role: target.role, name: target.name };
  const action: ComputerAction = value === undefined ? { kind: 'click', target: selector } : { kind: 'fill', target: selector, value };
  return { operationId, basis: structuredClone(view), targetRef: target.ref, action, deadlineAt: 1000 };
}
async function input(driver: SyntheticComputerDriver, lease: ComputerLease, name: string, id: string, value?: string) {
  const { view } = await driver.observe(lease, limits, signal()); return driver.act(lease, request(view, name, id, value), signal(), authorize);
}

test('synthetic document inputs produce independently observed app facts and separate session/call usage', async () => {
  const { driver, lease } = await fixture();
  assert.equal((await input(driver, lease, 'Query', 'query', 'quarterly report')).status, 'applied');
  assert.equal((await input(driver, lease, 'Search', 'search')).status, 'applied');
  let view = (await driver.observe(lease, limits, signal())).view; assert.equal(view.facts.resultsReady, true);
  assert.equal((await input(driver, lease, 'Note', 'note', 'Synthetic reviewed note')).status, 'applied');
  const applied = await input(driver, lease, 'Save', 'save'); assert.equal(applied.status, 'applied');
  assert.deepEqual(applied.usage, { transportCalls: 1, internalOperations: 1, imageBytes: 0, waitMs: 0 });
  view = (await driver.observe(lease, limits, signal())).view;
  assert.deepEqual(view.facts, { resultsReady: true, savedNote: 'Synthetic reviewed note', saveCount: 1 });
  const snapshot = driver.snapshot(); assert.equal(snapshot.inputCount, 4); assert.equal(snapshot.usage.transportCalls, 11);
  assert.equal(snapshot.usage.internalOperations, 11); assert.equal(snapshot.usage.imageBytes, 0); assert.equal(snapshot.usage.waitMs, 0);
  snapshot.usage.transportCalls = 0; snapshot.elements[0]!.name = 'mutated external copy';
  assert.equal(driver.snapshot().usage.transportCalls, 11); assert.equal(driver.snapshot().elements[0]!.name, 'Query');
  await driver.release(lease); assert.deepEqual(driver.snapshot().sessionCalls, { acquire: 1, release: 1 });
  assert.equal(driver.snapshot().savedNote, 'Synthetic reviewed note'); assert.equal(driver.snapshot().owner, 'available');
});

test('every lease identity dimension is checked at input and a forged grant applies no input', async () => {
  for (const [key, value] of Object.entries({ sessionId: 'another', epoch: 999, surfaceId: 'another', fence: 999, workId: 'another', attemptId: 'another', expiresAt: 999 })) {
    const { driver, lease, view } = await fixture(); const altered = { ...lease, [key]: key === 'epoch' ? lease.epoch + 1 : value };
    const result = await driver.act(altered, request(view, 'Query', key, 'blocked'), signal(), authorize);
    assert.equal(result.status, 'not_applied', key); assert.equal(driver.snapshot().inputCount, 0, key);
  }
});

test('stale observation identity and focus are rejected with zero input', async () => {
  for (const [key, value] of Object.entries({ sessionId: 'other', epoch: 999, surfaceId: 'other', revision: 999, focusRevision: 999, observedAt: 999 })) {
    const { driver, lease, view } = await fixture(); const command = request(view, 'Query', key, 'blocked');
    command.basis = { ...command.basis, [key]: key === 'epoch' ? view.epoch + 1 : value };
    assert.equal((await driver.act(lease, command, signal(), authorize)).status, 'not_applied', key); assert.equal(driver.snapshot().inputCount, 0);
  }
  for (const change of [{ rerender: true }, { focused: false }, { surfaceId: 'other-window' }]) {
    const { driver, lease, view } = await fixture(); driver.injectNextAction({ beforeInput: () => driver.mutate(change) });
    assert.equal((await driver.act(lease, request(view, 'Query', 'raced', 'blocked'), signal(), authorize)).status, 'not_applied');
    assert.equal(driver.snapshot().inputCount, 0);
  }
});

test('current target uniqueness, ref, role, name, visibility and enabled state gate the actual target', async () => {
  for (const kind of ['ambiguous', 'invisible', 'disabled', 'wrong-ref', 'wrong-role', 'wrong-name'] as const) {
    const { driver, lease } = await fixture(); const elements = driver.snapshot().elements;
    if (kind === 'ambiguous') elements.push({ ...elements[0]!, ref: 'duplicate' });
    if (kind === 'invisible') elements[0]!.visible = false;
    if (kind === 'disabled') elements[0]!.enabled = false;
    driver.mutate({ elements }); const view = (await driver.observe(lease, limits, signal())).view; const command = request(view, 'Query', kind, 'blocked');
    if (kind === 'wrong-ref') command.targetRef = 'missing';
    if (kind === 'wrong-role') command.basis.elements[0]!.role = 'button';
    if (kind === 'wrong-name') command.basis.elements[0]!.name = 'Another name';
    assert.equal((await driver.act(lease, command, signal(), authorize)).status, 'not_applied', kind); assert.equal(driver.snapshot().inputCount, 0);
  }
});

test('an expired delayed input cannot reach a new owner and old release cannot release the new lease', async () => {
  const { driver, clock, lease, view } = await fixture({}, 10);
  for (const owner of [{ workId: 'work-2', attemptId: 'attempt-2' }, { workId: 'work-1', attemptId: 'attempt-2' }])
    await assert.rejects(driver.acquire({ sessionId: driver.sessionId, ...owner, deadlineAt: 1000 }, signal()), /computer_session_busy/);
  driver.injectNextAction({ delayBeforeInputMs: 100 }); const old = driver.act(lease, request(view, 'Query', 'delayed', 'old input'), signal(), authorize);
  clock.advance(10);
  const newer = await driver.acquire({ sessionId: driver.sessionId, workId: 'work-2', attemptId: 'attempt-2', deadlineAt: 1000 }, signal());
  assert.ok(newer.fence > lease.fence); assert.equal((await old).status, 'not_applied'); assert.equal(driver.snapshot().inputCount, 0);
  await driver.release(lease); assert.deepEqual(driver.snapshot().lease, newer);
  assert.equal((await input(driver, newer, 'Query', 'new-input', 'new owner')).status, 'applied'); assert.equal(driver.snapshot().inputCount, 1);
});

test('human handoff interrupts pending input, invalidates old views and remains owned after agent release', async () => {
  const { driver, lease, view } = await fixture(); driver.injectNextAction({ delayBeforeInputMs: 50 });
  const pending = driver.act(lease, request(view, 'Query', 'pending', 'blocked'), signal(), authorize); driver.handoff();
  assert.equal((await pending).status, 'not_applied'); assert.equal(driver.snapshot().inputCount, 0);
  await driver.release(lease); assert.equal(driver.snapshot().owner, 'human');
  await assert.rejects(driver.acquire({ sessionId: driver.sessionId, workId: 'work-2', attemptId: 'a-2', deadlineAt: 1000 }, signal()), /computer_human_owned/);
  driver.reclaim(); const next = await driver.acquire({ sessionId: driver.sessionId, workId: 'work-2', attemptId: 'a-2', deadlineAt: 1000 }, signal());
  assert.ok(next.epoch > lease.epoch); assert.equal((await driver.act(next, request(view, 'Query', 'old-view', 'blocked'), signal(), authorize)).status, 'not_applied');
  assert.equal((await input(driver, next, 'Query', 'fresh-view', 'allowed')).status, 'applied');
});

test('cancellation and shared deadline are rechecked after a driver delay without injecting late input', async () => {
  for (const kind of ['abort-before', 'abort-after', 'deadline'] as const) {
    const { driver, clock, lease, view } = await fixture(); const abort = new AbortController();
    driver.injectNextAction({ delayBeforeInputMs: 50 }); const command = { ...request(view, 'Query', kind, 'blocked'), deadlineAt: 20 };
    if (kind === 'abort-before') abort.abort(); const pending = driver.act(lease, command, abort.signal, authorize);
    if (kind === 'abort-after') abort.abort(); if (kind === 'deadline') clock.advance(20);
    assert.equal((await pending).status, 'not_applied', kind); assert.equal(driver.snapshot().inputCount, 0);
    clock.advance(100); assert.equal(driver.snapshot().inputCount, 0);
  }
});

test('wait observes late readiness using virtual condition changes and a single remaining deadline', async () => {
  const { driver, clock, lease } = await fixture({ searchDelayMs: 25 });
  await input(driver, lease, 'Query', 'query', 'synthetic query'); await input(driver, lease, 'Search', 'search');
  const before = (await driver.observe(lease, limits, signal())).view; assert.equal(before.facts.resultsReady, false);
  const waiting = driver.wait(lease, { afterRevision: before.revision, maxWaitMs: 50, deadlineAt: 1000 }, signal());
  clock.advance(25); const changed = await waiting; assert.equal(changed.status, 'changed'); assert.equal(changed.usage.waitMs, 25);
  assert.equal((await driver.observe(lease, limits, signal())).view.facts.resultsReady, true);
  const current = driver.snapshot().viewRevision;
  const timeout = driver.wait(lease, { afterRevision: current, maxWaitMs: 100, deadlineAt: 35 }, signal()); clock.advance(10);
  assert.equal((await timeout).status, 'timeout'); assert.equal(driver.snapshot().usage.waitMs, 35);
  const handoff = driver.wait(lease, { afterRevision: current, maxWaitMs: 100, deadlineAt: 1000 }, signal()); driver.handoff();
  assert.equal((await handoff).status, 'interrupted'); assert.equal(driver.snapshot().usage.waitMs, 35);
  const fresh = await fixture({ searchDelayMs: 25 });
  await input(fresh.driver, fresh.lease, 'Query', 'first-query', 'same value'); await input(fresh.driver, fresh.lease, 'Search', 'old-search');
  await input(fresh.driver, fresh.lease, 'Query', 'replaced-query', 'same value'); fresh.clock.advance(25);
  assert.equal((await fresh.driver.observe(fresh.lease, limits, signal())).view.facts.resultsReady, false);
});

test('applied-but-unknown save retains its effect and exact operation replay never saves twice', async () => {
  const { driver, lease } = await fixture(); await input(driver, lease, 'Note', 'note', 'Save this synthetic note');
  const view = (await driver.observe(lease, limits, signal())).view; const command = request(view, 'Save', 'save-once');
  driver.injectNextAction({ outcome: 'applied_unknown' }); const first = await driver.act(lease, command, signal(), authorize);
  assert.equal(first.status, 'unknown'); assert.equal(driver.snapshot().saveCount, 1); assert.equal(driver.snapshot().inputCount, 2);
  const repeated = await driver.act(lease, structuredClone(command), signal(), authorize); assert.equal(repeated.status, 'unknown');
  assert.deepEqual(repeated.usage, { transportCalls: 1, internalOperations: 0, imageBytes: 0, waitMs: 0 });
  const conflict = await driver.act(lease, { ...command, targetRef: 'changed' }, signal(), authorize); assert.equal(conflict.status, 'unknown');
  assert.equal(conflict.reason, 'computer_operation_conflict'); assert.equal(driver.snapshot().saveCount, 1);
  const observed = await driver.observe(lease, limits, signal()); assert.equal(observed.view.facts.savedNote, 'Save this synthetic note');
});

test('concurrent identical operations join while timeout injection and hook failure apply zero input', async () => {
  const { driver, clock, lease, view } = await fixture(); const command = request(view, 'Query', 'joined', 'once');
  driver.injectNextAction({ delayBeforeInputMs: 10 }); const first = driver.act(lease, command, signal(), authorize); const second = driver.act(lease, structuredClone(command), signal(), authorize);
  clock.advance(10); assert.equal((await first).status, 'applied'); assert.equal((await second).status, 'applied'); assert.equal(driver.snapshot().inputCount, 1);
  driver.injectNextAction({ outcome: 'not_applied_timeout' }); assert.equal((await input(driver, lease, 'Save', 'timeout')).status, 'not_applied');
  driver.injectNextAction({ beforeInput: () => { throw new Error('host injection'); } }); assert.equal((await input(driver, lease, 'Save', 'host-error')).status, 'not_applied');
  assert.equal(driver.snapshot().inputCount, 1); assert.equal(driver.snapshot().saveCount, 0);
});

test('bounded partial observations never expose omitted targets for action or silently exceed bytes', async () => {
  const { driver, lease, view } = await fixture(); const partial = await driver.observe(lease, { maxElements: 1, maxBytes: 20_000 }, signal());
  assert.equal(partial.view.partial, true); assert.equal(partial.view.omittedCount, 3); assert.equal(partial.view.elements.length, 1);
  const command = request(view, 'Save', 'omitted'); command.basis = partial.view;
  assert.equal((await driver.act(lease, command, signal(), authorize)).status, 'not_applied'); assert.equal(driver.snapshot().saveCount, 0);
  const fullBytes = Buffer.byteLength(JSON.stringify(view)); const smaller = await driver.observe(lease, { maxElements: 20, maxBytes: fullBytes - 1 }, signal());
  assert.ok(Buffer.byteLength(JSON.stringify(smaller.view)) <= fullBytes - 1); assert.equal(smaller.view.partial, true);
  await assert.rejects(driver.observe(lease, { maxElements: 1, maxBytes: 1 }, signal()), /computer_observation_limit/);
});

test('durable synthetic contents and input counts survive reconstruction while leases and observations do not', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'synthetic-computer-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = join(directory, 'app.json'); let durableAtHook = false;
  const { driver, lease, view } = await fixture({ stateFile, onActApplied: event => {
    const persisted = JSON.parse(readFileSync(stateFile, 'utf8')) as { app: { inputCount: number; saveCount: number } };
    assert.deepEqual([persisted.app.inputCount, persisted.app.saveCount], [event.inputCount, event.saveCount]);
    if (event.saveCount === 1) durableAtHook = true;
  } });
  assert.equal((await input(driver, lease, 'Note', 'note', 'Persisted synthetic note')).status, 'applied');
  assert.equal((await input(driver, lease, 'Save', 'save')).status, 'applied');
  assert.equal(durableAtHook, true); const stored = JSON.parse(await readFile(stateFile, 'utf8')) as { app: { inputCount: number; saveCount: number } };
  assert.deepEqual([stored.app.inputCount, stored.app.saveCount], [2, 1]);
  const restarted = new SyntheticComputerDriver({ stateFile }); assert.equal(restarted.snapshot().inputCount, 2); assert.equal(restarted.snapshot().saveCount, 1);
  assert.equal(restarted.snapshot().savedNote, 'Persisted synthetic note'); assert.equal(restarted.snapshot().lease, null); assert.ok(restarted.snapshot().epoch > lease.epoch);
  assert.equal((await restarted.act(lease, request(view, 'Query', 'old-after-restart', 'blocked'), signal(), authorize)).status, 'not_applied');
  const fresh = await restarted.acquire({ sessionId: restarted.sessionId, workId: 'work-2', attemptId: 'a-2', deadlineAt: 1000 }, signal());
  const freshView = (await restarted.observe(fresh, limits, signal())).view; restarted.restart();
  assert.equal((await restarted.act(fresh, request(freshView, 'Save', 'old-after-hook-restart'), signal(), authorize)).status, 'not_applied');
  assert.equal(restarted.snapshot().inputCount, 2);
});

test('authority is required after delay and host hook, and focus is rechecked after asynchronous authorization', async () => {
  const first = await fixture(); let allowed = true; let authorizationCalls = 0;
  first.driver.injectNextAction({ delayBeforeInputMs: 20, beforeInput: () => { allowed = false; } });
  const blocked = first.driver.act(first.lease, request(first.view, 'Query', 'authority-revoked', 'blocked'), signal(), async () => {
    authorizationCalls++; assert.equal(first.clock.now(), 20); if (!allowed) throw new Error('private policy details');
  });
  assert.equal(authorizationCalls, 0); first.clock.advance(20); const result = await blocked;
  assert.equal(authorizationCalls, 1); assert.equal(result.status, 'not_applied'); assert.equal(result.reason, 'computer_input_authorization_failed');
  assert.equal(first.driver.snapshot().inputCount, 0);

  const second = await fixture(); let release!: () => void;
  const authorized = new Promise<void>(resolve => { release = resolve; });
  const raced = second.driver.act(second.lease, request(second.view, 'Query', 'focus-after-authorize', 'blocked'), signal(), () => authorized);
  second.driver.mutate({ focused: false }); release();
  assert.equal((await raced).status, 'not_applied'); assert.equal(second.driver.snapshot().inputCount, 0);

  const missing = await fixture();
  const absent = await missing.driver.act(missing.lease, request(missing.view, 'Query', 'missing-authority', 'blocked'), signal(), undefined as unknown as () => Promise<void>);
  assert.equal(absent.status, 'not_applied'); assert.equal(absent.reason, 'computer_input_authorization_failed'); assert.equal(missing.driver.snapshot().inputCount, 0);
});

test('synthetic fill accepts the shared 8192-character limit and rejects an oversized value before input', async () => {
  const { driver, lease } = await fixture(); const value = 'x'.repeat(8192);
  assert.equal((await input(driver, lease, 'Note', 'maximum-fill', value)).status, 'applied');
  assert.equal(driver.snapshot().note, value); assert.equal(driver.snapshot().inputCount, 1);
  const result = await input(driver, lease, 'Note', 'oversized-fill', value + 'x');
  assert.equal(result.status, 'not_applied'); assert.equal(result.reason, 'computer_action_unsupported'); assert.equal(driver.snapshot().inputCount, 1);
});
