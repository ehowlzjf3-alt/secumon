import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactRef, Json, TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import type { RuntimeServices } from '../application/services.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { ToolBroker } from '../application/tool-broker.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { asJson } from '../application/plan-validator.js';
import { transact } from '../application/work-transactions.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { createMcpReadTool, type McpReadBinding } from '../infrastructure/mcp-read-tools.js';
import { McpCallError, type McpSession, type McpStdioClient } from '../infrastructure/mcp-stdio-client.js';
import { MCP_FIXTURE_DOCUMENTS_TOOL, MCP_FIXTURE_PROTOCOL, fixtureRecord } from './helpers/mcp-fixture-contracts.js';
import { command, initial, type Adapter } from './state-conformance-helpers.js';

export type CustodyCallMode = 'returned' | 'captured-failure' | 'sent-false' | 'sent-true' | 'arbitrary-error';
export interface CustodyControls {
  callMode: CustodyCallMode;
  denyAuthorization: boolean;
  afterCapture?: (() => Promise<void>) | undefined;
  afterRaw?: (() => Promise<void>) | undefined;
  beforeResponseCommit?: (() => Promise<void>) | undefined;
}

/** Real C01 state, artifacts, transactions and broker; only the decoded SDK client is a fixed local substitute. */
export async function createMcpResponseCustodyFixture(t: TestContext, backend: Adapter = 'sqlite', options: { legacyReceipt?: boolean } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'secumon-mcp-response-custody-')));
  const engine = join(directory, 'engine'); mkdirSync(engine, { mode: 0o700 });
  const profiles = new FileAgentProfileStore(engine), profile = profiles.initialize(join(directory, 'agent'));
  writeFileSync(join(profile.root, 'config.json'), JSON.stringify({ ...profile.config,
    storage: { ...profile.config.storage, state: backend } }), { mode: 0o600 });
  let stores: Awaited<ReturnType<typeof openAgentStores>> | undefined;
  t.after(async () => { try { await stores?.close(); } finally { rmSync(directory, { recursive: true, force: true }); } });
  stores = await openAgentStores(profiles, profile.root);
  let now = 1000, mutation = 0, rawRef: ArtifactRef | undefined;
  const controls: CustodyControls = { callMode: 'returned', denyAuthorization: false };
  const counters = { calls: 0, discoveries: 0, projections: 0, captures: 0, rawPuts: 0, responseCommits: 0, responseConflicts: 0 };
  const errors = { arbitrary: new Error('fixture_arbitrary_client_error'),
    captured: new McpCallError('mcp_session_changed', true, { stage: 'post_response' }),
    unsent: new McpCallError('mcp_call_not_sent', false, { stage: 'request' }),
    sent: new McpCallError('mcp_call_failed', true, { stage: 'request' }) };
  const controller = new AbortController(), schemas = new AjvSchemas();
  const services: RuntimeServices = { state: stores.state, artifacts: stores.artifacts, clock: { now: () => now },
    ids: new RandomIds(), digester: new Sha256Digester(), tools: [], sink: new FakeSink(), planner: new ScriptedPlanner([]) };
  const session: McpSession = { endpointId: 'custody-fixture', generation: 1, protocolVersion: MCP_FIXTURE_PROTOCOL,
    discoveryDigest: 'd'.repeat(64) };
  const decodedValue: Json = { content: [{ type: 'text', text: 'fixed decoded response' }],
    structuredContent: { ...fixtureRecord('documents.read', 'good') } };
  const binding: McpReadBinding = { definition: { provider: 'fixture', id: 'fixture.read', version: '1',
    description: 'Fixed original response custody', effect: 'read', destination: 'local', labels: ['synthetic'],
    inputSchema: MCP_FIXTURE_DOCUMENTS_TOOL.inputSchema,
    outputSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false } },
    remote: structuredClone(MCP_FIXTURE_DOCUMENTS_TOOL), projectorId: 'custody-value', projectorVersion: '1', project(value) {
      counters.projections++; assert.ok(value && typeof value === 'object' && !Array.isArray(value));
      return { output: { value: value['value']! }, coverage: 'complete', observations: [{ sourceId: 'doc-origin', lineageId: 'doc-origin',
        locator: '/structuredContent/value', observedAt: 900, coverage: 'complete', facts: { value: value['value'] as number } }] };
    } };
  const client: Pick<McpStdioClient, 'discover' | 'call'> = {
    async discover() { counters.discoveries++; assert.fail('custody fixture does not discover a peer'); },
    async call(selected, name, input, context) {
      await context.authorize(); counters.calls++; now += 100;
      assert.equal(name, 'documents.read'); assert.deepEqual(input, { id: 'good' });
      if (controls.callMode === 'sent-false') throw errors.unsent;
      if (controls.callMode === 'sent-true') throw errors.sent;
      if (controls.callMode === 'arbitrary-error') throw errors.arbitrary;
      assert.ok(context.capture, 'the adapter must install the request-local capture');
      const json = JSON.stringify(decodedValue);
      context.capture.decoded(Object.freeze({ session: Object.freeze(structuredClone(selected)),
        requestDigest: services.digester.digest(asJson({ session: selected, name, input })),
        observedAt: context.capture.now(), json, byteLength: Buffer.byteLength(json), transportCalls: 1 }));
      counters.captures++; await controls.afterCapture?.();
      if (controls.callMode === 'captured-failure') throw errors.captured;
      return { session: selected, value: structuredClone(decodedValue), transportCalls: 1 };
    },
  };
  const installStoreHooks = () => {
    const put = services.artifacts.put.bind(services.artifacts), exists = services.artifacts.exists.bind(services.artifacts);
    const commit = services.state.commit.bind(services.state);
    services.artifacts.put = async (bytes, attributes) => {
      const ref = await put(bytes, attributes);
      let value: unknown; try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { return ref; }
      if (value && typeof value === 'object' && 'kind' in value && value.kind === 'mcp_decoded_response') {
        rawRef = ref; counters.rawPuts++; const hook = controls.afterRaw; controls.afterRaw = undefined; await hook?.();
      }
      return ref;
    };
    services.artifacts.exists = async ref => {
      const present = await exists(ref);
      if (rawRef?.id === ref.id && controls.beforeResponseCommit) {
        // commitWithArtifacts checks the new raw reference immediately before its actual beforeCommit custody check.
        const hook = controls.beforeResponseCommit; controls.beforeResponseCommit = undefined; await hook();
      }
      return present;
    };
    services.state.commit = async request => {
      if (!request.commandId.startsWith('mcp-response:')) return commit(request);
      counters.responseCommits++;
      let selected = request;
      if (options.legacyReceipt) {
        // Publish the historical signature into the actual repository, not a forged receipt read result.
        assert.ok(rawRef); const data = asJson({ attemptId: request.commandId.slice('mcp-response:'.length), artifact: rawRef });
        selected = { ...request, commandDigest: services.digester.digest({ type: 'mcp_response_recorded', data }),
          events: request.events.map(event => ({ ...event, data: { payload: data } })) };
      }
      const result = await commit(selected); if (result.kind === 'conflict') counters.responseConflicts++; return result;
    };
  };
  installStoreHooks();
  const tool = createMcpReadTool(binding, session, client, services, schemas), contracts = new ToolContracts([tool], schemas);
  services.tools = [tool];
  const runtime = new ExecutionRuntime(services, contracts, 'original-worker', 5000), work = initial();
  assert.equal((await services.state.commit(command(work, 'accept'))).kind, 'committed');
  const current = async () => { const value = await services.state.get(work.id); assert.ok(value); return value; };
  const mutate = async (edit: (state: WorkState) => void) => {
    await transact(services, work.id, `custody-fixture-change:${++mutation}`, 'fixture_state_changed', {}, edit);
  };
  const prepare = async (options: { dispatch?: boolean } = {}) => {
    const state = await current();
    const task: TaskSpec = { id: 'read', description: 'Read one fixed record', toolId: tool.definition.id, toolVersion: tool.definition.version,
      input: { id: 'good' }, effect: 'read', dependsOn: [], maxAttempts: 2, satisfies: [] };
    await runtime.submitPlan(work.id, 'plan', { baseStateRevision: state.revision, baseGoalRevision: state.goal.revision,
      basePlanRevision: 0, reason: 'Verify original response custody', tasks: [task], hypotheses: [] });
    const attempt = await runtime.reserve(work.id, task.id);
    if (options.dispatch !== false) await runtime.dispatch(work.id, attempt.id);
    return { task, attempt };
  };
  const invoke = (attemptId: string) => new ToolBroker(services.state, contracts, services.digester, services.clock,
    async () => !controls.denyAuthorization).invoke(work.id, attemptId, runtime.owner, controller.signal);
  const response = (attemptId: string) => services.state.receipt(work.id, `mcp-response:${attemptId}`);
  const raw = async (ref: ArtifactRef) => {
    const bytes = await services.artifacts.get(ref, work.policy);
    return { bytes, envelope: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<string, unknown> };
  };
  const reader = () => createMcpReadTool(binding, { ...session, generation: 9 }, {
    async discover() { counters.discoveries++; assert.fail('offline usage restoration must not discover'); },
    async call() { counters.calls++; assert.fail('offline usage restoration must not call'); },
  }, services, schemas);
  const reopen = async () => {
    await stores!.close(); stores = undefined; stores = await openAgentStores(profiles, profile.root);
    services.state = stores.state; services.artifacts = stores.artifacts; installStoreHooks();
  };
  const expectedBody = (attemptId: string, ref: ArtifactRef): ToolResult => ({ resultId: `mcp:${attemptId}`, attemptId,
    status: 'success', effectState: 'none', cursor: null,
    usage: { transportCalls: 1, internalOperations: null, imageBytes: null, waitMs: null }, coverage: 'complete', error: null,
    artifacts: [ref], output: { value: 30 }, evidence: [{ id: `mcp:${attemptId}:0`, tenantId: work.policy.tenantId, scope: work.goal.scope,
      sourceId: 'doc-origin', lineageId: 'doc-origin', locator: '/structuredContent/value', observedAt: 900, recordedAt: 1100,
      labels: ['synthetic'], coverage: 'complete', facts: { value: 30 }, artifact: ref, status: 'accepted', access: 'available',
      supersedes: [], derivedFrom: [] }] });
  return { directory, profile, services, schemas, tool, contracts, runtime, work, controller, controls, counters, errors,
    decodedValue, prepare, invoke, mutate, current, response, raw, reader, reopen, expectedBody,
    rawRef: () => rawRef, setNow: (value: number) => { now = value; } };
}

export type McpResponseCustodyFixture = Awaited<ReturnType<typeof createMcpResponseCustodyFixture>>;
