import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { ComputerBinding, ComputerDriver } from '../application/computer-use-ports.js';
import { createComputerTools } from '../application/computer-use.js';
import { isComputerObservationTool } from '../application/computer-tool-identity.js';
import type { Tool } from '../application/ports.js';
import { refreshProviderTools, type ProviderToolSource } from '../application/provider-tool-snapshot.js';
import { ToolDefinitionSchema } from '../application/resource-contracts.js';
import type { EffectProofValidator } from '../application/services.js';
import { snapshotTool, ToolContracts } from '../application/tool-contracts.js';
import type { TaskSpec } from '../domain/model.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';
import { SyntheticComputerDriver } from '../infrastructure/synthetic-computer-driver.js';
import { openRegisteredHostTools, type HostToolAssembly, type HostToolContext,
  type HostToolRegistration, type OpenedHostTools } from '../presentation/host-tools.js';
import { computerLimits } from './computer-use-helpers.js';

const context: HostToolContext = { agentId: 'write-computer-owner', root: '/owned/host', scope: 'agent:write-computer-owner' };
const computerIds = ['desktop.ui.observe', 'desktop.ui.act', 'desktop.ui.continue', 'desktop.ui.verify'];
function fixture(t: TestContext) {
  const state = new MemoryStateRepository();
  const assembly: HostToolAssembly = { custody: { state, artifacts: new MemoryArtifactStore(), digester: new Sha256Digester(), clock: { now: () => 1 } },
    schemas: new AjvSchemas(), signal: new AbortController().signal };
  const calls = { tool: 0, proof: 0, effect: 0, driver: 0, listings: 0, closes: 0 };
  const synthetic = new SyntheticComputerDriver();
  const driver: ComputerDriver = { identity: synthetic.identity,
    acquire(...args) { calls.driver++; return synthetic.acquire(...args); },
    observe(...args) { calls.driver++; return synthetic.observe(...args); },
    act(...args) { calls.driver++; return synthetic.act(...args); },
    wait(...args) { calls.driver++; return synthetic.wait(...args); },
    release(...args) { calls.driver++; return synthetic.release(...args); },
  };
  const computer: ComputerBinding = { provider: 'desktop', id: 'desktop.ui', version: '1', description: 'Host-owned synthetic document UI',
    destination: 'local', labels: ['public'], sessionId: synthetic.sessionId, limits: { ...computerLimits }, driver };
  function tool(provider: string, id: string, effect: 'read' | 'write'): Tool {
    return { definition: { provider, id, version: '1', description: 'Explicit host registration fixture', effect,
      destination: 'local', labels: ['public'], inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'null' },
      ...(effect === 'write' ? { resultValidation: 'artifact-proof-v1' as const } : {}) },
    async execute() { calls.tool++; throw new Error('registration_must_not_execute'); },
    ...(effect === 'write' ? { async validateResult() { calls.proof++; throw new Error('registration_must_not_validate_result'); } } : {}) };
  }
  const read = tool('documents', 'documents.read', 'read'), write = tool('changes', 'changes.apply', 'write');
  const reader: EffectProofValidator = {
    async current() { calls.effect++; throw new Error('registration_must_not_read_effect'); },
    async refresh() { calls.effect++; throw new Error('registration_must_not_refresh_effect'); },
    async recover() { calls.effect++; throw new Error('registration_must_not_recover_effect'); },
  };
  const lease: OpenedHostTools = { tools: [read], writeTools: [write], computerTools: [computer], effectReaders: [{ provider: 'changes', reader }],
    policy: { tenantId: 'tenant', principalId: 'owner', allowedTools: [read.definition.id, write.definition.id, ...computerIds],
      allowedLabels: ['public'], allowedDestinations: ['local'], allowWrites: false },
    limits: { toolCalls: 8, modelCalls: 4, tokens: 10000, replans: 2, wallTimeMs: 60000 },
    async close() { calls.closes++; } };
  const registration: HostToolRegistration = { async open() { return lease; } };
  const acquired: OpenedHostTools[] = [];
  t.after(async () => { try { for (const opened of acquired) await opened.close(); } finally { await state.close(); } });
  async function open() { const opened = await openRegisteredHostTools(registration, context, assembly); acquired.push(opened); return opened; }
  function source(candidate = write): ProviderToolSource {
    return { async list() { calls.listings++; return { revision: 'host-v1', tools: [candidate], nextCursor: null }; } };
  }
  return { assembly, calls, computer, driver, read, write, reader, lease, registration, open, source };
}
function generated(opened: OpenedHostTools) {
  return opened.computerTools!.flatMap(binding => createComputerTools(binding, () => { throw new Error('registration_must_not_run_computer'); }));
}
function task(tool: Tool): TaskSpec {
  const definition = tool.definition;
  return { id: `task:${definition.id}`, description: 'Check the registered contract only', toolId: definition.id, toolVersion: definition.version,
    effect: definition.effect, input: definition.id.endsWith('.act') ? { observationId: 'existing-observation', timeoutMs: 1000,
      steps: [{ action: { kind: 'click', target: { role: 'button', name: 'Save' } }, condition: { kind: 'fact_equals', key: 'saved', value: true } }] } : {},
    ...(definition.computerContinuation ? { computerResume: { attemptId: 'original-attempt', checkpointId: 'original-checkpoint', reconciliation: null } } : {}),
    dependsOn: [], maxAttempts: 1, satisfies: [] };
}
function noOperations(f: ReturnType<typeof fixture>) {
  assert.deepEqual({ tool: f.calls.tool, proof: f.calls.proof, effect: f.calls.effect, driver: f.calls.driver },
    { tool: 0, proof: 0, effect: 0, driver: 0 });
}

test('explicit host read, write and computer registrations retain fixed contracts without expanding permission', async t => {
  const f = fixture(t); f.lease.policy.allowedTools = ['documents.read'];
  const policy = structuredClone(f.lease.policy), definition = structuredClone(f.write.definition);
  const opened = await f.open(), computers = generated(opened);
  assert.deepEqual(opened.tools.map(value => value.definition.id), ['documents.read']);
  assert.deepEqual(opened.writeTools!.map(value => value.definition), [definition]);
  assert.deepEqual(computers.map(value => [value.definition.id, value.definition.version, value.definition.effect]),
    [['desktop.ui.observe', '1', 'read'], ['desktop.ui.act', '1', 'write'], ['desktop.ui.continue', '1', 'write'], ['desktop.ui.verify', '1', 'read']]);
  assert.ok(computers.every(value => value.definition.resultValidation === 'artifact-proof-v1' && typeof value.validateResult === 'function'));
  assert.deepEqual(opened.policy, policy); assert.deepEqual(opened.effectReaders!.map(value => value.provider), ['changes']);
  for (const value of [opened.writeTools, opened.computerTools, opened.computerTools![0], opened.computerTools![0]!.driver])
    assert.equal(Object.isFrozen(value), true);
  f.write.definition.description = 'replacement'; f.computer.labels.push('secret'); f.computer.limits.maxSteps = 1;
  f.computer.driver.act = async () => { assert.fail('replacement_driver'); };
  assert.deepEqual(opened.writeTools![0]!.definition, definition);
  assert.deepEqual(opened.computerTools![0]!.labels, ['public']); assert.equal(opened.computerTools![0]!.limits.maxSteps, 3);
  assert.deepEqual(generated(opened).map(value => value.definition), computers.map(value => value.definition));
  noOperations(f); await Promise.all([opened.close(), opened.close()]); assert.equal(f.calls.closes, 1);
});

test('generated observe identity survives host and contract snapshots but copied tool objects remain unmarked', async t => {
  const f = fixture(t);
  const tools = createComputerTools(f.computer, () => { throw new Error('identity_check_must_not_run_computer'); });
  const snapshots = tools.map(snapshotTool), contracts = new ToolContracts(snapshots, f.assembly.schemas);
  for (const [index, tool] of tools.entries()) {
    const expected = tool.definition.id === 'desktop.ui.observe';
    assert.equal(isComputerObservationTool(tool), expected);
    assert.notEqual(snapshots[index], tool);
    assert.equal(isComputerObservationTool(snapshots[index]), expected);
    const registered = contracts.get(tool.definition.id, tool.definition.version)!.tool;
    assert.notEqual(registered, snapshots[index]); assert.equal(isComputerObservationTool(registered), expected);
  }
  const observe = tools.find(tool => tool.definition.id === 'desktop.ui.observe')!;
  Reflect.set(f.lease, 'tools', [observe]); Reflect.set(f.lease, 'computerTools', []);
  const opened = await f.open(), hosted = opened.tools[0]!;
  assert.notEqual(hosted, observe); assert.equal(isComputerObservationTool(hosted), true);
  const hostContracts = new ToolContracts([...opened.tools], f.assembly.schemas);
  assert.equal(isComputerObservationTool(hostContracts.get(observe.definition.id, observe.definition.version)!.tool), true);
  const copies: Tool[] = [
    { ...observe },
    Object.create(Object.getPrototypeOf(observe), Object.getOwnPropertyDescriptors(observe)) as Tool,
    { definition: structuredClone(observe.definition), execute: observe.execute, validateResult: observe.validateResult! },
  ];
  for (const copy of copies) {
    assert.deepEqual(copy.definition, observe.definition); assert.equal(copy.validateResult, observe.validateResult);
    assert.equal(isComputerObservationTool(copy), false); assert.equal(isComputerObservationTool(snapshotTool(copy)), false);
    const copiedContracts = new ToolContracts([copy], f.assembly.schemas);
    assert.equal(isComputerObservationTool(copiedContracts.get(copy.definition.id, copy.definition.version)!.tool), false);
  }
  noOperations(f); await opened.close(); assert.equal(f.calls.closes, 1);
});

test('explicit writes require a matching recoverable effect reader and artifact proof validation', async t => {
  const variants: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { Reflect.deleteProperty(f.lease, 'effectReaders'); },
    f => { Reflect.set(f.lease, 'effectReaders', [{ provider: 'other', reader: f.reader }]); },
    f => { Reflect.deleteProperty(f.reader, 'recover'); },
    f => { f.write.definition.effect = 'read'; },
    f => { Reflect.deleteProperty(f.write.definition, 'resultValidation'); },
    f => { Reflect.deleteProperty(f.write, 'validateResult'); },
  ];
  for (const change of variants) {
    const f = fixture(t); change(f);
    await assert.rejects(f.open(), /agent_tool_registration_invalid/);
    assert.equal(f.calls.closes, 1); noOperations(f);
  }
});

test('generated computer identities share the read and write collision boundary', async t => {
  const variants: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.read.definition.provider = 'changes'; f.read.definition.id = f.write.definition.id; },
    f => { f.read.definition.provider = 'desktop'; f.read.definition.id = 'desktop.ui.observe'; },
    f => { f.write.definition.provider = 'desktop'; f.write.definition.id = 'desktop.ui.act';
      Reflect.set(f.lease, 'effectReaders', [{ provider: 'desktop', reader: f.reader }]); },
  ];
  for (const change of variants) {
    const f = fixture(t); change(f);
    ToolDefinitionSchema.parse(f.read.definition); ToolDefinitionSchema.parse(f.write.definition);
    await assert.rejects(f.open(), /agent_tool_registration_invalid/);
    assert.equal(f.calls.closes, 1); noOperations(f);
  }
  const differentVersion = fixture(t);
  differentVersion.write.definition.provider = 'desktop';
  differentVersion.write.definition.id = 'desktop.ui.act'; differentVersion.write.definition.version = '2';
  Reflect.set(differentVersion.lease, 'effectReaders', [{ provider: 'desktop', reader: differentVersion.reader }]);
  const opened = await differentVersion.open();
  const contracts = new ToolContracts([...opened.tools, ...opened.writeTools!, ...generated(opened)], differentVersion.assembly.schemas);
  assert.ok(contracts.get('desktop.ui.act', '1')); assert.ok(contracts.get('desktop.ui.act', '2')); noOperations(differentVersion);
});

test('dynamic providers cannot take ownership of a static read, write or computer provider', async t => {
  for (const provider of ['documents', 'changes', 'desktop']) {
    const f = fixture(t);
    Reflect.set(f.lease, 'providerSources', [{ provider, source: f.source() }]);
    await assert.rejects(f.open(), /agent_tool_registration_invalid/);
    assert.equal(f.calls.closes, 1); assert.equal(f.calls.listings, 0); noOperations(f);
  }
});

test('host computer aliases cannot duplicate a driver session or impersonate core tools', async t => {
  const variants: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { Reflect.set(f.lease, 'computerTools', [f.computer, { ...f.computer, id: 'desktop.alias' }]); },
    f => { Reflect.set(f.lease, 'computerTools', [f.computer, { ...f.computer, id: 'desktop.alias', driver: { ...f.driver } }]); },
    f => { Reflect.set(f.lease, 'computerTools', [f.computer, { ...f.computer, sessionId: 'different-session' }]); },
    f => { f.computer.provider = 'core'; },
    f => { f.computer.id = 'core.computer'; },
  ];
  for (const change of variants) {
    const f = fixture(t); change(f);
    await assert.rejects(f.open(), /agent_tool_registration_invalid/);
    assert.equal(f.calls.closes, 1); noOperations(f);
  }
});

test('a registered computer remains read-only until both write permission and the exact act tool are allowed', async t => {
  const f = fixture(t), opened = await f.open(), computers = generated(opened);
  const contracts = new ToolContracts([...opened.tools, ...opened.writeTools!, ...computers], f.assembly.schemas);
  for (const tool of computers)
    assert.equal(contracts.checkExecution(task(tool), opened.policy), tool.definition.effect === 'write' ? 'tool_permission_denied' : null);
  assert.equal(contracts.checkExecution(task(opened.writeTools![0]!), opened.policy), 'tool_permission_denied');
  assert.deepEqual(contracts.callable(opened.policy).map(value => value.id), ['documents.read', 'desktop.ui.observe', 'desktop.ui.verify']);
  const act = computers.find(value => value.definition.id === 'desktop.ui.act')!;
  const allowed = { ...opened.policy, allowWrites: true };
  assert.equal(contracts.checkExecution(task(act), allowed), null);
  assert.equal(contracts.checkExecution(task(act), { ...allowed, allowedTools: allowed.allowedTools.filter(id => id !== act.definition.id) }), 'tool_permission_denied');
  assert.equal(contracts.checkExecution(task(act), { ...allowed, allowedLabels: [] }), 'tool_permission_denied');
  assert.equal(contracts.checkExecution(task(act), { ...allowed, allowedDestinations: [] }), 'tool_permission_denied');
  assert.equal(opened.policy.allowWrites, false); noOperations(f);
});

test('provider writes require an explicit declaration and matching effect reader before listing can publish', async t => {
  const missingReader = fixture(t);
  Reflect.set(missingReader.lease, 'writeTools', []); Reflect.set(missingReader.lease, 'effectReaders', []);
  Reflect.set(missingReader.lease, 'providerSources', [{ provider: 'changes', source: missingReader.source(), allowWrites: true }]);
  await assert.rejects(missingReader.open(), /agent_tool_registration_invalid/);
  assert.equal(missingReader.calls.closes, 1); assert.equal(missingReader.calls.listings, 0); noOperations(missingReader);
  for (const declaration of [undefined, false]) {
    const f = fixture(t); Reflect.set(f.lease, 'writeTools', []);
    Reflect.set(f.lease, 'providerSources', [{ provider: 'changes', source: f.source(), ...(declaration === undefined ? {} : { allowWrites: declaration }) }]);
    const opened = await f.open(), provider = opened.providerSources![0]!, contracts = new ToolContracts([], f.assembly.schemas);
    await assert.rejects(refreshProviderTools(contracts, provider.provider, provider.source, { signal: f.assembly.signal }), /provider_listing_failed/);
    assert.equal(contracts.get('changes.apply', '1'), undefined); assert.equal(f.calls.listings, 1); noOperations(f);
  }
});

test('explicit provider write discovery keeps proof callbacks and still respects the current read-only policy', async t => {
  const f = fixture(t); Reflect.set(f.lease, 'writeTools', []);
  Reflect.set(f.lease, 'providerSources', [{ provider: 'changes', source: f.source(), allowWrites: true }]);
  const expected = structuredClone(f.write.definition), opened = await f.open(), provider = opened.providerSources![0]!;
  const contracts = new ToolContracts([], f.assembly.schemas);
  const snapshot = await refreshProviderTools(contracts, provider.provider, provider.source, { signal: f.assembly.signal });
  assert.equal(snapshot.toolCount, 1); assert.equal(provider.allowWrites, true);
  const registered = contracts.get('changes.apply', '1')!.tool;
  assert.deepEqual(registered.definition, expected); assert.equal(typeof registered.validateResult, 'function');
  assert.equal(contracts.checkExecution(task(registered), opened.policy), 'tool_permission_denied');
  assert.equal(contracts.checkExecution(task(registered), { ...opened.policy, allowWrites: true }), null);
  assert.equal(f.calls.listings, 1); noOperations(f);
});
