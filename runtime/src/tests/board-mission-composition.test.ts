import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentTurnReplySchema } from '../application/agent-turn-contracts.js';
import { BoardReadPageSchema } from '../application/board-contracts.js';
import { BOARD_READ_TOOL } from '../application/board-tools.js';
import { BOARD_WRITE_TOOLS } from '../application/board-commands.js';
import { acceptEntry, BOARD, runEntry, SOURCE_TOOL, specs, TENANT } from './board-deployment-entry-fixture.js';
import { boardMissionCompositionFixture, COMPOSITION_RULE, SECOND_RULE, compositionCheckpoint, compositionRead } from './board-mission-composition-fixture.js';

test('board-mission composition: actual request and event proofs stay current independently; exact ACK, board read, withdrawal and reopen preserve the other provider', { timeout: 180000 }, async t => {
  const f = boardMissionCompositionFixture(t), a = await f.open(0), b = await f.open(1); await f.setup(a.profile);
  const requestInput = await acceptEntry(a, 'request', 'composed-request', undefined, specs[1].roleId);
  const offered = await runEntry(a, requestInput.workId); assert.equal(offered.result.control.kind, 'wait');
  const board = await f.repository.get(TENANT, BOARD); assert.ok(board); assert.equal(board.requests.length, 1);
  const request = board.requests[0]!; assert.equal(request.status, 'offered'); assert.equal(request.fromWorkId, requestInput.workId);
  const input = await acceptEntry(b, 'accept', 'composed-notifications'), p = b.profile;
  assert.ok(p.boardWatch); assert.ok(p.missions); assert.ok(p.services.notifications);
  const watched = await p.boardWatch.register(input.workId, BOARD), boardSubscription = watched.subscriptions!.find(value => value.provider === 'board')!;
  assert.deepEqual(watched.notifications?.map(value => [value.provider, value.referenceId]), [['board', request.id]]);
  const boardReceipt = await p.services.state.receipt(input.workId, boardSubscription.checkpointId); assert.ok(boardReceipt);
  const changes = await f.repository.changes!(TENANT, BOARD, { afterRevision: 0, maxEvents: 32, maxBytes: 65536 });
  assert.equal(changes.headRevision, board.revision); assert.ok(changes.events.length > 0);
  const event = f.enqueue(), otherEvent = f.enqueue(SECOND_RULE, 'OTHER_UNREAD_MISSION_ORIGINAL');
  await p.missions.register(input.workId, COMPOSITION_RULE); await p.missions.register(input.workId, SECOND_RULE);
  const state = await p.services.notifications.refresh(input.workId), original = await compositionCheckpoint(p, input.workId);
  assert.deepEqual(state.notifications?.map(value => value.provider).sort(), ['board', 'mission', 'mission']);
  assert.equal(await p.missions.current(state), true); assert.equal(await p.boardWatch.current(state), true);
  assert.equal(await p.services.notifications.current(state), true, 'both actual checkpoint families must be current in the same work');
  assert.deepEqual(state.subscriptions?.find(value => value.provider === 'board'), boardSubscription);
  assert.deepEqual(await p.services.state.receipt(input.workId, boardSubscription.checkpointId), boardReceipt);
  const staleCursor = structuredClone(state), staleNotice = structuredClone(state);
  staleCursor.subscriptions!.find(value => value.provider === 'mission')!.cursor++;
  staleNotice.notifications!.find(value => value.provider === 'mission')!.receivedAt++;
  assert.equal(await p.boardWatch.current(staleCursor), false, 'the final snapshot fence still includes the other provider cursor');
  assert.equal(await p.boardWatch.current(staleNotice), false, 'the final snapshot fence still includes the other provider notice');

  const receipt = p.services.state.receipt.bind(p.services.state);
  for (const [commandId, boardValid, missionValid] of [[boardSubscription.checkpointId, false, true], [original.subscription.checkpointId, true, false]] as const) {
    let observed = 0;
    p.services.state.receipt = async (workId, id) => {
      const value = await receipt(workId, id);
      if (workId === input.workId && id === commandId && value) { observed++; return { ...value, digest: '0'.repeat(64) }; }
      return value;
    };
    try {
      assert.equal(await p.boardWatch.current(state), boardValid);
      assert.equal(await p.missions.current(state), missionValid);
      assert.equal(await p.services.notifications.current(state), false); assert.ok(observed > 0);
    } finally { p.services.state.receipt = receipt; }
    assert.deepEqual(await p.runtime.state(input.workId), state, 'a bad proof observation must not rewrite either provider');
  }
  const read = await compositionRead(p, input.workId, 'mission.events', { ruleId: COMPOSITION_RULE.id, maxBytes: 8192 });
  const boardNotices = state.notifications!.filter(value => value.provider === 'board'), other = await compositionCheckpoint(p, input.workId, SECOND_RULE);
  await p.services.notifications.refresh(input.workId); const acknowledged = await compositionCheckpoint(p, input.workId);
  assert.deepEqual(acknowledged.value.acknowledgedRead, { attemptId: read.attempt.id, resultId: read.attempt.resultId });
  assert.deepEqual(acknowledged.value.events, [event]); assert.equal(acknowledged.value.cursor, original.value.cursor);
  assert.deepEqual(acknowledged.state.notifications?.filter(value => value.provider === 'board'), boardNotices);
  assert.deepEqual(acknowledged.state.notifications?.filter(value => value.provider === 'mission').map(value => value.resourceId), [SECOND_RULE.resourceId]);
  assert.deepEqual((await compositionCheckpoint(p, input.workId, SECOND_RULE)).bytes, other.bytes);
  assert.deepEqual(other.value.events, [otherEvent]); assert.equal(other.value.acknowledgedRead, undefined);
  assert.equal(acknowledged.state.obligations.find(value => value.id === 'mission-wait')?.status, 'satisfied');
  assert.equal(await p.services.notifications.current(acknowledged.state), true);

  const observedBoard = await compositionRead(p, input.workId, BOARD_READ_TOOL, { boardId: BOARD, maxPosts: 20, maxBytes: 32768 });
  const page = BoardReadPageSchema.parse(observedBoard.result.output);
  const originalQuestion = board.posts.find(value => value.id === request.questionId); assert.ok(originalQuestion);
  assert.equal(page.posts[0]?.id, request.questionId); assert.equal(page.posts[0]?.body, originalQuestion.body);
  assert.equal(page.posts[0]?.citations[0]?.workId, requestInput.workId);
  assert.equal(await p.contracts.validateResult(await p.runtime.state(input.workId), observedBoard.result), true);
  const beforeWithdraw = await p.runtime.state(input.workId), missionNotices = beforeWithdraw.notifications!.filter(value => value.provider === 'mission');
  const currentBoard = await f.repository.get(TENANT, BOARD); assert.ok(currentBoard);
  await a.profile.board!.changeRequest({ boardId: BOARD, expectedRevision: currentBoard.revision, commandId: 'withdraw-composed-request', requestId: request.id, action: 'cancel' });
  const withdrawn = await p.services.notifications.refresh(input.workId), afterBoard = await f.repository.get(TENANT, BOARD); assert.ok(afterBoard);
  assert.equal(afterBoard.requests[0]!.status, 'cancelled');
  assert.deepEqual(withdrawn.notifications?.filter(value => value.provider === 'board'), []);
  assert.deepEqual(withdrawn.notifications?.filter(value => value.provider === 'mission'), missionNotices);
  assert.equal(withdrawn.subscriptions?.find(value => value.provider === 'board')?.cursor, afterBoard.revision);
  assert.ok(afterBoard.revision > boardSubscription.cursor);
  assert.deepEqual((await compositionCheckpoint(p, input.workId)).bytes, acknowledged.bytes);
  assert.deepEqual((await compositionCheckpoint(p, input.workId, SECOND_RULE)).bytes, other.bytes);
  assert.deepEqual(withdrawn.evidence, []); assert.equal(withdrawn.budget.used.modelCalls, 0); assert.equal(withdrawn.budget.used.toolCalls, 2);
  assert.equal(withdrawn.progress?.policy.maxUnproductiveSteps, 3); assert.equal(b.observed.inputs.length, 0);
  assert.equal(f.observedMissions.polls.filter(value => value.agentId === p.agentId).length, 2);
  const ownerArtifact = offered.state.evidence[0]!.artifact!;
  assert.equal(await p.services.artifacts.exists(ownerArtifact), false); assert.equal(await p.services.state.get(requestInput.workId), null);
  await b.close(); const reopened = await f.open(1), again = await reopened.profile.services.notifications!.refresh(input.workId);
  assert.deepEqual(again, withdrawn); assert.equal(await reopened.profile.services.notifications!.current(again), true);
  assert.deepEqual((await compositionCheckpoint(reopened.profile, input.workId)).bytes, acknowledged.bytes);
  assert.deepEqual(await reopened.profile.services.state.receipt(input.workId, `receive:${read.attempt.id}`), read.received);
  assert.deepEqual(await reopened.profile.services.state.receipt(input.workId, `adopt:${read.attempt.id}`), read.adopted);
  assert.deepEqual(await reopened.profile.services.artifacts.get(read.attempt.resultArtifact!, again.policy), read.bytes);
  assert.deepEqual(await reopened.profile.services.artifacts.get(original.artifact, again.policy), original.bytes);
  assert.deepEqual(await reopened.profile.services.state.receipt(input.workId, original.subscription.checkpointId), original.receipt);
  assert.equal(reopened.observed.inputs.length, 0); assert.equal(reopened.observed.reads.length, 0);
});

test('board-mission composition: one ordinary model work reads its mission and publishes a cited board reply before completion without merging original stores', { timeout: 180000 }, async t => {
  const f = boardMissionCompositionFixture(t, true), a = await f.open(0), b = await f.open(1); await f.setup(a.profile);
  const question = await acceptEntry(a, 'question', 'question-for-mission-work'), first = await runEntry(a, question.workId);
  assert.equal(first.result.control.kind, 'complete');
  const input = await acceptEntry(b, 'optional_reply', 'mission-and-reply'), p = b.profile;
  assert.ok(p.boardWatch); assert.ok(p.missions); assert.ok(p.services.notifications);
  await p.boardWatch.register(input.workId, BOARD); const event = f.enqueue();
  await p.missions.register(input.workId, COMPOSITION_RULE); await p.services.notifications.refresh(input.workId);
  const original = await compositionCheckpoint(p, input.workId);
  assert.deepEqual(original.state.notifications?.map(value => value.provider), ['mission']);
  const effectSummary = (state: typeof original.state) => ({ workId: state.id, revision: state.revision, status: state.status,
    attempts: state.attempts.map(value => ({ id: value.id, toolId: value.toolId, status: value.status,
      provider: value.effectReceipt?.provider ?? null, operationId: value.effectReceipt?.operationId ?? null,
      receiptArtifactId: value.effectReceipt?.artifact.id ?? null })),
    reconciliationIds: state.computerReconciliations?.map(value => value.id) ?? [],
    subscriptionProviders: state.subscriptions?.map(value => value.provider) ?? [],
    notificationProviders: state.notifications?.map(value => value.provider) ?? [] });
  t.diagnostic(`Composition tick entry: ${JSON.stringify(effectSummary(original.state))}`);
  const effects = p.services.effects; assert.ok(effects); const current = effects.current;
  effects.current = async state => {
    try {
      const valid = await current.call(effects, state);
      if (!valid) t.diagnostic(`Composition effect proof rejected: ${JSON.stringify(effectSummary(state))}`);
      return valid;
    } catch (error) {
      t.diagnostic(`Composition effect proof error: ${JSON.stringify({ ...effectSummary(state), code: error instanceof Error ? error.message : 'non_error' })}`);
      throw error;
    }
  };
  let result: Awaited<ReturnType<typeof p.missions.tick>>;
  try { result = await p.missions.tick(input.workId, p.workflow, { maxSteps: 100 }); }
  finally { effects.current = current; }
  const settled = await p.runtime.state(input.workId);
  const modelDecisions = await Promise.all(settled.modelCalls.map(async call => {
    const recorded = { id: call.id, purpose: call.purpose, status: call.status, reason: call.reason, outcome: call.outcome,
      baseStateRevision: call.baseStateRevision, inputArtifactId: call.inputArtifact.id, replyArtifactId: call.replyArtifact?.id ?? null };
    if (!call.replyArtifact || call.purpose !== 'agent_turn') return recorded;
    const bytes = await p.services.artifacts.get(call.replyArtifact, settled.policy);
    const reply = AgentTurnReplySchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (reply.status !== 'ok') return { ...recorded, replyStatus: reply.status, code: reply.code };
    const decision = reply.result;
    return { ...recorded, decision: decision.kind,
      ...(decision.kind === 'plan' ? { tasks: decision.proposal.tasks.map(value => ({ id: value.id, toolId: value.toolId,
        effect: value.effect, dependsOn: value.dependsOn, maxAttempts: value.maxAttempts })) } : {}),
      ...(decision.kind === 'answer' ? { evidenceIds: decision.evidenceIds, verdict: decision.assessment.verdict } : {}) };
  }));
  t.diagnostic(`Composition tick result: ${JSON.stringify({ kind: result.kind,
    control: result.kind === 'ran' ? result.result.control : null, state: effectSummary(settled), statusReason: settled.statusReason,
    progress: settled.progress, budget: settled.budget, attempts: settled.attempts.map(value => ({ id: value.id, taskId: value.taskId,
      toolId: value.toolId, status: value.status, adopted: value.adopted, error: value.error, resultArtifactId: value.resultArtifact?.id ?? null })),
    modelDecisions })}`);
  assert.equal(result.kind, 'ran'); if (result.kind !== 'ran') return;
  assert.equal(result.result.control.kind, 'complete');
  const final = await compositionCheckpoint(p, input.workId), board = await f.repository.get(TENANT, BOARD); assert.ok(board);
  assert.equal(final.state.status, 'completed'); assert.equal(final.value.status, 'closed'); assert.equal(final.value.claim, null);
  assert.deepEqual(final.value.events, [event]); assert.equal(final.value.cursor, original.value.cursor); assert.ok(final.value.acknowledgedRead);
  assert.deepEqual(final.state.notifications, []); assert.equal(final.state.obligations.find(value => value.id === 'mission-wait')?.status, 'satisfied');
  const reply = board.posts.find(value => value.workId === input.workId), source = board.posts.find(value => value.workId === question.workId);
  assert.ok(reply); assert.ok(source); assert.equal(reply.replyTo, source.id); assert.equal(reply.body, specs[1].source);
  assert.equal(reply.citations[0]?.ownerId, specs[1].principalId); assert.equal(reply.citations[0]?.workId, input.workId);
  const tools = final.state.attempts.map(value => value.toolId);
  assert.deepEqual(tools, ['mission.events', 'mission.events', BOARD_READ_TOOL, SOURCE_TOOL, BOARD_WRITE_TOOLS[0]]);
  assert.ok(final.state.attempts.every(value => value.status === 'succeeded' && value.adopted));
  assert.equal(final.state.budget.used.toolCalls, 5); assert.equal(final.state.budget.used.modelCalls, 6);
  assert.equal(final.state.progress?.policy.maxUnproductiveSteps, 3); assert.equal(b.observed.reads.length, 1);
  assert.ok(b.observed.inputs.some(value => JSON.stringify(value.packet.toolObservations).includes('COMPOSED_MISSION_ORIGINAL')));
  assert.ok(b.observed.inputs.some(value => JSON.stringify(value.packet.toolObservations).includes(specs[0].source)));
  assert.equal(final.state.evidence.length, 1); assert.equal(final.state.evidence[0]!.sourceId, SOURCE_TOOL);
  assert.equal(final.state.evidence[0]!.facts.summary, specs[1].source);
  assert.equal(await p.services.state.get(question.workId), null); assert.equal(await p.services.artifacts.exists(first.state.evidence[0]!.artifact!), false);
  const memory = await p.personalKnowledge(p.actor);
  assert.deepEqual((await memory.search({ namespace: 'personal', scope: 'personal', text: '', kinds: ['personal'], limit: 20 })).cards, []);
  const deliveries = await p.services.state.deliveries(input.workId);
  assert.ok(deliveries.some(value => value.kind === 'result' && value.status === 'delivered'));
  assert.equal(await p.services.notifications.current(final.state), true);
  await b.close(); const reopened = await f.open(1), after = await compositionCheckpoint(reopened.profile, input.workId);
  assert.deepEqual(after.bytes, final.bytes); assert.deepEqual(after.receipt, final.receipt);
  assert.equal((await reopened.profile.missions!.tick(input.workId, reopened.profile.workflow)).kind, 'idle');
  assert.deepEqual(await reopened.profile.runtime.state(input.workId), final.state);
  assert.deepEqual(await f.repository.get(TENANT, BOARD), board);
  assert.equal(reopened.observed.inputs.length, 0); assert.equal(reopened.observed.reads.length, 0);
  assert.equal(f.observedMissions.polls.filter(value => value.agentId === p.agentId).length, 1);
  assert.deepEqual(await reopened.profile.services.artifacts.get(original.artifact, after.state.policy), original.bytes);
});
