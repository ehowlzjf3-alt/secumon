import test from 'node:test';
import assert from 'node:assert/strict';
import type { SchemaCompiler, Tool, ToolDefinition } from '../application/ports.js';
import { refreshProviderTools, type ProviderToolPage, type ProviderToolSource } from '../application/provider-tool-snapshot.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';
import { openRegisteredHostTools, type HostProviderTools, type HostToolAssembly, type HostToolContext,
  type HostToolRegistration, type OpenedHostTools } from '../presentation/host-tools.js';

const context: HostToolContext = { agentId: 'provider-owner', root: '/owned/provider', scope: 'agent:provider-owner' };
function tool(id = 'remote.read', patch: Partial<ToolDefinition> = {}): Tool {
  return { definition: { provider: id.split('.')[0]!, id, version: '1', description: 'Host provider read', effect: 'read',
    inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'null' },
    destination: 'local', labels: ['public'], ...patch },
  async execute() { throw new Error('listing_must_not_execute'); } };
}
function page(tools: Tool[] = [tool()]): ProviderToolPage { return { revision: 'source-v1', tools, nextCursor: null }; }
function fixture() {
  const state = new MemoryStateRepository(), artifacts = new MemoryArtifactStore(), digester = new Sha256Digester();
  const clock = { now: () => 1 }, schemas = new AjvSchemas(), controller = new AbortController();
  const assembly: HostToolAssembly = { custody: { state, artifacts, digester, clock }, schemas, signal: controller.signal };
  let listings = 0, closes = 0;
  const source: ProviderToolSource = { async list() { assert.equal(this, source); listings++; return page(); } };
  const provider: HostProviderTools = { provider: 'remote', source, limits: { maxPages: 3, maxTools: 7, maxBytes: 65536 } };
  const providers = [provider];
  const lease: OpenedHostTools = { tools: [], providerSources: providers,
    policy: { tenantId: 'tenant', principalId: 'owner', allowedTools: [], allowedLabels: ['public'], allowedDestinations: ['local'], allowWrites: false },
    limits: { toolCalls: 4, modelCalls: 4, tokens: 10000, replans: 1, wallTimeMs: 60000 },
    async close() { assert.equal(this, lease); closes++; } };
  const registration: HostToolRegistration = { async open() { return lease; } };
  return { assembly, state, artifacts, digester, clock, schemas, controller, source, provider, providers, lease, registration,
    listings: () => listings, closes: () => closes };
}
function unsafe<T>(value: unknown): T { return value as T; }
async function opened(f: ReturnType<typeof fixture>) { return openRegisteredHostTools(f.registration, context, f.assembly); }

test('assembly preserves actual custody ports and captures schema method before the factory wait', async () => {
  const f = fixture(); let observed: HostToolAssembly | undefined, release!: () => void, schemaReads = 0, compilations = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const schemaReceiver: SchemaCompiler = { get compile() { schemaReads++; return function (this: unknown) {
    assert.equal(this, schemaReceiver); compilations++; return () => true;
  }; } };
  const supplied = { ...f.assembly, custody: { ...f.assembly.custody }, schemas: schemaReceiver };
  const pending = openRegisteredHostTools({ async open(_context, value) { observed = value; await gate; return f.lease; } }, context, supplied);
  const captured = observed!;
  assert.ok(captured); assert.notEqual(captured, supplied); assert.notEqual(captured.custody, supplied.custody);
  for (const key of ['state', 'artifacts', 'digester', 'clock'] as const) {
    assert.equal(captured.custody[key], f.assembly.custody[key]); assert.equal(Object.isFrozen(captured.custody[key]), false);
  }
  for (const value of [captured, captured.custody, captured.schemas]) assert.equal(Object.isFrozen(value), true);
  assert.equal(captured.signal, f.controller.signal); assert.equal(schemaReads, 1); assert.equal(compilations, 0); assert.equal(f.listings(), 0);
  supplied.custody.state = new MemoryStateRepository(); supplied.schemas = new AjvSchemas();
  Object.defineProperty(schemaReceiver, 'compile', { value: () => { assert.fail('replacement_schema'); } });
  assert.equal(captured.schemas.compile({})(null), true); assert.equal(compilations, 1); assert.equal(schemaReads, 1);
  assert.equal(captured.custody.state, f.state); release(); const value = await pending; await value.close();
  assert.equal(f.closes(), 1); assert.equal(await f.state.get('still-open'), null); await f.state.close();
});

test('invalid assembly is rejected before acquisition and does not fabricate missing ports or a signal', async () => {
  const f = fixture(); let opens = 0;
  const registration: HostToolRegistration = { async open() { opens++; return f.lease; } };
  for (const value of [null, [], {}, { ...f.assembly, custody: {} }, { ...f.assembly, signal: {} },
    { ...f.assembly, custody: { ...f.assembly.custody, artifacts: {} } }, { ...f.assembly, schemas: { compile: null } }])
    await assert.rejects(openRegisteredHostTools(registration, context, unsafe<HostToolAssembly>(value)), /agent_tool_registration_invalid/);
  assert.equal(opens, 0); assert.equal(f.closes(), 0); assert.equal(f.listings(), 0);
  const original = new Error('factory_failure');
  await assert.rejects(openRegisteredHostTools({ async open() { throw original; } }, context, f.assembly), error => error === original);
  assert.equal(f.closes(), 0);
});

test('legacy static factories remain valid while a supplied provider list requires real assembly even when empty', async () => {
  const f = fixture(); Reflect.deleteProperty(f.lease, 'providerSources');
  const legacy = await openRegisteredHostTools({ open: async _context => f.lease }, context);
  assert.equal(legacy.providerSources, undefined); await legacy.close(); assert.equal(f.closes(), 1);
  for (const providers of [[], [f.provider]]) {
    const attempt = fixture(); Reflect.set(attempt.lease, 'providerSources', providers);
    await assert.rejects(openRegisteredHostTools(attempt.registration, context), /agent_tool_registration_invalid/);
    assert.equal(attempt.closes(), 1); assert.equal(attempt.listings(), 0);
  }
  const empty = fixture(); empty.providers.length = 0; const value = await opened(empty);
  assert.deepEqual(value.providerSources, []); assert.deepEqual(value.tools, []); await value.close();
});

test('provider metadata and bound listing are fixed without granting permissions or compiling schemas during open', async () => {
  const f = fixture(); let compileCalls = 0, listReads = 0, executeCalls = 0;
  const candidate = tool(), expected = structuredClone(candidate.definition), execution = new Error('original_execute');
  candidate.execute = async function () { assert.equal(this, candidate); executeCalls++; throw execution; };
  Object.defineProperty(f.source, 'list', { configurable: true, get() {
    listReads++; return async function (this: unknown) { assert.equal(this, f.source); return page([candidate]); };
  } });
  const value = await openRegisteredHostTools(f.registration, context, { ...f.assembly, schemas: {
    compile(schema) { compileCalls++; return f.schemas.compile(schema); },
  } });
  const captured = value.providerSources![0]!;
  assert.equal(listReads, 1); assert.equal(compileCalls, 0); assert.deepEqual(value.policy.allowedTools, []);
  for (const item of [value.providerSources, captured, captured.source, captured.limits]) assert.equal(Object.isFrozen(item), true);
  Reflect.set(f.provider, 'provider', 'changed'); Reflect.set(f.provider.limits!, 'maxPages', 1001); f.providers.length = 0;
  Object.defineProperty(f.source, 'list', { value: async () => { assert.fail('replacement_list'); } });
  const compiler: SchemaCompiler = { compile(schema) { compileCalls++; return f.schemas.compile(schema); } };
  const contracts = new ToolContracts([], compiler);
  const refreshed = await refreshProviderTools(contracts, captured.provider, captured.source, { ...captured.limits, signal: f.controller.signal });
  assert.equal(refreshed.toolCount, 1); assert.equal(captured.provider, 'remote'); assert.equal(captured.limits!.maxPages, 3);
  assert.equal(listReads, 1); assert.equal(compileCalls, 2); assert.equal(executeCalls, 0);
  const stored = contracts.get('remote.read', '1')!.tool;
  candidate.definition.labels.push('private'); candidate.execute = async () => { assert.fail('replacement_execute'); };
  assert.deepEqual(stored.definition, expected);
  await assert.rejects(stored.execute({} as never, {} as never), error => error === execution); assert.equal(executeCalls, 1);
  await Promise.all([value.close(), value.close()]); await value.close(); assert.equal(f.closes(), 1);
});

test('duplicate providers, static ownership collisions and malformed sources close the acquired lease exactly once', async () => {
  const changes: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => { f.providers.push(f.provider); },
    f => { Reflect.set(f.lease, 'tools', [tool()]); },
    f => { Reflect.set(f.provider, 'provider', 'core'); },
    f => { Reflect.set(f.provider, 'provider', 'bad.provider'); },
    f => { Reflect.set(f.provider, 'source', { list: null }); },
    f => { Reflect.set(f.lease, 'providerSources', null); },
    f => { f.providers.length = 2; },
    f => { Reflect.set(f.provider, 'limits', { unknown: 1 }); },
    f => { Reflect.set(f.provider, 'limits', { maxPages: 'three' }); },
    f => { Reflect.set(f.provider, 'limits', { maxPages: () => 3 }); },
  ];
  for (const change of changes) {
    const f = fixture(); change(f);
    await assert.rejects(opened(f), /agent_tool_registration_invalid/);
    assert.equal(f.closes(), 1); assert.equal(f.listings(), 0);
  }
});

test('multiple distinct providers and unrelated static tools keep their independent listing ownership', async () => {
  const f = fixture(); Reflect.set(f.lease, 'tools', [tool('static.read')]);
  const other = tool('other.read'); f.providers.push({ provider: 'other', source: { list: async () => page([other]) } });
  const value = await opened(f), contracts = new ToolContracts([...value.tools], f.schemas);
  for (const provider of value.providerSources!)
    await refreshProviderTools(contracts, provider.provider, provider.source, { ...provider.limits, signal: f.controller.signal });
  assert.ok(contracts.get('remote.read', '1')); assert.ok(contracts.get('other.read', '1')); assert.ok(contracts.get('static.read', '1'));
  assert.deepEqual(value.policy.allowedTools, []); await value.close(); assert.equal(f.closes(), 1);
});

test('provider pages cannot introduce writes, core tools or broken proof callbacks before publication', async () => {
  const changes: Array<(candidate: Tool) => void> = [
    candidate => { candidate.definition.effect = 'write'; },
    candidate => { candidate.definition.provider = 'core'; candidate.definition.id = 'core.custom'; },
    candidate => { candidate.definition.id = 'core.custom'; },
    candidate => { candidate.definition.resultValidation = 'artifact-proof-v1'; },
    candidate => { Reflect.set(candidate, 'validateReadPage', true); },
  ];
  for (const change of changes) {
    const f = fixture(), candidate = tool(); change(candidate); f.source.list = async () => page([candidate]);
    const value = await opened(f), provider = value.providerSources![0]!;
    const old = tool('remote.old'), contracts = new ToolContracts([old], f.schemas), before = contracts.revision;
    await assert.rejects(refreshProviderTools(contracts, provider.provider, provider.source, { signal: f.controller.signal }), error => {
      assert.equal((error as Error).message, 'provider_listing_failed'); assert.ok((error as Error).cause instanceof Error); return true;
    });
    assert.equal(contracts.revision, before); assert.ok(contracts.get('remote.old', '1')); assert.equal(contracts.get('remote.read', '1'), undefined);
    await value.close(); assert.equal(f.closes(), 1);
  }
});

test('host page wrapping leaves shape, namespace and range validation to the existing atomic refresh', async () => {
  const cases: Array<{ result: ProviderToolPage; limits?: HostProviderTools['limits']; error: RegExp }> = [
    { result: unsafe({ ...page(), partial: true }), error: /invalid_provider_page/ },
    { result: unsafe({ tools: [tool()], nextCursor: null }), error: /invalid_provider_page/ },
    { result: page([tool('other.read')]), error: /provider_namespace_mismatch/ },
    { result: page(), limits: { maxPages: 1001 }, error: /invalid_provider_limits/ },
  ];
  for (const item of cases) {
    const f = fixture(); let calls = 0; f.source.list = async () => { calls++; return item.result; };
    if (item.limits) Reflect.set(f.provider, 'limits', item.limits);
    const value = await opened(f), provider = value.providerSources![0]!;
    const contracts = new ToolContracts([tool('remote.old')], f.schemas), before = contracts.revision;
    await assert.rejects(refreshProviderTools(contracts, provider.provider, provider.source, { ...provider.limits, signal: f.controller.signal }), item.error);
    assert.equal(calls, item.limits ? 0 : 1); assert.equal(contracts.revision, before); assert.ok(contracts.get('remote.old', '1'));
    await value.close(); assert.equal(f.closes(), 1);
  }
});

test('source callback failures keep the original cause through refresh and remain owned until explicit close', async () => {
  const f = fixture(), original = new Error('source_list_failure'); f.source.list = async () => { throw original; };
  const value = await opened(f), provider = value.providerSources![0]!;
  await assert.rejects(provider.source.list({ cursor: null, signal: f.controller.signal }), error => error === original);
  await assert.rejects(refreshProviderTools(new ToolContracts([], f.schemas), provider.provider, provider.source, { signal: f.controller.signal }), error => {
    assert.equal((error as Error).message, 'provider_listing_failed'); assert.equal((error as Error).cause, original); return true;
  });
  assert.equal(f.closes(), 0); await value.close(); assert.equal(f.closes(), 1); assert.equal(await f.state.get('no-port-close'), null);
});

test('provider getter failure and failed cleanup preserve both errors without retrying the closer', async () => {
  const f = fixture(), original = new Error('provider_getter'), cleanup = new Error('provider_cleanup'); let closes = 0;
  Object.defineProperty(f.provider, 'source', { get() { throw original; } });
  f.lease.close = async () => { closes++; throw cleanup; };
  await assert.rejects(opened(f), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 2);
    assert.equal(error.errors[0].message, 'agent_tool_registration_invalid'); assert.equal(error.errors[0].cause, original);
    assert.equal(error.errors[1], cleanup); return true;
  });
  assert.equal(closes, 1); assert.equal(f.listings(), 0);
});
