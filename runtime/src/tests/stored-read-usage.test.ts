import test from 'node:test';
import assert from 'node:assert/strict';
import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StoredReadUsages } from '../application/stored-read-usage.js';
import { createMcpCollectionCustodyFixture } from './mcp-collection-custody-fixture.js';
import { adapters } from './state-conformance-helpers.js';
import { inspected, originals, owner, selected, withHeldSecondCollection } from './mcp-collection-accounting-fixture.js';

for (const backend of adapters) {
  test(`${backend}: custody inspection cannot finalize a running subset, even after pause or a shorter work deadline`, { timeout: 45000 }, async t => {
    await withHeldSecondCollection(t, backend, async ({ f, prepared }) => {
      const helper = new StoredReadUsages(f.services, f.composed.contracts);
      const before = await f.current(), counters = { ...f.counters };
      const first = await helper.inspectCustody(before, prepared.attempt.id); assert.ok(first);
      assert.ok(first.custodyRefs.some(ref => ref.id === [...f.requests.values()][0]!.raw!.id));
      assert.equal(await helper.prepareUsage(before, first), null);
      assert.deepEqual(await f.current(), before); assert.deepEqual(f.counters, counters);

      await f.composed.runtime.command(prepared.workId, 'pause-live-collection', owner(before), before.goal.revision,
        { kind: 'pause', reason: 'Pause does not close the original call set' });
      await f.mutate(state => { state.deadlineAt = f.services.clock.now(); });
      f.setNow(f.services.clock.now() + 1);
      const paused = await f.current(); assert.equal(paused.status, 'paused');
      assert.equal(selected(paused, prepared.attempt.id).status, 'running');
      assert.ok(f.services.clock.now() < prepared.attempt.leaseUntil);
      const second = await helper.inspectCustody(paused, prepared.attempt.id); assert.ok(second);
      assert.equal(await helper.prepareUsage(paused, second), null, 'neither work status nor the shortened deadline closes an in-flight set');

      f.setNow(prepared.attempt.leaseUntil);
      const ticket = await helper.prepareUsage(paused, second); assert.ok(ticket);
      assert.equal(ticket.usage.transportCalls, null, 'one saved response and one absent receipt cannot become a known total of one');
      assert.deepEqual(selected(await f.current(), prepared.attempt.id), selected(paused, prepared.attempt.id));
      assert.deepEqual(f.counters, counters);
    });
  });
}

test('a complete checkpoint is not attempt closure; an actual received result closes its original calls', { timeout: 20000 }, async t => {
  const f = await createMcpCollectionCustodyFixture(t), p = await f.prepare();
  const helper = new StoredReadUsages(f.services, f.composed.contracts);
  assert.equal(helper.candidate(await f.current(), p.attempt.id), false, 'no collection intent has been published');
  const result = await f.invoke(p.attempt.id), active = await inspected(f, p.attempt.id, helper);
  assert.equal(selected(active.state, p.attempt.id).readProgress!.phase, 'complete');
  assert.equal(selected(active.state, p.attempt.id).status, 'running');
  assert.equal(await helper.prepareUsage(active.state, active.inspection), null);
  await f.composed.runtime.receive(p.workId, p.attempt.id, result);
  const received = await inspected(f, p.attempt.id, helper), before = await originals(f), counters = { ...f.counters };
  assert.equal(selected(received.state, p.attempt.id).status, 'received');
  const ticket = await helper.prepareUsage(received.state, received.inspection); assert.ok(ticket);
  assert.deepEqual(ticket.usage, { transportCalls: 1, internalOperations: null, imageBytes: null, waitMs: null });
  await helper.assertCurrent(received.state, ticket);
  assert.deepEqual(await f.current(), received.state); assert.deepEqual(await originals(f), before); assert.deepEqual(f.counters, counters);
});

test('read usage tickets are instance-bound and fail after source receipts or current ownership change', { timeout: 25000 }, async t => {
  const f = await createMcpCollectionCustodyFixture(t), p = await f.prepare(); await f.invoke(p.attempt.id);
  f.setNow(p.attempt.leaseUntil);
  const { state, helper, inspection } = await inspected(f, p.attempt.id), counters = { ...f.counters };
  const ticket = await helper.prepareUsage(state, inspection); assert.ok(ticket); assert.ok(Object.isFrozen(ticket));
  const foreign = new StoredReadUsages(f.services, f.composed.contracts);
  await assert.rejects(foreign.prepareUsage(state, inspection), /stored_read_usage_ticket_invalid/);
  await assert.rejects(helper.assertCurrent(state, structuredClone(ticket)), /stored_read_usage_ticket_invalid/);
  const injected = { ...inspection, custodyRefs: [...inspection.custodyRefs, { ...inspection.head, id: 'unrelated-ref' }] };
  await assert.rejects(helper.prepareUsage(state, injected), /stored_read_usage_ticket_invalid/);
  f.controls.damageReceipt = 'intent';
  await assert.rejects(helper.assertCurrent(state, ticket), /mcp_saved_response_invalid|stored_read_usage/);
  f.controls.damageReceipt = null;
  await f.mutate(next => { next.policy.principalId = 'another-owner'; });
  await assert.rejects(helper.inspectCustody(await f.current(), p.attempt.id), /stored_read_usage_owner_mismatch/);
  assert.deepEqual(f.counters, counters);
});

test('custody inspection excludes unrelated indexed artifacts instead of treating all checkpoint history as permission', { timeout: 20000 }, async t => {
  const f = await createMcpCollectionCustodyFixture(t), p = await f.prepare(); await f.invoke(p.attempt.id);
  const unrelated = await f.services.artifacts.put(new TextEncoder().encode('UNRELATED_PRIVATE_BODY'), {
    tenantId: 'tenant-a', labels: ['synthetic'], mediaType: 'text/plain' });
  await f.mutate(state => { state.artifacts.push(unrelated); });
  const { state, helper, inspection } = await inspected(f, p.attempt.id), counters = { ...f.counters };
  assert.ok(inspection.custodyRefs.length > 1); assert.equal(inspection.custodyRefs.some(ref => ref.id === unrelated.id), false);
  await helper.assertCurrent(state, inspection); assert.deepEqual(f.counters, counters); assert.deepEqual(await f.current(), state);
});

test('a settled head removed or substituted during a later receipt lookup fails the final original-file fence', { timeout: 30000 }, async t => {
  for (const change of ['remove', 'replace'] as const) {
    const f = await createMcpCollectionCustodyFixture(t), p = await f.prepare(); await f.invoke(p.attempt.id);
    const before = await f.current(), head = selected(before, p.attempt.id).readProgress!.head;
    const get = f.services.artifacts.get.bind(f.services.artifacts), receipt = f.services.state.receipt.bind(f.services.state);
    let headRead = false, changed = false;
    const reads = t.mock.method(f.services.artifacts, 'get', async (ref: Parameters<typeof get>[0], policy: Parameters<typeof get>[1]) => {
      const bytes = await get(ref, policy); if (ref.id === head.id) headRead = true; return bytes;
    });
    const receipts = t.mock.method(f.services.state, 'receipt', async (workId: string, commandId: string) => {
      const value = await receipt(workId, commandId);
      if (!changed && headRead && workId === p.workId && commandId.startsWith(`mcp-page:${p.attempt.id}:`)) {
        changed = true;
        const path = join(f.artifactDirectory, `${head.id}.blob`);
        if (change === 'remove') await unlink(path); else await writeFile(path, '{}');
      }
      return value;
    });
    try {
      const helper = new StoredReadUsages(f.services, f.composed.contracts);
      await assert.rejects(helper.inspectCustody(before, p.attempt.id), /ENOENT|artifact|stored_read_usage|read_checkpoint/);
      assert.equal(headRead, true); assert.equal(changed, true, 'mutation occurred after the original head read, in a later receipt lookup');
      assert.deepEqual(await f.current(), before); assert.equal(f.counters.calls, 1);
    } finally { receipts.mock.restore(); reads.mock.restore(); }
  }
});
