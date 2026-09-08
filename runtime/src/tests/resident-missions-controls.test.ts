import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { readGeneratedAnswer } from '../application/generated-answer.js';
import { residentEntryFixture, residentEvent } from './resident-missions-entry-fixture.js';

function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('resident_control_gate_timeout')), 15000); })]); }
  finally { clearTimeout(timer); }
}

async function record(p: AgentTurnProfile, workId: string) {
  const state = await p.runtime.state(workId), intake = await p.services.state.receipt(workId, 'conversation.accept'); assert.ok(intake);
  const session = intake.state.conversation?.session; assert.ok(session);
  const input = await p.sessions.repository.input(session.scope, session.input.messageId); assert.ok(input);
  const receipts = await Promise.all((state.subscriptions ?? []).map(async subscription => {
    const receipt = await p.services.state.receipt(workId, subscription.checkpointId); assert.ok(receipt);
    return { commandId: subscription.checkpointId, receipt };
  }));
  const refs = new Map([...state.artifacts, ...state.attempts.flatMap(value => value.resultArtifact ? [value.resultArtifact] : []),
    ...state.modelCalls.flatMap(value => [value.inputArtifact, ...(value.replyArtifact ? [value.replyArtifact] : [])]),
    ...(state.generatedAnswer ? [state.generatedAnswer.artifact] : [])].map(ref => [ref.id, ref]));
  const originals = await Promise.all([...refs.values()].map(async artifact => ({ artifact, bytes: await p.services.artifacts.get(artifact, state.policy) })));
  return { state, intake, input, session, receipts, originals, events: await p.services.state.events(workId, 0), deliveries: await p.services.state.deliveries(workId) };
}

async function retained(p: AgentTurnProfile, saved: Awaited<ReturnType<typeof record>>, unchangedState = false) {
  const state = await p.runtime.state(saved.state.id), events = await p.services.state.events(state.id, 0);
  if (unchangedState) {
    assert.deepEqual(state, saved.state); assert.deepEqual(events, saved.events);
    assert.deepEqual(await p.services.state.deliveries(state.id), saved.deliveries);
  } else assert.deepEqual(events.slice(0, saved.events.length), saved.events);
  assert.deepEqual(await p.services.state.receipt(state.id, 'conversation.accept'), saved.intake);
  assert.deepEqual(await p.sessions.repository.input(saved.session.scope, saved.session.input.messageId), saved.input);
  for (const item of saved.receipts) assert.deepEqual(await p.services.state.receipt(state.id, item.commandId), item.receipt);
  for (const item of saved.originals) assert.deepEqual(await p.services.artifacts.get(item.artifact, saved.state.policy), item.bytes);
}

test('resident controls: pause persists pending events across reopen, resume uses the same session, and stop cannot be resumed', { timeout: 120000 }, async t => {
  const f = await residentEntryFixture(t), a = residentEvent('before-pause', 'BEFORE_PAUSE'), b = residentEvent('after-pause', 'AFTER_PAUSE');
  f.pages.first.push([a, b]); const registered = await f.register();
  const first = await f.driver().tick(registered.workId, { maxSteps: 20 }); assert.equal(first.kind, 'event'); if (first.kind !== 'event') return;
  assert.equal(first.status, 'completed');
  const prior = await f.driver().status(registered.workId), originalController = await record(f.current(), registered.workId), firstWork = await record(f.current(), first.workId);
  assert.deepEqual(prior.pending, [{ eventId: b.id, workId: null }]);
  // Explicit host memory creation uses the actual first event's applied user-input receipt.
  const memory = await f.current().personalKnowledge(f.current().actor);
  const saved = await memory.remember({ id: 'resident-control-note', commandId: 'remember-before-pause', title: 'Retained original event note',
    source: { sessionId: registered.sessionId, messageId: firstWork.input.messageId, quote: 'BEFORE_PAUSE' } });
  assert.equal(saved.card.body, 'BEFORE_PAUSE'); assert.equal(saved.card.owner?.agentId, f.current().agentId);
  assert.equal(saved.dependency.sources[0]?.type, 'session_user_receipt');
  const preservedMemory = async () => {
    const own = await f.current().personalKnowledge(f.current().actor), other = await f.current('second').personalKnowledge(f.current('second').actor);
    assert.deepEqual((await own.get(saved.card.id)).card, saved.card);
    assert.deepEqual((await f.memory('first')).map(card => card.id), [saved.card.id]);
    assert.deepEqual(await f.memory('second'), []);
    await assert.rejects(other.get(saved.card.id), /knowledge_unavailable/);
  };
  await preservedMemory(); await retained(f.current(), firstWork, true);
  const paused = await f.driver().pause(registered.workId);
  assert.equal(paused.status, 'paused'); assert.equal(paused.reason, 'host_paused');
  for (const key of ['sessionId', 'cursor', 'events', 'pending', 'rule'] as const) assert.deepEqual(paused[key], prior[key]);
  const checkpoint = await record(f.current(), registered.workId);
  assert.deepEqual(checkpoint.state.budget, originalController.state.budget);
  assert.equal(checkpoint.state.subscriptions?.find(value => value.provider === 'resident-mission')?.status, 'active');
  assert.deepEqual(await f.driver().pause(registered.workId), paused); await retained(f.current(), checkpoint, true);
  const polls = structuredClone(f.observed.polls), inputs = structuredClone(f.observed.inputs);
  await f.reopen(); assert.deepEqual(await f.driver().status(registered.workId), paused);
  await preservedMemory();
  assert.deepEqual(await f.driver().tick(registered.workId), { kind: 'paused', reason: 'host_paused' });
  const drive = await bounded(f.driver().drive(registered.workId, { maxTicks: 2, intervalMs: 100 }));
  assert.equal(drive.kind, 'paused');
  assert.deepEqual(f.observed.polls, polls); assert.deepEqual(f.observed.inputs, inputs); await retained(f.current(), checkpoint, true);
  const active = await f.driver().resume(registered.workId); assert.equal(active.status, 'active');
  for (const key of ['sessionId', 'cursor', 'events', 'pending', 'rule'] as const) assert.deepEqual(active[key], paused[key]);
  const resumedController = await record(f.current(), registered.workId);
  assert.deepEqual(await f.driver().resume(registered.workId), active); await retained(f.current(), resumedController, true);
  for (let cycle = 0; cycle < 2; cycle++) {
    assert.equal((await f.driver().pause(registered.workId)).status, 'paused');
    assert.deepEqual(await f.driver().resume(registered.workId), active);
    assert.ok((await f.current().runtime.state(registered.workId)).revision > resumedController.state.revision);
  }
  assert.deepEqual(f.observed.inputs, inputs); assert.deepEqual(f.observed.polls, polls);
  const second = await f.driver().tick(registered.workId, { maxSteps: 20 }); assert.equal(second.kind, 'event'); if (second.kind !== 'event') return;
  assert.equal(second.eventId, b.id); assert.equal(second.status, 'completed'); assert.equal(second.sessionId, registered.sessionId);
  assert.notEqual(second.workId, first.workId); assert.equal(f.observed.inputs.first.length, 2);
  assert.deepEqual(f.observed.polls, polls, 'resuming a stored pending event needs no new source poll');
  await retained(f.current(), firstWork, true); await retained(f.current(), originalController); await preservedMemory();
  await f.driver().stop(registered.workId); const stopped = await record(f.current(), registered.workId);
  assert.equal((await f.driver().status(registered.workId)).status, 'closed');
  await f.reopen(); await assert.rejects(f.driver().resume(registered.workId), /resident_mission_closed/);
  assert.equal((await f.driver().tick(registered.workId)).kind, 'closed'); await retained(f.current(), stopped, true);
  assert.equal(f.observed.inputs.first.length, 2); assert.deepEqual(f.observed.polls, polls);
  await preservedMemory();
});

test('resident controls: an explicitly changed goal after original intake is detached without automatic execution and remains explicitly resumable', { timeout: 120000 }, async t => {
  const f = await residentEntryFixture(t), event = residentEvent('goal-event', 'ORIGINAL_EVENT_GOAL'); f.pages.first.push([event]);
  const registered = await f.register(), p = f.current(), accept = p.sessions.accept;
  const stop = new Error('resident_after_original_intake'); let workId: string | undefined;
  p.sessions.accept = async (...args) => { const result = await accept.apply(p.sessions, args); workId = result.workId; throw stop; };
  try { await assert.rejects(f.driver().tick(registered.workId, { maxSteps: 20 }), error => error === stop); }
  finally { p.sessions.accept = accept; }
  assert.ok(workId); const original = await record(p, workId);
  assert.equal(original.state.budget.used.modelCalls, 0); assert.deepEqual((await f.driver().status(registered.workId)).pending, [{ eventId: event.id, workId: null }]);
  const basis = await p.turns.goalChangeBasis(p.actor, { sessionId: registered.sessionId, workId });
  const rawText = 'Use this new explicit goal and preserve the earlier event only as conversation context.';
  const changed = await p.turns.changeGoal(p.actor, { sessionId: registered.sessionId, workId, messageId: 'explicit-replacement-goal', rawText,
    expectedGoalRevision: basis.expectedGoalRevision, expectedControlRevision: basis.expectedControlRevision, expectedInput: basis.expectedInput });
  const replacement = await record(p, workId); assert.equal(replacement.state.goal.revision, 2);
  assert.equal(replacement.state.goal.description, rawText); assert.deepEqual(replacement.state.budget, original.state.budget);
  assert.notEqual(replacement.state.goal.responseRequirement?.requestMessageId, original.state.goal.responseRequirement?.requestMessageId);
  await f.reopen(); const polls = structuredClone(f.observed.polls);
  const detached = await f.driver().tick(registered.workId, { maxSteps: 20 });
  assert.equal(detached.kind, 'event'); if (detached.kind !== 'event') return;
  assert.equal(detached.workId, workId); assert.equal(detached.continuation, 'explicit_resume_required'); assert.equal(detached.result, null);
  assert.deepEqual((await f.driver().status(registered.workId)).pending, []);
  assert.deepEqual((await f.driver().status(registered.workId)).events.map(value => ({ id: value.id, workId: value.workId })), [{ id: event.id, workId }]);
  assert.equal(f.observed.inputs.first.length, 0); assert.deepEqual(f.observed.polls, polls);
  await retained(f.current(), replacement, true); await retained(f.current(), original);
  const current = f.current();
  assert.deepEqual((await current.sessions.commandContext(current.actor, { sessionId: registered.sessionId, workId, messageId: changed.input.messageId })).receipt, changed.input);
  assert.equal((await current.workflow.run(workId, current.executionActor, { maxSteps: 20 })).control.kind, 'complete');
  const done = await record(current, workId);
  assert.equal(done.state.goal.description, rawText); assert.equal(done.state.budget.used.modelCalls, 1); assert.equal(done.state.budget.used.toolCalls, 0);
  assert.equal((await readGeneratedAnswer(current.services, done.state))?.text, 'first: ' + rawText);
  assert.deepEqual(done.state.evidence, []); await retained(current, original);
  f.pages.first.push([event, residentEvent('next-after-goal', 'NEXT_AFTER_EXPLICIT_GOAL')]); await f.due(registered.workId);
  const next = await f.driver().tick(registered.workId, { maxSteps: 20 }); assert.equal(next.kind, 'event'); if (next.kind !== 'event') return;
  assert.equal(next.eventId, 'next-after-goal'); assert.equal(next.status, 'completed'); assert.equal(next.sessionId, registered.sessionId);
  assert.notEqual(next.workId, workId); assert.equal(f.observed.inputs.first.length, 2);
  await retained(current, done, true); assert.deepEqual(await f.memory('first'), []);
});

test('resident controls: explicitly paused or cancelled accepted event work is not reexecuted while the next event remains independent', { timeout: 120000 }, async t => {
  for (const action of ['pause', 'cancel'] as const) {
    const f = await residentEntryFixture(t), event = residentEvent(action + '-event', 'ORIGINAL_' + action);
    f.pages.first.push([event]); const registered = await f.register(), p = f.current(), run = p.workflow.run;
    const stop = new Error('resident_before_actual_workflow'); let workId: string | undefined;
    // The controller has committed the actual event intake and pending work ID; no workflow result is fabricated.
    p.workflow.run = async id => { workId = id; throw stop; };
    try { await assert.rejects(f.driver().tick(registered.workId, { maxSteps: 20 }), error => error === stop); }
    finally { p.workflow.run = run; }
    assert.ok(workId); const original = await record(p, workId);
    assert.deepEqual((await f.driver().status(registered.workId)).pending, [{ eventId: event.id, workId }]);
    await p.sessions.command(p.actor, { sessionId: registered.sessionId, workId, messageId: 'explicit-' + action,
      rawText: 'Explicitly ' + action + ' this event work; keep the resident responsible for other events.',
      expectedGoalRevision: original.state.goal.revision, command: { kind: action, reason: 'explicit_event_' + action } });
    const controlled = await record(p, workId); assert.equal(controlled.state.status, action === 'pause' ? 'paused' : 'cancelled');
    assert.deepEqual(controlled.state.budget, original.state.budget); assert.equal(controlled.state.attempts.length, 0);
    await f.reopen(); const polls = structuredClone(f.observed.polls);
    const skipped = await f.driver().tick(registered.workId, { maxSteps: 20 }); assert.equal(skipped.kind, 'event'); if (skipped.kind !== 'event') return;
    assert.equal(skipped.workId, workId); assert.equal(skipped.status, controlled.state.status); assert.equal(skipped.result, null);
    assert.deepEqual((await f.driver().status(registered.workId)).pending, []);
    assert.equal(f.observed.inputs.first.length, 0); assert.deepEqual(f.observed.polls, polls); await retained(f.current(), controlled, true);
    f.pages.first.push([event, residentEvent('next-' + action, 'NEXT_INDEPENDENT_' + action)]); await f.due(registered.workId);
    const next = await f.driver().tick(registered.workId, { maxSteps: 20 }); assert.equal(next.kind, 'event'); if (next.kind !== 'event') return;
    assert.equal(next.eventId, 'next-' + action); assert.equal(next.status, 'completed'); assert.equal(next.sessionId, registered.sessionId);
    assert.notEqual(next.workId, workId); assert.equal(f.observed.inputs.first.length, 1);
    await retained(f.current(), controlled, true); await retained(f.current(), original);
    assert.deepEqual(await f.memory('first'), []); assert.deepEqual(await f.memory('second'), []);
  }
});

test('resident controls: pause during a gated source poll rejects its late page and resume reads the same cursor once', { timeout: 120000 }, async t => {
  const f = await residentEntryFixture(t); f.pages.first.push([residentEvent('gated-pause', 'GATED_PAUSE_ORIGINAL')]);
  const registered = await f.register(), driver = f.driver(), entered = gate(), release = gate();
  f.controls.beforePoll = async () => { entered.release(); await release.promise; };
  const pending = driver.tick(registered.workId, { maxSteps: 20 }); void pending.catch(() => {});
  try {
    await bounded(Promise.race([entered.promise, pending.then(() => assert.fail('tick returned before entering the source gate'))]));
    const paused = await driver.pause(registered.workId), saved = await record(f.current(), registered.workId);
    assert.equal(paused.status, 'paused'); assert.equal(paused.cursor, 0); assert.deepEqual(paused.pending, []);
    release.release(); await assert.rejects(bounded(pending), /resident_mission_changed/);
    assert.deepEqual(await driver.status(registered.workId), paused); await retained(f.current(), saved, true);
    assert.equal(f.observed.inputs.first.length, 0); assert.deepEqual(f.observed.polls.map(value => value.cursor), [0]);
    delete f.controls.beforePoll; await driver.resume(registered.workId);
    const event = await driver.tick(registered.workId, { maxSteps: 20 }); assert.equal(event.kind, 'event'); if (event.kind !== 'event') return;
    assert.equal(event.eventId, 'gated-pause'); assert.equal(event.status, 'completed'); assert.equal(event.sessionId, registered.sessionId);
    assert.deepEqual(f.observed.polls.map(value => value.cursor), [0, 0]); assert.equal(f.observed.inputs.first.length, 1);
    assert.equal((await driver.status(registered.workId)).cursor, 1); await retained(f.current(), saved);
    assert.deepEqual(await f.memory('first'), []);
  } finally { release.release(); delete f.controls.beforePoll; await bounded(Promise.allSettled([pending])); }
});

test('resident controls: an actual goal change during workflow stops automatic continuation until an explicit user resume', { timeout: 120000 }, async t => {
  const f = await residentEntryFixture(t); f.pages.first.push([residentEvent('running-goal', 'ORIGINAL_RUNNING_GOAL')]);
  const registered = await f.register(), p = f.current(), newGoal = 'Answer this replacement request only after my explicit resume.';
  let original: Awaited<ReturnType<typeof record>> | undefined, replacement: Awaited<ReturnType<typeof record>> | undefined;
  let changed = false, callsAtChange = 0;
  const result = await f.driver().tick(registered.workId, { maxSteps: 20, async onStep() {
    if (changed) return;
    const status = await f.driver().status(registered.workId), pending = status.pending[0]; assert.ok(pending?.workId);
    const state = await p.runtime.state(pending.workId);
    if (!state.budget.used.modelCalls) return;
    assert.equal(state.budget.used.modelCalls, 1); assert.notEqual(state.status, 'completed');
    original = await record(p, state.id);
    const basis = await p.turns.goalChangeBasis(p.actor, { sessionId: registered.sessionId, workId: state.id });
    await p.turns.changeGoal(p.actor, { sessionId: registered.sessionId, workId: state.id, messageId: 'change-while-running', rawText: newGoal,
      expectedGoalRevision: basis.expectedGoalRevision, expectedControlRevision: basis.expectedControlRevision, expectedInput: basis.expectedInput });
    replacement = await record(p, state.id); callsAtChange = f.observed.inputs.first.length; changed = true;
  } });
  assert.equal(changed, true); assert.ok(original); assert.ok(replacement);
  assert.equal(result.kind, 'event'); if (result.kind !== 'event') return;
  assert.equal(result.workId, original.state.id); assert.equal(result.continuation, 'explicit_resume_required');
  assert.equal(result.status, 'ready'); assert.equal(result.result, null);
  assert.equal(callsAtChange, 1); assert.equal(f.observed.inputs.first.length, callsAtChange);
  assert.deepEqual((await f.driver().status(registered.workId)).pending, []);
  await retained(p, replacement, true); await retained(p, original);
  assert.equal(replacement.state.goal.revision, 2); assert.equal(replacement.state.goal.description, newGoal);
  assert.deepEqual(replacement.state.budget, original.state.budget);
  assert.equal((await p.workflow.run(result.workId, p.executionActor, { maxSteps: 20 })).control.kind, 'complete');
  const done = await p.runtime.state(result.workId);
  assert.equal(done.goal.description, newGoal); assert.equal(done.budget.used.modelCalls, callsAtChange + 1); assert.equal(done.budget.used.toolCalls, 0);
  assert.equal(f.observed.inputs.first.length, callsAtChange + 1);
  assert.equal(f.observed.inputs.first.at(-1)!.packet.goal.revision, 2);
  assert.equal((await readGeneratedAnswer(p.services, done))?.text, 'first: ' + newGoal);
  assert.deepEqual(done.evidence, []); await retained(p, original); assert.deepEqual(await f.memory('first'), []);
});
