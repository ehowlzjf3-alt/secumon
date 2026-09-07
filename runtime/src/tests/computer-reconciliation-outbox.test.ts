import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactStore, MessageSink } from '../application/ports.js';
import { OutboxDispatcher } from '../application/outbox.js';
import { FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { SyntheticComputerDriver } from '../infrastructure/synthetic-computer-driver.js';
import { computerActor, computerActInput, computerHarness, mutateComputer, observeComputer, saveNoteSteps,
  submitComputerTask, type ComputerBackend } from './computer-use-helpers.js';

async function fixture(t: TestContext, backend: ComputerBackend) {
  const h = await computerHarness(backend); t.after(() => h.close());
  assert.ok(h.driver instanceof SyntheticComputerDriver); const driver = h.driver;
  const observed = await observeComputer(h); driver.injectNextAction({}); driver.injectNextAction({ outcome: 'applied_unknown' });
  const attempt = await submitComputerTask(h, 'act', computerActInput(observed.observationId, saveNoteSteps));
  await h.runtime.execute(h.workId, attempt.id); await h.runtime.settlePending(attempt.id); await h.runtime.adopt(h.workId, attempt.id);
  const source = (await h.runtime.state(h.workId)).attempts.find(value => value.id === attempt.id)!;
  assert.equal(source.effectState, 'unknown'); assert.ok(source.computerUse);
  const record = await h.computerReconciliations.reconcile(h.workId, 'outbox-proof', computerActor,
    { attemptId: source.id, checkpointId: source.computerUse.head.id });
  assert.equal(record.status, 'settled'); assert.ok(record.proofArtifact);
  const saved = driver.snapshot(); assert.equal(saved.inputCount, 2); assert.equal(saved.saveCount, 1); assert.equal(saved.savedNote, 'reviewed');
  // Host fixture supplies a separate current observation for result readiness. A receipt alone never supplies this evidence.
  const confirmation = await h.artifacts.put(new TextEncoder().encode(JSON.stringify({ kind: 'synthetic_confirmation', savedNote: saved.savedNote })),
    { tenantId: computerActor.tenantId, labels: ['public'], mediaType: 'application/json' });
  await mutateComputer(h, state => {
    state.evidence.push({ id: 'current-confirmation', tenantId: state.policy.tenantId, scope: state.goal.scope,
      sourceId: 'synthetic-confirmation', lineageId: 'synthetic-confirmation', locator: confirmation.id,
      observedAt: h.clock.now(), recordedAt: h.clock.now(), labels: ['public'], coverage: 'complete', status: 'accepted',
      supersedes: [], derivedFrom: [], facts: { savedNote: saved.savedNote }, artifact: confirmation });
    state.conversation = { primaryBindingId: 'outbox-binding', completionRequiresDelivery: true, result: null,
      bindings: [{ id: 'outbox-binding', ...computerActor, channel: 'cli', conversationId: 'synthetic-outbox', destination: 'local', recipientId: computerActor.principalId }] };
    state.obligations.push({ id: 'response-delivery:1', kind: 'delivery', reason: 'result_delivery_required', status: 'pending', wakeKey: null, dueAt: state.deadlineAt });
    state.status = 'waiting'; state.statusReason = 'result_delivery_pending';
  });
  const delivery = await h.conversation.prepare(h.workId, computerActor); assert.ok(delivery); assert.equal(delivery.kind, 'result');
  const baseline = await h.runtime.state(h.workId); assert.equal(await h.computerReconciliations.current(baseline), true);
  let sends = 0; let lookups = 0; const channel = new FakeSink();
  let sendMode: 'delivered' | 'unknown' = 'delivered'; let afterSend: (() => Promise<void>) | undefined; let afterLookup: (() => Promise<void>) | undefined;
  const sink: MessageSink = {
    capabilities: channel.capabilities,
    send: async value => { sends++; const result = await channel.send(value); await afterSend?.(); return sendMode === 'unknown' ? { status: 'unknown' } : result; },
    lookup: async value => { lookups++; const result = await channel.lookup(value); await afterLookup?.(); return result; },
  };
  const outbox = new OutboxDispatcher({ ...h.services, sink }, 'proof-aware-sender', 1000);
  const dropProof = () => rm(join(h.directory, 'artifacts', `${record.proofArtifact!.id}.blob`));
  const storedDelivery = async () => (await h.state.deliveries(h.workId)).find(value => value.id === delivery.id)!;
  async function assertUnavailable(expected: 'pending' | 'sending' | 'unknown') {
    const state = await h.runtime.state(h.workId);
    assert.equal((await storedDelivery()).status, expected);
    assert.equal(state.computerReconciliations!.find(value => value.id === record.id)!.status, 'failed');
    assert.equal(state.obligations.find(value => value.id === record.obligationId)!.status, 'pending');
    assert.equal(state.obligations.find(value => value.id === 'response-delivery:1')!.status, 'pending');
    assert.notEqual(state.status, 'completed'); assert.deepEqual(state.attempts, baseline.attempts); assert.deepEqual(state.evidence, baseline.evidence);
    assert.equal(driver.snapshot().inputCount, 2); assert.equal(driver.snapshot().saveCount, 1);
    assert.ok(h.services.planner instanceof ScriptedPlanner); assert.equal(h.services.planner.inputs.length, 0);
  }
  return { h, record, delivery, baseline, outbox, sink, dropProof, storedDelivery, assertUnavailable,
    sends: () => sends, lookups: () => lookups, setSendUnknown: () => { sendMode = 'unknown'; },
    afterSend: (callback: () => Promise<void>) => { afterSend = callback; }, afterLookup: (callback: () => Promise<void>) => { afterLookup = callback; } };
}

for (const backend of ['sqlite', 'file-journal'] as const) {
  test(`reconciliation outbox ${backend}: current proof permits one result send and delivery obligation settlement`, async t => {
    const f = await fixture(t, backend); await f.outbox.flush(f.h.workId, computerActor); await f.outbox.flush(f.h.workId, computerActor);
    assert.equal(f.sends(), 1); assert.equal(f.lookups(), 0); assert.equal((await f.storedDelivery()).status, 'delivered');
    const state = await f.h.runtime.state(f.h.workId);
    assert.equal(state.obligations.find(value => value.id === 'response-delivery:1')!.status, 'satisfied');
    assert.equal(state.obligations.find(value => value.id === f.record.obligationId)!.status, 'satisfied');
    assert.deepEqual(state.attempts, f.baseline.attempts); assert.equal(await f.h.computerReconciliations.current(state), true);
  });

  test(`reconciliation outbox ${backend}: narrowed tool authority preserves proof validation while channel restrictions still apply`, async t => {
    const f = await fixture(t, backend); f.setSendUnknown();
    const reader = { ...computerActor, allowWrites: false, allowedTools: [], allowedLabels: ['public'], allowedDestinations: ['local'] };
    await f.outbox.flush(f.h.workId, reader); await f.outbox.flush(f.h.workId, reader);
    assert.equal(f.sends(), 1); assert.equal(f.lookups(), 1); assert.equal((await f.storedDelivery()).status, 'delivered');
    const state = await f.h.runtime.state(f.h.workId);
    assert.deepEqual(state.computerReconciliations, f.baseline.computerReconciliations);
    assert.equal(state.obligations.find(value => value.id === 'response-delivery:1')!.status, 'satisfied');
    assert.equal(await f.h.computerReconciliations.current(state), true);
    const denied = await fixture(t, backend);
    await denied.outbox.flush(denied.h.workId, { ...reader, allowedDestinations: [] });
    assert.equal(denied.sends(), 0); assert.equal(denied.lookups(), 0); assert.equal((await denied.storedDelivery()).status, 'superseded');
    assert.deepEqual((await denied.h.runtime.state(denied.h.workId)).computerReconciliations, denied.baseline.computerReconciliations);
  });

  test(`reconciliation outbox ${backend}: proof loss at the same revision prevents any result transport`, async t => {
    const f = await fixture(t, backend); await f.dropProof(); assert.equal((await f.h.runtime.state(f.h.workId)).revision, f.baseline.revision);
    await f.outbox.flush(f.h.workId, computerActor);
    assert.equal(f.sends(), 0); assert.equal(f.lookups(), 0); await f.assertUnavailable('pending');
  });

  test(`reconciliation outbox ${backend}: proof loss defers lookup of an already sent uncertain result`, async t => {
    const f = await fixture(t, backend); f.setSendUnknown(); await f.outbox.flush(f.h.workId, computerActor);
    assert.equal((await f.storedDelivery()).status, 'unknown'); const revision = (await f.h.runtime.state(f.h.workId)).revision;
    await f.dropProof(); assert.equal((await f.h.runtime.state(f.h.workId)).revision, revision);
    await f.outbox.flush(f.h.workId, computerActor); await f.outbox.flush(f.h.workId, computerActor);
    assert.equal(f.sends(), 1); assert.equal(f.lookups(), 0); await f.assertUnavailable('unknown');
  });

  test(`reconciliation outbox ${backend}: proof loss after the send claim is checked before entering the sink`, async t => {
    const f = await fixture(t, backend); let deleted = false;
    const state = new Proxy(f.h.state, { get(target, key) {
      if (key === 'get') return async (workId: string) => {
        const value = await target.get(workId);
        if (!deleted && (await target.deliveries(workId)).some(delivery => delivery.id === f.delivery.id && delivery.status === 'sending')) {
          deleted = true; await f.dropProof();
        }
        return value;
      };
      const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const outbox = new OutboxDispatcher({ ...f.h.services, state, sink: f.sink }, 'proof-entry-sender', 1000);
    await outbox.flush(f.h.workId, computerActor);
    assert.equal(deleted, true); assert.equal(f.sends(), 0); assert.equal(f.lookups(), 0); await f.assertUnavailable('sending');
  });

  test(`reconciliation outbox ${backend}: proof loss in the pre-lookup artifact await prevents receipt lookup`, async t => {
    const f = await fixture(t, backend); f.setSendUnknown(); await f.outbox.flush(f.h.workId, computerActor); let deleted = false;
    const artifacts: ArtifactStore = { get: (...args) => f.h.artifacts.get(...args), put: (...args) => f.h.artifacts.put(...args),
      exists: async ref => {
        const exists = await f.h.artifacts.exists(ref);
        if (!deleted && ref.id === f.delivery.context!.artifact!.id) { deleted = true; await f.dropProof(); }
        return exists;
      } };
    const outbox = new OutboxDispatcher({ ...f.h.services, sink: f.sink, artifacts }, 'proof-lookup-sender', 1000);
    await outbox.flush(f.h.workId, computerActor);
    assert.equal(deleted, true); assert.equal(f.sends(), 1); assert.equal(f.lookups(), 0); await f.assertUnavailable('unknown');
  });

  test(`reconciliation outbox ${backend}: proof loss during send keeps the delivery unadopted without resending`, async t => {
    const f = await fixture(t, backend); f.afterSend(f.dropProof);
    await f.outbox.flush(f.h.workId, computerActor); await f.outbox.flush(f.h.workId, computerActor);
    assert.equal(f.sends(), 1); assert.equal(f.lookups(), 0); await f.assertUnavailable('sending');
  });

  test(`reconciliation outbox ${backend}: proof loss during receipt lookup cannot close the delivery obligation`, async t => {
    const f = await fixture(t, backend); f.setSendUnknown(); await f.outbox.flush(f.h.workId, computerActor); f.afterLookup(f.dropProof);
    await f.outbox.flush(f.h.workId, computerActor); await f.outbox.flush(f.h.workId, computerActor);
    assert.equal(f.sends(), 1); assert.equal(f.lookups(), 1); await f.assertUnavailable('unknown');
  });

  test(`reconciliation outbox ${backend}: the commit guard rechecks proof after awaited artifact validation`, async t => {
    const f = await fixture(t, backend); let armed = false; let deleted = false; f.afterSend(async () => { armed = true; });
    const artifacts: ArtifactStore = { get: (...args) => f.h.artifacts.get(...args), put: (...args) => f.h.artifacts.put(...args),
      exists: async ref => {
        const exists = await f.h.artifacts.exists(ref);
        if (armed && !deleted && ref.id === f.delivery.context!.artifact!.id) { deleted = true; await f.dropProof(); }
        return exists;
      } };
    const outbox = new OutboxDispatcher({ ...f.h.services, sink: f.sink, artifacts }, 'proof-commit-sender', 1000);
    await outbox.flush(f.h.workId, computerActor);
    assert.equal(deleted, true); assert.equal(f.sends(), 1); assert.equal(f.lookups(), 0); await f.assertUnavailable('sending');
  });
}
