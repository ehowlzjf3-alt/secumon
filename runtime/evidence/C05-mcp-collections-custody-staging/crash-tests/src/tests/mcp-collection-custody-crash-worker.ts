import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArtifactRef, TaskSpec, WorkState } from '../domain/model.js';
import type { ReadCollectionBinding } from '../application/ports.js';
import type { RuntimeServices } from '../application/services.js';
import { ArtifactSchema } from '../application/contracts.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { ToolBroker } from '../application/tool-broker.js';
import { ReadCheckpointReader } from '../application/read-checkpoint-store.js';
import { transact } from '../application/work-transactions.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { createMcpReadCollection, createMcpStoredReadCollection } from '../infrastructure/mcp-read-collections.js';
import { McpStdioClient } from '../infrastructure/mcp-stdio-client.js';
import { collectionBinding } from './helpers/mcp-collection-binding.js';
import { MCPC_PROTOCOL } from './helpers/mcp-collection-fixture-contracts.js';
import { command, initial } from './state-conformance-helpers.js';
import { collectionCrashAudit, type CollectionCrashObservation } from './mcp-collection-custody-crash-fixture.js';

const workId = 'collection-custody-crash-work', endpointId = 'collection-custody-crash-local';
async function main() {
  const [base, backend, stage, mode, selectedAttempt] = process.argv.slice(2);
  assert.ok(base && process.send); assert.ok(backend === 'sqlite' || backend === 'file-journal');
  assert.ok(stage === 'raw' || stage === 'response' || stage === 'usage'); assert.ok(mode === 'crash' || mode === 'recover');
  const watchdog = setTimeout(() => { console.error('collection_custody_worker_deadline'); process.exit(124); }, 30000);
  const engine = join(base, 'engine'), directory = join(base, 'agent'), auditFile = join(base, 'peer.jsonl');
  if (mode === 'crash') mkdirSync(engine, { mode: 0o700 });
  const profiles = new FileAgentProfileStore(engine);
  if (mode === 'crash') {
    const ready = profiles.initialize(directory);
    writeFileSync(join(ready.root, 'config.json'), JSON.stringify({ ...ready.config,
      storage: { ...ready.config.storage, state: backend } }), { mode: 0o600 });
  }
  const stores = await openAgentStores(profiles, directory), schemas = new AjvSchemas();
  const counters: CollectionCrashObservation['counters'] = { calls: 0, discoveries: 0, captures: 0, fetches: 0,
    projections: 0, manifests: 0, rawPuts: 0, accountingReads: [] };
  let now = mode === 'crash' ? 1000 : 10000, attemptId = selectedAttempt ?? '';
  const services: RuntimeServices = { state: stores.state, artifacts: stores.artifacts, clock: { now: () => now },
    ids: new RandomIds(), digester: new Sha256Digester(), tools: [], sink: new FakeSink(), planner: new ScriptedPlanner([]) };
  const put = services.artifacts.put.bind(services.artifacts), get = services.artifacts.get.bind(services.artifacts), commit = services.state.commit.bind(services.state);
  let raw: CollectionCrashObservation['raw'] = null, client: McpStdioClient | undefined;
  let composed: Awaited<ReturnType<typeof composeRuntime>> | undefined;
  const state = async () => { const value = await services.state.get(workId); assert.ok(value); return value; };
  async function observe(kind: CollectionCrashObservation['kind'], before: WorkState | null = null,
    returned: WorkState | null = null): Promise<CollectionCrashObservation> {
    const current = await state(), attempt = current.attempts.find(value => value.id === attemptId); assert.ok(attempt?.readProgress);
    const dispatch = await services.state.receipt(workId, `dispatch:${attemptId}`); assert.ok(dispatch);
    const task = dispatch.state.plan!.tasks.find(value => value.id === attempt.taskId); assert.ok(task);
    const ref = attempt.readProgress.head, intentId = `read:${attemptId}:${ref.id}`;
    const intent = await services.state.receipt(workId, intentId); assert.ok(intent);
    const checkpoint = await new ReadCheckpointReader(intent.state, services.artifacts, services.digester).load(ref);
    assert.equal(checkpoint.calls.length, 1); const call = checkpoint.calls[0]!;
    assert.equal(call.status, 'intent'); assert.equal(call.response, null); assert.equal(call.attemptId, attemptId);
    const responseCommandId = `mcp-page:${attemptId}:${call.request.requestId}`;
    const events = await services.state.events(workId, 0);
    const commandIds = new Set([...events.map(event => event.commandId), responseCommandId, `receive:${attemptId}`, `adopt:${attemptId}`]);
    const receipts = Object.fromEntries(await Promise.all([...commandIds].map(async id => [id, await services.state.receipt(workId, id)])));
    return { kind, stage, backend, pid: process.pid, peerPid: mode === 'crash' ? collectionCrashAudit(base!).find(row => row.event === 'start')?.pid ?? null : null,
      agentId: stores.profile.identity.agentId, workId, attemptId, runtimeOwner: composed!.runtime.owner,
      state: current, before, returned, task, head: { ref, text: Buffer.from(await get(ref, dispatch.state.policy)).toString('utf8'), checkpoint },
      raw, responseCommandId, receipts, events, counters: structuredClone(counters) };
  }
  async function send(value: CollectionCrashObservation) {
    assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 1048576);
    await new Promise<void>((resolve, reject) => process.send!(value, error => error ? reject(error) : resolve()));
  }
  let checkpointSent = false;
  async function checkpoint(): Promise<never> {
    assert.equal(checkpointSent, false); checkpointSent = true;
    // Match the actual server response audit, not a timing assumption about another process's append.
    const until = performance.now() + 3000;
    while (!collectionCrashAudit(base!).some(row => row.event === 'response-sent')) {
      if (performance.now() >= until) throw new Error('collection_custody_response_audit_timeout');
      await new Promise<void>(resolve => setTimeout(resolve, 20));
    }
    await send(await observe('checkpoint'));
    return new Promise<never>(() => {}); // Parent SIGKILL; watchdog also bounds this suspension.
  }
  try {
    const baseBinding = collectionBinding('documents', { maxCalls: 1 });
    const binding = { ...baseBinding, manifest(task: TaskSpec) { counters.manifests++; return baseBinding.manifest(task); },
      project(...args: Parameters<typeof baseBinding.project>) { counters.projections++; return baseBinding.project(...args); } };
    let source: ReadCollectionBinding;
    if (mode === 'crash') {
      client = new McpStdioClient({ endpointId, command: process.execPath,
        args: [fileURLToPath(new URL('./helpers/mcp-collection-fixture-server.js', import.meta.url)), '--audit-file', auditFile, '--mode', 'normal', '--delay-ms', '100'],
        cwd: fileURLToPath(new URL('../../', import.meta.url)), env: { TMPDIR: tmpdir(), TMP: tmpdir(), TEMP: tmpdir() }, timeoutMs: 5000 });
      counters.discoveries++; const session = await client.discover([binding.remote], new AbortController().signal), realClient = client;
      source = createMcpReadCollection(binding, session, { async call(selected, name, input, context) {
        counters.calls++; assert.ok(context.capture);
        const capture = context.capture;
        const reply = await realClient.call(selected, name, input, { ...context, capture: {
          now: capture.now.bind(capture), decoded(value): undefined { counters.captures++; capture.decoded(value); return undefined; } } });
        now = 1100;
        await composed!.runtime.command(workId, 'cancel-after-decoded', { tenantId: 'tenant-a', principalId: 'person-a' }, 1,
          { kind: 'cancel', reason: 'stop after actual collection SDK reply' });
        await transact(services, workId, 'narrow-after-decoded', 'fixture_policy_narrowed', {}, next => { next.policy.allowedLabels = []; });
        return reply;
      } }, services, schemas);
    } else source = createMcpStoredReadCollection(binding, { endpointId, protocolVersion: MCPC_PROTOCOL }, services, schemas);
    const originalFetch = source.source.fetch;
    source = { ...source, source: { ...source.source, async fetch(...args: Parameters<typeof originalFetch>) {
      counters.fetches++; if (mode === 'recover') assert.fail('stored-only accounting must not fetch'); return originalFetch(...args);
    } } };
    composed = await composeRuntime({ services, schemas, owner: mode === 'crash' ? 'original-collection-worker' : `accountant-${process.pid}`,
      leaseMs: 5000, enablePlanning: false, collectionTools: [source],
      guidanceSource: { list: async () => [], read: async () => { throw new Error('unused'); } } });
    if (mode === 'crash') {
      services.artifacts.put = async (...args) => {
        const ref = await put(...args), text = Buffer.from(args[0]).toString('utf8');
        let value: { kind?: string } | undefined;
        try { value = JSON.parse(text) as typeof value; } catch { /* Only the original collection raw is a barrier. */ }
        if (value?.kind === 'mcp_collection_response') { raw = { ref, text }; counters.rawPuts++; if (stage === 'raw') await checkpoint(); }
        return ref;
      };
      services.state.commit = async request => {
        const result = await commit(request);
        if (result.kind === 'committed' && (stage === 'response' && request.commandId.startsWith(`mcp-page:${attemptId}:`) ||
          stage === 'usage' && request.commandId.startsWith(`tool-usage:${attemptId}:`))) await checkpoint();
        return result;
      };
      const work = initial(workId); work.policy.allowedTools = [source.definition.id]; work.budget.limits.toolCalls = 1;
      assert.equal((await services.state.commit(command(work, 'accept'))).kind, 'committed');
      const task: TaskSpec = { id: 'collect', description: 'One original collection page', toolId: source.definition.id,
        toolVersion: source.definition.version, input: { ids: ['a', 'b'] }, effect: 'read', dependsOn: [], satisfies: [], maxAttempts: 1 };
      await composed.runtime.submitPlan(workId, 'plan', { baseStateRevision: work.revision, baseGoalRevision: 1,
        basePlanRevision: 0, reason: 'Original collection custody crash', tasks: [task], hypotheses: [] });
      const attempt = await composed.runtime.reserve(workId, task.id); attemptId = attempt.id;
      assert.equal(await composed.runtime.dispatch(workId, attemptId), true);
      await assert.rejects(new ToolBroker(services.state, composed.contracts, services.digester, services.clock,
        undefined, undefined, undefined, services, composed.readCollections)
        .invoke(workId, attemptId, composed.runtime.owner, new AbortController().signal), /read_interrupted|broker_execution_not_current/);
      now = attempt.leaseUntil + 1; await composed.runtime.recordStoredUsage(workId, attemptId);
      assert.fail('collection custody crash checkpoint not reached');
    } else {
      assert.ok(attemptId); const before = await state();
      const callbackBaseline = { manifests: counters.manifests, projections: counters.projections };
      const dispatch = await services.state.receipt(workId, `dispatch:${attemptId}`); assert.ok(dispatch);
      assert.equal(source.availability, 'stored_only');
      assert.ok(composed.contracts.visible(dispatch.state.policy).some(value => value.id === source.definition.id));
      assert.equal(composed.contracts.callable(dispatch.state.policy).some(value => value.id === source.definition.id), false);
      services.artifacts.get = async (ref, policy) => {
        assert.ok(counters.accountingReads.length < 10000); counters.accountingReads.push(ref.id); return get(ref, policy);
      };
      const returned = await composed.runtime.recordStoredUsage(workId, attemptId); assert.ok(returned);
      const once = await state(), events = await services.state.events(workId, 0);
      assert.deepEqual(await composed.runtime.recordStoredUsage(workId, attemptId), returned);
      const pass = await composed.runtime.reconcileStoredUsages(workId, next => {
        assert.equal(next.id, before.id); assert.equal(next.createdAt, before.createdAt);
        assert.equal(next.policy.tenantId, before.policy.tenantId); assert.equal(next.policy.principalId, before.policy.principalId);
      });
      assert.deepEqual(pass.changed, []); assert.deepEqual(await state(), once); assert.deepEqual(await services.state.events(workId, 0), events);
      services.artifacts.get = get;
      assert.equal(counters.manifests, callbackBaseline.manifests); assert.equal(counters.projections, callbackBaseline.projections);
      const response = events.find(event => event.type === 'mcp_collection_response_recorded');
      if (response) {
        const payload = response.data['payload']; assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload));
        const ref: ArtifactRef = ArtifactSchema.parse(payload['artifact']);
        const receipt = await services.state.receipt(workId, response.commandId); assert.ok(receipt);
        assert.equal(receipt.digest, services.digester.digest({ type: response.type, data: payload }));
        const dispatch = await services.state.receipt(workId, `dispatch:${attemptId}`); assert.ok(dispatch);
        raw = { ref, text: Buffer.from(await get(ref, dispatch.state.policy)).toString('utf8') };
        await assert.rejects(get(ref, once.policy), /artifact_access_denied/);
      }
      await composed.runtime.finishClose(); await stores.close();
      const reopened = await openAgentStores(profiles, directory);
      try {
        assert.deepEqual(await reopened.state.get(workId), once); services.state = reopened.state;
        assert.deepEqual(await reopened.state.events(workId, 0), events);
        await send(await observe('recovered', before, returned));
      } finally { await reopened.close(); }
    }
  } finally {
    services.artifacts.put = put; services.artifacts.get = get; stores.state.commit = commit;
    try { await client?.close(); }
    finally { try { await stores.close(); } finally { clearTimeout(watchdog); if (process.connected) process.disconnect(); } }
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
