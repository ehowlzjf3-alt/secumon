import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkViewAccess, WorkViewResult } from '../domain/work-view.js';
import { WorkViewService } from '../application/work-view-service.js';
import { SyntheticComputerDriver } from '../infrastructure/synthetic-computer-driver.js';
import { ScriptedPlanner } from '../infrastructure/fakes.js';
import { computerActor, computerActInput, computerHarness, mutateComputer, observeComputer, saveNoteSteps,
  submitComputerTask, type ComputerBackend } from './computer-use-helpers.js';

const access: WorkViewAccess = { channel: 'test', conversationId: 'effect-view', destination: 'local',
  recipientId: computerActor.principalId, allowDiagnostics: true };
function snapshot(result: WorkViewResult) {
  assert.equal(result.kind, 'snapshot'); if (result.kind !== 'snapshot') throw new Error('snapshot_expected'); return result;
}
async function fixture(t: TestContext, backend: ComputerBackend) {
  const calls = { commit: 0, put: 0 }; let metadataHook: (() => Promise<void>) | null = null;
  const h = await computerHarness(backend, {
    store: repository => ({
      get: id => repository.get(id), receipt: (id, commandId) => repository.receipt(id, commandId),
      async commit(request) { calls.commit++; return repository.commit(request); },
      events: (id, after) => repository.events(id, after), deliveries: id => repository.deliveries(id),
      eventPage: (id, query) => repository.eventPage(id, query),
      async recentEventMetadata(id, query) { await metadataHook?.(); return repository.recentEventMetadata(id, query); },
      conversationWorkPage: query => repository.conversationWorkPage(query),
      workIdsForConversation: (...args) => repository.workIdsForConversation(...args), runnable: now => repository.runnable(now), close: () => repository.close(),
    }),
    artifacts: store => ({ get: (ref, policy) => store.get(ref, policy), exists: ref => store.exists(ref),
      async put(bytes, attributes) { calls.put++; return store.put(bytes, attributes); } }),
  });
  t.after(() => h.close()); assert.ok(h.driver instanceof SyntheticComputerDriver); const driver = h.driver;
  const observation = await observeComputer(h); driver.injectNextAction({}); driver.injectNextAction({ outcome: 'applied_unknown' });
  const source = await submitComputerTask(h, 'act', computerActInput(observation.observationId, saveNoteSteps));
  await h.runtime.execute(h.workId, source.id); await h.runtime.adopt(h.workId, source.id);
  const initial = (await h.state.get(h.workId))!; const original = initial.attempts.find(attempt => attempt.id === source.id)!;
  assert.ok(original.computerUse); assert.deepEqual(initial.evidence, []);
  const settled = await h.computerReconciliations.reconcile(h.workId, 'screen-proof', computerActor,
    { attemptId: source.id, checkpointId: original.computerUse.head.id });
  assert.equal(settled.status, 'settled'); assert.ok(settled.proofArtifact);
  assert.deepEqual((await h.state.get(h.workId))!.evidence, [], 'lookup proof itself never supplies goal evidence');
  const artifact = await h.artifacts.put(new TextEncoder().encode('SEPARATE_FIXTURE_OBSERVATION_BODY'),
    { tenantId: computerActor.tenantId, labels: ['public'], mediaType: 'text/plain' });
  await mutateComputer(h, state => {
    state.evidence = [{ id: 'independent-observation', tenantId: state.policy.tenantId, scope: state.goal.scope,
      sourceId: 'independent-fixture', lineageId: 'independent-fixture', locator: 'fixture://separate-postcondition-observation',
      observedAt: h.clock.now(), recordedAt: h.clock.now(), labels: ['public'], coverage: 'complete', status: 'accepted',
      supersedes: [], derivedFrom: [], facts: { savedNote: driver.snapshot().savedNote }, artifact }];
    state.artifacts.push(artifact);
    const binding = { ...computerActor, id: 'primary', channel: access.channel, conversationId: access.conversationId,
      destination: access.destination, recipientId: access.recipientId };
    state.conversation = { bindings: [binding], primaryBindingId: binding.id, completionRequiresDelivery: false, result: null };
  });
  assert.equal((await h.conversation.prepare(h.workId, computerActor))?.kind, 'result');
  const image = async () => ({ state: await h.state.get(h.workId), events: await h.state.events(h.workId, 0), deliveries: await h.state.deliveries(h.workId) });
  const read = (level: 'conversation' | 'diagnostics', cursor?: string) => h.workView.read(h.workId, computerActor, access,
    { level, ...(cursor === undefined ? {} : { cursor }) });
  const loseProof = () => unlink(join(h.directory, 'artifacts', `${settled.proofArtifact!.id}.blob`));
  return { h, driver, calls, settled, image, read, loseProof, setMetadataHook(hook: (() => Promise<void>) | null) { metadataHook = hook; } };
}
function withheld(result: ReturnType<typeof snapshot>) {
  assert.equal(result.view.progress.analysisReady, false); assert.equal(result.view.progress.resultReady, false);
  assert.equal(result.view.progress.resultDelivery, 'unavailable'); assert.equal(result.view.messages.some(message => message.kind === 'result'), false);
}

for (const backend of ['sqlite', 'file-journal'] as const) {
  test(`${backend}: screen result depends on the live reconciliation proof even when the state revision and previous cursor are unchanged`, async t => {
    const f = await fixture(t, backend); const before = await f.image(); const calls = { ...f.calls }; const driver = f.driver.snapshot();
    assert.deepEqual(Object.keys(f.h.workView.services.effects!), ['current']);
    assert.equal(Object.hasOwn(f.h.workView.services.state, 'commit'), false); assert.equal(Object.hasOwn(f.h.workView.services.artifacts, 'put'), false);
    const ready = snapshot(await f.read('conversation')); assert.equal(ready.view.progress.resultReady, true);
    assert.equal(ready.view.messages.filter(message => message.kind === 'result').length, 1);
    const readOnly = snapshot(await f.h.workView.read(f.h.workId, { ...computerActor, allowWrites: false, allowedTools: [] }, access, { level: 'conversation' }));
    assert.equal(readOnly.view.progress.resultReady, true, 'screen proof validation does not require permission to invoke the original tools');
    assert.deepEqual(await f.read('conversation', ready.cursor), { kind: 'unchanged', cursor: ready.cursor });
    await f.loseProof();
    const missing = snapshot(await f.read('conversation', ready.cursor)); withheld(missing);
    assert.equal(missing.view.revision, ready.view.revision); assert.notEqual(missing.cursor, ready.cursor);
    assert.deepEqual(await f.read('conversation', missing.cursor), { kind: 'unchanged', cursor: missing.cursor });
    assert.deepEqual(await f.image(), before); assert.deepEqual(f.calls, calls); assert.deepEqual(f.driver.snapshot(), driver);
    assert.ok(f.h.services.planner instanceof ScriptedPlanner); assert.deepEqual(f.h.services.planner.inputs, []);
    const serialized = JSON.stringify(missing.view);
    for (const raw of ['SEPARATE_FIXTURE_OBSERVATION_BODY', 'computer_operation_receipt', 'computer_reconciliation_proof']) assert.equal(serialized.includes(raw), false);
  });

  test(`${backend}: proof loss during diagnostics projection withholds an already prepared result before returning a cursor`, async t => {
    const f = await fixture(t, backend); const ready = snapshot(await f.read('diagnostics')); assert.equal(ready.view.progress.resultReady, true);
    const before = await f.image(); const calls = { ...f.calls }; const driver = f.driver.snapshot(); let fired = false;
    f.setMetadataHook(async () => { if (!fired) { fired = true; await f.loseProof(); } });
    const lost = snapshot(await f.read('diagnostics', ready.cursor));
    assert.equal(fired, true); withheld(lost); assert.equal(lost.view.revision, ready.view.revision); assert.notEqual(lost.cursor, ready.cursor);
    assert.deepEqual(await f.image(), before); assert.deepEqual(f.calls, calls); assert.deepEqual(f.driver.snapshot(), driver);
  });

  test(`${backend}: a reader without the effect verifier cannot treat stored settled metadata as current proof`, async t => {
    const f = await fixture(t, backend); const before = await f.image(); const calls = { ...f.calls }; const driver = f.driver.snapshot();
    const ready = snapshot(await f.read('conversation')); assert.equal(ready.view.progress.resultReady, true);
    const services = f.h.workView.services;
    const reader = new WorkViewService({ state: services.state, artifacts: services.artifacts, digester: services.digester, knowledge: services.knowledge });
    const unavailable = snapshot(await reader.read(f.h.workId, computerActor, access, { level: 'conversation', cursor: ready.cursor }));
    withheld(unavailable); assert.equal(unavailable.view.revision, ready.view.revision); assert.notEqual(unavailable.cursor, ready.cursor);
    assert.deepEqual(await f.image(), before); assert.deepEqual(f.calls, calls); assert.deepEqual(f.driver.snapshot(), driver);
  });
}
