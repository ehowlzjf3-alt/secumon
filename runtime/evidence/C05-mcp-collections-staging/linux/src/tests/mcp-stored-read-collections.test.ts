import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isReadDeferral } from '../domain/read-collection.js';
import { createMcpReadCollection, createMcpStoredReadCollection } from '../infrastructure/mcp-read-collections.js';
import { MCP_PROTOCOL_VERSION, McpStdioClient } from '../infrastructure/mcp-stdio-client.js';
import { sha256 } from '../infrastructure/digest.js';
import { adapters } from './state-conformance-helpers.js';
import { collectionHostFixture } from './mcp-collection-host-fixture.js';

for (const backend of adapters) for (const deferral of [false, true]) {
  test(`${backend}: stored collection authenticates original ${deferral ? 'deferral' : 'page'} after peer and repository close`, { timeout: 20000 }, async t => {
    const f = await collectionHostFixture(t, backend, deferral), seeded = await f.seed();
    // From here onward there is no online client in the reader; any accidental discovery/call is a test failure.
    for (const method of ['discover', 'call'] as const)
      t.mock.method(McpStdioClient.prototype, method, () => assert.fail(`stored reader called ${method}`));
    const origin = { endpointId: f.config.endpointId, protocolVersion: MCP_PROTOCOL_VERSION };
    const stored = createMcpStoredReadCollection(f.binding, origin, f.services, f.schemas);
    assert.equal(stored.availability, 'stored_only'); assert.equal(seeded.collection.availability, undefined);
    assert.deepEqual(stored.definition, seeded.collection.definition);
    // Generation/discovery are historical proof, not a fabricated current connection.
    const later = createMcpReadCollection(f.binding, { ...seeded.session, generation: seeded.session.generation + 1,
      discoveryDigest: 'f'.repeat(64) }, seeded.client, f.services, f.schemas);
    assert.deepEqual(later.definition, stored.definition);
    origin.endpointId = 'caller-changed-origin';
    const before = await f.current(), events = await f.services.state.events(before.id, 0);
    const restored = await stored.source.restoreResponse!(before, seeded.input);
    assert.equal(restored.kind, 'available'); if (restored.kind !== 'available') assert.fail();
    assert.deepEqual(restored.response, seeded.response); assert.equal(restored.receivedAt, 1000);
    assert.equal(restored.response.usage?.transportCalls, 1);
    assert.equal(seeded.envelope.schemaVersion, 1); assert.equal(seeded.envelope.kind, 'mcp_collection_response');
    assert.deepEqual(seeded.envelope.session, seeded.session);
    if (isReadDeferral(restored.response)) {
      assert.equal(deferral, true); assert.equal(restored.response.dueAt, 3500);
      assert.equal(await stored.source.validateDeferral!(before, { ...seeded.input, deferral: restored.response }), true);
      assert.deepEqual(stored.source.manifest!(seeded.task), seeded.collection.source.manifest!(seeded.task));
    } else {
      assert.equal(deferral, false); assert.deepEqual(restored.response.items.map(item => item.id), ['a', 'b']);
      assert.equal(await stored.source.validatePage!(before, { ...seeded.input, page: restored.response }), true);
      assert.ok(restored.response.items.every(item => item.evidence.every(record => record.artifact?.id === seeded.rawArtifact.id)));
    }
    let authorizations = 0;
    await assert.rejects(stored.source.fetch(seeded.task, seeded.input.request, { workId: before.id, attemptId: seeded.attempt.id,
      policy: before.policy, signal: new AbortController().signal, authorize: async () => { authorizations++; } }), /mcp_stored_only/);
    assert.equal(authorizations, 0, 'direct fetch cannot create a new intent or touch the online path');
    assert.deepEqual(await f.current(), before); assert.deepEqual(await f.services.state.events(before.id, 0), events);
    assert.deepEqual(await f.services.state.receipt(before.id, seeded.responseCommandId), seeded.receipt);
    assert.deepEqual(await f.services.artifacts.get(seeded.rawArtifact, before.policy), seeded.bytes);
    assert.equal(sha256(seeded.bytes), seeded.rawArtifact.sha256); assert.deepEqual(await f.audit(), seeded.auditBefore);
  });
}

test('stored collection distinguishes absent receipt from changed binding, current policy, request and corrupt original', { timeout: 20000 }, async t => {
  const f = await collectionHostFixture(t), seeded = await f.seed();
  const origin = { endpointId: f.config.endpointId, protocolVersion: MCP_PROTOCOL_VERSION };
  const stored = createMcpStoredReadCollection(f.binding, origin, f.services, f.schemas), state = await f.current();
  const absent = { ...seeded.input, request: { ...seeded.input.request, requestId: 'never-received' } };
  assert.deepEqual(await stored.source.restoreResponse!(state, absent), { kind: 'absent' });
  for (const changed of [
    createMcpStoredReadCollection(f.binding, { ...origin, endpointId: 'other-endpoint' }, f.services, f.schemas),
    createMcpStoredReadCollection({ ...f.binding, projectorVersion: 'changed' }, origin, f.services, f.schemas),
  ]) await assert.rejects(changed.source.restoreResponse!(state, seeded.input), /mcp_saved_response_invalid/);
  await assert.rejects(stored.source.restoreResponse!({ ...state, policy: { ...state.policy, allowedLabels: [] } }, seeded.input));
  await assert.rejects(stored.source.restoreResponse!(state, { ...seeded.input, task: { ...seeded.task, input: { ids: ['c'] } } }), /mcp_saved_response_invalid/);
  await assert.rejects(stored.source.restoreResponse!(state, { ...seeded.input, intentHead: { ...seeded.input.intentHead, sha256: '0'.repeat(64) } }), /mcp_saved_response_invalid/);
  await writeFile(join(f.directory, 'artifacts', `${seeded.rawArtifact.id}.blob`), '{}');
  await assert.rejects(stored.source.restoreResponse!(state, seeded.input));
  assert.ok(!isReadDeferral(seeded.response));
  assert.equal(await stored.source.validatePage!(state, { ...seeded.input, page: seeded.response }), false);
  assert.deepEqual(await f.audit(), seeded.auditBefore); assert.deepEqual(await f.current(), state);
});

test('stored collection rejects unsupported or fabricated origins and keeps its original custody ports', { timeout: 20000 }, async t => {
  const f = await collectionHostFixture(t), seeded = await f.seed();
  const origin = { endpointId: f.config.endpointId, protocolVersion: MCP_PROTOCOL_VERSION };
  for (const bad of [{ ...origin, protocolVersion: 'old' }, { ...origin, endpointId: ' ' },
    { ...origin, generation: 1, discoveryDigest: 'f'.repeat(64) }])
    assert.throws(() => createMcpStoredReadCollection(f.binding, bad, f.services, f.schemas));
  const ports = { state: f.services.state, artifacts: f.services.artifacts, digester: f.services.digester, clock: f.services.clock };
  const stored = createMcpStoredReadCollection(f.binding, origin, ports, f.schemas);
  ports.state = new Proxy(ports.state, { get() { assert.fail('stored reader redirected to a replacement custody object'); } });
  assert.equal((await stored.source.restoreResponse!(await f.current(), seeded.input)).kind, 'available');
  assert.deepEqual(await f.audit(), seeded.auditBefore);
});
