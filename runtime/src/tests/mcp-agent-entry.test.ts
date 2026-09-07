import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { openAgentWeb } from '../presentation/agent-web.js';
import type { WebAcceptResult, WebCommandResult, WorkbenchConfig } from '../presentation/web-contracts.js';
import type { WorkViewResult } from '../domain/work-view.js';
import { createMcpFixtureHost, initializeMcpAgent, MCP_AGENT_TEXT, MCP_AGENT_TOOL } from './mcp-agent-profile-helper.js';

const execute = promisify(execFile);
interface Options { auditFile: string; documentValue: number }
interface Audit { event: string; method?: string; pid?: number }
function audit(options: Options): Audit[] {
  return existsSync(options.auditFile) ? readFileSync(options.auditFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Audit) : [];
}
function calls(options: Options) { return audit(options).filter(entry => entry.event === 'method' && entry.method === 'tools/call').length; }
function stopped(options: Options) {
  const starts = audit(options).filter(entry => entry.event === 'start'); assert.ok(starts.length > 0);
  for (const entry of starts) {
    assert.ok(Number.isSafeInteger(entry.pid) && entry.pid! > 0);
    assert.throws(() => process.kill(entry.pid!, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
  }
}
function fixture(t: TestContext, backend: 'sqlite' | 'file-journal') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-agent-entry-'))), directory = join(base, 'agent');
  initializeMcpAgent(directory, backend);
  const options = { auditFile: join(base, 'peer-audit.jsonl'), documentValue: 47 };
  let close = async () => {};
  t.after(async () => {
    try { await close(); if (audit(options).some(entry => entry.event === 'start')) stopped(options); }
    finally { rmSync(base, { recursive: true, force: true }); }
  });
  return { directory, options, cleanupWith(action: () => Promise<void>) { close = action; } };
}
interface Chat {
  workId: string; sessionId: string; snapshot: { status: string; resultDelivery: string; usage: { toolCalls: number; modelCalls: number; tokens: number } };
  messages: { kind: string; text: string }[];
}
async function cli(directory: string, options: Options, args: string[]): Promise<Chat> {
  const program = `import {runAgentTurnCli} from ${JSON.stringify(new URL('../presentation/agent-turn-cli.js', import.meta.url).href)};
import {createMcpFixtureHost} from ${JSON.stringify(new URL('./mcp-agent-profile-helper.js', import.meta.url).href)};
await runAgentTurnCli(process.argv.slice(1),createMcpFixtureHost(${JSON.stringify(options)}).host);`;
  const result = await execute(process.execPath, ['--input-type=module', '-e', program, ...args, '--directory', directory, '--provider', 'registered', '--json'],
    { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  assert.doesNotMatch(result.stdout, /\u001b/); return JSON.parse(result.stdout) as Chat;
}

for (const backend of ['sqlite', 'file-journal'] as const)
  test(`${backend}: a real CLI child uses its MCP peer and reopens without another tools/call`, { timeout: 30000 }, async t => {
    const f = fixture(t, backend);
    const first = await cli(f.directory, f.options, ['ask', '--message-id', 'mcp-read', '--text', MCP_AGENT_TEXT]);
    assert.equal(first.snapshot.status, 'completed'); assert.equal(first.snapshot.resultDelivery, 'delivered');
    assert.equal(first.snapshot.usage.toolCalls, 1); assert.equal(first.snapshot.usage.modelCalls, 2);
    assert.equal(first.messages.find(entry => entry.kind === 'result')?.text, '[합성 MCP 결과] 원자료 값은 47입니다.');
    assert.equal(calls(f.options), 1); stopped(f.options);
    const beforeDiscovery = audit(f.options).filter(entry => entry.method === 'tools/list').length;
    const again = await cli(f.directory, f.options, ['resume', '--work', first.workId, '--session', first.sessionId, '--goal-revision', '1']);
    assert.deepEqual(again.snapshot.usage, first.snapshot.usage); assert.equal(calls(f.options), 1); stopped(f.options);
    assert.ok(audit(f.options).filter(entry => entry.method === 'tools/list').length > beforeDiscovery, 'reopening discovers the new peer separately from reading the source');
    const p = await openAgentTurnProfile(f.directory, { provider: 'registered' }, createMcpFixtureHost(f.options).host);
    try {
      const state = await p.runtime.state(first.workId), attempt = state.attempts[0]!;
      assert.equal(attempt.toolId, MCP_AGENT_TOOL); assert.match(attempt.toolVersion, /^1\.[a-f0-9]{24}$/);
      assert.equal(state.evidence[0]!.facts.value, 47); assert.equal(state.evidence[0]!.scope, p.scope);
      const response = await p.services.state.receipt(first.workId, `mcp-response:${attempt.id}`); assert.ok(response);
      assert.ok(await p.services.state.receipt(first.workId, `mcp-intent:${attempt.id}`));
      const ref = response.state.artifacts.at(-1)!;
      const raw = JSON.parse(new TextDecoder().decode(await p.services.artifacts.get(ref, state.policy)));
      assert.equal(raw.kind, 'mcp_decoded_response'); assert.equal(raw.attemptId, attempt.id);
      assert.equal(raw.value.structuredContent.value, 47); assert.equal(raw.value.structuredContent.id, 'good');
      assert.equal(raw.transportCalls, 1); assert.equal(attempt.execution?.usage.transportCalls, 1);
      const history = await p.sessions.history(p.actor, first.sessionId, p.policy, { limit: 100 });
      assert.equal(history.entries.filter(entry => entry.role === 'user' && entry.text === MCP_AGENT_TEXT).length, 1);
      assert.equal(history.entries.filter(entry => entry.role === 'assistant' && entry.text === first.messages.find(entry => entry.kind === 'result')!.text).length, 1);
    } finally { await p.close(); }
    assert.equal(calls(f.options), 1); stopped(f.options);
  });

async function connect(directory: string, options: Options, sessionId?: string) {
  const f = createMcpFixtureHost(options);
  const app = await openAgentWeb(['--directory', directory, '--provider', 'registered', '--conversation', 'mcp-fixture',
    ...(sessionId ? ['--session', sessionId] : [])], f.host); assert.ok(app);
  try {
    const login = await fetch(`${app.server.origin}/api/session`, { method: 'POST', headers: { Origin: app.server.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: new URL(app.server.connectUrl).hash.slice(9) }), signal: AbortSignal.timeout(30000) });
    assert.equal(login.status, 200); const session = await login.json() as { csrf: string; config: WorkbenchConfig };
    const headers = { Cookie: login.headers.get('set-cookie')!.split(';')[0]!, Origin: app.server.origin, 'Content-Type': 'application/json', 'X-Work-CSRF': session.csrf };
    async function request<T>(path: string, body?: unknown, expected = 200): Promise<T> {
      const response = await fetch(`${app!.server.origin}${path}`, { headers, signal: AbortSignal.timeout(30000),
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      const value: unknown = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value as T;
    }
    return { app, request, observed: f.observed };
  } catch (error) { await app.close(); throw error; }
}

for (const backend of ['sqlite', 'file-journal'] as const)
  test(`${backend}: localhost HTTP binds MCP on the host and preserves its result across a new server lifetime`, { timeout: 30000 }, async t => {
    const f = fixture(t, backend); let web = await connect(f.directory, f.options);
    f.cleanupWith(() => web.app.close());
    const accepted = await web.request<WebAcceptResult>('/api/requests', { requestId: 'read-mcp', rawText: MCP_AGENT_TEXT, mode: 'auto' });
    assert.equal(calls(f.options), 0); assert.equal(web.observed.modelInputs.length, 0);
    const done = await web.request<WebCommandResult>(`/api/works/${accepted.workId}/commands`, { requestId: 'run-mcp', kind: 'run', expectedGoalRevision: 1 });
    assert.equal(done.view.kind, 'snapshot'); if (done.view.kind !== 'snapshot') assert.fail('expected result view');
    assert.equal(done.view.view.progress.status, 'completed');
    assert.equal(done.view.view.messages.find(entry => entry.kind === 'result')?.text, '[합성 MCP 결과] 원자료 값은 47입니다.');
    assert.equal(calls(f.options), 1); assert.equal(web.observed.modelInputs.length, 2);
    await web.request('/api/requests', { requestId: 'inject-mcp', rawText: MCP_AGENT_TEXT, mode: 'auto',
      command: 'untrusted-executable', env: { API_KEY: 'untrusted-text' }, providerSources: [] }, 400);
    const state = await web.app.profile.general!.runtime.state(accepted.workId);
    const history = await web.request('/api/conversation');
    await web.app.close(); stopped(f.options);
    web = await connect(f.directory, f.options, accepted.sessionId!);
    await web.request<WorkViewResult>(`/api/works/${accepted.workId}/view`);
    assert.deepEqual(await web.request('/api/conversation'), history);
    assert.deepEqual(await web.app.profile.general!.runtime.state(accepted.workId), state);
    assert.equal(calls(f.options), 1); assert.equal(web.observed.modelInputs.length, 0);
    await web.app.close(); stopped(f.options);
  });
