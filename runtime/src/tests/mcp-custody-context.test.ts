import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ContextRecovery } from '../application/context-recovery.js';
import { createExecutionAuthority } from '../application/execution-authority.js';
import { asJson } from '../application/plan-validator.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { createMcpResponseCustodyFixture } from './mcp-response-custody-fixture.js';
import type { Adapter } from './state-conformance-helpers.js';

async function protectedRaw(t: TestContext, backend: Adapter = 'sqlite', legacyReceipt = false) {
  const f = await createMcpResponseCustodyFixture(t, backend, { legacyReceipt });
  const prepared = await f.prepare();
  f.controls.afterCapture = () => f.mutate(state => { state.policy.allowedLabels = []; state.policy.allowedTools = []; });
  await assert.rejects(f.invoke(prepared.attempt.id));
  const ref = f.rawRef(); assert.ok(ref); assert.ok(await f.response(prepared.attempt.id));
  const state = await f.current();
  assert.deepEqual(ref.labels, ['synthetic']); assert.deepEqual(state.policy.allowedLabels, []);
  assert.equal(f.counters.calls, 1); assert.equal(f.counters.captures, 1); assert.equal(f.counters.projections, 0);
  return { ...f, prepared, ref, actor: { tenantId: state.policy.tenantId, principalId: state.policy.principalId },
    recovery: new ContextRecovery(f.services, f.contracts) };
}

for (const backend of ['sqlite', 'file-journal'] as const) test(`${backend} checkpoint omits only protected MCP raw custody and preserves the authoritative state and receipt across reopen`, async t => {
  const f = await protectedRaw(t, backend), before = await f.current(), response = await f.response(f.prepared.attempt.id);
  const raw = await f.raw(f.ref), deliveries = await f.services.state.deliveries(f.work.id);
  const stateHash = f.services.digester.digest(asJson(before));
  const first = await f.recovery.restore(f.work.id, f.actor);
  assert.equal(first.disposition, 'created'); assert.equal(first.packet.stateRevision, before.revision);
  assert.equal(first.packet.stateDigest, f.services.digester.digest(asJson({ state: before, deliveries })));
  assert.equal(first.packet.runtime.artifacts.some(ref => ref.id === f.ref.id), false);
  assert.equal(first.packet.context.evidence.length, 0); assert.deepEqual(first.artifact.labels, []);
  const serialized = JSON.stringify(first.packet);
  assert.ok(!serialized.includes(f.ref.id)); assert.ok(!serialized.includes('fixed decoded response'));
  const checkpoint = await f.services.artifacts.get(first.artifact, before.policy);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(checkpoint)), first.packet);
  assert.equal(f.services.digester.digest(asJson(await f.current())), stateHash);
  assert.deepEqual(await f.response(f.prepared.attempt.id), response); assert.deepEqual((await f.raw(f.ref)).bytes, raw.bytes);
  assert.ok((await f.current()).artifacts.some(ref => ref.id === f.ref.id));

  await f.reopen();
  const contracts = new ToolContracts([f.reader()], f.schemas);
  const restored = await new ContextRecovery(f.services, contracts).restore(f.work.id, f.actor, first.artifact);
  assert.equal(restored.disposition, 'reused'); assert.deepEqual(restored.packet, first.packet);
  assert.equal(f.services.digester.digest(asJson(await f.current())), stateHash);
  assert.deepEqual(await f.response(f.prepared.attempt.id), response); assert.deepEqual((await f.raw(f.ref)).bytes, raw.bytes);
  assert.equal(f.counters.calls, 1); assert.equal(f.counters.discoveries, 0); assert.equal(f.counters.projections, 0);
});

test('the same custody raw cannot be hidden when current evidence or an attempt result requires it', async t => {
  for (const kind of ['evidence', 'result'] as const) {
    const f = await protectedRaw(t);
    await f.mutate(state => {
      if (kind === 'evidence') state.evidence.push(f.expectedBody(f.prepared.attempt.id, f.ref).evidence[0]!);
      else { state.attempts[0]!.resultArtifact = f.ref; state.attempts[0]!.resultId = 'required-result'; }
    });
    const before = await f.current(); let checkpointPuts = 0;
    const put = f.services.artifacts.put.bind(f.services.artifacts);
    f.services.artifacts.put = async (...args) => { checkpointPuts++; return put(...args); };
    await assert.rejects(f.recovery.restore(f.work.id, f.actor), /resume_policy_insufficient/, kind);
    assert.equal(checkpointPuts, 0); assert.deepEqual(await f.current(), before);
    assert.equal(f.counters.calls, 1); assert.equal(f.counters.projections, 0);
  }
});

test('an unrelated forbidden artifact is not hidden alongside authenticated MCP custody', async t => {
  const f = await protectedRaw(t);
  const unknown = await f.services.artifacts.put(new TextEncoder().encode('UNRELATED_RESTRICTED_BODY'), {
    tenantId: f.actor.tenantId, labels: ['synthetic'], mediaType: 'text/plain' });
  await f.mutate(state => { state.artifacts.push(unknown); });
  const before = await f.current();
  await assert.rejects(f.recovery.restore(f.work.id, f.actor), /resume_policy_insufficient/);
  assert.deepEqual(await f.current(), before); assert.equal(f.counters.calls, 1); assert.equal(f.counters.projections, 0);
});

test('a legacy response receipt without the custody-only marker does not authorize hiding its raw reference', async t => {
  const f = await protectedRaw(t, 'sqlite', true), before = await f.current();
  const proof = await f.tool.restoreUsage!(before, { attemptId: f.prepared.attempt.id, task: f.prepared.task });
  assert.ok(proof.kind === 'available'); assert.equal(proof.custodyOnly, false);
  await assert.rejects(f.recovery.restore(f.work.id, f.actor), /resume_policy_insufficient/);
  assert.deepEqual(await f.current(), before); assert.equal(f.counters.projections, 0);
});

test('changed data generation and corrupted custody bytes prevent checkpoint publication', async t => {
  for (const kind of ['generation', 'bytes'] as const) {
    const f = await protectedRaw(t);
    if (kind === 'generation') await f.mutate(state => { state.dataLifecycle = { generation: 1, blockedArtifactIds: [], changes: [] }; });
    else {
      const get = f.services.artifacts.get.bind(f.services.artifacts);
      f.services.artifacts.get = async (ref, policy) => {
        const bytes = await get(ref, policy); if (ref.id === f.ref.id) bytes[0] = bytes[0]! ^ 1; return bytes;
      };
    }
    const before = await f.current(); let checkpointPuts = 0;
    const put = f.services.artifacts.put.bind(f.services.artifacts);
    f.services.artifacts.put = async (...args) => { checkpointPuts++; return put(...args); };
    await assert.rejects(f.recovery.restore(f.work.id, f.actor), /resume_custody_unavailable/, kind);
    assert.equal(checkpointPuts, 0); assert.deepEqual(await f.current(), before);
    assert.equal(f.counters.calls, 1); assert.equal(f.counters.projections, 0);
  }
});

test('custody filtering cannot bypass work ownership, a wider persisted policy or a revoked host authority', async t => {
  const f = await protectedRaw(t), before = await f.current(); let rawGets = 0;
  const get = f.services.artifacts.get.bind(f.services.artifacts);
  f.services.artifacts.get = async (ref, policy) => { if (ref.id === f.ref.id) rawGets++; return get(ref, policy); };
  await assert.rejects(f.recovery.restore(f.work.id, { ...f.actor, principalId: 'other-person' }), /work_unavailable/);
  const revoked = new AbortController(); revoked.abort();
  f.services.executionAuthority = createExecutionAuthority({ actor: before.policy, scope: before.goal.scope, signal: revoked.signal });
  await assert.rejects(f.recovery.restore(f.work.id, f.actor), /execution_authority_denied/);
  assert.equal(rawGets, 0);

  delete f.services.executionAuthority;
  await f.mutate(state => { state.policy.allowedLabels = ['synthetic']; state.policy.allowedTools = [f.tool.definition.id]; });
  const restricted = { ...f.actor, allowedLabels: [], allowedTools: [], allowedDestinations: ['local'], allowWrites: false };
  await assert.rejects(f.recovery.restore(f.work.id, restricted), /resume_policy_insufficient/);
  f.services.executionAuthority = createExecutionAuthority({ actor: restricted, scope: before.goal.scope, signal: new AbortController().signal });
  await assert.rejects(f.recovery.restore(f.work.id, restricted), /execution_authority_denied/);
  assert.equal(rawGets, 0); assert.equal(f.counters.calls, 1); assert.equal(f.counters.projections, 0);
});

test('a state commit during raw proof is re-evaluated instead of publishing an earlier custody projection', async t => {
  for (const change of ['note', 'required-evidence'] as const) {
    const f = await protectedRaw(t), before = await f.current(), get = f.services.artifacts.get.bind(f.services.artifacts);
    let changed = false, checkpointPuts = 0;
    f.services.artifacts.get = async (ref, policy) => {
      const bytes = await get(ref, policy);
      if (ref.id === f.ref.id && !changed) {
        changed = true;
        await f.mutate(state => {
          state.statusReason = 'Committed while reading custody';
          if (change === 'required-evidence') state.evidence.push(f.expectedBody(f.prepared.attempt.id, f.ref).evidence[0]!);
        });
      }
      return bytes;
    };
    const put = f.services.artifacts.put.bind(f.services.artifacts);
    f.services.artifacts.put = async (...args) => { checkpointPuts++; return put(...args); };
    if (change === 'required-evidence') {
      await assert.rejects(f.recovery.restore(f.work.id, f.actor), /resume_policy_insufficient/);
      assert.equal(checkpointPuts, 0);
    } else {
      const restored = await f.recovery.restore(f.work.id, f.actor), current = await f.current();
      assert.equal(restored.packet.stateRevision, current.revision); assert.ok(current.revision > before.revision);
      assert.equal(restored.packet.runtime.statusReason, 'Committed while reading custody');
      assert.equal(restored.packet.runtime.artifacts.some(ref => ref.id === f.ref.id), false);
      assert.equal(checkpointPuts, 1);
    }
    assert.equal(changed, true); assert.equal(f.counters.calls, 1); assert.equal(f.counters.projections, 0);
  }
});
