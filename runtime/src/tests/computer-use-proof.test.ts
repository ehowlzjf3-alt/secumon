import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactStore, StateRepository } from '../application/ports.js';
import type { ToolResult } from '../domain/model.js';
import { SyntheticComputerDriver } from '../infrastructure/synthetic-computer-driver.js';
import { computerActor, computerActInput, computerHarness, computerResult, mutateComputer, observeComputer, saveNoteSteps,
  submitComputerTask, type ComputerBackend, type ComputerHarness } from './computer-use-helpers.js';

function artifactsWithPut(store: ArtifactStore, put: ArtifactStore['put']): ArtifactStore {
  return { get: store.get.bind(store), exists: store.exists.bind(store), put };
}
const zero = { transportCalls: 0, internalOperations: 0, imageBytes: 0, waitMs: 0 };
for (const backend of ['sqlite', 'file-journal'] as ComputerBackend[]) {
  test(`${backend}: a failed observation artifact write retains the driver's measured call`, async t => {
    let failed = false;
    const h = await computerHarness(backend, { artifacts: store => artifactsWithPut(store, async (bytes, attributes) => {
      if (!failed && JSON.parse(new TextDecoder().decode(bytes)).kind === 'computer_observation') { failed = true; throw new Error('fixture_put_failed'); }
      return store.put(bytes, attributes);
    }) }); t.after(() => h.close());
    const attempt = await submitComputerTask(h, 'observe'); await h.runtime.execute(h.workId, attempt.id);
    const result = await computerResult(h, attempt.id); assert.equal(failed, true);
    assert.equal(result.status, 'error'); assert.equal(result.effectState, 'none'); assert.equal(result.usage!.transportCalls, 1);
    assert.deepEqual(result.artifacts, []); assert.deepEqual(result.evidence, []);
    assert.equal((h.driver as SyntheticComputerDriver).snapshot().inputCount, 0);
    const state = await h.runtime.state(h.workId);
    assert.equal(state.attempts.find(value => value.id === attempt.id)!.execution!.usage.transportCalls, 1);
  });

  test(`${backend}: intent persistence failure proves no driver entry and keeps the failed step diagnostic`, async t => {
    let failed = false;
    const h = await computerHarness(backend, { artifacts: store => artifactsWithPut(store, async (bytes, attributes) => {
      const value = JSON.parse(new TextDecoder().decode(bytes));
      if (!failed && value.kind === 'computer_checkpoint' && value.steps.at(-1)?.status === 'intent') { failed = true; throw new Error('fixture_intent_put_failed'); }
      return store.put(bytes, attributes);
    }) }); t.after(() => h.close());
    const observed = await observeComputer(h); const attempt = await submitComputerTask(h, 'act', computerActInput(observed.observationId, saveNoteSteps));
    await h.runtime.execute(h.workId, attempt.id); const result = await computerResult(h, attempt.id);
    assert.equal(failed, true); assert.equal(result.status, 'partial'); assert.equal(result.effectState, 'none');
    const trace = await h.computerUse.inspect(h.workId, computerActor, attempt.id);
    assert.equal(trace.checkpoint.steps.length, 1); assert.equal(trace.checkpoint.steps[0]!.status, 'not_applied');
    assert.equal(trace.progress.pendingOperationId, null); assert.equal((h.driver as SyntheticComputerDriver).snapshot().inputCount, 0);
    await h.runtime.adopt(h.workId, attempt.id);
    assert.equal((await h.runtime.state(h.workId)).obligations.some(value => value.kind === 'effect_reconciliation' && value.status === 'pending'), false);
  });

  for (const proofRevoked of [false, true]) test(`${backend}: cancellation before driver entry settles no-input and proof revoked=${proofRevoked} fences adoption`, async t => {
    let h!: ComputerHarness; let cancelled = false;
    h = await computerHarness(backend, { store: store => new Proxy(store, { get(target, key) {
      if (key === 'commit') return (async request => {
        const result = await target.commit(request);
        if (!cancelled && result.kind === 'committed' && request.events.some(event => event.type === 'computer_checkpoint_stored') &&
          request.next.attempts.some(attempt => attempt.computerUse?.pendingOperationId)) {
          cancelled = true;
          await h.runtime.command(h.workId, 'cancel-before-driver-entry', computerActor, request.next.goal.revision, { kind: 'cancel', reason: 'Stop before input' });
        }
        return result;
      }) as StateRepository['commit'];
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } }) }); t.after(() => h.close());
    const observed = await observeComputer(h); const attempt = await submitComputerTask(h, 'act', computerActInput(observed.observationId, saveNoteSteps));
    await h.runtime.execute(h.workId, attempt.id); await h.runtime.settlePending(attempt.id);
    const result = await computerResult(h, attempt.id); assert.equal(cancelled, true); assert.equal(result.effectState, 'none');
    const trace = await h.computerUse.inspect(h.workId, computerActor, attempt.id); assert.equal(trace.checkpoint.steps[0]!.status, 'not_applied');
    assert.equal((await h.runtime.state(h.workId)).obligations.find(value => value.id === `effect:${attempt.id}`)!.status, 'satisfied');
    if (proofRevoked) h.contracts.replaceProvider('synthetic', [], { expectedEpoch: h.contracts.providerEpoch('synthetic'), sourceRevision: 'removed-before-adopt' });
    await h.runtime.adopt(h.workId, attempt.id); const state = await h.runtime.state(h.workId);
    assert.equal(state.status, 'cancelled'); assert.equal(state.attempts.find(value => value.id === attempt.id)!.adopted, false);
    assert.equal(state.obligations.find(value => value.id === `effect:${attempt.id}`)!.status, proofRevoked ? 'pending' : 'satisfied');
    assert.equal((h.driver as SyntheticComputerDriver).snapshot().inputCount, 0);
  });

  test(`${backend}: a failure cannot downgrade the committed unknown effect or measured usage prefix`, async t => {
    const h = await computerHarness(backend); t.after(() => h.close()); const observed = await observeComputer(h);
    const driver = h.driver as SyntheticComputerDriver; driver.injectNextAction({}); driver.injectNextAction({ outcome: 'applied_unknown' });
    const attempt = await submitComputerTask(h, 'act', computerActInput(observed.observationId, saveNoteSteps)); await h.runtime.execute(h.workId, attempt.id);
    const state = await h.runtime.state(h.workId); const result = await computerResult(h, attempt.id);
    assert.equal(result.effectState, 'unknown'); assert.equal(await h.contracts.validateResult(state, result), true);
    const failure: ToolResult = { ...result, status: 'error', artifacts: [], evidence: [], output: null };
    assert.equal(await h.contracts.validateResult(state, { ...failure, effectState: 'none' }), false);
    assert.equal(await h.contracts.validateResult(state, { ...failure, effectState: 'confirmed' }), false);
    assert.equal(await h.contracts.validateResult(state, { ...failure, usage: zero }), false);
    assert.equal(await h.contracts.validateResult(state, failure), true);
    await h.runtime.adopt(h.workId, attempt.id); const settled = await h.runtime.state(h.workId);
    assert.ok(settled.obligations.some(value => value.kind === 'effect_reconciliation' && value.status === 'pending'));
    await h.runtime.execute(h.workId, attempt.id); assert.equal(driver.snapshot().inputCount, 2); assert.equal(driver.snapshot().saveCount, 1);
  });

  test(`${backend}: removing the proof provider at the receive commit fence cannot accept a no-effect result`, async t => {
    let h!: ComputerHarness; let pendingResult: string | null = null; let removed = false;
    h = await computerHarness(backend, { artifacts: store => ({
      get: store.get.bind(store),
      put: async (bytes, attributes) => {
        const ref = await store.put(bytes, attributes); const value = JSON.parse(new TextDecoder().decode(bytes));
        if (!removed && value.resultId?.endsWith(':computer-run') && value.effectState === 'none') pendingResult = ref.id;
        return ref;
      },
      exists: async ref => {
        const exists = await store.exists(ref);
        if (!removed && ref.id === pendingResult) {
          removed = true;
          h.contracts.replaceProvider('synthetic', [], { expectedEpoch: h.contracts.providerEpoch('synthetic'), sourceRevision: 'removed-at-receive-fence' });
        }
        return exists;
      },
    }) }); t.after(() => h.close());
    const observed = await observeComputer(h); const driver = h.driver as SyntheticComputerDriver;
    driver.injectNextAction({ outcome: 'not_applied_timeout' });
    const attempt = await submitComputerTask(h, 'act', computerActInput(observed.observationId, saveNoteSteps)); await h.runtime.execute(h.workId, attempt.id);
    const state = await h.runtime.state(h.workId); const result = await computerResult(h, attempt.id);
    assert.equal(removed, true); assert.equal(result.status, 'error'); assert.equal(result.error?.code, 'invalid_tool_result');
    assert.equal(result.effectState, 'unknown'); assert.equal(state.attempts.find(value => value.id === attempt.id)!.adopted, false);
    assert.equal(state.obligations.find(value => value.id === `effect:${attempt.id}`)!.status, 'pending');
    assert.equal(driver.snapshot().inputCount, 0); assert.equal(driver.snapshot().saveCount, 0);
  });

  test(`${backend}: provider removal between no-effect validation and adoption cannot skip the captured proof fence`, async t => {
    let h!: ComputerHarness; let armed = false; let removed = false;
    h = await computerHarness(backend, { store: store => new Proxy(store, { get(target, key) {
      if (key === 'receipt') return (async (workId, commandId) => {
        if (armed && !removed && commandId.startsWith('adopt:')) {
          removed = true;
          h.contracts.replaceProvider('synthetic', [], { expectedEpoch: h.contracts.providerEpoch('synthetic'), sourceRevision: 'removed-before-adopt-mutator' });
        }
        return target.receipt(workId, commandId);
      }) as StateRepository['receipt'];
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } }) }); t.after(() => h.close());
    const observed = await observeComputer(h); const driver = h.driver as SyntheticComputerDriver;
    driver.injectNextAction({ outcome: 'not_applied_timeout' });
    const attempt = await submitComputerTask(h, 'act', computerActInput(observed.observationId, saveNoteSteps)); await h.runtime.execute(h.workId, attempt.id);
    const state = await h.runtime.state(h.workId); assert.equal((await computerResult(h, attempt.id)).effectState, 'none'); armed = true;
    await assert.rejects(h.runtime.adopt(h.workId, attempt.id), /tool_proof_changed/); assert.equal(removed, true);
    assert.deepEqual(await h.runtime.state(h.workId), state);
    assert.equal(await h.state.receipt(h.workId, `adopt:${attempt.id}`), null);
    await h.runtime.adopt(h.workId, attempt.id); const rejected = await h.runtime.state(h.workId);
    assert.equal(rejected.attempts.find(value => value.id === attempt.id)!.adopted, false);
    assert.equal(rejected.obligations.find(value => value.id === `effect:${attempt.id}`)!.status, 'pending');
    assert.equal(driver.snapshot().inputCount, 0); assert.equal(driver.snapshot().saveCount, 0);
  });

  test(`${backend}: completion must match the checkpoint and only explicitly confirmed facts become evidence`, async t => {
    const h = await computerHarness(backend); t.after(() => h.close()); const observed = await observeComputer(h);
    const attempt = await submitComputerTask(h, 'act', computerActInput(observed.observationId, saveNoteSteps)); await h.runtime.execute(h.workId, attempt.id);
    const state = await h.runtime.state(h.workId); const result = await computerResult(h, attempt.id);
    assert.deepEqual(result.evidence[0]!.facts, { savedNote: 'reviewed' }); assert.equal(await h.contracts.validateResult(state, result), true);
    const forged = structuredClone(result); forged.evidence[0]!.facts['savedNote'] = 'different';
    assert.equal(await h.contracts.validateResult(state, forged), false);
    assert.equal(await h.contracts.validateResult(state, { ...result, output: { kind: 'computer_run', completedSteps: 3 } }), false);
    assert.equal(await h.contracts.validateResult(state, { ...result, usage: zero }), false);
    assert.deepEqual(await h.runtime.state(h.workId), state);
  });

  for (const removed of ['checkpoint', 'observation'] as const) test(`${backend}: losing the ${removed} original between receive and adopt prevents completion`, async t => {
    const h = await computerHarness(backend); t.after(() => h.close()); const observed = await observeComputer(h);
    const attempt = await submitComputerTask(h, 'act', computerActInput(observed.observationId, saveNoteSteps)); await h.runtime.execute(h.workId, attempt.id);
    const trace = await h.computerUse.inspect(h.workId, computerActor, attempt.id);
    const ref = removed === 'checkpoint' ? trace.progress.head : trace.checkpoint.latestObservation;
    await rm(join(h.directory, 'artifacts', `${ref.id}.blob`));
    const state = await h.runtime.state(h.workId); const result = await computerResult(h, attempt.id);
    assert.equal(await h.contracts.validateResult(state, result), false);
    await assert.rejects(h.runtime.adopt(h.workId, attempt.id), /artifact_unavailable/);
    assert.equal((await h.runtime.state(h.workId)).attempts.find(value => value.id === attempt.id)!.adopted, false);
    assert.equal((h.driver as SyntheticComputerDriver).snapshot().saveCount, 1);
  });

  test(`${backend}: diagnostic reads recheck retained knowledge before and after original IO`, async t => {
    const h = await computerHarness(backend); t.after(() => h.close()); const observed = await observeComputer(h);
    const attempt = await submitComputerTask(h, 'act', computerActInput(observed.observationId, saveNoteSteps)); await h.runtime.execute(h.workId, attempt.id);
    await mutateComputer(h, state => { state.attempts.find(value => value.id === attempt.id)!.knowledgeDependencies = [{ tenantId: state.policy.tenantId,
      knowledgeId: 'retained-note', knowledgeRevision: 1, actorDigest: 'a'.repeat(64), parents: [], sources: [{ workId: 'source', evidenceId: 'note',
        sourceVersion: 'b'.repeat(64), generation: 0, workRevision: 1, policyDigest: 'c'.repeat(64) }] }]; });
    const state = await h.runtime.state(h.workId); let calls = 0;
    h.services.knowledge = { validate: async () => ++calls === 1 };
    await assert.rejects(h.computerUse.inspect(h.workId, computerActor, attempt.id), /computer_knowledge_changed/); assert.equal(calls, 2);
    calls = 0; h.services.knowledge = { validate: async () => { calls++; return false; } };
    await assert.rejects(h.computerUse.inspect(h.workId, computerActor, attempt.id), /computer_knowledge_changed/); assert.equal(calls, 1);
    assert.deepEqual(await h.runtime.state(h.workId), state);
  });
}
