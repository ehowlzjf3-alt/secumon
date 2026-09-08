import test from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { PEER_TOOL_IDS } from '../application/peer-agents.js';
import { PeerReviewSchema } from '../application/peer-contracts.js';
import { ToolResultSchema } from '../application/contracts.js';
import { asJson } from '../application/plan-validator.js';
import { readGeneratedAnswer } from '../application/generated-answer.js';
import { hypothesesRequireReview } from '../domain/hypotheses.js';
import type { WorkState } from '../domain/model.js';
import { acceptPeerEntry, peerDeploymentFixture, peerObject, runPeerEntry, PEER_SOURCE, type PeerEntryOpened } from './peer-deployment-entry-fixture.js';

async function storedPeerResult(opened: PeerEntryOpened, state: WorkState, toolId: string = PEER_TOOL_IDS[0]) {
  const attempt = state.attempts.find(value => value.toolId === toolId); assert.ok(attempt?.resultArtifact);
  const result = ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(await opened.profile.services.artifacts.get(attempt.resultArtifact, state.policy))));
  assert.equal(attempt.adopted, true); assert.equal(result.status, 'success'); assert.equal(result.coverage, 'complete');
  assert.deepEqual(result.evidence, []); assert.equal(result.artifacts.length, 1);
  assert.equal(peerObject(result.output)?.interpretation, 'peer_assessment_not_independent_evidence');
  const record = JSON.parse(new TextDecoder().decode(await opened.profile.services.artifacts.get(result.artifacts[0]!, state.policy)));
  return { attempt, result, record };
}
async function noSharedMemory(opened: PeerEntryOpened) {
  const memory = await opened.profile.personalKnowledge(opened.profile.actor);
  const found = await memory.search({ namespace: 'personal', scope: 'personal', kinds: ['personal'], text: '', limit: 20 });
  assert.equal(found.index.status, 'ready'); assert.equal(found.index.complete, true); assert.deepEqual(found.cards, []);
  assert.equal(opened.profile.board, null); assert.equal(opened.profile.archive, null);
}
async function internalDelivery(opened: PeerEntryOpened, workId: string) {
  const p = opened.profile, state = await p.runtime.state(workId), deliveries = await p.services.state.deliveries(workId);
  const result = deliveries.find(value => value.kind === 'result'); assert.ok(result);
  assert.equal(result.status, 'delivered'); assert.equal(result.destination, 'local'); assert.equal(result.context?.binding.channel, 'peer');
  assert.ok(result.context);
  assert.equal(result.context.binding.session?.sessionId, state.conversation?.session?.scope.sessionId);
  const before = await p.sessions.history(p.actor, state.conversation!.session!.scope.sessionId, p.policy, { limit: 100 });
  assert.ok(before.entries.some(value => value.role === 'assistant' && value.workId === state.id));
  assert.equal((await p.services.sink.lookup!(result)).status, 'delivered');
  assert.equal((await p.services.sink.send(result)).status, 'delivered');
  assert.deepEqual(await p.sessions.history(p.actor, state.conversation!.session!.scope.sessionId, p.policy, { limit: 100 }), before);
  assert.ok(deliveries.every(value => value.destination === 'local' && value.context?.binding.channel === 'peer'));
  return { state, result, history: before };
}

test('independent SQLite profiles consult in both directions; resident sessions follow each sender and internal replies do not copy work or memory', { timeout: 60000 }, async t => {
  const f = peerDeploymentFixture(t), a = await f.open(0), b = await f.open(1);
  assert.notEqual(a.profile.agentId, b.profile.agentId); assert.notEqual(a.profile.scope, b.profile.scope);
  assert.equal(a.profile.stateBackend, 'sqlite'); assert.equal(b.profile.stateBackend, 'sqlite');
  for (const field of ['state', 'memory'] as const) {
    const [first, second] = f.ready.map(value => statSync(value.paths[field]));
    assert.notDeepEqual([first!.dev, first!.ino], [second!.dev, second!.ino]);
  }
  const first = await acceptPeerEntry(a, 'first-resident-question'); const firstState = await runPeerEntry(a, first.workId);
  const firstExchange = f.exchanges[0]!; assert.equal(firstExchange.to, 1); assert.equal(firstExchange.role, 'resident');
  const second = await acceptPeerEntry(a, 'second-resident-question'); const secondState = await runPeerEntry(a, second.workId);
  const secondExchange = f.exchanges[1]!;
  assert.notEqual(firstExchange.ticket.workId, secondExchange.ticket.workId);
  assert.equal(firstExchange.ticket.sessionId, secondExchange.ticket.sessionId);
  const receiverInput = b.observed.inputs.find(input => input.packet.workId === secondExchange.ticket.workId)!;
  assert.ok(receiverInput.packet.session?.entries.some(entry => entry.role === 'user' && entry.text.includes('first-resident-question')));
  assert.ok(receiverInput.packet.session?.entries.some(entry => entry.role === 'user' && entry.text.includes('second-resident-question')));
  const reverse = await acceptPeerEntry(b, 'reverse-resident-question'); const reverseState = await runPeerEntry(b, reverse.workId);
  const reverseExchange = f.exchanges[2]!; assert.equal(reverseExchange.to, 0);
  assert.notEqual(reverseExchange.ticket.sessionId, firstExchange.ticket.sessionId);
  for (const [caller, receiver, state, exchange] of [[a, b, firstState, firstExchange], [a, b, secondState, secondExchange],
    [b, a, reverseState, reverseExchange]] as const) {
    assert.equal(await caller.profile.services.state.get(exchange.ticket.workId), null);
    assert.equal(await receiver.profile.services.state.get(state.id), null);
    assert.deepEqual(state.evidence, []); assert.equal(state.budget.used.toolCalls, 1);
    assert.equal(state.generatedAnswer!.evidenceIds.length, 0);
    const result = await storedPeerResult(caller, state); assert.equal(peerObject(result.result.output)?.cost, 'recipient_own_budget');
    assert.deepEqual(result.record.ticket, exchange.ticket);
    const delivered = await internalDelivery(receiver, exchange.ticket.workId);
    assert.deepEqual(delivered.state.evidence, []); assert.equal(delivered.state.budget.used.modelCalls, 1);
    assert.equal(state.budget.used.modelCalls, 2);
    await assert.rejects(caller.profile.sessions.history(caller.profile.actor, exchange.ticket.sessionId, caller.profile.policy, { limit: 10 }), /session_unavailable/);
  }
  // Exercise the trusted receiver request API for another user of the same sender agent.
  // This routing check does not fabricate a sender work receipt or grant receiver access to sender stores.
  const alternate = { ...structuredClone(firstExchange.request), id: 'alternate-principal-request',
    text: JSON.stringify({ entry: 'receiver', token: 'alternate-principal-question' }),
    from: { ...firstExchange.request.from, principalId: 'alternate-sender-user', workId: 'alternate-principal-work' },
    policyDigest: a.profile.services.digester.digest(asJson({ ...a.profile.policy, principalId: 'alternate-sender-user' })) };
  const alternatePeer = f.peers(1), signal = new AbortController().signal;
  const alternateTicket = await alternatePeer.request(alternate, signal);
  assert.notEqual(alternateTicket.sessionId, firstExchange.ticket.sessionId, 'different sender principals must not share resident context');
  assert.equal((await alternatePeer.run(alternate, alternateTicket, signal)).status, 'answer');
  assert.deepEqual(await alternatePeer.request(alternate, signal), alternateTicket);
  const alternateInput = b.observed.inputs.find(input => input.packet.workId === alternateTicket.workId)!;
  assert.ok(alternateInput); assert.ok(!JSON.stringify(alternateInput.packet.session).includes('first-resident-question'));
  await internalDelivery(b, alternateTicket.workId);
  assert.equal(a.observed.reads.length + b.observed.reads.length, 0);
  await noSharedMemory(a); await noSharedMemory(b);
});

test('temporary peer consult uses a separate request context while the same receiving profile remains available afterward', { timeout: 60000 }, async t => {
  const f = peerDeploymentFixture(t), a = await f.open(0), b = await f.open(1);
  const one = await acceptPeerEntry(a, 'temporary-context-one', 'consult', 'temporary'); await runPeerEntry(a, one.workId);
  const two = await acceptPeerEntry(a, 'temporary-context-two', 'consult', 'temporary'); await runPeerEntry(a, two.workId);
  const [first, second] = f.exchanges; assert.ok(first && second);
  assert.equal(first.role, 'temporary'); assert.equal(second.role, 'temporary');
  assert.notEqual(first.ticket.sessionId, second.ticket.sessionId); assert.notEqual(first.ticket.workId, second.ticket.workId);
  const secondInput = b.observed.inputs.find(input => input.packet.workId === second.ticket.workId)!;
  assert.ok(secondInput); assert.ok(!JSON.stringify(secondInput.packet.session).includes('temporary-context-one'));
  assert.ok(JSON.stringify(secondInput.packet.session).includes('temporary-context-two'));
  await internalDelivery(b, first.ticket.workId); await internalDelivery(b, second.ticket.workId);
  const later = await acceptPeerEntry(a, 'resident-after-temporary'); await runPeerEntry(a, later.workId);
  assert.equal(f.exchanges[2]!.role, 'resident'); assert.notEqual(f.exchanges[2]!.ticket.sessionId, second.ticket.sessionId);
  assert.equal(b.observed.inputs.length, 3); await noSharedMemory(a); await noSharedMemory(b);
});

test('tampering with a confirmed peer delivery session or agent cannot redirect the original delivery or append to another history', { timeout: 60000 }, async t => {
  const f = peerDeploymentFixture(t), a = await f.open(0), b = await f.open(1);
  const intake = await acceptPeerEntry(a, 'delivery-routing-original'); await runPeerEntry(a, intake.workId);
  const exchange = f.exchanges[0]!, original = await internalDelivery(b, exchange.ticket.workId);
  const other = await b.profile.sessions.open(b.profile.actor, { channel: 'peer', conversationId: 'different-peer-route' });
  assert.notEqual(other.scope.sessionId, exchange.ticket.sessionId);
  const otherBefore = await b.profile.sessions.history(b.profile.actor, other.scope.sessionId, b.profile.policy, { limit: 100 });
  const callerBefore = await a.profile.sessions.history(a.profile.actor, intake.sessionId, a.profile.policy, { limit: 100 });
  const deliveries = await b.profile.services.state.deliveries(exchange.ticket.workId);
  for (const change of ['session', 'agent'] as const) {
    const altered = structuredClone(original.result); assert.ok(altered.context?.binding.session);
    if (change === 'session') {
      altered.context.binding.session.sessionId = other.scope.sessionId;
      altered.context.binding.conversationId = 'different-peer-route';
    } else altered.context.binding.session.agentId = a.profile.agentId;
    // Preserve the confirmed logical delivery ID: a retransmission cannot acquire another destination identity.
    // A trusted host issuing a new delivery ID is outside this retransmission check.
    assert.equal((await b.profile.services.sink.send(altered)).status, 'unknown');
    assert.equal((await b.profile.services.sink.lookup!(original.result)).status, 'delivered');
    assert.deepEqual(await b.profile.sessions.history(b.profile.actor, exchange.ticket.sessionId, b.profile.policy, { limit: 100 }), original.history);
    assert.deepEqual(await b.profile.sessions.history(b.profile.actor, other.scope.sessionId, b.profile.policy, { limit: 100 }), otherBefore);
  }
  // The other agent has no matching delivery, so this also exercises its session ownership guard and rollback.
  await assert.rejects(a.profile.services.sink.send(original.result), /session_unavailable/);
  assert.equal((await a.profile.services.sink.lookup!(original.result)).status, 'absent');
  assert.deepEqual(await a.profile.sessions.history(a.profile.actor, intake.sessionId, a.profile.policy, { limit: 100 }), callerBefore);
  assert.deepEqual(await b.profile.services.state.deliveries(exchange.ticket.workId), deliveries);
  assert.deepEqual(await b.profile.runtime.state(exchange.ticket.workId), original.state);
});

test('structured peer reviews retain separate contexts and cause caller reassessment followed by its own discriminating observation', { timeout: 60000 }, async t => {
  const f = peerDeploymentFixture(t), a = await f.open(0), b = await f.open(1);
  for (const token of ['review-context-one', 'review-context-two']) {
    const intake = await acceptPeerEntry(a, token, 'review'), state = await runPeerEntry(a, intake.workId);
    const exchange = f.exchanges.at(-1)!; assert.equal(exchange.request.kind, 'review'); assert.equal(exchange.to, 1);
    const stored = await storedPeerResult(a, state), output = peerObject(stored.result.output)!;
    const review = PeerReviewSchema.parse(output.review);
    assert.equal(review.targetVersion, exchange.request.target!.version); assert.equal(review.target, exchange.request.target!.hypothesis.claim);
    assert.equal(review.basis.kind, 'none'); assert.ok(review.alternative); assert.ok(review.impact); assert.equal(review.discriminatingQuestions.length, 1);
    assert.deepEqual(output.model, exchange.reply!.model);
    const responseReceipt = await a.profile.services.state.receipt(state.id, `peer-response:${stored.attempt.id}`); assert.ok(responseReceipt);
    assert.equal(responseReceipt.state.hypothesisAssessment, null);
    assert.equal(hypothesesRequireReview(responseReceipt.state), true);
    assert.equal(responseReceipt.state.generatedAnswer, undefined);
    assert.deepEqual(responseReceipt.state.evidence.map(value => value.facts.phase), ['baseline']);
    const publicReview = a.observed.inputs.find(input => input.packet.workId === state.id && input.packet.toolObservations?.some(value =>
      value.attemptId === stored.attempt.id && peerObject(value.output)?.review)); assert.ok(publicReview);
    const probe = state.attempts.find(value => value.toolId === PEER_SOURCE && value.id !== state.attempts[0]!.id)!;
    const dispatch = await a.profile.services.state.receipt(state.id, `dispatch:${probe.id}`); assert.ok(dispatch);
    assert.ok(dispatch.state.revision > responseReceipt.state.revision);
    const task = dispatch.state.plan!.tasks.find(value => value.id === probe.taskId)!;
    assert.equal(task.input.phase, 'current'); assert.equal(task.description, review.discriminatingQuestions[0]);
    assert.equal(dispatch.state.hypotheses[0]!.status, 'inconclusive');
    assert.equal(dispatch.state.hypotheses[0]!.reason, review.impact);
    assert.deepEqual(dispatch.state.hypothesisAssessment?.evidenceIds, responseReceipt.state.evidence.map(value => value.id));
    assert.equal(state.hypotheses[0]!.status, 'refuted'); assert.equal(hypothesesRequireReview(state), false);
    assert.deepEqual(state.evidence.map(value => value.facts.days), [90, 30]);
    assert.ok(state.evidence.every(value => value.sourceId === PEER_SOURCE && value.scope === a.profile.scope && value.derivedFrom.length === 0));
    assert.deepEqual(state.generatedAnswer!.evidenceIds, state.evidence.map(value => value.id));
    assert.match((await readGeneratedAnswer(a.profile.services, state))!.text, /30일/);
    for (const value of state.evidence) assert.equal(await b.profile.services.artifacts.exists(value.artifact!), false);
    const receiver = await internalDelivery(b, exchange.ticket.workId); assert.deepEqual(receiver.state.evidence, []);
  }
  assert.notEqual(f.exchanges[0]!.ticket.sessionId, f.exchanges[1]!.ticket.sessionId);
  const lastInput = b.observed.inputs.find(input => input.packet.workId === f.exchanges[1]!.ticket.workId)!;
  assert.ok(!JSON.stringify(lastInput.packet.session).includes('review-context-one'));
  assert.equal(b.observed.reads.length, 0); assert.deepEqual(a.observed.reads.map(value => value.phase), ['baseline', 'current', 'baseline', 'current']);
  await noSharedMemory(a); await noSharedMemory(b);
});

test('compact and profile reopen preserve the first peer ticket and receiver budget; core.peer.resume never repeats receiver work', { timeout: 60000 }, async t => {
  const f = peerDeploymentFixture(t); let a = await f.open(0), b = await f.open(1);
  const intake = await acceptPeerEntry(a, 'resume-original-request', 'resume');
  const stop = new Error('host_checkpoint_boundary');
  await assert.rejects(a.profile.workflow.run(intake.workId, a.profile.actor, { maxSteps: 64, onStep: async () => {
    const state = await a.profile.runtime.state(intake.workId);
    if (state.evidence.length && state.attempts.some(value => value.toolId === PEER_TOOL_IDS[0] && value.adopted)) throw stop;
  } }), error => error === stop);
  const before = await a.profile.runtime.state(intake.workId); assert.equal(before.generatedAnswer, undefined);
  const exchange = f.exchanges[0]!; assert.ok(exchange.reply); const receiverBefore = await b.profile.runtime.state(exchange.ticket.workId);
  const original = await storedPeerResult(a, before);
  const bytes = await a.profile.services.artifacts.get(original.result.artifacts[0]!, before.policy);
  const frame = await a.profile.context.prepare(before, { callId: 'peer-entry-compact', maxInputBytes: 65536, maxInputTokens: 100000,
    maxOutputTokens: 2048, forceCompact: true }); assert.equal(frame.packet.workId, before.id);
  const receiverCalls = b.observed.inputs.length;
  a = await f.reopen(0); b = await f.reopen(1);
  const duplicate = await f.peers(1).request(exchange.request, new AbortController().signal);
  assert.deepEqual(duplicate, exchange.ticket);
  assert.deepEqual((await b.profile.runtime.state(exchange.ticket.workId)).budget, receiverBefore.budget);
  assert.deepEqual(await a.profile.services.artifacts.get(original.result.artifacts[0]!, a.profile.policy), bytes);
  const restored = await a.profile.recovery.restore(intake.workId, a.profile.actor); assert.equal(restored.packet.workId, intake.workId);
  const final = await runPeerEntry(a, intake.workId), resumed = await storedPeerResult(a, final, PEER_TOOL_IDS[1]);
  assert.deepEqual(resumed.record.ticket, original.record.ticket); assert.deepEqual(resumed.record.request, original.record.request);
  assert.equal(resumed.record.reply.answerDigest, original.record.reply.answerDigest);
  assert.equal(final.attempts.filter(value => value.toolId === PEER_TOOL_IDS[0]).length, 1);
  assert.equal(final.attempts.filter(value => value.toolId === PEER_TOOL_IDS[1]).length, 1);
  assert.equal(b.observed.inputs.length, receiverCalls); assert.deepEqual((await b.profile.runtime.state(exchange.ticket.workId)).budget, receiverBefore.budget);
  assert.equal(a.observed.reads.length, 1); assert.equal(f.exchanges.length, 1);
  await internalDelivery(b, exchange.ticket.workId);
  const calls = a.observed.inputs.length; await runPeerEntry(a, intake.workId);
  assert.equal(a.observed.inputs.length, calls); assert.deepEqual((await a.profile.runtime.state(intake.workId)).budget, final.budget);
});
