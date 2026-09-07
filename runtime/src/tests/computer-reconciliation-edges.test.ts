import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { ComputerDriver } from '../application/computer-use-ports.js';
import { SyntheticComputerClock, SyntheticComputerDriver } from '../infrastructure/synthetic-computer-driver.js';
import { computerActor, computerActInput, computerHarness, observeComputer, saveNoteSteps, submitComputerTask,
  type ComputerBackend, type ComputerHarness } from './computer-use-helpers.js';

const backends: ComputerBackend[] = ['sqlite', 'file-journal'];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function wrap(driver: SyntheticComputerDriver, overrides: Partial<ComputerDriver> = {}): ComputerDriver {
  return { identity: driver.identity, acquire: driver.acquire.bind(driver), observe: driver.observe.bind(driver),
    act: driver.act.bind(driver), wait: driver.wait.bind(driver), release: driver.release.bind(driver), lookup: driver.lookup.bind(driver), ...overrides };
}
async function harness(t: TestContext, backend: ComputerBackend, clock: SyntheticComputerClock, driver: ComputerDriver) {
  const h = await computerHarness(backend, { clock, driver }); t.after(() => h.close()); return h;
}
async function seed(h: ComputerHarness) {
  const observation = await observeComputer(h);
  const attempt = await submitComputerTask(h, 'act', computerActInput(observation.observationId, saveNoteSteps));
  await h.runtime.execute(h.workId, attempt.id); await h.runtime.settlePending(attempt.id); await h.runtime.adopt(h.workId, attempt.id);
  const state = await h.runtime.state(h.workId); const source = state.attempts.find(value => value.id === attempt.id)!;
  assert.equal(source.status, 'unknown'); assert.ok(source.computerUse);
  return { source, input: { attemptId: source.id, checkpointId: source.computerUse.head.id } };
}

for (const backend of backends) {
  test(`${backend}: receipt identity and driver mismatches cannot close an effect and retain the measured read`, async t => {
    for (const mutation of ['attempt', 'driver'] as const) {
      const clock = new SyntheticComputerClock(1000); const driver = new SyntheticComputerDriver({ clock });
      driver.injectNextAction({}); driver.injectNextAction({ outcome: 'applied_unknown' }); let lookups = 0;
      const h = await harness(t, backend, clock, wrap(driver, { async lookup(...args) {
        lookups++; const result = await driver.lookup(...args); assert.equal(result.status, 'found');
        if (result.status === 'found') {
          if (mutation === 'attempt') result.receipt.identity.attemptId = 'different-input';
          else result.receipt.driver.version = 'different-driver';
        }
        return result;
      } }));
      const original = await seed(h); const before = driver.snapshot();
      const result = await h.computerReconciliations.reconcile(h.workId, mutation, computerActor, original.input);
      assert.equal(result.status, 'failed'); assert.equal(result.responseArtifact, null); assert.equal(result.proofArtifact, null);
      assert.equal(result.execution.mode, 'invoked'); assert.equal(result.execution.usage.transportCalls, 1);
      const state = await h.runtime.state(h.workId); assert.equal(state.budget.used.toolCalls, 3); assert.equal(state.budget.reservedToolCalls, 0);
      assert.equal(state.obligations.find(value => value.id === result.obligationId)!.status, 'pending');
      assert.deepEqual(state.attempts.find(value => value.id === original.source.id), original.source);
      assert.equal(lookups, 1); assert.equal(driver.snapshot().inputCount, before.inputCount); assert.deepEqual(state.evidence, []);
    }
  });

  test(`${backend}: a lease acquisition that ignores abort cannot hold cancellation or enter lookup later`, { timeout: 15000 }, async t => {
    const clock = new SyntheticComputerClock(1000); const driver = new SyntheticComputerDriver({ clock });
    driver.injectNextAction({}); driver.injectNextAction({ outcome: 'applied_unknown' });
    const entered = deferred<void>(); const proceed = deferred<void>(); const released = deferred<void>(); let lookups = 0;
    const h = await harness(t, backend, clock, wrap(driver, {
      async acquire(request, signal) {
        const lease = await driver.acquire(request, signal);
        if (request.attemptId.startsWith('computer-reconcile:')) { entered.resolve(); await proceed.promise; }
        return lease;
      },
      async release(lease) { await driver.release(lease); if (lease.attemptId.startsWith('computer-reconcile:')) released.resolve(); },
      async lookup(...args) { lookups++; return driver.lookup(...args); },
    }));
    const original = await seed(h); const reserved = await h.computerReconciliations.reserve(h.workId, 'pending-acquire', computerActor, original.input);
    const running = h.computerReconciliations.execute(h.workId, reserved.id, computerActor);
    try {
      await entered.promise;
      await h.runtime.command(h.workId, 'pause-acquire', computerActor, 1, { kind: 'pause', reason: 'Pause while obtaining read lease' });
      const failed = await running; assert.equal(failed.status, 'failed'); assert.equal(failed.responseArtifact, null); assert.equal(lookups, 0);
      proceed.resolve(); await released.promise;
      const state = await h.runtime.state(h.workId);
      assert.equal(state.budget.used.toolCalls, 3); assert.equal(state.budget.reservedToolCalls, 0);
      assert.deepEqual(state.attempts.find(value => value.id === original.source.id), original.source);
      assert.equal(state.obligations.find(value => value.id === reserved.obligationId)!.status, 'pending');
      assert.equal(driver.snapshot().inputCount, 2); assert.equal(lookups, 0);
    } finally { proceed.resolve(); await running; }
  });

  test(`${backend}: a reconciled expired input keeps its intent head and null result when the original runner returns late`, { timeout: 15000 }, async t => {
    const clock = new SyntheticComputerClock(1000); const driver = new SyntheticComputerDriver({ clock });
    const entered = deferred<void>(); const proceed = deferred<void>(); let lookups = 0;
    const h = await harness(t, backend, clock, wrap(driver, {
      async act(...args) { const result = await driver.act(...args); entered.resolve(); await proceed.promise; return result; },
      async lookup(...args) { lookups++; return driver.lookup(...args); },
    }));
    const observation = await observeComputer(h);
    const attempt = await submitComputerTask(h, 'act', computerActInput(observation.observationId, saveNoteSteps));
    const executing = h.runtime.execute(h.workId, attempt.id);
    try {
      await entered.promise; clock.advance(attempt.leaseUntil - clock.now()); await h.runtime.recover(h.workId, attempt.id);
      const recovered = await h.runtime.state(h.workId); const source = recovered.attempts.find(value => value.id === attempt.id)!;
      assert.equal(source.status, 'unknown'); assert.equal(source.resultArtifact, null); assert.ok(source.computerUse);
      const headBytes = await h.artifacts.get(source.computerUse.head, recovered.policy);
      const record = await h.computerReconciliations.reconcile(h.workId, 'recover-before-late-result', computerActor,
        { attemptId: source.id, checkpointId: source.computerUse.head.id });
      assert.equal(record.status, 'settled'); assert.equal(record.outcome, 'applied'); assert.equal(lookups, 1);
      proceed.resolve(); await executing; await h.runtime.settlePending(attempt.id);
      const state = await h.runtime.state(h.workId);
      assert.deepEqual(state.attempts.find(value => value.id === source.id), source);
      assert.deepEqual(await h.artifacts.get(source.computerUse.head, state.policy), headBytes);
      assert.deepEqual(state.evidence, []); assert.equal(driver.snapshot().inputCount, 1); assert.equal(driver.snapshot().saveCount, 0);
      assert.equal(await h.computerReconciliations.current(state), true);
      assert.equal(state.obligations.find(value => value.id === record.obligationId)!.status, 'satisfied');
      assert.deepEqual(h.runtime.backgroundFailures(), []);
    } finally { proceed.resolve(); await executing; await h.runtime.settlePending(attempt.id); }
  });

  test(`${backend}: revoking a parent grant refunds an unused query and prevents a fresh lookup allowance`, async t => {
    const clock = new SyntheticComputerClock(1000); const driver = new SyntheticComputerDriver({ clock });
    driver.injectNextAction({}); driver.injectNextAction({ outcome: 'applied_unknown' }); let lookups = 0;
    const h = await harness(t, backend, clock, wrap(driver, { async lookup(...args) { lookups++; return driver.lookup(...args); } }));
    const parent = await h.runtime.state(h.workId);
    const child = await h.runtime.budgets.createChild(h.workId, 'computer-child', computerActor, parent.goal.revision, {
      id: 'computer-child', goal: { ...parent.goal, scope: 'child-reconciliation' }, policy: parent.policy,
      limits: { toolCalls: 10, modelCalls: 1, tokens: 1000, replans: 10, wallTimeMs: 50000 },
    });
    const childHarness = { ...h, workId: child.id }; const original = await seed(childHarness);
    const reserved = await h.computerReconciliations.reserve(child.id, 'before-revoke', computerActor, original.input);
    await h.runtime.budgets.revoke(h.workId, child.budgetParent!.grantId, 'revoke-read', computerActor, parent.goal.revision);
    const fenced = await h.runtime.state(child.id);
    assert.equal(fenced.budgetParent!.phase, 'draining'); assert.equal(fenced.budget.reservedToolCalls, 0);
    assert.equal(fenced.computerReconciliations![0]!.status, 'failed'); assert.equal(fenced.budget.used.toolCalls, 2);
    assert.equal(fenced.obligations.find(value => value.id === reserved.obligationId)!.status, 'pending');
    await assert.rejects(h.computerReconciliations.reserve(child.id, 'after-revoke', computerActor, original.input), /budget_child_draining/);
    assert.deepEqual(await h.runtime.state(child.id), fenced); assert.equal(lookups, 0);
    assert.deepEqual(fenced.attempts.find(value => value.id === original.source.id), original.source); assert.equal(driver.snapshot().inputCount, 2);
    assert.equal((await h.runtime.state(h.workId)).budgetGrants![0]!.status, 'draining');
  });
}
