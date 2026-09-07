import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArtifactRef, Attempt, Limits, Policy, TaskSpec } from '../domain/model.js';
import type { WorkViewResult } from '../domain/work-view.js';
import { ToolBroker } from '../application/tool-broker.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';
import type { McpReadBinding } from '../infrastructure/mcp-read-tools.js';
import { MCP_PROTOCOL_VERSION, McpStdioClient } from '../infrastructure/mcp-stdio-client.js';
import { openAgentTurnProfile, type AgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { openAgentWeb } from '../presentation/agent-web.js';
import { createMcpHostTools } from '../presentation/mcp-host-tools.js';
import type { AgentExecutionHost } from '../presentation/host-tools.js';
import type { WebCommandResult } from '../presentation/web-contracts.js';
import { MCP_FIXTURE_DOCUMENTS_TOOL } from './helpers/mcp-fixture-contracts.js';
import { assertMcpPeersStopped, createMcpFixtureHost, initializeMcpAgent, MCP_AGENT_PROFILE, MCP_AGENT_PROVIDER,
  MCP_AGENT_TEXT, MCP_AGENT_TOOL, mcpFixtureAnswer, mcpFixtureIdentityOptions, readMcpAudit } from './mcp-agent-profile-helper.js';

const execute = promisify(execFile), runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
interface Options { auditFile: string; hostAuditFile: string; documentValue: number; now: number }
interface HostObservation { kind: 'model-close' | 'projector'; calls: number }

/** Test-only trusted host shared with the CLI child. The finite model is reused; no online tool registration is opened. */
export function createOfflineEntryHost(options: Options) {
  const configured = createMcpFixtureHost(options), model = configured.host.models.get(MCP_AGENT_PROFILE)!;
  const record = (value: HostObservation) => appendFileSync(options.hostAuditFile, JSON.stringify(value) + '\n', { mode: 0o600 });
  const policy: Policy = { tenantId: 'mcp-company', principalId: 'reader', allowWrites: false,
    allowedTools: [MCP_AGENT_TOOL], allowedLabels: ['synthetic', 'public'], allowedDestinations: ['local'] };
  const limits: Limits = { toolCalls: 8, modelCalls: 8, tokens: 1_000_000, replans: 4, wallTimeMs: 600_000 };
  const remote = structuredClone(MCP_FIXTURE_DOCUMENTS_TOOL);
  const binding: McpReadBinding = { definition: { provider: MCP_AGENT_PROVIDER, id: MCP_AGENT_TOOL, version: '1',
    description: 'Read the host-selected good MCP document and its value.', effect: 'read', destination: 'local', labels: ['synthetic'],
    inputSchema: remote.inputSchema, outputSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false } },
    remote, projectorId: 'mcp-agent-value', projectorVersion: '1', project(value, task) {
      record({ kind: 'projector', calls: 1 });
      assert.ok(value && typeof value === 'object' && !Array.isArray(value));
      assert.equal(value.id, task.input['id']); assert.equal(value.source, 'doc-origin'); assert.equal(value.observedAt, 900);
      assert.equal(typeof value.value, 'number');
      const coverage = value.complete === true ? 'complete' as const : 'partial' as const;
      return { output: { value: value.value! }, coverage, observations: [{ sourceId: 'doc-origin', lineageId: 'doc-origin',
        locator: '/value/structuredContent', observedAt: 900, coverage, facts: { value: value.value as number } }] };
    } };
  const tools = createMcpHostTools({ mode: 'stored_only', origin: { endpointId: 'mcp-agent-local', protocolVersion: MCP_PROTOCOL_VERSION },
    bindings: [binding], policy, limits });
  const host: AgentExecutionHost = { ...configured.host, models: new Map([[MCP_AGENT_PROFILE, { execution: model.execution, async open(profile) {
    const opened = await model.open(profile);
    return { ...opened, async close() {
      record({ kind: 'model-close', calls: configured.observed.modelInputs.length }); await opened.close();
    } };
  } }]]), tools };
  return { host, observed: configured.observed };
}

function originalIdentity(attempt: Attempt) {
  return { id: attempt.id, taskId: attempt.taskId, toolId: attempt.toolId, toolVersion: attempt.toolVersion,
    inputDigest: attempt.inputDigest, contractDigest: attempt.contractDigest, goalRevision: attempt.goalRevision,
    planRevision: attempt.planRevision, owner: attempt.owner, startedAt: attempt.startedAt, leaseUntil: attempt.leaseUntil, scope: attempt.scope };
}
function observations(options: Options): HostObservation[] {
  try { return readFileSync(options.hostAuditFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as HostObservation); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

async function seed(t: TestContext, backend: 'sqlite' | 'file-journal', received: boolean, channel: 'cli' | 'web' = received ? 'cli' : 'web') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-offline-entry-'))), directory = join(base, 'agent');
  initializeMcpAgent(directory, backend);
  const options: Options = { auditFile: join(base, 'peer.jsonl'), hostAuditFile: join(base, 'host.jsonl'), documentValue: 47, now: 100_000 };
  const realNow = Date.now, started = realNow();
  // Keep actual profile clocks immutable. Only the isolated test clock advances beyond the original lease; receipts are untouched.
  t.mock.method(Date, 'now', () => options.now + realNow() - started);
  let profile: AgentTurnProfile | undefined, extraClose: (() => Promise<void>) | undefined;
  t.after(async () => {
    try { await extraClose?.(); await profile?.close(); assertMcpPeersStopped(options.auditFile); }
    finally { rmSync(base, { recursive: true, force: true }); }
  });
  const configured = createMcpFixtureHost(options);
  profile = await openAgentTurnProfile(directory, { provider: 'registered' }, configured.host);
  const p = profile, conversationId = channel === 'cli' ? 'terminal' : 'offline-entry';
  const session = await p.sessions.open(p.actor, { channel, conversationId });
  const accepted = await p.turns.accept(p.actor, { sessionId: session.scope.sessionId, messageId: 'original-read', rawText: MCP_AGENT_TEXT,
    mode: 'auto', binding: { ...p.executionActor, channel, conversationId, recipientId: p.actor.principalId, destination: 'local' },
    scope: p.scope, policy: p.policy, limits: p.limits });
  const workId = accepted.workId, state = await p.runtime.state(workId);
  const definition = p.contracts.visible(p.policy).find(tool => tool.id === MCP_AGENT_TOOL); assert.ok(definition);
  const task: TaskSpec = { id: 'original-read', description: 'Read the original MCP source once', toolId: definition.id, toolVersion: definition.version,
    effect: 'read', input: { id: 'good' }, dependsOn: [], maxAttempts: 1, satisfies: [] };
  await p.runtime.submitPlan(workId, 'offline-entry-plan', { baseStateRevision: state.revision, baseGoalRevision: state.goal.revision,
    basePlanRevision: 0, reason: 'Exercise host persistence, not model planning quality', tasks: [task], hypotheses: [] });
  let attempt: Attempt | undefined, raw: ArtifactRef | undefined;
  if (received) {
    attempt = await p.runtime.reserve(workId, task.id); await p.runtime.dispatch(workId, attempt.id);
    const result = await new ToolBroker(p.services.state, p.contracts, p.services.digester, p.services.clock,
      undefined, undefined, undefined, p.services).invoke(workId, attempt.id, p.runtime.owner, new AbortController().signal);
    assert.equal(result.status, 'success'); raw = result.artifacts[0]; assert.ok(raw);
    assert.ok(await p.services.state.receipt(workId, `mcp-response:${attempt.id}`));
    assert.equal(await p.services.state.receipt(workId, `receive:${attempt.id}`), null);
  }
  assert.equal(configured.observed.modelInputs.length, 0);
  await p.close(); profile = undefined; assertMcpPeersStopped(options.auditFile);
  const peerLog = readFileSync(options.auditFile, 'utf8');
  const originalCalls = readMcpAudit(options.auditFile).filter(row => row.event === 'method' && row.method === 'tools/call').length;
  assert.equal(originalCalls, received ? 1 : 0);
  if (attempt) options.now = attempt.leaseUntil + 1;
  const inspect = async () => {
    const stores = await openAgentStores(new FileAgentProfileStore(runtimeRoot), directory, undefined, mcpFixtureIdentityOptions(options));
    try {
      const current = await stores.state.get(workId); assert.ok(current);
      const receipts = attempt ? await Promise.all(['dispatch', 'mcp-intent', 'mcp-response'].map(prefix => stores.state.receipt(workId, `${prefix}:${attempt!.id}`))) : [];
      return { state: current, receipts, rawBytes: raw ? await stores.artifacts.get(raw, current.policy) : null,
        input: await stores.sessions.input(session.scope, 'original-read'), history: await stores.sessions.history(session.scope, current.policy, { limit: 100 }) };
    } finally { await stores.close(); }
  };
  const before = await inspect();
  return { directory, options, workId, sessionId: session.scope.sessionId, conversationId, attempt, raw, definition, before, inspect,
    noPeer() { assert.equal(readFileSync(options.auditFile, 'utf8'), peerLog, 'stored reopen must not start/list/call/close a peer'); assertMcpPeersStopped(options.auditFile); },
    cleanupWith(close: () => Promise<void>) { extraClose = close; } };
}

interface Chat { workId: string; sessionId: string; snapshot: { status: string; resultDelivery: string; usage: { toolCalls: number; modelCalls: number } };
  messages: { kind: string; text: string }[]; run?: { control: { kind: string; reason: string } } }
async function cli(f: Awaited<ReturnType<typeof seed>>, command: 'resume' | 'status') {
  const options = { ...f.options, now: Date.now() };
  const program = `import {mock} from 'node:test';
import {runAgentTurnCli} from ${JSON.stringify(new URL('../presentation/agent-turn-cli.js', import.meta.url).href)};
import {createOfflineEntryHost} from ${JSON.stringify(import.meta.url)};
import {McpStdioClient} from ${JSON.stringify(new URL('../infrastructure/mcp-stdio-client.js', import.meta.url).href)};
const realNow=Date.now,started=realNow();mock.method(Date,'now',()=>${options.now}+realNow()-started);
for(const name of ['discover','call','close']) mock.method(McpStdioClient.prototype,name,()=>{throw new Error('offline_client_'+name);});
try { await runAgentTurnCli(process.argv.slice(1),createOfflineEntryHost(${JSON.stringify(options)}).host); }
finally { mock.restoreAll(); }`;
  const result = await execute(process.execPath, ['--input-type=module', '-e', program, command, '--directory', f.directory,
    '--provider', 'registered', '--session', f.sessionId, '--work', f.workId, '--json', ...(command === 'resume' ? ['--goal-revision', '1'] : [])],
  { timeout: 30000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, SECUMON_OFFLINE_ENTRY_HELPER: '1' } });
  return JSON.parse(result.stdout) as Chat;
}

async function connect(f: Awaited<ReturnType<typeof seed>>, mode: 'stored_only' | 'online' = 'stored_only') {
  const configured = mode === 'online' ? createMcpFixtureHost(f.options) : createOfflineEntryHost(f.options);
  const app = await openAgentWeb(['--directory', f.directory, '--provider', 'registered', '--session', f.sessionId,
    '--conversation', f.conversationId], configured.host); assert.ok(app);
  try {
    const login = await fetch(`${app.server.origin}/api/session`, { method: 'POST', headers: { Origin: app.server.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: new URL(app.server.connectUrl).hash.slice(9) }), signal: AbortSignal.timeout(10000) });
    assert.equal(login.status, 200); const session = await login.json() as { csrf: string };
    const headers = { Cookie: login.headers.get('set-cookie')!.split(';')[0]!, Origin: app.server.origin,
      'Content-Type': 'application/json', 'X-Work-CSRF': session.csrf };
    const request = async <T>(path: string, body?: unknown): Promise<T> => {
      const response = await fetch(`${app.server.origin}${path}`, { headers, signal: AbortSignal.timeout(10000),
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      const value: unknown = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value as T;
    };
    return { app, request, observed: configured.observed };
  } catch (error) { await app.close(); throw error; }
}

// The child imports this same trusted factory without recursively registering the test suite.
if (process.env['SECUMON_OFFLINE_ENTRY_HELPER'] !== '1') for (const backend of ['sqlite', 'file-journal'] as const) {
  test(`${backend}: real CLI child restores the original MCP response and finishes after the actual peer has stopped`, { timeout: 45000 }, async t => {
    const f = await seed(t, backend, true); assert.ok(f.attempt); assert.ok(f.raw);
    const status = await cli(f, 'status'); assert.notEqual(status.snapshot.status, 'completed');
    assert.deepEqual(await f.inspect(), f.before, 'status opens no MCP connection and does not reconcile state'); f.noPeer();
    const completed = await cli(f, 'resume'); assert.equal(completed.run?.control.kind, 'complete');
    assert.equal(completed.snapshot.status, 'completed'); assert.equal(completed.snapshot.resultDelivery, 'delivered');
    assert.equal(completed.messages.find(value => value.kind === 'result')?.text, mcpFixtureAnswer(f.options.documentValue));
    const after = await f.inspect(); assert.equal(after.state.attempts.length, 1);
    assert.deepEqual(originalIdentity(after.state.attempts[0]!), originalIdentity(f.before.state.attempts[0]!));
    assert.equal(after.state.attempts[0]!.adopted, true); assert.equal(after.state.attempts[0]!.execution?.usage.transportCalls, 1);
    assert.equal(after.state.budget.used.toolCalls, 1); assert.equal(after.state.budget.used.modelCalls, 1);
    assert.deepEqual(after.receipts, f.before.receipts); assert.deepEqual(after.rawBytes, f.before.rawBytes);
    assert.deepEqual(after.input, f.before.input); assert.deepEqual(after.state.goal, f.before.state.goal); assert.deepEqual(after.state.plan, f.before.state.plan);
    assert.equal(after.state.evidence[0]!.facts.value, f.options.documentValue); assert.deepEqual(after.state.evidence[0]!.artifact, f.raw);
    assert.equal(after.history.entries.filter(entry => entry.role === 'user' && entry.text === MCP_AGENT_TEXT).length, 1);
    assert.equal(after.history.entries.filter(entry => entry.role === 'assistant' && entry.text === mcpFixtureAnswer(f.options.documentValue)).length, 1);
    f.noPeer();
    const again = await cli(f, 'resume'); assert.equal(again.snapshot.status, 'completed');
    const repeated = await f.inspect(); assert.deepEqual(repeated.state.attempts, after.state.attempts);
    assert.deepEqual(repeated.state.budget.used, after.state.budget.used); assert.deepEqual(repeated.history, after.history);
    assert.equal(observations(f.options).filter(row => row.kind === 'model-close').reduce((sum, row) => sum + row.calls, 0), 1);
    f.noPeer();
  });

  test(`${backend}: actual localhost HTTP preserves an uncalled wait and completes the original task after online reopen`, { timeout: 60000 }, async t => {
    const f = await seed(t, backend, false);
    const clientMocks = (['discover', 'call', 'close'] as const).map(name =>
      t.mock.method(McpStdioClient.prototype, name, () => assert.fail(`offline HTTP must not invoke client.${name}`)));
    const web = await connect(f); f.cleanupWith(() => web.app.close());
    await web.request<WorkViewResult>(`/api/works/${f.workId}/view`);
    assert.deepEqual(await f.inspect(), f.before); f.noPeer();
    const result = await web.request<WebCommandResult>(`/api/works/${f.workId}/commands`, {
      requestId: 'offline-run', kind: 'run', expectedGoalRevision: 1 });
    assert.equal(result.view.kind, 'snapshot'); if (result.view.kind !== 'snapshot') assert.fail();
    assert.equal(result.view.view.progress.status, 'waiting');
    assert.equal(result.view.view.messages.some(message => message.kind === 'result'), false);
    const profile = web.app.profile.general!;
    const after = await f.inspect();
    assert.deepEqual(profile.runtime.control(after.state), { kind: 'wait', reason: 'connection_required', wakeAt: null });
    assert.deepEqual(after.state.attempts, []); assert.deepEqual(after.state.budget, f.before.state.budget);
    assert.deepEqual(after.state.goal, f.before.state.goal); assert.deepEqual(after.state.plan, f.before.state.plan); assert.deepEqual(after.input, f.before.input);
    assert.equal(web.observed.modelInputs.length, 0); assert.deepEqual(observations(f.options), []); f.noPeer();
    await web.app.close();
    const reopened = await connect(f); f.cleanupWith(() => reopened.app.close());
    await reopened.request<WebCommandResult>(`/api/works/${f.workId}/commands`, { requestId: 'offline-run', kind: 'run', expectedGoalRevision: 1 });
    const repeated = await f.inspect(); assert.deepEqual(repeated.state.attempts, []); assert.deepEqual(repeated.state.budget, f.before.state.budget);
    assert.deepEqual(reopened.app.profile.general!.runtime.control(repeated.state), { kind: 'wait', reason: 'connection_required', wakeAt: null });
    assert.equal(reopened.observed.modelInputs.length, 0); f.noPeer();
    await reopened.app.close(); f.noPeer();
    for (const method of clientMocks) method.mock.restore();

    const online = await connect(f, 'online'); f.cleanupWith(() => online.app.close());
    const completed = await online.request<WebCommandResult>(`/api/works/${f.workId}/commands`, {
      requestId: 'online-run', kind: 'run', expectedGoalRevision: 1 });
    assert.equal(completed.workId, f.workId); assert.equal(completed.duplicate, false);
    assert.equal(completed.view.kind, 'snapshot'); if (completed.view.kind !== 'snapshot') assert.fail();
    assert.equal(completed.view.view.progress.status, 'completed'); assert.equal(completed.view.view.progress.resultDelivery, 'delivered');
    assert.equal(completed.view.view.messages.find(message => message.kind === 'result')?.text, mcpFixtureAnswer(f.options.documentValue));
    const finished = await f.inspect(); assert.equal(finished.state.id, f.workId); assert.equal(finished.state.attempts.length, 1);
    const attempt = finished.state.attempts[0]!;
    assert.equal(attempt.taskId, 'original-read'); assert.equal(attempt.toolId, f.definition.id); assert.equal(attempt.toolVersion, f.definition.version);
    assert.equal(attempt.goalRevision, f.before.state.goal.revision); assert.equal(attempt.planRevision, f.before.state.plan!.revision);
    assert.equal(attempt.adopted, true); assert.equal(attempt.execution?.usage.transportCalls, 1);
    assert.deepEqual(finished.state.goal, f.before.state.goal); assert.deepEqual(finished.state.plan, f.before.state.plan);
    assert.deepEqual(finished.input, f.before.input); assert.equal(finished.state.conversation!.session!.scope.sessionId, f.sessionId);
    assert.equal(finished.state.budget.used.toolCalls, 1); assert.equal(finished.state.budget.used.modelCalls, 1);
    assert.equal(online.observed.modelInputs.length, 1); assert.equal(finished.state.evidence[0]!.facts.value, f.options.documentValue);
    assert.equal(finished.history.entries.filter(entry => entry.role === 'user' && entry.text === MCP_AGENT_TEXT).length, 1);
    assert.equal(finished.history.entries.filter(entry => entry.role === 'assistant' && entry.text === mcpFixtureAnswer(f.options.documentValue)).length, 1);
    assert.equal(readMcpAudit(f.options.auditFile).filter(row => row.event === 'method' && row.method === 'tools/call').length, 1);
    const duplicate = await online.request<WebCommandResult>(`/api/works/${f.workId}/commands`, {
      requestId: 'online-run', kind: 'run', expectedGoalRevision: 1 });
    assert.equal(duplicate.duplicate, true);
    const once = await f.inspect(); assert.deepEqual(once.state.attempts, finished.state.attempts);
    assert.deepEqual(once.state.budget.used, finished.state.budget.used); assert.deepEqual(once.history, finished.history);
    assert.equal(online.observed.modelInputs.length, 1);
    assert.equal(readMcpAudit(f.options.auditFile).filter(row => row.event === 'method' && row.method === 'tools/call').length, 1);
    await online.app.close(); assertMcpPeersStopped(f.options.auditFile);
  });

  test(`${backend}: actual localhost HTTP restores the original raw response without a peer and remains complete after reopen`, { timeout: 60000 }, async t => {
    const f = await seed(t, backend, true, 'web'); assert.ok(f.attempt); assert.ok(f.raw);
    for (const name of ['discover', 'call', 'close'] as const)
      t.mock.method(McpStdioClient.prototype, name, () => assert.fail(`offline response restore must not invoke client.${name}`));
    const web = await connect(f); f.cleanupWith(() => web.app.close());
    await web.request<WorkViewResult>(`/api/works/${f.workId}/view`);
    assert.deepEqual(await f.inspect(), f.before, 'HTTP status must not receive or adopt the saved response'); f.noPeer();
    const completed = await web.request<WebCommandResult>(`/api/works/${f.workId}/commands`, {
      requestId: 'offline-restore-response', kind: 'run', expectedGoalRevision: 1 });
    assert.equal(completed.workId, f.workId); assert.equal(completed.duplicate, false);
    assert.equal(completed.view.kind, 'snapshot'); if (completed.view.kind !== 'snapshot') assert.fail();
    assert.equal(completed.view.view.progress.status, 'completed'); assert.equal(completed.view.view.progress.resultDelivery, 'delivered');
    assert.equal(completed.view.view.messages.find(message => message.kind === 'result')?.text, mcpFixtureAnswer(f.options.documentValue));
    const after = await f.inspect(); assert.equal(after.state.attempts.length, 1);
    assert.deepEqual(originalIdentity(after.state.attempts[0]!), originalIdentity(f.before.state.attempts[0]!));
    assert.equal(after.state.attempts[0]!.adopted, true); assert.equal(after.state.attempts[0]!.execution?.usage.transportCalls, 1);
    assert.equal(after.state.budget.used.toolCalls, 1); assert.equal(after.state.budget.used.modelCalls, 1);
    assert.deepEqual(after.receipts, f.before.receipts); assert.deepEqual(after.rawBytes, f.before.rawBytes);
    assert.deepEqual(after.input, f.before.input); assert.deepEqual(after.state.goal, f.before.state.goal); assert.deepEqual(after.state.plan, f.before.state.plan);
    assert.equal(after.state.conversation!.session!.scope.sessionId, f.sessionId);
    assert.equal(after.state.evidence[0]!.facts.value, f.options.documentValue); assert.deepEqual(after.state.evidence[0]!.artifact, f.raw);
    assert.equal(after.history.entries.filter(entry => entry.role === 'user' && entry.text === MCP_AGENT_TEXT).length, 1);
    assert.equal(after.history.entries.filter(entry => entry.role === 'assistant' && entry.text === mcpFixtureAnswer(f.options.documentValue)).length, 1);
    assert.equal(web.observed.modelInputs.length, 1); f.noPeer();
    await web.app.close();

    const reopened = await connect(f); f.cleanupWith(() => reopened.app.close());
    const duplicate = await reopened.request<WebCommandResult>(`/api/works/${f.workId}/commands`, {
      requestId: 'offline-restore-response', kind: 'run', expectedGoalRevision: 1 });
    assert.equal(duplicate.duplicate, true); assert.equal(duplicate.view.kind, 'snapshot'); if (duplicate.view.kind !== 'snapshot') assert.fail();
    assert.equal(duplicate.view.view.progress.status, 'completed'); assert.equal(duplicate.view.view.progress.resultDelivery, 'delivered');
    const repeated = await f.inspect(); assert.deepEqual(repeated.state.attempts, after.state.attempts);
    assert.deepEqual(repeated.state.budget.used, after.state.budget.used); assert.deepEqual(repeated.history, after.history);
    assert.deepEqual(repeated.receipts, after.receipts); assert.deepEqual(repeated.rawBytes, after.rawBytes); assert.deepEqual(repeated.input, after.input);
    assert.equal(reopened.observed.modelInputs.length, 0); f.noPeer();
  });
}
