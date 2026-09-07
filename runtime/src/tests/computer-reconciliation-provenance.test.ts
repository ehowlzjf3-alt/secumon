import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { StateRepository } from '../application/ports.js';
import type { ComputerReconciliation } from '../domain/computer-reconciliation.js';
import { SyntheticComputerDriver } from '../infrastructure/synthetic-computer-driver.js';
import { computerActor, computerActInput, computerHarness, observeComputer, saveNoteSteps,
  submitComputerTask, type ComputerBackend } from './computer-use-helpers.js';

type Stage = 'reserve' | 'dispatch' | 'receive' | 'settle';
type Tamper = { commandId: string; kind: 'missing' | 'digest' | 'record_ref' } | null;
type Receipt = NonNullable<Awaited<ReturnType<StateRepository['receipt']>>>;
const stages: Stage[] = ['reserve', 'dispatch', 'receive', 'settle'];

async function fixture(t: TestContext, backend: ComputerBackend) {
  let tamper: Tamper = null;
  const calls = { commit: 0, put: 0, alteredReceipts: 0 };
  const originals = new Map<string, Receipt>();
  const h = await computerHarness(backend, {
    store: repository => ({
      get: id => repository.get(id),
      async receipt(id, commandId) {
        const actual = await repository.receipt(id, commandId);
        if (actual && commandId.startsWith('reconcile-')) originals.set(commandId, structuredClone(actual));
        if (!tamper || tamper.commandId !== commandId || !actual) return actual;
        calls.alteredReceipts++;
        if (tamper.kind === 'missing') return null;
        const changed = structuredClone(actual);
        if (tamper.kind === 'digest') changed.digest = '0'.repeat(64);
        else {
          const record = changed.state.computerReconciliations!.at(-1)!;
          const target = commandId.startsWith('reconcile-reserve:') ? record.requestArtifact :
            commandId.startsWith('reconcile-dispatch:') ? record.sourceHead :
              commandId.startsWith('reconcile-receive:') ? record.responseArtifact! : record.proofArtifact!;
          target.sha256 = '0'.repeat(64);
        }
        return changed;
      },
      async commit(request) { calls.commit++; return repository.commit(request); },
      events: (id, after) => repository.events(id, after), deliveries: id => repository.deliveries(id),
      recentEventMetadata: (id, query) => repository.recentEventMetadata(id, query),
      conversationWorkPage: query => repository.conversationWorkPage(query), workIdsForConversation: (...args) => repository.workIdsForConversation(...args),
      runnable: now => repository.runnable(now), close: () => repository.close(),
    }),
    artifacts: store => ({ get: (ref, policy) => store.get(ref, policy), exists: ref => store.exists(ref),
      async put(bytes, attributes) { calls.put++; return store.put(bytes, attributes); } }),
  });
  t.after(() => h.close()); assert.ok(h.driver instanceof SyntheticComputerDriver); const driver = h.driver;
  const observed = await observeComputer(h); driver.injectNextAction({}); driver.injectNextAction({ outcome: 'applied_unknown' });
  const attempt = await submitComputerTask(h, 'act', computerActInput(observed.observationId, saveNoteSteps));
  await h.runtime.execute(h.workId, attempt.id); await h.runtime.adopt(h.workId, attempt.id);
  const state = (await h.state.get(h.workId))!; const source = state.attempts.find(value => value.id === attempt.id)!;
  assert.ok(source.computerUse); assert.ok(source.resultArtifact); assert.equal(source.effectState, 'unknown');
  const sourceBytes = await h.artifacts.get(source.resultArtifact, state.policy);
  const headBytes = await h.artifacts.get(source.computerUse.head, state.policy);
  const input = { attemptId: source.id, checkpointId: source.computerUse.head.id };
  const assertSource = async () => {
    const current = (await h.state.get(h.workId))!;
    assert.deepEqual(current.attempts.find(value => value.id === source.id), source);
    assert.deepEqual(await h.artifacts.get(source.resultArtifact!, current.policy), sourceBytes);
    assert.deepEqual(await h.artifacts.get(source.computerUse!.head, current.policy), headBytes);
    assert.deepEqual(current.evidence, state.evidence); assert.deepEqual(current.modelCalls, state.modelCalls);
  };
  return { h, driver, input, source, calls, originals, assertSource, setTamper(value: Tamper) { tamper = value; } };
}

for (const backend of ['sqlite', 'file-journal'] as const) {
  for (const stage of stages) {
    test(`${backend}: ${stage} command receipt is required to authenticate an otherwise intact reconciliation proof`, async t => {
      const f = await fixture(t, backend); const { h } = f;
      const settled = await h.computerReconciliations.reconcile(h.workId, 'provenance', computerActor, f.input);
      assert.equal(settled.status, 'settled'); assert.ok(settled.responseArtifact); assert.ok(settled.proofArtifact);
      const state = (await h.state.get(h.workId))!; const driverBefore = f.driver.snapshot();
      assert.equal(await h.computerReconciliations.current(state), true);
      const commandId = `reconcile-${stage}:${settled.id}`;
      const receipt = await h.state.receipt(h.workId, commandId); assert.ok(receipt);
      const requestBytes = await h.artifacts.get(settled.requestArtifact, state.policy);
      const responseBytes = await h.artifacts.get(settled.responseArtifact, state.policy);
      const proofBytes = await h.artifacts.get(settled.proofArtifact, state.policy);
      const calls = { commit: f.calls.commit, put: f.calls.put };
      for (const kind of ['digest', 'record_ref', 'missing'] as const) {
        f.setTamper({ commandId, kind }); const attempts = f.calls.alteredReceipts;
        assert.equal(await h.computerReconciliations.current(state), false, `${stage} ${kind} cannot authenticate the stored claim`);
        assert.ok(f.calls.alteredReceipts > attempts);
        assert.deepEqual(await h.state.get(h.workId), state, 'read-only verification does not repair or mutate the authoritative work');
        assert.equal(f.calls.commit, calls.commit); assert.equal(f.calls.put, calls.put);
        f.setTamper(null);
        assert.equal(await h.computerReconciliations.current(state), true);
        assert.deepEqual(await h.state.receipt(h.workId, commandId), receipt);
      }
      f.setTamper({ commandId, kind: 'missing' });
      const invalidated = await h.computerReconciliations.refresh(h.workId);
      const record = invalidated.computerReconciliations!.find(value => value.id === settled.id)!;
      assert.equal(record.status, 'failed'); assert.equal(record.reason, 'effect_proof_unavailable');
      assert.equal(record.outcome, settled.outcome); assert.equal(record.effectState, settled.effectState); assert.equal(record.finishedAt, settled.finishedAt);
      assert.deepEqual(record.requestArtifact, settled.requestArtifact); assert.deepEqual(record.responseArtifact, settled.responseArtifact); assert.deepEqual(record.proofArtifact, settled.proofArtifact);
      assert.equal(invalidated.obligations.find(value => value.id === record.obligationId)!.status, 'pending');
      assert.deepEqual(invalidated.budget, state.budget); assert.equal(f.calls.put, calls.put);
      f.setTamper(null);
      assert.deepEqual(await h.state.receipt(h.workId, commandId), receipt);
      assert.deepEqual(f.originals.get(commandId), receipt);
      assert.deepEqual(await h.artifacts.get(settled.requestArtifact, state.policy), requestBytes);
      assert.deepEqual(await h.artifacts.get(settled.responseArtifact, state.policy), responseBytes);
      assert.deepEqual(await h.artifacts.get(settled.proofArtifact, state.policy), proofBytes);
      await f.assertSource(); assert.deepEqual(f.driver.snapshot(), driverBefore);
    });
  }

  test(`${backend}: concurrent identical reserve, execute, and settle calls retain one intent, one lookup charge, and one proof`, async t => {
    const f = await fixture(t, backend); const { h } = f;
    const before = (await h.state.get(h.workId))!; const driverBefore = f.driver.snapshot(); const puts = f.calls.put;
    const records = await Promise.all(Array.from({ length: 3 }, () => h.computerReconciliations.reserve(h.workId, 'concurrent', computerActor, f.input)));
    const reserved = records[0]!; assert.equal(reserved.status, 'reserved');
    for (const record of records) assert.deepEqual(record, reserved);
    let state = (await h.state.get(h.workId))!;
    assert.equal(state.computerReconciliations!.length, 1); assert.equal(state.budget.reservedToolCalls, 1); assert.equal(state.budget.used.toolCalls, before.budget.used.toolCalls);
    assert.equal(f.calls.put, puts + 1); assert.deepEqual(f.driver.snapshot(), driverBefore);
    const responses = await Promise.all(Array.from({ length: 3 }, () => h.computerReconciliations.execute(h.workId, reserved.id, computerActor)));
    for (const response of responses) { assert.equal(response.status, 'received'); assert.deepEqual(response, responses[0]); }
    const proofs = await Promise.all(Array.from({ length: 3 }, () => h.computerReconciliations.settle(h.workId, reserved.id, computerActor)));
    const settled: ComputerReconciliation = proofs[0]!;
    for (const proof of proofs) { assert.equal(proof.status, 'settled'); assert.deepEqual(proof, settled); }
    state = (await h.state.get(h.workId))!;
    assert.equal(state.computerReconciliations!.length, 1); assert.equal(state.budget.reservedToolCalls, 0); assert.equal(state.budget.used.toolCalls, before.budget.used.toolCalls + 1);
    assert.equal(f.calls.put, puts + 3);
    assert.equal(f.driver.snapshot().usage.transportCalls - driverBefore.usage.transportCalls, 1);
    assert.equal(f.driver.snapshot().inputCount, driverBefore.inputCount); assert.equal(f.driver.snapshot().saveCount, driverBefore.saveCount);
    const events = await h.state.events(h.workId, 0);
    for (const type of ['computer_reconciliation_reserved', 'computer_reconciliation_dispatched', 'computer_reconciliation_response_stored', 'computer_reconciliation_settled'])
      assert.equal(events.filter(event => event.type === type).length, 1);
    assert.equal(await h.computerReconciliations.current(state), true); await f.assertSource();
    const duplicate = await h.computerReconciliations.reconcile(h.workId, 'concurrent', computerActor, f.input);
    assert.deepEqual(duplicate, settled); assert.deepEqual(await h.state.get(h.workId), state); assert.equal(f.calls.put, puts + 3);
  });
}
