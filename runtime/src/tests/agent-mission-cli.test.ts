import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ResidentMissions } from '../application/resident-missions.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { runAgentMissionCli } from '../presentation/agent-mission-cli.js';
import { agentLaunchDirectory, agentPreparationDirectory } from '../presentation/agent-cli-options.js';
import { HOST_ENTRY_PROFILE } from './host-tool-entry-fixture.js';
import { residentControlEntryHost, RESIDENT_CONTROL_ENTRY_RULE } from './resident-control-entry-host.js';

const execute = promisify(execFile), runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
const worker = fileURLToPath(new URL('./helpers/agent-mission-cli-worker.js', import.meta.url));
type Status = Awaited<ReturnType<ResidentMissions['status']>>;
type Control = Awaited<ReturnType<ResidentMissions['control']>>;
async function fixture(t: TestContext, backend: 'sqlite' | 'file-journal' = 'sqlite') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-mission-cli-'))), directory = join(base, 'agent'), registry = join(base, 'registry');
  const profiles = new FileAgentProfileStore(runtimeRoot), ready = profiles.initialize(directory, { stateBackend: backend });
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ ...ready.config, model: { profile: HOST_ENTRY_PROFILE },
    features: { ...ready.config.features, missions: true }, skills: { mode: 'off' } }), { mode: 0o600 });
  t.after(() => rmSync(base, { recursive: true, force: true }));
  async function open() {
    const entry = residentControlEntryHost(registry), profile = await openAgentTurnProfile(directory, { provider: 'registered' }, entry.host);
    return { profile, async close() { await profile.close(); entry.assertIdleAndClosed(); } };
  }
  const initial = await open(); let workId: string, sessionId: string, otherSessionId: string;
  try {
    const p = initial.profile, session = await p.sessions.open(p.actor, { channel: 'cli', conversationId: 'terminal' });
    sessionId = session.scope.sessionId;
    const driver = p.createResidentMissions({ policy: p.policy, limits: p.limits,
      binding: { ...p.executionActor, channel: 'cli', conversationId: 'terminal', destination: 'local', recipientId: p.actor.principalId } });
    workId = (await driver.register({ rule: RESIDENT_CONTROL_ENTRY_RULE, instruction: 'Handle local observations when the host explicitly runs this mission.', sessionId })).workId;
    otherSessionId = (await p.sessions.open(p.actor, { channel: 'cli', conversationId: 'terminal', newSession: true })).scope.sessionId;
  } finally { await initial.close(); }
  async function image() {
    const h = await open();
    try {
      const state = await h.profile.runtime.state(workId), events = await h.profile.services.state.events(workId, 0);
      const receipts = await Promise.all(events.map(async event => ({ commandId: event.commandId,
        receipt: await h.profile.services.state.receipt(workId, event.commandId) })));
      const history = await h.profile.sessions.history(h.profile.actor, sessionId, h.profile.policy, { limit: 100 });
      return { state, events, receipts, history };
    } finally { await h.close(); }
  }
  const baseArgs = ['--directory', directory, '--provider', 'registered', '--work', workId, '--session', sessionId];
  async function raw(args: string[], options: { json?: boolean; noMissions?: boolean } = {}) {
    return execute(process.execPath, [worker, 'mission', ...args, ...baseArgs, ...(options.json === false ? [] : ['--json'])], {
      timeout: 45000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, SECUMON_RESIDENT_CLI_REGISTRY: registry, ...(options.noMissions ? { SECUMON_RESIDENT_CLI_NO_MISSIONS: '1' } : {}) },
    });
  }
  async function call<T = Status>(args: string[]) { const result = await raw(args); assert.doesNotMatch(result.stdout, /\u001b/); return JSON.parse(result.stdout) as T; }
  async function failure(args: string[], code: string, options: { noMissions?: boolean } = {}) {
    await assert.rejects(raw(args, options), (error: unknown) => {
      const result = error as { code?: number; stdout?: string; stderr?: string };
      assert.equal(result.code, 1); assert.equal(result.stdout, '');
      const lines = result.stderr!.trim().split('\n').filter(line => line.startsWith('{'));
      assert.deepEqual(JSON.parse(lines.at(-1)!), { code }); return true;
    });
  }
  return { base, directory, registry, workId, sessionId, otherSessionId, image, call, failure, raw };
}

for (const backend of ['sqlite', 'file-journal'] as const) test(`${backend}: native mission CLI controls only the resident and replays an old pause without changing a newer resume`, { timeout: 180000 }, async t => {
  const f = await fixture(t, backend), initial = await f.image();
  const status = await f.call(['status']); assert.equal(status.status, 'active'); assert.equal(status.controlRevision, 0);
  assert.equal(status.sessionId, f.sessionId); assert.equal(status.stateRevision, initial.state.revision);
  assert.deepEqual(await f.image(), initial, 'status does not append session input or state records');
  const pause = ['pause', '--command-id', 'pause-original', '--control-revision', '0'];
  const paused = await f.call<Control>(pause); assert.equal(paused.replayed, false); assert.equal(paused.current.status, 'paused');
  assert.equal(paused.appliedControlRevision, 1); assert.equal(paused.current.controlRevision, 1);
  const resumed = await f.call<Control>(['resume', '--command-id', 'resume-next', '--control-revision', '1']);
  assert.equal(resumed.current.status, 'active'); assert.equal(resumed.current.controlRevision, 2);
  const beforeReplay = await f.image(), replayed = await f.call<Control>(pause);
  assert.equal(replayed.replayed, true); assert.equal(replayed.appliedControlRevision, 1);
  assert.equal(replayed.appliedStateRevision, paused.appliedStateRevision); assert.equal(replayed.current.controlRevision, 2);
  assert.equal(replayed.current.status, 'active'); assert.deepEqual(await f.image(), beforeReplay);
  const stopped = await f.call<Control>(['stop', '--command-id', 'stop-final', '--control-revision', '2']);
  assert.equal(stopped.current.status, 'closed'); assert.equal(stopped.current.controlRevision, 3);
  const final = await f.image(); assert.deepEqual(final.history, initial.history);
  assert.deepEqual(final.state.budget, initial.state.budget); assert.deepEqual(final.state.modelCalls, []); assert.deepEqual(final.state.attempts, []);
  assert.deepEqual(final.events.slice(0, initial.events.length), initial.events);
  for (const original of initial.receipts) assert.deepEqual(final.receipts.find(value => value.commandId === original.commandId), original);
  const text = await f.raw(['status'], { json: false }); assert.match(text.stdout, /임무 종료.*제어 버전 3.*대기 사건 0건/);
  assert.match(text.stdout, /사용자 대화/); assert.doesNotMatch(text.stdout, /resident_mission_registration|Handle local observations/);
  assert.deepEqual(await f.image(), final);
});

test('native mission CLI reports stale commands, payload conflicts, foreign selection and disabled registration without changing the controller', { timeout: 150000 }, async t => {
  const f = await fixture(t);
  await f.call<Control>(['pause', '--command-id', 'same-command', '--control-revision', '0']);
  const paused = await f.image();
  await f.failure(['resume', '--command-id', 'stale-command', '--control-revision', '0'], 'resident_control_stale');
  await f.failure(['stop', '--command-id', 'same-command', '--control-revision', '0'], 'resident_control_conflict');
  await f.failure(['status', '--conversation', 'other-conversation'], 'resident_selection_mismatch');
  // Supply the other session after the fixture arguments using an explicit subprocess invocation.
  await assert.rejects(execute(process.execPath, [worker, 'mission', 'status', '--directory', f.directory, '--provider', 'registered',
    '--work', f.workId, '--session', f.otherSessionId, '--json'], { timeout: 45000, env: { ...process.env, SECUMON_RESIDENT_CLI_REGISTRY: f.registry } }),
  (error: unknown) => { assert.match((error as { stderr: string }).stderr, /resident_selection_mismatch/); return true; });
  await f.failure(['status'], 'agent_mission_registration_required', { noMissions: true });
  assert.deepEqual(await f.image(), paused);
  const stopped = await f.call<Control>(['stop', '--command-id', 'stop-existing', '--control-revision', '1']);
  const before = await f.image();
  const replayed = await f.call<Control>(['stop', '--command-id', 'stop-existing', '--control-revision', '1']);
  assert.equal(replayed.replayed, true); assert.equal(replayed.appliedStateRevision, stopped.appliedStateRevision);
  await f.failure(['resume', '--command-id', 'new-after-stop', '--control-revision', String(stopped.current.controlRevision)], 'resident_mission_closed');
  assert.deepEqual(await f.image(), before);
});

test('mission CLI validates options before profile access and launches an existing selected engine without preparing a new agent', async t => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mission-cli-options-'))), directory = join(base, 'missing');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const options = ['--directory', directory, '--provider', 'registered', '--work', 'resident', '--session', 'session'];
  for (const [args, message] of [
    [['status', '--command-id', 'unsupported'], 'resident_cli_option_not_supported'],
    [['status', '--control-revision', '0'], 'resident_cli_option_not_supported'],
    [['pause'], 'resident_command_id_required'],
    [['pause', '--command-id', 'required'], 'resident_control_revision_required'],
    [['pause', '--command-id', 'invalid', '--control-revision=-1'], 'resident_control_revision_invalid'],
    [['pause', '--command-id', 'invalid', '--control-revision', '1.5'], 'resident_control_revision_invalid'],
    [['run'], 'resident_cli_command_invalid'],
  ] as const) await assert.rejects(runAgentMissionCli([...args, ...options]), error => error instanceof Error && error.message === message);
  await assert.rejects(runAgentMissionCli(['pause', '--command-id', 'invalid', '--control-revision', '-1', ...options]),
    error => error instanceof TypeError && (error as NodeJS.ErrnoException).code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE');
  await assert.rejects(runAgentMissionCli(['status', ...options]), /resident_agent_not_ready/);
  assert.equal(existsSync(directory), false);
  const args = ['mission', 'status', '--directory', directory];
  assert.equal(agentLaunchDirectory(args, base), directory); assert.equal(agentPreparationDirectory(args, base), null);
  assert.equal(agentLaunchDirectory(['mission', 'pause', '--directory', 'first', '--directory=last'], base), 'last');
  assert.equal(agentLaunchDirectory(['mission', 'status', '--unknown'], base), null);
  assert.equal(agentLaunchDirectory(['mission', 'help'], base), null);
});
