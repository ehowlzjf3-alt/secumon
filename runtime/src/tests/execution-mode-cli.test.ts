import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Mode, WorkState } from '../domain/model.js';
import { validateScenario } from '../application/fixtures.js';
import { FileJournalStateRepository } from '../infrastructure/file-journal-state.js';
import { SqliteStateRepository } from '../infrastructure/sqlite-state.js';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../presentation/cli.js', import.meta.url));
const backends = ['sqlite', 'file-journal'] as const;
type Backend = typeof backends[number];
type Snapshot = { revision: number; goalRevision: number; status: WorkState['status']; usage: WorkState['budget']['used'];
  execution: { revision: number; requestedMode: Mode; strategy: 'direct' | 'investigate'; pending: unknown; lastReason: string; deadlineAt: number } };
type Reply = { workId: string; accepted?: boolean; snapshot: Snapshot };
async function directory(t: TestContext) { const dir = await mkdtemp(join(tmpdir(), 'runtime-mode-cli-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
async function invoke(dir: string, backend: Backend, args: string[], json = true) {
  return execute(process.execPath, [cli, ...args, '--data-dir', dir, '--state-backend', backend, ...(json ? ['--json'] : [])], { timeout: 15000, maxBuffer: 1048576 });
}
async function call(dir: string, backend: Backend, args: string[]): Promise<Reply> {
  const response = await invoke(dir, backend, args); assert.equal(response.stderr, ''); assert.doesNotMatch(response.stdout, /\u001b/);
  return JSON.parse(response.stdout) as Reply;
}
async function rejected(dir: string, backend: Backend, args: string[], code: string) {
  await assert.rejects(invoke(dir, backend, args), (error: unknown) => {
    const failure = error as { code: number; stdout: string; stderr: string };
    assert.equal(failure.code, 1); assert.equal(failure.stdout, ''); assert.equal(failure.stderr, `오류: ${code}\n`); return true;
  });
}
async function stored(dir: string, backend: Backend, workId: string) {
  const repository = backend === 'sqlite' ? new SqliteStateRepository(join(dir, 'state.sqlite')) : new FileJournalStateRepository(join(dir, 'state-journal'));
  try { const state = await repository.get(workId); assert.ok(state); return { state, events: await repository.events(workId, 0), deliveries: await repository.deliveries(workId) }; }
  finally { await repository.close(); }
}
function modeArgs(reply: Reply, mode: Mode, requestId: string) {
  return ['mode', reply.workId, '--mode', mode, '--goal-revision', String(reply.snapshot.goalRevision), '--control-revision', String(reply.snapshot.execution.revision),
    '--reason', 'Explicit synthetic execution preference', '--request-id', requestId];
}

for (const backend of backends) {
  test(`execution mode CLI ${backend}: fast reception survives process exit and repeated status is read-only`, async t => {
    const dir = await directory(t); const accepted = await call(dir, backend, ['accept', '--scenario', 'documents-simple', '--request-id', 'fast-request', '--mode', 'fast']);
    assert.equal(accepted.accepted, true); assert.equal(accepted.snapshot.execution.requestedMode, 'fast'); assert.equal(accepted.snapshot.execution.strategy, 'direct');
    assert.equal(accepted.snapshot.execution.revision, 1); assert.equal(accepted.snapshot.execution.pending, null);
    const before = await stored(dir, backend, accepted.workId); assert.equal(before.state.goal.mode, 'fast'); assert.deepEqual(before.state.evidence, []);
    const reopened = await call(dir, backend, ['status', accepted.workId]); assert.equal(reopened.snapshot.execution.requestedMode, 'fast');
    assert.equal(reopened.snapshot.revision, accepted.snapshot.revision); assert.equal(reopened.snapshot.usage.toolCalls, 0); assert.equal(reopened.snapshot.usage.modelCalls, 0);
    const human = await invoke(dir, backend, ['status', accepted.workId], false); assert.equal(human.stderr, ''); assert.match(human.stdout, /모드 fast · 전략 direct/);
    assert.doesNotMatch(human.stdout, /\u001b|attempt_reserved|user_command/); assert.deepEqual(await stored(dir, backend, accepted.workId), before);
    const duplicate = await call(dir, backend, ['accept', '--scenario', 'documents-simple', '--request-id', 'fast-request', '--mode', 'fast']);
    assert.equal(duplicate.workId, accepted.workId); assert.equal(duplicate.accepted, false); assert.deepEqual(await stored(dir, backend, accepted.workId), before);
    const automatic = await call(dir, backend, ['accept', '--scenario', 'observations-simple', '--request-id', 'default-request']);
    assert.equal(automatic.snapshot.execution.requestedMode, 'auto'); assert.equal((await stored(dir, backend, automatic.workId)).state.goal.mode, 'auto');
  });

  test(`execution mode CLI ${backend}: mode command is durable and idempotent while stale revisions do not change state`, async t => {
    const dir = await directory(t); const accepted = await call(dir, backend, ['accept', '--request-id', 'mode-request']);
    const before = await stored(dir, backend, accepted.workId); const args = modeArgs(accepted, 'deep', 'change-once');
    const changed = await call(dir, backend, args); assert.equal(changed.snapshot.execution.requestedMode, 'deep'); assert.equal(changed.snapshot.execution.strategy, 'investigate');
    assert.equal(changed.snapshot.execution.revision, accepted.snapshot.execution.revision + 1); assert.equal(changed.snapshot.goalRevision, accepted.snapshot.goalRevision);
    const persisted = await stored(dir, backend, accepted.workId); assert.deepEqual(persisted.state.goal, before.state.goal); assert.deepEqual(persisted.state.budget, before.state.budget);
    assert.deepEqual(persisted.deliveries, before.deliveries); assert.equal(persisted.state.deadlineAt, before.state.deadlineAt);
    const replay = await call(dir, backend, args); assert.equal(replay.snapshot.revision, changed.snapshot.revision); assert.deepEqual(await stored(dir, backend, accepted.workId), persisted);
    const conflict = [...args]; conflict[conflict.indexOf('--mode') + 1] = 'fast'; await rejected(dir, backend, conflict, 'idempotency_conflict');
    const staleControl = modeArgs(accepted, 'fast', 'stale-control'); await rejected(dir, backend, staleControl, 'stale_execution_control');
    const staleGoal = modeArgs(changed, 'fast', 'stale-goal'); staleGoal[staleGoal.indexOf('--goal-revision') + 1] = '999';
    await rejected(dir, backend, staleGoal, 'stale_user_command'); assert.deepEqual(await stored(dir, backend, accepted.workId), persisted);
    const reopened = await call(dir, backend, ['status', accepted.workId]); assert.equal(reopened.snapshot.execution.requestedMode, 'deep');
    assert.equal(reopened.snapshot.execution.revision, changed.snapshot.execution.revision); assert.equal(reopened.snapshot.execution.pending, null);
  });

  test(`execution mode CLI ${backend}: a pending mode change is visible after exit and preserves the reserved attempt`, async t => {
    const dir = await directory(t); const accepted = await call(dir, backend, ['accept', '--request-id', 'pending-request']);
    await call(dir, backend, ['demo-plan', accepted.workId]); const reserved = await call(dir, backend, ['run', accepted.workId, '--steps', '1']);
    const before = await stored(dir, backend, accepted.workId); assert.equal(before.state.attempts.length, 1); assert.equal(before.state.attempts[0]!.status, 'reserved');
    const changed = await call(dir, backend, modeArgs(reserved, 'deep', 'pending-mode'));
    assert.equal(changed.snapshot.execution.requestedMode, 'auto'); assert.equal(changed.snapshot.execution.strategy, 'direct');
    assert.deepEqual(changed.snapshot.execution.pending, { mode: 'deep', reason: 'Explicit synthetic execution preference' });
    const after = await stored(dir, backend, accepted.workId);
    for (const key of ['goal', 'plan', 'attempts', 'budget', 'deadlineAt'] as const) assert.deepEqual(after.state[key], before.state[key]);
    assert.deepEqual(after.deliveries, before.deliveries);
    const status = await call(dir, backend, ['status', accepted.workId]); assert.deepEqual(status.snapshot.execution.pending, changed.snapshot.execution.pending);
    const human = await invoke(dir, backend, ['status', accepted.workId], false); assert.match(human.stdout, /모드 auto · 전략 direct · 모드 변경 대기 deep/);
    assert.deepEqual(await stored(dir, backend, accepted.workId), after);
  });

  test(`execution mode CLI ${backend}: enum, both revisions and an explicit nonblank reason are required`, async t => {
    const dir = await directory(t); const accepted = await call(dir, backend, ['accept', '--request-id', 'validation-request']);
    const before = await stored(dir, backend, accepted.workId); const args = modeArgs(accepted, 'deep', 'invalid-mode-change');
    for (const [option, error] of [['--mode', 'mode_required'], ['--goal-revision', 'goal_revision_required'], ['--control-revision', 'control_revision_required'], ['--reason', 'mode_reason_required']] as const) {
      const missing = [...args]; missing.splice(missing.indexOf(option), 2); await rejected(dir, backend, missing, error);
    }
    for (const [option, value, error] of [['--mode', 'turbo', 'invalid_execution_mode'], ['--control-revision', '0', 'invalid_control_revision'],
      ['--control-revision', '1.5', 'invalid_control_revision'], ['--goal-revision', 'NaN', 'invalid_goal_revision'], ['--reason', '   ', 'mode_reason_required']] as const) {
      const invalid = [...args]; invalid[invalid.indexOf(option) + 1] = value; await rejected(dir, backend, invalid, error);
    }
    await rejected(dir, backend, ['accept', '--request-id', 'bad-reception', '--mode', 'FAST'], 'invalid_execution_mode');
    assert.deepEqual(await stored(dir, backend, accepted.workId), before);
  });

  test(`execution mode CLI ${backend}: irrelevant mode options are rejected before opening a profile`, async t => {
    const parent = await directory(t); const unopened = join(parent, 'unopened-profile');
    for (const command of ['run', 'status', 'messages', 'demo-plan', 'checkpoint']) {
      await rejected(unopened, backend, [command, 'work-not-opened', '--mode', 'fast'], 'mode_option_not_supported');
    }
    for (const command of ['accept', 'status']) await rejected(unopened, backend, [command, '--control-revision', '1'], 'control_revision_option_not_supported');
    await assert.rejects(access(unopened), { code: 'ENOENT' });
  });

  for (const family of ['documents-simple', 'observations-simple']) {
    test(`execution mode CLI ${backend} ${family}: changing mode preserves the goal, original source and completed work`, async t => {
      const dir = await directory(t); const accepted = await call(dir, backend, ['accept', '--scenario', family, '--request-id', 'source-request']);
      await call(dir, backend, ['demo-plan', accepted.workId]); await call(dir, backend, ['run', accepted.workId, '--steps', '3']);
      const current = await call(dir, backend, ['status', accepted.workId]); const before = await stored(dir, backend, accepted.workId);
      assert.ok(before.state.attempts.some(attempt => attempt.adopted && attempt.status === 'succeeded')); assert.ok(before.state.evidence.length > 0);
      const scenario = validateScenario(JSON.parse(readFileSync(new URL(`../../fixtures/${family}.json`, import.meta.url), 'utf8')));
      assert.deepEqual(before.state.goal, scenario.goal); assert.equal(before.state.budget.used.toolCalls, 1); assert.equal(before.state.budget.used.modelCalls, 0);
      const changed = await call(dir, backend, modeArgs(current, 'deep', 'preserve-source'));
      assert.equal(changed.snapshot.execution.requestedMode, 'deep'); assert.equal(changed.snapshot.goalRevision, current.snapshot.goalRevision);
      const after = await stored(dir, backend, accepted.workId);
      for (const key of ['goal', 'evidence', 'plan', 'attempts', 'budget', 'deadlineAt', 'obligations', 'artifacts'] as const)
        assert.deepEqual(after.state[key], before.state[key], `mode change must preserve ${key}`);
      assert.deepEqual(after.deliveries, before.deliveries); assert.equal(after.state.goal.mode, 'auto');
      const status = await call(dir, backend, ['status', accepted.workId]); assert.equal(status.snapshot.execution.requestedMode, 'deep');
      assert.deepEqual(await stored(dir, backend, accepted.workId), after);
    });
  }
}
