import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextRecovery } from '../application/context-recovery.js';
import { asJson } from '../application/plan-validator.js';
import { createMcpCollectionCustodyFixture } from './mcp-collection-custody-fixture.js';
import { adapters } from './state-conformance-helpers.js';
import { inspected, originals, owner, protectedCollection, selected, withHeldSecondCollection } from './mcp-collection-accounting-fixture.js';

for (const backend of adapters) {
  test(`${backend}: recovery hides only authenticated old collection custody and preserves authoritative originals across reopen`, { timeout: 30000 }, async t => {
    const f = await createMcpCollectionCustodyFixture(t, backend, { family: 'observations' }), setup = await protectedCollection(f);
    const { state, inspection } = await inspected(f, setup.prepared.attempt.id), saved = await originals(f), counters = { ...f.counters };
    assert.ok(inspection.custodyRefs.length > f.requests.size, 'the proof authenticates the actual checkpoint chain as well as raw responses');
    for (const request of f.requests.values()) assert.ok(inspection.custodyRefs.some(ref => ref.id === request.raw!.id));
    const recovery = new ContextRecovery(f.services, f.composed.contracts), first = await recovery.restore(setup.prepared.workId, setup.actor);
    const deliveries = await f.services.state.deliveries(setup.prepared.workId);
    assert.equal(first.packet.stateDigest, f.services.digester.digest(asJson({ state, deliveries })));
    assert.equal(first.packet.runtime.status, 'cancelled'); assert.equal(first.packet.context.evidence.length, 0);
    assert.equal(first.packet.context.readCollections?.length ?? 0, 0); assert.deepEqual(first.artifact.labels, []);
    const serialized = JSON.stringify(first.packet);
    for (const ref of inspection.custodyRefs) assert.equal(serialized.includes(ref.id), false, 'old custody is not a current context reference');
    assert.equal(serialized.includes('Fixed collection response'), false);
    assert.deepEqual(await f.current(), state); assert.deepEqual(await originals(f), saved); assert.deepEqual(f.counters, counters);
    for (const ref of inspection.custodyRefs) assert.ok(state.artifacts.some(value => value.id === ref.id), 'the projection never deletes authoritative custody');

    await f.reopen();
    const reopened = await new ContextRecovery(f.services, f.composed.contracts).restore(setup.prepared.workId, setup.actor, first.artifact);
    assert.equal(reopened.disposition, 'reused'); assert.deepEqual(reopened.packet, first.packet);
    assert.deepEqual(await f.current(), state); assert.deepEqual(await originals(f), saved); assert.deepEqual(f.counters, counters);
  });
}

test('a protected head still required by the current running task is never projected out', { timeout: 45000 }, async t => {
  await withHeldSecondCollection(t, 'sqlite', async ({ f, prepared }) => {
    await f.mutate(state => { state.policy.allowedLabels = []; });
    const before = await f.current(), head = selected(before, prepared.attempt.id).readProgress!.head;
    assert.equal(selected(before, prepared.attempt.id).status, 'running');
    assert.equal(selected(before, prepared.attempt.id).goalRevision, before.goal.revision);
    assert.ok(head.labels.some(label => !before.policy.allowedLabels.includes(label)));
    let puts = 0; const put = f.services.artifacts.put.bind(f.services.artifacts);
    const mock = t.mock.method(f.services.artifacts, 'put', async (...args: Parameters<typeof put>) => { puts++; return put(...args); });
    try {
      await assert.rejects(new ContextRecovery(f.services, f.composed.contracts).restore(prepared.workId, owner(before)), /resume_policy_insufficient/);
      assert.equal(puts, 0); assert.deepEqual(await f.current(), before);
    } finally { mock.mock.restore(); }
  });
});

test('a current result or evidence reference overrides collection custody exclusion', { timeout: 40000 }, async t => {
  for (const kind of ['result', 'evidence'] as const) {
    const f = await createMcpCollectionCustodyFixture(t, 'sqlite', { family: 'observations' }), setup = await protectedCollection(f);
    const first = [...f.requests.values()][0]!; assert.ok(first.raw); assert.ok(setup.evidence[0]);
    await f.mutate(state => {
      if (kind === 'result') { const attempt = selected(state, setup.prepared.attempt.id); attempt.resultArtifact = first.raw!; attempt.resultId = 'required-result'; }
      else state.evidence.push(structuredClone(setup.evidence[0]!));
    });
    const before = await f.current(), saved = await originals(f), counters = { ...f.counters };
    let puts = 0; const put = f.services.artifacts.put.bind(f.services.artifacts);
    const mock = t.mock.method(f.services.artifacts, 'put', async (...args: Parameters<typeof put>) => { puts++; return put(...args); });
    try {
      await assert.rejects(new ContextRecovery(f.services, f.composed.contracts).restore(setup.prepared.workId, setup.actor), /resume_policy_insufficient/, kind);
      assert.equal(puts, 0); assert.deepEqual(await f.current(), before); assert.deepEqual(await originals(f), saved); assert.deepEqual(f.counters, counters);
    } finally { mock.mock.restore(); }
  }
});

test('an unrelated protected ref prevents collection recovery instead of borrowing the custody proof', { timeout: 25000 }, async t => {
  const f = await createMcpCollectionCustodyFixture(t, 'sqlite', { family: 'observations' }), setup = await protectedCollection(f);
  const unrelated = await f.services.artifacts.put(new TextEncoder().encode('UNRELATED_RESTRICTED_BODY'), {
    tenantId: setup.actor.tenantId, labels: ['synthetic'], mediaType: 'text/plain' });
  await f.mutate(state => { state.artifacts.push(unrelated); });
  const before = await f.current(), proof = await inspected(f, setup.prepared.attempt.id), counters = { ...f.counters };
  assert.equal(proof.inspection.custodyRefs.some(ref => ref.id === unrelated.id), false);
  await assert.rejects(new ContextRecovery(f.services, f.composed.contracts).restore(setup.prepared.workId, setup.actor), /resume_policy_insufficient/);
  assert.deepEqual(await f.current(), before); assert.deepEqual(f.counters, counters);
});

test('a receipt identity change during collection custody proof refuses context publication', { timeout: 25000 }, async t => {
  const f = await createMcpCollectionCustodyFixture(t, 'sqlite', { family: 'observations' }), setup = await protectedCollection(f);
  f.controls.damageReceipt = 'intent'; const before = await f.current(), counters = { ...f.counters };
  let puts = 0; const put = f.services.artifacts.put.bind(f.services.artifacts);
  const mock = t.mock.method(f.services.artifacts, 'put', async (...args: Parameters<typeof put>) => { puts++; return put(...args); });
  try {
    await assert.rejects(new ContextRecovery(f.services, f.composed.contracts).restore(setup.prepared.workId, setup.actor), /resume_custody_unavailable/);
    assert.equal(puts, 0); assert.deepEqual(await f.current(), before); assert.deepEqual(f.counters, counters);
  } finally { mock.mock.restore(); }
});
