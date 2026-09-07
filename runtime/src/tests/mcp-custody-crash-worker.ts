import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArtifactRef, TaskSpec, WorkState } from '../domain/model.js';
import type { ArtifactStore, StateRepository, Tool } from '../application/ports.js';
import type { RuntimeServices } from '../application/services.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { ToolBroker } from '../application/tool-broker.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { transact } from '../application/work-transactions.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { createMcpReadTool, type McpReadBinding } from '../infrastructure/mcp-read-tools.js';
import { McpStdioClient, type McpSession } from '../infrastructure/mcp-stdio-client.js';
import { MCP_FIXTURE_DOCUMENTS_TOOL, MCP_FIXTURE_PROTOCOL } from './helpers/mcp-fixture-contracts.js';
import { command, initial } from './state-conformance-helpers.js';
import { readMcpAudit } from './mcp-agent-profile-helper.js';

export type CustodyCrashStage = 'raw' | 'response' | 'usage';
type Backend = 'sqlite' | 'file-journal';
type Receipt = Awaited<ReturnType<StateRepository['receipt']>>;
export interface CustodyCrashObservation {
  kind: 'checkpoint' | 'recovered'; stage: CustodyCrashStage; backend: Backend; pid: number; peerPid: number | null;
  agentId: string; workId: string; attemptId: string; runtimeOwner: string;
  state: WorkState; before: WorkState | null; returned: WorkState | null;
  receipts: Record<string, Receipt>; events: Awaited<ReturnType<StateRepository['events']>>;
  raw: { ref: ArtifactRef; text: string } | null;
  counters: { calls: number; discoveries: number; projections: number; executes: number; rawPuts: number; accountingRawReads: number };
}

const endpointId = 'custody-crash-local', workId = 'custody-crash-work';
function binding(counters: CustodyCrashObservation['counters']): McpReadBinding {
  return { definition: { provider: 'fixture', id: 'fixture.read', version: '1', description: 'Original MCP custody crash fixture',
    effect: 'read', destination: 'local', labels: ['synthetic'], inputSchema: MCP_FIXTURE_DOCUMENTS_TOOL.inputSchema,
    outputSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false } },
    remote: structuredClone(MCP_FIXTURE_DOCUMENTS_TOOL), projectorId: 'custody-crash-value', projectorVersion: '1',
    project() { counters.projections++; assert.fail('usage-only custody must never invoke the body projector'); } };
}

async function main() {
  const [base, selectedBackend, selectedStage, mode, selectedAttempt] = process.argv.slice(2);
  assert.ok(base && process.send); assert.ok(selectedBackend === 'sqlite' || selectedBackend === 'file-journal');
  assert.ok(selectedStage === 'raw' || selectedStage === 'response' || selectedStage === 'usage');
  assert.ok(mode === 'crash' || mode === 'recover');
  const backend = selectedBackend, stage = selectedStage;
  // All waits, including the deliberately suspended post-commit boundary, have a process deadline.
  const watchdog = setTimeout(() => { console.error('custody_crash_worker_deadline'); process.exit(124); }, 30000);
  const engine = join(base, 'engine'), directory = join(base, 'agent'), auditFile = join(base, 'peer.jsonl');
  const hostOptions = { identityRegistryDirectory: join(base, 'registry') };
  if (mode === 'crash') mkdirSync(engine, { mode: 0o700 });
  const profiles = new FileAgentProfileStore(engine);
  if (mode === 'crash') {
    const ready = profiles.initialize(directory);
    writeFileSync(join(ready.root, 'config.json'), JSON.stringify({ ...ready.config,
      storage: { ...ready.config.storage, state: backend } }), { mode: 0o600 });
  }
  const stores = await openAgentStores(profiles, directory, undefined, hostOptions), schemas = new AjvSchemas();
  const counters: CustodyCrashObservation['counters'] = { calls: 0, discoveries: 0, projections: 0, executes: 0, rawPuts: 0, accountingRawReads: 0 };
  let now = mode === 'crash' ? 1000 : 10000, attemptId = selectedAttempt ?? '';
  const services: RuntimeServices = { state: stores.state, artifacts: stores.artifacts, clock: { now: () => now },
    ids: new RandomIds(), digester: new Sha256Digester(), tools: [], sink: new FakeSink(), planner: new ScriptedPlanner([]) };
  let client: McpStdioClient | undefined, raw: CustodyCrashObservation['raw'] = null;
  let runtime!: ExecutionRuntime;
  const put = services.artifacts.put.bind(services.artifacts), commit = services.state.commit.bind(services.state);
  const get = services.artifacts.get.bind(services.artifacts);
  const readState = async () => { const state = await services.state.get(workId); assert.ok(state); return state; };
  async function observe(kind: CustodyCrashObservation['kind'], before: WorkState | null = null,
    returned: WorkState | null = null): Promise<CustodyCrashObservation> {
    const state = await readState(), events = await services.state.events(workId, 0);
    const commandIds = [`dispatch:${attemptId}`, `mcp-intent:${attemptId}`, `mcp-response:${attemptId}`,
      `receive:${attemptId}`, `adopt:${attemptId}`, 'cancel-after-decoded', 'narrow-after-decoded',
      ...events.filter(event => event.type === 'tool_execution_usage_recorded').map(event => event.commandId)];
    const receipts = Object.fromEntries(await Promise.all(commandIds.map(async id => [id, await services.state.receipt(workId, id)])));
    const peer = readMcpAudit(auditFile).find(row => row.event === 'start');
    return { kind, stage, backend, pid: process.pid, peerPid: peer?.pid ?? null,
      agentId: stores.profile.identity.agentId, workId, attemptId, runtimeOwner: runtime.owner,
      state, before, returned, receipts, events, raw, counters: { ...counters } };
  }
  async function send(value: CustodyCrashObservation) {
    await new Promise<void>((resolve, reject) => process.send!(value, error => error ? reject(error) : resolve()));
  }
  let checkpointSent = false;
  async function checkpoint(): Promise<never> {
    assert.equal(checkpointSent, false); checkpointSent = true;
    await send(await observe('checkpoint'));
    // The parent kills this exact PID only after receiving the committed snapshot.
    return new Promise<never>(() => {});
  }
  try {
    let session: McpSession;
    let transport: Pick<McpStdioClient, 'discover' | 'call'>;
    if (mode === 'crash') {
      client = new McpStdioClient({ endpointId, command: process.execPath,
        args: [fileURLToPath(new URL('./helpers/mcp-fixture-server.js', import.meta.url)), '--audit-file', auditFile, '--audit-process'],
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        env: { TMPDIR: tmpdir(), TMP: tmpdir(), TEMP: tmpdir() }, timeoutMs: 5000 });
      counters.discoveries++; session = await client.discover([MCP_FIXTURE_DOCUMENTS_TOOL], new AbortController().signal);
      const realClient = client;
      transport = { discover: realClient.discover.bind(realClient), async call(...args) {
        counters.calls++;
        // Forward the complete real request context, including decoded capture. No response bytes are substituted.
        const reply = await realClient.call(...args); now = 1100;
        await runtime.command(workId, 'cancel-after-decoded', { tenantId: 'tenant-a', principalId: 'person-a' }, 1,
          { kind: 'cancel', reason: 'explicit stop after the real SDK reply' });
        await transact(services, workId, 'narrow-after-decoded', 'fixture_policy_narrowed', {}, state => { state.policy.allowedLabels = []; });
        return reply;
      } };
    } else {
      assert.ok(attemptId);
      // A fresh reader uses the same binding, not the old connection or a directory scan.
      session = { endpointId, generation: 9, protocolVersion: MCP_FIXTURE_PROTOCOL, discoveryDigest: 'd'.repeat(64) };
      transport = { async discover() { counters.discoveries++; assert.fail('recovery must not discover a peer'); },
        async call() { counters.calls++; assert.fail('recovery must not send another request'); } };
    }
    const adapter = createMcpReadTool(binding(counters), session, transport, services, schemas);
    const tool: Tool = { ...adapter, async execute(task, context) { counters.executes++;
      if (mode === 'recover') assert.fail('recovery must not execute a tool');
      return adapter.execute(task, context);
    } };
    services.tools = [tool]; const contracts = new ToolContracts([tool], schemas);
    runtime = new ExecutionRuntime(services, contracts, mode === 'crash' ? 'original-custody-worker' : `recovery-worker-${process.pid}`, 5000);
    if (mode === 'crash') {
      services.artifacts.put = async (...args: Parameters<ArtifactStore['put']>) => {
        const ref = await put(...args), text = Buffer.from(args[0]).toString('utf8');
        let value: { kind?: string } | null = null;
        try { value = JSON.parse(text) as { kind?: string }; } catch { /* Other artifact kinds are not suspension points. */ }
        if (value?.kind === 'mcp_decoded_response') {
          raw = { ref, text }; counters.rawPuts++; if (stage === 'raw') await checkpoint();
        }
        return ref;
      };
      services.state.commit = async request => {
        const result = await commit(request);
        if ((result.kind === 'committed' || result.kind === 'duplicate') &&
          (stage === 'response' && request.commandId === `mcp-response:${attemptId}` ||
           stage === 'usage' && request.commandId.startsWith(`tool-usage:${attemptId}:`))) await checkpoint();
        return result;
      };
      const work = initial(workId); work.budget.limits.toolCalls = 1;
      assert.equal((await services.state.commit(command(work, 'accept'))).kind, 'committed');
      const task: TaskSpec = { id: 'read', toolId: tool.definition.id, toolVersion: tool.definition.version, description: 'One original MCP read',
        input: { id: 'good' }, dependsOn: [], satisfies: [], maxAttempts: 1, effect: 'read' };
      await runtime.submitPlan(workId, 'plan', { baseStateRevision: work.revision, baseGoalRevision: 1,
        basePlanRevision: 0, reason: 'Original response custody crash', tasks: [task], hypotheses: [] });
      const attempt = await runtime.reserve(workId, task.id); attemptId = attempt.id;
      assert.equal(await runtime.dispatch(workId, attemptId), true);
      const broker = new ToolBroker(services.state, contracts, services.digester, services.clock);
      await assert.rejects(broker.invoke(workId, attemptId, runtime.owner, new AbortController().signal), /broker_execution_not_current/);
      await runtime.recordStoredUsage(workId, attemptId);
      assert.fail('custody crash checkpoint was not reached');
    } else {
      const before = await readState();
      services.artifacts.get = async (...args) => { counters.accountingRawReads++; return get(...args); };
      const returned = await runtime.recordStoredUsage(workId, attemptId);
      const once = await readState(), events = await services.state.events(workId, 0);
      assert.deepEqual(await runtime.recordStoredUsage(workId, attemptId), returned);
      assert.deepEqual(await readState(), once); assert.deepEqual(await services.state.events(workId, 0), events);
      services.artifacts.get = get;
      const response = await services.state.receipt(workId, `mcp-response:${attemptId}`);
      if (response) {
        // This is an evidence read after accounting, using only the official response's exact reference.
        assert.equal(response.state.artifacts.length, 1); const ref = response.state.artifacts[0]!;
        const dispatch = await services.state.receipt(workId, `dispatch:${attemptId}`); assert.ok(dispatch);
        raw = { ref, text: Buffer.from(await get(ref, dispatch.state.policy)).toString('utf8') };
        await assert.rejects(get(ref, once.policy), /artifact_access_denied/);
      }
      await runtime.finishClose(); await stores.close();
      // Reopen once more in this new process to establish that the accounting receipt is durable.
      const reopened = await openAgentStores(profiles, directory, undefined, hostOptions);
      try {
        assert.deepEqual(await reopened.state.get(workId), once);
        services.state = reopened.state;
        await send(await observe('recovered', before, returned));
      } finally { await reopened.close(); }
    }
  } finally {
    services.artifacts.put = put; services.artifacts.get = get; stores.state.commit = commit;
    try { await client?.close(); }
    finally {
      try { await stores.close(); }
      finally { clearTimeout(watchdog); if (process.connected) process.disconnect(); }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
