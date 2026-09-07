import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TaskSpec } from '../domain/model.js';
import type { RuntimeServices } from '../application/services.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { ToolBroker } from '../application/tool-broker.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { refreshProviderTools } from '../application/provider-tool-snapshot.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { FakeClock, FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import type { McpReadBinding } from '../infrastructure/mcp-read-tools.js';
import { createMcpHostTools, type McpHostToolsOptions } from '../presentation/mcp-host-tools.js';
import { openRegisteredHostTools, type HostToolAssembly, type HostToolRegistration, type OpenedHostTools } from '../presentation/host-tools.js';
import { MCP_FIXTURE_TOOLS, type McpFixtureAudit, type McpFixtureMode } from './helpers/mcp-fixture-contracts.js';
import { command, initial, openRepository } from './state-conformance-helpers.js';

function binding(family = 0): McpReadBinding {
  const remote = structuredClone(MCP_FIXTURE_TOOLS[family]!);
  return { definition: { provider: 'fixture', id: family === 0 ? 'fixture.read' : 'fixture.observe', version: '1',
    description: 'Reviewed local MCP host fixture', effect: 'read', destination: 'local', labels: ['synthetic'],
    inputSchema: remote.inputSchema,
    outputSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false } },
  remote, projectorId: 'host-value', projectorVersion: '1', project(value, task) {
    // This receiver is the registration's captured binding, not the later-mutated caller object.
    assert.equal(this.projectorVersion, '1'); assert.equal(Object.isFrozen(this), true);
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.equal(value['id'], task.input['id']);
    assert.equal(value['source'], family === 0 ? 'doc-origin' : 'observation-origin');
    const coverage = value['complete'] === true ? 'complete' as const : 'partial' as const;
    return { output: { value: value['value']! }, coverage, observations: [{ sourceId: String(value['source']),
      lineageId: String(value['source']), locator: '/structuredContent/value', observedAt: 900, coverage,
      facts: { value: value['value'] as number } }] };
  } };
}

async function fixture(t: TestContext, mode: McpFixtureMode = 'normal') {
  const directory = await mkdtemp(join(tmpdir(), 'secumon-mcp-host-')), auditPath = join(directory, 'audit.jsonl');
  const state = openRepository('sqlite', directory), leases: OpenedHostTools[] = [];
  t.after(async () => {
    try {
      const results = await Promise.allSettled(leases.map(lease => lease.close()));
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    } finally { try { await state.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
    await assert.rejects(stat(directory), { code: 'ENOENT' });
  });
  const schemas = new AjvSchemas(), services: RuntimeServices = { state,
    artifacts: new FileArtifactStore(join(directory, 'artifacts')), clock: new FakeClock(1000), ids: new RandomIds(),
    digester: new Sha256Digester(), tools: [], sink: new FakeSink(), planner: new ScriptedPlanner([]) };
  const sample = initial(), context = { agentId: 'mcp-helper-agent', root: directory, scope: sample.goal.scope };
  const options: McpHostToolsOptions = { config: { endpointId: 'local-helper-fixture', command: process.execPath,
    args: [fileURLToPath(new URL('./helpers/mcp-fixture-server.js', import.meta.url)), '--audit-file', auditPath, '--mode', mode],
    cwd: process.cwd(), env: { TMPDIR: tmpdir(), TMP: tmpdir(), TEMP: tmpdir() }, timeoutMs: 5000 },
    bindings: [binding()], policy: structuredClone(sample.policy), limits: structuredClone(sample.budget.limits) };
  const assembly = (signal = new AbortController().signal): HostToolAssembly => ({ custody: services, schemas, signal });
  const audit = async (): Promise<McpFixtureAudit[]> => (await readFile(auditPath, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error;
  })).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const open = async (registration = createMcpHostTools(options), signal?: AbortSignal) => {
    const lease = await openRegisteredHostTools(registration, context, assembly(signal)); leases.push(lease); return lease;
  };
  const publish = async (lease: OpenedHostTools) => {
    const contracts = new ToolContracts([...lease.tools], schemas);
    assert.equal(lease.providerSources?.length, 1);
    const source = lease.providerSources![0]!;
    await refreshProviderTools(contracts, source.provider, source.source, { signal: new AbortController().signal, ...source.limits });
    return contracts;
  };
  let sequence = 0;
  const invoke = async (lease: OpenedHostTools, contracts: ToolContracts, toolId = 'fixture.read') => {
    const work = initial(`mcp-host-work-${++sequence}`); work.policy = structuredClone(lease.policy);
    work.goal.criteria[0] = { ...work.goal.criteria[0]!, key: 'value', equals: toolId === 'fixture.read' ? 30 : 1 };
    assert.equal((await state.commit(command(work, 'accept'))).kind, 'committed');
    const runtime = new ExecutionRuntime(services, contracts, 'mcp-host-worker');
    const tool = contracts.visible(work.policy).find(candidate => candidate.id === toolId)!;
    assert.ok(tool);
    const task: TaskSpec = { id: 'read', description: 'Use the host registered MCP source', toolId, toolVersion: tool.version,
      input: { id: 'good' }, effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: [] };
    await runtime.submitPlan(work.id, 'plan', { baseStateRevision: work.revision, baseGoalRevision: work.goal.revision,
      basePlanRevision: 0, reason: 'Check the composition seam', tasks: [task], hypotheses: [] });
    const attempt = await runtime.reserve(work.id, task.id); await runtime.dispatch(work.id, attempt.id);
    const result = await new ToolBroker(state, contracts, services.digester, services.clock).invoke(work.id, attempt.id,
      runtime.owner, new AbortController().signal);
    return { workId: work.id, attempt, result, runtime };
  };
  return { directory, auditPath, context, options, assembly, services, audit, open, publish, invoke };
}

test('MCP host registration rejects absent custody and a pre-aborted lifetime before peer discovery', async t => {
  const f = await fixture(t), registration = createMcpHostTools(f.options);
  await assert.rejects(registration.open(f.context), /mcp_host_assembly_required/);
  const aborted = new AbortController(), reason = new Error('profile_already_closed'); aborted.abort(reason);
  await assert.rejects(registration.open(f.context, f.assembly(aborted.signal)), error => error === reason);
  await assert.rejects(stat(f.auditPath), { code: 'ENOENT' });
});

test('MCP host registration rejects mixed providers, duplicate bindings and unsupported effects without starting a peer', async t => {
  const f = await fixture(t);
  const cases: ((options: McpHostToolsOptions) => McpHostToolsOptions)[] = [
    options => ({ ...options, bindings: [] }),
    options => ({ ...options, bindings: [binding(), binding()] }),
    options => { const other = binding(1); other.definition.provider = 'other'; other.definition.id = 'other.read'; return { ...options, bindings: [binding(), other] }; },
    options => { const other = binding(); other.definition.id = 'fixture.other'; return { ...options, bindings: [binding(), other] }; },
    options => { const selected = binding(); selected.definition.effect = 'write'; return { ...options, bindings: [selected] }; },
    options => { const selected = binding(); selected.definition.provider = 'core'; selected.definition.id = 'core.read'; return { ...options, bindings: [selected] }; },
    options => { const selected = binding(); selected.definition.reuse = { mode: 'ttl', maxAgeMs: 1000 }; return { ...options, bindings: [selected] }; },
    options => { const selected = binding(); selected.projectorVersion = ''; return { ...options, bindings: [selected] }; },
    options => { const selected = binding(); Reflect.set(selected, 'project', null); return { ...options, bindings: [selected] }; },
    options => { const selected = binding(); delete selected.remote.outputSchema; return { ...options, bindings: [selected] }; },
    options => ({ ...options, policy: { ...options.policy, allowWrites: true } }),
  ];
  for (const change of cases) assert.throws(() => createMcpHostTools(change(f.options)), /mcp_host_registration_invalid/);
  await assert.rejects(stat(f.auditPath), { code: 'ENOENT' });
});

test('MCP host captures config, policy and projector receiver while keeping real raw custody in the supplied store', { timeout: 15000 }, async t => {
  const f = await fixture(t), original = f.options.bindings[0]!, registration = createMcpHostTools(f.options);
  const expectedPolicy = structuredClone(f.options.policy), expectedLimits = structuredClone(f.options.limits);
  f.options.config.command = 'not-an-absolute-command'; f.options.config.args.length = 0;
  f.options.policy.allowedTools.length = 0; f.options.limits.toolCalls = 1;
  original.definition.description = 'changed'; original.remote.name = 'not-approved'; original.projectorVersion = 'mutated';
  original.project = () => { assert.fail('replacement_projector'); };
  const lease = await f.open(registration); assert.deepEqual(lease.tools, []);
  assert.deepEqual(lease.policy, expectedPolicy); assert.deepEqual(lease.limits, expectedLimits);
  const contracts = await f.publish(lease), received = await f.invoke(lease, contracts);
  assert.equal(received.result.status, 'success'); assert.deepEqual(received.result.output, { value: 30 });
  assert.equal(received.result.usage?.transportCalls, 1);
  const intent = await f.services.state.receipt(received.workId, `mcp-intent:${received.attempt.id}`);
  const response = await f.services.state.receipt(received.workId, `mcp-response:${received.attempt.id}`);
  assert.ok(intent); assert.ok(response);
  const ref = received.result.artifacts[0]!, raw = JSON.parse(new TextDecoder().decode(await f.services.artifacts.get(ref, lease.policy)));
  assert.equal(raw.kind, 'mcp_decoded_response'); assert.equal(raw.workId, received.workId);
  assert.equal(raw.value.structuredContent.source, 'doc-origin'); assert.equal(raw.value.structuredContent.value, 30);
  assert.equal(await contracts.validateResult(response.state, received.result), true);
  await received.runtime.receive(received.workId, received.attempt.id, received.result, 'invoked');
  const adopted = await received.runtime.adopt(received.workId, received.attempt.id);
  assert.equal(adopted.attempts[0]!.adopted, true); assert.equal(adopted.evidence[0]!.facts['value'], 30);
  const first = lease.close(), second = lease.close(); assert.equal(first, second); await first; await second; await lease.close();
  const audit = await f.audit(); assert.equal(audit.filter(row => row.event === 'call').length, 1);
  assert.equal(audit.filter(row => row.event === 'start').length, 1); assert.equal(audit.filter(row => row.event === 'close').length, 1);
});

test('opening one MCP registration twice creates independent client sessions and closing one preserves the other', { timeout: 20000 }, async t => {
  const f = await fixture(t), registration = createMcpHostTools(f.options);
  const first = await f.open(registration), firstContracts = await f.publish(first);
  const second = await f.open(registration), secondContracts = await f.publish(second);
  assert.equal((await f.invoke(first, firstContracts)).result.status, 'success');
  await first.close();
  assert.equal((await f.invoke(second, secondContracts)).result.status, 'success');
  await second.close();
  const audit = await f.audit(); assert.equal(audit.filter(row => row.event === 'start').length, 2);
  assert.equal(audit.filter(row => row.event === 'close').length, 2); assert.equal(audit.filter(row => row.event === 'call').length, 2);
});

test('multiple bindings in one provider share a single discovery and retain both executable contracts', { timeout: 15000 }, async t => {
  const f = await fixture(t), options = { ...f.options, bindings: [binding(), binding(1)],
    policy: { ...f.options.policy, allowedTools: ['fixture.read', 'fixture.observe'] } };
  const lease = await f.open(createMcpHostTools(options)), contracts = await f.publish(lease);
  assert.equal(contracts.visible(lease.policy).length, 2);
  assert.deepEqual((await f.invoke(lease, contracts)).result.output, { value: 30 });
  assert.deepEqual((await f.invoke(lease, contracts, 'fixture.observe')).result.output, { value: 1 });
  await lease.close();
  const audit = await f.audit(); assert.equal(audit.filter(row => row.event === 'method' && row.method === 'tools/list').length, 1);
  assert.equal(audit.filter(row => row.event === 'call').length, 2); assert.equal(audit.filter(row => row.event === 'start').length, 1);
});

test('MCP discovery does not add registered tools to host permissions', { timeout: 15000 }, async t => {
  const f = await fixture(t), registration = createMcpHostTools({ ...f.options, policy: { ...f.options.policy, allowedTools: [] } });
  const lease = await f.open(registration), contracts = await f.publish(lease);
  assert.deepEqual(lease.policy.allowedTools, []); assert.deepEqual(contracts.visible(lease.policy), []);
  await lease.close(); assert.equal((await f.audit()).filter(row => row.event === 'call').length, 0);
});

test('host lifetime cancellation prevents rediscovery and old registered tools from sending a new request', { timeout: 15000 }, async t => {
  const f = await fixture(t), controller = new AbortController(), lease = await f.open(undefined, controller.signal);
  const contracts = await f.publish(lease); controller.abort(new Error('host_lifetime_ended'));
  await assert.rejects(lease.providerSources![0]!.source.list({ cursor: null, signal: new AbortController().signal }));
  const received = await f.invoke(lease, contracts);
  assert.equal(received.result.status, 'error'); assert.equal(received.result.usage?.transportCalls, 0);
  assert.deepEqual(received.result.evidence, []); assert.deepEqual(received.result.artifacts, []);
  await lease.close(); assert.equal((await f.audit()).filter(row => row.event === 'call').length, 0);
});

test('a rejected remote manifest preserves the existing catalog and the acquired lease can close its actual peer', { timeout: 15000 }, async t => {
  const f = await fixture(t, 'schema'), lease = await f.open(), contracts = new ToolContracts([], f.assembly().schemas);
  const before = contracts.revision, selected = lease.providerSources![0]!;
  await assert.rejects(refreshProviderTools(contracts, selected.provider, selected.source, { signal: new AbortController().signal }), /provider_listing_failed/);
  assert.equal(contracts.revision, before); assert.deepEqual(contracts.visible(lease.policy), []);
  await lease.close(); const audit = await f.audit();
  assert.equal(audit.filter(row => row.event === 'start').length, 1); assert.equal(audit.filter(row => row.event === 'close').length, 1);
  assert.equal(audit.filter(row => row.event === 'call').length, 0);
});

test('transport config validation remains in the existing client and cannot start a peer for an invalid command', async t => {
  const f = await fixture(t); f.options.config.command = 'relative-command';
  const registration: HostToolRegistration = createMcpHostTools(f.options);
  await assert.rejects(registration.open(f.context, f.assembly()), /mcp_config_invalid/);
  await assert.rejects(stat(f.auditPath), { code: 'ENOENT' });
});
