import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import type { Json } from '../domain/model.js';
import { createMcpHostTools, type McpHostToolsOptions } from '../presentation/mcp-host-tools.js';
import { createMcpStoredReadCollection } from '../infrastructure/mcp-read-collections.js';
import { MCP_PROTOCOL_VERSION, McpStdioClient } from '../infrastructure/mcp-stdio-client.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { refreshProviderTools } from '../application/provider-tool-snapshot.js';
import { collectionBinding } from './helpers/mcp-collection-binding.js';
import { collectionHostFixture, collectionPeerPlainBinding } from './mcp-collection-host-fixture.js';
import { adapters } from './state-conformance-helpers.js';

for (const backend of adapters) test(`${backend}: mixed MCP host discovers once and registers plain plus collection against the same session`, { timeout: 20000 }, async t => {
  const f = await collectionHostFixture(t, backend);
  const binding = f.binding, project = binding.project, manifest = binding.manifest;
  binding.project = function (...args) { assert.equal(Object.isFrozen(this), true); assert.equal(this.projectorVersion, '1'); return project(...args); };
  binding.manifest = function (task) { assert.equal(Object.isFrozen(this), true); assert.equal(this.projectorVersion, '1'); return manifest(task); };
  const options = { ...f.options, bindings: [collectionPeerPlainBinding()] }, registration = createMcpHostTools(options);
  binding.project = () => assert.fail('mutated projector'); binding.manifest = () => assert.fail('mutated manifest');
  binding.remote = { ...binding.remote, name: 'mutated.remote' }; binding.projectorVersion = '2';
  options.config.args.length = 0; options.policy.allowedTools = [];
  const lease = await f.open(registration); assert.equal(lease.providerSources, undefined);
  assert.equal(lease.tools.length, 1); assert.equal(lease.collectionTools?.length, 1);
  assert.equal(lease.collectionTools![0]!.availability, undefined);
  assert.deepEqual(lease.policy, f.work.policy);
  const core = await f.compose(lease); assert.equal(core.contracts.visible(lease.policy).length, 2);
  await f.accept();
  const collection = lease.collectionTools![0]!, first = await f.invoke(core, f.task('collection', collection.definition.version));
  assert.equal(first.result.status, 'success'); assert.equal(first.result.usage?.transportCalls, 1);
  await core.runtime.receive(f.work.id, first.attempt.id, first.result, 'invoked'); await core.runtime.adopt(f.work.id, first.attempt.id);
  const checkpoint = await core.readCheckpoints.read(await f.current(), first.attempt.id);
  const page = checkpoint.collection.pages[0]!; assert.ok(page.rawArtifact);
  const firstRaw = JSON.parse(new TextDecoder().decode(await f.services.artifacts.get(page.rawArtifact, lease.policy)));
  const second = await f.invoke(core, f.task('plain', lease.tools[0]!.definition.version, true));
  assert.equal(second.result.status, 'success'); assert.deepEqual(second.result.output, { count: 2 });
  const secondRaw = JSON.parse(new TextDecoder().decode(await f.services.artifacts.get(second.result.artifacts[0]!, lease.policy)));
  assert.deepEqual(secondRaw.session, firstRaw.session, 'both adapters use the single discovery generation');
  assert.equal(firstRaw.kind, 'mcp_collection_response'); assert.equal(secondRaw.kind, 'mcp_decoded_response');
  const close = lease.close(); assert.equal(lease.close(), close); await close;
  const audit = await f.audit(); assert.equal(audit.filter(row => row.event === 'start').length, 1);
  assert.equal(audit.filter(row => row.event === 'method' && row.method === 'tools/list').length, 1);
  assert.deepEqual(audit.filter(row => row.event === 'call').map(row => row.tool), ['documents.batch', 'observations.page']);
  assert.equal(audit.filter(row => row.event === 'close').length, 1);
});

test('mixed registration captures one provider and rejects combined count/byte overflow before peer or schema compile', async t => {
  const f = await collectionHostFixture(t), plain = collectionPeerPlainBinding();
  const cases: McpHostToolsOptions[] = [
    { ...f.options, bindings: [], collectionBindings: [] },
    { ...f.options, bindings: [plain], collectionBindings: [{ ...f.binding, definition: { ...f.binding.definition, provider: 'another', id: 'another.collection' } }] },
    { ...f.options, bindings: [{ ...plain, remote: f.binding.remote }], collectionBindings: [f.binding] },
    { ...f.options, bindings: [{ ...plain, definition: { ...plain.definition, id: f.binding.definition.id } }], collectionBindings: [f.binding] },
    { ...f.options, collectionBindings: [{ ...f.binding, definition: { ...f.binding.definition, effect: 'write' } }] },
    { ...f.options, collectionBindings: [{ ...f.binding, definition: { ...f.binding.definition, provider: 'core', id: 'core.collection' } }] },
    { ...f.options, collectionBindings: [{ ...f.binding, manifest: undefined } as unknown as typeof f.binding] },
    { ...f.options, bindings: Array.from({ length: 1000 }, (_, index) => ({ ...plain, definition: { ...plain.definition, id: `fixture.${index}` },
      remote: { ...plain.remote, name: `remote.${index}` } })), collectionBindings: [f.binding] },
  ];
  for (const options of cases) assert.throws(() => createMcpHostTools(options), /mcp_host_registration_invalid/);
  const big = 'x'.repeat(2 * 1024 * 1024);
  const largePlain = { ...plain, definition: { ...plain.definition, inputSchema: { type: 'object', description: big } } };
  const largeCollection = { ...f.binding, definition: { ...f.binding.definition, inputSchema: { type: 'object', description: big } } };
  assert.throws(() => createMcpHostTools({ ...f.options, bindings: [largePlain], collectionBindings: [largeCollection] }),
    error => error instanceof Error && error.message === 'mcp_host_registration_invalid' &&
      error.cause instanceof Error && error.cause.message === 'provider_byte_limit');
  await assert.rejects(stat(f.auditPath), { code: 'ENOENT' });
});

for (const cleanupFails of [false, true]) test(`mixed open preserves final collection compile error${cleanupFails ? ' and owned close error' : ''} without returning a partial lease`, { timeout: 20000 }, async t => {
  const f = await collectionHostFixture(t), primary = new Error('collection_schema_unavailable'), cleanup = new Error('owned_client_close_failed');
  const expected = JSON.stringify(f.binding.remote.outputSchema);
  const assembly = { ...f.assembly(), schemas: { compile(schema: Json) {
    if (JSON.stringify(schema) === expected) throw primary; return f.schemas.compile(schema);
  } } };
  const close = McpStdioClient.prototype.close; let closes = 0;
  t.mock.method(McpStdioClient.prototype, 'close', async function (this: McpStdioClient) {
    closes++; await close.call(this); if (cleanupFails) throw cleanup;
  });
  const registration = createMcpHostTools({ ...f.options, bindings: [collectionPeerPlainBinding()] });
  await assert.rejects(f.open(registration, assembly), error => cleanupFails ? error instanceof AggregateError && error.cause === primary &&
    error.errors.length === 2 && error.errors[0] === primary && error.errors[1] === cleanup : error === primary);
  assert.equal(closes, 1); const audit = await f.audit();
  assert.equal(audit.filter(row => row.event === 'start').length, 1); assert.equal(audit.filter(row => row.event === 'close').length, 1);
  assert.equal(audit.filter(row => row.event === 'call').length, 0);
});

test('mixed host fails closed on a missing remote contract and owns independent client lifetimes', { timeout: 20000 }, async t => {
  const f = await collectionHostFixture(t), registration = createMcpHostTools({ ...f.options, bindings: [collectionPeerPlainBinding()] });
  const first = await f.open(registration), second = await f.open(registration);
  await first.close();
  const core = await f.compose(second); await f.accept();
  assert.equal((await f.invoke(core, f.task('second', second.collectionTools![0]!.definition.version))).result.status, 'success');
  const missing = collectionBinding('documents'); missing.remote = { ...missing.remote, name: 'missing.collection' };
  await assert.rejects(f.open(createMcpHostTools({ ...f.options, collectionBindings: [missing] })), /mcp_manifest_mismatch/);
  await second.close(); const audit = await f.audit();
  assert.equal(audit.filter(row => row.event === 'start').length, 3); assert.equal(audit.filter(row => row.event === 'close').length, 3);
  assert.equal(audit.filter(row => row.event === 'call').length, 1);
});

test('plain-only options keep lazy provider discovery and do not gain a collection field or permissions', { timeout: 20000 }, async t => {
  const f = await collectionHostFixture(t), options = { ...f.options, bindings: [collectionPeerPlainBinding()], collectionBindings: [],
    policy: { ...f.options.policy, allowedTools: [] } };
  const lease = await f.open(createMcpHostTools(options)); assert.deepEqual(lease.tools, []); assert.equal(lease.collectionTools, undefined);
  assert.equal(lease.providerSources?.length, 1); assert.deepEqual(await f.audit(), []);
  const contracts = new ToolContracts([], f.schemas), provider = lease.providerSources![0]!;
  await refreshProviderTools(contracts, provider.provider, provider.source, { signal: new AbortController().signal });
  assert.deepEqual(contracts.visible(lease.policy), []); assert.deepEqual(lease.policy.allowedTools, []);
  await lease.close(); const audit = await f.audit();
  assert.equal(audit.filter(row => row.event === 'method' && row.method === 'tools/list').length, 1);
  assert.equal(audit.filter(row => row.event === 'call').length, 0);
});

test('stored mixed host verifies online originals without online transport or custody ownership', { timeout: 20000 }, async t => {
  const f = await collectionHostFixture(t), seeded = await f.seed();
  for (const method of ['discover', 'call'] as const)
    t.mock.method(McpStdioClient.prototype, method, () => assert.fail(`stored open must not use client.${method}`));
  const originalClose = McpStdioClient.prototype.close;
  t.mock.method(McpStdioClient.prototype, 'close', function (this: McpStdioClient) {
    assert.equal(this, seeded.client, 'only the already closed seed client belongs to fixture cleanup');
    return originalClose.call(this);
  });
  const origin = { endpointId: f.config.endpointId, protocolVersion: MCP_PROTOCOL_VERSION };
  const registration = createMcpHostTools({ mode: 'stored_only', origin, bindings: [collectionPeerPlainBinding()],
    collectionBindings: [f.binding], policy: f.work.policy, limits: f.work.budget.limits });
  const lease = await f.open(registration); assert.equal(lease.providerSources, undefined);
  assert.equal(lease.tools.length, 1); assert.equal(lease.collectionTools?.length, 1);
  assert.equal(lease.tools[0]!.availability, 'stored_only'); assert.equal(lease.collectionTools![0]!.availability, 'stored_only');
  const stored = lease.collectionTools![0]!; assert.deepEqual(stored.definition, seeded.collection.definition);
  assert.deepEqual(stored.definition, createMcpStoredReadCollection(f.binding, origin, f.services, f.schemas).definition);
  const restored = await stored.source.restoreResponse!(await f.current(), seeded.input);
  assert.equal(restored.kind, 'available'); if (restored.kind !== 'available') assert.fail();
  assert.deepEqual(restored.response, seeded.response);
  const close = lease.close(); assert.equal(lease.close(), close); await close;
  assert.equal((await stored.source.restoreResponse!(await f.current(), seeded.input)).kind, 'available', 'lease close does not close caller-owned custody');
  assert.deepEqual(await f.current(), seeded.state); assert.deepEqual(await f.audit(), seeded.auditBefore);
});

test('stored host captures the deferral mapper and settings without changing the original wait proof', { timeout: 20000 }, async t => {
  const f = await collectionHostFixture(t, 'sqlite', true), seeded = await f.seed();
  const source = f.binding.deferral!, map = source.project, maximum = source.maxDelayMs;
  source.project = function (...args) { assert.equal(Object.isFrozen(this), true); assert.equal(this.maxDelayMs, maximum); return map(...args); };
  const registration = createMcpHostTools({ mode: 'stored_only', origin: { endpointId: f.config.endpointId, protocolVersion: MCP_PROTOCOL_VERSION },
    bindings: [], collectionBindings: [f.binding], policy: f.work.policy, limits: f.work.budget.limits });
  source.maxDelayMs = 1; source.version = 'changed'; source.project = () => assert.fail('replacement deferral mapper');
  const lease = await f.open(registration), stored = lease.collectionTools![0]!;
  assert.deepEqual(stored.definition, seeded.collection.definition);
  const restored = await stored.source.restoreResponse!(await f.current(), seeded.input);
  assert.equal(restored.kind, 'available'); if (restored.kind !== 'available') assert.fail();
  assert.deepEqual(restored.response, seeded.response); assert.deepEqual(await f.audit(), seeded.auditBefore);
});
