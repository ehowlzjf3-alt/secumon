import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ComputerReconciliation } from '../domain/computer-reconciliation.js';
import type { ContextPacket, WorkState } from '../domain/model.js';
import type { ArtifactStore } from '../application/ports.js';
import { ContextCompiler } from '../application/context-compiler.js';
import { ContextRecovery } from '../application/context-recovery.js';
import { buildContextPacket, computerReconciliationContext, computerReconciliationRefs } from '../application/context-packet.js';
import { ComputerReconciliationIntentSchema, ComputerReconciliationResponseSchema } from '../application/computer-reconciliation-contracts.js';
import { transact } from '../application/work-transactions.js';
import { ScriptedPlanner } from '../infrastructure/fakes.js';
import { SyntheticComputerDriver } from '../infrastructure/synthetic-computer-driver.js';
import { computerActor, computerActInput, computerHarness, computerResult, mutateComputer, observeComputer, saveNoteSteps,
  submitComputerTask, type ComputerBackend, type ComputerHarness } from './computer-use-helpers.js';

const backends: ComputerBackend[] = ['sqlite', 'file-journal'];
const limits = { callId: 'reconciliation-context', maxOutputTokens: 100, maxInputBytes: 200000, maxInputTokens: 1000000, forceCompact: true };

async function fixture(t: TestContext, backend: ComputerBackend, phase: 'reserved' | 'settled' = 'settled') {
  let current = await computerHarness(backend); const directory = current.directory;
  t.after(async () => { await current.close(false); await rm(directory, { recursive: true, force: true }); });
  const h = current; const driver = h.driver as SyntheticComputerDriver;
  const initial = await h.runtime.state(h.workId);
  assert.equal(Object.hasOwn(buildContextPacket(initial, h.contracts), 'computerReconciliations'), false);
  const legacyResume = await h.recovery.restore(h.workId, computerActor);
  assert.equal(Object.hasOwn(legacyResume.packet.context, 'computerReconciliations'), false);
  assert.equal(Object.hasOwn(legacyResume.packet.runtime, 'computerReconciliations'), false);
  const observed = await observeComputer(h);
  driver.injectNextAction({}); driver.injectNextAction({ outcome: 'applied_unknown' });
  const attempt = await submitComputerTask(h, 'act', computerActInput(observed.observationId, saveNoteSteps));
  await h.runtime.execute(h.workId, attempt.id); await h.runtime.adopt(h.workId, attempt.id);
  const originalState = await h.runtime.state(h.workId); const originalAttempt = originalState.attempts.find(value => value.id === attempt.id)!;
  assert.equal(originalAttempt.adopted, false); assert.equal(originalAttempt.effectState, 'unknown');
  assert.ok(originalAttempt.computerUse); assert.deepEqual((await computerResult(h, attempt.id)).evidence, []);
  assert.equal(driver.snapshot().inputCount, 2); assert.equal(driver.snapshot().saveCount, 1);
  const service = h.computerReconciliations; assert.ok(service, 'composition exposes the reviewed reconciliation service');
  const reserved = await service.reserve(h.workId, 'context-read', computerActor,
    { attemptId: attempt.id, checkpointId: originalAttempt.computerUse.head.id });
  assert.equal(reserved.status, 'reserved');
  let record = reserved;
  if (phase === 'settled') {
    assert.equal((await service.execute(h.workId, record.id, computerActor)).status, 'received');
    record = await service.settle(h.workId, record.id, computerActor);
    assert.equal(record.status, 'settled'); assert.equal(record.outcome, 'applied'); assert.equal(record.effectState, 'confirmed');
  }
  const state = await h.runtime.state(h.workId);
  assert.deepEqual(state.attempts.find(value => value.id === attempt.id), originalAttempt);
  assert.deepEqual(state.evidence, originalState.evidence, 'an input receipt does not create completion evidence');
  assert.equal(await service.current(state), true);
  const decode = async (ref: NonNullable<typeof record.responseArtifact>) => JSON.parse(new TextDecoder().decode(await h.artifacts.get(ref, state.policy))) as unknown;
  const request = ComputerReconciliationIntentSchema.parse(await decode(record.requestArtifact));
  assert.deepEqual(request.identity.action, saveNoteSteps[1]!.action);
  if (record.responseArtifact) {
    const response = ComputerReconciliationResponseSchema.parse(await decode(record.responseArtifact));
    assert.equal(response.result.status, 'found');
    if (response.result.status === 'found') assert.equal(response.result.receipt.kind, 'computer_operation_receipt');
  }
  return { h, driver, record, originalAttempt, originalState, directory,
    async reopen() {
      await current.close(false);
      current = await computerHarness(backend, { directory });
      return current;
    } };
}

function assertMetadata(packet: ContextPacket, record: ComputerReconciliation, status: 'reserved' | 'settled') {
  assert.deepEqual(packet.computerReconciliations, [record]);
  assert.equal(packet.obligations.find(value => value.id === record.obligationId)?.status, status === 'reserved' ? 'pending' : 'satisfied');
  const serialized = JSON.stringify(packet);
  for (const rawKind of ['computer_reconciliation_intent', 'computer_reconciliation_response', 'computer_operation_receipt'])
    assert.equal(serialized.includes(`"kind":"${rawKind}"`), false, `${rawKind} body is retained only in its artifact`);
  const index = packet.computerReconciliations![0]!;
  for (const key of ['action', 'identity', 'receipt', 'result', 'lease']) assert.equal(Object.hasOwn(index, key), false);
}

function assertNoExecution(h: ComputerHarness, inputs = 2) {
  const driver = h.driver as SyntheticComputerDriver;
  assert.equal(driver.snapshot().inputCount, inputs); assert.equal(driver.snapshot().saveCount, 1);
  assert.ok(h.services.planner instanceof ScriptedPlanner); assert.equal(h.services.planner.inputs.length, 0);
}

for (const backend of backends) {
  for (const phase of ['reserved', 'settled'] as const) test(`reconciliation context ${backend}: ${phase} metadata and original refs survive compaction and repository reopen`, async t => {
    const f = await fixture(t, backend, phase); const { h, record } = f;
    const baseline = await h.runtime.state(h.workId); const digests = new Set<string>();
    for (let cycle = 1; cycle <= 3; cycle++) {
      const state = await h.runtime.state(h.workId);
      const prepared = await h.context.prepare(state, { ...limits, callId: `reconcile-cycle-${cycle}` });
      assertMetadata(prepared.packet, record, phase); assert.equal(prepared.frame.memo.cycle, cycle);
      assert.equal(prepared.frame.metrics.extraModelCalls, 0); assert.equal(await h.context.sourcesCurrent(prepared.packet, state), true);
      digests.add(prepared.frame.protectedDigest);
      const missing = structuredClone(prepared.packet); delete missing.computerReconciliations;
      const altered = structuredClone(prepared.packet); altered.computerReconciliations![0]!.operationId = 'another-operation';
      assert.equal(await h.context.sourcesCurrent(missing, state), false); assert.equal(await h.context.sourcesCurrent(altered, state), false);
      assert.deepEqual(await h.state.get(h.workId), state, 'preparing or checking a context never settles an obligation');
      await transact(h.services, h.workId, `publish-reconcile-${cycle}`, 'context_compacted', {}, next => { next.contextHead = prepared.head; });
    }
    assert.equal(digests.size, 1, 'index and active obligations remain protected across repeated compaction');
    assertNoExecution(h);
    const reopened = await f.reopen(); const state = await reopened.runtime.state(reopened.workId);
    assert.deepEqual(state.attempts, baseline.attempts); assert.deepEqual(state.evidence, baseline.evidence);
    assert.deepEqual(state.budget, baseline.budget); assert.deepEqual(state.obligations, baseline.obligations);
    const prepared = await reopened.context.prepare(state, { ...limits, callId: 'reopened-reconciliation' });
    assertMetadata(prepared.packet, record, phase); assert.equal(prepared.frame.memo.cycle, 4);
    const restored = await reopened.recovery.restore(reopened.workId, computerActor);
    assertMetadata(restored.packet.context, record, phase); assert.deepEqual(restored.packet.runtime.computerReconciliations, [record]);
    for (const ref of computerReconciliationRefs(record)) assert.ok(restored.packet.runtime.artifacts.some(value => value.id === ref.id), ref.id);
    const again = await reopened.recovery.restore(reopened.workId, computerActor, restored.artifact);
    assert.equal(again.disposition, 'reused'); assert.deepEqual(again.packet, restored.packet);
    assert.deepEqual(await reopened.state.get(reopened.workId), state); assertNoExecution(reopened);
  });

  for (const fault of ['missing', 'corrupt'] as const) test(`reconciliation context ${backend}: ${fault} proof rejects source reuse, compaction and restore`, async t => {
    const { h, record } = await fixture(t, backend); const state = await h.runtime.state(h.workId);
    const prepared = await h.context.prepare(state, limits);
    const path = join(h.directory, 'artifacts', `${record.proofArtifact!.id}.blob`);
    if (fault === 'missing') await rm(path);
    else { const bytes = await readFile(path); bytes[0] = bytes[0] === 123 ? 91 : 123; await writeFile(path, bytes); }
    assert.equal(await h.computerReconciliations!.current(state), false);
    assert.equal(await h.context.sourcesCurrent(prepared.packet, state), false);
    await assert.rejects(h.context.prepare(state, { ...limits, callId: 'lost-proof' }), /context_state_changed/);
    await assert.rejects(h.recovery.restore(h.workId, computerActor), /resume_effect_proof_changed/);
    assert.deepEqual(await h.state.get(h.workId), state, 'read failures never manufacture a new proof or completion claim');
    assertNoExecution(h);
  });

  for (const derived of ['model_context', 'runtime_resume'] as const) test(`reconciliation context ${backend}: proof loss during ${derived} staging is rejected before return`, async t => {
    const { h, record } = await fixture(t, backend); const state = await h.runtime.state(h.workId); let deleted = false;
    const artifacts: ArtifactStore = {
      get: (...args) => h.artifacts.get(...args), exists: ref => h.artifacts.exists(ref),
      put: async (bytes, attributes) => {
        const ref = await h.artifacts.put(bytes, attributes);
        if (!deleted && (JSON.parse(new TextDecoder().decode(bytes)) as { kind?: string }).kind === derived) {
          deleted = true; await rm(join(h.directory, 'artifacts', `${record.proofArtifact!.id}.blob`));
        }
        return ref;
      },
    };
    const services = { ...h.services, artifacts };
    if (derived === 'model_context') await assert.rejects(new ContextCompiler(services, h.contracts, h.guidance).prepare(state, limits), /context_guidance_unavailable/);
    else await assert.rejects(new ContextRecovery(services, h.contracts).restore(h.workId, computerActor), /resume_effect_proof_changed/);
    assert.equal(deleted, true); assert.deepEqual(await h.state.get(h.workId), state); assertNoExecution(h);
  });

  test(`reconciliation context ${backend}: lifecycle and read permission changes hide the index and prevent resume without dropping the pending obligation`, async t => {
    const { h, record } = await fixture(t, backend); const state = await h.runtime.state(h.workId);
    const prepared = await h.context.prepare(state, limits);
    for (const edit of [
      (value: WorkState) => { value.dataLifecycle = { generation: 0, blockedArtifactIds: [record.requestArtifact.id], changes: [] }; },
      (value: WorkState) => { value.policy.allowedLabels = []; },
      (value: WorkState) => { value.policy.tenantId = 'another-tenant'; },
    ]) {
      const restricted = structuredClone(state); edit(restricted);
      assert.deepEqual(computerReconciliationContext(restricted), []);
      assert.equal(await h.context.sourcesCurrent(prepared.packet, restricted), false);
    }
    const extended = structuredClone(state);
    Object.assign(extended.computerReconciliations![0]!, { action: { value: 'RAW_RECEIPT_EXTENSION' }, receipt: { body: 'RAW_RECEIPT_EXTENSION' } });
    const projected = buildContextPacket(extended, h.contracts);
    assert.deepEqual(projected.computerReconciliations, [record]); assert.equal(JSON.stringify(projected).includes('RAW_RECEIPT_EXTENSION'), false);
    await mutateComputer(h, value => { value.dataLifecycle = { generation: 1, blockedArtifactIds: [], changes: [] }; });
    const refreshed = await h.computerReconciliations!.refresh(h.workId);
    assert.equal(refreshed.computerReconciliations![0]!.status, 'failed');
    assert.equal(refreshed.obligations.find(value => value.id === record.obligationId)!.status, 'pending');
    const packet = buildContextPacket(refreshed, h.contracts);
    assert.deepEqual(packet.computerReconciliations, []);
    assert.equal(packet.obligations.find(value => value.id === record.obligationId)!.status, 'pending');
    // Diagnostic projection of invalidated originals does not authorize an executable resume packet.
    await assert.rejects(h.recovery.restore(h.workId, computerActor), /resume_effect_proof_changed/);
    assert.deepEqual(await h.state.get(h.workId), refreshed, 'failed restore preserves state, evidence and every stored head');
    assert.deepEqual(refreshed.attempts, state.attempts); assert.deepEqual(refreshed.evidence, state.evidence); assertNoExecution(h);
  });

  test(`reconciliation context ${backend}: a runtime without an effect proof reader rejects settled metadata`, async t => {
    const { h } = await fixture(t, backend); const state = await h.runtime.state(h.workId);
    const prepared = await h.context.prepare(state, limits); const services = { ...h.services, effects: undefined };
    const compiler = new ContextCompiler(services, h.contracts, h.guidance);
    assert.equal(await compiler.sourcesCurrent(prepared.packet, state), false);
    await assert.rejects(compiler.prepare(state, { ...limits, callId: 'no-proof-reader' }), /context_state_changed/);
    await assert.rejects(new ContextRecovery(services, h.contracts).restore(h.workId, computerActor), /resume_effect_proof_changed/);
    assert.deepEqual(await h.state.get(h.workId), state); assertNoExecution(h);
  });
}
