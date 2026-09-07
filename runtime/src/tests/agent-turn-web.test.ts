import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentTurnCallInputSchema } from '../application/agent-turn-contracts.js';
import type { WorkView, WorkViewResult } from '../domain/work-view.js';
import { SYNTHETIC_AGENT_TURN_REQUESTS as requests, SYNTHETIC_AGENT_TURN_CORRECTION as correction } from '../infrastructure/synthetic-agent-turn.js';
import { openAgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { agentTurnWorkbenchProfile, LocalWorkbench } from '../presentation/local-workbench.js';
import { startWebServer } from '../presentation/web-server.js';
import type { WebAcceptResult, WebCommandResult, WebConversation, WebGoalBasis, WorkbenchConfig, WorkList } from '../presentation/web-contracts.js';

async function fixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-turn-web-'))), directory = join(base, 'agent');
  const hostOptions = { models: new Map(), identityRegistryDirectory: join(base, 'registry') };
  let profile = await openAgentTurnProfile(directory, { provider: 'synthetic' }, hostOptions);
  const servers = new Set<Awaited<ReturnType<typeof startWebServer>>>();
  async function closeServers() { for (const server of servers) { await server.close(); servers.delete(server); } }
  t.after(async () => { try { await closeServers(); await profile.close(); } finally { rmSync(base, { recursive: true, force: true }); } });
  async function connect(options: { sessionId?: string; newSession?: boolean } = {}) {
    const workbench = new LocalWorkbench(agentTurnWorkbenchProfile(profile), profile.executionActor, 'web', options);
    await workbench.initializeSession(); const web = await startWebServer(workbench); servers.add(web);
    const login = await fetch(`${web.origin}/api/session`, { method: 'POST', headers: { Origin: web.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: new URL(web.connectUrl).hash.slice(9) }), signal: AbortSignal.timeout(30000) });
    assert.equal(login.status, 200); const value = await login.json() as { csrf: string; config: WorkbenchConfig };
    const headers = { Cookie: login.headers.get('set-cookie')!.split(';')[0]!, Origin: web.origin, 'Content-Type': 'application/json', 'X-Work-CSRF': value.csrf };
    async function request<T = unknown>(path: string, body?: unknown, expected = 200): Promise<T> {
      const response = await fetch(`${web.origin}${path}`, { headers, signal: AbortSignal.timeout(30000),
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      const output: unknown = await response.json(); assert.equal(response.status, expected, JSON.stringify(output)); return output as T;
    }
    return { web, workbench, headers, config: value.config, request };
  }
  return { connect, get profile() { return profile; }, async reopen() {
    await closeServers(); await profile.close(); profile = await openAgentTurnProfile(directory, { provider: 'synthetic' }, hostOptions);
  } };
}
type Client = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['connect']>>;
function snapshot(value: WorkViewResult): WorkView {
  assert.equal(value.kind, 'snapshot'); if (value.kind !== 'snapshot') throw new Error('snapshot_expected'); return value.view;
}
const accept = (web: Client, requestId: string, rawText: string) => web.request<WebAcceptResult>('/api/requests', { requestId, mode: 'auto', rawText });
const run = async (web: Client, workId: string, requestId: string) => snapshot((await web.request<WebCommandResult>(`/api/works/${workId}/commands`,
  { kind: 'run', requestId, expectedGoalRevision: 1 })).view);

test('native HTTP general intake acknowledges without inference; explicit execution, reconnect and same-session follow-up preserve the real answer', async t => {
  const h = await fixture(t); let web = await h.connect();
  assert.equal(web.config.generalRequests, true); assert.equal(web.config.model, 'synthetic-agent-turn'); assert.deepEqual(web.config.scenarios, []);
  const x = await accept(web, 'correction', requests.rewrite);
  assert.equal(x.sessionId, web.config.persistentSession!.sessionId);
  const acknowledged = await h.profile.runtime.state(x.workId);
  assert.equal(acknowledged.goal.description, requests.rewrite); assert.deepEqual(acknowledged.goal.criteria, []);
  assert.equal(acknowledged.modelCalls.length, 0); assert.equal(acknowledged.attempts.length, 0);
  const initialView = snapshot(await web.request<WorkViewResult>(`/api/works/${x.workId}/view`));
  assert.deepEqual(initialView.messages.map(message => message.kind), ['ack']);
  assert.equal(initialView.progress.resultReady, false);
  assert.deepEqual(await accept(web, 'correction', requests.rewrite), { ...x, accepted: false });
  const completed = await run(web, x.workId, 'run-correction');
  assert.equal(completed.progress.status, 'completed'); assert.equal(completed.progress.resultDelivery, 'delivered');
  const result = completed.messages.filter(message => message.kind === 'result'); assert.equal(result.length, 1);
  assert.equal(result[0]!.text, `[합성 규칙 결과] ${correction}`);
  const xState = await h.profile.runtime.state(x.workId);
  assert.equal(xState.modelCalls.length, 1); assert.equal(xState.modelCalls[0]!.purpose, 'agent_turn'); assert.equal(xState.attempts.length, 0);
  const oldCookie = web.headers.Cookie; await h.reopen(); web = await h.connect({ sessionId: x.sessionId! });
  assert.equal((await fetch(`${web.web.origin}/api/session`, { headers: { Cookie: oldCookie } })).status, 401);
  for (const level of ['conversation', 'details', 'diagnostics']) await web.request(`/api/works/${x.workId}/view?level=${level}`);
  await web.request('/api/session'); await web.request('/api/works'); await web.request('/api/conversation');
  assert.deepEqual(await h.profile.runtime.state(x.workId), xState, 'Reconnect and GETs do not invoke the model or modify completed work.');
  const y = await accept(web, 'same-format', requests.followup); assert.equal(y.sessionId, x.sessionId); assert.notEqual(y.workId, x.workId);
  const yBefore = await h.profile.runtime.state(y.workId); assert.equal(yBefore.plan, null); assert.deepEqual(yBefore.evidence, []); assert.equal(yBefore.modelCalls.length, 0);
  const yView = await run(web, y.workId, 'run-followup'); assert.equal(yView.progress.status, 'completed');
  assert.equal(yView.messages.find(message => message.kind === 'result')?.text, `[합성 규칙 결과] ${correction}`);
  const yState = await h.profile.runtime.state(y.workId); const call = yState.modelCalls[0]!;
  const savedInput = AgentTurnCallInputSchema.parse(JSON.parse(new TextDecoder().decode(await h.profile.services.artifacts.get(call.inputArtifact, yState.policy))));
  assert.ok(savedInput.turn.packet.session?.entries.some(entry => entry.workId === x.workId && entry.role === 'assistant' && entry.text.includes(correction)));
  assert.equal(yState.attempts.length, 0); assert.deepEqual(await h.profile.runtime.state(x.workId), xState);
});

test('native HTTP reading request uses the real task executor once and projects its generated evidence-backed answer', async t => {
  const h = await fixture(t); const web = await h.connect(); const accepted = await accept(web, 'read-document', requests.read);
  const view = await run(web, accepted.workId, 'run-read-document');
  assert.equal(view.progress.status, 'completed'); assert.equal(view.progress.resultReady, true);
  assert.match(view.messages.find(message => message.kind === 'result')!.text, /doc-current.*30일/);
  const state = await h.profile.runtime.state(accepted.workId);
  assert.equal(state.attempts.length, 1); assert.equal(state.attempts[0]!.toolId, 'fixture.read'); assert.equal(state.attempts[0]!.status, 'succeeded');
  assert.equal(state.modelCalls.length, 2); assert.deepEqual(state.modelCalls.map(call => call.status), ['accepted', 'accepted']);
  assert.deepEqual(state.generatedAnswer?.evidenceIds, ['doc-current']); assert.equal(state.evidence[0]!.scope, h.profile.scope);
  const duplicate = await web.request<WebCommandResult>(`/api/works/${accepted.workId}/commands`, { kind: 'run', requestId: 'run-read-document', expectedGoalRevision: 1 });
  assert.equal(duplicate.duplicate, true); assert.deepEqual(await h.profile.runtime.state(accepted.workId), state);
});

test('native HTTP question, explicit original clarification and run resume the same work without pretending the question completed it', async t => {
  const h = await fixture(t); const web = await h.connect(); const accepted = await accept(web, 'question', requests.question);
  const asked = await run(web, accepted.workId, 'run-question');
  assert.equal(asked.progress.resultReady, false); assert.equal(asked.messages.some(message => message.kind === 'result'), false);
  assert.equal(asked.questions?.length, 1); const obligationId = asked.questions![0]!.id;
  const before = await h.profile.runtime.state(accepted.workId); assert.equal(before.modelCalls.length, 1); assert.notEqual(before.status, 'completed');
  await web.request(`/api/works/${accepted.workId}/commands`, { kind: 'resolve', requestId: 'clarify', expectedGoalRevision: 1,
    obligationId, reason: '사용자가 설명 대상을 명시했다.', rawText: requests.clarification });
  const clarified = await h.profile.runtime.state(accepted.workId);
  assert.equal(clarified.modelCalls.length, 1); assert.equal(clarified.conversation!.session!.scope.sessionId, accepted.sessionId);
  assert.equal(clarified.obligations.find(obligation => obligation.id === obligationId)?.status, 'satisfied');
  const final = await run(web, accepted.workId, 'run-clarified'); assert.equal(final.progress.status, 'completed');
  assert.match(final.messages.find(message => message.kind === 'result')!.text, /파생 기록/);
  const state = await h.profile.runtime.state(accepted.workId); assert.equal(state.modelCalls.length, 2); assert.equal(state.attempts.length, 0);
  const history = await web.request<WebConversation>('/api/conversation');
  assert.equal(history.entries.filter(entry => entry.role === 'user' && entry.text === requests.clarification).length, 1);
  assert.equal(history.entries.filter(entry => entry.role === 'user').every(entry => entry.workId === accepted.workId), true);
});

test('native HTTP another selected conversation cannot read or run a work from the original session', async t => {
  const h = await fixture(t); const original = await h.connect(); const accepted = await accept(original, 'private-session', requests.rewrite);
  const before = await h.profile.runtime.state(accepted.workId); const other = await h.connect({ newSession: true });
  assert.notEqual(other.config.persistentSession?.sessionId, accepted.sessionId);
  assert.deepEqual(await other.request(`/api/works/${accepted.workId}/view`, undefined, 403), { code: 'session_work_unavailable' });
  await other.request(`/api/works/${accepted.workId}/commands`, { kind: 'run', requestId: 'foreign-run', expectedGoalRevision: 1 }, 403);
  assert.deepEqual((await other.request<WorkList>('/api/works')).items, []);
  assert.deepEqual((await other.request<WebConversation>('/api/conversation')).entries, []);
  await original.request(`/api/works/${accepted.workId}/view`);
  assert.deepEqual(await h.profile.runtime.state(accepted.workId), before);
});

test('native HTTP general requests retain strict actor/policy/scenario rejection and the existing CSRF gate', async t => {
  const h = await fixture(t); const web = await h.connect(); const input = { requestId: 'injected', mode: 'auto', rawText: requests.rewrite };
  for (const injected of [{ actor: { tenantId: 'other', principalId: 'admin' } }, { policy: { allowWrites: true } }, { scenarioId: 'documents-simple' }])
    assert.deepEqual(await web.request('/api/requests', { ...input, ...injected }, 400), { code: 'invalid_web_input' });
  const denied = await fetch(`${web.web.origin}/api/requests`, { method: 'POST', headers: { ...web.headers, 'X-Work-CSRF': 'wrong' }, body: JSON.stringify(input) });
  assert.equal(denied.status, 403); assert.deepEqual(await denied.json(), { code: 'csrf_denied' });
  assert.deepEqual((await web.request<WorkList>('/api/works')).items, []);
  assert.deepEqual((await web.request<WebConversation>('/api/conversation')).entries, []);
});

test('native HTTP explicit goal replacement supersedes an old question, acknowledges without inference, then executes the new goal once', async t => {
  const h = await fixture(t); let web = await h.connect();
  const accepted = await accept(web, 'old-question', requests.question); const asked = await run(web, accepted.workId, 'ask-question');
  const questionId = asked.questions![0]!.id;
  const path = `/api/works/${accepted.workId}`, basis = await web.request<WebGoalBasis>(`${path}/goal-basis`);
  const original = await h.profile.runtime.state(accepted.workId);
  const command = { kind: 'request-goal', requestId: 'replace-question', rawText: requests.rewrite,
    expectedGoalRevision: basis.expectedGoalRevision, expectedControlRevision: basis.expectedControlRevision, expectedInput: basis.expectedInput, mode: basis.mode };
  const changed = await web.request<WebCommandResult>(`${path}/commands`, command);
  assert.equal(changed.accepted, true); assert.equal(changed.duplicate, false);
  const view = snapshot(changed.view); assert.equal(view.goalRevision, 2); assert.equal(view.progress.status, 'ready');
  assert.equal(view.progress.resultReady, false); assert.deepEqual(view.questions, []);
  const state = await h.profile.runtime.state(accepted.workId);
  assert.deepEqual(state.modelCalls, original.modelCalls); assert.deepEqual(state.budget, original.budget);
  assert.equal(state.obligations.find(item => item.id === questionId)!.status, 'waived');
  await h.reopen(); web = await h.connect({ sessionId: accepted.sessionId! });
  const retried = await web.request<WebCommandResult>(`${path}/commands`, command);
  assert.equal(retried.duplicate, true); assert.deepEqual(await h.profile.runtime.state(accepted.workId), state);
  const completed = snapshot((await web.request<WebCommandResult>(`${path}/commands`, { kind: 'run', requestId: 'run-new', expectedGoalRevision: 2 })).view);
  assert.equal(completed.progress.status, 'completed'); assert.equal(completed.goalRevision, 2);
  assert.equal(completed.messages.filter(item => item.kind === 'result').length, 1);
  assert.equal(completed.messages.find(item => item.kind === 'result')!.text, `[합성 규칙 결과] ${correction}`);
  const done = await h.profile.runtime.state(accepted.workId);
  await web.request(`${path}/commands`, command); assert.deepEqual(await h.profile.runtime.state(accepted.workId), done);
  await web.request(`${path}/commands`, { ...command, rawText: '다른 원문' }, 409);
  const history = await web.request<WebConversation>('/api/conversation');
  assert.deepEqual(history.entries.filter(item => item.role === 'user').map(item => item.text), [requests.question, requests.rewrite]);
});

test('native HTTP general goal editor rejects stale inputs and authority injection while preserving received rejection originals', async t => {
  const h = await fixture(t), web = await h.connect(), accepted = await accept(web, 'initial', requests.question);
  const path = `/api/works/${accepted.workId}`, basis = await web.request<WebGoalBasis>(`${path}/goal-basis`);
  const command = { kind: 'request-goal', requestId: 'stale-goal', rawText: requests.rewrite,
    expectedGoalRevision: basis.expectedGoalRevision, expectedControlRevision: basis.expectedControlRevision, expectedInput: basis.expectedInput, mode: basis.mode };
  for (const injection of [{ policy: { allowWrites: true } }, { scope: 'other' }, { goal: {} }, { criteria: [] }])
    await web.request(`${path}/commands`, { ...command, ...injection }, 400);
  const { expectedInput: _basis, ...missingBasis } = command;
  await web.request(`${path}/commands`, missingBasis, 400);
  await web.request(`${path}/inputs`, { requestId: 'new-input', expectedGoalRevision: 1, rawText: requests.clarification });
  const current = await h.profile.runtime.state(accepted.workId);
  assert.deepEqual(await web.request(`${path}/commands`, command, 409), { code: 'stale_session_input' });
  const currentDenied = await h.profile.runtime.state(accepted.workId);
  assert.deepEqual({ ...currentDenied, revision: current.revision, updatedAt: current.updatedAt }, current);
  const fresh = await web.request<WebGoalBasis>(`${path}/goal-basis`);
  assert.notDeepEqual(fresh.expectedInput, basis.expectedInput); assert.equal(fresh.expectedGoalRevision, basis.expectedGoalRevision);
  assert.equal(fresh.expectedControlRevision, basis.expectedControlRevision);
  const history = await web.request<WebConversation>('/api/conversation');
  assert(history.entries.some(item => item.role === 'user' && item.text === requests.rewrite && item.status === 'received'));
  const other = await h.connect({ newSession: true });
  await other.request(`${path}/goal-basis`, undefined, 403); await other.request(`${path}/commands`, command, 403);
  const denied = await fetch(`${web.web.origin}${path}/commands`, { method: 'POST', headers: { ...web.headers, 'X-Work-CSRF': 'wrong' }, body: JSON.stringify(command) });
  assert.equal(denied.status, 403); assert.deepEqual(await h.profile.runtime.state(accepted.workId), currentDenied);
});

test('native HTTP command identity survives goal-intent interruption, rejects run collisions and retains legacy session retries', async t => {
  const h = await fixture(t); let web = await h.connect();
  const accepted = await accept(web, 'intent-source', requests.question), path = `/api/works/${accepted.workId}`;
  const basis = await web.request<WebGoalBasis>(`${path}/goal-basis`);
  const command = { kind: 'request-goal', requestId: 'goal-intent', rawText: requests.rewrite,
    expectedGoalRevision: basis.expectedGoalRevision, expectedControlRevision: basis.expectedControlRevision,
    expectedInput: basis.expectedInput, mode: basis.mode };
  const digest = (value: unknown) => h.profile.services.digester.digest(JSON.parse(JSON.stringify(value)));
  const commandId = `web-command:${digest({ actor: h.profile.executionActor, conversationId: 'web', requestId: command.requestId })}`;
  const before = await h.profile.runtime.state(accepted.workId), scope = before.conversation!.session!.scope;
  const receive = h.profile.sessions.repository.receive.bind(h.profile.sessions.repository); let attemptedIntake = 0;
  h.profile.sessions.repository.receive = async () => { attemptedIntake++; throw new Error('goal_intake_interrupted'); };
  try { assert.deepEqual(await web.request(`${path}/commands`, command, 500), { code: 'request_failed' }); }
  finally { h.profile.sessions.repository.receive = receive; }
  assert.equal(attemptedIntake, 1);
  assert.equal(await h.profile.sessions.repository.input(scope, commandId), null);
  const intent = await h.profile.services.state.receipt(accepted.workId, commandId); assert.ok(intent);
  assert.equal(intent.digest, digest({ type: 'web_session_command_requested',
    data: { actor: h.profile.executionActor, conversationId: 'web', input: command } }));
  const afterIntent = await h.profile.runtime.state(accepted.workId);
  assert.deepEqual({ ...afterIntent, revision: before.revision, updatedAt: before.updatedAt }, before);
  const events = await h.profile.services.state.events(accepted.workId, 0);
  const received = events.filter(event => event.commandId === commandId && event.type === 'web_session_command_requested');
  assert.equal(received.length, 1);
  assert.deepEqual((received[0]!.data['payload'] as { input: unknown }).input, command, 'The complete goal original precedes inbox publication.');
  await h.reopen(); web = await h.connect({ sessionId: accepted.sessionId! });
  const resumed = await web.request<WebCommandResult>(`${path}/commands`, command);
  assert.equal(resumed.duplicate, true); assert.equal(snapshot(resumed.view).goalRevision, 2);
  const changed = await h.profile.runtime.state(accepted.workId);
  assert.equal(changed.modelCalls.length, 0); assert.equal(changed.goal.description, requests.rewrite);
  assert.equal((await h.profile.sessions.repository.input(scope, commandId))!.status, 'applied');
  assert.deepEqual(await web.request(`${path}/commands`, { kind: 'run', requestId: command.requestId, expectedGoalRevision: 2 }, 409),
    { code: 'idempotency_conflict' });
  assert.deepEqual(await h.profile.runtime.state(accepted.workId), changed);
  const repeated = await web.request<WebCommandResult>(`${path}/commands`, command); assert.equal(repeated.duplicate, true);
  assert.deepEqual(await h.profile.runtime.state(accepted.workId), changed);
  const runInput = { kind: 'run', requestId: 'fresh-run', expectedGoalRevision: 2 };
  const done = await web.request<WebCommandResult>(`${path}/commands`, runInput);
  assert.equal(snapshot(done.view).progress.status, 'completed');
  const final = await h.profile.runtime.state(accepted.workId), next = await web.request<WebGoalBasis>(`${path}/goal-basis`);
  assert.deepEqual(await web.request(`${path}/commands`, { ...command, requestId: runInput.requestId,
    rawText: requests.question, expectedGoalRevision: next.expectedGoalRevision, expectedControlRevision: next.expectedControlRevision,
    expectedInput: next.expectedInput, mode: next.mode }, 409), { code: 'idempotency_conflict' });
  assert.equal((await web.request<WebCommandResult>(`${path}/commands`, runInput)).duplicate, true);
  assert.deepEqual(await h.profile.runtime.state(accepted.workId), final);

  // This is the former session-only Web storage shape, constructed through the real service.
  const legacy = await accept(web, 'legacy-source', requests.question), legacyPath = `/api/works/${legacy.workId}`;
  const legacyBasis = await web.request<WebGoalBasis>(`${legacyPath}/goal-basis`);
  const legacyInput = { kind: 'mode' as const, requestId: 'legacy-mode', expectedGoalRevision: 1,
    expectedControlRevision: legacyBasis.expectedControlRevision, mode: 'deep' as const, reason: 'explicit mode', rawText: '깊게 조사해 줘.' };
  const legacyId = `web-command:${digest({ actor: h.profile.executionActor, conversationId: 'web', requestId: legacyInput.requestId })}`;
  await h.profile.sessions.command(h.profile.executionActor, { sessionId: accepted.sessionId!, workId: legacy.workId,
    messageId: legacyId, rawText: legacyInput.rawText, expectedGoalRevision: 1,
    command: { kind: 'mode', mode: legacyInput.mode, reason: legacyInput.reason, expectedControlRevision: legacyInput.expectedControlRevision } });
  const legacyState = await h.profile.runtime.state(legacy.workId);
  assert.equal(await h.profile.services.state.receipt(legacy.workId, legacyId), null);
  assert.equal((await web.request<WebCommandResult>(`${legacyPath}/commands`, legacyInput)).duplicate, true);
  assert.deepEqual(await h.profile.runtime.state(legacy.workId), legacyState);
  assert.deepEqual(await web.request(`${legacyPath}/commands`, { kind: 'run', requestId: legacyInput.requestId, expectedGoalRevision: 1 }, 409),
    { code: 'idempotency_conflict' });
  const legacyCurrent = await web.request<WebGoalBasis>(`${legacyPath}/goal-basis`);
  await web.request(`${legacyPath}/commands`, { ...command, requestId: legacyInput.requestId,
    expectedGoalRevision: legacyCurrent.expectedGoalRevision, expectedControlRevision: legacyCurrent.expectedControlRevision,
    expectedInput: legacyCurrent.expectedInput, mode: legacyCurrent.mode }, 409);
  assert.equal(await h.profile.services.state.receipt(legacy.workId, legacyId), null, 'A conflicting request cannot poison the legacy identity.');
  assert.equal((await web.request<WebCommandResult>(`${legacyPath}/commands`, legacyInput)).duplicate, true);
  assert.deepEqual(await h.profile.runtime.state(legacy.workId), legacyState);
});

test('native HTTP run and goal from separate coordinators race on one durable command receipt', async t => {
  const h = await fixture(t), web = await h.connect(), accepted = await accept(web, 'race-source', requests.rewrite);
  const path = `/api/works/${accepted.workId}`, basis = await web.request<WebGoalBasis>(`${path}/goal-basis`);
  const goalInput = { kind: 'request-goal', requestId: 'competing-id', rawText: requests.question,
    expectedGoalRevision: basis.expectedGoalRevision, expectedControlRevision: basis.expectedControlRevision,
    expectedInput: basis.expectedInput, mode: basis.mode };
  const digest = (value: unknown) => h.profile.services.digester.digest(JSON.parse(JSON.stringify(value)));
  const commandId = `web-command:${digest({ actor: h.profile.executionActor, conversationId: 'web', requestId: goalInput.requestId })}`;
  const adapted = agentTurnWorkbenchProfile(h.profile);
  const independentState = new Proxy(adapted.services.state, { get(target, key) {
    const value: unknown = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  // A separate host wrapper bypasses the in-memory request coordinator but uses the same real SQLite CAS.
  const peer = new LocalWorkbench({ ...adapted, services: { ...adapted.services, state: independentState } },
    h.profile.executionActor, 'web', { sessionId: accepted.sessionId! });
  await peer.initializeSession(); const server = await startWebServer(peer);
  let release = () => {}, entered = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
  const commit = h.profile.services.state.commit.bind(h.profile.services.state);
  let intercepted = 0, timeout: ReturnType<typeof setTimeout> | undefined, pending: Promise<unknown> | undefined;
  try {
    const login = await fetch(`${server.origin}/api/session`, { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: new URL(server.connectUrl).hash.slice(9) }), signal: AbortSignal.timeout(30000) });
    assert.equal(login.status, 200); const session = await login.json() as { csrf: string };
    const headers = { Cookie: login.headers.get('set-cookie')!.split(';')[0]!, Origin: server.origin,
      'Content-Type': 'application/json', 'X-Work-CSRF': session.csrf };
    h.profile.services.state.commit = async proposal => {
      if (proposal.commandId === commandId && proposal.events.some(event => event.type === 'web_session_command_requested')) {
        intercepted++; entered(); await gate;
      }
      return commit(proposal);
    };
    pending = web.request(`${path}/commands`, goalInput, 409); void pending.catch(() => {});
    await Promise.race([reached, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('goal_intent_boundary_not_reached')), 5000);
    })]);
    clearTimeout(timeout); timeout = undefined;
    const runInput = { kind: 'run', requestId: goalInput.requestId, expectedGoalRevision: 1 };
    const response = await fetch(`${server.origin}${path}/commands`, { method: 'POST', headers,
      body: JSON.stringify(runInput), signal: AbortSignal.timeout(30000) });
    const result = await response.json() as WebCommandResult; assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.duplicate, false); assert.equal(snapshot(result.view).progress.status, 'completed');
    release(); assert.deepEqual(await pending, { code: 'idempotency_conflict' });
    assert.equal(intercepted, 1);
    const state = await h.profile.runtime.state(accepted.workId);
    assert.equal(state.goal.revision, 1); assert.equal(state.goal.description, requests.rewrite); assert.equal(state.modelCalls.length, 1);
    const receipt = await h.profile.services.state.receipt(accepted.workId, commandId); assert.ok(receipt);
    assert.equal(receipt.digest, digest({ type: 'web_run_requested', data: { actor: h.profile.executionActor, conversationId: 'web', input: runInput } }));
    assert.equal(await h.profile.sessions.repository.input(state.conversation!.session!.scope, commandId), null);
    assert.equal((await h.profile.services.state.events(accepted.workId, 0)).filter(event => event.commandId === commandId).length, 1);
    assert.equal((await web.request<WebCommandResult>(`${path}/commands`, runInput)).duplicate, true);
    assert.deepEqual(await web.request(`${path}/commands`, goalInput, 409), { code: 'idempotency_conflict' });
    assert.deepEqual(await h.profile.runtime.state(accepted.workId), state);
  } finally {
    if (timeout) clearTimeout(timeout); release();
    if (pending) await Promise.allSettled([pending]);
    h.profile.services.state.commit = commit; await server.close();
  }
});
