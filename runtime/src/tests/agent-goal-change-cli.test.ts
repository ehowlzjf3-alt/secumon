import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { SYNTHETIC_AGENT_TURN_CORRECTION, SYNTHETIC_AGENT_TURN_REQUESTS as texts } from '../infrastructure/synthetic-agent-turn.js';
import type { SessionPage, SessionRecord } from '../domain/session.js';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('./helpers/agent-cli-isolated-worker.js', import.meta.url));
function hostOptions(directory: string) { return { models: new Map(), identityRegistryDirectory: join(dirname(directory), 'registry') }; }
function cliEnvironment(directory: string) { return { ...process.env, SECUMON_TEST_IDENTITY_REGISTRY: hostOptions(directory).identityRegistryDirectory }; }
const runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
interface ChatResult {
  sessionId: string; workId: string; created?: boolean;
  snapshot: { status: string; reason: string; goalRevision: number; resultReady: boolean; resultDelivery: string;
    execution: { revision: number; requestedMode: string }; pendingQuestions: { id: string }[];
    usage: { toolCalls: number; modelCalls: number; replans: number; tokens: number } };
  messages: { id: string; kind: string; text: string }[];
  run?: { control: { kind: string }; reason: string };
}
function fixture(backend: 'sqlite' | 'file-journal' = 'sqlite') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-goal-change-cli-'))), directory = join(base, 'agent');
  const profile = new FileAgentProfileStore(runtimeRoot).initialize(directory);
  if (backend === 'file-journal') writeFileSync(join(directory, 'config.json'), JSON.stringify({ ...profile.config,
    storage: { ...profile.config.storage, state: backend } }), { mode: 0o600 });
  return { base, directory, close: () => rmSync(base, { recursive: true, force: true }) };
}
function invoke(directory: string, args: string[], json = true) {
  return execute(process.execPath, [cli, 'chat', ...args, '--directory', directory, '--provider', 'synthetic', ...(json ? ['--json'] : [])],
    { timeout: 30000, maxBuffer: 2 * 1024 * 1024, env: cliEnvironment(directory) });
}
async function call<T = ChatResult>(directory: string, args: string[]): Promise<T> {
  const result = await invoke(directory, args); assert.doesNotMatch(result.stdout, /\u001b/); return JSON.parse(result.stdout) as T;
}
function goalArgs(current: ChatResult, messageId: string, text: string) {
  return ['goal', '--work', current.workId, '--session', current.sessionId, '--message-id', messageId, '--text', text,
    '--goal-revision', String(current.snapshot.goalRevision), '--control-revision', String(current.snapshot.execution.revision)];
}

for (const backend of ['sqlite', 'file-journal'] as const) test(`${backend}: chat goal retains work and auto mode, answers at the next revision and never executes an old replay`, async () => {
  const f = fixture(backend);
  try {
    const first = await call(f.directory, ['ask', '--message-id', 'read', '--text', texts.read]);
    assert.equal(first.snapshot.status, 'completed'); assert.equal(first.snapshot.usage.toolCalls, 1);
    assert.equal(first.snapshot.execution.requestedMode, 'auto');
    const beforeProfile = await openAgentTurnProfile(f.directory, { provider: 'synthetic' }, hostOptions(f.directory));
    const before = await beforeProfile.runtime.state(first.workId); await beforeProfile.close();
    const args = goalArgs(first, 'rewrite-goal', texts.rewrite);
    const changed = await call(f.directory, args);
    assert.equal(changed.created, true); assert.ok(changed.run);
    assert.equal(changed.workId, first.workId); assert.equal(changed.sessionId, first.sessionId);
    assert.equal(changed.snapshot.goalRevision, 2); assert.equal(changed.snapshot.execution.requestedMode, 'auto');
    assert.equal(changed.snapshot.status, 'completed'); assert.equal(changed.snapshot.resultDelivery, 'delivered');
    assert.equal(changed.snapshot.usage.toolCalls, first.snapshot.usage.toolCalls);
    assert.equal(changed.snapshot.usage.modelCalls, first.snapshot.usage.modelCalls + 1);
    assert.equal(changed.snapshot.usage.replans, first.snapshot.usage.replans);
    assert.deepEqual(changed.messages.map(message => message.kind), ['result']);
    assert.ok(changed.messages[0]!.text.includes(SYNTHETIC_AGENT_TURN_CORRECTION));
    const replay = await call(f.directory, args);
    assert.equal(replay.created, false); assert.equal(replay.run, undefined); assert.deepEqual(replay.snapshot, changed.snapshot);
    const later = await call(f.directory, [...goalArgs(changed, 'question-goal', texts.question), '--mode', 'auto']);
    assert.equal(later.snapshot.goalRevision, 3); assert.equal(later.snapshot.execution.requestedMode, 'auto');
    assert.equal(later.snapshot.status, 'waiting'); assert.equal(later.snapshot.pendingQuestions.length, 1);
    const oldReplay = await call(f.directory, args);
    assert.equal(oldReplay.created, false); assert.equal(oldReplay.run, undefined); assert.deepEqual(oldReplay.snapshot, later.snapshot);
    const profile = await openAgentTurnProfile(f.directory, { provider: 'synthetic' }, hostOptions(f.directory));
    try {
      const state = await profile.runtime.state(first.workId);
      assert.deepEqual(state.attempts, before.attempts); assert.deepEqual(state.evidence, before.evidence);
      assert.equal(state.deadlineAt, before.deadlineAt); assert.deepEqual(state.budget.limits, before.budget.limits);
      assert.equal(state.goal.scope, before.goal.scope); assert.deepEqual(state.policy, before.policy);
      assert.equal(state.goal.responseRequirement!.requestMessageId, 'question-goal');
      const scope = state.conversation!.session!.scope;
      const receipt = await profile.sessions.repository.input(scope, 'rewrite-goal');
      assert.equal(receipt!.status, 'applied'); assert.equal(receipt!.text, texts.rewrite);
      const payload = receipt!.payload as { command: { goal: { mode: string; revision: number }; expectedSessionInput: { messageId: string } } };
      assert.equal(payload.command.goal.mode, 'auto'); assert.equal(payload.command.goal.revision, 2);
      assert.equal(payload.command.expectedSessionInput.messageId, 'read');
      const deliveries = await profile.services.state.deliveries(first.workId);
      assert.deepEqual(deliveries.filter(item => item.kind === 'result' && item.status === 'delivered').map(item => item.goalRevision).sort(), [1, 2]);
    } finally { await profile.close(); }
    const history = await call<SessionPage>(f.directory, ['history', '--session', first.sessionId]);
    assert.deepEqual(history.entries.filter(entry => entry.role === 'user').map(entry => entry.text), [texts.read, texts.rewrite, texts.question]);
  } finally { f.close(); }
});

test('chat goal with omitted mode retains fast and completes within the same work call limit', async () => {
  const f = fixture();
  try {
    const first = await call(f.directory, ['ask', '--message-id', 'rewrite-fast', '--text', texts.rewrite, '--mode', 'fast']);
    assert.equal(first.snapshot.status, 'completed'); assert.equal(first.snapshot.usage.modelCalls, 1);
    assert.equal(first.snapshot.execution.requestedMode, 'fast');
    const beforeProfile = await openAgentTurnProfile(f.directory, { provider: 'synthetic' }, hostOptions(f.directory));
    const before = await beforeProfile.runtime.state(first.workId); await beforeProfile.close();
    const changed = await call(f.directory, goalArgs(first, 'clarification-fast', texts.clarification));
    assert.equal(changed.created, true); assert.equal(changed.workId, first.workId); assert.equal(changed.sessionId, first.sessionId);
    assert.equal(changed.snapshot.goalRevision, 2); assert.equal(changed.snapshot.execution.requestedMode, 'fast');
    assert.equal(changed.snapshot.status, 'completed'); assert.equal(changed.snapshot.resultDelivery, 'delivered');
    assert.equal(changed.snapshot.usage.modelCalls, 2); assert.equal(changed.snapshot.usage.toolCalls, 0);
    assert.deepEqual(changed.messages.map(message => message.kind), ['result']);
    assert.match(changed.messages[0]!.text, /원문은.*요약은/);
    const profile = await openAgentTurnProfile(f.directory, { provider: 'synthetic' }, hostOptions(f.directory));
    try {
      const state = await profile.runtime.state(first.workId);
      assert.deepEqual(state.budget.limits, before.budget.limits); assert.equal(state.deadlineAt, before.deadlineAt);
      const receipt = await profile.sessions.repository.input(state.conversation!.session!.scope, 'clarification-fast');
      assert.equal(receipt!.status, 'applied'); assert.equal(receipt!.text, texts.clarification);
      assert.equal((receipt!.payload as { command: { goal: { mode: string } } }).command.goal.mode, 'fast');
    } finally { await profile.close(); }
  } finally { f.close(); }
});

test('chat goal preserves exhausted fast usage; explicit auto spends only the remaining original work budget', async () => {
  const f = fixture();
  try {
    const first = await call(f.directory, ['ask', '--message-id', 'read-fast', '--text', texts.read, '--mode', 'fast']);
    assert.equal(first.snapshot.status, 'completed'); assert.equal(first.snapshot.usage.modelCalls, 2);
    const beforeProfile = await openAgentTurnProfile(f.directory, { provider: 'synthetic' }, hostOptions(f.directory));
    const before = await beforeProfile.runtime.state(first.workId); await beforeProfile.close();
    const args = goalArgs(first, 'rewrite-blocked', texts.rewrite);
    const blocked = await call(f.directory, args);
    assert.equal(blocked.created, true); assert.equal(blocked.snapshot.goalRevision, 2);
    assert.equal(blocked.snapshot.execution.requestedMode, 'fast'); assert.equal(blocked.snapshot.status, 'blocked');
    assert.equal(blocked.snapshot.reason, 'fast_model_budget_exhausted');
    assert.equal(blocked.run!.control.kind, 'blocked'); assert.equal(blocked.run!.reason, 'fast_model_budget_exhausted');
    assert.deepEqual(blocked.snapshot.usage, first.snapshot.usage); assert.equal(blocked.snapshot.resultReady, false);
    assert.equal(blocked.messages.some(message => message.kind === 'result'), false);
    const replay = await call(f.directory, args);
    assert.equal(replay.created, false); assert.equal(replay.run, undefined); assert.deepEqual(replay.snapshot, blocked.snapshot);
    const changed = await call(f.directory, [...goalArgs(blocked, 'rewrite-auto', texts.rewrite), '--mode', 'auto']);
    assert.equal(changed.created, true); assert.equal(changed.snapshot.goalRevision, 3);
    assert.equal(changed.snapshot.execution.requestedMode, 'auto'); assert.equal(changed.snapshot.status, 'completed');
    assert.equal(changed.snapshot.resultDelivery, 'delivered');
    assert.equal(changed.snapshot.usage.modelCalls, first.snapshot.usage.modelCalls + 1);
    assert.equal(changed.snapshot.usage.toolCalls, first.snapshot.usage.toolCalls);
    assert.equal(changed.snapshot.usage.replans, first.snapshot.usage.replans);
    assert.ok(changed.messages.some(message => message.kind === 'result' && message.text.includes(SYNTHETIC_AGENT_TURN_CORRECTION)));
    const profile = await openAgentTurnProfile(f.directory, { provider: 'synthetic' }, hostOptions(f.directory));
    try {
      const state = await profile.runtime.state(first.workId);
      assert.deepEqual(state.budget.limits, before.budget.limits); assert.equal(state.deadlineAt, before.deadlineAt);
      assert.deepEqual(state.policy, before.policy); assert.deepEqual(state.attempts, before.attempts); assert.deepEqual(state.evidence, before.evidence);
      assert.equal(state.budget.used.modelCalls, before.budget.used.modelCalls + 1);
      assert.equal(state.budget.limits.modelCalls - state.budget.used.modelCalls,
        before.budget.limits.modelCalls - before.budget.used.modelCalls - 1);
      const scope = state.conversation!.session!.scope;
      assert.equal((await profile.sessions.repository.input(scope, 'rewrite-blocked'))!.status, 'applied');
      assert.equal((await profile.sessions.repository.input(scope, 'rewrite-auto'))!.status, 'applied');
      const deliveries = await profile.services.state.deliveries(first.workId);
      assert.deepEqual(deliveries.filter(item => item.kind === 'result' && item.status === 'delivered').map(item => item.goalRevision).sort(), [1, 3]);
    } finally { await profile.close(); }
    const history = await call<SessionPage>(f.directory, ['history', '--session', first.sessionId]);
    assert.deepEqual(history.entries.filter(entry => entry.role === 'user').map(entry => entry.text), [texts.read, texts.rewrite, texts.rewrite]);
  } finally { f.close(); }
});

test('chat goal supersedes the old question and prints intake before the new answer; status exposes both revisions', async () => {
  const f = fixture();
  try {
    const first = await call(f.directory, ['ask', '--message-id', 'question', '--text', texts.question]);
    assert.equal(first.snapshot.pendingQuestions.length, 1);
    const status = await invoke(f.directory, ['status', '--work', first.workId, '--session', first.sessionId], false);
    assert.match(status.stdout, new RegExp(`목표 버전 ${first.snapshot.goalRevision} · 제어 버전 ${first.snapshot.execution.revision}`));
    const changed = await invoke(f.directory, goalArgs(first, 'answered-goal', texts.rewrite), false);
    assert.match(changed.stdout, /목표 변경을 접수했습니다/); assert.match(changed.stdout, /완료/);
    assert.ok(changed.stdout.indexOf('목표 변경을 접수했습니다') < changed.stdout.indexOf(SYNTHETIC_AGENT_TURN_CORRECTION));
    assert.equal(changed.stdout.split('목표 변경을 접수했습니다').length - 1, 1);
    assert.doesNotMatch(changed.stdout, /model_call_reserved|context_head|task_ready|"artifacts"|\u001b/);
    const current = await call(f.directory, ['status', '--work', first.workId, '--session', first.sessionId]);
    assert.equal(current.snapshot.status, 'completed'); assert.equal(current.snapshot.goalRevision, 2);
    assert.deepEqual(current.snapshot.pendingQuestions, []); assert.deepEqual(current.messages.map(item => item.kind), ['result']);
    const replay = await invoke(f.directory, goalArgs(first, 'answered-goal', texts.rewrite), false);
    assert.match(replay.stdout, /이미 접수한 목표 변경/); assert.match(replay.stdout, /chat resume/);
    const history = await call<SessionPage>(f.directory, ['history', '--session', first.sessionId]);
    assert.equal(history.entries.filter(entry => entry.kind === 'question').length, 1);
    assert.equal(history.entries.filter(entry => entry.role === 'user').length, 2);
  } finally { f.close(); }
});

test('chat goal refuses invalid or missing revision and unsupported options before profile creation', async () => {
  const f = fixture(), unused = join(f.base, 'unused');
  try {
    const prefix = ['goal', '--work', 'work', '--message-id', 'change', '--text', texts.rewrite];
    const cases: [string[], RegExp][] = [
      [prefix, /goal_revision_required/],
      [[...prefix, '--goal-revision', '1'], /control_revision_required/],
      [[...prefix, '--goal-revision', '1', '--control-revision', '0'], /invalid_control_revision/],
      [[...prefix, '--goal-revision', '1', '--control-revision', '1.5'], /invalid_control_revision/],
      [[...prefix, '--goal-revision', String(Number.MAX_SAFE_INTEGER), '--control-revision', '1'], /invalid_goal_revision/],
      [[...prefix, '--goal-revision', '1', '--control-revision', String(Number.MAX_SAFE_INTEGER)], /invalid_control_revision/],
      [[...prefix, '--goal-revision', '1', '--control-revision', '1', '--obligation', 'old-question'], /chat_option_not_supported/],
      [['status', '--work', 'work', '--control-revision', '1'], /chat_option_not_supported/],
    ];
    for (const [args, error] of cases) { await assert.rejects(invoke(unused, args), error); assert.equal(existsSync(unused), false); }
  } finally { f.close(); }
});

test('chat goal preserves selected session and channel authority and rejects stale or conflicting commands', async () => {
  const f = fixture(), other = fixture();
  try {
    const first = await call(f.directory, ['ask', '--message-id', 'initial', '--text', texts.rewrite]);
    const args = goalArgs(first, 'new-goal', texts.question);
    const fresh = await call<{ session: SessionRecord }>(f.directory, ['session', '--new-session']);
    const wrongSession = [...args]; wrongSession[wrongSession.indexOf('--session') + 1] = fresh.session.scope.sessionId;
    await assert.rejects(invoke(f.directory, wrongSession), /session_work_unavailable/);
    await assert.rejects(invoke(other.directory, args), /session_unavailable/);
    await assert.rejects(invoke(f.directory, [...args, '--conversation', 'other-terminal']), /session_work_unavailable|session_unavailable/);
    const stale = [...goalArgs(first, 'stale', texts.question)]; stale[stale.indexOf('--control-revision') + 1] = String(first.snapshot.execution.revision + 1);
    await assert.rejects(invoke(f.directory, stale), /stale_execution_control/);
    const current = await call(f.directory, ['status', '--work', first.workId, '--session', first.sessionId]);
    assert.deepEqual(current.snapshot, first.snapshot);
    const changed = await call(f.directory, args); assert.equal(changed.created, true);
    const conflict = [...args]; conflict[conflict.indexOf('--text') + 1] = texts.read;
    await assert.rejects(invoke(f.directory, conflict), /session_input_identity_conflict/);
    const profile = await openAgentTurnProfile(f.directory, { provider: 'synthetic' }, hostOptions(f.directory));
    try {
      const state = await profile.runtime.state(first.workId);
      const receipt = await profile.sessions.repository.input(state.conversation!.session!.scope, 'stale');
      assert.equal(receipt!.status, 'rejected'); assert.equal(receipt!.rejection, 'stale_execution_control');
      assert.equal(state.goal.description, texts.question); assert.equal(state.goal.revision, 2);
    } finally { await profile.close(); }
  } finally { f.close(); other.close(); }
});

test('chat goal replays an intake interrupted after receipt without model execution; explicit resume continues the new goal', async () => {
  const f = fixture();
  try {
    const first = await call(f.directory, ['ask', '--message-id', 'first', '--text', texts.rewrite]);
    const profile = await openAgentTurnProfile(f.directory, { provider: 'synthetic' }, hostOptions(f.directory));
    const before = await profile.runtime.state(first.workId);
    try {
      const receive = profile.sessions.repository.receive.bind(profile.sessions.repository), interruption = new Error('after_goal_receive');
      profile.sessions.repository.receive = async input => { await receive(input); throw interruption; };
      try {
        await assert.rejects(profile.turns.changeGoal(profile.actor, { sessionId: first.sessionId, workId: first.workId,
          messageId: 'interrupted', rawText: texts.read, expectedGoalRevision: first.snapshot.goalRevision,
          expectedControlRevision: first.snapshot.execution.revision }), error => error === interruption);
      } finally { profile.sessions.repository.receive = receive; }
      const state = await profile.runtime.state(first.workId); assert.equal(state.goal.revision, 1);
      assert.equal((await profile.sessions.repository.input(state.conversation!.session!.scope, 'interrupted'))!.status, 'pending');
    } finally { await profile.close(); }
    const recovered = await call(f.directory, goalArgs(first, 'interrupted', texts.read));
    assert.equal(recovered.created, false); assert.equal(recovered.run, undefined); assert.equal(recovered.snapshot.goalRevision, 2);
    assert.equal(recovered.snapshot.status, 'ready'); assert.equal(recovered.snapshot.execution.requestedMode, 'auto');
    assert.deepEqual(recovered.snapshot.usage, first.snapshot.usage);
    const resumed = await call(f.directory, ['resume', '--work', first.workId, '--session', first.sessionId, '--goal-revision', '2']);
    assert.equal(resumed.snapshot.status, 'completed'); assert.equal(resumed.snapshot.usage.toolCalls, 1);
    assert.equal(resumed.snapshot.usage.modelCalls, first.snapshot.usage.modelCalls + 2);
    assert.ok(resumed.messages.some(item => item.kind === 'result' && item.text.includes('doc-current')));
    const resumedProfile = await openAgentTurnProfile(f.directory, { provider: 'synthetic' }, hostOptions(f.directory));
    try {
      const state = await resumedProfile.runtime.state(first.workId);
      assert.deepEqual(state.budget.limits, before.budget.limits); assert.equal(state.deadlineAt, before.deadlineAt);
      assert.equal(state.budget.used.modelCalls, before.budget.used.modelCalls + 2);
    } finally { await resumedProfile.close(); }
    const history = await call<SessionPage>(f.directory, ['history', '--session', first.sessionId]);
    assert.deepEqual(history.entries.filter(entry => entry.role === 'user').map(entry => entry.text), [texts.rewrite, texts.read]);
  } finally { f.close(); }
});
