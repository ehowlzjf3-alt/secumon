import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArtifactRef, Json, TaskSpec, WorkState } from '../domain/model.js';
import type { ReadRequest } from '../domain/read-collection.js';
import type { ReadCollectionBinding, ReadUsageRestoreInput } from '../application/ports.js';
import type { RuntimeServices } from '../application/services.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { ToolBroker } from '../application/tool-broker.js';
import { asJson } from '../application/plan-validator.js';
import { transact } from '../application/work-transactions.js';
import { ReadCheckpointReader } from '../application/read-checkpoint-store.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { createMcpReadCollection, createMcpStoredReadCollection } from '../infrastructure/mcp-read-collections.js';
import { McpCallError, McpStdioClient, type McpDecodedResponse, type McpSession } from '../infrastructure/mcp-stdio-client.js';
import { collectionBinding, type CollectionFamily } from './helpers/mcp-collection-binding.js';
import { collectionFixturePage, parseCollectionFixtureArguments, MCPC_PROTOCOL,
  type McpCollectionAudit, type McpCollectionName } from './helpers/mcp-collection-fixture-contracts.js';
import { command, initial, openRepository, type Adapter } from './state-conformance-helpers.js';

export type CollectionCustodyCallMode = 'returned' | 'returned-without-capture' | 'captured-failure' |
  'sent-false' | 'sent-true' | 'arbitrary-error';
export interface CollectionCustodyRequest {
  workId: string;
  input: ReadUsageRestoreInput;
  intentHead: ArtifactRef;
  originalPolicy: WorkState['policy'];
  raw?: ArtifactRef;
  capture?: McpDecodedResponse;
  decodedValue?: Json;
  custody?: () => Promise<void>;
}
type Seam = (request: CollectionCustodyRequest) => Promise<void>;
export interface CollectionCustodyControls {
  callMode: CollectionCustodyCallMode;
  denyAuthorization: boolean;
  damageReceipt: 'dispatch' | 'intent' | null;
  afterCapture?: Seam | undefined;
  beforeRaw?: Seam | undefined;
  afterRaw?: Seam | undefined;
  beforeResponseCommit?: Seam | undefined;
  afterDecoded?: ((request: CollectionCustodyRequest) => undefined) | undefined;
}

/** Real repositories, collection wrapper, checkpoints and Broker. Fixed decoded transport unless explicitly stdio. */
export async function createMcpCollectionCustodyFixture(t: TestContext, backend: Adapter = 'sqlite', options: {
  family?: CollectionFamily;
  transport?: 'fixed-decoded' | 'stdio';
  legacyReceipt?: boolean;
  receiptMarker?: Json;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-collection-custody-'));
  let repository = openRepository(backend, directory), now = 1000, mutation = 0;
  let peer: McpStdioClient | undefined;
  const artifactDirectory = join(directory, 'artifacts'), auditFile = join(directory, 'audit.jsonl');
  t.after(async () => {
    const pid = peer?.snapshot().pid;
    try {
      await peer?.close();
      if (pid != null) assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
    } finally { try { await repository.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
  });
  const controls: CollectionCustodyControls = { callMode: 'returned', denyAuthorization: false, damageReceipt: null };
  const counters = { calls: 0, fetches: 0, captures: 0, projections: 0, manifests: 0, rawPuts: 0,
    responseCommits: 0, responseConflicts: 0 };
  const errors = { arbitrary: new Error('collection_fixture_arbitrary'),
    captured: new McpCallError('mcp_session_changed', true, { stage: 'post_response' }),
    unsent: new McpCallError('mcp_call_not_sent', false, { stage: 'request' }),
    sent: new McpCallError('mcp_call_failed', true, { stage: 'request' }) };
  const controller = new AbortController(), requests = new Map<string, CollectionCustodyRequest>(), clientErrors: unknown[] = [], sourceErrors: unknown[] = [];
  const services: RuntimeServices = { state: repository, artifacts: new FileArtifactStore(artifactDirectory), clock: { now: () => now },
    ids: new RandomIds(), digester: new Sha256Digester(), tools: [], sink: new FakeSink(), planner: new ScriptedPlanner([]) };
  const schemas = new AjvSchemas(), family = options.family ?? 'documents', base = collectionBinding(family);
  const host = { ...base, manifest(task: TaskSpec) { counters.manifests++; return base.manifest(task); },
    project(...args: Parameters<typeof base.project>) { counters.projections++; return base.project(...args); } };
  let session: McpSession = { endpointId: 'collection-custody-fixture', generation: 1,
    protocolVersion: MCPC_PROTOCOL, discoveryDigest: 'd'.repeat(64) };
  if (options.transport === 'stdio') {
    peer = new McpStdioClient({ endpointId: session.endpointId, command: process.execPath,
      args: [fileURLToPath(new URL('./helpers/mcp-collection-fixture-server.js', import.meta.url)), '--audit-file', auditFile, '--mode', 'normal'],
      cwd: directory, env: { TMPDIR: tmpdir() }, timeoutMs: 5000 });
    session = await peer.discover([host.remote], controller.signal);
  }
  const client: Pick<McpStdioClient, 'call'> = { async call(selected, name, input, context) {
    await context.authorize(); counters.calls++; now += 100;
    const args = parseCollectionFixtureArguments(input), request = requests.get(args.read.requestId);
    assert.ok(request); assert.deepEqual(args.query, request.input.task.input); assert.equal(name, host.remote.name);
    const observe = (value: McpDecodedResponse): undefined => {
      assert.ok(context.capture, 'collection adapter must install a request-local decoded capture');
      assert.equal(request.capture, undefined, 'each original request has exactly one capture');
      context.capture.decoded(value); request.capture = value; counters.captures++;
      controls.afterDecoded?.(request);
    };
    if (peer) {
      assert.ok(context.capture);
      try {
        const reply = await peer.call(selected, name, input, { ...context,
          capture: { now: context.capture.now.bind(context.capture), decoded: observe } });
        request.decodedValue = structuredClone(reply.value); await controls.afterCapture?.(request); return reply;
      } catch (error) { clientErrors.push(error); throw error; }
    }
    if (controls.callMode === 'sent-false') throw errors.unsent;
    if (controls.callMode === 'sent-true') throw errors.sent;
    if (controls.callMode === 'arbitrary-error') throw errors.arbitrary;
    const value = asJson({ content: [{ type: 'text', text: 'Fixed collection response' }],
      structuredContent: collectionFixturePage(name as McpCollectionName, args) });
    request.decodedValue = structuredClone(value);
    if (controls.callMode !== 'returned-without-capture') {
      assert.ok(context.capture); const json = JSON.stringify(value);
      observe(Object.freeze({ session: Object.freeze(structuredClone(selected)),
        requestDigest: services.digester.digest(asJson({ session: selected, name, input })), observedAt: context.capture.now(),
        json, byteLength: Buffer.byteLength(json), transportCalls: 1 }));
    }
    await controls.afterCapture?.(request);
    if (controls.callMode === 'captured-failure') throw errors.captured;
    return { session: selected, value, transportCalls: 1 };
  } };
  const installStoreHooks = () => {
    const put = services.artifacts.put.bind(services.artifacts), exists = services.artifacts.exists.bind(services.artifacts);
    const commit = services.state.commit.bind(services.state), receipt = services.state.receipt.bind(services.state);
    services.artifacts.put = async (bytes, attributes) => {
      let envelope: { kind?: string; request?: ReadRequest } | undefined;
      try { envelope = JSON.parse(new TextDecoder().decode(bytes)) as typeof envelope; } catch { /* Non-JSON artifacts use the real store unchanged. */ }
      const request = envelope?.kind === 'mcp_collection_response' ? requests.get(envelope.request!.requestId) : undefined;
      if (request) { const hook = controls.beforeRaw; controls.beforeRaw = undefined; await hook?.(request); }
      const ref = await put(bytes, attributes);
      if (request) {
        request.raw = ref; counters.rawPuts++;
        const hook = controls.afterRaw; controls.afterRaw = undefined; await hook?.(request);
      }
      return ref;
    };
    services.artifacts.exists = async ref => {
      const present = await exists(ref), request = [...requests.values()].find(value => value.raw?.id === ref.id);
      if (request && controls.beforeResponseCommit) {
        // Real commitWithArtifacts dependency read, before its actual custody/commit guard.
        const hook = controls.beforeResponseCommit; controls.beforeResponseCommit = undefined; await hook(request);
      }
      return present;
    };
    services.state.receipt = async (workId, commandId) => {
      const value = await receipt(workId, commandId);
      const selected = [...requests.values()].find(request => request.workId === workId &&
        commandId === (controls.damageReceipt === 'intent' ? `read:${request.input.attemptId}:${request.intentHead.id}` :
          controls.damageReceipt === 'dispatch' ? `dispatch:${request.input.attemptId}` : ''));
      return selected && value ? { ...value, digest: `${value.digest}:damaged` } : value;
    };
    services.state.commit = async request => {
      if (!request.commandId.startsWith('mcp-page:')) return commit(request);
      counters.responseCommits++;
      let selected = request;
      if (options.legacyReceipt || options.receiptMarker !== undefined) {
        const event = request.events.find(value => value.type === 'mcp_collection_response_recorded'); assert.ok(event);
        const data = structuredClone(event.data['payload']) as Record<string, Json>;
        if (options.legacyReceipt) delete data['custody']; else data['custody'] = options.receiptMarker!;
        selected = { ...request, commandDigest: services.digester.digest({ type: 'mcp_collection_response_recorded', data }),
          events: request.events.map(value => value === event ? { ...value, data: { payload: data } } : value) };
      }
      const result = await commit(selected); if (result.kind === 'conflict') counters.responseConflicts++; return result;
    };
  };
  installStoreHooks();
  const original = createMcpReadCollection(host, session, client, services, schemas);
  const source: ReadCollectionBinding = { ...original, source: { ...original.source, async fetch(task, request, context) {
    counters.fetches++;
    const state = await services.state.get(context.workId); assert.ok(state);
    const head = state.attempts.find(value => value.id === context.attemptId)?.readProgress?.head; assert.ok(head);
    const checkpoint = await new ReadCheckpointReader(state, services.artifacts, services.digester).load(head);
    const call = checkpoint.calls.at(-1); assert.ok(call); assert.deepEqual(call.request, request); assert.equal(call.status, 'intent');
    assert.ok(context.authorizeResponseCustody, 'real Broker and collection intent wrapper must issue custody');
    requests.set(request.requestId, { workId: context.workId, input: { attemptId: context.attemptId,
      task: structuredClone(task), request: structuredClone(request), dispatchedAt: call.dispatchedAt },
      intentHead: structuredClone(head), originalPolicy: structuredClone(context.policy), custody: context.authorizeResponseCustody });
    try { return await original.source.fetch(task, request, context); }
    catch (error) { sourceErrors.push(error); throw error; }
  } } };
  const composed = await composeRuntime({ services, schemas, owner: 'collection-custody-owner', leaseMs: 5000,
    enablePlanning: false, collectionTools: [source], guidanceSource: { list: async () => [], read: async () => { throw new Error('unused'); } } });
  const current = async (workId = 'work-1') => { const state = await services.state.get(workId); assert.ok(state); return state; };
  const mutate = async (edit: (state: WorkState) => void, workId = 'work-1') => {
    await transact(services, workId, `collection-custody-edit:${++mutation}`, 'fixture_state_changed', {}, edit);
  };
  const prepare = async (workId = 'work-1', ids = ['a', 'b', 'c', 'd']) => {
    const work = initial(workId); work.policy.allowedTools = [source.definition.id];
    assert.equal((await services.state.commit(command(work, 'accept'))).kind, 'committed');
    const task: TaskSpec = { id: 'collect', description: 'Read fixed collection records', toolId: source.definition.id,
      toolVersion: source.definition.version, input: { ids }, effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: [] };
    await composed.runtime.submitPlan(workId, 'plan', { baseStateRevision: work.revision, baseGoalRevision: work.goal.revision,
      basePlanRevision: 0, reason: 'Request-specific custody', tasks: [task], hypotheses: [] });
    const attempt = await composed.runtime.reserve(workId, task.id);
    assert.equal(await composed.runtime.dispatch(workId, attempt.id), true); return { workId, task, attempt };
  };
  const invoke = (attemptId: string, workId = 'work-1') => new ToolBroker(services.state, composed.contracts, services.digester,
    services.clock, async () => !controls.denyAuthorization, undefined, undefined, services, composed.readCollections)
    .invoke(workId, attemptId, composed.runtime.owner, controller.signal);
  const reader = () => createMcpStoredReadCollection(host,
    { endpointId: session.endpointId, protocolVersion: session.protocolVersion }, services, schemas);
  const response = (request: CollectionCustodyRequest) => services.state.receipt(request.workId,
    `mcp-page:${request.input.attemptId}:${request.input.request.requestId}`);
  const raw = async (request: CollectionCustodyRequest) => {
    assert.ok(request.raw); const bytes = await services.artifacts.get(request.raw, request.originalPolicy);
    return { bytes, envelope: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<string, unknown> };
  };
  const restore = async (request: CollectionCustodyRequest, input = request.input) => {
    const source = reader().source; assert.ok(source.restoreUsage);
    return source.restoreUsage(await current(request.workId), structuredClone(input));
  };
  const restoreResponse = async (request: CollectionCustodyRequest) => {
    const source = reader().source; assert.ok(source.restoreResponse);
    return source.restoreResponse(await current(request.workId), { attemptId: request.input.attemptId,
      task: request.input.task, request: request.input.request, intentHead: request.intentHead });
  };
  const checkpoint = async (workId = 'work-1') => {
    const state = await current(workId), head = state.attempts[0]!.readProgress!.head;
    return new ReadCheckpointReader(state, services.artifacts, services.digester).load(head);
  };
  return { directory, artifactDirectory, services, schemas, source, host, session, composed, controller, controls, counters, errors,
    requests, clientErrors, sourceErrors, prepare, invoke, current, mutate, response, raw, reader, restore, restoreResponse, checkpoint,
    setNow: (value: number) => { now = value; }, peer: () => peer,
    audit: async () => (await readFile(auditFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as McpCollectionAudit),
    reopen: async () => { await repository.close(); repository = openRepository(backend, directory);
      services.state = repository; services.artifacts = new FileArtifactStore(artifactDirectory); installStoreHooks(); } };
}
