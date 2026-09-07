import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Json, TaskSpec } from '../domain/model.js';
import type { RuntimeServices } from '../application/services.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { ToolBroker } from '../application/tool-broker.js';
import { ArtifactSchema } from '../application/contracts.js';
import { ReadResponseSchema } from '../application/read-collection-contracts.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { FakeClock, FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import type { McpReadBinding } from '../infrastructure/mcp-read-tools.js';
import { McpStdioClient, type McpStdioConfig } from '../infrastructure/mcp-stdio-client.js';
import { createMcpReadCollection } from '../infrastructure/mcp-read-collections.js';
import { createMcpHostTools, type McpHostToolsOptions } from '../presentation/mcp-host-tools.js';
import { openRegisteredHostTools, type HostToolAssembly, type HostToolRegistration, type OpenedHostTools } from '../presentation/host-tools.js';
import { collectionBinding } from './helpers/mcp-collection-binding.js';
import { waitCollectionBinding } from './helpers/mcp-wait-fixture-binding.js';
import { MCPC_OBSERVATIONS_TOOL, type McpCollectionAudit } from './helpers/mcp-collection-fixture-contracts.js';
import { command, initial, openRepository, type Adapter } from './state-conformance-helpers.js';

export function collectionPeerPlainBinding(): McpReadBinding {
  const remote = structuredClone(MCPC_OBSERVATIONS_TOOL);
  return { definition: { provider: 'fixture', id: 'fixture.observe', version: '1', description: 'Read a reviewed fixed observation page once',
    effect: 'read', destination: 'local', labels: ['synthetic'], inputSchema: remote.inputSchema,
    outputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false } },
    remote, projectorId: 'fixture-plain-page-count', projectorVersion: '1', project(value) {
      assert.ok(value && typeof value === 'object' && !Array.isArray(value));
      assert.ok(Array.isArray(value['records']));
      return { output: { count: value['records'].length }, coverage: 'complete', observations: [] };
    } };
}

/** Real SQLite/journal and original local stdio fixture; no decoded-client or model substitute is invoked. */
export async function collectionHostFixture(t: TestContext, backend: Adapter = 'sqlite', deferral = false) {
  const directory = await mkdtemp(join(tmpdir(), 'secumon-collection-host-')), auditPath = join(directory, 'audit.jsonl');
  let repository = openRepository(backend, directory);
  const leases: OpenedHostTools[] = [], clients: McpStdioClient[] = [];
  t.after(async () => {
    try {
      const results = await Promise.allSettled([...leases.map(lease => lease.close()), ...clients.map(client => client.close())]);
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : []);
      if (errors.length) throw new AggregateError(errors, 'fixture_close_failed');
    } finally { try { await repository.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
  });
  const services: RuntimeServices = { state: repository, artifacts: new FileArtifactStore(join(directory, 'artifacts')),
    clock: new FakeClock(1000), ids: new RandomIds(), digester: new Sha256Digester(), tools: [], sink: new FakeSink(), planner: new ScriptedPlanner([]) };
  const schemas = new AjvSchemas(), work = initial('collection-host-work');
  work.policy.allowedTools = ['fixture.collection', 'fixture.observe'];
  const context = { agentId: 'collection-host-agent', root: directory, scope: work.goal.scope };
  const config: McpStdioConfig = { endpointId: 'collection-host-fixture', command: process.execPath,
    args: [fileURLToPath(new URL(deferral ? './helpers/mcp-wait-fixture-server.js' : './helpers/mcp-collection-fixture-server.js', import.meta.url)),
      '--audit-file', auditPath, '--mode', deferral ? 'whole-rate-limit' : 'normal'],
    cwd: directory, env: { TMPDIR: tmpdir() }, timeoutMs: 5000 };
  const binding = deferral ? waitCollectionBinding('documents') : collectionBinding('documents');
  const options: McpHostToolsOptions = { config, bindings: [], collectionBindings: [binding],
    policy: structuredClone(work.policy), limits: structuredClone(work.budget.limits) };
  const assembly = (signal = new AbortController().signal): HostToolAssembly => ({ custody: services, schemas, signal });
  const audit = async (): Promise<McpCollectionAudit[]> => (await readFile(auditPath, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error;
  })).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as McpCollectionAudit);
  const open = async (registration: HostToolRegistration = createMcpHostTools(options), supplied = assembly()) => {
    const lease = await openRegisteredHostTools(registration, context, supplied); leases.push(lease); return lease;
  };
  const compose = async (lease: OpenedHostTools) => composeRuntime({ services: { ...services, tools: [...lease.tools] }, schemas,
    owner: 'collection-host-worker', enablePlanning: false, collectionTools: [...(lease.collectionTools ?? [])],
    guidanceSource: { list: async () => [], read: async () => { throw new Error('fixture_guidance_unused'); } } });
  const accept = async () => assert.equal((await repository.commit(command(work, 'accept'))).kind, 'committed');
  const task = (id: string, version: string, plain = false): TaskSpec => ({ id, description: 'Read fixed local records',
    toolId: plain ? 'fixture.observe' : binding.definition.id, toolVersion: version,
    input: plain ? { query: { ids: ['a', 'b'] }, read: { requestId: `plain:${id}`, cursor: null, snapshot: null, retryIds: null, itemLimit: 2 } }
      : { ids: ['a', 'b'] }, effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: [] });
  const invoke = async (core: Awaited<ReturnType<typeof compose>>, selected: TaskSpec) => {
    const before = await core.runtime.state(work.id);
    await core.runtime.submitPlan(work.id, `plan:${selected.id}`, { baseStateRevision: before.revision, baseGoalRevision: before.goal.revision,
      basePlanRevision: before.plan?.revision ?? 0, reason: 'Check host collection assembly with original local responses', tasks: [selected], hypotheses: [] });
    const attempt = await core.runtime.reserve(work.id, selected.id); await core.runtime.dispatch(work.id, attempt.id);
    const result = await new ToolBroker(repository, core.contracts, services.digester, services.clock)
      .invoke(work.id, attempt.id, core.runtime.owner, new AbortController().signal);
    return { attempt, task: selected, result };
  };
  const seed = async () => {
    const client = new McpStdioClient(config); clients.push(client);
    const session = await client.discover([binding.remote], new AbortController().signal);
    const collection = createMcpReadCollection(binding, session, client, services, schemas);
    const core = await compose({ tools: [], collectionTools: [collection], policy: work.policy, limits: work.budget.limits, close: async () => {} });
    await accept();
    const received = await invoke(core, task('original', collection.definition.version));
    const state = await core.runtime.state(work.id), attempt = state.attempts.find(value => value.id === received.attempt.id)!;
    const checkpoint = await core.readCheckpoints.read(state, attempt.id, attempt.readProgress!.head);
    const call = checkpoint.calls[0]!; assert.ok(call.response);
    const response = ReadResponseSchema.parse(JSON.parse(new TextDecoder().decode(await services.artifacts.get(call.response, state.policy))));
    const rawArtifact = response.rawArtifact!; assert.ok(rawArtifact);
    const bytes = await services.artifacts.get(rawArtifact, state.policy);
    const envelope = JSON.parse(new TextDecoder().decode(bytes)) as { intentHead: Json; session: unknown; schemaVersion: unknown; kind: unknown };
    const input = { attemptId: attempt.id, task: received.task, request: call.request, intentHead: ArtifactSchema.parse(envelope.intentHead) };
    const responseCommandId = `mcp-page:${attempt.id}:${call.request.requestId}`;
    const receipt = await repository.receipt(work.id, responseCommandId); assert.ok(receipt);
    await client.close(); const auditBefore = await audit();
    assert.equal(auditBefore.filter(row => row.event === 'start').length, 1);
    assert.equal(auditBefore.filter(row => row.event === 'call').length, 1);
    assert.equal(auditBefore.filter(row => row.event === 'close').length, 1);
    await repository.close(); repository = openRepository(backend, directory); services.state = repository;
    return { ...received, state, checkpoint, collection, client, session, input, response, rawArtifact, bytes, envelope, receipt, responseCommandId, auditBefore };
  };
  return { directory, auditPath, services, schemas, work, binding, config, context, options, assembly, open, compose, accept, task, invoke, seed, audit,
    current: async () => { const state = await repository.get(work.id); assert.ok(state); return state; } };
}
