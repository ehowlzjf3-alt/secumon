import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentLocalProfile, runtimeRoot } from '../presentation/local-profile.js';
import { LocalWorkbench } from '../presentation/local-workbench.js';
import { startWebServer } from '../presentation/web-server.js';
import { compactStatusText, receiveCompactStatus } from '../presentation/web/view-state.js';
import type { WebAcceptResult, WebCompactResult, WebCompactStatus, WebConversation } from '../presentation/web-contracts.js';
import type { ArtifactRef } from '../domain/model.js';
import { ResumePacketSchema } from '../application/recovery-contracts.js';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../presentation/agent-cli.js', import.meta.url));
const actor = { tenantId: 'synthetic', principalId: 'learner' };
const original = (label: string) => `[합성 예제] ${label}. 외부 전송 금지. 원문 보존. 검증 후 완료. ${'합성 배경 자료. '.repeat(200)}`;
function fixture(backend: 'sqlite' | 'file-journal' = 'sqlite') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'session-compact-presentation-'))); const directory = join(base, 'agent');
  const profile = new FileAgentProfileStore(runtimeRoot).initialize(directory);
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ ...profile.config, storage: { ...profile.config.storage, state: backend } }), { mode: 0o600 });
  return { directory, close: () => rmSync(base, { recursive: true, force: true }) };
}
async function seed(workbench: LocalWorkbench, text = original('처음 요청')) {
  await workbench.initializeSession();
  const accepted = await workbench.accept({ requestId: 'first', scenarioId: 'documents-simple', mode: 'auto', rawText: text });
  await workbench.input(accepted.workId, { requestId: 'tail', expectedGoalRevision: 1, rawText: original('현재 입력') });
  return accepted;
}
async function login(web: Awaited<ReturnType<typeof startWebServer>>) {
  const response = await fetch(`${web.origin}/api/session`, { method: 'POST', headers: { Origin: web.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: new URL(web.connectUrl).hash.slice(9) }) });
  assert.equal(response.status, 200); const value = await response.json() as { csrf: string };
  return { Cookie: response.headers.get('set-cookie')!.split(';')[0]!, Origin: web.origin, 'Content-Type': 'application/json', 'X-Work-CSRF': value.csrf };
}

for (const backend of ['sqlite', 'file-journal'] as const) test(`${backend}: repeated manual compact preserves actual history, then restarts with summary and latest raw input`, async () => {
  const f = fixture(backend); let profile = await openAgentLocalProfile(f.directory, { compactProvider: 'synthetic' });
  let workbench = new LocalWorkbench(profile);
  try {
    const accepted = await seed(workbench); let previousSummary = 0; let previousThrough = 0; let retainedIds: string[] | undefined;
    for (let round = 0; round < 3; round++) {
      const before = await workbench.history();
      const input = { requestId: `compact-${round}`, expectedGoalRevision: 1 };
      const result = await workbench.compact(accepted.workId, input);
      assert.equal(result.status.stage, 'ready', JSON.stringify(result)); assert.ok(result.status.summary);
      assert.ok(result.status.summary.revision > previousSummary); previousSummary = result.status.summary.revision;
      assert.deepEqual(await workbench.history(), before);
      const state = await profile.runtime.state(accepted.workId);
      const summary = await profile.sessions!.repository.summary(state.conversation!.session!.scope, result.status.summary.id); assert.ok(summary);
      assert.ok(summary.content.retained.some(item => item.citations.some(citation => citation.role === 'user' && citation.sequence > previousThrough &&
        before.entries.some(entry => entry.sourceId === citation.sourceId && entry.sequence === citation.sequence && entry.text.includes(citation.quote)))));
      if (retainedIds) {
        assert.deepEqual(summary.content.retained.map(item => item.id), retainedIds);
        assert.ok(summary.content.retained.every(item => item.changedBy && item.changedBy.sequence > previousThrough));
      }
      retainedIds = summary.content.retained.map(item => item.id); previousThrough = summary.ref.throughSequence;
      assert.equal(state.budget.used.toolCalls, 0); assert.equal(state.plan, null); assert.equal(profile.planning, null);
      assert.equal(state.modelCalls.length, round + 1); assert.ok(state.modelCalls.every(call => call.purpose === 'session_compact' && call.status === 'accepted'));
      assert.equal(state.budget.used.modelCalls, round + 1); assert.equal(state.budget.used.tokens, 0);
      assert.equal(state.budget.reservedTokens, 0); assert.equal(state.budget.reservedModelCalls, 0);
      assert.ok(state.modelCalls.every(call => call.provider === 'synthetic' && call.model === 'local-session-rules' && call.inputEstimate === 1 &&
        call.tokenReservation === call.maxOutputTokens + 1 && call.inputArtifact.byteLength > call.inputEstimate));
      assert.equal((await workbench.compact(accepted.workId, input)).callId, result.callId);
      assert.equal((await profile.runtime.state(accepted.workId)).modelCalls.length, round + 1);
      if (round < 2) await workbench.input(accepted.workId, { requestId: `next-${round}`, expectedGoalRevision: 1, rawText: original(`후속 ${round}`) });
    }
    const beforeRestart = await workbench.history(); await workbench.drain(); await profile.close();
    profile = await openAgentLocalProfile(f.directory, { compactProvider: 'synthetic' }); workbench = new LocalWorkbench(profile);
    await workbench.initializeSession(); assert.deepEqual(await workbench.history(), beforeRestart);
    const raw = '[합성 예제] 재시작 후 다음 입력. 원문 보존.';
    await workbench.input(accepted.workId, { requestId: 'after-restart', expectedGoalRevision: 1, rawText: raw });
    const state = await profile.runtime.state(accepted.workId);
    const prepared = await profile.context.prepare(state, { callId: 'inspect-compact-context', maxOutputTokens: 1000, maxInputBytes: 524288, maxInputTokens: 131072 });
    const session = prepared.packet.session; assert.equal(session?.schemaVersion, 2);
    if (session?.schemaVersion !== 2) assert.fail('summary missing');
    assert.equal(session.summary.ref.revision, 3); assert.ok(session.entries.some(entry => entry.text === raw));
    assert.ok(session.summary.content.retained.some(item => item.kind === 'constraint' && item.citations.length > 0));
    assert.ok(!session.entries.some(entry => entry.sourceId === 'first'));
    const other = new LocalWorkbench(profile, { ...actor, principalId: 'other' }); await other.initializeSession();
    await assert.rejects(other.compactStatus(accepted.workId));
    await assert.rejects(other.compact(accepted.workId, { requestId: 'foreign', expectedGoalRevision: 1 }));
    const anotherSession = new LocalWorkbench(profile, actor, 'web', { newSession: true }); await anotherSession.initializeSession();
    await assert.rejects(anotherSession.compactStatus(accepted.workId), /session_work_unavailable/);
  } finally { await workbench.drain(); await profile.close(); f.close(); }
});

test('installed CLI explicitly enables synthetic compact; retry and readonly status do not create another call', async () => {
  const f = fixture();
  const call = async <T>(args: string[]): Promise<T> => {
    const result = await execute(process.execPath, [cli, 'work', ...args, '--directory', f.directory, '--json'], { timeout: 30000, maxBuffer: 2097152 });
    return JSON.parse(result.stdout) as T;
  };
  try {
    const accepted = await call<WebAcceptResult>(['accept', '--request-id', 'first', '--text', original('CLI 원문')]);
    await call(['input', accepted.workId, '--request-id', 'tail', '--text', original('CLI 현재 입력'), '--goal-revision', '1']);
    const before = await call<WebConversation>(['history']);
    await assert.rejects(call(['compact', accepted.workId, '--goal-revision', '1']), /session_compact_unavailable/);
    const args = ['compact', accepted.workId, '--goal-revision', '1', '--request-id', 'manual', '--compact-provider', 'synthetic'];
    const result = await call<WebCompactResult>(args); assert.equal(result.status.stage, 'ready', JSON.stringify(result));
    assert.equal((await call<WebCompactResult>(args)).callId, result.callId);
    const status = await call<WebCompactStatus>(['context-status', accepted.workId]); assert.equal(status.summary?.id, result.status.summary?.id);
    assert.equal(status.provider, null); assert.deepEqual(await call(['history']), before);
    const profile = await openAgentLocalProfile(f.directory);
    try { const state = await profile.runtime.state(accepted.workId); assert.equal(state.modelCalls.length, 1); assert.equal(state.budget.used.toolCalls, 0); }
    finally { await profile.close(); }
  } finally { f.close(); }
});

for (const invalid of ['free-text', 'unmatched-fixture'] as const) test(`Web exposes safe unavailable and refused ${invalid} compact without hiding or rewriting original messages`, async () => {
  const f = fixture(); let profile = await openAgentLocalProfile(f.directory); let workbench = new LocalWorkbench(profile);
  const accepted = await seed(workbench, `${invalid === 'unmatched-fixture' ? '[합성 예제] ' : ''}자유 문장 원문. ${'일반 내용. '.repeat(300)}`);
  let web = await startWebServer(workbench);
  try {
    let headers = await login(web);
    const post = () => fetch(`${web.origin}/api/works/${accepted.workId}/compact`, { method: 'POST', headers, body: JSON.stringify({ requestId: 'manual', expectedGoalRevision: 1 }) });
    const unavailable = await post(); assert.equal(unavailable.status, 409); assert.deepEqual(await unavailable.json(), { code: 'session_compact_unavailable' });
    const before = await workbench.history(); assert.equal((await profile.runtime.state(accepted.workId)).modelCalls.length, 0);
    await web.close(); await profile.close();
    profile = await openAgentLocalProfile(f.directory, { compactProvider: 'synthetic' }); workbench = new LocalWorkbench(profile); await workbench.initializeSession();
    web = await startWebServer(workbench); headers = await login(web);
    const refused = await post(); assert.equal(refused.status, 200); const result = await refused.json() as WebCompactResult;
    assert.equal(result.status.stage, 'failed'); assert.equal(result.status.summary, null);
    assert.match(compactStatusText(result.status), /원문 이력은 유지/);
    assert.deepEqual(await workbench.history(), before);
    const state = await profile.runtime.state(accepted.workId); assert.equal(state.modelCalls.length, 1);
    const repeated = await post(); assert.equal(repeated.status, 200); assert.equal((await profile.runtime.state(accepted.workId)).modelCalls.length, 1);
    const status = await fetch(`${web.origin}/api/works/${accepted.workId}/context-status`, { headers }); assert.equal(status.status, 200);
    const serialized = await status.text(); assert.ok(!serialized.includes('자유 문장 원문')); assert.ok(!serialized.includes('narrative'));
  } finally { await web.close(); await profile.close(); f.close(); }
});

for (const interruption of ['input', 'cancel'] as const) test(`Web compact remains interruptible by ${interruption}; late fixture reply cannot publish a summary`, async () => {
  const f = fixture(); const profile = await openAgentLocalProfile(f.directory, { compactProvider: 'synthetic' }); const workbench = new LocalWorkbench(profile);
  let release!: () => void; let entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const originalCompact = profile.services.planner.compact!.bind(profile.services.planner);
  profile.services.planner.compact = async (input, signal, options) => { entered(); await gate; return originalCompact(input, signal, options); };
  const accepted = await seed(workbench); const web = await startWebServer(workbench); let pending: Promise<Response> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const headers = await login(web);
    const post = (path: string, body: unknown) => fetch(`${web.origin}/api/works/${accepted.workId}/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    pending = post('compact', { requestId: 'delayed', expectedGoalRevision: 1 });
    await Promise.race([enteredPromise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('compact_fixture_not_started')), 5000); })]);
    clearTimeout(timer);
    const status = await fetch(`${web.origin}/api/works/${accepted.workId}/context-status`, { headers }); assert.equal(status.status, 200);
    assert.equal((await status.json() as WebCompactStatus).stage, 'running');
    const rawText = interruption === 'input' ? '[합성 예제] 새 입력은 원문으로 유지.' : '사용자가 취소 요청';
    const response = interruption === 'input' ? await post('inputs', { requestId: 'interrupt', expectedGoalRevision: 1, rawText }) :
      await post('commands', { requestId: 'interrupt', expectedGoalRevision: 1, kind: 'cancel', rawText });
    assert.equal(response.status, 200, await response.text());
    release(); assert.equal((await pending).status, 200); await profile.compactPlanning!.settlePending();
    const current = await workbench.compactStatus(accepted.workId); assert.equal(current.summary, null); assert.notEqual(current.stage, 'ready');
    assert.ok((await workbench.history()).entries.some(entry => entry.text === rawText));
    assert.equal((await profile.runtime.state(accepted.workId)).modelCalls.length, 1);
  } finally { clearTimeout(timer); release(); await pending?.catch(() => undefined); await web.close(); await profile.compactPlanning!.settlePending(); await profile.close(); f.close(); }
});

test('automatic compact precedes fixture execution when the current session tail exceeds its entry limit', async () => {
  const f = fixture(); const profile = await openAgentLocalProfile(f.directory, { compactProvider: 'synthetic', compactLimits: { maxContextEntries: 4, keepRecentEntries: 1 } });
  const workbench = new LocalWorkbench(profile);
  let checkpoint: ArtifactRef | undefined;
  const run = profile.workflow.run.bind(profile.workflow);
  // Observe the checkpoint returned by the real surface run, without replacing its execution.
  profile.workflow.run = async (...args) => { const result = await run(...args); checkpoint = result.checkpoint; return result; };
  try {
    const accepted = await seed(workbench);
    await workbench.input(accepted.workId, { requestId: 'third', expectedGoalRevision: 1, rawText: original('세 번째 입력') });
    await workbench.input(accepted.workId, { requestId: 'fourth', expectedGoalRevision: 1, rawText: original('네 번째 입력') });
    const latestRaw = original('다섯 번째 입력');
    await workbench.input(accepted.workId, { requestId: 'fifth', expectedGoalRevision: 1, rawText: latestRaw });
    const before = await workbench.history();
    assert.equal(before.entries.filter(entry => entry.role === 'user').length, 5);
    await assert.rejects(profile.sessions!.context(await profile.runtime.state(accepted.workId)), /session_context_capacity/);
    await workbench.command(accepted.workId, { requestId: 'run', expectedGoalRevision: 1, kind: 'run' });
    const state = await profile.runtime.state(accepted.workId);
    assert.ok(state.modelCalls.some(call => call.purpose === 'session_compact' && call.status === 'accepted'), JSON.stringify({ status: state.status,
      reason: state.statusReason, budget: state.budget, calls: state.modelCalls.map(call => ({ status: call.status, reason: call.reason, purpose: call.purpose })) }));
    assert.ok(state.budget.used.toolCalls > 0); assert.equal(profile.planning, null);
    assert.equal(state.status, 'completed'); assert.equal(state.budget.reservedTokens, 0); assert.equal(state.budget.reservedModelCalls, 0);
    const events = await profile.services.state.events(accepted.workId, 0);
    const adopted = events.find(event => event.type === 'model_compact_accepted'); const firstTool = events.find(event => event.type === 'attempt_reserved');
    assert.ok(adopted && firstTool && adopted.sequence < firstTool.sequence);
    assert.ok(checkpoint, 'the real Web run must return a stored recovery checkpoint');
    const stored = ResumePacketSchema.parse(JSON.parse(new TextDecoder().decode(await profile.services.artifacts.get(checkpoint, state.policy))));
    assert.equal(stored.workId, accepted.workId); assert.equal(stored.runtime.status, 'completed'); assert.equal(stored.stateRevision, state.revision);
    assert.equal(stored.context.session?.schemaVersion, 2);
    const sessionX = stored.context.session; if (sessionX?.schemaVersion !== 2) assert.fail('automatic compact summary missing from stored checkpoint');
    assert.ok(sessionX.entries.some(entry => entry.role === 'user' && entry.text === latestRaw));
    assert.ok(!sessionX.entries.some(entry => entry.sourceId === 'first'));
    const after = await workbench.history(); assert.deepEqual(after.entries.filter(entry => before.entries.some(old => old.sourceId === entry.sourceId)), before.entries);
    assert.equal(after.entries.filter(entry => entry.workId === accepted.workId && entry.kind === 'result').length, 1);
    const rawY = '[합성 예제] 다음 업무 Y. 원문 보존.';
    const next = await workbench.accept({ requestId: 'next-work', scenarioId: 'documents-simple', mode: 'auto', rawText: rawY });
    assert.notEqual(next.workId, accepted.workId); assert.equal(next.sessionId, accepted.sessionId);
    const nextState = await profile.runtime.state(next.workId);
    assert.deepEqual(nextState.conversation?.session?.scope, state.conversation?.session?.scope);
    assert.equal(nextState.budget.used.modelCalls, 0); assert.equal(nextState.budget.used.toolCalls, 0); assert.equal(nextState.budget.used.tokens, 0);
    assert.equal(nextState.budget.reservedModelCalls, 0); assert.equal(nextState.budget.reservedTokens, 0);
    assert.deepEqual(nextState.modelCalls, []); assert.deepEqual(nextState.attempts, []); assert.deepEqual(nextState.evidence, []); assert.equal(nextState.plan, null);
    const restoredY = await profile.recovery.restore(next.workId, actor);
    const storedY = ResumePacketSchema.parse(JSON.parse(new TextDecoder().decode(await profile.services.artifacts.get(restoredY.artifact, nextState.policy))));
    const sessionY = storedY.context.session; assert.equal(sessionY?.schemaVersion, 2);
    if (sessionY?.schemaVersion !== 2) assert.fail('next work lost the accepted summary');
    assert.deepEqual(sessionY.summary.ref, sessionX.summary.ref);
    assert.ok(sessionY.entries.some(entry => entry.workId === accepted.workId && entry.text === latestRaw));
    assert.ok(sessionY.entries.some(entry => entry.workId === next.workId && entry.text === rawY));
    assert.deepEqual((await profile.runtime.state(accepted.workId)).budget, state.budget);
    // These are stored runtime ContextPackets, not inputs observed at a real planner.propose call.
    assert.equal(profile.planning, null); assert.ok(state.modelCalls.every(call => call.purpose === 'session_compact'));
  } finally { await workbench.drain(); await profile.close(); f.close(); }
});

test('context status is a separate compact reference projection; older responses cannot replace newer status', () => {
  const status: WebCompactStatus = { workId: 'work', sessionId: 'session', stateRevision: 5, stage: 'running', provider: 'synthetic', reason: null, summary: null,
    call: { id: 'call', status: 'running', requestId: 'request', inputTokens: null, outputTokens: null }, originalHistoryPreserved: true };
  const failed = { ...status, stateRevision: 6, stage: 'failed' as const };
  assert.equal(receiveCompactStatus(failed, status), failed);
  assert.match(compactStatusText(status), /추가 입력이나 취소/); assert.match(compactStatusText(failed), /원문 이력은 유지/);
  assert.match(compactStatusText({ ...status, stage: 'needed' }), /정리가 필요/);
  assert.match(compactStatusText({ ...status, stage: 'unknown' }), /수신 여부/);
});
