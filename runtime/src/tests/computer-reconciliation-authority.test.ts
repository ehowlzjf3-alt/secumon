import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { ComputerDriver } from '../application/computer-use-ports.js';
import type { StateRepository } from '../application/ports.js';
import { ComputerReconciliationResponseSchema } from '../application/computer-reconciliation-contracts.js';
import { summarizeToolExecution } from '../application/tool-execution-usage.js';
import { evaluateCompletion } from '../domain/completion.js';
import { executionControl } from '../domain/execution-policy.js';
import { SyntheticComputerClock, SyntheticComputerDriver } from '../infrastructure/synthetic-computer-driver.js';
import { computerActor, computerActInput, computerHarness, observeComputer, saveNoteSteps, submitComputerTask,
  type ComputerBackend, type ComputerHarness } from './computer-use-helpers.js';

const backends: ComputerBackend[] = ['sqlite', 'file-journal'];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function wrap(driver: SyntheticComputerDriver, lookup: NonNullable<ComputerDriver['lookup']>): ComputerDriver {
  return { identity: driver.identity, acquire: driver.acquire.bind(driver), observe: driver.observe.bind(driver),
    act: driver.act.bind(driver), wait: driver.wait.bind(driver), release: driver.release.bind(driver), lookup };
}
async function seed(t: TestContext, backend: ComputerBackend, clock: SyntheticComputerClock, driver: ComputerDriver,
  store?: (value: StateRepository) => StateRepository) {
  const h = await computerHarness(backend, { clock, driver, ...(store ? { store } : {}) }); t.after(() => h.close());
  const observed = await observeComputer(h);
  const attempt = await submitComputerTask(h, 'act', computerActInput(observed.observationId, saveNoteSteps));
  await h.runtime.execute(h.workId, attempt.id); await h.runtime.settlePending(attempt.id); await h.runtime.adopt(h.workId, attempt.id);
  assert.deepEqual(await h.runtime.step(h.workId), { kind: 'blocked', reason: 'effect_unknown' });
  const state = await h.state.get(h.workId); assert.ok(state);
  const source = state.attempts.find(value => value.id === attempt.id)!;
  assert.equal(source.adopted, false); assert.equal(source.effectState, 'unknown'); assert.ok(source.resultArtifact); assert.ok(source.computerUse);
  return { h, source: structuredClone(source), input: { attemptId: source.id, checkpointId: source.computerUse.head.id },
    resultBytes: await h.artifacts.get(source.resultArtifact, state.policy), headBytes: await h.artifacts.get(source.computerUse.head, state.policy) };
}
async function originalUnchanged(h: ComputerHarness, seeded: Awaited<ReturnType<typeof seed>>, driver: SyntheticComputerDriver) {
  const state = await h.state.get(h.workId); assert.ok(state);
  assert.deepEqual(state.attempts.find(value => value.id === seeded.source.id), seeded.source);
  assert.deepEqual(await h.artifacts.get(seeded.source.resultArtifact!, state.policy), seeded.resultBytes);
  assert.deepEqual(await h.artifacts.get(seeded.source.computerUse!.head, state.policy), seeded.headBytes);
  assert.deepEqual(state.evidence, []); assert.equal(state.modelCalls.length, 0);
  assert.equal(evaluateCompletion(state.goal, state.evidence, state.obligations, state.policy).complete, false);
  assert.equal(driver.snapshot().inputCount, 2); assert.equal(driver.snapshot().saveCount, 1);
  return state;
}

for (const backend of backends) {
  test(`${backend}: lost receive ACK preserves the committed reconciliation response and settles without another lookup`, async t => {
    const clock = new SyntheticComputerClock(1000); const driver = new SyntheticComputerDriver({ clock });
    driver.injectNextAction({}); driver.injectNextAction({ outcome: 'applied_unknown' });
    let lookups = 0; let ackLosses = 0; let receiveCommits = 0;
    const adapter = wrap(driver, async (...args) => { lookups++; return driver.lookup(...args); });
    const seeded = await seed(t, backend, clock, adapter, store => new Proxy(store, { get(target, key) {
      if (key === 'commit') return (async request => {
        const result = await target.commit(request);
        if (result.kind === 'committed' && request.events.some(event => event.type === 'computer_reconciliation_response_stored')) {
          receiveCommits++;
          if (ackLosses === 0) { ackLosses++; throw new Error('fixture_receive_ack_lost'); }
        }
        return result;
      }) as StateRepository['commit'];
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } }));
    const { h } = seeded; const sourceInvocations = driver.snapshot().invocations;
    const reserved = await h.computerReconciliations.reserve(h.workId, 'receive-ack-loss', computerActor, seeded.input);
    // The API may report an unknown commit or recover its receipt; either way the durable response must survive.
    const [attempted] = await Promise.allSettled([h.computerReconciliations.execute(h.workId, reserved.id, computerActor)]);
    assert.ok(attempted); assert.equal(ackLosses, 1); assert.equal(receiveCommits, 1); assert.equal(lookups, 1);
    const state = await originalUnchanged(h, seeded, driver);
    const received = state.computerReconciliations!.find(value => value.id === reserved.id)!;
    assert.equal(received.status, 'received'); assert.equal(received.outcome, 'applied'); assert.equal(received.effectState, 'unknown');
    assert.ok(received.responseArtifact); assert.equal(received.proofArtifact, null); assert.equal(received.reason, null);
    assert.equal(state.budget.used.toolCalls, 3); assert.equal(state.budget.reservedToolCalls, 0);
    assert.equal(state.obligations.find(value => value.id === received.obligationId)!.status, 'pending');
    const receipt = await h.state.receipt(h.workId, `reconcile-receive:${received.id}`); assert.ok(receipt);
    assert.deepEqual(receipt.state.computerReconciliations!.find(value => value.id === received.id), received);
    assert.equal(await h.state.receipt(h.workId, `reconcile-fail:${received.id}`), null);
    const bytes = await h.artifacts.get(received.responseArtifact, state.policy);
    const response = ComputerReconciliationResponseSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    assert.equal(response.result.status, 'found'); assert.deepEqual(received.execution.usage, response.result.usage);
    if (attempted.status === 'fulfilled') assert.deepEqual(attempted.value, received);
    assert.deepEqual(await h.computerReconciliations.execute(h.workId, received.id, computerActor), received);
    assert.deepEqual(await h.computerReconciliations.reserve(h.workId, 'receive-ack-loss', computerActor, seeded.input), received);
    assert.deepEqual(await h.state.get(h.workId), state); assert.equal(lookups, 1);
    const settled = await h.computerReconciliations.settle(h.workId, received.id, computerActor);
    assert.equal(settled.status, 'settled'); assert.equal(settled.effectState, 'confirmed');
    assert.equal(settled.finishedAt, received.finishedAt); assert.deepEqual(settled.responseArtifact, received.responseArtifact);
    const final = await originalUnchanged(h, seeded, driver);
    assert.equal(final.budget.used.toolCalls, 3); assert.equal(await h.computerReconciliations.current(final), true);
    assert.deepEqual(await h.artifacts.get(received.responseArtifact, final.policy), bytes);
    assert.deepEqual(await h.computerReconciliations.reconcile(h.workId, 'receive-ack-loss', computerActor, seeded.input), settled);
    assert.equal(lookups, 1); assert.equal(receiveCommits, 1); assert.deepEqual(driver.snapshot().invocations, sourceInvocations);
  });

  for (const command of ['pause', 'goal'] as const) test(`${backend}: ${command} during an actual driver lookup fences its late receipt while retaining the read charge and effect obligation`, { timeout: 15000 }, async t => {
    const clock = new SyntheticComputerClock(1000); const driver = new SyntheticComputerDriver({ clock });
    driver.injectNextAction({}); driver.injectNextAction({ outcome: 'applied_unknown' });
    const entered = deferred<AbortSignal>(); const release = deferred<void>(); const returned = deferred<void>();
    let lookups = 0; let returnedFound = false;
    const adapter = wrap(driver, async (...args) => {
      lookups++; const result = await driver.lookup(...args);
      assert.equal(result.status, 'found'); entered.resolve(args[2]);
      // Deliberately retain an already obtained receipt while the public control command changes authority.
      await release.promise; returnedFound = result.status === 'found'; returned.resolve(); return result;
    });
    const seeded = await seed(t, backend, clock, adapter); const { h } = seeded;
    const sourceInvocations = driver.snapshot().invocations; const commandId = `${command}-during-lookup`;
    const reserved = await h.computerReconciliations.reserve(h.workId, commandId, computerActor, seeded.input);
    const executing = h.computerReconciliations.execute(h.workId, reserved.id, computerActor);
    try {
      const signal = await entered.promise; const running = await h.state.get(h.workId); assert.ok(running);
      assert.equal(running.computerReconciliations!.find(value => value.id === reserved.id)!.status, 'running');
      assert.equal(running.budget.used.toolCalls, 3); assert.equal(running.budget.reservedToolCalls, 0); assert.equal(lookups, 1);
      const next = command === 'pause'
        ? await h.runtime.command(h.workId, 'pause-the-lookup', computerActor, running.goal.revision, { kind: 'pause', reason: 'Pause pending receipt read' })
        : await h.runtime.command(h.workId, 'change-goal-during-lookup', computerActor, running.goal.revision, {
          kind: 'goal', expectedControlRevision: executionControl(running).revision,
          goal: { ...running.goal, revision: running.goal.revision + 1, description: 'A changed goal still needs the earlier input reconciled' },
        });
      assert.equal(signal.aborted, true, 'the acknowledged control command interrupts this work lookup');
      const failed = await executing;
      assert.equal(failed.status, 'failed'); assert.equal(failed.effectState, 'unknown'); assert.equal(failed.outcome, null);
      assert.equal(failed.responseArtifact, null); assert.equal(failed.proofArtifact, null); assert.equal(failed.leaseUntil, reserved.leaseUntil);
      assert.equal(failed.execution.usage.transportCalls, null, 'an unreturned driver measurement remains unknown');
      const stopped = await originalUnchanged(h, seeded, driver);
      assert.equal(stopped.status, command === 'pause' ? 'paused' : 'ready'); assert.equal(stopped.goal.revision, next.goal.revision);
      assert.equal(stopped.budget.used.toolCalls, 3); assert.equal(stopped.budget.reservedToolCalls, 0);
      assert.equal(summarizeToolExecution(stopped).transportCalls.unknown, 1);
      assert.equal(stopped.obligations.find(value => value.id === failed.obligationId)!.status, 'pending');
      release.resolve(); await returned.promise; await new Promise<void>(done => setImmediate(done));
      assert.equal(returnedFound, true); assert.deepEqual(await h.state.get(h.workId), stopped);
      assert.equal(await h.state.receipt(h.workId, `reconcile-receive:${failed.id}`), null);
      assert.equal(await h.state.receipt(h.workId, `reconcile-settle:${failed.id}`), null);
      assert.deepEqual(await h.computerReconciliations.settle(h.workId, failed.id, computerActor), failed);
      assert.equal(lookups, 1); assert.deepEqual(driver.snapshot().invocations, sourceInvocations);
      await originalUnchanged(h, seeded, driver);
    } finally { release.resolve(); await executing.catch(() => {}); }
  });
}
