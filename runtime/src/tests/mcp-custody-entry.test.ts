import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArtifactRef, Attempt, Limits, Policy, TaskSpec } from '../domain/model.js';
import type { WorkViewResult } from '../domain/work-view.js';
import { ToolBroker } from '../application/tool-broker.js';
import { ResumePacketSchema } from '../application/recovery-contracts.js';
import { transact } from '../application/work-transactions.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';
import type { McpReadBinding } from '../infrastructure/mcp-read-tools.js';
import { openAgentTurnProfile, type AgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { openAgentWeb } from '../presentation/agent-web.js';
import type { AgentExecutionHost } from '../presentation/host-tools.js';
import { createMcpHostTools } from '../presentation/mcp-host-tools.js';
import type { WebCommandResult } from '../presentation/web-contracts.js';
import { MCP_FIXTURE_DOCUMENTS_TOOL } from './helpers/mcp-fixture-contracts.js';
import { assertMcpPeersStopped, createMcpFixtureHost, initializeMcpAgent, MCP_AGENT_PROFILE,
  MCP_AGENT_PROVIDER, MCP_AGENT_TEXT, MCP_AGENT_TOOL, mcpFixtureIdentityOptions, readMcpAudit } from './mcp-agent-profile-helper.js';

const execute = promisify(execFile), runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
interface HostOptions { auditFile: string; hostAuditFile: string; now: number; documentValue: number }
interface HostObservation { kind: 'projector' | 'model-close'; calls: number }
function observations(options: HostOptions): HostObservation[] {
  return existsSync(options.hostAuditFile) ? readFileSync(options.hostAuditFile, 'utf8').trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as HostObservation) : [];
}

/** Exported solely so the real CLI child can use the same host registration, without registering this test suite. */
export function createCustodyEntryHost(options: HostOptions) {
  const configured = createMcpFixtureHost(options), model = configured.host.models.get(MCP_AGENT_PROFILE)!;
  let afterRaw: (() => Promise<void>) | undefined;
  const record = (value: HostObservation) => appendFileSync(options.hostAuditFile, JSON.stringify(value) + '\n', { mode: 0o600 });
  const policy: Policy = { tenantId: 'mcp-company', principalId: 'reader', allowWrites: false,
    allowedTools: [MCP_AGENT_TOOL], allowedLabels: ['synthetic', 'public'], allowedDestinations: ['local'] };
  const limits: Limits = { toolCalls: 8, modelCalls: 8, tokens: 1_000_000, replans: 4, wallTimeMs: 600_000 };
  const remote = structuredClone(MCP_FIXTURE_DOCUMENTS_TOOL);
  // The existing fixture projection is retained exactly; the added counter distinguishes body work from bookkeeping.
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
  const registration = createMcpHostTools({ config: { endpointId: 'mcp-agent-local', command: process.execPath,
    args: [fileURLToPath(new URL('./helpers/mcp-fixture-server.js', import.meta.url)), '--audit-file', options.auditFile,
      '--audit-process', '--document-value', String(options.documentValue), '--mode', 'normal'],
    cwd: runtimeRoot, env: { TMPDIR: tmpdir(), TMP: tmpdir(), TEMP: tmpdir() }, timeoutMs: 5000 }, bindings: [binding], policy, limits });
  const host: AgentExecutionHost = { ...configured.host, models: new Map([[MCP_AGENT_PROFILE, { execution: model.execution, async open(profile) {
    const opened = await model.open(profile);
    return { ...opened, async close() {
      record({ kind: 'model-close', calls: configured.observed.modelInputs.length }); await opened.close();
    } };
  } }]]), tools: { async open(context, assembly) {
    assert.ok(assembly);
    const put = assembly.custody.artifacts.put.bind(assembly.custody.artifacts);
    assembly.custody.artifacts.put = async (bytes, attributes) => {
      const ref = await put(bytes, attributes);
      let value: unknown; try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { return ref; }
      if (value && typeof value === 'object' && 'kind' in value && value.kind === 'mcp_decoded_response' && afterRaw) {
        const action = afterRaw; afterRaw = undefined; await action();
      }
      return ref;
    };
    return registration.open(context, assembly);
  } } };
  return { host, observed: configured.observed, afterRaw(action: () => Promise<void>) { afterRaw = action; } };
}

function callCount(options: HostOptions) {
  return readMcpAudit(options.auditFile).filter(row => row.event === 'method' && row.method === 'tools/call').length;
}
function assertNoExtraExecution(options: HostOptions) {
  assert.equal(callCount(options), 1, 'only the original wire request is sent; discovery is a different operation');
  assert.equal(observations(options).filter(row => row.kind === 'projector').length, 0);
  assert.equal(observations(options).filter(row => row.kind === 'model-close').reduce((sum, row) => sum + row.calls, 0), 0);
}
function identity(attempt: Attempt) {
  return { id: attempt.id, taskId: attempt.taskId, toolId: attempt.toolId, toolVersion: attempt.toolVersion,
    owner: attempt.owner, scope: attempt.scope, startedAt: attempt.startedAt, leaseUntil: attempt.leaseUntil,
    inputDigest: attempt.inputDigest, contractDigest: attempt.contractDigest, goalRevision: attempt.goalRevision, planRevision: attempt.planRevision };
}
function noBody(value: unknown, raw: ArtifactRef, options: HostOptions) {
  const text = JSON.stringify(value);
  for (const forbidden of ['mcp_decoded_response', 'structuredContent', 'doc-origin', '/value/structuredContent', raw.id, raw.sha256,
    String(options.documentValue)]) assert.equal(text.includes(forbidden), false, `surface leaked ${forbidden}`);
  assert.doesNotMatch(text, /"facts"\s*:/);
}

async function seed(t: TestContext, backend: 'sqlite' | 'file-journal', channel: 'cli' | 'web', publicInput = false) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-custody-entry-'))), directory = join(base, 'agent');
  initializeMcpAgent(directory, backend);
  const options: HostOptions = { auditFile: join(base, 'peer.jsonl'), hostAuditFile: join(base, 'host.jsonl'), now: 100_000, documentValue: 867539 };
  const realNow = Date.now, started = realNow();
  // Only this isolated test process's system clock is mocked. The real, frozen profile clock still calls Date.now;
  // timers keep running, time keeps advancing, and no stored lease or receipt is rewritten.
  t.mock.method(Date, 'now', () => options.now + realNow() - started);
  const configured = createCustodyEntryHost(options);
  let profile: AgentTurnProfile | undefined, extraClose: (() => Promise<void>) | undefined;
  t.after(async () => {
    try { await extraClose?.(); await profile?.close(); if (existsSync(options.auditFile)) assertMcpPeersStopped(options.auditFile); }
    finally { rmSync(base, { recursive: true, force: true }); }
  });
  profile = await openAgentTurnProfile(directory, { provider: 'registered' }, configured.host);
  const p = profile, conversationId = channel === 'cli' ? 'terminal' : 'custody-entry';
  const session = await p.sessions.open(p.actor, { channel, conversationId });
  const accepted = await p.turns.accept(p.actor, { sessionId: session.scope.sessionId, messageId: 'original-read', rawText: MCP_AGENT_TEXT,
    mode: 'auto', binding: { ...p.executionActor, channel, conversationId, destination: 'local', recipientId: p.actor.principalId },
    scope: p.scope, policy: publicInput ? { ...p.policy, allowedLabels: [] } : p.policy, limits: p.limits });
  const workId = accepted.workId, originalInput = await p.sessions.repository.input(session.scope, 'original-read'); assert.ok(originalInput);
  if (publicInput) {
    assert.deepEqual(originalInput.labels, []);
    // A distinct host-authorized grant permits this one read. The original public request is never relabelled or rewritten.
    await transact(p.services, workId, 'entry-authorize-labelled-read', 'fixture_read_authorized', {}, next => {
      next.policy.allowedLabels = [...p.policy.allowedLabels];
    });
  }
  const state = await p.runtime.state(workId), definition = p.contracts.visible(p.policy).find(tool => tool.id === MCP_AGENT_TOOL)!;
  const task: TaskSpec = { id: 'original-read', description: 'Read the actual local peer once before reconnecting', toolId: definition.id,
    toolVersion: definition.version, effect: 'read', input: { id: 'good' }, dependsOn: [], maxAttempts: 1, satisfies: [] };
  await p.runtime.submitPlan(workId, 'entry-fixture-plan', { baseStateRevision: state.revision, baseGoalRevision: state.goal.revision,
    basePlanRevision: 0, reason: 'Host persistence and entry routing, not model inference', tasks: [task], hypotheses: [] });
  const attempt = await p.runtime.reserve(workId, task.id); await p.runtime.dispatch(workId, attempt.id);
  configured.afterRaw(async () => {
    await transact(p.services, workId, 'entry-narrow-labels', 'fixture_policy_narrowed', {}, next => { next.policy.allowedLabels = []; });
  });
  const broker = new ToolBroker(p.services.state, p.contracts, p.services.digester, p.services.clock,
    undefined, undefined, undefined, p.services);
  await assert.rejects(broker.invoke(workId, attempt.id, p.runtime.owner, new AbortController().signal), /broker_execution_not_current/);
  const response = await p.services.state.receipt(workId, `mcp-response:${attempt.id}`); assert.ok(response);
  const raw = response.state.artifacts.find(ref => ref.mediaType === 'application/json')!; assert.ok(raw);
  const rawBytes = await p.services.artifacts.get(raw, p.policy);
  const envelope = JSON.parse(new TextDecoder().decode(rawBytes));
  assert.equal(envelope.kind, 'mcp_decoded_response'); assert.equal(envelope.value.structuredContent.value, options.documentValue);
  assert.equal(envelope.transportCalls, 1); assert.deepEqual(raw.labels, [...p.policy.allowedLabels].sort());
  await assert.rejects(p.services.artifacts.get(raw, (await p.runtime.state(workId)).policy), /artifact_access_denied/);
  assert.equal(await p.services.state.receipt(workId, `receive:${attempt.id}`), null);
  assert.equal(configured.observed.modelInputs.length, 0); assert.equal(callCount(options), 1);
  const originalPolicy = p.policy;
  await p.close(); profile = undefined; assertMcpPeersStopped(options.auditFile); assertNoExtraExecution(options);
  const inspect = async () => {
    const stores = await openAgentStores(new FileAgentProfileStore(runtimeRoot), directory, undefined, mcpFixtureIdentityOptions(options));
    try {
      const current = await stores.state.get(workId); assert.ok(current);
      const selected = current.attempts.find(value => value.id === attempt.id)!;
      const receipts = await Promise.all(['dispatch', 'mcp-intent', 'mcp-response'].map(prefix => stores.state.receipt(workId, `${prefix}:${attempt.id}`)));
      assert.ok(stores.sessions);
      return { state: current, attempt: selected, receipts, rawBytes: await stores.artifacts.get(raw, originalPolicy),
        input: await stores.sessions.input(session.scope, 'original-read'), history: await stores.sessions.history(session.scope, originalPolicy, { limit: 100 }),
        receive: await stores.state.receipt(workId, `receive:${attempt.id}`), events: await stores.state.events(workId, 0) };
    } finally { await stores.close(); }
  };
  const before = await inspect();
  options.now = attempt.leaseUntil + 1;
  assert.equal(before.attempt.execution?.usage.transportCalls ?? null, null); assert.equal(before.attempt.adopted, false);
  const unchangedOriginal = (after: Awaited<ReturnType<typeof inspect>>) => {
    assert.deepEqual(after.receipts, before.receipts); assert.deepEqual(after.rawBytes, rawBytes);
    assert.deepEqual(identity(after.attempt), identity(before.attempt)); assert.deepEqual(after.input, originalInput);
    assert.deepEqual(after.state.goal, before.state.goal); assert.deepEqual(after.state.plan, before.state.plan);
    assert.deepEqual(after.state.policy, before.state.policy); assert.deepEqual(after.state.evidence, []);
    assert.equal(after.attempt.resultId, null); assert.equal(after.attempt.resultArtifact, null); assert.equal(after.attempt.adopted, false);
    assert.equal(after.receive, null); assert.equal(after.state.generatedAnswer ?? null, null); assert.deepEqual(after.state.modelCalls, []);
    assert.deepEqual(after.state.budget.used, before.state.budget.used);
    assert.equal(after.history.entries.filter(entry => entry.role === 'user' && entry.text === MCP_AGENT_TEXT).length, 1);
    assert.equal(after.history.entries.some(entry => entry.role === 'assistant' && entry.kind === 'result'), false);
  };
  return { directory, options, workId, sessionId: session.scope.sessionId, conversationId, raw, before, inspect, unchangedOriginal,
    later: { ...options, now: attempt.leaseUntil + 1 }, cleanupWith(close: () => Promise<void>) { extraClose = close; } };
}

interface Chat { workId: string; sessionId: string; snapshot: { status: string; resultReady: boolean }; messages: { kind: string; text: string }[];
  run?: { control: { kind: string }; checkpoint: ArtifactRef } }
async function cli(f: Awaited<ReturnType<typeof seed>>, command: 'status' | 'resume', inputDenied = true) {
  const childOptions = { ...f.later, now: Date.now() };
  const program = `import {mock} from 'node:test';
import {runAgentTurnCli,reportAgentTurnCliFailure} from ${JSON.stringify(new URL('../presentation/agent-turn-cli.js', import.meta.url).href)};
import {createCustodyEntryHost} from ${JSON.stringify(import.meta.url)};
const realNow=Date.now,started=realNow();mock.method(Date,'now',()=>${childOptions.now}+realNow()-started);
try { await runAgentTurnCli(process.argv.slice(1),createCustodyEntryHost(${JSON.stringify(childOptions)}).host); }
catch(error) { reportAgentTurnCliFailure(error,true); }
finally { mock.restoreAll(); }`;
  const pending = execute(process.execPath, ['--input-type=module', '-e', program, command, '--directory', f.directory,
    '--provider', 'registered', '--session', f.sessionId, '--work', f.workId, '--json', ...(command === 'resume' ? ['--goal-revision', '1'] : [])],
  { timeout: 30000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, SECUMON_CUSTODY_ENTRY_HELPER: '1' } });
  if (command === 'resume' && inputDenied) {
    await assert.rejects(pending, error => {
      const failure = error as Error & { code?: number; killed?: boolean; signal?: string; stdout?: string; stderr?: string };
      assert.equal(failure.code, 1); assert.notEqual(failure.killed, true); assert.equal(failure.signal ?? null, null);
      assert.equal(failure.stdout, ''); assert.ok(failure.stderr);
      const lines = failure.stderr.split('\n').filter(line => line.startsWith('{'));
      assert.deepEqual(lines.map(line => JSON.parse(line)), [{ code: 'session_current_input_unavailable' }]);
      noBody(failure.stderr, f.raw, f.options); return true;
    });
    assertMcpPeersStopped(f.options.auditFile); return null;
  }
  const result = await pending;
  assert.doesNotMatch(result.stdout, /\u001b/); assertMcpPeersStopped(f.options.auditFile);
  return JSON.parse(result.stdout) as Chat;
}

async function connect(f: Awaited<ReturnType<typeof seed>>) {
  const configured = createCustodyEntryHost(f.later);
  const app = await openAgentWeb(['--directory', f.directory, '--provider', 'registered', '--session', f.sessionId,
    '--conversation', f.conversationId], configured.host); assert.ok(app);
  try {
    const login = await fetch(`${app.server.origin}/api/session`, { method: 'POST', headers: { Origin: app.server.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: new URL(app.server.connectUrl).hash.slice(9) }), signal: AbortSignal.timeout(10000) });
    assert.equal(login.status, 200); const session = await login.json() as { csrf: string };
    const headers = { Cookie: login.headers.get('set-cookie')!.split(';')[0]!, Origin: app.server.origin,
      'Content-Type': 'application/json', 'X-Work-CSRF': session.csrf };
    const request = async <T>(path: string, body?: unknown): Promise<T> => {
      const result = await fetch(`${app.server.origin}${path}`, { headers, signal: AbortSignal.timeout(10000),
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      const value: unknown = await result.json(); assert.equal(result.status, 200, JSON.stringify(value)); return value as T;
    };
    return { app, request, observed: configured.observed };
  } catch (error) { await app.close(); throw error; }
}

// The CLI subprocess imports this file as its trusted host factory, never as a second test runner.
if (process.env['SECUMON_CUSTODY_ENTRY_HELPER'] !== '1') for (const backend of ['sqlite', 'file-journal'] as const) {
  if (backend === 'sqlite') test('SQLite: CLI resume retains a public original input, projects out protected MCP custody and returns a valid blocked checkpoint', { timeout: 45000 }, async t => {
    const f = await seed(t, backend, 'cli', true);
    assert.deepEqual(f.before.input!.labels, []);
    const resumed = await cli(f, 'resume', false); assert.ok(resumed?.run);
    assert.equal(resumed.run.control.kind, 'blocked'); assert.equal(resumed.snapshot.status, 'blocked');
    assert.equal(resumed.snapshot.resultReady, false); noBody(resumed, f.raw, f.options);
    const after = await f.inspect(); f.unchangedOriginal(after);
    assert.equal(after.attempt.execution?.usage.transportCalls, 1);
    assert.equal(after.events.filter(event => event.type === 'tool_execution_usage_recorded').length, 1);
    assert.deepEqual(after.state.conversation?.session, f.before.state.conversation?.session);
    const stores = await openAgentStores(new FileAgentProfileStore(runtimeRoot), f.directory, undefined, mcpFixtureIdentityOptions(f.options));
    try {
      const bytes = await stores.artifacts.get(resumed.run.checkpoint, after.state.policy);
      const packet = ResumePacketSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
      assert.equal(packet.kind, 'runtime_resume'); assert.equal(packet.workId, f.workId);
      assert.ok(packet.context.session);
      assert.equal(packet.runtime.status, 'blocked'); assert.equal(packet.context.session.basis.input.messageId, 'original-read');
      assert.equal(packet.context.session.entries.filter((entry: { role: string; text: string }) => entry.role === 'user' && entry.text === MCP_AGENT_TEXT).length, 1);
      assert.deepEqual(packet.context.evidence, []); assert.equal(packet.runtime.artifacts.some((ref: ArtifactRef) => ref.id === f.raw.id), false);
      noBody(packet, f.raw, f.options);
    } finally { await stores.close(); }
    const again = await cli(f, 'resume', false); assert.ok(again); noBody(again, f.raw, f.options); assert.equal(again.snapshot.status, 'blocked');
    const repeated = await f.inspect(); f.unchangedOriginal(repeated);
    assert.equal(repeated.events.filter(event => event.type === 'tool_execution_usage_recorded').length, 1);
    assertNoExtraExecution(f.options);
  });

  test(`${backend}: CLI status stays read-only; resume accounts once then refuses the now-inaccessible original session input`, { timeout: 45000 }, async t => {
    const f = await seed(t, backend, 'cli');
    const status = await cli(f, 'status'); noBody(status, f.raw, f.options);
    assert.ok(status); assert.equal(status.snapshot.resultReady, false); assert.deepEqual(await f.inspect(), f.before); assertNoExtraExecution(f.options);
    const discoveries = readMcpAudit(f.options.auditFile).filter(row => row.method === 'tools/list').length;
    await cli(f, 'resume');
    const after = await f.inspect(); f.unchangedOriginal(after);
    assert.equal(after.attempt.execution?.mode, 'invoked'); assert.equal(after.attempt.execution?.usage.transportCalls, 1);
    assert.equal(after.events.filter(event => event.type === 'tool_execution_usage_recorded').length, 1);
    assert.equal(after.state.status, 'blocked');
    assert.deepEqual(after.state.conversation?.session, f.before.state.conversation?.session);
    assertNoExtraExecution(f.options);
    const blocked = await cli(f, 'status'); assert.ok(blocked); noBody(blocked, f.raw, f.options);
    assert.equal(blocked.snapshot.status, 'blocked'); assert.equal(blocked.snapshot.resultReady, false);
    assert.deepEqual(await f.inspect(), after, 'status does not retry accounting or construct a partial context');
    await cli(f, 'resume');
    const repeated = await f.inspect(); f.unchangedOriginal(repeated);
    assert.equal(repeated.events.filter(event => event.type === 'tool_execution_usage_recorded').length, 1);
    assert.deepEqual(repeated.attempt.execution, after.attempt.execution); assertNoExtraExecution(f.options);
    assert.ok(readMcpAudit(f.options.auditFile).filter(row => row.method === 'tools/list').length > discoveries,
      'new profile lifetimes perform discovery; this test does not claim offline startup');
  });

  test(`${backend}: HTTP view stays read-only and cancel reconciles once while preserving cancelled state across server reopen`, { timeout: 45000 }, async t => {
    const f = await seed(t, backend, 'web'); let web = await connect(f); f.cleanupWith(() => web.app.close());
    const view = await web.request<WorkViewResult>(`/api/works/${f.workId}/view`); noBody(view, f.raw, f.options);
    assert.equal(view.kind, 'snapshot'); assert.deepEqual(await f.inspect(), f.before); assertNoExtraExecution(f.options);
    const command = { requestId: 'cancel-original-read', kind: 'cancel', expectedGoalRevision: 1,
      reason: 'user_requested_cancel', rawText: '이 원자료 확인 작업을 취소해 줘.' };
    const cancelled = await web.request<WebCommandResult>(`/api/works/${f.workId}/commands`, command); noBody(cancelled, f.raw, f.options);
    assert.equal(cancelled.duplicate, false); assert.equal(cancelled.view.kind, 'snapshot');
    if (cancelled.view.kind !== 'snapshot') assert.fail('expected cancellation snapshot');
    assert.equal(cancelled.view.view.progress.status, 'cancelled'); assert.equal(cancelled.view.view.progress.resultReady, false);
    const after = await f.inspect(); f.unchangedOriginal(after);
    assert.equal(after.state.status, 'cancelled'); assert.equal(after.attempt.execution?.usage.transportCalls, 1);
    assert.equal(after.events.filter(event => event.type === 'tool_execution_usage_recorded').length, 1);
    assert.equal(after.history.entries.filter(entry => entry.role === 'user' && entry.text === command.rawText).length, 1);
    assert.notDeepEqual(after.state.conversation?.session?.input, f.before.state.conversation?.session?.input,
      'the explicit cancellation is a new applied input; the original request receipt remains unchanged');
    assert.equal(web.observed.modelInputs.length, 0); await web.app.close(); assertMcpPeersStopped(f.options.auditFile);
    web = await connect(f);
    noBody(await web.request<WorkViewResult>(`/api/works/${f.workId}/view`), f.raw, f.options);
    assert.deepEqual(await f.inspect(), after, 'opening and viewing a completed control command cannot account again');
    const duplicate = await web.request<WebCommandResult>(`/api/works/${f.workId}/commands`, command); noBody(duplicate, f.raw, f.options);
    assert.equal(duplicate.duplicate, true);
    const repeated = await f.inspect(); f.unchangedOriginal(repeated);
    assert.equal(repeated.state.status, 'cancelled'); assert.deepEqual(repeated.attempt.execution, after.attempt.execution);
    assert.equal(repeated.events.filter(event => event.type === 'tool_execution_usage_recorded').length, 1);
    assert.equal(repeated.history.entries.filter(entry => entry.role === 'user' && entry.text === command.rawText).length, 1);
    assert.equal(web.observed.modelInputs.length, 0); await web.app.close(); assertMcpPeersStopped(f.options.auditFile); assertNoExtraExecution(f.options);
  });
}
