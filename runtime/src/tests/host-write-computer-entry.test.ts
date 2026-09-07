import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { openAgentWeb } from '../presentation/agent-web.js';
import type { WebAcceptResult, WebCommandResult } from '../presentation/web-contracts.js';
import { writeComputerEntryFixture, WRITE_COMPUTER_PROFILE, WRITE_TOOL, COMPUTER_ID, ENTRY_TEXT, type WriteComputerEntryOptions } from './host-write-computer-entry-fixture.js';

const execute = promisify(execFile), runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
function fixture(t: TestContext, backend: 'sqlite' | 'file-journal', mode: WriteComputerEntryOptions['mode']) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'host-write-computer-'))), directory = join(base, 'agent');
  const ready = new FileAgentProfileStore(runtimeRoot).initialize(directory, { stateBackend: backend });
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ ...ready.config, model: { profile: WRITE_COMPUTER_PROFILE } }), { mode: 0o600 });
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, directory, options: { base, mode } as WriteComputerEntryOptions };
}
interface Chat { workId: string; sessionId: string; accepted: boolean; snapshot: { status: string; resultReady: boolean;
  usage: { toolCalls: number; modelCalls: number } }; messages: { kind: string; text: string }[] }
async function cli(directory: string, options: WriteComputerEntryOptions, args: string[]) {
  const program = `import {runAgentTurnCli} from ${JSON.stringify(new URL('../presentation/agent-turn-cli.js', import.meta.url).href)};
import {writeComputerEntryFixture} from ${JSON.stringify(new URL('./host-write-computer-entry-fixture.js', import.meta.url).href)};
await runAgentTurnCli(process.argv.slice(1),writeComputerEntryFixture(${JSON.stringify(options)}).host);`;
  const response = await execute(process.execPath, ['--input-type=module', '-e', program, ...args, '--directory', directory, '--provider', 'registered', '--json'],
    { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(response.stdout) as Chat;
}
function externalCounts(options: WriteComputerEntryOptions) {
  if (options.mode === 'write') return { writes: readdirSync(options.base).filter(name => name.startsWith('write-') && name.endsWith('.json')).length };
  const stored = JSON.parse(readFileSync(join(options.base, 'computer-app.json'), 'utf8'));
  return { inputs: stored.app.inputCount as number, saves: stored.app.saveCount as number, savedNote: stored.app.savedNote as string };
}
const expectedCounts = (mode: WriteComputerEntryOptions['mode']) => mode === 'write' ? { writes: 1 } : { inputs: 2, saves: 1, savedNote: 'reviewed' };

async function connect(directory: string, options: WriteComputerEntryOptions, sessionId?: string) {
  const fixture = writeComputerEntryFixture(options);
  const app = await openAgentWeb(['--directory', directory, '--provider', 'registered', '--conversation', 'host-effects',
    ...(sessionId ? ['--session', sessionId] : [])], fixture.host); assert.ok(app);
  try {
    const login = await fetch(`${app.server.origin}/api/session`, { method: 'POST', headers: { Origin: app.server.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: new URL(app.server.connectUrl).hash.slice(9) }), signal: AbortSignal.timeout(30000) });
    assert.equal(login.status, 200); const session = await login.json() as { csrf: string };
    const headers = { Cookie: login.headers.get('set-cookie')!.split(';')[0]!, Origin: app.server.origin, 'Content-Type': 'application/json', 'X-Work-CSRF': session.csrf };
    async function request<T>(path: string, body: unknown, expected = 200): Promise<T> {
      const response = await fetch(`${app!.server.origin}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value as T;
    }
    return { ...fixture, app, request };
  } catch (error) { await app.close(); throw error; }
}

for (const backend of ['sqlite', 'file-journal'] as const) for (const mode of ['write', 'computer'] as const) {
  test(`${backend}: registered ${mode} CLI executes once and retains proof across same-session replay`, { timeout: 60000 }, async t => {
    const f = fixture(t, backend, mode);
    const first = await cli(f.directory, f.options, ['ask', '--message-id', 'save', '--text', ENTRY_TEXT]);
    assert.equal(first.snapshot.status, 'completed'); assert.equal(first.snapshot.resultReady, true);
    assert.equal(first.snapshot.usage.toolCalls, mode === 'write' ? 1 : 2);
    assert.equal(first.snapshot.usage.modelCalls, mode === 'write' ? 2 : 3);
    assert.deepEqual(first.messages.map(message => message.kind), ['ack', 'result']);
    assert.match(first.messages[1]!.text, /reviewed/); assert.deepEqual(externalCounts(f.options), expectedCounts(mode));
    const replay = await cli(f.directory, f.options, ['ask', '--message-id', 'save', '--text', ENTRY_TEXT]);
    assert.equal(replay.accepted, false); assert.equal(replay.workId, first.workId); assert.equal(replay.sessionId, first.sessionId);
    assert.deepEqual(replay.snapshot.usage, first.snapshot.usage); assert.deepEqual(externalCounts(f.options), expectedCounts(mode));
    const resume = await cli(f.directory, f.options, ['resume', '--work', first.workId, '--session', first.sessionId]);
    assert.equal(resume.snapshot.status, 'completed'); assert.deepEqual(resume.snapshot.usage, first.snapshot.usage);
    assert.deepEqual(externalCounts(f.options), expectedCounts(mode));
    const host = writeComputerEntryFixture(f.options), profile = await openAgentTurnProfile(f.directory, { provider: 'registered' }, host.host);
    try {
      const state = await profile.runtime.state(first.workId);
      assert.deepEqual(state.attempts.map(attempt => attempt.toolId), mode === 'write' ? [WRITE_TOOL] : [COMPUTER_ID + '.observe', COMPUTER_ID + '.act']);
      assert.ok(state.attempts.every(attempt => attempt.status === 'succeeded' && attempt.adopted && attempt.resultArtifact));
      assert.equal(state.budget.reservedToolCalls, 0); assert.ok(state.generatedAnswer?.evidenceIds.length);
      const write = state.attempts.find(attempt => attempt.effect === 'write')!;
      assert.equal(write.effectState, 'confirmed');
      assert.ok(mode === 'write' ? write.effectReceipt : write.computerUse?.head);
      assert.equal(state.evidence[0]!.facts['savedNote'], 'reviewed');
      assert.equal(await profile.services.effects!.current(state), true);
      const history = await profile.sessions.history(profile.actor, first.sessionId, profile.policy, { limit: 100 });
      assert.equal(history.entries.filter(entry => entry.role === 'user' && entry.text === ENTRY_TEXT).length, 1);
      assert.equal(history.entries.filter(entry => entry.kind === 'result').length, 1);
      if (mode === 'write') {
        assert.ok(host.observed.effectChecks > 0);
        writeFileSync(join(f.base, `write-${write.id}.json`), 'changed external proof', { mode: 0o600 });
        assert.equal(await profile.services.effects!.current(state), false);
        assert.equal(host.observed.writes, 0);
      }
    } finally { await profile.close(); }
    assert.equal(host.observed.toolCloses, 1); assert.equal(host.observed.modelCloses, 1);
  });

  test(`${backend}: registered ${mode} HTTP runs through the shared host and reconnects without repeating input`, { timeout: 60000 }, async t => {
    const f = fixture(t, backend, mode); let web = await connect(f.directory, f.options);
    try {
      const accepted = await web.request<WebAcceptResult>('/api/requests', { requestId: 'save', rawText: ENTRY_TEXT, mode: 'auto' });
      assert.equal(web.observed.inputs.length, 0); assert.equal(web.observed.writes, 0);
      if (mode === 'computer') assert.equal(web.driver()!.snapshot().inputCount, 0);
      const done = await web.request<WebCommandResult>(`/api/works/${accepted.workId}/commands`, { requestId: 'run-save', kind: 'run', expectedGoalRevision: 1 });
      assert.equal(done.view.kind, 'snapshot'); if (done.view.kind !== 'snapshot') assert.fail('snapshot required');
      assert.equal(done.view.view.progress.status, 'completed'); assert.deepEqual(externalCounts(f.options), expectedCounts(mode));
      const before = await web.app.profile.general!.runtime.state(accepted.workId);
      const first = web; await first.app.close(); assert.equal(first.observed.toolCloses, 1); assert.equal(first.observed.modelCloses, 1);
      web = await connect(f.directory, f.options, accepted.sessionId!);
      const replay = await web.request<WebCommandResult>(`/api/works/${accepted.workId}/commands`, { requestId: 'run-save', kind: 'run', expectedGoalRevision: 1 });
      assert.equal(replay.view.kind, 'snapshot'); if (replay.view.kind !== 'snapshot') assert.fail('snapshot required');
      assert.equal(replay.view.view.progress.status, 'completed'); assert.deepEqual(externalCounts(f.options), expectedCounts(mode));
      const terminal = await web.request<{ code: string }>(`/api/works/${accepted.workId}/commands`,
        { requestId: 'new-run-save', kind: 'run', expectedGoalRevision: 1 }, 409);
      assert.equal(terminal.code, 'work_terminal');
      assert.equal(web.observed.inputs.length, 0); assert.equal(web.observed.writes, 0);
      const after = await web.app.profile.general!.runtime.state(accepted.workId);
      assert.deepEqual(after.attempts, before.attempts); assert.deepEqual(after.budget, before.budget); assert.deepEqual(after.evidence, before.evidence);
    } finally { await web.app.close(); }
    assert.equal(web.observed.toolCloses, 1); assert.equal(web.observed.modelCloses, 1);
  });
}

for (const mode of ['write', 'computer'] as const) test(`registered ${mode} with read-only authority never performs a physical input`, { timeout: 60000 }, async t => {
  const f = fixture(t, 'sqlite', mode); f.options.allowWrites = false;
  const result = await cli(f.directory, f.options, ['ask', '--message-id', 'denied', '--text', ENTRY_TEXT, '--steps', '12']);
  assert.notEqual(result.snapshot.status, 'completed'); assert.equal(result.snapshot.resultReady, false);
  if (mode === 'write') { assert.equal(result.snapshot.usage.toolCalls, 0); assert.deepEqual(externalCounts(f.options), { writes: 0 }); }
  else {
    assert.deepEqual(externalCounts(f.options), { inputs: 0, saves: 0, savedNote: '' });
    assert.equal(result.snapshot.usage.toolCalls, 1, 'observation remains available without input permission');
  }
});
