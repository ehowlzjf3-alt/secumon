import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkState } from '../domain/model.js';
import { asJson } from '../application/plan-validator.js';
import { sha256 } from '../infrastructure/digest.js';
import { adapters } from './state-conformance-helpers.js';
import { createMcpResponseCustodyFixture, type McpResponseCustodyFixture } from './mcp-response-custody-fixture.js';

const narrow = (state: WorkState) => { state.policy.allowedLabels = []; state.policy.allowedTools = []; };
const usage = (transportCalls: number | null) => ({ transportCalls, internalOperations: null, imageBytes: null, waitMs: null });
async function saved(f: McpResponseCustodyFixture, attemptId: string, outcome: 'returned' | 'captured' | 'failure', transportCalls: 0 | 1) {
  const response = await f.response(attemptId); assert.ok(response);
  const ref = f.rawRef(); assert.ok(ref); const raw = await f.raw(ref);
  assert.equal(raw.envelope['schemaVersion'], 1); assert.equal(raw.envelope['kind'], 'mcp_decoded_response');
  assert.equal(raw.envelope['attemptId'], attemptId); assert.equal(raw.envelope['recordedAt'], 1100);
  assert.equal(raw.envelope['transportCalls'], transportCalls); assert.equal('custody' in raw.envelope, false);
  assert.equal(sha256(raw.bytes), ref.sha256); assert.equal(raw.bytes.byteLength, ref.byteLength);
  assert.deepEqual(ref.labels, ['synthetic']); assert.equal(ref.tenantId, f.work.policy.tenantId);
  assert.equal(response.digest, f.services.digester.digest(asJson({ type: 'mcp_response_recorded', data: {
    attemptId, artifact: ref, custody: { schemaVersion: 1, outcome, transportCalls } } })));
  const current = await f.current(); assert.ok(current.artifacts.some(value => value.id === ref.id));
  assert.deepEqual(current.evidence, []);
  assert.equal(current.attempts.find(value => value.id === attemptId)!.resultId, null);
  assert.equal(await f.services.state.receipt(f.work.id, `receive:${attemptId}`), null);
  return { response, ref, raw, current };
}

for (const backend of adapters) for (const change of ['authorization', 'abort', 'policy', 'goal'] as const)
  test(`${backend}: decoded response custody survives ${change} change without projecting an answer`, async t => {
    const f = await createMcpResponseCustodyFixture(t, backend), p = await f.prepare();
    f.controls.afterCapture = async () => {
      if (change === 'authorization') f.controls.denyAuthorization = true;
      if (change === 'abort') f.controller.abort(new Error('fixture_after_capture_abort'));
      if (change === 'policy') await f.mutate(narrow);
      if (change === 'goal') await f.mutate(state => { state.goal.revision++; state.goal.description = 'A different current request'; });
    };
    await assert.rejects(f.invoke(p.attempt.id), /broker_(execution_not_current|knowledge_changed)/);
    assert.equal(f.counters.captures, 1); assert.equal(f.counters.calls, 1); assert.equal(f.counters.projections, 0);
    const s = await saved(f, p.attempt.id, 'returned', 1);
    assert.deepEqual(s.raw.envelope['value'], f.decodedValue); assert.equal(s.raw.envelope['failure'], null);
    assert.equal(s.raw.envelope['goalDigest'], f.services.digester.digest(asJson(f.work.goal)));
    assert.equal(s.raw.envelope['policyDigest'], f.services.digester.digest(asJson(f.work.policy)));
    if (change === 'goal') assert.equal(s.current.goal.revision, 2);
    if (change === 'policy') assert.deepEqual(s.current.policy.allowedLabels, []);
    const input = { attemptId: p.attempt.id, task: p.task };
    const restored = await f.reader().restoreUsage!(s.current, input);
    assert.deepEqual(restored, { kind: 'available', usage: usage(1), receivedAt: 1100,
      receipt: { commandId: `mcp-response:${p.attempt.id}`, digest: s.response.digest, artifact: s.ref },
      custodyOnly: true, responseObserved: true });
    assert.equal(f.counters.projections, 0); assert.equal(f.counters.calls, 1); assert.equal(f.counters.discoveries, 0);
    assert.deepEqual(await f.current(), s.current, 'usage inspection does not write or complete the original work');
  });

for (const backend of adapters) for (const boundary of ['afterRaw', 'beforeResponseCommit'] as const)
  test(`${backend}: policy reduction at ${boundary} retains original raw labels through response publication`, async t => {
    const f = await createMcpResponseCustodyFixture(t, backend), p = await f.prepare();
    let changes = 0;
    f.controls[boundary] = async () => { changes++; await f.mutate(narrow); };
    await assert.rejects(f.invoke(p.attempt.id), /broker_execution_not_current/);
    assert.equal(changes, 1); assert.equal(f.counters.rawPuts, 1); assert.equal(f.counters.projections, 0);
    const s = await saved(f, p.attempt.id, 'returned', 1);
    assert.deepEqual(s.current.policy.allowedTools, []); assert.deepEqual(s.current.policy.allowedLabels, []);
    if (boundary === 'beforeResponseCommit') assert.equal(f.counters.responseConflicts, 1, 'the stale prepared state must retry the real CAS');
    const before = structuredClone(s.current); await f.reopen();
    const reader = f.reader(), input = { attemptId: p.attempt.id, task: p.task };
    assert.deepEqual(reader.definition, f.tool.definition, 'custody did not revise the original tool contract');
    const restored = await reader.restoreUsage!(await f.current(), input);
    assert.equal(restored.kind, 'available'); if (restored.kind !== 'available') assert.fail();
    assert.deepEqual(restored.usage, usage(1)); assert.deepEqual(restored.receipt.artifact, s.ref);
    assert.deepEqual(Object.keys(restored).sort(), ['custodyOnly', 'kind', 'receipt', 'receivedAt', 'responseObserved', 'usage']);
    await assert.rejects(reader.restoreResult!(await f.current(), input), /mcp_saved_result_invalid/);
    assert.equal(await reader.validateResult!(await f.current(), f.expectedBody(p.attempt.id, s.ref)), false);
    assert.equal(f.counters.projections, 0); assert.equal(f.counters.calls, 1); assert.equal(f.counters.discoveries, 0);
    assert.deepEqual(await f.current(), before); assert.deepEqual((await f.raw(s.ref)).bytes, s.raw.bytes);
    assert.deepEqual(await f.response(p.attempt.id), s.response);
  });

for (const boundary of ['afterCapture', 'afterRaw', 'beforeResponseCommit'] as const)
  for (const change of ['generation', 'owner'] as const)
    test(`custody rejects ${change} change at ${boundary}, including a raw object already written`, async t => {
      const f = await createMcpResponseCustodyFixture(t, 'sqlite'), p = await f.prepare();
      f.controls[boundary] = () => f.mutate(state => {
        if (change === 'owner') state.policy.principalId = 'different-owner';
        else state.dataLifecycle = { generation: 1, blockedArtifactIds: [], changes: [] };
      });
      await assert.rejects(f.invoke(p.attempt.id), /broker_response_custody_invalid|mcp_custody_changed/);
      assert.equal(await f.response(p.attempt.id), null); assert.equal(f.counters.projections, 0); assert.equal(f.counters.calls, 1);
      const current = await f.current(); assert.deepEqual(current.artifacts, []); assert.deepEqual(current.evidence, []);
      assert.equal(f.counters.rawPuts, boundary === 'afterCapture' ? 0 : 1);
      const ref = f.rawRef(); if (ref) assert.equal(await f.services.artifacts.exists(ref), true, 'an unpublished raw object is not adopted or relabelled');
      assert.deepEqual(await f.reader().restoreUsage!(current, { attemptId: p.attempt.id, task: p.task }), { kind: 'absent' });
    });

for (const mode of ['sent-false', 'sent-true', 'arbitrary-error'] as const)
  test(`decoded client ${mode} preserves only a proven transport count`, async t => {
    const f = await createMcpResponseCustodyFixture(t), p = await f.prepare(); f.controls.callMode = mode;
    const input = { attemptId: p.attempt.id, task: p.task };
    if (mode === 'arbitrary-error') {
      await assert.rejects(f.invoke(p.attempt.id), error => error === f.errors.arbitrary);
      assert.equal(f.counters.rawPuts, 0); assert.equal(await f.response(p.attempt.id), null);
      assert.deepEqual(await f.reader().restoreUsage!(await f.current(), input), { kind: 'absent' });
    } else {
      const result = await f.invoke(p.attempt.id), count = mode === 'sent-false' ? 0 : 1;
      assert.equal(result.status, 'error'); assert.deepEqual(result.usage, usage(count));
      const s = await saved(f, p.attempt.id, 'failure', count);
      assert.equal(s.raw.envelope['value'], null);
      assert.deepEqual(s.raw.envelope['failure'], { code: count ? 'mcp_transport_failed' : 'mcp_call_not_sent', sent: count === 1 });
      const restored = await f.reader().restoreUsage!(s.current, input);
      assert.equal(restored.kind, 'available'); if (restored.kind !== 'available') assert.fail();
      assert.deepEqual(restored.usage, usage(count)); assert.equal(restored.responseObserved, false); assert.equal(restored.custodyOnly, true);
    }
    assert.equal(f.counters.calls, 1); assert.equal(f.counters.captures, 0); assert.equal(f.counters.projections, 0);
  });

for (const backend of adapters) test(`${backend}: captured post-check failure cannot be promoted to a returned body even after reopen`, async t => {
  const f = await createMcpResponseCustodyFixture(t, backend), p = await f.prepare(); f.controls.callMode = 'captured-failure';
  await assert.rejects(f.invoke(p.attempt.id), error => error === f.errors.captured);
  const s = await saved(f, p.attempt.id, 'captured', 1); assert.deepEqual(s.raw.envelope['value'], f.decodedValue);
  assert.equal(s.raw.envelope['failure'], null); await f.reopen();
  const reader = f.reader(), input = { attemptId: p.attempt.id, task: p.task };
  const restored = await reader.restoreUsage!(await f.current(), input);
  assert.equal(restored.kind, 'available'); if (restored.kind !== 'available') assert.fail();
  assert.deepEqual(restored.usage, usage(1)); assert.equal(restored.responseObserved, true);
  await assert.rejects(reader.restoreResult!(await f.current(), input), /mcp_saved_result_invalid/);
  assert.equal(await reader.validateResult!(await f.current(), f.expectedBody(p.attempt.id, s.ref)), false);
  assert.equal(f.counters.calls, 1); assert.equal(f.counters.discoveries, 0); assert.equal(f.counters.projections, 0);
  assert.deepEqual(await f.current(), s.current);
});

for (const mode of ['returned', 'sent-false', 'sent-true'] as const)
  test(`legacy ${mode} response signature remains readable without upgrading ambiguous failure usage`, async t => {
    const f = await createMcpResponseCustodyFixture(t, 'sqlite', { legacyReceipt: true }), p = await f.prepare();
    f.controls.callMode = mode; const result = await f.invoke(p.attempt.id);
    const response = await f.response(p.attempt.id), ref = f.rawRef(); assert.ok(response); assert.ok(ref);
    assert.equal(response.digest, f.services.digester.digest(asJson({ type: 'mcp_response_recorded', data: { attemptId: p.attempt.id, artifact: ref } })));
    const raw = await f.raw(ref); assert.equal(raw.envelope['schemaVersion'], 1); assert.equal('custody' in raw.envelope, false);
    const originalCount = mode === 'sent-false' ? 0 : 1; assert.equal(raw.envelope['transportCalls'], originalCount);
    await f.reopen(); const current = await f.current(), reader = f.reader(), input = { attemptId: p.attempt.id, task: p.task };
    const before = { ...f.counters }, restoredUsage = await reader.restoreUsage!(current, input);
    assert.equal(restoredUsage.kind, 'available'); if (restoredUsage.kind !== 'available') assert.fail();
    assert.deepEqual(restoredUsage.usage, usage(mode === 'sent-true' ? null : originalCount));
    assert.equal(restoredUsage.custodyOnly, false); assert.equal(restoredUsage.responseObserved, mode === 'returned');
    assert.equal(f.counters.projections, before.projections, 'usage-only inspection does not invoke the historical projector');
    const restored = await reader.restoreResult!(current, input);
    assert.equal(restored.kind, 'available'); if (restored.kind !== 'available') assert.fail();
    assert.deepEqual(restored.result, result); assert.equal(await reader.validateResult!(current, result), true);
    assert.equal(f.counters.calls, 1); assert.equal(f.counters.discoveries, 0);
    assert.deepEqual(await f.response(p.attempt.id), response); assert.deepEqual((await f.raw(ref)).bytes, raw.bytes);
    assert.deepEqual(await f.current(), current);
  });
