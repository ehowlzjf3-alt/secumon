import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ComputerDriver } from '../application/computer-use-ports.js';
import type { ComputerStep } from '../domain/computer-use.js';
import type { WorkActor } from '../application/work-resources.js';
import { evaluateCompletion } from '../domain/completion.js';
import { ComputerReconciliationIntentSchema, ComputerReconciliationResponseSchema, ComputerReconciliationProofSchema } from '../application/computer-reconciliation-contracts.js';
import { SyntheticComputerClock, SyntheticComputerDriver } from '../infrastructure/synthetic-computer-driver.js';
import { computerActor, computerActInput, computerHarness, computerResult, mutateComputer, observeComputer, saveNoteSteps,
  submitComputerTask, type ComputerBackend, type ComputerHarness } from './computer-use-helpers.js';

const backends: ComputerBackend[] = ['sqlite', 'file-journal'];
async function harness(t: TestContext, backend: ComputerBackend, options?: Parameters<typeof computerHarness>[1]) {
  const value = await computerHarness(backend, options); t.after(() => value.close()); return value;
}
function wrap(driver: SyntheticComputerDriver, overrides: Partial<ComputerDriver> = {}): ComputerDriver {
  return { identity: driver.identity, acquire: driver.acquire.bind(driver), observe: driver.observe.bind(driver),
    act: driver.act.bind(driver), wait: driver.wait.bind(driver), release: driver.release.bind(driver), lookup: driver.lookup.bind(driver), ...overrides };
}
async function unknownInput(h: ComputerHarness, steps: ComputerStep[] = saveNoteSteps) {
  const observed = await observeComputer(h);
  const attempt = await submitComputerTask(h, 'act', computerActInput(observed.observationId, steps));
  await h.runtime.execute(h.workId, attempt.id); await h.runtime.settlePending(attempt.id); await h.runtime.adopt(h.workId, attempt.id);
  const result = await computerResult(h, attempt.id); assert.equal(result.effectState, 'unknown'); assert.deepEqual(result.evidence, []);
  assert.deepEqual(await h.runtime.step(h.workId), { kind: 'blocked', reason: 'effect_unknown' });
  const state = await h.state.get(h.workId); assert.ok(state);
  const source = state.attempts.find(value => value.id === attempt.id)!;
  assert.ok(source.computerUse); assert.ok(source.resultArtifact); assert.equal(source.adopted, false);
  return { source: structuredClone(source), input: { attemptId: source.id, checkpointId: source.computerUse.head.id },
    resultBytes: await h.artifacts.get(source.resultArtifact, state.policy), headBytes: await h.artifacts.get(source.computerUse.head, state.policy) };
}
async function assertSource(h: ComputerHarness, original: Awaited<ReturnType<typeof unknownInput>>) {
  const state = await h.state.get(h.workId); assert.ok(state);
  assert.deepEqual(state.attempts.find(value => value.id === original.source.id), original.source);
  assert.deepEqual(await h.artifacts.get(original.source.resultArtifact!, state.policy), original.resultBytes);
  assert.deepEqual(await h.artifacts.get(original.source.computerUse!.head, state.policy), original.headBytes);
  assert.deepEqual(state.evidence, []); assert.equal(state.modelCalls.length, 0);
  assert.equal(evaluateCompletion(state.goal, state.evidence, state.obligations, state.policy).complete, false);
  return state;
}
async function seedApplied(t: TestContext, backend: ComputerBackend) {
  const h = await harness(t, backend); assert.ok(h.driver instanceof SyntheticComputerDriver); const driver = h.driver;
  driver.injectNextAction({}); driver.injectNextAction({ outcome: 'applied_unknown' });
  const original = await unknownInput(h); return { h, driver, original };
}

for (const backend of backends) {
  test(`${backend}: explicit reconciliation records a read response and separate effect proof without adopting or changing the original input`, async t => {
    const { h, driver, original } = await seedApplied(t, backend);
    await mutateComputer(h, state => state.obligations.push({ id: 'effect:another-input', kind: 'effect_reconciliation',
      reason: 'Another input is unresolved', status: 'pending', wakeKey: null, dueAt: null }));
    const before = (await h.state.get(h.workId))!; const driverBefore = driver.snapshot();
    const reserved = await h.computerReconciliations.reserve(h.workId, 'explicit-lookup', computerActor, original.input);
    assert.equal(reserved.status, 'reserved'); assert.equal(reserved.sourceAttemptId, original.source.id);
    assert.equal(reserved.sourceHead.id, original.input.checkpointId); assert.equal(reserved.responseArtifact, null); assert.equal(reserved.proofArtifact, null);
    let state = (await h.state.get(h.workId))!;
    assert.equal(state.budget.used.toolCalls, before.budget.used.toolCalls); assert.equal(state.budget.reservedToolCalls, 1);
    const intent = ComputerReconciliationIntentSchema.parse(JSON.parse(new TextDecoder().decode(await h.artifacts.get(reserved.requestArtifact, state.policy))));
    assert.equal(intent.identity.attemptId, original.source.id); assert.equal(intent.identity.operationId, reserved.operationId);
    assert.equal(intent.identity.action.kind, 'click'); assert.equal(intent.identity.action.target.name, 'Save');
    const inspected = await h.computerReconciliations.inspect(h.workId, reserved.id, computerActor);
    assert.deepEqual(inspected, reserved); assert.deepEqual(await h.state.get(h.workId), state); assert.deepEqual(driver.snapshot(), driverBefore);
    const received = await h.computerReconciliations.execute(h.workId, reserved.id, computerActor);
    assert.equal(received.status, 'received'); assert.equal(received.outcome, 'applied'); assert.equal(received.effectState, 'unknown');
    assert.ok(received.responseArtifact); assert.equal(received.proofArtifact, null); assert.equal(received.execution.mode, 'invoked');
    state = (await h.state.get(h.workId))!;
    assert.equal(state.obligations.find(value => value.id === reserved.obligationId)!.status, 'pending');
    const response = ComputerReconciliationResponseSchema.parse(JSON.parse(new TextDecoder().decode(await h.artifacts.get(received.responseArtifact, state.policy))));
    assert.equal(response.lease.attemptId, reserved.id); assert.equal(response.result.status, 'found');
    if (response.result.status === 'found') assert.equal(response.result.receipt.identity.attemptId, original.source.id);
    const settled = await h.computerReconciliations.settle(h.workId, reserved.id, computerActor);
    assert.equal(settled.status, 'settled'); assert.equal(settled.outcome, 'applied'); assert.equal(settled.effectState, 'confirmed');
    assert.equal(settled.finishedAt, received.finishedAt); assert.deepEqual(settled.responseArtifact, received.responseArtifact); assert.ok(settled.proofArtifact);
    state = await assertSource(h, original);
    const proof = ComputerReconciliationProofSchema.parse(JSON.parse(new TextDecoder().decode(await h.artifacts.get(settled.proofArtifact, state.policy))));
    assert.equal(proof.sourceAttemptId, original.source.id); assert.equal(proof.effectState, 'confirmed'); assert.equal(proof.sourceHead.id, original.input.checkpointId);
    assert.equal(state.obligations.find(value => value.id === reserved.obligationId)!.status, 'satisfied');
    assert.equal(state.obligations.find(value => value.id === 'effect:another-input')!.status, 'pending');
    assert.equal(state.budget.used.toolCalls, before.budget.used.toolCalls + 1); assert.equal(state.budget.reservedToolCalls, 0);
    assert.equal(await h.computerReconciliations.current(state), true);
    assert.deepEqual(await h.runtime.step(h.workId), { kind: 'blocked', reason: 'effect_unknown' });
    assert.equal(driver.snapshot().inputCount, driverBefore.inputCount); assert.equal(driver.snapshot().saveCount, 1);
    assert.deepEqual(driver.snapshot().invocations, driverBefore.invocations);
  });

  test(`${backend}: recorded not-applied receipts resolve only the unknown step and preserve a prior applied prefix`, async t => {
    for (const prefix of [false, true]) {
      const clock = new SyntheticComputerClock(1000); const driver = new SyntheticComputerDriver({ clock }); let lookups = 0;
      if (prefix) driver.injectNextAction({}); driver.injectNextAction({ outcome: 'not_applied_timeout' });
      const adapter = wrap(driver, {
        async act(lease, request, signal, authorizeInput) {
          const result = await driver.act(lease, request, signal, authorizeInput);
          return result.status === 'not_applied' ? { ...result, status: 'unknown', reason: 'synthetic_response_lost' } : result;
        },
        async lookup(...args) { lookups++; return driver.lookup(...args); },
      });
      const h = await harness(t, backend, { clock, driver: adapter });
      const original = await unknownInput(h, prefix ? saveNoteSteps : [saveNoteSteps[0]!]); const before = driver.snapshot();
      const result = await h.computerReconciliations.reconcile(h.workId, `negative-${prefix}`, computerActor, original.input);
      assert.equal(result.status, 'settled'); assert.equal(result.outcome, 'not_applied'); assert.equal(result.effectState, prefix ? 'confirmed' : 'none');
      const state = await assertSource(h, original);
      assert.equal(state.obligations.find(value => value.id === result.obligationId)!.status, 'satisfied');
      assert.equal(lookups, 1); assert.equal(driver.snapshot().inputCount, prefix ? 1 : 0); assert.equal(driver.snapshot().saveCount, 0);
      assert.deepEqual(driver.snapshot().invocations, before.invocations);
    }
  });

  test(`${backend}: a missing driver receipt remains unresolved and repeating the same request neither repeats input nor lookup`, async t => {
    const clock = new SyntheticComputerClock(1000); const driver = new SyntheticComputerDriver({ clock }); let lookups = 0;
    const adapter = wrap(driver, {
      async act(_lease, request, _signal, authorizeInput) {
        await authorizeInput();
        return { operationId: request.operationId, status: 'unknown', reason: 'synthetic_transport_lost_before_input',
          usage: { transportCalls: 1, internalOperations: 0, imageBytes: 0, waitMs: 0 } };
      },
      async lookup(...args) { lookups++; return driver.lookup(...args); },
    });
    const h = await harness(t, backend, { clock, driver: adapter }); const original = await unknownInput(h, [saveNoteSteps[0]!]);
    const result = await h.computerReconciliations.reconcile(h.workId, 'missing-receipt', computerActor, original.input);
    assert.equal(result.status, 'failed'); assert.equal(result.outcome, 'unknown'); assert.equal(result.effectState, 'unknown');
    assert.ok(result.responseArtifact); assert.equal(result.proofArtifact, null);
    const state = await assertSource(h, original); assert.equal(state.obligations.find(value => value.id === result.obligationId)!.status, 'pending');
    assert.equal(state.budget.reservedToolCalls, 0); assert.equal(result.execution.usage.transportCalls, 1);
    assert.deepEqual(await h.computerReconciliations.reconcile(h.workId, 'missing-receipt', computerActor, original.input), result);
    assert.deepEqual(await h.state.get(h.workId), state); assert.equal(lookups, 1); assert.equal(driver.snapshot().inputCount, 0);
    assert.deepEqual(driver.snapshot().invocations, []); assert.deepEqual(await h.runtime.step(h.workId), { kind: 'blocked', reason: 'effect_unknown' });
  });

  test(`${backend}: duplicate command and execution charge one lookup while changed payload conflicts`, async t => {
    const { h, driver, original } = await seedApplied(t, backend);
    const budgetBefore = (await h.state.get(h.workId))!.budget; const before = driver.snapshot();
    const reserved = await h.computerReconciliations.reserve(h.workId, 'deduplicated', computerActor, original.input);
    const once = await h.state.get(h.workId);
    assert.deepEqual(await h.computerReconciliations.reserve(h.workId, 'deduplicated', computerActor, original.input), reserved);
    assert.deepEqual(await h.state.get(h.workId), once);
    await assert.rejects(h.computerReconciliations.reserve(h.workId, 'deduplicated', computerActor,
      { ...original.input, checkpointId: 'different-checkpoint' }), /idempotency_conflict/);
    const results = await Promise.all([h.computerReconciliations.execute(h.workId, reserved.id, computerActor),
      h.computerReconciliations.execute(h.workId, reserved.id, computerActor)]);
    assert.deepEqual(results[0], results[1]); assert.equal(results[0]!.status, 'received');
    const settled = await h.computerReconciliations.settle(h.workId, reserved.id, computerActor); assert.equal(settled.status, 'settled');
    const state = await assertSource(h, original); const driverSettled = driver.snapshot();
    assert.equal(state.budget.used.toolCalls, budgetBefore.used.toolCalls + 1); assert.equal(state.budget.reservedToolCalls, 0);
    assert.equal(driverSettled.usage.transportCalls - before.usage.transportCalls, 1);
    assert.deepEqual(await h.computerReconciliations.reconcile(h.workId, 'deduplicated', computerActor, original.input), settled);
    assert.deepEqual(await h.state.get(h.workId), state); assert.deepEqual(driver.snapshot(), driverSettled);
  });

  test(`${backend}: exhausted lookup budget refuses reservation without a driver call or a stored intent`, async t => {
    const { h, driver, original } = await seedApplied(t, backend);
    await mutateComputer(h, state => { state.budget.limits.toolCalls = state.budget.used.toolCalls; });
    const state = await h.state.get(h.workId); const before = driver.snapshot();
    await assert.rejects(h.computerReconciliations.reserve(h.workId, 'no-budget', computerActor, original.input), /tool_budget_exhausted/);
    assert.deepEqual(await h.state.get(h.workId), state); assert.deepEqual(driver.snapshot(), before);
  });

  test(`${backend}: receipt lookup requires current read authority but does not require permission to issue another input`, async t => {
    const { h, driver, original } = await seedApplied(t, backend); const before = driver.snapshot();
    const denied: WorkActor[] = [
      { ...computerActor, tenantId: 'foreign' }, { ...computerActor, principalId: 'foreign' },
      { ...computerActor, allowedLabels: [] }, { ...computerActor, allowedTools: [] }, { ...computerActor, allowedDestinations: [] },
    ];
    const snapshot = await h.state.get(h.workId);
    for (let index = 0; index < denied.length; index++) {
      await assert.rejects(h.computerReconciliations.reserve(h.workId, `denied-${index}`, denied[index]!, original.input));
      assert.deepEqual(await h.state.get(h.workId), snapshot); assert.deepEqual(driver.snapshot(), before);
    }
    const readOnly: WorkActor = { ...computerActor, allowWrites: false, allowedTools: ['synthetic.ui.observe'], allowedLabels: ['public'], allowedDestinations: ['local'] };
    const result = await h.computerReconciliations.reconcile(h.workId, 'read-authority', readOnly, original.input);
    assert.equal(result.status, 'settled'); assert.equal(result.outcome, 'applied');
    await assertSource(h, original); assert.equal(driver.snapshot().inputCount, before.inputCount); assert.equal(driver.snapshot().saveCount, before.saveCount);
    await assert.rejects(h.computerReconciliations.inspect(h.workId, result.id, { ...computerActor, allowedLabels: [] }));
  });

  test(`${backend}: an expired unused reconciliation reservation is released and the same request never dispatches later`, async t => {
    const { h, driver, original } = await seedApplied(t, backend); const before = driver.snapshot();
    const budgetBefore = (await h.state.get(h.workId))!.budget;
    const reserved = await h.computerReconciliations.reserve(h.workId, 'unused-expiry', computerActor, original.input);
    h.clock.advance(reserved.leaseUntil - h.clock.now());
    const state = await h.computerReconciliations.refresh(h.workId);
    const failed = state.computerReconciliations!.find(value => value.id === reserved.id)!;
    assert.equal(failed.status, 'failed'); assert.equal(failed.reason, 'computer_reconciliation_expired');
    assert.equal(failed.execution.mode, 'not_invoked'); assert.equal(failed.dispatchedAt, null);
    assert.equal(state.budget.reservedToolCalls, 0); assert.equal(state.budget.used.toolCalls, budgetBefore.used.toolCalls);
    assert.equal(state.obligations.find(value => value.id === failed.obligationId)!.status, 'pending');
    assert.deepEqual(await h.computerReconciliations.reconcile(h.workId, 'unused-expiry', computerActor, original.input), failed);
    assert.deepEqual(await h.state.get(h.workId), state); assert.deepEqual(driver.snapshot(), before); await assertSource(h, original);
  });

  test(`${backend}: loss of a settled proof reopens the effect obligation while preserving the old receipt, claim, and original head`, async t => {
    const { h, driver, original } = await seedApplied(t, backend);
    const settled = await h.computerReconciliations.reconcile(h.workId, 'proof-lifecycle', computerActor, original.input);
    assert.equal(settled.status, 'settled'); assert.ok(settled.proofArtifact);
    const before = await assertSource(h, original); const driverBefore = driver.snapshot();
    assert.equal(await h.computerReconciliations.current(before), true);
    await unlink(join(h.directory, 'artifacts', `${settled.proofArtifact.id}.blob`));
    assert.equal(await h.computerReconciliations.current(before), false);
    const state = await h.computerReconciliations.refresh(h.workId);
    const invalidated = state.computerReconciliations!.find(value => value.id === settled.id)!;
    assert.equal(invalidated.status, 'failed'); assert.equal(invalidated.reason, 'effect_proof_unavailable');
    assert.deepEqual(invalidated.responseArtifact, settled.responseArtifact); assert.deepEqual(invalidated.proofArtifact, settled.proofArtifact);
    assert.equal(invalidated.finishedAt, settled.finishedAt); assert.equal(invalidated.outcome, 'applied'); assert.equal(invalidated.effectState, 'confirmed');
    assert.equal(state.obligations.find(value => value.id === settled.obligationId)!.status, 'pending');
    assert.deepEqual(state.budget, before.budget); await assertSource(h, original);
    assert.deepEqual(await h.runtime.step(h.workId), { kind: 'blocked', reason: 'effect_unknown' });
    assert.deepEqual(driver.snapshot(), driverBefore);
  });
}
