import test from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { BOARD_REQUEST_TOOLS, BOARD_WRITE_TOOLS } from '../application/board-commands.js';
import { BoardReadPageSchema } from '../application/board-contracts.js';
import { ToolResultSchema } from '../application/contracts.js';
import { BOARD_READ_TOOL } from '../application/board-tools.js';
import type { AgentTurnProfile } from '../presentation/agent-turn-profile.js';
import type { WorkState } from '../domain/model.js';
import { acceptEntry, boardDeploymentFixture, BOARD, runEntry, SOURCE_TOOL, specs, TENANT } from './board-deployment-entry-fixture.js';

const requests = (state: WorkState) => state.obligations.filter(value => value.source?.provider === 'board');
function complete(value: Awaited<ReturnType<typeof runEntry>>) {
  assert.equal(value.result.control.kind, 'complete'); assert.equal(value.state.status, 'completed');
  assert.ok(value.state.attempts.every(attempt => attempt.status === 'succeeded' && attempt.adopted));
  assert.ok(value.deliveries.some(delivery => delivery.kind === 'result' && delivery.status === 'delivered'));
}
async function noAutomaticMemory(profile: AgentTurnProfile) {
  const memory = await profile.personalKnowledge(profile.actor);
  const result = await memory.search({ namespace: 'personal', scope: 'personal', kinds: ['personal'], text: '', limit: 20 });
  assert.equal(result.index.status, 'ready'); assert.equal(result.index.complete, true);
  assert.deepEqual(result.cards, []);
}
async function isolated(a: AgentTurnProfile, b: AgentTurnProfile, first: WorkState, second: WorkState) {
  assert.notEqual(a.agentId, b.agentId); assert.notEqual(a.scope, b.scope);
  assert.equal(a.stateBackend, 'sqlite'); assert.equal(b.stateBackend, 'sqlite');
  assert.notEqual(first.id, second.id); assert.notEqual(first.conversation!.session!.scope.sessionId, second.conversation!.session!.scope.sessionId);
  assert.equal(await a.services.state.get(second.id), null); assert.equal(await b.services.state.get(first.id), null);
  await assert.rejects(a.conversation.snapshot(second.id, a.actor), /work_unavailable/);
  await assert.rejects(b.conversation.snapshot(first.id, b.actor), /work_unavailable/);
  for (const [profile, other, state, spec] of [[a, b, first, specs[0]], [b, a, second, specs[1]]] as const) {
    assert.equal(state.evidence.length, 1); const original = state.evidence[0]!;
    assert.equal(original.sourceId, SOURCE_TOOL); assert.equal(original.scope, profile.scope); assert.deepEqual(original.derivedFrom, []);
    assert.equal(original.facts.summary, spec.source); assert.ok(original.artifact);
    assert.equal(new TextDecoder().decode(await profile.services.artifacts.get(original.artifact, profile.policy)), spec.source);
    assert.equal(await other.services.artifacts.exists(original.artifact), false, 'a shared board does not copy original artifacts into the other store');
    await noAutomaticMemory(profile);
    assert.equal(profile.archive, null); assert.equal(profile.missions, null); assert.equal(profile.a2a, null);
    const history = await profile.sessions.history(profile.actor, state.conversation!.session!.scope.sessionId, profile.policy, { limit: 50 });
    assert.ok(history.entries.length > 0); assert.ok(history.entries.every(entry => entry.workId === state.id));
  }
}

test('two independent SQLite deployments use the ordinary model/tool loop for a question and an optional cited reply without creating response duties or copying memory', async t => {
  const f = boardDeploymentFixture(t), a = await f.open(0), b = await f.open(1); await f.setup(a.profile);
  for (const field of ['state', 'memory'] as const) {
    const first = statSync(f.ready[0]!.paths[field]), second = statSync(f.ready[1]!.paths[field]);
    assert.notDeepEqual([first.dev, first.ino], [second.dev, second.ino], `${field} must be physically independent`);
  }
  const question = await acceptEntry(a, 'question', 'same-input'); const first = await runEntry(a, question.workId); complete(first);
  const beforeReply = await f.repository.get(TENANT, BOARD); assert.ok(beforeReply);
  assert.equal(beforeReply.posts.length, 1); assert.equal(beforeReply.posts[0]!.kind, 'question'); assert.deepEqual(beforeReply.requests, []);
  assert.deepEqual(requests(first.state), []); assert.equal(b.observed.inputs.length, 0); assert.equal(b.observed.reads.length, 0);
  const reply = await acceptEntry(b, 'optional_reply', 'same-input'); const second = await runEntry(b, reply.workId); complete(second);
  const board = await f.repository.get(TENANT, BOARD); assert.ok(board); assert.equal(board.posts.length, 2); assert.deepEqual(board.requests, []);
  const questionPost = board.posts.find(post => post.workId === question.workId)!, replyPost = board.posts.find(post => post.workId === reply.workId)!;
  assert.equal(questionPost.authorId, specs[0].roleId); assert.equal(replyPost.authorId, specs[1].roleId);
  assert.equal(replyPost.replyTo, questionPost.id); assert.equal(replyPost.relation, 'clarifies'); assert.equal(replyPost.body, specs[1].source);
  assert.deepEqual(replyPost.citations.map(citation => [citation.workId, citation.ownerId, citation.evidenceId]),
    [[reply.workId, specs[1].principalId, second.state.evidence[0]!.id]]);
  assert.deepEqual(requests(second.state), []); await isolated(a.profile, b.profile, first.state, second.state);
  const read = b.observed.inputs.flatMap(input => input.packet.toolObservations ?? []).find(value => value.toolId === BOARD_READ_TOOL)!;
  const page = BoardReadPageSchema.parse(read.output); assert.equal(page.interpretation, 'discussion_not_independent_evidence');
  assert.equal(page.posts[0]!.id, questionPost.id); assert.equal(page.posts[0]!.citations[0]!.workId, question.workId);
  assert.equal(second.state.evidence.some(value => value.id === first.state.evidence[0]!.id), false);
  assert.ok(b.observed.inputs.some(input => JSON.stringify(input.packet.toolObservations).includes(specs[0].source)), 'the permitted discussion really crossed the registered source boundary');
  assert.equal(a.observed.reads.length, 1); assert.equal(b.observed.reads.length, 1);

  await a.close(); await b.close(); const reopenedA = await f.open(0), reopenedB = await f.open(1);
  const againA = await acceptEntry(reopenedA, 'question', 'same-input', question.sessionId);
  const againB = await acceptEntry(reopenedB, 'optional_reply', 'same-input', reply.sessionId);
  assert.equal(againA.accepted, false); assert.equal(againB.accepted, false);
  assert.equal(againA.workId, question.workId); assert.equal(againB.workId, reply.workId);
  complete(await runEntry(reopenedA, question.workId)); complete(await runEntry(reopenedB, reply.workId));
  assert.equal(reopenedA.observed.inputs.length + reopenedB.observed.inputs.length, 0);
  assert.equal(reopenedA.observed.reads.length + reopenedB.observed.reads.length, 0);
  assert.deepEqual(await f.repository.get(TENANT, BOARD), board);
  assert.deepEqual((await reopenedA.profile.runtime.state(question.workId)).attempts, first.state.attempts);
  assert.deepEqual((await reopenedB.profile.runtime.state(reply.workId)).attempts, second.state.attempts);
});

test('reversed requester and responder roles accept and answer a request through independent profiles, wait without model work, and complete only after requester confirmation', async t => {
  const f = boardDeploymentFixture(t), a = await f.open(0), b = await f.open(1); await f.setup(a.profile);
  // Board administration gives no permanent lead/worker assignment: B requests A here.
  const intakeB = await acceptEntry(b, 'request', 'explicit-request', undefined, specs[0].roleId);
  const offered = await runEntry(b, intakeB.workId); assert.equal(offered.result.control.kind, 'wait');
  assert.equal(offered.state.status, 'waiting'); assert.equal(requests(offered.state)[0]!.mode, 'waiting');
  assert.equal(requests(offered.state)[0]!.status, 'pending'); assert.equal(a.observed.reads.length, 0);
  let board = await f.repository.get(TENANT, BOARD); assert.ok(board); assert.equal(board.requests.length, 1);
  const requestId = board.requests[0]!.id; assert.equal(board.requests[0]!.status, 'offered');
  assert.equal(board.requests[0]!.fromAgentId, specs[1].roleId); assert.equal(board.requests[0]!.toAgentId, specs[0].roleId);
  assert.equal(board.requests[0]!.fromWorkId, intakeB.workId);
  const usedBeforeWait = structuredClone(offered.state.budget.used), attemptsBeforeWait = structuredClone(offered.state.attempts);
  await b.close(); const resumedB = await f.open(1);
  const duplicate = await acceptEntry(resumedB, 'request', 'explicit-request', intakeB.sessionId, specs[0].roleId);
  assert.equal(duplicate.accepted, false); assert.equal(duplicate.workId, intakeB.workId);
  for (let i = 0; i < 2; i++) {
    const waiting = await runEntry(resumedB, intakeB.workId); assert.equal(waiting.result.control.kind, 'wait');
    assert.deepEqual(waiting.state.budget.used, usedBeforeWait); assert.deepEqual(waiting.state.attempts, attemptsBeforeWait);
  }
  assert.equal(resumedB.observed.inputs.length, 0); assert.equal(resumedB.observed.reads.length, 0);

  const intakeA = await acceptEntry(a, 'accept', 'accept-observed-request'); const answered = await runEntry(a, intakeA.workId);
  assert.equal(answered.result.control.kind, 'wait'); assert.equal(answered.state.status, 'waiting');
  assert.equal(requests(answered.state)[0]!.status, 'pending'); assert.equal(requests(answered.state)[0]!.mode, 'waiting');
  board = await f.repository.get(TENANT, BOARD); assert.ok(board); const request = board.requests.find(value => value.id === requestId)!;
  assert.equal(request.status, 'answered'); assert.equal(request.acceptedWorkId, intakeA.workId); assert.equal(request.acceptedGoalRevision, 1);
  const post = board.posts.find(value => value.id === request.answerPostId)!; assert.equal(post.workId, intakeA.workId);
  assert.equal(post.authorId, specs[0].roleId); assert.equal(post.body, specs[0].source);
  assert.equal(post.citations[0]!.ownerId, specs[0].principalId); assert.equal(post.citations[0]!.evidenceId, answered.state.evidence[0]!.id);
  const answerEffect = answered.state.attempts.find(value => value.toolId === BOARD_REQUEST_TOOLS[2])!;
  assert.ok(answerEffect.effectReceipt); assert.equal(answerEffect.effectReceipt.outcome, 'applied');
  assert.equal(answered.deliveries.filter(value => value.kind === 'result').length, 0, 'an answered board request is not a completed agent response');
  const beforeConfirm = await resumedB.profile.services.obligations!.refresh(intakeB.workId);
  assert.equal(requests(beforeConfirm)[0]!.status, 'pending'); assert.equal(requests(beforeConfirm)[0]!.mode, 'actionable');
  const confirmed = await runEntry(resumedB, intakeB.workId); complete(confirmed);
  const finishedA = await runEntry(a, intakeA.workId); complete(finishedA);
  assert.equal(requests(confirmed.state)[0]!.status, 'satisfied'); assert.equal(requests(finishedA.state)[0]!.status, 'satisfied');
  const finalBoard = await f.repository.get(TENANT, BOARD); assert.ok(finalBoard); assert.equal(finalBoard.requests[0]!.status, 'satisfied');
  assert.equal(finalBoard.posts.length, 2); assert.equal(finalBoard.requests.length, 1);
  assert.equal(confirmed.state.attempts.filter(value => value.toolId === BOARD_REQUEST_TOOLS[0]).length, 1);
  assert.equal(confirmed.state.attempts.filter(value => value.toolId === BOARD_REQUEST_TOOLS[3]).length, 1);
  for (const toolId of [BOARD_REQUEST_TOOLS[1], BOARD_REQUEST_TOOLS[2], BOARD_WRITE_TOOLS[0]])
    assert.equal(finishedA.state.attempts.filter(value => value.toolId === toolId).length, 1);
  for (const [profile, inputs, state, previousTool, nextTool] of [
    [resumedB.profile, b.observed.inputs, confirmed.state, BOARD_WRITE_TOOLS[0], BOARD_REQUEST_TOOLS[0]],
    [a.profile, a.observed.inputs, finishedA.state, BOARD_REQUEST_TOOLS[1], BOARD_WRITE_TOOLS[0]],
    [a.profile, a.observed.inputs, finishedA.state, BOARD_WRITE_TOOLS[0], BOARD_REQUEST_TOOLS[2]],
  ] as const) {
    const previous = state.attempts.find(value => value.toolId === previousTool)!;
    const next = state.attempts.find(value => value.toolId === nextTool)!;
    const observed = inputs.flatMap(input => input.packet.toolObservations ?? []).find(value => value.attemptId === previous.id && value.output);
    assert.ok(observed?.output && typeof observed.output === 'object' && !Array.isArray(observed.output));
    const revision = observed.output['revision']; assert.ok(typeof revision === 'number' && Number.isSafeInteger(revision) && revision > 0);
    const dispatch = await profile.services.state.receipt(state.id, `dispatch:${next.id}`);
    const task = dispatch?.state.plan?.tasks.find(value => value.id === next.taskId); assert.ok(task);
    assert.equal(task.input['expectedRevision'], revision, 'the next command uses a committed revision actually visible to the model');
  }
  await isolated(a.profile, resumedB.profile, finishedA.state, confirmed.state);
  assert.equal(a.observed.reads.length, 1); assert.equal(b.observed.reads.length, 1); assert.equal(resumedB.observed.reads.length, 0);
  const counts = [a.observed.inputs.length, resumedB.observed.inputs.length];
  complete(await runEntry(a, intakeA.workId)); complete(await runEntry(resumedB, intakeB.workId));
  assert.deepEqual([a.observed.inputs.length, resumedB.observed.inputs.length], counts);
  assert.deepEqual(await f.repository.get(TENANT, BOARD), finalBoard);
});

test('withdrawn foreign-source scope invalidates the retained discussion proof and a new session sees no protected post without changing the owner original', async t => {
  const f = boardDeploymentFixture(t), a = await f.open(0), b = await f.open(1); await f.setup(a.profile);
  const sourceInput = await acceptEntry(a, 'publish', 'source-post'); const author = await runEntry(a, sourceInput.workId); complete(author);
  const readInput = await acceptEntry(b, 'observe', 'visible-read'); const reader = await runEntry(b, readInput.workId); complete(reader);
  assert.deepEqual(reader.state.evidence, []); await noAutomaticMemory(a.profile); await noAutomaticMemory(b.profile);
  const read = b.observed.inputs.flatMap(input => input.packet.toolObservations ?? []).findLast(value => value.toolId === BOARD_READ_TOOL)!;
  const page = BoardReadPageSchema.parse(read.output); assert.equal(page.posts.length, 1); assert.equal(page.posts[0]!.body, specs[0].source);
  const inspection = await b.profile.board!.inspectPage({ boardId: BOARD, workId: readInput.workId, maxPosts: 20, maxBytes: 32768 }, page);
  assert.equal(await inspection.current(), true); assert.ok(inspection.sourceWorks?.some(value => value.workId === sourceInput.workId && value.source.id === a.profile.boardWorkSource!.inputs.id));
  assert.equal(await b.profile.services.inputs!.current(reader.state), true);
  const original = author.state.evidence[0]!.artifact!, originalBytes = await a.profile.services.artifacts.get(original, a.profile.policy);
  const boardBefore = await f.repository.get(TENANT, BOARD);
  f.actors[1]!.allowedScopes = f.actors[1]!.allowedScopes.filter(scope => scope !== a.profile.scope);
  assert.equal(await inspection.current(), false); assert.equal(await b.profile.services.inputs!.current(reader.state), false);
  // A fresh session has no retained conversation dependency on the withdrawn source.
  const afterInput = await acceptEntry(b, 'observe', 'after-grant', undefined, undefined, 'board-after-grant');
  const callsBefore = b.observed.inputs.length; const hidden = await runEntry(b, afterInput.workId); complete(hidden);
  const after = b.observed.inputs.slice(callsBefore);
  const observedPage = BoardReadPageSchema.parse(after.flatMap(input => input.packet.toolObservations ?? []).findLast(value => value.toolId === BOARD_READ_TOOL)!.output);
  assert.deepEqual(observedPage.posts, []); assert.deepEqual(observedPage.findings, []); assert.deepEqual(hidden.state.evidence, []);
  assert.ok(after.every(input => !JSON.stringify(input).includes(specs[0].source)));
  assert.equal(b.observed.reads.length, 0); assert.equal(a.observed.reads.length, 1);
  assert.deepEqual(await a.profile.services.artifacts.get(original, a.profile.policy), originalBytes);
  assert.deepEqual(await a.profile.runtime.state(sourceInput.workId), author.state); assert.deepEqual(await f.repository.get(TENANT, BOARD), boardBefore);
  await noAutomaticMemory(b.profile);
});

test('ordinary board reads of unchanged content hit the default no-progress limit despite different task IDs', async t => {
  const f = boardDeploymentFixture(t), a = await f.open(0), b = await f.open(1); await f.setup(a.profile);
  const sourceInput = await acceptEntry(a, 'publish', 'source-for-repeated-read');
  const author = await runEntry(a, sourceInput.workId); complete(author);
  const originalBoard = await f.repository.get(TENANT, BOARD);
  const input = await acceptEntry(b, 'repeat_read', 'same-content-different-tasks');
  const result = await b.profile.workflow.run(input.workId, b.profile.actor, { maxSteps: 100 });
  const state = await b.profile.runtime.state(input.workId);
  assert.deepEqual(result.control, { kind: 'blocked', reason: 'no_progress_limit' });
  assert.equal(state.status, 'blocked'); assert.equal(state.progress!.policy.maxUnproductiveSteps, 3);
  assert.equal(state.progress!.consecutiveUnproductive, 3);
  assert.ok(state.plan); assert.equal(state.plan.tasks.length, 8);
  assert.equal(new Set(state.plan.tasks.map(task => task.id)).size, 8);
  assert.ok(state.plan.tasks.every(task => task.toolId === BOARD_READ_TOOL && task.effect === 'read'));
  assert.ok(state.plan.tasks.every(task => JSON.stringify(task.input) === JSON.stringify(state.plan!.tasks[0]!.input)));
  assert.ok(state.attempts.length >= 2 && state.attempts.length < state.plan.tasks.length, 'actual unchanged reads stop before exhausting the finite plan');
  assert.equal(new Set(state.attempts.map(attempt => attempt.taskId)).size, state.attempts.length);
  assert.ok(state.attempts.every(attempt => attempt.status === 'succeeded' && attempt.adopted && attempt.effect === 'read'));
  assert.equal(state.budget.used.toolCalls, state.attempts.length); assert.equal(state.budget.used.modelCalls, 1);
  assert.equal(b.observed.inputs.length, 1); assert.equal(b.observed.reads.length, 0); assert.deepEqual(state.evidence, []);
  const pages: Omit<ReturnType<typeof BoardReadPageSchema.parse>, 'observedAt'>[] = [];
  for (const attempt of state.attempts) {
    assert.ok(attempt.resultArtifact);
    const stored = ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(await b.profile.services.artifacts.get(attempt.resultArtifact, state.policy))));
    assert.equal(stored.effectState, 'none'); assert.deepEqual(stored.evidence, []);
    const { observedAt: _observedAt, ...page } = BoardReadPageSchema.parse(stored.output);
    assert.equal(page.posts.length, 1); assert.equal(page.posts[0]!.body, specs[0].source); pages.push(page);
  }
  assert.ok(pages.every(page => JSON.stringify(page) === JSON.stringify(pages[0])), 'new observation timestamps and task identities do not change the returned content');
  assert.deepEqual(await f.repository.get(TENANT, BOARD), originalBoard);
  assert.deepEqual(await a.profile.runtime.state(sourceInput.workId), author.state);
  assert.equal((await b.profile.services.state.deliveries(input.workId)).filter(delivery => delivery.kind === 'result').length, 0);
  await noAutomaticMemory(b.profile);
});
