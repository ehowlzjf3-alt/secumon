import test from 'node:test';
import assert from 'node:assert/strict';
import { RESIDENT_RULE, residentEntryFixture, residentEvent } from './resident-missions-entry-fixture.js';

test('mission entry: the ordinary model tool loop reads a newly observed event and reports it without creating personal memory or evidence', { timeout: 120000 }, async t => {
  const f = await residentEntryFixture(t); f.controls.readMission = true; f.pages.first.push([residentEvent('read-event', 'UNREVIEWED_EVENT_ORIGINAL')]);
  const p = f.current(), session = await p.sessions.open(p.actor, { channel: 'test', conversationId: 'resident-conversation' });
  const accepted = await p.turns.accept(p.actor, { sessionId: session.scope.sessionId, messageId: 'mission-request', rawText: 'Read the incoming event and report what it says.',
    mode: 'auto', scope: p.scope, policy: p.policy, limits: p.limits, binding: f.binding('first') });
  assert.ok(p.missions); await p.missions.register(accepted.workId, RESIDENT_RULE); assert.equal(f.observed.inputs.first.length, 0);
  await p.missions.tick(accepted.workId, p.workflow, { maxSteps: 20 });
  const state = await p.runtime.state(accepted.workId); assert.equal(state.status, 'completed', JSON.stringify({ status: state.status, reason: state.statusReason, progress: state.progress }));
  assert.equal(state.budget.used.toolCalls, 2); assert.equal(state.budget.used.modelCalls, 3);
  assert.equal(state.attempts[0]?.toolId, 'mission.events'); assert.equal(state.attempts[0]?.adopted, true);
  assert.deepEqual(state.evidence, []); assert.deepEqual(await f.memory('first'), []);
  assert.ok(JSON.stringify(f.observed.inputs.first.at(-1)?.packet.toolObservations).includes('UNREVIEWED_EVENT_ORIGINAL'));
});

test('resident entry: event tasks share only their persistent conversation while the controller never executes', { timeout: 120000 }, async t => {
  const f = await residentEntryFixture(t); f.pages.first.push([residentEvent('event-A', 'FIRST_ORIGINAL'), residentEvent('event-B', 'SECOND_ORIGINAL')]);
  const registered = await f.register(), p = f.current(), originalController = await p.runtime.state(registered.workId);
  assert.equal(originalController.status, 'paused'); assert.deepEqual(originalController.budget.used, { toolCalls: 0, modelCalls: 0, tokens: 0, replans: 0, unmeasuredModelCalls: 0 });
  assert.notEqual(originalController.conversation?.session?.scope.sessionId, registered.sessionId);
  assert.equal(f.observed.inputs.first.length, 0);
  const first = await f.driver().tick(registered.workId, { maxSteps: 20 }); assert.equal(first.kind, 'event'); if (first.kind !== 'event') return;
  assert.equal(first.status, 'completed', JSON.stringify(first)); const a = await p.runtime.state(first.workId);
  const second = await f.driver().tick(registered.workId, { maxSteps: 20 }); assert.equal(second.kind, 'event'); if (second.kind !== 'event') return;
  assert.equal(second.status, 'completed', JSON.stringify(second)); const b = await p.runtime.state(second.workId);
  assert.notEqual(a.id, b.id); assert.notDeepEqual(a.goal, b.goal); assert.equal(a.conversation?.session?.scope.sessionId, registered.sessionId);
  assert.equal(b.conversation?.session?.scope.sessionId, registered.sessionId); assert.deepEqual(await p.runtime.state(a.id), a);
  for (const state of [a, b]) { assert.deepEqual(state.evidence, []); assert.equal(state.plan, null); assert.equal(state.budget.used.modelCalls, 1);
    assert.equal(state.budget.used.tokens, 260); assert.equal(state.budget.used.toolCalls, 0); }
  const nextInput = f.observed.inputs.first.find(value => value.packet.workId === b.id); assert.ok(nextInput);
  assert.ok(JSON.stringify(nextInput.packet.session).includes('FIRST_ORIGINAL')); assert.ok(JSON.stringify(nextInput.packet.session).includes('SECOND_ORIGINAL'));
  assert.equal(JSON.stringify(nextInput.packet.session).includes('resident_mission_registration'), false);
  const controller = await p.runtime.state(registered.workId); assert.equal(controller.modelCalls.length, 0); assert.equal(controller.attempts.length, 0);
  assert.deepEqual(controller.budget, originalController.budget); assert.deepEqual(await f.memory('first'), []);
});

test('resident entry: independent directories and original event receipts survive reopen and reject changed redelivery', { timeout: 120000 }, async t => {
  const f = await residentEntryFixture(t); f.pages.first.push([residentEvent('same-event', 'FIRST_PRIVATE')]); f.pages.second.push([residentEvent('same-event', 'SECOND_PRIVATE')]);
  const left = await f.register(), right = await f.register('second');
  const a = await f.driver().tick(left.workId, { maxSteps: 20 }), b = await f.driver('second').tick(right.workId, { maxSteps: 20 });
  assert.equal(a.kind, 'event'); assert.equal(b.kind, 'event'); if (a.kind !== 'event' || b.kind !== 'event') return;
  assert.equal(a.status, 'completed'); assert.equal(b.status, 'completed'); assert.notEqual(a.workId, b.workId); assert.notEqual(left.sessionId, right.sessionId);
  assert.equal(await f.current().services.state.get(b.workId), null); assert.equal(await f.current('second').services.state.get(a.workId), null);
  assert.equal(JSON.stringify(f.observed.inputs.first).includes('SECOND_PRIVATE'), false); assert.equal(JSON.stringify(f.observed.inputs.second).includes('FIRST_PRIVATE'), false);
  const saved = await f.current().runtime.state(a.workId); await f.reopen(); assert.equal((await f.register()).workId, left.workId);
  assert.equal((await f.register()).created, false); f.pages.first.push([residentEvent('same-event', 'FIRST_PRIVATE')]); await f.due(left.workId);
  const repeat = await f.driver().tick(left.workId, { maxSteps: 20 }); assert.equal(repeat.kind, 'wait'); assert.equal(f.observed.inputs.first.length, 1);
  assert.deepEqual(await f.current().runtime.state(a.workId), saved); f.pages.first.push([residentEvent('same-event', 'ALTERED_ORIGINAL')]); await f.due(left.workId);
  await assert.rejects(f.driver().tick(left.workId, { maxSteps: 20 }), /mission_event_identity_conflict/);
  assert.equal((await f.driver().status(left.workId)).cursor, 2); assert.deepEqual(await f.current().runtime.state(a.workId), saved);
  assert.deepEqual(await f.memory('first'), []); assert.deepEqual(await f.memory('second'), []);
});

test('resident entry: accepted intake interrupted before its controller receipt reuses the same work after real compact and reopen', { timeout: 120000 }, async t => {
  const f = await residentEntryFixture(t, true); f.pages.first.push(Array.from({ length: 6 }, (_, i) => residentEvent('history-' + i, 'HISTORY_' + i + '_' + 'original '.repeat(100))));
  const registered = await f.register(); for (let i = 0; i < 6; i++) assert.equal((await f.driver().tick(registered.workId, { maxSteps: 20 })).kind, 'event');
  f.pages.first.push([residentEvent('after-intake', 'PENDING_ORIGINAL')]); await f.due(registered.workId);
  const p = f.current(), accept = p.sessions.accept.bind(p.sessions); let workId: string | undefined;
  p.sessions.accept = async (...args) => { const result = await accept(...args); workId = result.workId; throw new Error('injected_after_actual_event_intake'); };
  try { await assert.rejects(f.driver().tick(registered.workId, { maxSteps: 20 }), /injected_after_actual_event_intake/); } finally { p.sessions.accept = accept; }
  assert.ok(workId); const before = await p.runtime.state(workId); assert.equal(before.modelCalls.length, 0);
  assert.deepEqual((await f.driver().status(registered.workId)).pending, [{ eventId: 'after-intake', workId: null }]);
  const planning = p.compactPlanning; assert.ok(planning); const call = await planning.requestCompact(workId, { requestId: 'resident-summary-once', force: true, expectedGoalRevision: 1 });
  assert.ok(call); await planning.execute(workId, call.id); assert.equal(await planning.adopt(workId, call.id), true);
  const summary = f.observed.compacts[0]; assert.ok(summary); const publication = await p.sessions.compactPublication(await p.runtime.state(workId), call.id, summary.input); assert.ok(publication);
  const inputCount = f.observed.inputs.first.length, originalReceipt = await p.services.state.receipt(workId, 'conversation.accept'); assert.ok(originalReceipt);
  await f.reopen(); const resumed = await f.driver().tick(registered.workId, { maxSteps: 20 }); assert.equal(resumed.kind, 'event'); if (resumed.kind !== 'event') return;
  assert.equal(resumed.workId, workId); assert.equal(resumed.status, 'completed', JSON.stringify(resumed)); assert.equal(f.observed.inputs.first.length, inputCount + 1);
  const used = f.observed.inputs.first.at(-1)!.packet.session; assert.ok(used?.schemaVersion === 2); assert.deepEqual(used.summary.ref, publication.ref);
  const after = await f.current().runtime.state(workId); assert.deepEqual(after.goal, before.goal); assert.equal(after.budget.used.modelCalls, 2); assert.equal(after.budget.used.tokens, 420);
  assert.deepEqual(await f.current().services.state.receipt(workId, 'conversation.accept'), originalReceipt); assert.deepEqual(after.evidence, []); assert.deepEqual(await f.memory('first'), []);
});

test('resident entry: a question remains explicitly resumable without repeated inference on an empty poll', { timeout: 120000 }, async t => {
  const f = await residentEntryFixture(t); f.pages.first.push([residentEvent('question-event', 'ASK_DATE')]); const registered = await f.register();
  const result = await f.driver().tick(registered.workId, { maxSteps: 20 }); assert.equal(result.kind, 'event'); if (result.kind !== 'event') return;
  const p = f.current(), waiting = await p.runtime.state(result.workId); const question = waiting.obligations.find(value => value.kind === 'response' && value.status === 'pending');
  assert.ok(question); assert.equal(f.observed.inputs.first.length, 1); await f.due(registered.workId);
  assert.equal((await f.driver().tick(registered.workId, { maxSteps: 20 })).kind, 'wait'); assert.equal(f.observed.inputs.first.length, 1);
  await p.turns.followUp(p.actor, { sessionId: registered.sessionId, messageId: 'explicit-answer', workId: result.workId,
    rawText: 'Use 2026-09-08.', expectedGoalRevision: waiting.goal.revision, action: { kind: 'clarify', obligationId: question.id } });
  assert.equal((await p.workflow.run(result.workId, p.executionActor, { maxSteps: 20 })).control.kind, 'complete');
  assert.equal(f.observed.inputs.first.length, 2); assert.ok(f.observed.inputs.first.at(-1)!.packet.session?.entries.some(entry => entry.text.includes('Use 2026-09-08.')));
  f.pages.first.push([residentEvent('next-event', 'NEXT_ORIGINAL')]); await f.due(registered.workId);
  const next = await f.driver().tick(registered.workId, { maxSteps: 20 }); assert.equal(next.kind, 'event'); if (next.kind !== 'event') return;
  assert.notEqual(next.workId, result.workId); assert.equal(next.sessionId, registered.sessionId); assert.equal(next.status, 'completed');
});

test('resident entry: stopping a gated poll preserves its controller and prevents late event intake or inference', { timeout: 120000 }, async t => {
  const f = await residentEntryFixture(t); f.pages.first.push([residentEvent('late-event', 'LATE_ORIGINAL')]); const registered = await f.register(), driver = f.driver();
  let entered!: () => void, release!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  f.controls.beforePoll = async () => { entered(); await gate; }; const running = driver.tick(registered.workId, { maxSteps: 20 }); void running.catch(() => {});
  try {
    await Promise.race([started, running.then(() => assert.fail('tick finished before its poll gate'))]); await driver.stop(registered.workId); release();
    await assert.rejects(running, /resident_mission_changed/); const status = await driver.status(registered.workId);
    assert.equal(status.status, 'closed'); assert.deepEqual(status.events, []); assert.deepEqual(status.pending, []); assert.equal(f.observed.inputs.first.length, 0);
    assert.equal((await driver.tick(registered.workId)).kind, 'closed'); const closing = driver.close();
    assert.throws(() => driver.tick(registered.workId)); await closing;
  } finally { release(); await Promise.allSettled([running]); }
});
