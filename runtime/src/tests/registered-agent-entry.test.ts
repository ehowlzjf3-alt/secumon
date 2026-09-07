import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { SYNTHETIC_AGENT_TURN_REQUESTS as texts } from '../infrastructure/synthetic-agent-turn.js';
import { createLocalContractHost, LOCAL_CONTRACT_MODEL_PROFILE } from '../presentation/local-contract-model.js';
import { openAgentWeb } from '../presentation/agent-web.js';
import { openAgentTurnProfile } from '../presentation/agent-turn-profile.js';
import type { AgentTurnHost } from '../presentation/host-models.js';
import type { WebAcceptResult, WebCommandResult, WorkbenchConfig } from '../presentation/web-contracts.js';
import type { SessionPage } from '../domain/session.js';
import type { WorkViewResult } from '../domain/work-view.js';

const execute = promisify(execFile);
const runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
const cli = fileURLToPath(new URL('../presentation/agent-cli.js', import.meta.url));

function fixture(t: TestContext, profileName = LOCAL_CONTRACT_MODEL_PROFILE) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'registered-entry-'))), directory = join(base, 'agent');
  const profile = new FileAgentProfileStore(runtimeRoot).initialize(directory);
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ ...profile.config, model: { profile: profileName } }), { mode: 0o600 });
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, directory };
}
async function call<T>(directory: string, args: string[]): Promise<T> {
  const result = await execute(process.execPath, [cli, 'chat', ...args, '--directory', directory, '--provider', 'registered', '--json'],
    { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(result.stdout) as T;
}
interface Chat {
  provider: string; notice: string; modelInfo: { profileName: string; execution: string; compact: boolean };
  sessionId: string; workId: string; accepted: boolean;
  snapshot: { status: string; resultDelivery: string; usage: { modelCalls: number; toolCalls: number } };
}

test('installed registered chat selects the C01 name, executes one read and resumes without another invocation', { timeout: 60000 }, async t => {
  const f = fixture(t);
  const first = await call<Chat>(f.directory, ['ask', '--message-id', 'read', '--text', texts.read, '--mode', 'fast']);
  assert.equal(first.provider, 'registered'); assert.equal(first.modelInfo.profileName, LOCAL_CONTRACT_MODEL_PROFILE);
  assert.equal(first.modelInfo.execution, 'deterministic_fixture'); assert.equal(first.modelInfo.compact, true);
  assert.match(first.notice, /로컬 전송 대역/); assert.equal(first.snapshot.status, 'completed'); assert.equal(first.snapshot.resultDelivery, 'delivered');
  assert.equal(first.snapshot.usage.modelCalls, 2); assert.equal(first.snapshot.usage.toolCalls, 1);
  const status = await call<Chat>(f.directory, ['status', '--work', first.workId, '--session', first.sessionId]);
  assert.deepEqual(status.snapshot.usage, first.snapshot.usage);
  const retry = await call<Chat>(f.directory, ['ask', '--message-id', 'read', '--text', texts.read, '--mode', 'fast']);
  assert.equal(retry.workId, first.workId); assert.equal(retry.accepted, false); assert.deepEqual(retry.snapshot.usage, first.snapshot.usage);
  const second = await call<Chat>(f.directory, ['ask', '--message-id', 'next', '--text', texts.rewrite]);
  assert.notEqual(second.workId, first.workId); assert.equal(second.sessionId, first.sessionId); assert.equal(second.snapshot.status, 'completed');
  const history = await call<SessionPage>(f.directory, ['history']);
  assert.deepEqual(history.entries.filter(entry => entry.role === 'user').map(entry => entry.text), [texts.read, texts.rewrite]);
  const profile = await openAgentTurnProfile(f.directory, { provider: 'registered' }, createLocalContractHost());
  try {
    const state = await profile.runtime.state(first.workId);
    assert.equal(state.attempts.length, 1); assert.equal(state.attempts[0]!.status, 'succeeded');
    assert.deepEqual(state.generatedAnswer?.evidenceIds, ['doc-current']);
    assert.ok(state.modelCalls.every(item => item.status === 'accepted' && !!item.inputProfileDigest));
    assert.equal(state.budget.reservedTokens, 0);
  } finally { await profile.close(); }
});

test('registered CLI never falls back for unknown names or mixed provider options', { timeout: 60000 }, async t => {
  const f = fixture(t, '../unregistered-module.js');
  await assert.rejects(call(f.directory, ['ask', '--message-id', 'unavailable', '--text', texts.rewrite]), /agent_turn_provider_unavailable/);
  await assert.rejects(call(f.directory, ['session', '--compact-provider', 'synthetic']), /invalid_compact_provider/);
});

test('Web startup accepts the same host registration, carries call limits and keeps HTTP selection read-only', { timeout: 60000 }, async t => {
  const name = 'company-local-test', f = fixture(t, name), base = createLocalContractHost().models.get(LOCAL_CONTRACT_MODEL_PROFILE)!;
  const lifetime = { opened: 0, closed: 0 };
  const host: AgentTurnHost = { models: new Map([[name, { execution: 'deterministic_fixture', async open(prompt) {
    lifetime.opened++; const lease = await base.open(prompt);
    return { ...lease, inputLimits: { maxInputBytes: 65536, maxOutputTokens: 512 }, async close() { lifetime.closed++; await lease.close(); } };
  } }]]) };
  const opened = await openAgentWeb(['--directory', f.directory, '--provider', 'registered', '--conversation', 'company'], host);
  assert.ok(opened); const general = opened.profile.general!;
  try {
    assert.equal(lifetime.opened, 1); assert.match(opened.notice, /로컬 전송 대역/);
    const login = await fetch(opened.server.origin + '/api/session', { method: 'POST', headers: { Origin: opened.server.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: new URL(opened.server.connectUrl).hash.slice(9) }), signal: AbortSignal.timeout(30000) });
    assert.equal(login.status, 200);
    const session = await login.json() as { csrf: string; config: WorkbenchConfig };
    assert.equal(session.config.profile, 'local-registered'); assert.equal(session.config.model, 'registered-agent-turn');
    assert.equal(session.config.modelInfo?.profileName, name); assert.equal(session.config.modelInfo?.execution, 'deterministic_fixture');
    assert.equal(session.config.compactProvider, 'registered');
    const headers = { Cookie: login.headers.get('set-cookie')!.split(';')[0]!, Origin: opened.server.origin,
      'Content-Type': 'application/json', 'X-Work-CSRF': session.csrf };
    async function request<T>(path: string, body?: unknown, status = 200): Promise<T> {
      const result = await fetch(opened!.server.origin + path, { headers, signal: AbortSignal.timeout(30000),
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      const value: unknown = await result.json(); assert.equal(result.status, status, JSON.stringify(value)); return value as T;
    }
    const accepted = await request<WebAcceptResult>('/api/requests', { requestId: 'read', rawText: texts.read, mode: 'fast' });
    assert.equal((await general.runtime.state(accepted.workId)).modelCalls.length, 0, 'HTTP intake acknowledges without starting a model');
    const response = await request<WebCommandResult>(`/api/works/${accepted.workId}/commands`, { kind: 'run', requestId: 'execute', expectedGoalRevision: 1 });
    assert.equal(response.view.kind, 'snapshot');
    if (response.view.kind !== 'snapshot') assert.fail('expected a snapshot');
    assert.equal(response.view.view.progress.status, 'completed');
    const before = await general.runtime.state(accepted.workId);
    assert.equal(before.attempts.length, 1); assert.equal(before.modelCalls.length, 2);
    assert.ok(before.modelCalls.every(call => call.maxOutputTokens === 512 && !!call.inputProfileDigest));
    await request<WorkViewResult>(`/api/works/${accepted.workId}/view`);
    await request('/api/session'); await request('/api/conversation');
    await request('/api/requests', { requestId: 'injection', rawText: texts.rewrite, mode: 'fast', provider: '../other.js' }, 400);
    assert.deepEqual(await general.runtime.state(accepted.workId), before);
    assert.equal(lifetime.opened, 1);
  } finally { await opened.close(); await opened.close(); }
  assert.deepEqual(lifetime, { opened: 1, closed: 1 });
});

test('Web rejects invalid registered startup options before creating a profile', async t => {
  const f = fixture(t), unused = join(f.base, 'unused');
  for (const args of [
    ['--port', '65536'], ['--provider', 'other'], ['--provider', 'registered', '--compact-provider', 'synthetic'],
    ['--provider', 'registered', '--session', 's', '--new-session'],
  ]) await assert.rejects(openAgentWeb(['--directory', unused, ...args]));
  assert.equal(existsSync(unused), false);
});
