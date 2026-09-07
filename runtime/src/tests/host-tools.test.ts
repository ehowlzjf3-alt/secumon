import test from 'node:test';
import assert from 'node:assert/strict';
import type { Tool } from '../application/ports.js';
import { ToolContracts } from '../application/tool-contracts.js';
import type { Limits, Policy, ToolResult } from '../domain/model.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { openRegisteredHostTools, resolveHostToolRegistration,
  type AgentExecutionHost, type HostToolContext, type HostToolRegistration, type OpenedHostTools } from '../presentation/host-tools.js';

const context: HostToolContext = { agentId: 'host-tool-agent', root: '/owned/agent', scope: 'agent:host-tool-agent' };
function fixture() {
  let calls = 0, closes = 0;
  const result: ToolResult = { resultId: 'unit-result', attemptId: 'unit-attempt', status: 'error',
    error: { code: 'unit_read_only', retryable: false }, effectState: 'none', evidence: [], artifacts: [], output: null, cursor: null, coverage: 'unknown' };
  const source: Tool = {
    definition: { provider: 'owned', id: 'owned.read', version: '1', description: 'Local host contract unit', effect: 'read',
      destination: 'local', labels: ['public'], inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'null' } },
    async execute() { assert.equal(this, source); calls++; return result; },
  };
  const policy: Policy = { tenantId: 'tenant', principalId: 'owner', allowedTools: ['owned.read'], allowedLabels: ['public'],
    allowedDestinations: ['local'], allowWrites: false };
  const limits: Limits = { toolCalls: 4, modelCalls: 4, tokens: 10000, replans: 1, wallTimeMs: 60000 };
  const tools = [source];
  const lease: OpenedHostTools = { tools, policy, limits, async close() { assert.equal(this, lease); closes++; } };
  return { lease, source, tools, result, calls: () => calls, closes: () => closes };
}
function registration(lease: OpenedHostTools): HostToolRegistration { return { open: async () => lease }; }
function unsafeHost(value: unknown) { return value as AgentExecutionHost; }

test('only an undefined host tool registration is absent; malformed registrations and getters retain errors', () => {
  assert.equal(resolveHostToolRegistration(undefined), null);
  assert.equal(resolveHostToolRegistration({ models: new Map() }), null);
  for (const tools of [null, false, 0, [], 'file:///not-loaded.js', {}, { open: null }])
    assert.throws(() => resolveHostToolRegistration(unsafeHost({ tools })), /agent_tool_registration_invalid/);
  for (const host of [null, false, [], 'module-path'])
    assert.throws(() => resolveHostToolRegistration(unsafeHost(host)), /agent_tool_registration_invalid/);
  const original = new Error('registration_getter_failed');
  assert.throws(() => resolveHostToolRegistration(unsafeHost({ get tools() { throw original; } })), error => {
    assert.equal((error as Error).message, 'agent_tool_registration_invalid'); assert.equal((error as Error).cause, original); return true;
  });
});

test('registration captures its one getter and bound factory before later host changes', async () => {
  const f = fixture(); let selectedReads = 0, methodReads = 0, opens = 0;
  const original = { get open() { methodReads++; return async function (this: unknown) {
    assert.equal(this, original); opens++; return f.lease;
  }; } };
  const host = unsafeHost({ get tools() { selectedReads++; return original; } });
  const selected = resolveHostToolRegistration(host)!;
  Object.defineProperty(original, 'open', { value: async () => { assert.fail('replacement_factory'); } });
  Object.defineProperty(host, 'tools', { value: null });
  assert.equal(selectedReads, 1); assert.equal(methodReads, 1); assert.equal(opens, 0); assert.equal(Object.isFrozen(selected), true);
  const opened = await openRegisteredHostTools(selected, context);
  assert.equal(opens, 1); assert.equal(f.calls(), 0); await opened.close(); assert.equal(f.closes(), 1);
});

test('factory gets only a frozen context copy captured before its asynchronous wait', async () => {
  const f = fixture(), supplied = { ...context }; let release!: () => void, observed: HostToolContext | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pending = openRegisteredHostTools({ async open(value) { observed = value; await gate; return f.lease; } }, supplied);
  supplied.agentId = 'changed'; supplied.root = '/another/root';
  assert.deepEqual(observed, context); assert.notEqual(observed, supplied); assert.equal(Object.isFrozen(observed), true);
  assert.deepEqual(Object.keys(observed!).sort(), ['agentId', 'root', 'scope']);
  release(); const opened = await pending; await opened.close(); assert.equal(f.closes(), 1);
});

test('invalid context or its clone failure prevents the factory from acquiring resources', async () => {
  const f = fixture(); let opens = 0;
  const selected: HostToolRegistration = { async open() { opens++; return f.lease; } };
  for (const value of [{ ...context, agentId: '' }, { ...context, root: '\0' }, { ...context, scope: ' ' },
    { ...context, permission: 'not-part-of-context' }, { ...context, callback() {} }])
    await assert.rejects(openRegisteredHostTools(selected, value), /agent_tool_registration_invalid/);
  assert.equal(opens, 0); assert.equal(f.closes(), 0);
});

test('opened tool metadata and methods are copied without freezing or expanding the host policy', async () => {
  const f = fixture(); f.lease.policy.allowedTools = [];
  const expectedPolicy = structuredClone(f.lease.policy), expectedLimits = structuredClone(f.lease.limits);
  const expectedDefinition = structuredClone(f.source.definition);
  const opened = await openRegisteredHostTools(registration(f.lease), context), tool = opened.tools[0]!;
  assert.deepEqual(opened.policy, expectedPolicy); assert.deepEqual(opened.policy.allowedTools, []);
  for (const value of [opened, opened.tools, tool, tool.definition, tool.definition.inputSchema, tool.definition.labels,
    opened.policy, opened.policy.allowedTools, opened.limits]) assert.equal(Object.isFrozen(value), true);
  for (const value of [f.lease, f.tools, f.source, f.source.definition, f.source.definition.inputSchema, f.lease.policy, f.lease.limits])
    assert.equal(Object.isFrozen(value), false);
  f.source.definition.labels.push('secret'); f.source.definition.description = 'changed';
  Reflect.set(f.source.definition.inputSchema as object, 'additionalProperties', true);
  f.lease.policy.allowedTools.push('unexpected'); f.lease.limits.modelCalls = 1000; f.tools.length = 0;
  f.source.execute = async () => { assert.fail('replacement_execute'); };
  f.lease.close = async () => { assert.fail('replacement_close'); };
  assert.deepEqual(tool.definition, expectedDefinition); assert.deepEqual(opened.policy, expectedPolicy); assert.deepEqual(opened.limits, expectedLimits);
  assert.equal(await tool.execute({} as never, {} as never), f.result); assert.equal(f.calls(), 1);
  const first = opened.close(), second = opened.close(); assert.equal(first, second);
  await Promise.all([first, second]); await opened.close(); assert.equal(f.closes(), 1);
});

test('optional proof and response custody callbacks keep their receiver and are not lost at registration', async () => {
  const f = fixture(), invoked: string[] = [];
  f.source.definition.resultValidation = 'artifact-proof-v1';
  f.source.validateResult = async function () { assert.equal(this, f.source); invoked.push('result'); return true; };
  f.source.validateReadPage = async function () { assert.equal(this, f.source); invoked.push('page'); return true; };
  f.source.validateReadDeferral = async function () { assert.equal(this, f.source); invoked.push('deferral'); return true; };
  f.source.restoreReadResponse = async function () { assert.equal(this, f.source); invoked.push('custody'); return { kind: 'absent' }; };
  f.source.readManifest = function () { assert.equal(this, f.source); invoked.push('manifest'); return [{ id: 'read-key', inputDigest: 'a'.repeat(64) }]; };
  const opened = await openRegisteredHostTools(registration(f.lease), context), tool = opened.tools[0]!;
  f.source.validateResult = async () => false; f.source.validateReadPage = async () => false;
  f.source.validateReadDeferral = async () => false;
  f.source.restoreReadResponse = async () => { assert.fail('replacement_custody'); };
  f.source.readManifest = () => { assert.fail('replacement_manifest'); };
  assert.equal(await tool.validateResult!({} as never, f.result), true);
  assert.equal(await tool.validateReadPage!({} as never, {} as never), true);
  assert.equal(await tool.validateReadDeferral!({} as never, {} as never), true);
  assert.deepEqual(await tool.restoreReadResponse!({} as never, {} as never), { kind: 'absent' });
  assert.deepEqual(tool.readManifest!({} as never), [{ id: 'read-key', inputDigest: 'a'.repeat(64) }]);
  assert.deepEqual(invoked, ['result', 'page', 'deferral', 'custody', 'manifest']); assert.equal(f.calls(), 0);
  await opened.close(); assert.equal(f.closes(), 1);
});

test('write effects, core namespace, duplicate identity and missing proof callbacks reject and close once', async () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.source.definition.effect = 'write'; },
    f => { f.source.definition.provider = 'core'; f.source.definition.id = 'core.custom'; },
    f => { f.source.definition.id = 'core.evidence.get'; },
    f => { f.tools.push(f.source); },
    f => { Reflect.set(f.source, 'execute', undefined); },
    f => { f.source.definition.resultValidation = 'artifact-proof-v1'; },
    f => { Reflect.set(f.lease, 'tools', null); },
    f => { f.tools.length = 2; },
  ];
  for (const change of changes) {
    const f = fixture(); change(f);
    await assert.rejects(openRegisteredHostTools(registration(f.lease), context), /agent_tool_registration_invalid/);
    assert.equal(f.closes(), 1); assert.equal(f.calls(), 0);
  }
});

test('policy and work limit failures close an acquired lease without silently repairing metadata', async () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.lease.policy.allowWrites = true; }, f => { f.lease.policy.tenantId = ''; },
    f => { Reflect.set(f.lease.policy, 'unknown', true); }, f => { Reflect.set(f.lease.policy, 'allowedLabels', null); },
    f => { f.lease.limits.tokens = Number.NaN; }, f => { f.lease.limits.modelCalls = -1; },
    f => { f.lease.limits.toolCalls = 0.5; }, f => { f.lease.limits.wallTimeMs = 0; },
    f => { Reflect.set(f.lease.limits, 'modelCalls', undefined); }, f => { Reflect.set(f.lease.limits, 'extraBudget', 1); },
  ];
  for (const change of changes) {
    const f = fixture(); change(f);
    await assert.rejects(openRegisteredHostTools(registration(f.lease), context), /agent_tool_registration_invalid/);
    assert.equal(f.closes(), 1); assert.equal(f.calls(), 0);
  }
});

test('empty tools and different versions preserve exact policies and compile only at the existing consumer', async () => {
  const empty = fixture(); empty.tools.length = 0; empty.lease.policy.allowedTools = [];
  const openedEmpty = await openRegisteredHostTools(registration(empty.lease), context);
  assert.deepEqual(openedEmpty.tools, []); assert.deepEqual(openedEmpty.policy.allowedTools, []);
  await openedEmpty.close(); assert.equal(empty.closes(), 1);
  const f = fixture(), second: Tool = { ...f.source, definition: { ...f.source.definition, version: '2' } };
  f.tools.push(second); const opened = await openRegisteredHostTools(registration(f.lease), context);
  assert.deepEqual(opened.tools.map(tool => tool.definition.version), ['1', '2']);
  const ajv = new AjvSchemas(); let compilations = 0;
  const contracts = new ToolContracts([...opened.tools], { compile(schema) { compilations++; return ajv.compile(schema); } });
  assert.equal(compilations, 4); assert.ok(contracts.get('owned.read', '1')); assert.ok(contracts.get('owned.read', '2'));
  assert.equal(f.calls(), 0); await opened.close();
  const malformed = fixture(); malformed.source.definition.inputSchema = { type: 'not-a-schema-type' };
  const acquired = await openRegisteredHostTools(registration(malformed.lease), context);
  assert.throws(() => new ToolContracts([...acquired.tools], new AjvSchemas()), /invalid_tool_schema/);
  await acquired.close(); assert.equal(malformed.closes(), 1);
});

test('factory exceptions retain the original error object and are not treated as missing registration', async () => {
  const original = new Error('factory_open_failed');
  await assert.rejects(openRegisteredHostTools({ async open() { throw original; } }, context), error => error === original);
});

test('metadata getter and clone failures occur inside acquired cleanup and preserve their original cause', async () => {
  const f = fixture(), original = new Error('policy_getter_failed');
  Object.defineProperty(f.lease, 'policy', { get() { throw original; } });
  await assert.rejects(openRegisteredHostTools(registration(f.lease), context), error => {
    assert.equal((error as Error).message, 'agent_tool_registration_invalid'); assert.equal((error as Error).cause, original); return true;
  });
  assert.equal(f.closes(), 1);
  const unclonable = fixture(); Reflect.set(unclonable.lease.policy, 'callback', () => undefined);
  await assert.rejects(openRegisteredHostTools(registration(unclonable.lease), context), error => {
    assert.equal((error as Error).message, 'agent_tool_registration_invalid');
    assert.equal(((error as Error).cause as Error).name, 'DataCloneError'); return true;
  });
  assert.equal(unclonable.closes(), 1);
});

test('validation plus close failure retain both causes and a successful lease close never retries a failure', async () => {
  const f = fixture(), validation = new Error('tools_getter_failed'), cleanup = new Error('close_failed'); let closes = 0;
  Object.defineProperty(f.lease, 'tools', { get() { throw validation; } });
  f.lease.close = async () => { closes++; throw cleanup; };
  await assert.rejects(openRegisteredHostTools(registration(f.lease), context), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.message, 'agent_profile_cleanup_failed');
    assert.equal(error.errors.length, 2); assert.equal(error.cause, error.errors[0]);
    assert.equal((error.errors[0] as Error).cause, validation); assert.equal(error.errors[1], cleanup); return true;
  });
  assert.equal(closes, 1);
  const valid = fixture(); valid.lease.close = async () => { closes++; throw cleanup; };
  const opened = await openRegisteredHostTools(registration(valid.lease), context);
  const first = opened.close(), second = opened.close(); assert.equal(first, second);
  await assert.rejects(first, error => error === cleanup); await assert.rejects(second, error => error === cleanup);
  await assert.rejects(opened.close(), error => error === cleanup); assert.equal(closes, 2);
});
