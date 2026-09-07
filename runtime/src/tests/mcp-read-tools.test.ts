import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TaskSpec, ToolResult } from '../domain/model.js';
import type { RuntimeServices } from '../application/services.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { refreshProviderTools } from '../application/provider-tool-snapshot.js';
import { ToolBroker } from '../application/tool-broker.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { transact } from '../application/work-transactions.js';
import { asJson } from '../application/plan-validator.js';
import { evaluateCompletion } from '../domain/completion.js';
import { FakeClock, FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { Sha256Digester, RandomIds, sha256 } from '../infrastructure/digest.js';
import { evaluationCodePin } from '../infrastructure/local-evaluation.js';
import { McpStdioClient } from '../infrastructure/mcp-stdio-client.js';
import { createMcpProviderSource, createMcpReadTool, type McpReadBinding } from '../infrastructure/mcp-read-tools.js';
import { MCP_FIXTURE_TOOLS } from './helpers/mcp-fixture-contracts.js';
import { adapters, command, initial, openRepository, type Adapter } from './state-conformance-helpers.js';

const evidenceDirectory = process.env['SECUMON_MCP_EVIDENCE_DIR'];
const codeDigest = evidenceDirectory ? (await evaluationCodePin(process.cwd())).digest : null;
function gate() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function setup(t: TestContext, adapter: Adapter, family = 0, independentSources = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'secumon-mcp-read-')); let state = openRepository(adapter, directory);
  const client = new McpStdioClient({ endpointId: 'synthetic-mcp', command: process.execPath,
    args: [fileURLToPath(new URL('./helpers/mcp-fixture-server.js', import.meta.url)), '--audit-file', join(directory, 'audit.jsonl')],
    cwd: process.cwd(), env: { TMPDIR: tmpdir(), TMP: tmpdir(), TEMP: tmpdir() }, timeoutMs: 5000 });
  let ownedPid: number | null = null;
  t.after(async () => {
    await client.close(); await state.close();
    if (ownedPid !== null) assert.throws(() => process.kill(ownedPid!, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
    const audit = (await readFile(join(directory, 'audit.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    await rm(directory, { recursive: true, force: true }); await assert.rejects(stat(directory), { code: 'ENOENT' });
    if (evidenceDirectory) {
      await mkdir(evidenceDirectory, { recursive: true });
      await writeFile(join(evidenceDirectory, `${sha256(t.name).slice(0, 20)}-read.json`), JSON.stringify({ codeDigest, test: t.name, adapter, family,
        snapshot: client.snapshot(), audit, shutdown: { pid: ownedPid, ownedProcessStopped: true, temporaryFilesCleaned: true } }, null, 2) + '\n');
    }
  });
  const artifacts = new FileArtifactStore(join(directory, 'artifacts')); const schemas = new AjvSchemas();
  const services: RuntimeServices = { state, artifacts, clock: new FakeClock(1000), ids: new RandomIds(), digester: new Sha256Digester(),
    tools: [], sink: new FakeSink(), planner: new ScriptedPlanner([]) };
  const remote = structuredClone(MCP_FIXTURE_TOOLS[family]!);
  const binding: McpReadBinding = { definition: { provider: 'fixture', id: 'fixture.read', version: '1', description: 'Read reviewed synthetic records',
    effect: 'read', destination: 'local', labels: ['synthetic'], inputSchema: remote.inputSchema,
    outputSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false } },
    remote, projectorId: 'fixture-value', projectorVersion: '1', project(value, task) {
      assert.ok(value && typeof value === 'object' && !Array.isArray(value));
      assert.equal(value['id'], task.input['id']);
      assert.equal(value['source'], family === 0 ? 'doc-origin' : 'observation-origin');
      assert.equal(typeof value['value'], 'number'); assert.equal(value['observedAt'], 900);
      const coverage = value['complete'] === true ? 'complete' as const : 'partial' as const;
      return { output: { value: value['value']! }, coverage, observations: [{ sourceId: String(value['source']),
        lineageId: String(value['source']), locator: '/value/structuredContent', observedAt: 900, coverage, facts: { value: value['value'] as number } }] };
    } };
  const contracts = new ToolContracts([], schemas);
  const source = createMcpProviderSource([binding], client, services, schemas);
  const published = await refreshProviderTools(contracts, 'fixture', source, { signal: new AbortController().signal });
  ownedPid = client.snapshot().pid;
  assert.equal(published.toolCount, 1); assert.equal(published.pages, 1);
  const work = initial(); work.goal.criteria[0] = { ...work.goal.criteria[0]!, key: 'value', equals: family === 0 ? 30 : 1, minIndependentSources: independentSources };
  assert.equal((await state.commit(command(work, 'accept'))).kind, 'committed');
  const tool = contracts.visible(work.policy)[0]!;
  let runtime = new ExecutionRuntime(services, contracts, 'mcp-worker');
  const prepare = async (id = 'good', taskId = 'read') => {
    const current = (await state.get(work.id))!;
    const task: TaskSpec = { id: taskId, description: 'Read a synthetic source through MCP', toolId: tool.id, toolVersion: tool.version,
      input: { id }, effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: [] };
    await runtime.submitPlan(work.id, `plan:${taskId}`, { baseStateRevision: current.revision, baseGoalRevision: current.goal.revision,
      basePlanRevision: current.plan?.revision ?? 0, reason: 'Verify the MCP boundary', tasks: [task], hypotheses: [] });
    const attempt = await runtime.reserve(work.id, task.id); await runtime.dispatch(work.id, attempt.id);
    return { task, attempt };
  };
  const broker = () => new ToolBroker(services.state, contracts, services.digester, services.clock);
  const invoke = async (id = 'good', taskId = 'read') => {
    const prepared = await prepare(id, taskId);
    const result = await broker().invoke(work.id, prepared.attempt.id, runtime.owner, new AbortController().signal);
    return { ...prepared, result };
  };
  const adopt = async (result: ToolResult) => { await runtime.receive(work.id, result.attemptId, result, 'invoked'); return runtime.adopt(work.id, result.attemptId); };
  const reopen = async () => { await state.close(); state = openRepository(adapter, directory); services.state = state; runtime = new ExecutionRuntime(services, contracts, 'mcp-worker'); };
  return { directory, services, contracts, client, binding, tool, work, prepare, invoke, adopt, broker, reopen,
    state: () => state, runtime: () => runtime };
}

for (const adapter of adapters) {
  for (const family of [0, 1]) test(`${adapter}: MCP family ${family} stores an original, adopts facts and revalidates offline`, { timeout: 15000 }, async t => {
    const f = await setup(t, adapter, family); const { result } = await f.invoke();
    assert.equal(result.status, 'success'); assert.equal(result.evidence.length, 1);
    assert.deepEqual(result.usage, { transportCalls: 1, internalOperations: null, imageBytes: null, waitMs: null });
    assert.deepEqual(result.evidence[0]!.artifact, result.artifacts[0]);
    const state = await f.adopt(result); assert.equal(state.attempts[0]!.adopted, true);
    assert.equal(await f.contracts.validateResult(state, result), true);
    await f.client.close(); await f.reopen();
    assert.equal(await f.contracts.validateResult((await f.state().get(f.work.id))!, result), true);
    const raw = JSON.parse(new TextDecoder().decode(await f.services.artifacts.get(result.artifacts[0]!, state.policy)));
    assert.equal(raw.kind, 'mcp_decoded_response'); assert.equal(raw.value.structuredContent.value, family === 0 ? 30 : 1);
    assert.equal(raw.session.protocolVersion, '2026-07-28');
  });

  test(`${adapter}: MCP partial records do not satisfy complete coverage`, { timeout: 15000 }, async t => {
    const f = await setup(t, adapter); const { result } = await f.invoke('partial');
    assert.equal(result.status, 'partial'); assert.equal(result.coverage, 'partial');
    const state = await f.adopt(result);
    assert.equal(evaluateCompletion(state.goal, state.evidence, [], state.policy).complete, false);
  });

  for (const id of ['error', 'invalid']) test(`${adapter}: MCP ${id} retains no result evidence`, { timeout: 15000 }, async t => {
    const f = await setup(t, adapter); const { result } = await f.invoke(id);
    assert.equal(result.status, 'error'); assert.deepEqual(result.artifacts, []); assert.deepEqual(result.evidence, []);
    const state = (await f.state().get(f.work.id))!;
    assert.equal(state.artifacts.length, 1); assert.equal(await f.contracts.validateResult(state, result), true);
    const adopted = await f.adopt(result); assert.equal(adopted.evidence.length, 0);
  });

  test(`${adapter}: MCP changed projected facts and different attempt proof are rejected`, { timeout: 15000 }, async t => {
    const f = await setup(t, adapter); const { result } = await f.invoke(); const state = (await f.state().get(f.work.id))!;
    const forged = structuredClone(result); forged.output = { value: 999 }; forged.evidence[0]!.facts = { value: 999 };
    assert.equal(await f.contracts.validateResult(state, forged), false);
    assert.equal(await f.contracts.validateResult(state, { ...result, attemptId: 'other-attempt' }), false);
    await f.runtime().receive(f.work.id, result.attemptId, forged, 'invoked');
    assert.equal((await f.runtime().adopt(f.work.id, result.attemptId)).evidence.length, 0);
  });

  test(`${adapter}: MCP raw body corruption prevents adoption after restart`, { timeout: 15000 }, async t => {
    const f = await setup(t, adapter); const { result } = await f.invoke();
    await f.runtime().receive(f.work.id, result.attemptId, result, 'invoked'); await f.reopen();
    await writeFile(join(f.directory, 'artifacts', `${result.artifacts[0]!.id}.blob`), '{}');
    const current = (await f.state().get(f.work.id))!;
    assert.equal(await f.contracts.validateResult(current, result), false);
    await assert.rejects(f.runtime().adopt(f.work.id, result.attemptId), /artifact_unavailable/);
    const state = (await f.state().get(f.work.id))!; assert.equal(state.evidence.length, 0);
    assert.equal(state.attempts[0]!.adopted, false);
  });

  test(`${adapter}: MCP received result survives reopen and does not recall a stopped server`, { timeout: 15000 }, async t => {
    const f = await setup(t, adapter); const { result } = await f.invoke();
    await f.runtime().receive(f.work.id, result.attemptId, result, 'invoked'); await f.client.close(); await f.reopen();
    const state = await f.runtime().adopt(f.work.id, result.attemptId);
    assert.equal(state.attempts[0]!.adopted, true); assert.equal(state.evidence.length, 1);
    const envelope = JSON.parse(new TextDecoder().decode(await f.services.artifacts.get(result.artifacts[0]!, state.policy)));
    const restored = new ToolContracts([createMcpReadTool(f.binding, envelope.session, f.client, f.services, new AjvSchemas())], new AjvSchemas());
    assert.equal(await restored.validateResult(state, result), true);
  });

  test(`${adapter}: MCP request intent prevents a hidden second call for the same attempt`, { timeout: 15000 }, async t => {
    const f = await setup(t, adapter); const { result } = await f.invoke();
    await assert.rejects(f.broker().invoke(f.work.id, result.attemptId, f.runtime().owner, new AbortController().signal), /already_started/);
    assert.equal(await f.contracts.validateResult((await f.state().get(f.work.id))!, result), true);
  });

  test(`${adapter}: MCP repeated reads keep one independent source lineage`, { timeout: 15000 }, async t => {
    const f = await setup(t, adapter, 0, 2); const first = await f.invoke(); await f.adopt(first.result);
    const second = await f.invoke('good', 'second'); const state = await f.adopt(second.result);
    assert.equal(state.evidence.length, 2); assert.equal(new Set(state.evidence.map(e => e.lineageId)).size, 1);
    const goal = structuredClone(state.goal); goal.criteria[0]!.minIndependentSources = 2;
    assert.equal(evaluateCompletion(goal, state.evidence, [], state.policy).complete, false);
  });

  async function recordedCustody(f: Awaited<ReturnType<typeof setup>>, attemptId: string,
    witness: { schemaVersion: 1; outcome: 'returned' | 'failure'; transportCalls: 0 | 1 }) {
    const state = (await f.state().get(f.work.id))!, response = await f.state().receipt(f.work.id, `mcp-response:${attemptId}`);
    assert.ok(response); assert.equal(state.artifacts.length, 1); assert.equal(state.evidence.length, 0);
    const active = state.attempts.find(value => value.id === attemptId)!;
    assert.equal(active.resultId, null); assert.equal(active.resultArtifact, null); assert.equal(active.adopted, false);
    assert.equal(await f.state().receipt(f.work.id, `receive:${attemptId}`), null);
    const ref = state.artifacts[0]!;
    assert.deepEqual(ref.labels, ['synthetic']); assert.equal(ref.tenantId, f.work.policy.tenantId);
    // Only the original dispatch policy reads these bytes for host custody inspection.
    const bytes = await f.services.artifacts.get(ref, f.work.policy);
    assert.equal(bytes.byteLength, ref.byteLength); assert.equal(sha256(bytes), ref.sha256);
    const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    assert.equal(raw.schemaVersion, 1); assert.equal(raw.kind, 'mcp_decoded_response'); assert.equal(raw.attemptId, attemptId);
    assert.equal(raw.policyDigest, f.services.digester.digest(asJson(f.work.policy)));
    assert.equal(raw.goalDigest, f.services.digester.digest(asJson(f.work.goal)));
    assert.equal(raw.transportCalls, witness.transportCalls); assert.equal('custody' in raw, false);
    assert.equal(response.digest, f.services.digester.digest(asJson({ type: 'mcp_response_recorded',
      data: { attemptId, artifact: ref, custody: witness } })));
    assert.deepEqual(response.state.artifacts, [ref]);
    const task = state.plan!.tasks.find(value => value.id === active.taskId)!;
    assert.deepEqual(await f.contracts.restoreUsage(state, { attemptId, task }), {
      kind: 'available', usage: { transportCalls: witness.transportCalls, internalOperations: null, imageBytes: null, waitMs: null },
      receivedAt: raw.recordedAt, receipt: { commandId: `mcp-response:${attemptId}`, digest: response.digest, artifact: ref },
      custodyOnly: true, responseObserved: witness.outcome === 'returned',
    });
    const audit = (await readFile(join(f.directory, 'audit.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.equal(audit.filter(entry => entry.event === 'method' && entry.method === 'tools/call').length, witness.transportCalls);
    return { state, response, ref, raw, bytes };
  }

  for (const change of ['pause', 'expand-labels']) test(`${adapter}: MCP ${change} during adapter wait blocks the wire call and records unsent custody`, { timeout: 15000 }, async t => {
    const f = await setup(t, adapter); const entered = gate(); const release = gate();
    const session = await f.client.discover([f.binding.remote], new AbortController().signal); let sends = 0, projections = 0;
    const slowClient = { discover: f.client.discover.bind(f.client), async call(...args: Parameters<McpStdioClient['call']>) {
      entered.resolve(); await release.promise;
      return f.client.call(args[0], args[1], args[2], { ...args[3], authorize: async () => { await args[3].authorize(); sends++; } });
    } };
    const binding: McpReadBinding = { ...f.binding, project(value, task) { projections++; return f.binding.project(value, task); } };
    const replacement = createMcpReadTool(binding, session, slowClient, f.services, new AjvSchemas());
    f.contracts.replaceProvider('fixture', [replacement], { expectedEpoch: f.contracts.providerEpoch('fixture'), sourceRevision: 'slow-client' });
    const { attempt } = await f.prepare();
    const invocation = f.broker().invoke(f.work.id, attempt.id, f.runtime().owner, new AbortController().signal);
    const rejected = assert.rejects(invocation, /broker_execution_not_current/);
    await entered.promise;
    await transact(f.services, f.work.id, 'change-during-wait', 'fixture_changed', {}, state => {
      if (change === 'pause') { state.status = 'paused'; state.statusReason = 'fixture_pause'; } else state.policy.allowedLabels.push('new-label');
    });
    release.resolve(); await rejected; assert.equal(sends, 0); assert.equal(f.client.snapshot().toolCalls, 0); assert.equal(projections, 0);
    const saved = await recordedCustody(f, attempt.id, { schemaVersion: 1, outcome: 'failure', transportCalls: 0 });
    assert.equal(projections, 0);
    assert.equal(saved.raw.value, null); assert.deepEqual(saved.raw.failure, { code: 'mcp_call_not_sent', sent: false });
    if (change === 'pause') { assert.equal(saved.state.status, 'paused'); assert.equal(saved.state.statusReason, 'fixture_pause'); }
    else assert.deepEqual(saved.state.policy.allowedLabels, ['synthetic', 'new-label']);
  });

  for (const change of ['cancel', 'restrict-labels']) test(`${adapter}: MCP ${change} after a real reply preserves raw custody but prevents adoption`, { timeout: 15000 }, async t => {
    const f = await setup(t, adapter); const returned = gate(); const release = gate(); const controller = new AbortController();
    const session = await f.client.discover([f.binding.remote], new AbortController().signal);
    let receivedJson: string | undefined, projections = 0;
    const delayed = { discover: f.client.discover.bind(f.client), async call(...args: Parameters<McpStdioClient['call']>) {
      const reply = await f.client.call(...args); receivedJson = JSON.stringify(reply.value); returned.resolve(); await release.promise; return reply;
    } };
    const binding: McpReadBinding = { ...f.binding, project(value, task) { projections++; return f.binding.project(value, task); } };
    const replacement = createMcpReadTool(binding, session, delayed, f.services, new AjvSchemas());
    f.contracts.replaceProvider('fixture', [replacement],
      { expectedEpoch: f.contracts.providerEpoch('fixture'), sourceRevision: 'delayed-return' });
    const { attempt, task } = await f.prepare();
    const invocation = f.broker().invoke(f.work.id, attempt.id, f.runtime().owner, controller.signal);
    const rejected = assert.rejects(invocation, /broker_execution_not_current/); await returned.promise;
    assert.equal(f.client.snapshot().toolCalls, 1);
    if (change === 'cancel') controller.abort();
    else await transact(f.services, f.work.id, 'restrict-after-reply', 'fixture_restricted', {}, state => { state.policy.allowedLabels = []; });
    release.resolve(); await rejected; assert.equal(f.client.snapshot().toolCalls, 1); assert.equal(projections, 0);
    const saved = await recordedCustody(f, attempt.id, { schemaVersion: 1, outcome: 'returned', transportCalls: 1 });
    assert.equal(projections, 0);
    assert.ok(receivedJson); assert.equal(JSON.stringify(saved.raw.value), receivedJson); assert.equal(saved.raw.failure, null);
    if (change === 'restrict-labels') {
      assert.deepEqual(saved.state.policy.allowedLabels, []);
      await assert.rejects(f.services.artifacts.get(saved.ref, saved.state.policy), /artifact_access_denied/);
      await assert.rejects(replacement.restoreResult!(saved.state, { attemptId: attempt.id, task }), /mcp_saved_result_invalid/);
      assert.equal(projections, 0);
    } else {
      assert.equal(controller.signal.aborted, true);
      // This abort is local to the signal; it does not permanently revoke later, independently revalidated read recovery.
      assert.notEqual(saved.state.status, 'cancelled');
    }
    assert.deepEqual(await f.services.artifacts.get(saved.ref, f.work.policy), saved.bytes);
    assert.deepEqual(await f.state().get(f.work.id), saved.state);
    assert.deepEqual(await f.state().receipt(f.work.id, `mcp-response:${attempt.id}`), saved.response);
  });
}
