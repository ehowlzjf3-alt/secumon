import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentLocalProfile, runtimeRoot } from '../presentation/local-profile.js';
import { LocalWorkbench } from '../presentation/local-workbench.js';
import { startWebServer } from '../presentation/web-server.js';
import type { SessionPage, SessionRecord } from '../domain/session.js';
import type { WebAcceptResult, WebCommandResult, WebConversation } from '../presentation/web-contracts.js';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('./helpers/agent-cli-isolated-worker.js', import.meta.url));
const registry = (directory: string) => join(dirname(directory), 'registry');
const actor = { tenantId: 'synthetic', principalId: 'learner' };
type Backend = 'sqlite' | 'file-journal';
function fixture(backend: Backend) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'persistent-presentation-'))); const directory = join(base, 'agent');
  const profile = new FileAgentProfileStore(runtimeRoot).initialize(directory);
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ ...profile.config, storage: { ...profile.config.storage, state: backend } }), { mode: 0o600 });
  return { base, directory, agentId: profile.identity.agentId, close: () => rmSync(base, { recursive: true, force: true }) };
}
async function call<T>(directory: string, args: string[]): Promise<T> {
  const result = await execute(process.execPath, [cli, 'work', ...args, '--directory', directory, '--json'], {
    timeout: 30000, maxBuffer: 2097152, env: { ...process.env, SECUMON_TEST_IDENTITY_REGISTRY: registry(directory) },
  });
  assert.doesNotMatch(result.stdout, /\u001b/); return JSON.parse(result.stdout) as T;
}

for (const backend of ['sqlite', 'file-journal'] as const) test(`${backend}: installed CLI continues X → process restart → Y with exact raw input and owned stores`, async () => {
  const f = fixture(backend);
  try {
    const rawX = '  앞으로 한국어로 답해줘.\n첫 문서도 확인해줘.  ';
    const first = await call<{ workId: string; sessionId: string; snapshot: { status: string } }>(f.directory, ['demo', '--request-id', 'X', '--text', rawX]);
    assert.equal(first.snapshot.status, 'completed'); assert.ok(first.sessionId);
    const reopened = await call<{ session: SessionRecord }>(f.directory, ['session']); assert.equal(reopened.session.scope.sessionId, first.sessionId);
    assert.equal(reopened.session.scope.agentId, f.agentId);
    const rawY = '앞서 정한 한국어 답변 조건을 유지하고 다음 관측을 확인해줘.';
    const accepted = await call<{ workId: string; sessionId: string; accepted: boolean }>(f.directory, ['accept', '--request-id', 'Y', '--scenario', 'observations-simple', '--text', rawY]);
    assert.equal(accepted.sessionId, first.sessionId); assert.notEqual(accepted.workId, first.workId);
    const duplicate = await call<{ workId: string; accepted: boolean }>(f.directory, ['accept', '--request-id', 'Y', '--scenario', 'observations-simple', '--text', rawY]);
    assert.equal(duplicate.workId, accepted.workId); assert.equal(duplicate.accepted, false);
    const history = await call<SessionPage>(f.directory, ['history']);
    assert.deepEqual(history.entries.filter(entry => entry.role === 'user').map(entry => entry.text), [rawX, rawY]);
    assert.equal(history.entries.filter(entry => entry.workId === first.workId && entry.kind === 'result').length, 1);
    const profile = await openAgentLocalProfile(f.directory, {}, undefined, { identityRegistryDirectory: registry(f.directory) });
    try {
      const state = await profile.runtime.state(accepted.workId);
      const prepared = await profile.context.prepare(state, { callId: 'presentation-Y', maxOutputTokens: 1000, maxInputBytes: 524288, maxInputTokens: 131072 });
      assert.ok(prepared.packet.session?.entries.some(entry => entry.text === rawX));
      assert.ok(prepared.packet.session?.entries.some(entry => entry.text === rawY));
      assert.equal(state.contextHead, undefined); assert.equal(state.evidence.length, 0); assert.equal(state.budget.used.toolCalls, 0);
      assert.equal(profile.stateBackend, backend);
    } finally { await profile.close(); }
    assert.equal(existsSync(join(f.directory, 'state.sqlite')), false);
    assert.equal(existsSync(join(f.directory, 'knowledge.sqlite')), false);
    assert.equal(existsSync(join(f.directory, 'channel.sqlite')), false);
  } finally { f.close(); }
});

test('installed CLI input is durable once, new sessions are explicit, and foreign agent sessions remain unavailable', async () => {
  const f = fixture('sqlite'); const other = fixture('sqlite');
  try {
    const accepted = await call<{ workId: string; sessionId: string }>(f.directory, ['accept', '--request-id', 'first', '--text', '처음 요청']);
    const args = ['input', accepted.workId, '--text', '  추가 합의\n원문 그대로  ', '--goal-revision', '1', '--request-id', 'followup'];
    await call(f.directory, args); await call(f.directory, args);
    const before = await call<SessionPage>(f.directory, ['history']);
    assert.deepEqual(before.entries.filter(entry => entry.role === 'user').map(entry => entry.text), ['처음 요청', '  추가 합의\n원문 그대로  ']);
    const newSession = await call<{ session: SessionRecord }>(f.directory, ['session', '--new-session']); assert.notEqual(newSession.session.scope.sessionId, accepted.sessionId);
    assert.deepEqual((await call<SessionPage>(f.directory, ['history'])).entries, []);
    assert.deepEqual(await call(f.directory, ['list']), { workIds: [] });
    await assert.rejects(call(f.directory, ['work-view', accepted.workId]), /session_work_unavailable/);
    await assert.rejects(call(f.directory, ['pause', accepted.workId, '--goal-revision', '1']), /session_work_unavailable/);
    assert.deepEqual((await call<SessionPage>(f.directory, ['history', '--session', accepted.sessionId])).entries, before.entries);
    await assert.rejects(call(other.directory, ['history', '--session', accepted.sessionId]), /session_unavailable/);
    await assert.rejects(call(f.directory, ['accept', '--request-id', 'missing-original']), /session_text_required/);
    await assert.rejects(call(f.directory, ['history', '--state-backend', 'file-journal']), /agent_storage_option_conflict/);
    assert.equal(JSON.parse(readFileSync(join(f.directory, 'config.json'), 'utf8')).storage.state, 'sqlite');
  } finally { f.close(); other.close(); }
});

for (const backend of ['sqlite', 'file-journal'] as const) test(`${backend}: Web auth reconnect preserves one durable conversation and common atomic question intake`, async () => {
  const f = fixture(backend); let profile = await openAgentLocalProfile(f.directory, {}, undefined, { identityRegistryDirectory: registry(f.directory) });
  let workbench = new LocalWorkbench(profile); await workbench.initializeSession(); let web = await startWebServer(workbench);
  try {
    async function login() {
      const response = await fetch(`${web.origin}/api/session`, { method: 'POST', headers: { Origin: web.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: new URL(web.connectUrl).hash.slice(9) }) });
      assert.equal(response.status, 200); const value = await response.json() as { csrf: string };
      return { Cookie: response.headers.get('set-cookie')!.split(';')[0]!, Origin: web.origin, 'Content-Type': 'application/json', 'X-Work-CSRF': value.csrf };
    }
    let headers = await login();
    async function post<T>(path: string, body: unknown): Promise<T> {
      const response = await fetch(`${web.origin}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
      const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value as T;
    }
    const rawX = '  첫 요청. 한국어로 안내해줘.\n원문 보존  ';
    const first = await post<WebAcceptResult>('/api/works', { requestId: 'X', scenarioId: 'documents-question', mode: 'auto', rawText: rawX });
    assert.ok(first.sessionId);
    const receipt = await profile.services.state.receipt(first.workId, 'conversation.accept'); assert.ok(receipt);
    const initial = await profile.runtime.state(first.workId); assert.equal(initial.status, 'waiting');
    assert.equal(profile.services.planner.destination, 'local');
    assert.ok(initial.policy.disclosure?.destinations.find(value => value.destination === 'local')?.surfaces.includes('model'));
    assert.ok(initial.obligations.some(value => value.id === 'document-selection-g1' && value.status === 'pending'));
    const rawReply = '  현행 문서를 선택합니다.\n확인 완료  ';
    const command = { requestId: 'answer-X', kind: 'resolve', expectedGoalRevision: 1, obligationId: 'document-selection-g1', reason: rawReply.trim(), rawText: rawReply };
    await post<WebCommandResult>(`/api/works/${first.workId}/commands`, command);
    assert.equal((await post<WebCommandResult>(`/api/works/${first.workId}/commands`, command)).duplicate, true);
    await post(`/api/works/${first.workId}/commands`, { requestId: 'run-X', kind: 'run', expectedGoalRevision: 1 });
    const completed = await profile.runtime.state(first.workId); assert.equal(completed.status, 'completed'); assert.equal(completed.budget.used.modelCalls, 0);
    const oldCookie = headers.Cookie; await web.close(); await profile.close();
    profile = await openAgentLocalProfile(f.directory, {}, undefined, { identityRegistryDirectory: registry(f.directory) }); workbench = new LocalWorkbench(profile); await workbench.initializeSession(); web = await startWebServer(workbench);
    assert.equal((await fetch(`${web.origin}/api/session`, { headers: { Cookie: oldCookie } })).status, 401); headers = await login();
    const second = await post<WebAcceptResult>('/api/works', { requestId: 'Y', scenarioId: 'observations-simple', mode: 'auto', rawText: '그 합의를 이어서 다음 업무를 시작해줘.' });
    assert.equal(second.sessionId, first.sessionId);
    const followup = { requestId: 'followup-Y', expectedGoalRevision: 1, rawText: '  보고 순서는 이전대로  ' };
    await post(`/api/works/${second.workId}/inputs`, followup);
    assert.equal((await post<WebCommandResult>(`/api/works/${second.workId}/inputs`, followup)).duplicate, true);
    const response = await fetch(`${web.origin}/api/conversation`, { headers }); assert.equal(response.status, 200);
    const history = await response.json() as WebConversation;
    assert.equal(history.sessionId, first.sessionId);
    assert.deepEqual(history.entries.filter(entry => entry.role === 'user').map(entry => entry.text), [rawX, rawReply, '그 합의를 이어서 다음 업무를 시작해줘.', followup.rawText]);
    assert.equal(history.entries.filter(entry => entry.kind === 'result').length, 1);
    const otherUser = new LocalWorkbench(profile, { ...actor, principalId: 'another-person' }); await otherUser.initializeSession();
    assert.deepEqual((await otherUser.history()).entries, []); await assert.rejects(otherUser.view(first.workId));
    const anotherSession = new LocalWorkbench(profile, actor, 'web', { newSession: true }); await anotherSession.initializeSession();
    assert.deepEqual((await anotherSession.history()).entries, []); assert.deepEqual((await anotherSession.list()).items, []);
    await assert.rejects(anotherSession.view(second.workId), /session_work_unavailable/);
    await assert.rejects(anotherSession.input(second.workId, { ...followup, requestId: 'wrong-session' }), /session_work_unavailable/);
    await assert.rejects(anotherSession.command(second.workId, { requestId: 'wrong-command', kind: 'pause', expectedGoalRevision: 1, rawText: '일시 정지' }), /session_work_unavailable/);
    await assert.rejects(anotherSession.attach({ requestId: 'wrong-attach', workId: first.workId }), /session_attach_unsupported/);
    const explicitlyResumed = new LocalWorkbench(profile, actor, 'web', { sessionId: first.sessionId! }); await explicitlyResumed.initializeSession();
    assert.equal((await explicitlyResumed.view(second.workId)).kind, 'snapshot');
    const missingRaw = await fetch(`${web.origin}/api/works`, { method: 'POST', headers, body: JSON.stringify({ requestId: 'missing', scenarioId: 'documents-simple', mode: 'auto', title: '제목은 원문이 아니다' }) });
    assert.equal(missingRaw.status, 400); assert.deepEqual(await missingRaw.json(), { code: 'session_text_required' });
    const disconnect = await fetch(`${web.origin}/api/session`, { method: 'DELETE', headers }); assert.equal(disconnect.status, 200);
    assert.deepEqual((await workbench.history()).entries, history.entries);
  } finally { await web.close(); await profile.close(); f.close(); }
});
