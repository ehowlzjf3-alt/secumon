import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkView, WorkViewResult } from '../domain/work-view.js';
import { BrowserReadQueue, BrowserRequestIdentity, coalescedRefresh, goalDraftFromView, goalDraftIsStale, goalForSubmission, messageKey, nearConversationEnd, needsResultRecheck, newBrowserWork, receiveWorkView, unavailableWork } from '../presentation/web/view-state.js';
import { requestGoalDraft, requestGoalForSubmission } from '../presentation/web/view-state.js';
import type { WebGoalBasis } from '../presentation/web-contracts.js';

function snapshot(options: { workId?: string; revision?: number; goalRevision?: number; level?: WorkView['level']; cursor?: string; result?: boolean } = {}): WorkViewResult & { kind: 'snapshot' } {
  return { kind: 'snapshot', cursor: options.cursor ?? 'opaque-z', view: { schemaVersion: 1, workId: options.workId ?? 'work', revision: options.revision ?? 4,
    goalRevision: options.goalRevision ?? 1, level: options.level ?? 'conversation', title: '합성 업무',
    mode: { requested: 'auto', strategy: 'direct', pending: null, revision: 1 }, reply: { channel: 'web', observingPrimary: true },
    progress: { status: 'ready', reason: '', updatedAt: 1, activeAttempts: 0, activeModels: 0, analysisReady: options.result !== false, resultReady: options.result !== false,
      resultDelivery: options.result === false ? 'unavailable' : 'delivered', pendingQuestions: 0 },
    messages: options.result === false ? [] : [{ id: 'result', kind: 'result', text: '현재 답변', deliveryStatus: 'delivered' }],
  } };
}
test('general goal draft pins the applied input, sends exact raw text and never accepts a changed edit basis', () => {
  const basis: WebGoalBasis = { workId: 'work', description: 'old goal', expectedGoalRevision: 1, expectedControlRevision: 1,
    expectedInput: { messageId: 'initial', sequence: 1, digest: 'a'.repeat(64) }, mode: 'deep' };
  const draft = requestGoalDraft(basis), rawText = '  새 목표\n원문을 그대로 남긴다.  ';
  const command = requestGoalForSubmission(draft, basis, rawText, 'request');
  assert.equal(command.rawText, rawText); assert.equal(command.kind, 'request-goal'); assert.equal(command.mode, 'deep');
  assert.deepEqual(Object.keys(command).sort(), ['kind', 'requestId', 'rawText', 'mode', 'expectedGoalRevision', 'expectedControlRevision', 'expectedInput'].sort());
  assert.equal(goalDraftIsStale(draft, snapshot().view), false);
  for (const changed of [{ ...basis, workId: 'other' }, { ...basis, expectedGoalRevision: 2 }, { ...basis, expectedControlRevision: 2 },
    ...[{ messageId: 'new' }, { sequence: 2 }, { digest: 'b'.repeat(64) }].map(edit => ({ ...basis, expectedInput: { ...basis.expectedInput, ...edit } }))])
    assert.throws(() => requestGoalForSubmission(draft, changed, rawText, 'request'), /stale_session_input/);
  assert.throws(() => requestGoalForSubmission(draft, basis, ' \n ', 'request'), /session_text_required/);
  command.expectedInput.sequence = 99; basis.expectedInput.sequence = 100;
  assert.equal(draft.expectedInput.sequence, 1, 'the draft and submitted payload own separate copies of the edit basis');
});
test('browser view: same-revision source invalidation replaces a result without sorting opaque cursors', () => {
  const first = receiveWorkView(newBrowserWork('work'), snapshot({ cursor: 'opaque-z' }), 0, 'conversation');
  const invalid = receiveWorkView(first, snapshot({ cursor: 'opaque-a', result: false }), first.generation, 'conversation');
  assert.equal(invalid.current?.revision, first.revision); assert.equal(invalid.current?.progress.resultReady, false); assert.deepEqual(invalid.current?.messages, []);
  assert.equal(invalid.cursors.conversation, 'opaque-a');
});
test('browser view: unavailable invalidates pending details and unchanged cannot resurrect revoked content', () => {
  const first = receiveWorkView(newBrowserWork('work'), snapshot(), 0, 'conversation'); const generation = first.generation;
  const denied = unavailableWork(first);
  assert.equal(receiveWorkView(denied, snapshot({ level: 'details' }), generation, 'details'), denied);
  assert.equal(receiveWorkView(denied, { kind: 'unchanged', cursor: 'opaque-z' }, denied.generation, 'conversation'), denied);
  assert.equal(denied.current, null); assert.deepEqual(denied.views, {}); assert.deepEqual(denied.cursors, {});
});
test('browser view: an accepted conversation refresh invalidates an older in-flight detail response', () => {
  const first = receiveWorkView(newBrowserWork('work'), snapshot(), 0, 'conversation'); const pendingGeneration = first.generation;
  const newer = receiveWorkView(first, snapshot({ revision: 5 }), first.generation, 'conversation');
  assert.equal(receiveWorkView(newer, snapshot({ revision: 4, level: 'details' }), pendingGeneration, 'details'), newer);
  assert.equal(receiveWorkView(newer, snapshot({ revision: 5, level: 'details' }), pendingGeneration, 'details'), newer);
});
test('browser view: work identity, level, revision and goal version cannot be mixed or reversed', () => {
  const first = receiveWorkView(newBrowserWork('work'), snapshot({ goalRevision: 2 }), 0, 'conversation');
  for (const value of [snapshot({ workId: 'other', goalRevision: 2 }), snapshot({ level: 'details', goalRevision: 2 }), snapshot({ revision: 3, goalRevision: 2 }), snapshot({ revision: 9, goalRevision: 1 })]) {
    assert.equal(receiveWorkView(first, value, first.generation, 'conversation'), first);
  }
});
test('browser view: repeated message identities update in place while new goal versions have distinct identities', () => {
  const value = snapshot(); value.view.messages.push({ ...value.view.messages[0]!, text: '최신 답변' });
  const first = receiveWorkView(newBrowserWork('work'), value, 0, 'conversation');
  assert.equal(first.current?.messages.length, 1); assert.equal(first.current!.messages[0]!.text, '최신 답변');
  const oldKey = messageKey(first.current!, first.current!.messages[0]!);
  const next = receiveWorkView(first, snapshot({ goalRevision: 2, revision: 5 }), first.generation, 'conversation');
  assert.notEqual(messageKey(next.current!, next.current!.messages[0]!), oldKey);
});
test('browser view: snapshots clone data and invalidate other levels without mutating the previous view', () => {
  const original = snapshot(); const first = receiveWorkView(newBrowserWork('work'), original, 0, 'conversation');
  original.view.messages[0]!.text = 'caller mutation'; assert.equal(first.current!.messages[0]!.text, '현재 답변');
  const next = receiveWorkView(first, snapshot({ level: 'details' }), first.generation, 'details');
  assert.equal(next.views.conversation, undefined); assert.ok(next.views.details); assert.ok(first.views.conversation);
});
test('browser view: state and cursors remain isolated across two selected works', () => {
  const first = receiveWorkView(newBrowserWork('work'), snapshot(), 0, 'conversation');
  const second = receiveWorkView(newBrowserWork('other'), snapshot({ workId: 'other', cursor: 'other-cursor' }), 0, 'conversation');
  assert.equal(receiveWorkView(second, snapshot(), second.generation, 'conversation'), second);
  assert.equal(first.cursors.conversation, 'opaque-z'); assert.equal(second.cursors.conversation, 'other-cursor');
});
test('browser view: history readers are not treated as pinned to the end of a scroll region', () => {
  assert.equal(nearConversationEnd(0, 2000, 500), false); assert.equal(nearConversationEnd(1500, 2000, 500), true);
  assert.equal(nearConversationEnd(1428, 2000, 500), false); assert.equal(nearConversationEnd(1429, 2000, 500), true);
});
test('browser reads: serialization starts the next request only after the prior read completes', async () => {
  const queue = new BrowserReadQueue(); const order: string[] = []; let finish!: () => void;
  const first = queue.enqueue(async () => { order.push('first-start'); await new Promise<void>(resolve => { finish = resolve; }); order.push('first-end'); return 1; }, 0);
  const second = queue.enqueue(async () => { order.push('second'); return 2; }, 0);
  await Promise.resolve(); assert.deepEqual(order, ['first-start']); finish();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]); assert.deepEqual(order, ['first-start', 'first-end', 'second']);
});
test('browser reads: unavailability discards already-queued old reads and a new selection has its own queue epoch', async () => {
  const queue = new BrowserReadQueue(); let finish!: () => void; let startedOldDetails = false;
  const first = queue.enqueue(async () => { await new Promise<void>(resolve => { finish = resolve; }); return 'old-in-flight'; }, 'discarded');
  const details = queue.enqueue(async () => { startedOldDetails = true; return 'old-details'; }, 'discarded');
  await Promise.resolve(); queue.invalidate();
  const current = queue.enqueue(async () => 'new-selection', 'discarded'); assert.equal(await current, 'new-selection');
  finish(); await first; assert.equal(await details, 'discarded'); assert.equal(startedOldDetails, false);
});
test('browser reads: a failed read does not permanently block later explicit reads', async () => {
  const queue = new BrowserReadQueue(); const failed = queue.enqueue(async () => { throw new Error('offline'); }, false);
  const next = queue.enqueue(async () => true, false); await assert.rejects(failed, /offline/); assert.equal(await next, true);
});
test('browser stream: unchanged events make no reads and a burst of changes has at most one follow-up read', async () => {
  let reads = 0; let finish!: () => void;
  const refresh = coalescedRefresh(async () => { reads++; if (reads === 1) await new Promise<void>(resolve => { finish = resolve; }); }, () => true);
  await refresh('unchanged'); assert.equal(reads, 0);
  const first = refresh('view'); const second = refresh('view'); const third = refresh('view'); void refresh('unchanged');
  assert.equal(reads, 1); finish(); await Promise.all([first, second, third]); assert.equal(reads, 2);
});
test('browser stream: an invalidated stream cannot start its queued follow-up refresh', async () => {
  let active = true; let reads = 0; let finish!: () => void;
  const refresh = coalescedRefresh(async () => { reads++; await new Promise<void>(resolve => { finish = resolve; }); }, () => active);
  const pending = refresh('view'); void refresh('view'); active = false; finish(); await pending; await refresh('view'); assert.equal(reads, 1);
});
test('browser stream: delayed change notifications only read the current same-revision source state', async () => {
  let state = receiveWorkView(newBrowserWork('work'), snapshot(), 0, 'conversation');
  const currentSource = snapshot({ result: false, cursor: 'source-revoked' });
  const refresh = coalescedRefresh(async () => { state = receiveWorkView(state, currentSource, state.generation, 'conversation'); }, () => true);
  await refresh('view'); await refresh('view');
  assert.deepEqual(state.current?.messages, []); assert.equal(state.current?.progress.resultReady, false); assert.equal(state.cursors.conversation, 'source-revoked');
});
test('browser acceptance: a lost response keeps the same receipt identity for an explicit retry', () => {
  const identity = new BrowserRequestIdentity(); let created = 0; const next = () => `request-${++created}`; const payload = { scenarioId: 'documents-simple', mode: 'auto', title: '학습 업무' };
  const first = identity.forPayload(payload, next); const retry = identity.forPayload({ ...payload }, next);
  assert.equal(first, retry); assert.equal(created, 1);
  const changed = identity.forPayload({ ...payload, title: '다른 업무' }, next); assert.notEqual(changed, first);
  identity.complete(first); assert.equal(identity.forPayload({ ...payload, title: '다른 업무' }, next), changed);
  identity.complete(changed); assert.notEqual(identity.forPayload({ ...payload, title: '다른 업무' }, next), changed);
});
test('browser acceptance: the same receipt after a lost response produces one work in a receipt-based fake receiver', () => {
  const identity = new BrowserRequestIdentity(); const receipts = new Map<string, string>(); let requests = 0;
  const payload = { scenarioId: 'documents-simple', mode: 'auto' };
  const submit = () => { const requestId = identity.forPayload(payload, () => `receipt-${++requests}`); if (!receipts.has(requestId)) receipts.set(requestId, `work-${receipts.size + 1}`); return receipts.get(requestId); };
  submit(); assert.equal(submit(), 'work-1'); assert.equal(receipts.size, 1); assert.equal(requests, 1);
});
test('browser status: stored completion is distinct from a currently invalidated result', () => {
  const value = snapshot().view; value.progress.status = 'completed'; assert.equal(needsResultRecheck(value), false);
  value.progress.resultReady = false; value.progress.resultDelivery = 'unavailable'; assert.equal(needsResultRecheck(value), true);
  value.progress.status = 'waiting'; assert.equal(needsResultRecheck(value), false);
});
function editableGoalView(): WorkView {
  const view = snapshot({ level: 'details' }).view;
  view.details = { goal: { revision: 1, description: '처음 목표', scope: 'synthetic', mode: 'auto', editable: true,
    criteria: [{ id: 'criterion', description: '자료 확인', key: 'ready', operator: 'present', equals: null, minIndependentSources: 1, requireCompleteCoverage: true }] },
    plan: null, hypotheses: [], evidence: [], omitted: { tasks: 0, hypotheses: 0, evidence: 0 } };
  return view;
}
test('browser goal editing: changing only the description preserves the current fast mode over the original goal mode', () => {
  const view = editableGoalView(); view.mode.requested = 'fast'; view.mode.revision = 2;
  const draft = goalDraftFromView(view)!;
  const goal = goalForSubmission(draft, view, { description: '설명만 수정', criteria: draft.original.criteria });
  assert.equal(view.details!.goal.mode, 'auto'); assert.equal(draft.original.mode, 'fast'); assert.equal(goal.mode, 'fast');
  assert.equal(goal.description, '설명만 수정'); assert.equal(goal.revision, 2); assert.deepEqual(goal.criteria, view.details!.goal.criteria);
});
test('browser goal editing: a pending requested mode is preserved and its control revision is pinned', () => {
  const view = editableGoalView(); view.mode.requested = 'fast'; view.mode.pending = 'deep'; view.mode.revision = 7;
  const draft = goalDraftFromView(view)!;
  assert.equal(draft.original.mode, 'deep'); assert.equal(draft.controlRevision, 7);
  assert.equal(goalForSubmission(draft, view, { description: '유지', criteria: draft.original.criteria }).mode, 'deep');
});
test('browser goal editing: a control, goal or work change rejects submission without changing the input draft', () => {
  const view = editableGoalView(); const draft = goalDraftFromView(view)!; const original = structuredClone(draft);
  for (const latest of [{ ...view, mode: { ...view.mode, revision: 2 } }, { ...view, goalRevision: 2 }, { ...view, workId: 'other' }, null]) {
    assert.equal(goalDraftIsStale(draft, latest), true);
    assert.throws(() => goalForSubmission(draft, latest, { description: '보존할 입력', criteria: draft.original.criteria }), /stale_goal_draft/);
  }
  assert.deepEqual(draft, original);
});
test('browser goal editing: an explicit refreshed basis retains user edits and adopts the latest requested mode', () => {
  const first = editableGoalView(); const draft = goalDraftFromView(first)!;
  const edits = { description: '작성 중인 설명', criteria: [{ ...draft.original.criteria[0]!, minIndependentSources: 2 }] };
  const latest = editableGoalView(); latest.mode.requested = 'deep'; latest.mode.revision = 2;
  const refreshed = goalDraftFromView(latest)!; const submitted = goalForSubmission(refreshed, latest, edits);
  assert.equal(submitted.mode, 'deep'); assert.equal(submitted.description, edits.description); assert.equal(submitted.criteria[0]!.minIndependentSources, 2);
  assert.deepEqual(edits, { description: '작성 중인 설명', criteria: [{ ...draft.original.criteria[0]!, minIndependentSources: 2 }] });
  latest.details!.goal.editable = false; assert.equal(goalDraftFromView(latest), null);
});
