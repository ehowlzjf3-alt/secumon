import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { AgentProfileStatus } from '../application/agent-profile-contracts.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentLocalProfile, runtimeRoot } from '../presentation/local-profile.js';
import { LocalWorkbench } from '../presentation/local-workbench.js';
import { startWebServer } from '../presentation/web-server.js';
import type { KnowledgeCard, KnowledgeRecord } from '../domain/knowledge.js';
import type { WebAcceptResult, WebConversation } from '../presentation/web-contracts.js';

const execute = promisify(execFile), cli = fileURLToPath(new URL('./helpers/agent-cli-isolated-worker.js', import.meta.url));
const actor = { tenantId: 'synthetic', principalId: 'learner' };
const original = '문서형 개인 기억 시험: 보고서는 한국어로 작성하고 원문을 보존한다.';
const corrected = '문서형 개인 기억 정정: 보고서는 한국어로 쓰고 요약 뒤에 출처를 덧붙인다.';
type Ready = Extract<AgentProfileStatus, { status: 'ready' }>;
type Search = { cards: KnowledgeCard[]; index: { complete: boolean } };
type Selection = { stateRevision: number; goalRevision: number; available: boolean; refs: { id: string; revision: number }[] };
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'document-memory-presentation-'))), directory = join(base, 'agent');
  const hostOptions = { identityRegistryDirectory: join(base, 'registry') };
  const run = (args: string[]) => execute(process.execPath, [cli, ...args, '--directory', directory], { timeout: 30000, maxBuffer: 2097152, env: { ...process.env, SECUMON_TEST_IDENTITY_REGISTRY: hostOptions.identityRegistryDirectory } });
  const json = async <T>(args: string[]): Promise<T> => JSON.parse((await run([...args, '--json'])).stdout) as T;
  return { base, directory, hostOptions, run, json, close: () => rmSync(base, { recursive: true, force: true }) };
}
function documentTexts(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? documentTexts(path) : entry.isFile() && entry.name.endsWith('.md') ? [readFileSync(path, 'utf8')] : [];
  });
}
function sqliteContents(directory: string) {
  const db = new DatabaseSync(join(directory, 'memory', 'memory.sqlite'), { readOnly: true });
  try {
    db.exec('BEGIN');
    for (const table of ['records', 'receipts', 'heads', 'index']) {
      const row = db.prepare(`SELECT count(*) AS total FROM knowledge_${table}_v2 WHERE partition='personal'`).get();
      assert.equal(row?.['total'], 0, `document personal memory must not create SQLite ${table} rows`);
    }
    const work = db.prepare("SELECT body FROM knowledge_records_v2 WHERE partition='work' ORDER BY id").all();
    db.exec('COMMIT'); return work.map(row => JSON.parse(row['body'] as string) as KnowledgeRecord);
  } finally { db.close(); }
}
async function login(web: Awaited<ReturnType<typeof startWebServer>>) {
  const response = await fetch(`${web.origin}/api/session`, { method: 'POST', headers: { Origin: web.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: new URL(web.connectUrl).hash.slice(9) }) });
  assert.equal(response.status, 200); const value = await response.json() as { csrf: string };
  return { Cookie: response.headers.get('set-cookie')!.split(';')[0]!, Origin: web.origin, 'Content-Type': 'application/json', 'X-Work-CSRF': value.csrf };
}

test('CLI init explicitly selects documents, preserves ready choices and truthfully advertises schema support', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.run(['init', '--personal-memory', 'unknown']), /agent_setup_options_invalid/); assert.equal(existsSync(f.directory), false);
    for (const command of ['status', 'repair', 'clone', 'version']) {
      await assert.rejects(f.run([command, '--personal-memory', 'documents']), /agent_option_not_supported/); assert.equal(existsSync(f.directory), false);
    }
    const ready = await f.json<Ready>(['init', '--personal-memory', 'documents']); assert.equal(ready.status, 'ready'); assert.equal(ready.config.schemaVersion, 2);
    if (ready.config.schemaVersion !== 2) assert.fail('documents require v2 config');
    assert.equal(ready.config.storage.personalMemory.backend, 'documents'); assert.match(ready.config.storage.personalMemory.storeId, /^[a-f0-9-]{36}$/);
    assert.equal(ready.config.storage.memory, 'sqlite'); const configBytes = readFileSync(join(f.directory, 'config.json'));
    const repeat = await f.json<Ready>(['init', '--personal-memory', 'documents']); assert.deepEqual(repeat.identity, ready.identity); assert.deepEqual(repeat.config, ready.config);
    await assert.rejects(f.run(['init', '--personal-memory', 'sqlite'])); assert.deepEqual(readFileSync(join(f.directory, 'config.json')), configBytes);
    const status = await f.json<Ready>(['status']); assert.deepEqual(status.config, ready.config);
    const visible = await f.run(['status']); assert.match(visible.stdout, /개인 기억: 문서 \(documents\)/); assert.match(visible.stdout, /업무 근거 기억: SQLite/);
    const version = await f.json<{ configSchema: number; defaultConfigSchema: number; configSchemas: number[] }>(['version']);
    assert.equal(version.configSchema, 1); assert.equal(version.defaultConfigSchema, 1); assert.deepEqual(version.configSchemas, [1, 2]);
    assert.deepEqual(sqliteContents(f.directory), []);
    const defaultDirectory = join(f.base, 'default-agent');
    const defaults = JSON.parse((await execute(process.execPath, [cli, 'init', '--directory', defaultDirectory, '--personal-memory', 'sqlite', '--json'], { timeout: 30000, maxBuffer: 2097152, env: { ...process.env, SECUMON_TEST_IDENTITY_REGISTRY: f.hostOptions.identityRegistryDirectory } })).stdout) as Ready;
    assert.equal(defaults.config.schemaVersion, 1); assert.equal(defaults.config.storage.memory, 'sqlite');
    const prior = readFileSync(join(defaultDirectory, 'config.json'));
    await assert.rejects(execute(process.execPath, [cli, 'init', '--directory', defaultDirectory, '--personal-memory', 'documents'], { timeout: 30000, maxBuffer: 2097152, env: { ...process.env, SECUMON_TEST_IDENTITY_REGISTRY: f.hostOptions.identityRegistryDirectory } }));
    assert.deepEqual(readFileSync(join(defaultDirectory, 'config.json')), prior);
  } finally { f.close(); }
});

for (const backend of ['sqlite', 'file-journal'] as const) test(`${backend}: existing Web memory lifecycle uses documents while real Evidence memory stays in SQLite`, async () => {
  const f = fixture(); const ready = new FileAgentProfileStore(runtimeRoot).initialize(f.directory, { personalMemory: 'documents' });
  writeFileSync(join(f.directory, 'config.json'), JSON.stringify({ ...ready.config, storage: { ...ready.config.storage, state: backend } }), { mode: 0o600 });
  let profile = await openAgentLocalProfile(f.directory, {}, undefined, f.hostOptions), workbench = new LocalWorkbench(profile), web = await startWebServer(workbench), headers = await login(web);
  const request = async <T>(path: string, body?: unknown, expected = 200): Promise<T> => {
    const response = await fetch(`${web.origin}${path}`, { headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const value: unknown = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value as T;
  };
  try {
    assert.equal(profile.stateBackend, backend);
    const x = await request<WebAcceptResult>('/api/works', { requestId: 'source', scenarioId: 'documents-simple', mode: 'auto', rawText: original }); assert.ok(x.sessionId);
    const input = { id: 'personal-style', requestId: 'remember', title: '보고서 표현', source: { kind: 'existing', sessionId: x.sessionId, messageId: 'source', quote: original } };
    const saved = await request<{ card: KnowledgeCard }>('/api/memories/remember', input); assert.equal(saved.card.body, original);
    assert.deepEqual(await request('/api/memories/remember', input), saved); assert.deepEqual(sqliteContents(f.directory), []);
    assert.ok(documentTexts(join(f.directory, 'memory', 'documents')).some(text => text.includes(original)));
    await request(`/api/works/${x.workId}/commands`, { requestId: 'run-x', kind: 'run', expectedGoalRevision: 1 });
    const finished = await profile.runtime.state(x.workId); assert.equal(finished.status, 'completed');
    const evidence = finished.evidence.find(item => item.status === 'accepted'); assert.ok(evidence); assert.ok(profile.knowledge);
    const workMemory = await profile.knowledge.create({ id: 'work-evidence-note', commandId: 'remember-work-evidence', namespace: 'local', scope: finished.goal.scope,
      kind: 'fact', title: '합성 업무 근거', body: '합성 문서에서 확인한 관측을 기록한다.', labels: finished.policy.allowedLabels, sources: [{ workId: x.workId, evidenceId: evidence.id }], expiresAt: null });
    assert.equal(workMemory.card.kind, 'fact');
    const sqliteWork = sqliteContents(f.directory); assert.equal(sqliteWork.length, 1); assert.equal(sqliteWork[0]!.id, 'work-evidence-note');
    assert.notEqual(sqliteWork[0]!.sources[0]?.type, 'session_user_receipt'); assert.equal(sqliteWork[0]!.owner, undefined);
    await web.close(); await profile.close();
    profile = await openAgentLocalProfile(f.directory, {}, undefined, f.hostOptions); workbench = new LocalWorkbench(profile, actor, 'web', { newSession: true }); web = await startWebServer(workbench); headers = await login(web);
    const y = await request<WebAcceptResult>('/api/works', { requestId: 'next-work', scenarioId: 'documents-simple', mode: 'auto', rawText: '새 대화의 업무' }); assert.notEqual(y.sessionId, x.sessionId);
    const search = await request<Search>('/api/memories?query=보고서'); assert.equal(search.index.complete, true); assert.equal(search.cards.length, 1); assert.equal(search.cards[0]!.id, input.id);
    let basis = await request<Selection>(`/api/works/${y.workId}/memories`);
    await request(`/api/works/${y.workId}/memories`, { requestId: 'recall-v1', expectedGoalRevision: basis.goalRevision, expectedStateRevision: basis.stateRevision, refs: [{ id: input.id, revision: 1 }] });
    assert.equal((await request<Selection>(`/api/works/${y.workId}/memories`)).refs[0]?.revision, 1);
    const correction = { id: input.id, requestId: 'revise', expectedRevision: 1, title: '보고서 표현', reason: '사용자 정정',
      source: { kind: 'new_input', workId: y.workId, messageId: 'correction-source', expectedGoalRevision: 1, rawText: corrected } };
    assert.equal((await request<{ revision: number }>('/api/memories/revise', correction)).revision, 2);
    assert.equal((await request<{ revision: number }>('/api/memories/revise', correction)).revision, 2);
    assert.equal((await request<{ card: KnowledgeCard }>(`/api/memories/${input.id}`)).card.body, corrected);
    basis = await request<Selection>(`/api/works/${y.workId}/memories`); assert.equal(basis.available, false);
    await request(`/api/works/${y.workId}/memories`, { requestId: 'recall-v2', expectedGoalRevision: basis.goalRevision, expectedStateRevision: basis.stateRevision, refs: [{ id: input.id, revision: 2 }] });
    assert.equal((await request<Selection>(`/api/works/${y.workId}/memories`)).refs[0]?.revision, 2);
    await request('/api/memories/forget', { id: input.id, requestId: 'forget', expectedRevision: 2, reason: '개인 기억 사용 중단' });
    await request('/api/memories/remember', input, 403); assert.deepEqual((await request<Search>('/api/memories')).cards, []);
    assert.deepEqual(sqliteContents(f.directory), sqliteWork);
    await web.close(); await profile.close();
    profile = await openAgentLocalProfile(f.directory, {}, undefined, f.hostOptions); workbench = new LocalWorkbench(profile); web = await startWebServer(workbench); headers = await login(web);
    await request(`/api/memories/${input.id}`, undefined, 403); assert.deepEqual((await request<Search>('/api/memories')).cards, []);
    const history = await request<WebConversation>('/api/conversation'); assert.equal(history.entries.filter(entry => entry.sourceId === 'correction-source' && entry.text === corrected).length, 1);
    assert.equal((await profile.knowledge!.get('work-evidence-note')).card.body, workMemory.card.body); assert.deepEqual(sqliteContents(f.directory), sqliteWork);
    const yState = await profile.runtime.state(y.workId); assert.deepEqual(yState.modelCalls, []); assert.deepEqual(yState.attempts, []);
  } finally { await web.close(); await profile.close(); f.close(); }
});

test('built CLI entrypoint document-backed memory survives separate processes and uses the existing explicit recall commands', async () => {
  const f = fixture();
  try {
    const ready = await f.json<Ready>(['init', '--personal-memory', 'documents']); assert.equal(ready.config.schemaVersion, 2);
    const x = await f.json<WebAcceptResult>(['work', 'accept', '--request-id', 'source', '--text', original]); assert.ok(x.sessionId);
    const remember = ['work', 'memory-remember', '--memory-id', 'style', '--request-id', 'remember', '--title', '보고서 표현', '--source-session', x.sessionId, '--source-message', 'source', '--quote', original];
    assert.equal((await f.json<{ card: KnowledgeCard }>(remember)).card.body, original);
    await f.json(['work', 'session', '--new-session']);
    const y = await f.json<WebAcceptResult>(['work', 'accept', '--request-id', 'next', '--text', '새 CLI 대화']); assert.notEqual(y.sessionId, x.sessionId);
    assert.equal((await f.json<Search>(['work', 'memory-search', '--query', '보고서'])).cards[0]?.revision, 1);
    const selected = await f.json<Selection>(['work', 'memory-selected', y.workId]);
    await f.json(['work', 'memory-recall', y.workId, '--memory-id', 'style', '--memory-revision', '1', '--request-id', 'recall', '--goal-revision', '1', '--state-revision', String(selected.stateRevision)]);
    assert.equal((await f.json<Selection>(['work', 'memory-selected', y.workId])).refs[0]?.id, 'style');
    await f.json(['work', 'memory-revise', y.workId, '--memory-id', 'style', '--memory-revision', '1', '--request-id', 'revise', '--source-message', 'correction', '--goal-revision', '1', '--title', '보고서 표현', '--reason', '사용자 정정', '--text', corrected]);
    assert.equal((await f.json<{ card: KnowledgeCard }>(['work', 'memory-get', '--memory-id', 'style'])).card.body, corrected);
    await f.json(['work', 'memory-forget', '--memory-id', 'style', '--memory-revision', '2', '--request-id', 'forget', '--reason', '기억 사용 중단']);
    assert.deepEqual((await f.json<Search>(['work', 'memory-search'])).cards, []); await assert.rejects(f.json(remember), /knowledge_unavailable/);
    assert.deepEqual(sqliteContents(f.directory), []);
    const history = await f.json<WebConversation>(['work', 'history']); assert.equal(history.entries.filter(entry => entry.sourceId === 'correction' && entry.text === corrected).length, 1);
  } finally { f.close(); }
});
