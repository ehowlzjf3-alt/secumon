import test from 'node:test';
import assert from 'node:assert/strict';
import type { McpReadBinding } from '../infrastructure/mcp-read-tools.js';
import { MCP_PROTOCOL_VERSION, McpStdioClient } from '../infrastructure/mcp-stdio-client.js';
import { createMcpHostTools, type McpHostToolsOptions } from '../presentation/mcp-host-tools.js';
import { openRegisteredHostTools } from '../presentation/host-tools.js';
import { MCP_FIXTURE_DOCUMENTS_TOOL } from './helpers/mcp-fixture-contracts.js';
import { createMcpResponseCustodyFixture, type McpResponseCustodyFixture } from './mcp-response-custody-fixture.js';
import { adapters } from './state-conformance-helpers.js';

function optionsFor(f: McpResponseCustodyFixture, projected = () => {}) {
  const binding: McpReadBinding = { definition: { ...structuredClone(f.tool.definition), version: '1' },
    remote: structuredClone(MCP_FIXTURE_DOCUMENTS_TOOL), projectorId: 'custody-value', projectorVersion: '1', project(value) {
      projected(); assert.equal(this.projectorVersion, '1'); assert.equal(Object.isFrozen(this), true);
      assert.ok(value && typeof value === 'object' && !Array.isArray(value));
      return { output: { value: value['value']! }, coverage: 'complete', observations: [{ sourceId: 'doc-origin', lineageId: 'doc-origin',
        locator: '/structuredContent/value', observedAt: 900, coverage: 'complete', facts: { value: value['value'] as number } }] };
    } };
  return { mode: 'stored_only' as const, origin: { endpointId: 'custody-fixture', protocolVersion: MCP_PROTOCOL_VERSION },
    bindings: [binding], policy: structuredClone(f.work.policy), limits: structuredClone(f.work.budget.limits) };
}
const contextFor = (f: McpResponseCustodyFixture) => ({ agentId: f.profile.identity.agentId, root: f.profile.root, scope: f.work.goal.scope });
const assemblyFor = (f: McpResponseCustodyFixture, signal = new AbortController().signal) => ({
  custody: { state: f.services.state, artifacts: f.services.artifacts, digester: f.services.digester, clock: f.services.clock },
  schemas: f.schemas, signal,
});

for (const backend of adapters) test(`${backend}: stored host opens captured static contracts and owns no peer or C01 store lifetime`, async t => {
  // The existing fixture seeds real C01 custody through its declared decoded-client substitute; the reader receives no client/config.
  const f = await createMcpResponseCustodyFixture(t, backend), p = await f.prepare(), result = await f.invoke(p.attempt.id);
  for (const name of ['discover', 'call', 'close'] as const)
    t.mock.method(McpStdioClient.prototype, name, () => assert.fail(`stored registration must not invoke client.${name}`));
  let projections = 0;
  const options = optionsFor(f, () => { projections++; }), registration = createMcpHostTools(options);
  options.origin.endpointId = 'later-mutated-endpoint'; options.bindings[0]!.projectorVersion = '2';
  options.bindings[0]!.definition.description = 'later-mutated-description';
  options.bindings[0]!.project = () => assert.fail('later projector must not replace the captured callback');
  options.policy.allowedLabels = []; options.policy.allowedTools = [];
  const abort = new AbortController(), assembly = assemblyFor(f, abort.signal);
  const lease = await openRegisteredHostTools(registration, contextFor(f), assembly); t.after(() => lease.close());
  assert.equal(lease.providerSources, undefined); assert.equal(lease.tools.length, 1);
  assert.deepEqual(lease.policy, f.work.policy); assert.deepEqual(lease.limits, f.work.budget.limits);
  const tool = lease.tools[0]!; assert.equal(tool.availability, 'stored_only'); assert.deepEqual(tool.definition, f.tool.definition);
  // Replacing the caller's assembly container cannot redirect an already opened lease to another source.
  assembly.custody.state = new Proxy(f.services.state, { get() { assert.fail('mutated assembly must not be used'); } });
  const before = await f.current(), input = { attemptId: p.attempt.id, task: p.task };
  const restored = await tool.restoreResult!(before, input); assert.equal(restored.kind, 'available');
  if (restored.kind !== 'available') assert.fail(); assert.deepEqual(restored.result, result); assert.equal(projections, 1);
  abort.abort(new Error('host_stopping'));
  const firstClose = lease.close(); assert.equal(lease.close(), firstClose); await firstClose;
  assert.equal((await tool.restoreUsage!(before, input)).kind, 'available', 'host drain may finish custody after the tool lease closes');
  assert.deepEqual(await f.current(), before, 'closing the lease does not close or mutate the supplied repository');
  await f.reopen();
  await assert.rejects(tool.restoreUsage!(before, input), 'an old lease must not silently switch to the new C01 handle');
  const reopened = await openRegisteredHostTools(registration, contextFor(f), assemblyFor(f)); t.after(() => reopened.close());
  assert.deepEqual(reopened.tools[0]!.definition, f.tool.definition);
  assert.equal((await reopened.tools[0]!.restoreUsage!(await f.current(), input)).kind, 'available');
  assert.equal(f.counters.calls, 1); assert.equal(f.counters.discoveries, 0);
});

test('stored host requires explicit mode, strict current origin and custody; none of these failures falls back online', async t => {
  const f = await createMcpResponseCustodyFixture(t), options = optionsFor(f);
  for (const malformed of [{ ...options, mode: 'automatic' }, { ...options, mode: undefined },
    { ...options, config: { command: '/not/a/peer' } }, { ...options, origin: { ...options.origin, protocolVersion: 'old-protocol' } },
    { ...options, origin: { ...options.origin, endpointId: ' ' } },
    { ...options, origin: { ...options.origin, generation: 1, discoveryDigest: 'f'.repeat(64) } }])
    assert.throws(() => createMcpHostTools(malformed as unknown as McpHostToolsOptions), /mcp_host_registration_invalid/);
  const registration = createMcpHostTools(options);
  await assert.rejects(registration.open(contextFor(f)), /mcp_host_assembly_required/);
  const aborted = new AbortController(), reason = new Error('stored_host_already_stopped'); aborted.abort(reason);
  await assert.rejects(registration.open(contextFor(f), assemblyFor(f, aborted.signal)), error => error === reason);
  assert.equal(f.counters.calls, 0); assert.equal(f.counters.discoveries, 0);
});

test('stored host preserves source read failures and never closes source custody or substitutes a remote read', async t => {
  const f = await createMcpResponseCustodyFixture(t), p = await f.prepare();
  const error = new Error('original_custody_store_unavailable'); let closes = 0;
  const state = new Proxy(f.services.state, { get(target, key) {
    if (key === 'receipt') return async () => { throw error; };
    if (key === 'close') return async () => { closes++; };
    const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const assembly = assemblyFor(f); assembly.custody.state = state;
  const lease = await openRegisteredHostTools(createMcpHostTools(optionsFor(f)), contextFor(f), assembly);
  t.after(() => lease.close()); const input = { attemptId: p.attempt.id, task: p.task }, before = await f.current();
  await assert.rejects(lease.tools[0]!.restoreUsage!(before, input), cause => cause === error);
  await assert.rejects(lease.tools[0]!.restoreResult!(before, input), cause => cause === error);
  await lease.close(); assert.equal(closes, 0); assert.deepEqual(await f.current(), before);
  assert.equal(f.counters.calls, 0); assert.equal(f.counters.discoveries, 0);
});
