import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Policy } from '../domain/model.js';
import type { WorkActor } from '../application/work-resources.js';
import { agentTurnWorkbenchProfile, LocalWorkbench } from '../presentation/local-workbench.js';
import { startWebServer } from '../presentation/web-server.js';
import type { WebResidentMissionStatus, WebResidentMissionCommandResult, WorkbenchConfig } from '../presentation/web-contracts.js';
import { residentEntryFixture, RESIDENT_RULE } from './resident-missions-entry-fixture.js';
import { bounded, gate } from './mission-runtime-fixture.js';

async function fixture(t: TestContext) {
  const servers = new Set<Awaited<ReturnType<typeof startWebServer>>>();
  const closeServers = async () => { for (const server of servers) { await server.close(); servers.delete(server); } };
  t.after(closeServers);
  const f = await residentEntryFixture(t);
  async function connect(options: { conversationId?: string; sessionId?: string; newSession?: boolean; actor?: WorkActor } = {}) {
    const p = f.current(), actor = options.actor ?? p.executionActor, conversationId = options.conversationId ?? 'resident-web';
    const workbench = new LocalWorkbench(agentTurnWorkbenchProfile(p), actor, conversationId, {
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.newSession === undefined ? {} : { newSession: options.newSession }),
    });
    await workbench.initializeSession();
    const web = await startWebServer(workbench); servers.add(web);
    const login = await fetch(`${web.origin}/api/session`, { method: 'POST', headers: { Origin: web.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: new URL(web.connectUrl).hash.slice(9) }), signal: AbortSignal.timeout(30000) });
    assert.equal(login.status, 200);
    const value = await login.json() as { csrf: string; config: WorkbenchConfig };
    const headers = { Cookie: login.headers.get('set-cookie')!.split(';')[0]!, Origin: web.origin,
      'Content-Type': 'application/json', 'X-Work-CSRF': value.csrf };
    async function request<T = unknown>(path: string, body?: unknown, expected = 200): Promise<T> {
      const response = await fetch(`${web.origin}${path}`, { headers, signal: AbortSignal.timeout(30000),
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      const output: unknown = await response.json(); assert.equal(response.status, expected, JSON.stringify(output)); return output as T;
    }
    return { web, workbench, config: value.config, headers, request };
  }
  async function register(client: Awaited<ReturnType<typeof connect>>, policy: Policy = f.current().policy) {
    const p = f.current(), sessionId = client.config.persistentSession?.sessionId; assert.ok(sessionId);
    const driver = p.createResidentMissions({ binding: { tenantId: p.actor.tenantId, principalId: p.actor.principalId,
      channel: 'web', conversationId: client.config.conversationId, destination: 'local', recipientId: p.actor.principalId }, policy, limits: p.limits });
    const registered = await driver.register({ rule: RESIDENT_RULE, instruction: 'Observe only explicit host-controlled events.', sessionId });
    return { driver, ...registered };
  }
  return { f, connect, register, async reopen() { await closeServers(); await f.reopen(); } };
}
const statusPath = (workId: string) => `/api/resident-missions/${encodeURIComponent(workId)}/status`;
const commandPath = (workId: string) => `/api/resident-missions/${encodeURIComponent(workId)}/commands`;
const outcome = <T>(pending: Promise<T>) => pending.then(value => ({ kind: 'resolved' as const, value }), error => ({ kind: 'rejected' as const, error }));

test('resident mission Web: stable commands replay across resume and reopen without cancelling a newer poll', { timeout: 120000 }, async t => {
  const h = await fixture(t); let client = await h.connect();
  assert.equal(client.config.residentMissions, true);
  const registered = await h.register(client), sessionId = registered.sessionId;
  const initial = await client.request<WebResidentMissionStatus>(statusPath(registered.workId));
  assert.equal(initial.status, 'active'); assert.equal(initial.controlRevision, 0);
  const entered = [gate<AbortSignal>(), gate<AbortSignal>()], release = [gate<void>(), gate<void>()]; let calls = 0;
  h.f.controls.beforePoll = async (role, signal) => {
    assert.equal(role, 'first'); const index = calls++; assert.ok(index < 2);
    entered[index]!.resolve(signal); await release[index]!.promise;
  };
  const running: Promise<unknown>[] = [];
  const pause = { commandId: 'web-pause-stable', expectedControlRevision: initial.controlRevision, kind: 'pause' as const };
  let paused: WebResidentMissionCommandResult | undefined;
  let originalReceipt: unknown = null;
  let receiptId = '';
  try {
    const first = outcome(registered.driver.tick(registered.workId)); running.push(first);
    const oldSignal = await bounded(entered[0]!.promise, 30000);
    paused = await client.request<WebResidentMissionCommandResult>(commandPath(registered.workId), pause);
    assert.equal(paused.replayed, false); assert.equal(paused.current.status, 'paused');
    assert.equal(paused.appliedControlRevision, initial.controlRevision + 1);
    assert.equal(oldSignal.aborted, true); assert.equal((await bounded(first, 30000)).kind, 'rejected');
    const event = (await h.f.current().services.state.events(registered.workId, 0)).find(value => value.revision === paused!.appliedStateRevision);
    assert.ok(event); assert.equal(event.type, 'resident_control'); receiptId = event.commandId;
    originalReceipt = await h.f.current().services.state.receipt(registered.workId, receiptId); assert.ok(originalReceipt);
    const resumed = await client.request<WebResidentMissionCommandResult>(commandPath(registered.workId), {
      commandId: 'web-resume-stable', expectedControlRevision: paused.current.controlRevision, kind: 'resume',
    });
    assert.equal(resumed.current.status, 'active');
    const second = outcome(registered.driver.tick(registered.workId)); running.push(second);
    const newSignal = await bounded(entered[1]!.promise, 30000), beforeReplay = await h.f.current().runtime.state(registered.workId);
    const replay = await client.request<WebResidentMissionCommandResult>(commandPath(registered.workId), pause);
    assert.equal(replay.replayed, true); assert.equal(replay.appliedStateRevision, paused.appliedStateRevision);
    assert.equal(replay.appliedControlRevision, paused.appliedControlRevision); assert.equal(replay.current.status, 'active');
    assert.equal(newSignal.aborted, false); assert.deepEqual(await h.f.current().runtime.state(registered.workId), beforeReplay);
    assert.deepEqual(await h.f.current().services.state.receipt(registered.workId, receiptId), originalReceipt);
    assert.deepEqual(await client.request(commandPath(registered.workId), { ...pause, kind: 'stop' }, 409), { code: 'resident_control_conflict' });
    assert.deepEqual(await client.request(commandPath(registered.workId), { ...pause, commandId: 'web-stale-new' }, 409), { code: 'resident_control_stale' });
    assert.equal(newSignal.aborted, false); assert.deepEqual(await h.f.current().runtime.state(registered.workId), beforeReplay);
    const stopped = await client.request<WebResidentMissionCommandResult>(commandPath(registered.workId), {
      commandId: 'web-stop-stable', expectedControlRevision: resumed.current.controlRevision, kind: 'stop',
    });
    assert.equal(stopped.current.status, 'closed'); assert.equal(newSignal.aborted, true);
    assert.equal((await bounded(second, 30000)).kind, 'rejected');
  } finally {
    delete h.f.controls.beforePoll; for (const held of release) held.resolve();
    await registered.driver.close(); await Promise.allSettled(running);
  }
  assert.ok(paused); await h.reopen(); client = await h.connect({ sessionId });
  const beforeReplay = await h.f.current().runtime.state(registered.workId);
  const replay = await client.request<WebResidentMissionCommandResult>(commandPath(registered.workId), pause);
  assert.equal(replay.replayed, true); assert.equal(replay.current.status, 'closed');
  assert.equal(replay.appliedStateRevision, paused.appliedStateRevision); assert.equal(replay.appliedControlRevision, paused.appliedControlRevision);
  assert.deepEqual(await h.f.current().runtime.state(registered.workId), beforeReplay);
  assert.deepEqual(await h.f.current().services.state.receipt(registered.workId, receiptId), originalReceipt);
  assert.equal(h.f.observed.polls.length, 2); assert.equal(h.f.observed.inputs.first.length + h.f.observed.inputs.second.length, 0);
  assert.equal(beforeReplay.attempts.length + beforeReplay.modelCalls.length, 0);
});

test('resident mission Web: authentication, CSRF and exact user selection reject commands without changing the controller', { timeout: 120000 }, async t => {
  const h = await fixture(t), client = await h.connect(), registered = await h.register(client);
  const before = await h.f.current().runtime.state(registered.workId), events = await h.f.current().services.state.events(registered.workId, 0);
  const command = { commandId: 'web-auth-control', expectedControlRevision: 0, kind: 'pause' };
  const unauthenticated = await fetch(client.web.origin + statusPath(registered.workId), { signal: AbortSignal.timeout(30000) });
  assert.equal(unauthenticated.status, 401); assert.deepEqual(await unauthenticated.json(), { code: 'session_required' });
  for (const csrf of [undefined, 'wrong-csrf']) {
    const headers: Record<string, string> = { Cookie: client.headers.Cookie, Origin: client.web.origin, 'Content-Type': 'application/json' };
    if (csrf !== undefined) headers['X-Work-CSRF'] = csrf;
    const response = await fetch(client.web.origin + commandPath(registered.workId), { method: 'POST', headers,
      body: JSON.stringify(command), signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 403); assert.deepEqual(await response.json(), { code: 'csrf_denied' });
  }
  await client.request(commandPath(registered.workId), { ...command, sessionId: registered.sessionId }, 400);
  await client.request(commandPath(registered.workId), { ...command, expectedControlRevision: -1 }, 400);
  await client.request(statusPath(registered.workId) + '?sessionId=' + encodeURIComponent(registered.sessionId), undefined, 400);
  const sameConversation = await h.connect({ newSession: true }), otherConversation = await h.connect({ conversationId: 'another-conversation' });
  assert.notEqual(sameConversation.config.persistentSession!.sessionId, registered.sessionId);
  for (const other of [sameConversation, otherConversation]) {
    assert.deepEqual(await other.request(statusPath(registered.workId), undefined, 403), { code: 'resident_selection_mismatch' });
    assert.deepEqual(await other.request(commandPath(registered.workId), command, 403), { code: 'resident_selection_mismatch' });
  }
  const foreign = await h.connect({ actor: { ...h.f.current().executionActor, principalId: 'another-operator' } });
  assert.deepEqual(await foreign.request(statusPath(registered.workId), undefined, 403), { code: 'work_view_denied' });
  assert.deepEqual(await foreign.request(commandPath(registered.workId), command, 403), { code: 'work_view_denied' });
  assert.deepEqual(await client.request(`/api/works/${encodeURIComponent(registered.workId)}/view`, undefined, 403), { code: 'session_work_unavailable' });
  assert.deepEqual(await h.f.current().runtime.state(registered.workId), before);
  assert.deepEqual(await h.f.current().services.state.events(registered.workId, 0), events);
  assert.equal(h.f.observed.polls.length + h.f.observed.inputs.first.length + h.f.observed.inputs.second.length, 0);
});

test('resident mission Web: disabled mission registration is advertised and cannot create a controller', { timeout: 120000 }, async t => {
  const h = await fixture(t), path = join(h.f.base, 'first', 'config.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...config, features: { ...config.features, missions: false } }), { mode: 0o600 });
  await h.reopen(); const client = await h.connect(); assert.equal(client.config.residentMissions, false);
  assert.equal(h.f.current().missions, null);
  assert.deepEqual(await client.request(statusPath('unregistered-controller'), undefined, 409), { code: 'agent_mission_registration_required' });
  assert.deepEqual(await client.request(commandPath('unregistered-controller'), { commandId: 'off-control', expectedControlRevision: 0, kind: 'pause' }, 409),
    { code: 'agent_mission_registration_required' });
  assert.deepEqual(await client.request('/api/works'), { items: [], nextCursor: null });
  assert.equal(h.f.observed.polls.length + h.f.observed.inputs.first.length + h.f.observed.inputs.second.length, 0);
});

test('resident mission Web: matching user selection does not bypass screen disclosure', { timeout: 120000 }, async t => {
  const h = await fixture(t), client = await h.connect(), policy = structuredClone(h.f.current().policy);
  policy.disclosure = { revision: 'resident-no-screen', destinations: [{ destination: 'local', surfaces: ['tool', 'channel', 'model', 'log'],
    allowedLabels: [...policy.allowedLabels] }], maxReleasesPerWork: 10, maxReleasedBytesPerWork: 65536 };
  const registered = await h.register(client, policy), before = await h.f.current().runtime.state(registered.workId);
  assert.deepEqual(await client.request(statusPath(registered.workId), undefined, 403), { code: 'work_view_denied' });
  assert.deepEqual(await client.request(commandPath(registered.workId), { commandId: 'no-screen-control', expectedControlRevision: 0, kind: 'pause' }, 403),
    { code: 'work_view_denied' });
  assert.deepEqual(await h.f.current().runtime.state(registered.workId), before);
  assert.equal(h.f.observed.polls.length + h.f.observed.inputs.first.length + h.f.observed.inputs.second.length, 0);
});
