import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { openAgentWeb } from '../presentation/agent-web.js';
import type { WebAcceptResult, WebCommandResult, WorkbenchConfig } from '../presentation/web-contracts.js';
import type { WorkViewResult } from '../domain/work-view.js';
import { hostEntryFixture, HOST_ENTRY_PROFILE, HOST_ENTRY_TEXT, HOST_ENTRY_TOOL, type HostEntryOptions } from './host-tool-entry-fixture.js';

const execute = promisify(execFile), runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
function fixture(t: TestContext, backend: 'sqlite' | 'file-journal') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'host-tool-entry-'))), directory = join(base, 'agent');
  const ready = new FileAgentProfileStore(runtimeRoot).initialize(directory);
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ ...ready.config, storage: { ...ready.config.storage, state: backend },
    model: { profile: HOST_ENTRY_PROFILE } }), { mode: 0o600 });
  let close: (() => Promise<void>) | undefined;
  t.after(async () => {
    const errors: unknown[] = [];
    try { await close?.(); } catch (error) { errors.push(error); }
    try { rmSync(base, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'host_entry_cleanup_failed', { cause: errors[0] });
  });
  return { base, directory, callsFile: join(base, 'source-calls.log'), beforeRemove(callback: () => Promise<void>) { close = callback; } };
}
interface Chat { workId: string; sessionId: string; accepted: boolean; snapshot: { status: string; resultDelivery: string;
  usage: { toolCalls: number; modelCalls: number; tokens: number } }; messages: { kind: string; text: string }[] }
async function cli(directory: string, options: HostEntryOptions, args: string[]): Promise<Chat> {
  const program = `import {runAgentTurnCli} from ${JSON.stringify(new URL('../presentation/agent-turn-cli.js', import.meta.url).href)};
import {hostEntryFixture} from ${JSON.stringify(new URL('./host-tool-entry-fixture.js', import.meta.url).href)};
await runAgentTurnCli(process.argv.slice(1),hostEntryFixture(${JSON.stringify(options)}).host);`;
  const result = await execute(process.execPath, ['--input-type=module', '-e', program, ...args, '--directory', directory, '--provider', 'registered', '--json'],
    { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  assert.doesNotMatch(result.stdout, /\u001b/); return JSON.parse(result.stdout) as Chat;
}

for (const backend of ['sqlite', 'file-journal'] as const) test(`${backend}: a host-wired CLI executes a non-fixture tool and reopens the same raw session without another read`, async t => {
  const f = fixture(t, backend), options = { text: '이 담당 원본의 보존기간은 17일입니다.', callsFile: f.callsFile };
  const first = await cli(f.directory, options, ['ask', '--message-id', 'read', '--text', HOST_ENTRY_TEXT]);
  assert.equal(first.snapshot.status, 'completed'); assert.equal(first.snapshot.resultDelivery, 'delivered');
  assert.equal(first.snapshot.usage.toolCalls, 1); assert.equal(first.snapshot.usage.modelCalls, 2);
  assert.equal(first.messages.find(item => item.kind === 'result')?.text, options.text);
  const second = await cli(f.directory, options, ['resume', '--work', first.workId, '--session', first.sessionId, '--goal-revision', '1']);
  assert.deepEqual(second.snapshot.usage, first.snapshot.usage);
  assert.equal(readFileSync(f.callsFile, 'utf8').trim().split('\n').length, 1);
  const profile = await openAgentTurnProfile(f.directory, { provider: 'registered' }, hostEntryFixture(options).host);
  try {
    const state = await profile.runtime.state(first.workId);
    assert.equal(state.attempts[0]!.toolId, HOST_ENTRY_TOOL); assert.equal(state.evidence[0]!.facts.summary, options.text);
    assert.equal(state.evidence[0]!.scope, profile.scope); assert.ok(state.attempts[0]!.resultArtifact);
    const raw = JSON.parse(new TextDecoder().decode(await profile.services.artifacts.get(state.attempts[0]!.resultArtifact!, state.policy)));
    assert.equal(raw.output.summary, options.text);
    const history = await profile.sessions.history(profile.actor, first.sessionId, profile.policy, { limit: 100 });
    assert.equal(history.entries.filter(entry => entry.role === 'user' && entry.text === HOST_ENTRY_TEXT).length, 1);
    assert.equal(history.entries.filter(entry => entry.role === 'assistant' && entry.text === options.text).length, 1);
  } finally { await profile.close(); }
  await assert.rejects(cli(f.directory, { ...options, allowRead: false }, ['resume', '--work', first.workId, '--session', first.sessionId]), /policy_insufficient|execution_authority/);
  assert.equal(readFileSync(f.callsFile, 'utf8').trim().split('\n').length, 1);
});

async function connect(directory: string, options: HostEntryOptions, sessionId?: string) {
  const f = hostEntryFixture(options), app = await openAgentWeb(['--directory', directory, '--provider', 'registered', '--conversation', 'company',
    ...(sessionId ? ['--session', sessionId] : [])], f.host);
  assert.ok(app);
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
    return { app, observed: f.observed, config: session.config, request };
  } catch (error) {
    try { await app.close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'host_entry_connect_cleanup_failed', { cause: error }); }
    throw error;
  }
}

for (const backend of ['sqlite', 'file-journal'] as const) test(`${backend}: native HTTP keeps host registration out of requests and connects one read through evidence and reconnect`, async t => {
  const f = fixture(t, backend), options = { text: '웹 담당의 원본 결과입니다.', callsFile: f.callsFile };
  let web = await connect(f.directory, options); f.beforeRemove(() => web.app.close());
  const first = await web.request<WebAcceptResult>('/api/requests', { requestId: 'read', rawText: HOST_ENTRY_TEXT, mode: 'auto' });
  assert.equal(web.observed.modelInputs.length, 0); assert.equal(web.observed.reads, 0);
  const done = await web.request<WebCommandResult>(`/api/works/${first.workId}/commands`, { requestId: 'run', kind: 'run', expectedGoalRevision: 1 });
  assert.equal(done.view.kind, 'snapshot'); if (done.view.kind !== 'snapshot') assert.fail('expected snapshot');
  assert.equal(done.view.view.progress.status, 'completed'); assert.equal(done.view.view.messages.find(item => item.kind === 'result')?.text, options.text);
  assert.equal(web.observed.reads, 1); assert.equal(web.observed.modelInputs.length, 2);
  assert.ok(web.observed.modelInputs.every(input => !JSON.stringify(input).includes('fixture.read')));
  await web.request('/api/requests', { requestId: 'inject', rawText: HOST_ENTRY_TEXT, mode: 'auto', tools: ['other'], policy: { allowWrites: true } }, 400);
  const before = await web.app.profile.general!.runtime.state(first.workId);
  await web.app.close(); assert.equal(web.observed.toolCloses, 1); assert.equal(web.observed.modelCloses, 1);
  web = await connect(f.directory, options, first.sessionId!);
  await web.request<WorkViewResult>(`/api/works/${first.workId}/view`); await web.request('/api/conversation');
  assert.equal(web.observed.modelInputs.length, 0); assert.equal(web.observed.reads, 0);
  assert.deepEqual(await web.app.profile.general!.runtime.state(first.workId), before);
  assert.equal(readFileSync(f.callsFile, 'utf8').trim().split('\n').length, 1);
  const pending = await web.request<WebAcceptResult>('/api/requests', { requestId: 'needs-execution', rawText: HOST_ENTRY_TEXT, mode: 'auto' });
  const pendingBefore = await web.app.profile.general!.runtime.state(pending.workId);
  await web.app.close(); web = await connect(f.directory, { ...options, allowRead: false }, first.sessionId!);
  const denied = await web.request<{ code: string }>(`/api/works/${pending.workId}/commands`,
    { requestId: 'run-after-host-restriction', kind: 'run', expectedGoalRevision: 1 }, 403);
  assert.match(denied.code, /workflow_policy_insufficient|execution_authority_denied|resume_policy_insufficient/);
  assert.equal(web.observed.reads, 0); assert.equal(web.observed.modelInputs.length, 0);
  assert.deepEqual((await web.app.profile.general!.runtime.state(first.workId)).budget, before.budget);
  assert.deepEqual((await web.app.profile.general!.runtime.state(pending.workId)).budget, pendingBefore.budget);
});

test('a new CLI request cannot invoke a registered tool outside the host policy', async t => {
  const f = fixture(t, 'sqlite'), options = { text: '금지된 원본', callsFile: f.callsFile, allowRead: false };
  const result = await cli(f.directory, options, ['ask', '--message-id', 'forbidden', '--text', HOST_ENTRY_TEXT, '--steps', '12']);
  assert.notEqual(result.snapshot.status, 'completed'); assert.equal(result.snapshot.usage.toolCalls, 0);
  assert.equal(existsSync(f.callsFile), false);
});
