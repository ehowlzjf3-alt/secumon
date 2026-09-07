import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentLocalProfile, openLocalProfile, runtimeRoot } from '../presentation/local-profile.js';
import { LocalWorkbench } from '../presentation/local-workbench.js';
import { startWebServer } from '../presentation/web-server.js';
import type { KnowledgeCard, KnowledgeSearch } from '../domain/knowledge.js';
import type { PersonalRememberInput } from '../presentation/local-personal-memory.js';
import type { WebAcceptResult, WebConversation } from '../presentation/web-contracts.js';
import { ContextFrameSchema } from '../application/context-contracts.js';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('./helpers/agent-cli-isolated-worker.js', import.meta.url));
const actor = { tenantId: 'synthetic', principalId: 'learner' };
const original = '개인 기억 표면 시험: 보고서는 한국어로 작성하고 원문을 보존해 주세요.';
const corrected = '개인 기억 정정: 보고서는 한국어로 작성하고 표보다 간결한 문장을 우선해 주세요.';
function fixture(backend: 'sqlite' | 'file-journal' = 'sqlite') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'personal-memory-presentation-'))), directory = join(base, 'agent');
  const ready = new FileAgentProfileStore(runtimeRoot).initialize(directory);
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ ...ready.config, storage: { ...ready.config.storage, state: backend } }), { mode: 0o600 });
  const hostOptions = { identityRegistryDirectory: join(base, 'registry') };
  return { base, directory, hostOptions, close: () => rmSync(base, { recursive: true, force: true }) };
}
async function login(web: Awaited<ReturnType<typeof startWebServer>>) {
  const response = await fetch(`${web.origin}/api/session`, { method: 'POST', headers: { Origin: web.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: new URL(web.connectUrl).hash.slice(9) }) });
  assert.equal(response.status, 200); const value = await response.json() as { csrf: string };
  return { Cookie: response.headers.get('set-cookie')!.split(';')[0]!, Origin: web.origin, 'Content-Type': 'application/json', 'X-Work-CSRF': value.csrf };
}
async function seed(workbench: LocalWorkbench, requestId = 'initial', rawText = original) {
  await workbench.initializeSession();
  return workbench.accept({ requestId, scenarioId: 'documents-simple', mode: 'auto', rawText });
}
function remember(sessionId: string, id = 'report-style'): PersonalRememberInput {
  return { requestId: 'remember-report-style', id, title: '보고서 표현', source: { kind: 'existing', sessionId, messageId: 'initial', quote: original } };
}
async function prepare(profile: Awaited<ReturnType<typeof openAgentLocalProfile>>, workId: string) {
  const state = await profile.runtime.state(workId);
  const prepared = await profile.context.prepare(state, { callId: `inspect-${state.revision}`, maxOutputTokens: 1000, maxInputBytes: 524288, maxInputTokens: 131072 });
  const stored = ContextFrameSchema.parse(JSON.parse(new TextDecoder().decode(await profile.services.artifacts.get(prepared.head.artifact, state.policy))));
  assert.deepEqual(stored.packet, prepared.packet); return prepared;
}

for (const backend of ['sqlite', 'file-journal'] as const) test(`${backend}: Web personal memory crosses a completed work and restart, with explicit current-version recall and forget`, async () => {
  const f = fixture(backend); let profile = await openAgentLocalProfile(f.directory, {}, undefined, f.hostOptions); let workbench = new LocalWorkbench(profile);
  let web = await startWebServer(workbench); let headers = await login(web);
  const request = async <T>(path: string, body?: unknown, expected = 200): Promise<T> => {
    const response = await fetch(`${web.origin}${path}`, { headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const value: unknown = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value as T;
  };
  try {
    const x = await request<WebAcceptResult>('/api/works', { requestId: 'initial', scenarioId: 'documents-simple', mode: 'auto', rawText: original }); assert.ok(x.sessionId);
    const beforeRemember = await workbench.history();
    assert.deepEqual((await request<Pick<KnowledgeSearch, 'cards' | 'index'>>('/api/memories')).cards, []);
    const input = remember(x.sessionId);
    const saved = await request<{ card: KnowledgeCard }>('/api/memories/remember', input);
    assert.equal(saved.card.body, original); assert.equal(saved.card.kind, 'personal'); assert.equal(saved.card.revision, 1);
    assert.equal(saved.card.owner?.agentId, profile.agentId); assert.equal(saved.card.owner?.principalId, actor.principalId);
    assert.deepEqual(await request('/api/memories/remember', input), saved);
    assert.deepEqual(await workbench.history(), beforeRemember, 'management notifications must not become conversation messages');
    assert.equal((await profile.runtime.state(x.workId)).personalMemorySelection, undefined);
    await request(`/api/works/${x.workId}/commands`, { requestId: 'finish-x', expectedGoalRevision: 1, kind: 'run' });
    assert.equal((await profile.runtime.state(x.workId)).status, 'completed');
    await web.close(); await profile.close();
    profile = await openAgentLocalProfile(f.directory, {}, undefined, f.hostOptions); workbench = new LocalWorkbench(profile, actor, 'web', { newSession: true });
    web = await startWebServer(workbench); headers = await login(web);
    const y = await request<WebAcceptResult>('/api/works', { requestId: 'next', scenarioId: 'documents-simple', mode: 'auto', rawText: '다른 세션에서 보고서 형식을 확인합니다.' });
    assert.notEqual(y.sessionId, x.sessionId);
    const searched = await request<Pick<KnowledgeSearch, 'cards' | 'index'>>('/api/memories?query=보고서');
    assert.equal(searched.index.complete, true); assert.equal(searched.cards.length, 1); assert.equal(searched.cards[0]!.id, input.id);
    const unselected = await prepare(profile, y.workId); assert.equal(unselected.packet.personalMemory, undefined);
    let state = await profile.runtime.state(y.workId);
    const selection = { requestId: 'recall-v1', expectedGoalRevision: state.goal.revision, expectedStateRevision: state.revision, refs: [{ id: input.id, revision: 1 }] };
    const selected = await request<{ selectionId: string; applied: boolean }>(`/api/works/${y.workId}/memories`, selection);
    assert.equal(selected.applied, true); assert.equal((await request<{ applied: boolean }>(`/api/works/${y.workId}/memories`, selection)).applied, false);
    const prepared = await prepare(profile, y.workId);
    assert.equal(prepared.packet.personalMemory?.entries[0]?.body, original); assert.equal(prepared.packet.personalMemory?.entries[0]?.ref.revision, 1);
    assert.equal(prepared.packet.personalMemory?.interpretation, 'user_requested_memory_not_verified_evidence');
    state = await profile.runtime.state(y.workId); assert.deepEqual(state.attempts, []); assert.deepEqual(state.modelCalls, []); assert.deepEqual(state.evidence, []);
    assert.equal(state.budget.used.toolCalls, 0); assert.equal(state.budget.used.modelCalls, 0); assert.equal(profile.planning, null);
    const revision = await request<{ revision: number }>('/api/memories/revise', { id: input.id, requestId: 'revise-v2', expectedRevision: 1, title: '보고서 표현', reason: '사용자 정정',
      source: { kind: 'new_input', workId: y.workId, messageId: 'correction-source', expectedGoalRevision: 1, rawText: corrected } });
    assert.equal(revision.revision, 2);
    assert.ok((await workbench.history()).entries.some(entry => entry.sourceId === 'correction-source' && entry.text === corrected));
    assert.equal(await profile.context.sourcesCurrent(prepared.packet, await profile.runtime.state(y.workId)), false);
    const unavailable = await request<{ available: boolean; stateRevision: number; goalRevision: number }>(`/api/works/${y.workId}/memories`); assert.equal(unavailable.available, false);
    await request(`/api/works/${y.workId}/memories`, { requestId: 'stale-v1', expectedGoalRevision: unavailable.goalRevision, expectedStateRevision: unavailable.stateRevision,
      refs: [{ id: input.id, revision: 1 }] }, 409);
    await request(`/api/works/${y.workId}/memories`, { requestId: 'recall-v2', expectedGoalRevision: unavailable.goalRevision, expectedStateRevision: unavailable.stateRevision,
      refs: [{ id: input.id, revision: 2 }] });
    assert.equal((await prepare(profile, y.workId)).packet.personalMemory?.entries[0]?.body, corrected);
    const beforeForget = await workbench.history();
    const forgotten = await request<{ revision: number; originalHistoryPreserved: boolean }>('/api/memories/forget', { id: input.id, requestId: 'forget', expectedRevision: 2, reason: '다음 업무에 사용하지 않음' });
    assert.equal(forgotten.revision, 3); assert.equal(forgotten.originalHistoryPreserved, true);
    await request(`/api/memories/${input.id}`, undefined, 403); assert.deepEqual((await request<Pick<KnowledgeSearch, 'cards' | 'index'>>('/api/memories')).cards, []);
    await request('/api/memories/remember', input, 403);
    const current = await request<{ stateRevision: number; goalRevision: number }>(`/api/works/${y.workId}/memories`);
    await request(`/api/works/${y.workId}/memories`, { requestId: 'clear', expectedGoalRevision: current.goalRevision, expectedStateRevision: current.stateRevision, refs: [] });
    assert.equal((await prepare(profile, y.workId)).packet.personalMemory?.entries.length, 0);
    assert.deepEqual(await workbench.history(), beforeForget);
    await web.close(); await profile.close();
    profile = await openAgentLocalProfile(f.directory, {}, undefined, f.hostOptions); workbench = new LocalWorkbench(profile); web = await startWebServer(workbench); headers = await login(web);
    assert.deepEqual((await request<Pick<KnowledgeSearch, 'cards' | 'index'>>('/api/memories')).cards, []);
    await request(`/api/memories/${input.id}`, undefined, 403);
    assert.ok((await request<WebConversation>('/api/conversation')).entries.some(entry => entry.text === corrected));
    const asset = await fetch(`${web.origin}/assets/personal-memory.js`); assert.equal(asset.status, 200); assert.match(await asset.text(), /installPersonalMemoryUI/);
  } finally { await web.close(); await profile.close(); f.close(); }
});

test('installed CLI records a real source and uses explicit memory revision, then clears and forgets after restart', async () => {
  const f = fixture();
  const call = async <T>(args: string[]): Promise<T> => {
    const result = await execute(process.execPath, [cli, 'work', ...args, '--directory', f.directory, '--json'], { timeout: 30000, maxBuffer: 2097152, env: { ...process.env, SECUMON_TEST_IDENTITY_REGISTRY: f.hostOptions.identityRegistryDirectory } });
    return JSON.parse(result.stdout) as T;
  };
  try {
    const x = await call<WebAcceptResult>(['accept', '--request-id', 'initial', '--text', original]); assert.ok(x.sessionId);
    const args = ['memory-remember', '--memory-id', 'style', '--request-id', 'save', '--title', '보고서 표현', '--source-session', x.sessionId, '--source-message', 'initial', '--quote', original];
    const saved = await call<{ card: KnowledgeCard }>(args); assert.equal(saved.card.body, original); assert.deepEqual(await call(args), saved);
    await call(['demo-plan', x.workId]); await call(['run', x.workId]);
    const session = await call<{ session: { scope: { sessionId: string } } }>(['session', '--new-session']); assert.notEqual(session.session.scope.sessionId, x.sessionId);
    const y = await call<WebAcceptResult>(['accept', '--request-id', 'next', '--text', '다음 업무']);
    const found = await call<Pick<KnowledgeSearch, 'cards' | 'index'>>(['memory-search', '--query', '보고서']); assert.equal(found.cards[0]?.id, 'style');
    const basis = await call<{ stateRevision: number }>(['memory-selected', y.workId]);
    await call(['memory-recall', y.workId, '--memory-id', 'style', '--memory-revision', '1', '--request-id', 'select', '--goal-revision', '1', '--state-revision', String(basis.stateRevision)]);
    let profile = await openAgentLocalProfile(f.directory, {}, undefined, f.hostOptions);
    try { assert.equal((await prepare(profile, y.workId)).packet.personalMemory?.entries[0]?.ref.id, 'style'); } finally { await profile.close(); }
    const revised = await call<{ revision: number }>(['memory-revise', y.workId, '--memory-id', 'style', '--memory-revision', '1', '--request-id', 'revise', '--source-message', 'correction', '--text', corrected, '--goal-revision', '1', '--title', '보고서 표현', '--reason', '사용자 정정']);
    assert.equal(revised.revision, 2); assert.equal((await call<{ card: KnowledgeCard }>(['memory-get', '--memory-id', 'style'])).card.body, corrected);
    const latest = await call<{ stateRevision: number }>(['memory-selected', y.workId]);
    await call(['memory-clear', y.workId, '--request-id', 'clear', '--goal-revision', '1', '--state-revision', String(latest.stateRevision)]);
    await call(['memory-forget', '--memory-id', 'style', '--memory-revision', '2', '--request-id', 'forget', '--reason', '기억 사용 중단']);
    assert.deepEqual((await call<Pick<KnowledgeSearch, 'cards' | 'index'>>(['memory-search'])).cards, []);
    await assert.rejects(call(args), /knowledge_unavailable/);
    const history = await call<WebConversation>(['history']); assert.equal(history.entries.filter(entry => entry.sourceId === 'correction' && entry.text === corrected).length, 1);
    profile = await openAgentLocalProfile(f.directory, {}, undefined, f.hostOptions);
    try { const state = await profile.runtime.state(y.workId); assert.deepEqual(state.attempts, []); assert.deepEqual(state.modelCalls, []); }
    finally { await profile.close(); }
  } finally { f.close(); }
});

test('new-input remember retries reuse the applied user message after a memory failure and after response loss', async () => {
  const f = fixture(); const profile = await openAgentLocalProfile(f.directory, {}, undefined, f.hostOptions); const workbench = new LocalWorkbench(profile);
  const factory = profile.personalKnowledge; let failure: 'before' | 'after' | null = 'before';
  profile.personalKnowledge = async (...args) => {
    const service = await factory(...args), remember = service.remember.bind(service);
    service.remember = async input => {
      if (failure === 'before') { failure = 'after'; throw new Error('synthetic_memory_commit_unavailable'); }
      const result = await remember(input);
      if (failure === 'after') { failure = null; throw new Error('synthetic_response_lost'); }
      return result;
    };
    return service;
  };
  try {
    const x = await seed(workbench);
    const input: PersonalRememberInput = { id: 'retry', requestId: 'save-retry', title: '재시도 기억', source: { kind: 'new_input', workId: x.workId, messageId: 'stable-user-input', expectedGoalRevision: 1, rawText: corrected } };
    await assert.rejects(workbench.memoryRemember(input), /synthetic_memory_commit_unavailable/);
    assert.equal((await workbench.history()).entries.filter(entry => entry.sourceId === 'stable-user-input').length, 1);
    assert.deepEqual((await workbench.memorySearch('')).cards, []);
    await assert.rejects(workbench.memoryRemember(input), /synthetic_response_lost/);
    const saved = await workbench.memoryRemember(input); assert.equal(saved.card.revision, 1); assert.equal(saved.card.body, corrected);
    assert.equal((await workbench.history()).entries.filter(entry => entry.sourceId === 'stable-user-input').length, 1);
    assert.equal((await workbench.memorySearch('')).cards.length, 1);
    await assert.rejects(workbench.memoryRemember({ ...input, title: '동일 요청의 다른 내용' }), /knowledge_command_conflict/);
    await workbench.memoryForget({ id: input.id, requestId: 'forget-retry', expectedRevision: 1, reason: '사용 중단' });
    await assert.rejects(workbench.memoryRemember(input), /knowledge_unavailable/);
  } finally { await workbench.drain(); await profile.close(); f.close(); }
});

test('surface authority rejects other users, labels, destinations and session work selection while same-owner memory remains cross-session', async () => {
  const f = fixture(); const profile = await openAgentLocalProfile(f.directory, {}, undefined, f.hostOptions); const workbench = new LocalWorkbench(profile);
  let foreign: Awaited<ReturnType<typeof openAgentLocalProfile>> | undefined;
  try {
    const x = await seed(workbench); await workbench.memoryRemember(remember(x.sessionId!));
    for (const restriction of [{ ...actor, principalId: 'other' }, { ...actor, allowedLabels: [] }, { ...actor, allowedDestinations: [] }]) {
      const denied = new LocalWorkbench(profile, restriction);
      await assert.rejects(denied.memoryGet('report-style'));
      await assert.rejects(denied.memoryRemember({ ...remember(x.sessionId!), requestId: 'denied', id: 'denied' }));
      await assert.rejects(denied.memoryRecall(x.workId, { requestId: 'denied', expectedGoalRevision: 1, expectedStateRevision: 1, refs: [{ id: 'report-style', revision: 1 }] }));
      await denied.drain();
    }
    const next = new LocalWorkbench(profile, actor, 'web', { newSession: true }); await next.initializeSession();
    assert.equal((await next.memorySearch('보고서')).cards.length, 1);
    await assert.rejects(next.memorySelected(x.workId), /session_work_unavailable/);
    await assert.rejects(next.memoryRecall(x.workId, { requestId: 'wrong-session', expectedGoalRevision: 1, expectedStateRevision: 1, refs: [] }), /session_work_unavailable/);
    const readonly = new LocalWorkbench(profile, { ...actor, allowWrites: false });
    assert.equal((await readonly.memoryGet('report-style')).card.body, original);
    await assert.rejects(readonly.memoryForget({ id: 'report-style', requestId: 'read-only-forget', expectedRevision: 1, reason: '읽기 전용 요청' }), /personal_memory_read_only/);
    await assert.rejects(readonly.memoryRemember({ ...remember(x.sessionId!), requestId: 'read-only-remember', id: 'read-only' }), /personal_memory_read_only/);
    await readonly.drain();
    foreign = await openAgentLocalProfile(join(f.base, 'other-agent'), {}, undefined, f.hostOptions); const otherAgent = new LocalWorkbench(foreign);
    await assert.rejects(otherAgent.memoryGet('report-style')); assert.deepEqual((await otherAgent.memorySearch('')).cards, []);
    await next.drain(); await otherAgent.drain();
  } finally { await foreign?.close(); await workbench.drain(); await profile.close(); f.close(); }
});

test('Web memory mutations preserve CSRF and strict owner-free schemas, reject stale work input and do not append operation notices', async () => {
  const f = fixture(); const profile = await openAgentLocalProfile(f.directory, {}, undefined, f.hostOptions); const workbench = new LocalWorkbench(profile);
  const web = await startWebServer(workbench);
  try {
    const x = await seed(workbench), headers = await login(web); const before = await workbench.history();
    const send = (body: unknown, supplied = headers) => fetch(`${web.origin}/api/memories/remember`, { method: 'POST', headers: supplied, body: JSON.stringify(body) });
    assert.equal((await send({ ...remember(x.sessionId!), owner: { agentId: profile.agentId, principalId: actor.principalId } })).status, 400);
    assert.equal((await send(remember(x.sessionId!), { ...headers, 'X-Work-CSRF': '' })).status, 403);
    assert.deepEqual(await workbench.history(), before); assert.deepEqual((await workbench.memorySearch('')).cards, []);
    assert.equal((await send(remember(x.sessionId!))).status, 200);
    const state = await profile.runtime.state(x.workId);
    const choice = { requestId: 'select', expectedGoalRevision: 1, expectedStateRevision: state.revision, refs: [{ id: 'report-style', revision: 1 }] };
    await workbench.input(x.workId, { requestId: 'later', expectedGoalRevision: 1, rawText: '같은 목표의 새 입력' });
    const stale = await fetch(`${web.origin}/api/works/${x.workId}/memories`, { method: 'POST', headers, body: JSON.stringify(choice) });
    assert.equal(stale.status, 409); assert.equal((await profile.runtime.state(x.workId)).personalMemorySelection, undefined);
    const invalidOwner = await fetch(`${web.origin}/api/works/${x.workId}/memories`, { method: 'POST', headers, body: JSON.stringify({ ...choice, refs: [{ id: 'report-style', revision: 1, agentId: 'other' }] }) });
    assert.equal(invalidOwner.status, 400);
    await workbench.command(x.workId, { requestId: 'cancel', expectedGoalRevision: 1, kind: 'cancel', rawText: '업무 취소' });
    const cancelled = await profile.runtime.state(x.workId);
    await assert.rejects(workbench.memoryRecall(x.workId, { ...choice, expectedStateRevision: cancelled.revision }), /personal_memory_not_selectable/);
    const users = (await workbench.history()).entries.filter(entry => entry.role === 'user');
    assert.deepEqual(users.map(entry => entry.text), [original, '같은 목표의 새 입력', '업무 취소']);
    assert.deepEqual(users.slice(0, 2).map(entry => entry.sourceId), ['initial', 'later']);
    assert.equal(users[2]!.sourceId, cancelled.conversation?.session?.input.messageId);
    assert.equal(users[2]!.kind, 'command'); assert.ok(users.every(entry => entry.workId === x.workId));
  } finally { await web.close(); await profile.close(); f.close(); }
});

test('legacy synthetic directory exposes no personal-memory service and does not reinterpret old knowledge', async () => {
  const f = fixture(); const profile = await openLocalProfile(join(f.base, 'legacy'));
  try { await assert.rejects(profile.personalKnowledge(actor), /personal_memory_unavailable/); }
  finally { await profile.close(); f.close(); }
});

test('memory source controls reject assistant text, invented quotes and unbound new input without creating memory', async () => {
  const f = fixture(); const profile = await openAgentLocalProfile(f.directory, {}, undefined, f.hostOptions); const workbench = new LocalWorkbench(profile);
  try {
    const x = await seed(workbench), history = await workbench.history(); const assistant = history.entries.find(entry => entry.role === 'assistant'); assert.ok(assistant);
    const input = remember(x.sessionId!);
    await assert.rejects(workbench.memoryRemember({ ...input, source: { kind: 'existing', sessionId: x.sessionId!, messageId: assistant.sourceId, quote: assistant.text } }), /knowledge_unavailable/);
    await assert.rejects(workbench.memoryRemember({ ...input, source: { kind: 'existing', sessionId: x.sessionId!, messageId: 'initial', quote: '원문에 없던 기억' } }), /knowledge_unavailable/);
    const next = new LocalWorkbench(profile, actor, 'web', { newSession: true }); await next.initializeSession();
    await assert.rejects(next.memoryRemember({ ...input, source: { kind: 'new_input', workId: x.workId, messageId: 'wrong-session-source', expectedGoalRevision: 1, rawText: corrected } }), /session_work_unavailable/);
    assert.deepEqual(await workbench.history(), history); assert.deepEqual((await workbench.memorySearch('')).cards, []);
    await next.drain();
  } finally { await workbench.drain(); await profile.close(); f.close(); }
});
