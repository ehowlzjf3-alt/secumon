import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalWorkbench } from '../presentation/local-workbench.js';
import { openLocalProfile } from '../presentation/local-profile.js';
import type { WebCommandInput } from '../presentation/web-contracts.js';
import type { WorkViewResult } from '../domain/work-view.js';
import type { Goal, WorkState } from '../domain/model.js';
import { transact } from '../application/work-transactions.js';
import { adapters, type Adapter } from './state-conformance-helpers.js';

const actor = { tenantId: 'synthetic', principalId: 'learner' };
function view(result: WorkViewResult) { assert.equal(result.kind, 'snapshot'); if (result.kind !== 'snapshot') throw new Error('snapshot_required'); return result.view; }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t: TestContext, backend: Adapter) {
  const directory = await mkdtemp(join(tmpdir(), 'local-workbench-')); let profile = await openLocalProfile(directory, backend); let workbench = new LocalWorkbench(profile);
  t.after(async () => { await workbench.drain(); await profile.close(); await rm(directory, { recursive: true, force: true }); });
  let sequence = 0;
  return { directory, get profile() { return profile; }, get workbench() { return workbench; },
    accept: (requestId = 'request', scenarioId: 'documents-simple' | 'observations-simple' | 'documents-question' = 'documents-simple') => workbench.accept({ requestId, scenarioId, mode: 'auto' }),
    mutate: (workId: string, edit: (state: WorkState) => void) => transact(profile.services, workId, `fixture:${++sequence}`, 'fixture_changed', {}, edit),
    async stateImage(workId: string) { return { state: await profile.services.state.get(workId), events: await profile.services.state.events(workId, 0), deliveries: await profile.services.state.deliveries(workId), messages: await profile.services.sink.messages(actor, 'web', 'web') }; },
    async reopen() { await workbench.drain(); await profile.close(); profile = await openLocalProfile(directory, backend); workbench = new LocalWorkbench(profile); },
  };
}
const run = (requestId = 'run', expectedGoalRevision = 1): Extract<WebCommandInput, { kind: 'run' }> => ({ kind: 'run', requestId, expectedGoalRevision });
async function editableGoal(workbench: LocalWorkbench, workId: string): Promise<Goal> {
  const current = view(await workbench.view(workId, 'details')).details!.goal;
  assert.equal(current.editable, true);
  return { revision: current.revision! + 1, description: current.description, scope: current.scope, mode: current.mode, criteria: current.criteria! };
}

for (const backend of adapters) {
  test(`${backend}: accepted work, request replay, and queries stay separate from fixture execution`, async t => {
    const f = await fixture(t, backend); assert.deepEqual(await f.workbench.list(), { items: [], nextCursor: null });
    assert.deepEqual(f.workbench.config().scenarios.map(scenario => scenario.id), ['documents-simple', 'observations-simple', 'documents-question']);
    assert.equal(f.workbench.config().model, 'disabled');
    const accepted = await f.accept(); assert.equal(accepted.accepted, true); const before = await f.stateImage(accepted.workId);
    assert.equal(before.state!.plan, null); assert.equal(before.state!.attempts.length, 0); assert.equal(before.state!.modelCalls.length, 0);
    assert.equal(before.messages[0]!.kind, 'ack'); assert.equal(before.deliveries[0]!.status, 'delivered');
    assert.deepEqual(await f.accept(), { workId: accepted.workId, accepted: false });
    const initial = await f.workbench.view(accepted.workId); assert.equal((await f.workbench.view(accepted.workId, 'conversation', initial.cursor)).kind, 'unchanged');
    assert.equal((await f.workbench.list()).items[0]!.workId, accepted.workId); assert.deepEqual(await f.stateImage(accepted.workId), before);
    await assert.rejects(f.workbench.accept({ requestId: 'request', scenarioId: 'documents-simple', mode: 'deep' }), /idempotency_conflict/);
    await assert.rejects(f.workbench.accept({ requestId: 'request', scenarioId: 'documents-question', mode: 'auto' }), /idempotency_conflict/);
    const completed = await f.workbench.command(accepted.workId, run()); assert.equal(completed.duplicate, false); assert.equal(view(completed.view).progress.status, 'completed');
    assert.equal(view(completed.view).progress.resultReady, true); assert.equal(view(completed.view).progress.resultDelivery, 'delivered');
    const finished = await f.stateImage(accepted.workId); assert.equal(finished.state!.budget.used.toolCalls, 1); assert.equal(finished.state!.budget.used.modelCalls, 0);
    assert.equal((await f.workbench.command(accepted.workId, run())).duplicate, true); assert.deepEqual(await f.stateImage(accepted.workId), finished);
    await assert.rejects(f.workbench.command(accepted.workId, { ...run(), reason: 'Changed request' }), /idempotency_conflict/);
  });

  test(`${backend}: document question is atomic, actionable, and does not interpret reply text`, async t => {
    const f = await fixture(t, backend); const accepted = await f.accept('question', 'documents-question');
    const receipt = await f.profile.services.state.receipt(accepted.workId, 'conversation.accept'); assert.ok(receipt);
    assert.equal(receipt.state.status, 'waiting'); assert.equal(receipt.state.obligations.filter(obligation => obligation.kind === 'response').length, 1);
    const waiting = view(await f.workbench.view(accepted.workId)); assert.equal(waiting.questions!.length, 1); assert.equal(waiting.messages.at(-1)!.kind, 'question');
    const firstRun = await f.workbench.command(accepted.workId, run('before-answer')); assert.equal(view(firstRun.view).progress.status, 'waiting');
    assert.equal((await f.profile.runtime.state(accepted.workId)).budget.used.toolCalls, 0);
    const response: WebCommandInput = { kind: 'resolve', requestId: 'reply', expectedGoalRevision: 1, obligationId: waiting.questions![0]!.id, reason: 'Synthetic confirmation; no language understanding is asserted.' };
    const resolved = await f.workbench.command(accepted.workId, response); assert.deepEqual(view(resolved.view).questions, []); assert.equal(view(resolved.view).progress.status, 'ready');
    assert.equal((await f.workbench.command(accepted.workId, response)).duplicate, true);
    await assert.rejects(f.workbench.command(accepted.workId, { ...response, requestId: 'other-reply' }), /obligation_not_resolvable/);
    const done = await f.workbench.command(accepted.workId, run('after-answer')); assert.equal(view(done.view).progress.status, 'completed');
    assert.equal((await f.profile.runtime.state(accepted.workId)).budget.used.modelCalls, 0);
  });

  test(`${backend}: current ownership, route, and disclosure gates apply to reads and mutations`, async t => {
    const f = await fixture(t, backend); const { workId } = await f.accept();
    const otherActor = new LocalWorkbench(f.profile, { ...actor, principalId: 'other-person' });
    await assert.rejects(otherActor.view(workId), /work_view_denied/); await assert.rejects(otherActor.attach({ requestId: 'attach-other', workId }), /work_view_denied/);
    const otherRoute = new LocalWorkbench(f.profile, actor, 'other-web'); await assert.rejects(otherRoute.command(workId, run()), /work_view_denied/);
    await f.mutate(workId, state => { state.policy.disclosure!.destinations[0]!.surfaces = ['channel', 'tool']; }); const before = await f.stateImage(workId);
    await assert.rejects(f.workbench.view(workId), /work_view_denied/); await assert.rejects(f.workbench.command(workId, { kind: 'cancel', requestId: 'cancel-denied', expectedGoalRevision: 1 }), /work_view_denied/);
    assert.deepEqual(await f.workbench.list(), { items: [], nextCursor: null }); assert.deepEqual(await f.stateImage(workId), before);
  });

  test(`${backend}: web attachment observes an existing CLI primary without re-sending or changing it`, async t => {
    const f = await fixture(t, backend); const scenario = f.profile.scenarios.find(value => value.id === 'documents-simple')!;
    const accepted = await f.profile.workflow.accept(actor, { messageId: 'cli-request', binding: { ...actor, channel: 'cli', conversationId: 'terminal', recipientId: actor.principalId, destination: 'local' },
      goal: scenario.goal, policy: scenario.policy, limits: { toolCalls: 10, modelCalls: 0, tokens: 10000, replans: 5, wallTimeMs: 60000 }, completionRequiresDelivery: true });
    const primary = accepted.state.conversation!.primaryBindingId; const cliMessages = await f.profile.services.sink.messages(actor, 'cli', 'terminal');
    await assert.rejects(f.workbench.view(accepted.workId), /work_view_denied/);
    const attached = await f.workbench.attach({ requestId: 'attach', workId: accepted.workId }); assert.equal(attached.attached, true); assert.equal(view(attached.view).reply.observingPrimary, false);
    assert.equal(view(attached.view).reply.channel, 'cli'); assert.equal((await f.profile.runtime.state(accepted.workId)).conversation!.primaryBindingId, primary);
    const before = await f.stateImage(accepted.workId); assert.equal((await f.workbench.attach({ requestId: 'attach', workId: accepted.workId })).duplicate, true); assert.deepEqual(await f.stateImage(accepted.workId), before);
    assert.deepEqual(await f.profile.services.sink.messages(actor, 'cli', 'terminal'), cliMessages); assert.deepEqual(await f.profile.services.sink.messages(actor, 'web', 'web'), []);
    const done = await f.workbench.command(accepted.workId, run()); assert.equal(view(done.view).progress.resultReady, true); assert.equal(view(done.view).reply.channel, 'cli');
    assert.equal((await f.profile.services.sink.messages(actor, 'cli', 'terminal')).filter(message => message.kind === 'result').length, 1); assert.deepEqual(await f.profile.services.sink.messages(actor, 'web', 'web'), []);
  });

  test(`${backend}: goal and mode commands preserve optimistic revisions and durable idempotency`, async t => {
    const f = await fixture(t, backend); const { workId } = await f.accept(); const goal = { ...await editableGoal(f.workbench, workId), description: 'Revised synthetic question' };
    const changed: WebCommandInput = { kind: 'goal', expectedControlRevision: 1, requestId: 'edit-goal', expectedGoalRevision: 1, goal };
    assert.equal(view((await f.workbench.command(workId, changed)).view).goalRevision, 2); const after = await f.stateImage(workId);
    assert.equal((await f.workbench.command(workId, changed)).duplicate, true); assert.deepEqual(await f.stateImage(workId), after);
    await assert.rejects(f.workbench.command(workId, run('stale-run')), /stale_user_command/);
    await assert.rejects(f.workbench.command(workId, { kind: 'pause', requestId: 'stale-pause', expectedGoalRevision: 1 }), /stale_user_command/);
    const current = view(await f.workbench.view(workId));
    const mode: WebCommandInput = { kind: 'mode', requestId: 'deep-mode', expectedGoalRevision: 2, expectedControlRevision: current.mode.revision, mode: 'deep', reason: 'Explicit mode selection' };
    assert.equal(view((await f.workbench.command(workId, mode)).view).mode.requested, 'deep'); assert.equal((await f.workbench.command(workId, mode)).duplicate, true);
    await assert.rejects(f.workbench.command(workId, { ...mode, requestId: 'stale-control', mode: 'fast' }), /stale_execution_control/);
    const done = await f.workbench.command(workId, run('run-revised', 2)); assert.equal(view(done.view).goalRevision, 2); assert.equal(view(done.view).progress.status, 'completed');
  });

  for (const kind of ['pause', 'cancel'] as const) test(`${backend}: ${kind} does not wait behind an active run and a replay cannot start another run`, async t => {
    const f = await fixture(t, backend); const { workId } = await f.accept(); const entered = deferred(); const release = deferred();
    const original = f.profile.workflow.run.bind(f.profile.workflow); let workflowCalls = 0;
    f.profile.workflow.run = async (...args) => { workflowCalls++; entered.resolve(); await release.promise; return original(...args); };
    const first = f.workbench.command(workId, run()); await entered.promise;
    const duplicate = f.workbench.command(workId, run()); await assert.rejects(f.workbench.command(workId, run('different-run')), /web_run_in_progress/);
    const controlled = await f.workbench.command(workId, { kind, requestId: kind, expectedGoalRevision: 1, reason: 'Explicit user control' });
    assert.equal(view(controlled.view).progress.status, kind === 'pause' ? 'paused' : 'cancelled');
    release.resolve(); const [ended, replay] = await Promise.all([first, duplicate]); assert.equal(replay.duplicate, true); assert.equal(workflowCalls, 1);
    assert.equal(view(ended.view).progress.status, kind === 'pause' ? 'paused' : 'cancelled'); assert.equal((await f.profile.runtime.state(workId)).budget.used.toolCalls, 0);
    if (kind === 'pause') {
      await f.workbench.command(workId, { kind: 'resume', requestId: 'resume', expectedGoalRevision: 1 });
      const finished = await f.workbench.command(workId, run('resume-run')); assert.equal(view(finished.view).progress.status, 'completed');
    } else await assert.rejects(f.workbench.command(workId, { kind: 'resume', requestId: 'resume', expectedGoalRevision: 1 }), /work_terminal/);
  });

  test(`${backend}: an unfinished durable run is not repeated by the same request after restart`, async t => {
    const f = await fixture(t, backend); const { workId } = await f.accept();
    f.profile.workflow.run = async () => { throw new Error('synthetic_worker_stopped'); };
    await assert.rejects(f.workbench.command(workId, run('interrupted')), /synthetic_worker_stopped/);
    const interrupted = await f.stateImage(workId); assert.equal(interrupted.state!.budget.used.toolCalls, 0); assert.ok(interrupted.events.some(event => event.type === 'web_run_requested'));
    await f.reopen(); const replay = await f.workbench.command(workId, run('interrupted')); assert.equal(replay.duplicate, true); assert.deepEqual(await f.stateImage(workId), interrupted);
    const completed = await f.workbench.command(workId, run('new-explicit-run')); assert.equal(view(completed.view).progress.status, 'completed');
    assert.equal((await f.profile.runtime.state(workId)).budget.used.toolCalls, 1);
  });

  test(`${backend}: a goal changed while the old run intent is acknowledged never receives that run's plan`, async t => {
    const f = await fixture(t, backend); const { workId } = await f.accept(); const nextGoal = { ...await editableGoal(f.workbench, workId), description: 'The newly requested goal' };
    const original = f.profile.services.state.commit.bind(f.profile.services.state); let changed = false;
    f.profile.services.state.commit = async request => {
      const result = await original(request);
      if (!changed && request.events.some(event => event.type === 'web_run_requested')) { changed = true;
        await f.workbench.command(workId, { kind: 'goal', expectedControlRevision: 1, requestId: 'racing-goal', expectedGoalRevision: 1, goal: nextGoal }); }
      return result;
    };
    await assert.rejects(f.workbench.command(workId, run('old-goal-run')), /stale_user_command/);
    const current = await f.profile.runtime.state(workId); assert.equal(current.goal.revision, 2); assert.equal(current.plan, null); assert.equal(current.budget.used.toolCalls, 0);
    assert.equal((await f.workbench.command(workId, run('old-goal-run'))).duplicate, true);
    assert.equal(view((await f.workbench.command(workId, run('new-goal-run', 2))).view).progress.status, 'completed');
  });

  test(`${backend}: workflow entry rejects a stale pinned goal before recovery or execution`, async t => {
    const f = await fixture(t, backend); const { workId } = await f.accept(); const goal = await editableGoal(f.workbench, workId);
    await f.workbench.command(workId, { kind: 'goal', expectedControlRevision: 1, requestId: 'goal', expectedGoalRevision: 1, goal }); const before = await f.stateImage(workId);
    await assert.rejects(f.profile.workflow.run(workId, actor, { maxSteps: 40, expectedGoalRevision: 1 }), /stale_user_command/);
    assert.deepEqual(await f.stateImage(workId), before);
  });

  test(`${backend}: paged lists recheck every returned card and omit a card revoked while another is read`, async t => {
    const f = await fixture(t, backend);
    for (let index = 0; index < 21; index++) await f.accept(`work-${index}`);
    let calls = 0; const original = f.profile.workView.read.bind(f.profile.workView); f.profile.workView.read = async (...args) => { calls++; return original(...args); };
    const first = await f.workbench.list(); assert.equal(first.items.length, 20); assert.ok(first.nextCursor); assert.equal(calls, 40);
    const second = await f.workbench.list(first.nextCursor!); assert.equal(second.items.length, 1); assert.equal(second.nextCursor, null); assert.ok(!first.items.some(item => item.workId === second.items[0]!.workId));
    await assert.rejects(f.workbench.list('wl1:foreign-cursor'), /web_list_cursor_invalid/);
    const [one, two] = first.items.map(item => item.workId);
    let revoked = false; f.profile.workView.read = async (...args) => {
      if (!revoked && args[0] === two) { revoked = true; await f.mutate(one!, state => { state.policy.disclosure!.destinations[0]!.surfaces = ['tool', 'channel']; }); }
      return original(...args);
    };
    const checked = await f.workbench.list(); assert.equal(checked.items.some(item => item.workId === one), false); assert.ok(checked.items.some(item => item.workId === two));
  });

  test(`${backend}: at most four distinct works execute concurrently and draining admits no new mutations`, async t => {
    const f = await fixture(t, backend); const ids: string[] = [];
    for (let index = 0; index < 5; index++) ids.push((await f.accept(`capacity-${index}`)).workId);
    const entered = deferred(); const release = deferred(); const original = f.profile.workflow.run.bind(f.profile.workflow); let calls = 0;
    f.profile.workflow.run = async (...args) => { if (++calls === 4) entered.resolve(); await release.promise; return original(...args); };
    const running = ids.slice(0, 4).map((workId, index) => f.workbench.command(workId, run(`parallel-${index}`))); await entered.promise;
    await assert.rejects(f.workbench.command(ids[4]!, run('overflow')), /web_run_capacity/);
    assert.equal((await f.profile.services.state.events(ids[4]!, 0)).filter(event => event.type === 'web_run_requested').length, 0);
    const draining = f.workbench.drain(); await assert.rejects(f.accept('after-drain'), /web_workbench_draining/);
    release.resolve(); await Promise.all(running); await draining; assert.equal(calls, 4);
  });
}
