import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_REQUEST_TOOLS, BOARD_WRITE_TOOLS } from '../application/board-commands.js';
import { BOARD_REQUEST_READ_TOOL } from '../application/board-request-tools.js';
import { buildModelContextPacket } from '../application/context-packet.js';
import { completionProofsCurrent } from '../application/completion-proofs.js';
import { BoardService } from '../application/board-service.js';
import { PlanningRuntime } from '../application/planning-runtime.js';
import { ScriptedPlanner } from '../infrastructure/fakes.js';
import { decide } from '../domain/control.js';
import { boardRequestFixture as fixture } from './helpers/board-request-fixture.js';

for (const adapter of ['sqlite', 'file-journal'] as const) {
  for (const family of ['documents', 'observations']) test(`${adapter}/${family}: discover and finish a request using observed IDs and revisions, then retain history across compact and reopen`, async t => {
    const h = await fixture(t, adapter, family);
    await h.bundle('a').boardWatch!.register('work-a', 'board'); await h.bundle('b').boardWatch!.register('work-b', 'board');
    const empty = await h.readRequests('a'); assert.deepEqual(empty.page.requests, []);
    await h.execute('a', BOARD_WRITE_TOOLS[0], { boardId: 'board', expectedRevision: empty.page.revision, id: 'question', entityId: 'entity',
      kind: 'question', body: 'Please examine the evidence', labels: [], evidenceIds: [], quotedPostIds: [], replyTo: null, relation: null, causeId: 'question', expiresAt: null });
    const beforeOffer = await h.readRequests('a');
    await h.execute('a', BOARD_REQUEST_TOOLS[0], { boardId: 'board', expectedRevision: beforeOffer.page.revision, id: 'request', questionId: 'question',
      toAgentId: 'role-b', deliverable: 'Cited answer', dueAt: 50000 });
    const notified = await h.bundle('b').boardWatch!.refresh('work-b');
    assert.equal(notified.notifications?.length, 1); assert.equal(notified.status, 'ready');
    assert.ok((await h.state.runnable(h.clock.now())).includes('work-b'));
    const discovered = await h.readRequests('b', notified.notifications![0]!.referenceId), request = discovered.page.requests[0]!;
    assert.equal(request.questionId, 'question'); assert.equal(request.effectiveStatus, 'offered');
    assert.doesNotMatch(JSON.stringify(discovered.page), /Please examine|Cited answer|original-documents|original-observations/);
    await h.read('b');
    await h.execute('b', BOARD_REQUEST_TOOLS[1], { boardId: discovered.page.boardId, expectedRevision: discovered.page.revision, requestId: request.id });
    assert.deepEqual((await h.refresh('b')).notifications, []);
    const accepted = await h.readRequests('b', request.id);
    await h.execute('b', BOARD_WRITE_TOOLS[0], { boardId: accepted.page.boardId, expectedRevision: accepted.page.revision, id: 'answer', entityId: 'entity',
      kind: 'observation', body: 'Evidence-backed answer', labels: [], evidenceIds: ['e1'], quotedPostIds: [], replyTo: request.questionId,
      relation: 'clarifies', causeId: 'answer', expiresAt: null });
    const beforeAnswer = await h.readRequests('b', request.id);
    await h.execute('b', BOARD_REQUEST_TOOLS[2], { boardId: beforeAnswer.page.boardId, expectedRevision: beforeAnswer.page.revision, requestId: request.id, postId: 'answer' });
    const answered = await h.readRequests('a', request.id); assert.equal(answered.page.requests[0]!.answerPostId, 'answer');
    await h.read('a');
    await h.execute('a', BOARD_REQUEST_TOOLS[3], { boardId: answered.page.boardId, expectedRevision: answered.page.revision, requestId: answered.page.requests[0]!.id });
    const a = await h.refresh('a'), b = await h.refresh('b');
    assert.equal(a.obligations.find(value => value.source)?.status, 'satisfied'); assert.equal(b.obligations.find(value => value.source)?.status, 'satisfied');
    assert.equal(a.evidence.length + b.evidence.length, 2); assert.equal(a.budget.used.modelCalls + b.budget.used.modelCalls, 0);
    assert.equal(a.budget.used.toolCalls + b.budget.used.toolCalls, 14);
    const tool = h.bundle('b').services.tools.find(value => value.definition.id === BOARD_REQUEST_READ_TOOL)!;
    assert.equal(await tool.validateResult!(b, discovered.result!), true, 'ordinary lifecycle changes preserve the original observation');
    assert.equal(discovered.page.requests[0]!.status, 'offered');
    const frame = await h.bundle('b').context.prepare(b, { callId: 'compact-discovery', maxInputBytes: 500000, maxInputTokens: 600000, maxOutputTokens: 1000, forceCompact: true });
    assert.deepEqual(frame.packet.notifications, []);
    await h.reopen(); const restored = await h.bundle('b').recovery.restore('work-b', h.actors['b']!);
    assert.deepEqual(restored.packet.runtime.subscriptions, b.subscriptions);
    assert.equal((await h.refresh('b')).revision, b.revision);
  });

  test(`${adapter}: duplicate wake is a no-op with zero model, tool and chat delivery activity`, async t => {
    const h = await fixture(t, adapter); await h.bundle('b').boardWatch!.register('work-b', 'board'); await h.offer();
    const first = await h.bundle('b').boardWatch!.refresh('work-b');
    for (let index = 0; index < 3; index++) assert.deepEqual(await h.bundle('b').boardWatch!.refresh('work-b'), first);
    assert.equal(first.notifications?.length, 1); assert.equal(first.budget.used.modelCalls, 0); assert.equal(first.budget.used.toolCalls, 0);
    assert.deepEqual(await h.state.deliveries('work-b'), []);
    assert.deepEqual((await h.bundle('b').conversation.snapshot('work-b', h.actors['b']!)).pendingQuestions, []);
    await h.reopen(); assert.deepEqual(await h.bundle('b').boardWatch!.refresh('work-b'), first);
  });

  test(`${adapter}: an unprocessed event rejects stale context and a pending offer blocks completion even after metadata is read`, async t => {
    const h = await fixture(t, adapter); await h.bundle('b').boardWatch!.register('work-b', 'board');
    const prior = (await h.state.get('work-b'))!; await h.offer();
    assert.equal(await completionProofsCurrent(h.bundle('b').services, prior), false);
    await assert.rejects(buildModelContextPacket(prior, h.bundle('b').contracts, h.bundle('b').services));
    const current = await h.bundle('b').boardWatch!.refresh('work-b');
    assert.equal(decide(current, h.clock.now()).reason, 'external_notification_requires_review');
    const observed = await h.readRequests('b');
    await h.edit('b', state => { state.evidence[0]!.facts['available'] = true; });
    assert.notEqual((await h.bundle('b').runtime.step('work-b')).kind, 'complete');
    assert.equal((await h.bundle('b').conversation.snapshot('work-b', h.actors['b']!)).analysisReady, false);
    assert.equal((await h.state.get('work-b'))!.notifications?.length, 1);
    await h.execute('b', BOARD_REQUEST_TOOLS[4], { boardId: 'board', expectedRevision: observed.page.revision, requestId: observed.page.requests[0]!.id });
    assert.deepEqual((await h.refresh('b')).notifications, []);
    assert.equal((await h.bundle('b').runtime.step('work-b')).kind, 'complete');
    assert.equal((await h.state.get('work-b'))!.subscriptions![0]!.status, 'closed');
  });

  test(`${adapter}: a missed wake and a lost checkpoint reply resume with one durable notification`, async t => {
    const h = await fixture(t, adapter); await h.bundle('b').boardWatch!.register('work-b', 'board'); await h.offer();
    await h.reopen();
    const commit = h.state.commit.bind(h.state); let lost = false;
    h.state.commit = async request => {
      const result = await commit(request);
      if (!lost && request.commandId.startsWith('watch-poll:') && result.kind === 'committed') { lost = true; throw new Error('synthetic_lost_checkpoint_reply'); }
      return result;
    };
    await assert.rejects(h.bundle('b').boardWatch!.refresh('work-b'), /synthetic_lost_checkpoint_reply/); assert.equal(lost, true);
    const stored = (await h.state.get('work-b'))!; assert.equal(stored.notifications?.length, 1);
    await h.reopen(); const resumed = await h.bundle('b').boardWatch!.refresh('work-b');
    assert.deepEqual(resumed.notifications, stored.notifications); assert.equal(resumed.revision, stored.revision);
    assert.equal(resumed.subscriptions![0]!.cursor, (await h.repository.get('tenant-a', 'board'))!.revision);
    assert.equal(resumed.budget.used.toolCalls + resumed.budget.used.modelCalls, 0);
  });

  test(`${adapter}: notifications and cursor require their original checkpoint and survive compact without omissions`, async t => {
    const h = await fixture(t, adapter); await h.bundle('b').boardWatch!.register('work-b', 'board'); await h.offer();
    const current = await h.bundle('b').boardWatch!.refresh('work-b');
    const frame = await h.bundle('b').context.prepare(current, { callId: 'notice-compact', maxInputBytes: 500000, maxInputTokens: 600000, maxOutputTokens: 1000, forceCompact: true });
    assert.deepEqual(frame.packet.notifications, current.notifications);
    const omitted = structuredClone(frame.packet); omitted.notifications = [];
    assert.equal(await h.bundle('b').context.sourcesCurrent(omitted, current), false);
    const { notifications: _notifications, ...missingReader } = h.bundle('b').services;
    assert.equal(await completionProofsCurrent(missingReader, current), false);
    const receipt = h.state.receipt.bind(h.state);
    h.state.receipt = (workId, commandId) => commandId === current.subscriptions![0]!.checkpointId ? Promise.resolve(null) : receipt(workId, commandId);
    assert.equal(await h.bundle('b').boardWatch!.current(current), false);
    await assert.rejects(h.bundle('b').boardWatch!.refresh('work-b'), /board_watch_unavailable/); h.state.receipt = receipt;
    const forged = structuredClone(current); forged.notifications![0]!.referenceId = 'forged';
    assert.equal(await h.bundle('b').boardWatch!.current(forged), false);
    await h.reopen(); const restored = await h.bundle('b').recovery.restore('work-b', h.actors['b']!);
    assert.deepEqual(restored.packet.context.notifications, current.notifications);
  });

  test(`${adapter}: request metadata cannot be forged and current authority is rechecked after artifact reads`, async t => {
    const h = await fixture(t, adapter); await h.offer(); const observed = await h.readRequests('b');
    const tool = h.bundle('b').services.tools.find(value => value.definition.id === BOARD_REQUEST_READ_TOOL)!, state = (await h.state.get('work-b'))!;
    const altered = structuredClone(observed.result!); altered.output = { injected: 'satisfied' };
    assert.equal(await tool.validateResult!(state, altered), false);
    const receipt = h.state.receipt.bind(h.state);
    h.state.receipt = (workId, id) => id === `board-observe:${observed.attempt.id}` ? Promise.resolve(null) : receipt(workId, id);
    assert.equal(await tool.validateResult!(state, observed.result!), false); h.state.receipt = receipt;
    const get = h.artifacts.get.bind(h.artifacts);
    h.artifacts.get = async (ref, policy) => { const bytes = await get(ref, policy); if (ref.id === observed.result!.artifacts[0]!.id) h.actors['b']!.allowedNamespaces = []; return bytes; };
    assert.equal(await tool.validateResult!(state, observed.result!), false);
    await assert.rejects(h.bundle('b').boardWatch!.register('work-b', 'board'));
  });

  test(`${adapter}: another owner cannot register or close a subscription; revoked access prevents wake`, async t => {
    const h = await fixture(t, adapter); await assert.rejects(h.bundle('a').boardWatch!.register('work-b', 'board'));
    await h.bundle('b').boardWatch!.register('work-b', 'board'); await h.offer();
    const current = (await h.state.get('work-b'))!;
    await assert.rejects(h.bundle('a').boardWatch!.close('work-b', current.subscriptions![0]!.id));
    h.actors['b']!.allowedNamespaces = [];
    assert.equal(await h.bundle('b').boardWatch!.current(current), false);
    await assert.rejects(h.bundle('b').boardWatch!.refresh('work-b'));
    assert.deepEqual((await h.state.get('work-b'))!.notifications, []);
    const closed = await h.bundle('b').boardWatch!.close('work-b', current.subscriptions![0]!.id);
    assert.equal(closed.subscriptions![0]!.status, 'closed');
  });

  test(`${adapter}: expiry before a poll creates no actionable offer and unchanged waiting does not call a model`, async t => {
    const h = await fixture(t, adapter); await h.bundle('b').boardWatch!.register('work-b', 'board'); await h.offer(); h.clock.advance(50000);
    const current = await h.bundle('b').boardWatch!.refresh('work-b'); assert.deepEqual(current.notifications, []);
    assert.equal(current.budget.used.modelCalls + current.budget.used.toolCalls, 0);
    const observed = await h.readRequests('a'); assert.equal(observed.page.requests[0]!.effectiveStatus, 'expired');
    await h.execute('a', BOARD_REQUEST_TOOLS[5], { boardId: 'board', expectedRevision: observed.page.revision, requestId: observed.page.requests[0]!.id });
    assert.deepEqual((await h.bundle('b').boardWatch!.refresh('work-b')).notifications, []);
  });

  test(`${adapter}: pause preserves the cursor, resume reads missed events, and cancellation closes the inbox`, async t => {
    const h = await fixture(t, adapter); const registered = await h.bundle('b').boardWatch!.register('work-b', 'board');
    await h.bundle('b').runtime.command('work-b', 'pause', h.actors['b']!, 1, { kind: 'pause', reason: 'Synthetic pause' }); await h.offer();
    const paused = await h.bundle('b').boardWatch!.refresh('work-b');
    assert.equal(paused.subscriptions![0]!.cursor, registered.subscriptions![0]!.cursor); assert.deepEqual(paused.notifications, []);
    assert.equal(await h.bundle('b').boardWatch!.current(paused), true);
    await h.bundle('b').runtime.command('work-b', 'resume', h.actors['b']!, 1, { kind: 'resume', reason: 'Synthetic resume' });
    const resumed = await h.bundle('b').boardWatch!.refresh('work-b'); assert.equal(resumed.notifications?.length, 1);
    await h.bundle('b').runtime.command('work-b', 'cancel', h.actors['b']!, 1, { kind: 'cancel', reason: 'Synthetic cancellation' });
    const cancelled = await h.bundle('b').boardWatch!.refresh('work-b');
    assert.deepEqual(cancelled.notifications, []); assert.equal(cancelled.subscriptions![0]!.status, 'closed'); assert.equal(cancelled.status, 'cancelled');
  });

  test(`${adapter}: metadata pagination is bounded and rejects stale cursors and caller-selected ownership`, async t => {
    const h = await fixture(t, adapter); await h.offer();
    for (const id of ['request-2', 'request-3']) await h.bundle('a').board!.offer({ ...await h.mutation(), commandId: `offer-${id}`,
      id, questionId: 'question', toAgentId: 'role-b', deliverable: 'Private deliverable', dueAt: 50000 });
    const query = { boardId: 'board', workId: 'work-b', maxRequests: 1, maxBytes: 1024 };
    const first = await h.bundle('b').board!.requestPage(query); assert.equal(first.requests.length, 1); assert.ok(first.nextCursor);
    assert.ok(new TextEncoder().encode(JSON.stringify(first)).byteLength <= 1024);
    const second = await h.bundle('b').board!.requestPage({ ...query, cursor: first.nextCursor! }); assert.equal(second.requests[0]!.id, 'request-2');
    await h.bundle('a').board!.changeRequest({ ...await h.mutation(), commandId: 'cancel-second', action: 'cancel', requestId: 'request-2' });
    await assert.rejects(h.bundle('b').board!.requestPage({ ...query, cursor: first.nextCursor! }), /board_request_cursor_stale/);
    await assert.rejects(h.prepare('b', BOARD_REQUEST_READ_TOOL, { boardId: 'board', workId: 'work-a', maxRequests: 1, maxBytes: 1024 }));
    const empty = await h.bundle('b').board!.requestPage({ ...query, requestId: 'absent' }); assert.deepEqual(empty.requests, []);
  });

  test(`${adapter}: goal revision closes its old inbox and a new host subscription rescans current offers`, async t => {
    const h = await fixture(t, adapter); await h.bundle('b').boardWatch!.register('work-b', 'board'); await h.offer();
    const current = await h.bundle('b').boardWatch!.refresh('work-b');
    const changed = await h.bundle('b').runtime.command('work-b', 'new-goal', h.actors['b']!, 1, { kind: 'goal',
      goal: { ...current.goal, revision: 2 }, expectedControlRevision: current.executionControl!.revision });
    assert.deepEqual(changed.notifications, []); assert.equal(changed.subscriptions![0]!.status, 'closed');
    const registered = await h.bundle('b').boardWatch!.register('work-b', 'board');
    assert.equal(registered.subscriptions!.filter(value => value.status === 'active').length, 1);
    assert.equal(registered.notifications?.length, 1); assert.equal(registered.notifications![0]!.goalRevision, 2);
    assert.notEqual(registered.notifications![0]!.id, current.notifications![0]!.id);
  });

  test(`${adapter}: completed work closes its subscription and a later offer does not reopen it`, async t => {
    const h = await fixture(t, adapter); await h.bundle('b').boardWatch!.register('work-b', 'board');
    await h.edit('b', state => { state.evidence[0]!.facts['available'] = true; });
    assert.equal((await h.bundle('b').runtime.step('work-b')).kind, 'complete'); const completed = (await h.state.get('work-b'))!;
    await h.offer(); const current = await h.bundle('b').boardWatch!.refresh('work-b');
    assert.equal(current.status, 'completed'); assert.equal(current.revision, completed.revision); assert.deepEqual(current.notifications, []);
  });

  test(`${adapter}: a data access change closes old generation subscriptions and removes their context references`, async t => {
    const h = await fixture(t, adapter); await h.bundle('b').boardWatch!.register('work-b', 'board'); await h.offer();
    assert.equal((await h.bundle('b').boardWatch!.refresh('work-b')).notifications?.length, 1);
    await h.bundle('b').dataLifecycle.change('work-b', { ...h.actors['b']!, allowWrites: true }, 'restrict-data',
      { action: 'restrict', evidenceIds: ['e1'], expectedGeneration: 0, reason: 'Synthetic access withdrawal', replacement: null });
    const current = (await h.state.get('work-b'))!;
    assert.equal(current.dataLifecycle!.generation, 1); assert.deepEqual(current.notifications, []);
    assert.equal(current.subscriptions![0]!.status, 'closed'); assert.equal(current.status, 'blocked');
    assert.equal((await h.bundle('b').boardWatch!.refresh('work-b')).revision, current.revision);
  });

  test(`${adapter}: repeated metadata observations do not manufacture progress or independent evidence`, async t => {
    const h = await fixture(t, adapter); await h.offer(); const first = await h.readRequests('b'), second = await h.readRequests('b');
    assert.equal(second.state.progress!.productiveSteps, first.state.progress!.productiveSteps);
    assert.equal(second.state.progress!.unproductiveSteps, first.state.progress!.unproductiveSteps + 1);
    assert.equal(second.state.evidence.length, 1); assert.notEqual(second.result!.artifacts[0]!.id, first.result!.artifacts[0]!.id);
    assert.deepEqual(second.page.requests, first.page.requests);
  });

  test(`${adapter}: authority withdrawn during the final metadata check prevents cursor advancement`, async t => {
    const h = await fixture(t, adapter); await h.bundle('b').boardWatch!.register('work-b', 'board'); await h.offer();
    const prior = (await h.state.get('work-b'))!, original = BoardService.prototype.requestMetadataPermitted; let revoked = false;
    BoardService.prototype.requestMetadataPermitted = async function (boardId, workId, requestIds) {
      const permitted = await original.call(this, boardId, workId, requestIds);
      if (workId === 'work-b' && requestIds.includes('request')) { revoked = true; h.actors['b']!.allowedNamespaces = []; }
      return permitted;
    };
    t.after(() => { BoardService.prototype.requestMetadataPermitted = original; });
    await assert.rejects(h.bundle('b').boardWatch!.refresh('work-b')); assert.equal(revoked, true);
    const current = (await h.state.get('work-b'))!;
    assert.deepEqual(current.subscriptions, prior.subscriptions); assert.deepEqual(current.notifications, []);
  });

  test(`${adapter}: a refresh that exceeds its time budget leaves the cursor and inbox uncommitted`, async t => {
    const h = await fixture(t, adapter); await h.bundle('b').boardWatch!.register('work-b', 'board'); await h.offer();
    const prior = (await h.state.get('work-b'))!, changes = h.repository.changes!.bind(h.repository);
    h.repository.changes = async (...args) => { const page = await changes(...args); h.clock.advance(10001); return page; };
    await assert.rejects(h.bundle('b').boardWatch!.refresh('work-b'), /board_watch_deadline/);
    const current = (await h.state.get('work-b'))!;
    assert.deepEqual(current.subscriptions, prior.subscriptions); assert.deepEqual(current.notifications, []);
  });

  test(`${adapter}: an incoming offer invalidates a reserved model context before any model invocation`, async t => {
    const h = await fixture(t, adapter); await h.bundle('b').boardWatch!.register('work-b', 'board');
    await h.edit('b', state => { state.budget.limits.tokens = 100000; });
    const bundle = h.bundle('b'), planning = new PlanningRuntime(bundle.services, bundle.contracts, bundle.runtime, 'model-b', { maxInputBytes: 500000, maxOutputTokens: 128 }, bundle.context);
    const call = await planning.reserve('work-b'); await h.offer();
    await assert.rejects(planning.dispatch('work-b', call.id), /model_not_dispatchable/);
    const current = (await h.state.get('work-b'))!; assert.equal(current.notifications?.length, 1);
    assert.equal(current.budget.used.modelCalls, 0); assert.deepEqual((bundle.services.planner as ScriptedPlanner).inputs, []);
  });

  test(`${adapter}: an active nonparticipant role sees no request metadata and receives no offer notification`, async t => {
    const h = await fixture(t, adapter), board = h.bundle('a').board!;
    await board.create({ id: 'other-board', commandId: 'create-other', namespace: 'team', scope: 'fixture', labels: ['synthetic'],
      roles: [{ id: 'requester', principalId: 'person-a', purpose: 'Request', active: true },
        { id: 'recipient', principalId: 'person-other', purpose: 'Receive', active: true }, { id: 'observer', principalId: 'person-b', purpose: 'Unrelated', active: true }],
      limits: { maxPosts: 5, maxReplies: 2, maxUnproductiveReplies: 2, maxRequests: 5 } });
    await board.addEntity({ boardId: 'other-board', commandId: 'other-entity', expectedRevision: 1,
      entity: { id: 'entity', authority: 'fixture', key: 'other', kind: 'documents', title: 'Other', validFrom: 0, validThrough: null } });
    await board.publish({ boardId: 'other-board', commandId: 'other-question', expectedRevision: 2, id: 'private-question', workId: 'work-a',
      entityId: 'entity', kind: 'question', body: 'A private request', labels: [], sources: [], quotedPostIds: [], replyTo: null, relation: null, causeId: 'private', expiresAt: null });
    await board.offer({ boardId: 'other-board', commandId: 'other-offer', expectedRevision: 3, id: 'private-request', questionId: 'private-question',
      toAgentId: 'recipient', deliverable: 'Private content', dueAt: 50000 });
    const page = await h.bundle('b').board!.requestPage({ boardId: 'other-board', workId: 'work-b', maxRequests: 20, maxBytes: 32768 });
    assert.equal(page.roleId, 'observer'); assert.deepEqual(page.requests, []);
    assert.deepEqual((await h.bundle('b').boardWatch!.register('work-b', 'other-board')).notifications, []);
  });
}
