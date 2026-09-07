import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentLocalProfile, runtimeRoot } from '../presentation/local-profile.js';
import { LocalWorkbench } from '../presentation/local-workbench.js';
import { startWebServer } from '../presentation/web-server.js';
import { memoryDraftStatusText } from '../presentation/web/personal-memory.js';
import type { MemoryDraftApplyInput, MemoryDraftStatus } from '../application/personal-memory-draft-contracts.js';
import type { WorkActor } from '../application/work-resources.js';
import type { KnowledgeCard } from '../domain/knowledge.js';
import type { WebAcceptResult, WebConversation, WorkbenchConfig } from '../presentation/web-contracts.js';

const actor = { tenantId: 'synthetic', principalId: 'learner' };
const original = '초안의 원래 기억: 한국어로 보고하고 원문 출처를 보존한다.';
const edited = '사용자가 파일에서 정정한 기억: 한국어 요약 뒤에 반론과 출처를 쓴다.';
type Created = { draftId: string; path: string; baseRevision: number; title: string };
type Selection = { goalRevision: number; stateRevision: number; available: boolean; refs: { id: string; revision: number }[] };

async function fixture(t: TestContext, backend: 'sqlite' | 'file-journal' = 'sqlite', documents = true) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'memory-draft-web-'))), directory = join(base, 'agent');
  const ready = new FileAgentProfileStore(runtimeRoot).initialize(directory, { personalMemory: documents ? 'documents' : 'sqlite' });
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ ...ready.config, storage: { ...ready.config.storage, state: backend } }), { mode: 0o600 });
  let profile = await openAgentLocalProfile(directory);
  const servers = new Set<Awaited<ReturnType<typeof startWebServer>>>();
  async function closeServers() { for (const server of servers) { await server.close(); servers.delete(server); } }
  t.after(async () => { try { await closeServers(); await profile.close(); } finally { rmSync(base, { recursive: true, force: true }); } });
  async function connect(caller: WorkActor = actor, options: { sessionId?: string; newSession?: boolean } = {}) {
    const workbench = new LocalWorkbench(profile, caller, 'web', options); await workbench.initializeSession();
    const web = await startWebServer(workbench); servers.add(web);
    const login = await fetch(`${web.origin}/api/session`, { method: 'POST', headers: { Origin: web.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: new URL(web.connectUrl).hash.slice(9) }) });
    assert.equal(login.status, 200); const value = await login.json() as { csrf: string; config: WorkbenchConfig };
    const headers = { Cookie: login.headers.get('set-cookie')!.split(';')[0]!, Origin: web.origin, 'Content-Type': 'application/json', 'X-Work-CSRF': value.csrf };
    async function request<T = unknown>(path: string, body?: unknown, expected = 200): Promise<T> {
      const response = await fetch(`${web.origin}${path}`, { headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      const result: unknown = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result as T;
    }
    return { web, workbench, headers, config: value.config, request };
  }
  return { base, directory, connect, get profile() { return profile; },
    async reopen() { await closeServers(); await profile.close(); profile = await openAgentLocalProfile(directory); } };
}
async function seed(h: Awaited<ReturnType<typeof fixture>>, web: Awaited<ReturnType<typeof h.connect>>) {
  const x = await web.request<WebAcceptResult>('/api/works', { requestId: 'source', scenarioId: 'documents-simple', mode: 'auto', rawText: original });
  assert.ok(x.sessionId);
  const { card } = await web.request<{ card: KnowledgeCard }>('/api/memories/remember', { id: 'style', requestId: 'remember', title: '보고서 표현',
    source: { kind: 'existing', sessionId: x.sessionId, messageId: 'source', quote: original } });
  const y = await web.request<WebAcceptResult>('/api/works', { requestId: 'next', scenarioId: 'documents-simple', mode: 'auto', rawText: '다음 업무에서 형식을 확인한다.' });
  assert.equal(y.sessionId, x.sessionId); return { x, y, card, sessionId: x.sessionId };
}
async function create(web: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['connect']>>, memoryId = 'style') {
  const draftId = randomUUID(); return web.request<Created>('/api/memory-drafts/create', { draftId, memoryId });
}
function edit(path: string, text = edited) { writeFileSync(path, readFileSync(path, 'utf8').replace(original, text)); }
const statusPath = (applyId: string, sessionId: string) => `/api/memory-drafts/status?applyId=${encodeURIComponent(applyId)}&sessionId=${encodeURIComponent(sessionId)}`;

for (const backend of ['sqlite', 'file-journal'] as const) test(`${backend}: Web draft explicit apply preserves source and receipt across stale work view, forget and reopen`, async t => {
  const h = await fixture(t, backend); let web = await h.connect();
  assert.equal(web.config.memoryDrafts, true); assert.ok(web.config.persistentSession?.sessionId);
  const { y, sessionId } = await seed(h, web);
  const basis = await web.request<Selection>(`/api/works/${y.workId}/memories`);
  await web.request(`/api/works/${y.workId}/memories`, { requestId: 'select-v1', expectedGoalRevision: basis.goalRevision, expectedStateRevision: basis.stateRevision, refs: [{ id: 'style', revision: 1 }] });
  const before = await h.profile.runtime.state(y.workId);
  const oldPacket = await h.profile.context.prepare(before, { callId: 'before-draft', maxOutputTokens: 1024, maxInputBytes: 524288, maxInputTokens: 100000 });
  const historyBefore = await web.request<WebConversation>('/api/conversation');
  const draft = await create(web); assert.equal(draft.baseRevision, 1);
  assert.ok(relative(join(h.directory, 'memory', 'drafts'), draft.path).length > 0);
  assert.equal(relative(join(h.directory, 'memory', 'drafts'), draft.path).startsWith('..'), false);
  const initialFile = readFileSync(draft.path); assert.match(initialFile.toString('utf8'), /secumon-memory-draft: 1/);
  assert.deepEqual(await web.request('/api/memory-drafts/create', { draftId: draft.draftId, memoryId: 'style' }), draft);
  assert.deepEqual(await web.request('/api/conversation'), historyBefore, 'creating a draft does not add chat notifications');
  edit(draft.path);
  assert.equal((await web.request<{ card: KnowledgeCard }>('/api/memories/style')).card.body, original, 'editing a file alone does not update memory');
  const input: MemoryDraftApplyInput = { draftId: draft.draftId, applyId: randomUUID(), sessionId, workId: y.workId, expectedGoalRevision: 1, reason: '편집한 문서를 명시 적용' };
  const applied = await web.request<MemoryDraftStatus>('/api/memory-drafts/apply', input);
  assert.equal(applied.stage, 'complete'); assert.equal(applied.sourceStatus, 'applied'); assert.equal(applied.appliedRevision, 2);
  assert.equal(applied.currentRevision, 2); assert.equal(applied.currentStatus, 'active');
  assert.equal((await web.request<{ card: KnowledgeCard }>('/api/memories/style')).card.body, edited);
  assert.equal(await h.profile.context.sourcesCurrent(oldPacket.packet, await h.profile.runtime.state(y.workId)), false);
  assert.deepEqual(await web.request(`/api/works/${y.workId}/view`, undefined, 403), { code: 'work_view_knowledge_changed' });
  assert.deepEqual(await web.request(statusPath(input.applyId, sessionId)), applied, 'management status does not require the stale work projection');
  assert.deepEqual(await web.request('/api/memory-drafts/apply', input), applied);
  assert.deepEqual(await web.request('/api/memory-drafts/resume', { applyId: input.applyId, sessionId }), applied);
  const historyAfter = await web.request<WebConversation>('/api/conversation');
  assert.deepEqual(historyAfter.entries.filter(entry => entry.sourceId !== applied.sourceMessageId), historyBefore.entries);
  assert.deepEqual(historyAfter.entries.filter(entry => entry.sourceId === applied.sourceMessageId).map(entry => [entry.role, entry.text]), [['user', edited]]);
  const fresh = await web.request<Selection>(`/api/works/${y.workId}/memories`); assert.equal(fresh.available, false);
  await web.request(`/api/works/${y.workId}/memories`, { requestId: 'select-v2', expectedGoalRevision: fresh.goalRevision, expectedStateRevision: fresh.stateRevision, refs: [{ id: 'style', revision: 2 }] });
  const state = await h.profile.runtime.state(y.workId);
  const prepared = await h.profile.context.prepare(state, { callId: 'after-draft', maxOutputTokens: 1024, maxInputBytes: 524288, maxInputTokens: 100000 });
  assert.equal(prepared.packet.personalMemory?.entries[0]?.body, edited); assert.equal(prepared.packet.personalMemory?.entries[0]?.ref.revision, 2);
  await web.request('/api/memories/forget', { requestId: 'forget', id: 'style', expectedRevision: 2, reason: '이후 업무에서 사용 중단' });
  const forgotten = await web.request<MemoryDraftStatus>(statusPath(input.applyId, sessionId));
  assert.equal(forgotten.stage, 'complete'); assert.equal(forgotten.appliedRevision, 2); assert.equal(forgotten.currentRevision, 3); assert.equal(forgotten.currentStatus, 'deleted');
  await h.reopen(); web = await h.connect(actor, { sessionId });
  assert.equal(web.config.persistentSession?.sessionId, sessionId);
  assert.deepEqual(await web.request(statusPath(input.applyId, sessionId)), forgotten);
  assert.deepEqual(await web.request('/api/memory-drafts/resume', { applyId: input.applyId, sessionId }), forgotten);
  assert.deepEqual(await web.request('/api/conversation'), historyAfter);
  const final = await h.profile.runtime.state(y.workId);
  assert.deepEqual(final.attempts, []); assert.deepEqual(final.modelCalls, []); assert.equal(final.budget.used.tokens, 0); assert.equal(final.budget.used.toolCalls, 0);
});

test('Web resumes a prepared apply ID after input failure using saved content, not later editor bytes', async t => {
  const h = await fixture(t), web = await h.connect(), { y, sessionId } = await seed(h, web), draft = await create(web); edit(draft.path);
  const input: MemoryDraftApplyInput = { draftId: draft.draftId, applyId: randomUUID(), sessionId, workId: y.workId, expectedGoalRevision: 1, reason: '중단 후 같은 적용 재개' };
  const sessions = h.profile.sessions!; const originalInput = sessions.inputOnly;
  const historyBefore = await web.request<WebConversation>('/api/conversation');
  sessions.inputOnly = async () => { throw new Error('synthetic/private-path: input unavailable'); };
  try { assert.deepEqual(await web.request('/api/memory-drafts/apply', input, 500), { code: 'request_failed' }); }
  finally { sessions.inputOnly = originalInput; }
  const pending = await web.request<MemoryDraftStatus>(statusPath(input.applyId, sessionId));
  assert.equal(pending.stage, 'prepared'); assert.equal(pending.sourceStatus, 'not_received'); assert.equal(pending.appliedRevision, null); assert.equal(pending.currentRevision, 1);
  assert.deepEqual(await web.request('/api/conversation'), historyBefore);
  writeFileSync(draft.path, readFileSync(draft.path, 'utf8').replace(edited, '최초 적용 후 편집한 미접수 내용'));
  const result = await web.request<MemoryDraftStatus>('/api/memory-drafts/resume', { applyId: input.applyId, sessionId });
  assert.equal(result.stage, 'complete'); assert.equal(result.appliedRevision, 2);
  assert.equal((await web.request<{ card: KnowledgeCard }>('/api/memories/style')).card.body, edited);
  assert.deepEqual(await web.request('/api/memory-drafts/resume', { applyId: input.applyId, sessionId }), result);
  const history = await web.request<WebConversation>('/api/conversation');
  assert.deepEqual(history.entries.filter(entry => entry.sourceId === result.sourceMessageId).map(entry => entry.text), [edited]);
  assert.equal(JSON.stringify(history).includes('미접수 내용'), false);
});

test('Web unchanged draft records its status without a new user message or memory revision', async t => {
  const h = await fixture(t), web = await h.connect(), { y, sessionId } = await seed(h, web), draft = await create(web);
  const before = await web.request<WebConversation>('/api/conversation');
  const input: MemoryDraftApplyInput = { draftId: draft.draftId, applyId: randomUUID(), sessionId, workId: y.workId, expectedGoalRevision: 1, reason: '변경 없는 파일 확인' };
  const status = await web.request<MemoryDraftStatus>('/api/memory-drafts/apply', input);
  assert.equal(status.stage, 'unchanged'); assert.equal(status.sourceStatus, 'not_received'); assert.equal(status.appliedRevision, null); assert.equal(status.currentRevision, 1);
  assert.deepEqual(await web.request('/api/memory-drafts/resume', { applyId: input.applyId, sessionId }), status);
  assert.deepEqual(await web.request('/api/conversation'), before);
});

test('Web draft apply, status and resume reject another selected session and read-only mutations', async t => {
  const h = await fixture(t), first = await h.connect(), { y, sessionId } = await seed(h, first), draft = await create(first); edit(draft.path);
  const input: MemoryDraftApplyInput = { draftId: draft.draftId, applyId: randomUUID(), sessionId, workId: y.workId, expectedGoalRevision: 1, reason: '대화 경계 확인' };
  const applied = await first.request<MemoryDraftStatus>('/api/memory-drafts/apply', input);
  const other = await h.connect(actor, { newSession: true }), otherSession = other.config.persistentSession!.sessionId!;
  assert.notEqual(otherSession, sessionId);
  for (const path of ['/api/memory-drafts/apply', '/api/memory-drafts/resume']) {
    assert.deepEqual(await other.request(path, path.endsWith('/apply') ? input : { applyId: input.applyId, sessionId }, 403), { code: 'session_work_unavailable' });
  }
  assert.deepEqual(await other.request(statusPath(input.applyId, sessionId), undefined, 403), { code: 'session_work_unavailable' });
  await other.request('/api/memory-drafts/apply', { ...input, sessionId: otherSession }, 403);
  await other.request('/api/memory-drafts/resume', { applyId: input.applyId, sessionId: otherSession }, 403);
  await other.request(statusPath(input.applyId, otherSession), undefined, 403);
  const reader = await h.connect({ ...actor, allowWrites: false }, { sessionId });
  assert.deepEqual(await reader.request('/api/memory-drafts/create', { draftId: randomUUID(), memoryId: 'style' }, 403), { code: 'personal_memory_read_only' });
  assert.deepEqual(await reader.request('/api/memory-drafts/apply', input, 403), { code: 'personal_memory_read_only' });
  assert.deepEqual(await reader.request('/api/memory-drafts/resume', { applyId: input.applyId, sessionId }, 403), { code: 'personal_memory_read_only' });
  assert.deepEqual(await reader.request(statusPath(input.applyId, sessionId)), applied);
});

test('Web draft transport rejects arbitrary paths and identities before accessing draft files', async t => {
  const h = await fixture(t), web = await h.connect(), { y, sessionId } = await seed(h, web);
  const directory = join(h.directory, 'memory', 'drafts'); assert.equal(existsSync(directory), false);
  const draftId = randomUUID(), applyId = randomUUID();
  const createBody = { draftId, memoryId: 'style' }, applyBody = { draftId, applyId, sessionId, workId: y.workId, expectedGoalRevision: 1, reason: '정정' };
  const before = await web.request<WebConversation>('/api/conversation');
  for (const [path, body] of [
    ['/api/memory-drafts/create', { ...createBody, path: '/private/other.md' }],
    ['/api/memory-drafts/create', { ...createBody, owner: { agentId: 'other' } }],
    ['/api/memory-drafts/create', { ...createBody, draftId: '../other' }],
    ['/api/memory-drafts/apply', { ...applyBody, body: 'HTTP에서 주입한 본문' }],
    ['/api/memory-drafts/apply', { ...applyBody, path: '/private/other.md' }],
    ['/api/memory-drafts/resume', { applyId, sessionId, path: '/private/other.md' }],
  ] as const) assert.deepEqual(await web.request(path, body, 400), { code: 'invalid_web_input' });
  assert.deepEqual(await web.request(`${statusPath(applyId, sessionId)}&path=other`, undefined, 400), { code: 'invalid_query' });
  assert.deepEqual(await web.request(`${statusPath(applyId, sessionId)}&applyId=${applyId}`, undefined, 400), { code: 'invalid_query' });
  const withoutCsrf = await fetch(`${web.web.origin}/api/memory-drafts/create`, { method: 'POST', headers: { ...web.headers, 'X-Work-CSRF': '' }, body: JSON.stringify(createBody) });
  assert.equal(withoutCsrf.status, 403); assert.equal(existsSync(directory), false);
  assert.deepEqual(await web.request('/api/conversation'), before);
});

test('default SQLite profile advertises no document drafts and refuses draft creation', async t => {
  const h = await fixture(t, 'sqlite', false), web = await h.connect();
  assert.equal(web.config.memoryDrafts, false);
  assert.deepEqual(await web.request('/api/memory-drafts/create', { draftId: randomUUID(), memoryId: 'style' }, 403), { code: 'personal_memory_draft_unavailable' });
  assert.equal(existsSync(join(h.directory, 'memory', 'drafts')), false);
});

test('draft completion text describes its recorded revision without claiming it is the current active memory', () => {
  const value: MemoryDraftStatus = { applyId: randomUUID(), draftId: randomUUID(), memoryId: 'style', workId: 'work', sessionId: 'session', baseRevision: 1,
    stage: 'complete', sourceStatus: 'applied', sourceMessageId: 'source', appliedRevision: 2, currentRevision: 3, currentStatus: 'deleted', reason: null };
  assert.match(memoryDraftStatusText(value), /버전 2/);
  assert.doesNotMatch(memoryDraftStatusText(value), /버전 3|현재.*활성|현재.*사용/);
  assert.match(memoryDraftStatusText({ ...value, stage: 'memory_pending', appliedRevision: null }), /입력은 반영.*정정은 아직/);
});
