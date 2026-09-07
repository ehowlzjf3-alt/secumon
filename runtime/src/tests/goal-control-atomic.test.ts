import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Goal, WorkState } from '../domain/model.js';
import type { CommitRequest } from '../application/ports.js';
import { executionControl } from '../domain/execution-policy.js';
import { transact } from '../application/work-transactions.js';
import { openLocalProfile } from '../presentation/local-profile.js';
import { LocalWorkbench } from '../presentation/local-workbench.js';
import { startWebServer } from '../presentation/web-server.js';
import { WebCommandSchema } from '../presentation/web-contracts.js';
import { adapters, type Adapter } from './state-conformance-helpers.js';

const actor = { tenantId: 'synthetic', principalId: 'learner' };
const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../presentation/cli.js', import.meta.url));
async function fixture(t: TestContext, backend: Adapter) {
  const directory = await mkdtemp(join(tmpdir(), 'goal-control-atomic-')); let profile = await openLocalProfile(directory, backend);
  t.after(async () => { await profile.close(); await rm(directory, { recursive: true, force: true }); });
  const scenario = profile.scenarios.find(value => value.id === 'documents-simple')!;
  const accepted = await profile.workflow.accept(actor, { messageId: 'goal-control',
    binding: { ...actor, channel: 'cli', conversationId: 'terminal', recipientId: actor.principalId, destination: 'local' },
    goal: scenario.goal, policy: scenario.policy, limits: { toolCalls: 20, modelCalls: 0, tokens: 1000, replans: 5, wallTimeMs: 60000 }, completionRequiresDelivery: true });
  const workId = accepted.workId;
  return { directory, workId, get profile() { return profile; },
    state: () => profile.runtime.state(workId),
    image: async () => ({ state: await profile.runtime.state(workId), events: await profile.services.state.events(workId, 0), deliveries: await profile.services.state.deliveries(workId) }),
    async reopen() { await profile.close(); profile = await openLocalProfile(directory, backend); },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function nextGoal(state: WorkState): Goal { return { ...structuredClone(state.goal), revision: state.goal.revision + 1,
  description: 'Explicitly revised synthetic goal', mode: executionControl(state).pending?.mode ?? executionControl(state).requestedMode }; }
async function mode(f: Fixture, value: 'auto' | 'fast' | 'deep', id = 'other-channel-mode') {
  const current = await f.state(); return f.profile.runtime.command(f.workId, id, actor, current.goal.revision,
    { kind: 'mode', mode: value, reason: 'Explicit mode change from another channel', expectedControlRevision: executionControl(current).revision });
}
async function invoke(directory: string, backend: Adapter, args: string[]) {
  return execute(process.execPath, [cli, ...args, '--data-dir', directory, '--state-backend', backend, '--json'], { timeout: 15000, maxBuffer: 1048576 });
}
async function rejectCli(directory: string, backend: Adapter, args: string[], code: string) {
  await assert.rejects(invoke(directory, backend, args), (error: unknown) => {
    const failure = error as { code: number; stdout: string; stderr: string };
    assert.equal(failure.code, 1); assert.equal(failure.stdout, ''); assert.equal(failure.stderr, `오류: ${code}\n`); return true;
  });
}

for (const backend of adapters) {
  test(`${backend}: goal change rejects a mode changed by another channel without modifying goal, control or receipts`, async t => {
    const f = await fixture(t, backend); const observed = await f.state(); const input = { kind: 'goal' as const, goal: nextGoal(observed), expectedControlRevision: executionControl(observed).revision };
    await mode(f, 'fast'); const before = await f.image();
    await assert.rejects(f.profile.runtime.command(f.workId, 'stale-goal-control', actor, observed.goal.revision, input), /stale_execution_control/);
    assert.deepEqual(await f.image(), before); assert.equal(await f.profile.services.state.receipt(f.workId, 'stale-goal-control'), null);
    assert.equal(executionControl((await f.image()).state).requestedMode, 'fast');
  });

  test(`${backend}: goal control is rechecked after a commit CAS conflict and cannot overwrite the winning mode`, async t => {
    const f = await fixture(t, backend); const observed = await f.state(); const commit = f.profile.services.state.commit.bind(f.profile.services.state);
    let injected = false; let conflicted = false; let winning: Awaited<ReturnType<Fixture['image']>> | undefined;
    f.profile.services.state.commit = async (request: CommitRequest) => {
      if (request.commandId === 'racing-goal' && !injected) { injected = true; await mode(f, 'deep'); winning = await f.image(); }
      const result = await commit(request); if (request.commandId === 'racing-goal') conflicted ||= result.kind === 'conflict'; return result;
    };
    await assert.rejects(f.profile.runtime.command(f.workId, 'racing-goal', actor, observed.goal.revision,
      { kind: 'goal', goal: nextGoal(observed), expectedControlRevision: executionControl(observed).revision }), /stale_execution_control/);
    assert.equal(injected, true); assert.equal(conflicted, true); assert.deepEqual(await f.image(), winning);
    assert.equal(await f.profile.services.state.receipt(f.workId, 'racing-goal'), null); assert.equal((await f.state()).goal.revision, 1);
  });

  test(`${backend}: unrelated commit contention retries the same goal request while incrementing control exactly once`, async t => {
    const f = await fixture(t, backend); const observed = await f.state(); const commit = f.profile.services.state.commit.bind(f.profile.services.state);
    let attempts = 0;
    f.profile.services.state.commit = async request => {
      if (request.commandId === 'retry-goal' && ++attempts === 1) await transact(f.profile.services, f.workId, 'metadata-race', 'fixture_changed', {}, state => { state.statusReason = 'Unrelated local update'; });
      return commit(request);
    };
    const changed = await f.profile.runtime.command(f.workId, 'retry-goal', actor, observed.goal.revision,
      { kind: 'goal', goal: nextGoal(observed), expectedControlRevision: executionControl(observed).revision });
    assert.equal(attempts, 2); assert.equal(changed.goal.revision, 2); assert.equal(executionControl(changed).revision, 2);
    const events = await f.profile.services.state.events(f.workId, 0); assert.equal(events.filter(event => event.type === 'user_command').length, 1);
    assert.equal(events.filter(event => event.type === 'fixture_changed').length, 1); assert.ok(await f.profile.services.state.receipt(f.workId, 'retry-goal'));
  });

  test(`${backend}: successful goal replay remains idempotent after a later mode change and restart`, async t => {
    const f = await fixture(t, backend); await mode(f, 'fast', 'first-mode'); const observed = await f.state();
    const input = { kind: 'goal' as const, goal: nextGoal(observed), expectedControlRevision: executionControl(observed).revision };
    const changed = await f.profile.runtime.command(f.workId, 'saved-goal', actor, observed.goal.revision, input);
    assert.equal(changed.goal.revision, observed.goal.revision + 1); assert.equal(executionControl(changed).revision, input.expectedControlRevision + 1);
    assert.equal(executionControl(changed).requestedMode, 'fast'); assert.deepEqual(changed.budget, observed.budget);
    await mode(f, 'deep', 'later-mode'); const after = await f.image(); await f.reopen();
    assert.deepEqual(await f.profile.runtime.command(f.workId, 'saved-goal', actor, observed.goal.revision, input), after.state); assert.deepEqual(await f.image(), after);
    await assert.rejects(f.profile.runtime.command(f.workId, 'saved-goal', actor, observed.goal.revision,
      { ...input, expectedControlRevision: input.expectedControlRevision + 1 }), /idempotency_conflict/);
    assert.deepEqual(await f.image(), after);
  });

  test(`${backend}: goal mutation requires a positive safe control revision and strict fields before any receipt or state change`, async t => {
    const f = await fixture(t, backend); const observed = await f.state(); const before = await f.image(); let index = 0;
    type Input = Parameters<typeof f.profile.runtime.command>[4];
    for (const revision of [undefined, null, '1', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      const input = { kind: 'goal', goal: nextGoal(observed), ...(revision === undefined ? {} : { expectedControlRevision: revision }) };
      const commandId = `invalid-goal-${++index}`;
      await assert.rejects(f.profile.runtime.command(f.workId, commandId, actor, 1, input as Input), /invalid_contract/);
      assert.equal(await f.profile.services.state.receipt(f.workId, commandId), null);
    }
    await assert.rejects(f.profile.runtime.command(f.workId, 'unexpected-authority', actor, 1,
      { kind: 'goal', goal: nextGoal(observed), expectedControlRevision: 1, policy: { allowWrites: true } } as Input), /invalid_contract/);
    assert.deepEqual(await f.image(), before);
    await assert.rejects(f.profile.runtime.command(f.workId, 'stale-goal-only', actor, 999,
      { kind: 'goal', goal: nextGoal(observed), expectedControlRevision: 1 }), /stale_user_command/); assert.deepEqual(await f.image(), before);
  });

  test(`${backend}: a legacy goal without stored execution control still requires its explicit initial revision`, async t => {
    const f = await fixture(t, backend); await transact(f.profile.services, f.workId, 'legacy-fixture', 'fixture_changed', {}, state => { delete state.executionControl; });
    const observed = await f.state(); assert.equal(observed.executionControl, undefined);
    await assert.rejects(f.profile.runtime.command(f.workId, 'legacy-stale', actor, 1, { kind: 'goal', goal: nextGoal(observed), expectedControlRevision: 2 }), /stale_execution_control/);
    const changed = await f.profile.runtime.command(f.workId, 'legacy-goal', actor, 1, { kind: 'goal', goal: { ...nextGoal(observed), mode: 'fast' }, expectedControlRevision: 1 });
    assert.equal(executionControl(changed).revision, 2); assert.equal(executionControl(changed).requestedMode, 'fast'); assert.equal(changed.goal.revision, 2);
  });

  test(`${backend}: CLI goal changes require both explicit revisions, reject stale control and replay the saved receipt`, async t => {
    const f = await fixture(t, backend); const observed = await f.state(); const path = join(f.directory, 'goal.json'); await writeFile(path, JSON.stringify(nextGoal(observed)));
    const args = ['change-goal', f.workId, '--file', path, '--goal-revision', '1', '--control-revision', '1', '--request-id', 'cli-goal']; const before = await f.image();
    for (const [option, code] of [['--goal-revision', 'goal_revision_required'], ['--control-revision', 'control_revision_required']] as const) {
      const missing = [...args]; missing.splice(missing.indexOf(option), 2); await rejectCli(f.directory, backend, missing, code);
    }
    for (const value of ['0', '-1', '1.5', 'NaN', '9007199254740992']) {
      const invalid = [...args];
      // Inline string values disambiguate leading '-' from a new option before revision validation.
      invalid.splice(invalid.indexOf('--control-revision'), 2, `--control-revision=${value}`);
      await rejectCli(f.directory, backend, invalid, 'invalid_control_revision');
    }
    assert.deepEqual(await f.image(), before); await mode(f, 'fast'); const afterMode = await f.image();
    await rejectCli(f.directory, backend, args, 'stale_execution_control'); assert.deepEqual(await f.image(), afterMode);
    const current = await f.state(); await writeFile(path, JSON.stringify(nextGoal(current))); args[args.indexOf('--control-revision') + 1] = String(executionControl(current).revision);
    const success = await invoke(f.directory, backend, args); assert.equal(success.stderr, ''); const after = await f.image();
    assert.equal(after.state.goal.revision, 2); assert.equal(executionControl(after.state).revision, executionControl(current).revision + 1); assert.equal(executionControl(after.state).requestedMode, 'fast');
    await invoke(f.directory, backend, args); assert.deepEqual(await f.image(), after);
  });

  test(`${backend}: Web strict goal input carries control revision through HTTP and rejects a newer channel mode`, async t => {
    const f = await fixture(t, backend); const workbench = new LocalWorkbench(f.profile); await workbench.attach({ requestId: 'web-attachment', workId: f.workId });
    const server = await startWebServer(workbench);
    try {
      const session = await fetch(`${server.origin}/api/session`, { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: new URL(server.connectUrl).hash.slice(9) }) });
      assert.equal(session.status, 200); const csrf = (await session.json() as { csrf: string }).csrf;
      const headers = { Cookie: session.headers.get('set-cookie')!.split(';')[0]!, Origin: server.origin, 'Content-Type': 'application/json', 'X-Work-CSRF': csrf };
      const observed = await f.state(); const input = { requestId: 'web-goal', kind: 'goal', expectedGoalRevision: 1, goal: nextGoal(observed), expectedControlRevision: 1 };
      const post = (value: unknown) => fetch(`${server.origin}/api/works/${f.workId}/commands`, { method: 'POST', headers, body: JSON.stringify(value) });
      const { expectedControlRevision: ignored, ...missing } = input; void ignored;
      const before = await f.image(); assert.equal((await post(missing)).status, 400); assert.equal((await post({ ...input, expectedControlRevision: '1' })).status, 400);
      assert.equal((await post({ ...input, privileged: true })).status, 400); assert.deepEqual(await f.image(), before);
      await mode(f, 'deep'); const newer = await f.image(); const stale = await post(input); assert.equal(stale.status, 409); assert.deepEqual(await stale.json(), { code: 'stale_execution_control' }); assert.deepEqual(await f.image(), newer);
      const current = await f.state(); const fresh = { ...input, goal: nextGoal(current), expectedControlRevision: executionControl(current).revision };
      const success = await post(fresh); assert.equal(success.status, 200, JSON.stringify(await success.clone().json())); const after = await f.image();
      assert.equal(after.state.goal.revision, 2); assert.equal(executionControl(after.state).requestedMode, 'deep'); assert.equal(executionControl(after.state).revision, fresh.expectedControlRevision + 1);
      const replay = await post(fresh); assert.equal(replay.status, 200); assert.equal((await replay.json() as { duplicate: boolean }).duplicate, true); assert.deepEqual(await f.image(), after);
    } finally { await server.close(); await workbench.drain(); }
  });
}

test('Web goal schema accepts only an explicit positive safe numeric control revision', () => {
  const goal: Goal = { revision: 2, description: 'Synthetic goal', scope: 'synthetic', mode: 'auto', criteria: [
    { id: 'criterion', description: 'Data is present', key: 'ready', operator: 'present', equals: null, minIndependentSources: 1, requireCompleteCoverage: true },
  ] };
  const input = { requestId: 'strict-goal', expectedGoalRevision: 1, kind: 'goal', goal, expectedControlRevision: 1 };
  assert.equal(WebCommandSchema.safeParse(input).success, true);
  for (const revision of [undefined, null, '1', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
    assert.equal(WebCommandSchema.safeParse({ ...input, expectedControlRevision: revision }).success, false);
  }
  assert.equal(WebCommandSchema.safeParse({ ...input, expectedStateRevision: 1 }).success, false);
});
