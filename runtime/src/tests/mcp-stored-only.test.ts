import test from 'node:test';
import assert from 'node:assert/strict';
import { asJson } from '../application/plan-validator.js';
import { createMcpStoredReadTool, type McpReadBinding } from '../infrastructure/mcp-read-tools.js';
import { MCP_PROTOCOL_VERSION } from '../infrastructure/mcp-stdio-client.js';
import { MCP_FIXTURE_DOCUMENTS_TOOL, MCP_FIXTURE_PROTOCOL } from './helpers/mcp-fixture-contracts.js';
import { createMcpResponseCustodyFixture, type McpResponseCustodyFixture } from './mcp-response-custody-fixture.js';
import { adapters } from './state-conformance-helpers.js';

const origin = { endpointId: 'custody-fixture', protocolVersion: MCP_PROTOCOL_VERSION };
// Re-register the reviewed fixture contract, not metadata inferred from a saved envelope or a fabricated session.
function bindingFor(f: McpResponseCustodyFixture, projected = () => {}): McpReadBinding {
  return { definition: { ...structuredClone(f.tool.definition), version: '1' }, remote: structuredClone(MCP_FIXTURE_DOCUMENTS_TOOL),
    projectorId: 'custody-value', projectorVersion: '1', project(value) {
      projected(); assert.ok(value && typeof value === 'object' && !Array.isArray(value));
      return { output: { value: value['value']! }, coverage: 'complete', observations: [{ sourceId: 'doc-origin', lineageId: 'doc-origin',
        locator: '/structuredContent/value', observedAt: 900, coverage: 'complete', facts: { value: value['value'] as number } }] };
    } };
}
const reader = (f: McpResponseCustodyFixture, binding = bindingFor(f)) =>
  createMcpStoredReadTool(binding, origin, f.services, f.schemas);

for (const backend of adapters) test(`${backend}: stored-only factory reopens original response proofs without a client or current session`, async t => {
  const f = await createMcpResponseCustodyFixture(t, backend), p = await f.prepare(), result = await f.invoke(p.attempt.id);
  const before = await f.current(), response = await f.response(p.attempt.id), ref = f.rawRef(); assert.ok(response); assert.ok(ref);
  const raw = await f.raw(ref); await f.reopen(); f.setNow(10000);
  const tool = reader(f), input = { attemptId: p.attempt.id, task: p.task };
  assert.equal(MCP_PROTOCOL_VERSION, MCP_FIXTURE_PROTOCOL);
  assert.equal(tool.availability, 'stored_only'); assert.equal(f.tool.availability, undefined);
  assert.deepEqual(tool.definition, f.tool.definition);
  assert.equal(f.services.digester.digest(asJson(tool.definition)), f.services.digester.digest(asJson(f.tool.definition)));
  const restored = await tool.restoreResult!(await f.current(), input);
  assert.equal(restored.kind, 'available'); if (restored.kind !== 'available') assert.fail();
  assert.deepEqual(restored.result, result); assert.equal(restored.receivedAt, 1100);
  assert.deepEqual(restored.receipt, { commandId: `mcp-response:${p.attempt.id}`, digest: response.digest, artifact: ref });
  assert.equal(await tool.validateResult!(await f.current(), restored.result), true);
  assert.deepEqual(await tool.restoreResult!(await f.current(), input), restored);
  assert.deepEqual(await f.current(), before); assert.deepEqual(await f.response(p.attempt.id), response);
  assert.deepEqual((await f.raw(ref)).bytes, raw.bytes);
  assert.equal(await f.services.state.receipt(f.work.id, `receive:${p.attempt.id}`), null);
  assert.equal(f.counters.calls, 1); assert.equal(f.counters.discoveries, 0);
});

test('stored-only usage survives current label/tool reduction without projecting or adopting the saved body', async t => {
  const f = await createMcpResponseCustodyFixture(t), p = await f.prepare(), result = await f.invoke(p.attempt.id);
  await f.mutate(state => { state.policy.allowedLabels = []; state.policy.allowedTools = []; }); await f.reopen();
  const before = await f.current(); let projections = 0;
  const tool = reader(f, bindingFor(f, () => { projections++; })), input = { attemptId: p.attempt.id, task: p.task };
  const usage = await tool.restoreUsage!(before, input);
  assert.equal(usage.kind, 'available'); if (usage.kind !== 'available') assert.fail();
  assert.deepEqual(usage.usage, { transportCalls: 1, internalOperations: null, imageBytes: null, waitMs: null });
  assert.deepEqual(await tool.restoreUsage!(before, input), usage);
  assert.deepEqual(Object.keys(usage).sort(), ['custodyOnly', 'kind', 'receipt', 'receivedAt', 'responseObserved', 'usage']);
  await assert.rejects(tool.restoreResult!(before, input), /mcp_saved_result_invalid/);
  assert.equal(await tool.validateResult!(before, result), false);
  assert.equal(projections, 0); assert.deepEqual(await f.current(), before);
  assert.equal(f.counters.calls, 1); assert.equal(f.counters.discoveries, 0);
});

test('stored-only does not turn captured post-check failure into a result even when its usage is known', async t => {
  const f = await createMcpResponseCustodyFixture(t), p = await f.prepare(); f.controls.callMode = 'captured-failure';
  await assert.rejects(f.invoke(p.attempt.id), error => error === f.errors.captured);
  const ref = f.rawRef(); assert.ok(ref); const before = await f.current(); let projections = 0;
  const tool = reader(f, bindingFor(f, () => { projections++; })), input = { attemptId: p.attempt.id, task: p.task };
  const usage = await tool.restoreUsage!(before, input); assert.equal(usage.kind, 'available');
  if (usage.kind !== 'available') assert.fail(); assert.equal(usage.usage.transportCalls, 1);
  await assert.rejects(tool.restoreResult!(before, input), /mcp_saved_result_invalid/);
  assert.equal(await tool.validateResult!(before, f.expectedBody(p.attempt.id, ref)), false);
  assert.equal(projections, 0); assert.deepEqual(await f.current(), before); assert.equal(f.counters.calls, 1);
});

for (const mode of ['returned', 'sent-true'] as const) test(`stored-only keeps the historical ${mode} receipt interpretation`, async t => {
  const f = await createMcpResponseCustodyFixture(t, 'sqlite', { legacyReceipt: true }), p = await f.prepare(); f.controls.callMode = mode;
  const result = await f.invoke(p.attempt.id), before = await f.current(), tool = reader(f), input = { attemptId: p.attempt.id, task: p.task };
  const usage = await tool.restoreUsage!(before, input); assert.equal(usage.kind, 'available'); if (usage.kind !== 'available') assert.fail();
  assert.equal(usage.usage.transportCalls, mode === 'sent-true' ? null : 1);
  assert.equal(usage.custodyOnly, false);
  const restored = await tool.restoreResult!(before, input); assert.equal(restored.kind, 'available');
  if (restored.kind !== 'available') assert.fail(); assert.deepEqual(restored.result, result);
  assert.equal(await tool.validateResult!(before, result), true); assert.deepEqual(await f.current(), before);
});

test('stored-only validates trusted endpoint/protocol/binding and cannot reinterpret old source custody', async t => {
  const f = await createMcpResponseCustodyFixture(t), p = await f.prepare(), result = await f.invoke(p.attempt.id);
  const before = await f.current(), input = { attemptId: p.attempt.id, task: p.task }, binding = bindingFor(f);
  for (const supplied of [{ ...origin, endpointId: '' }, { ...origin, protocolVersion: 'older-unregistered-version' },
    { ...origin, generation: 9, discoveryDigest: 'd'.repeat(64) }])
    assert.throws(() => createMcpStoredReadTool(binding, supplied, f.services, f.schemas));
  for (const tool of [createMcpStoredReadTool(binding, { ...origin, endpointId: 'another-endpoint' }, f.services, f.schemas),
    reader(f, { ...binding, projectorVersion: '2' })]) {
    assert.notDeepEqual(tool.definition, f.tool.definition);
    await assert.rejects(tool.restoreUsage!(before, input), /mcp_saved_result_invalid/);
    await assert.rejects(tool.restoreResult!(before, input), /mcp_saved_result_invalid/);
    assert.equal(await tool.validateResult!(before, result), false);
  }
  const changed = structuredClone(before); changed.dataLifecycle = { generation: 1, blockedArtifactIds: [], changes: [] };
  await assert.rejects(reader(f).restoreUsage!(changed, input), /mcp_saved_result_invalid/);
  assert.deepEqual(await f.current(), before); assert.equal(f.counters.calls, 1);
});

test('stored-only absence never sends or writes an intent and direct execute rejects before authorization', async t => {
  const f = await createMcpResponseCustodyFixture(t), p = await f.prepare(), tool = reader(f), before = await f.current();
  const input = { attemptId: p.attempt.id, task: p.task };
  assert.deepEqual(await tool.restoreResult!(before, input), { kind: 'absent' });
  assert.deepEqual(await tool.restoreUsage!(before, input), { kind: 'absent' });
  let authorizations = 0;
  await assert.rejects(tool.execute(p.task, { workId: f.work.id, attemptId: p.attempt.id, policy: before.policy,
    signal: f.controller.signal, authorize: async () => { authorizations++; } }), /mcp_stored_only/);
  assert.equal(authorizations, 0); assert.deepEqual(await f.current(), before);
  assert.equal(await f.services.state.receipt(f.work.id, `mcp-intent:${p.attempt.id}`), null);
  assert.equal(f.counters.calls, 0); assert.equal(f.counters.discoveries, 0); assert.equal(f.counters.rawPuts, 0);
});
