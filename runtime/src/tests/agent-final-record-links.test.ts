import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { AgentTurnCallInputSchema, AgentTurnReplySchema } from '../application/agent-turn-contracts.js';
import { ToolResultSchema } from '../application/contracts.js';
import { generatedAnswerDigest } from '../application/generated-answer.js';
import { asJson } from '../application/plan-validator.js';
import type { ArtifactRef, WorkState } from '../domain/model.js';
import type { KnowledgeCard } from '../domain/knowledge.js';
import type { SessionScope } from '../domain/session.js';
import { canonical, sha256 } from '../infrastructure/digest.js';
import type { AgentTurnProfile } from '../presentation/agent-turn-profile.js';
import type { WebAcceptResult, WebCommandResult } from '../presentation/web-contracts.js';
import { deploymentFixture, deploymentRequest, type DeploymentWeb } from './agent-deployment-entry-fixture.js';

const fingerprint = (value: unknown) => value === undefined ? 'undefined' : sha256(canonical(asJson(value)));
function same(actual: unknown, expected: unknown, label: string) {
  assert.ok(isDeepStrictEqual(actual, expected), `${label}: expected ${fingerprint(expected)}, got ${fingerprint(actual)}`);
}
async function accept(web: DeploymentWeb, requestId: string, rawText: string) {
  const result = await web.request<WebAcceptResult>('/api/requests', { requestId, rawText, mode: 'auto' });
  assert.equal(result.accepted, true); assert.ok(result.sessionId); return { ...result, sessionId: result.sessionId };
}
async function artifact(profile: AgentTurnProfile, state: WorkState, ref: ArtifactRef) {
  const bytes = Buffer.from(await profile.services.artifacts.get(ref, state.policy));
  assert.equal(bytes.length, ref.byteLength, `artifact byte length: ${ref.id}`);
  assert.equal(sha256(bytes), ref.sha256, `artifact hash: ${ref.id}`); return bytes;
}
async function records(profile: AgentTurnProfile, workId: string) {
  const state = await profile.runtime.state(workId), events = await profile.services.state.events(workId, 0);
  const receipts = new Map<string, NonNullable<Awaited<ReturnType<typeof profile.services.state.receipt>>>>();
  for (const event of events) {
    if (receipts.has(event.commandId)) continue;
    const receipt = await profile.services.state.receipt(workId, event.commandId); assert.ok(receipt, `original receipt: ${event.commandId}`);
    assert.equal(receipt.state.id, workId); assert.equal(receipt.state.revision, event.revision, `publication revision: ${event.commandId}`);
    // Transaction events retain their exact payload; initial conversation acceptance uses its own source envelope below.
    if (event.data['payload'] !== undefined) assert.equal(receipt.digest,
      profile.services.digester.digest({ type: event.type, data: event.data['payload'] }), `publication digest: ${event.commandId}`);
    receipts.set(event.commandId, receipt);
  }
  const artifacts = new Map<string, { ref: ArtifactRef; bytes: Buffer }>();
  // Accepted call/attempt references need not also occur in the current artifact projection.
  const references = [...state.artifacts, ...state.attempts.flatMap(attempt => attempt.resultArtifact ? [attempt.resultArtifact] : []),
    ...state.modelCalls.flatMap(call => [call.inputArtifact, ...(call.replyArtifact ? [call.replyArtifact] : [])]),
    ...(state.generatedAnswer ? [state.generatedAnswer.inputArtifact, state.generatedAnswer.artifact] : [])];
  for (const ref of references) if (!artifacts.has(ref.id)) artifacts.set(ref.id, { ref, bytes: await artifact(profile, state, ref) });
  return { state, events, receipts, artifacts, deliveries: await profile.services.state.deliveries(workId) };
}
type Records = Awaited<ReturnType<typeof records>>;
function publication(saved: Records, commandId: string, type: string) {
  const events = saved.events.filter(event => event.commandId === commandId);
  assert.equal(events.length, 1, `single publication: ${commandId}`); assert.equal(events[0]!.type, type);
  const receipt = saved.receipts.get(commandId); assert.ok(receipt, `receipt selected by original command: ${commandId}`); return receipt;
}
function preserved(actual: Records, expected: Records, label: string) {
  same(actual.state, expected.state, `${label} state`); same(actual.events, expected.events, `${label} events`);
  same([...actual.receipts], [...expected.receipts], `${label} receipts`); same(actual.deliveries, expected.deliveries, `${label} deliveries`);
  same([...actual.artifacts.keys()], [...expected.artifacts.keys()], `${label} artifact IDs`);
  for (const [id, original] of expected.artifacts) {
    const current = actual.artifacts.get(id); assert.ok(current, `retained artifact: ${id}`);
    same(current.ref, original.ref, `retained artifact reference: ${id}`);
    assert.equal(current.bytes.equals(original.bytes), true, `retained original bytes: ${id}`);
  }
}
async function inbox(profile: AgentTurnProfile, scope: SessionScope, messageId: string) {
  const original = await profile.sessions.repository.input(scope, messageId); assert.ok(original, `session original: ${messageId}`);
  assert.equal(original.status, 'applied'); same(original.scope, scope, `session owner: ${messageId}`);
  assert.equal(original.digest, profile.services.digester.digest(asJson({ scope, text: original.text, payload: original.payload,
    kind: original.kind, workId: original.workId })), `session original digest: ${messageId}`);
  return original;
}

test('personal memory execution preserves the exact source and receipt chain across profile reopen', { timeout: 180000 }, async t => {
  const f = deploymentFixture(t, { allowMemorySelection: true });
  // One existing ordinary HTTP flow per supplied storage configuration; no backup, injected receipts or extra model stages.
  for (const [index, deployment] of f.deployments.entries()) {
    const other = f.deployments[1 - index]!;
    let web = await deployment.open(), profile = web.app.profile.general!;
    const source = await accept(web, 'linked-source', deployment.spec.preference);
    const sourceBefore = await records(profile, source.workId), sourceBasis = sourceBefore.state.conversation?.session; assert.ok(sourceBasis);
    const scope = sourceBasis.scope, original = await inbox(profile, scope, 'linked-source');
    assert.equal(original.workId, source.workId); assert.equal(original.text, deployment.spec.preference);
    same(sourceBasis.input, { messageId: original.messageId, sequence: original.sequence, digest: original.digest }, 'applied source basis');
    const accepted = publication(sourceBefore, 'conversation.accept', 'request_accepted');
    assert.equal(accepted.digest, profile.services.digester.digest(asJson({ input: original.payload, session: sourceBasis })), 'source acceptance receipt digest');
    same(accepted.state.conversation?.session, sourceBasis, 'source acceptance receipt session');

    const saved = await web.request<{ card: KnowledgeCard }>('/api/memories/remember', { id: 'linked-memory', requestId: 'linked-save', title: '담당의 원문 요청',
      source: { kind: 'existing', sessionId: source.sessionId, messageId: original.messageId, quote: deployment.spec.preference } });
    const memory = await (await profile.personalKnowledge(profile.actor)).get('linked-memory');
    same(memory.card, saved.card, 'saved personal card'); assert.equal(memory.card.body, original.text);
    assert.equal(memory.card.coverage, 'unknown'); assert.equal(memory.card.kind, 'personal');
    assert.equal(memory.dependency.sources.length, 1);
    const stamp = memory.dependency.sources[0]!; assert.equal(stamp.type, 'session_user_receipt');
    if (stamp.type !== 'session_user_receipt') assert.fail('personal source is not an applied user receipt');
    same(stamp.session, scope, 'personal source scope'); assert.equal(stamp.workId, source.workId);
    assert.equal(stamp.messageId, original.messageId); assert.equal(stamp.sequence, original.sequence);
    assert.equal(stamp.receiptDigest, original.digest);
    assert.equal(stamp.sourceVersion, profile.services.digester.digest(asJson({ type: 'session_user_receipt', scope,
      messageId: original.messageId, sequence: original.sequence, digest: original.digest, quote: original.text })), 'personal source version');
    same(memory.card.sourceVersions, [stamp.sourceVersion], 'card source version');
    assert.equal(memory.card.owner?.agentId, deployment.agentId); assert.notEqual(memory.card.owner?.agentId, other.agentId);
    preserved(await records(profile, source.workId), sourceBefore, 'remember leaves source work unchanged');
    assert.equal(web.observed.reads + web.observed.inputs.length, 0);
    await web.app.close();

    web = await deployment.open(source.sessionId); profile = web.app.profile.general!;
    same(await inbox(profile, scope, original.messageId), original, 'source inbox after first reopen');
    const next = await accept(web, 'linked-next', deploymentRequest(deployment.spec));
    assert.equal(next.sessionId, source.sessionId); assert.notEqual(next.workId, source.workId);
    const unselected = await profile.runtime.state(next.workId), applied = unselected.conversation?.session; assert.ok(applied);
    const request = await inbox(profile, scope, 'linked-next'); assert.equal(request.workId, next.workId);
    assert.equal(request.text, deploymentRequest(deployment.spec));
    const selectionInput = { requestId: 'linked-selection', expectedGoalRevision: unselected.goal.revision, expectedStateRevision: unselected.revision,
      refs: [{ id: 'linked-memory', revision: memory.card.revision }] };
    const selection = await web.request<{ applied: boolean }>(`/api/works/${next.workId}/memories`, selectionInput); assert.equal(selection.applied, true);
    const selectedState = await profile.runtime.state(next.workId); assert.ok(selectedState.personalMemorySelection);
    const selected = selectedState.personalMemorySelection;
    same(selected.basis, applied, 'selection records the new work input, not its source work');
    same(selected.entries[0]!.dependency, memory.dependency, 'selection retains the original memory dependency');
    assert.equal(selected.entries[0]!.ref.agentId, scope.agentId); assert.equal(selected.entries[0]!.ref.principalId, scope.principalId);
    same(selectedState.evidence, [], 'memory selection does not create independent evidence');

    const run = { requestId: 'linked-run', kind: 'run', expectedGoalRevision: unselected.goal.revision } as const;
    const response = await web.request<WebCommandResult>(`/api/works/${next.workId}/commands`, run);
    assert.equal(response.view.kind, 'snapshot');
    if (response.view.kind !== 'snapshot') assert.fail('completed response snapshot missing');
    assert.equal(response.view.view.progress.status, 'completed'); assert.equal(response.view.view.progress.resultDelivery, 'delivered');
    const done = await records(profile, next.workId), state = done.state;
    const selectionReceipt = publication(done, 'personal-memory-select:linked-selection', 'personal_memory_selected');
    same(selectionReceipt.state.personalMemorySelection, selected, 'original selection receipt');
    assert.equal(selectionReceipt.state.revision, selectedState.revision);
    same(state.personalMemorySelection, selected, 'execution retains the explicit selection');
    assert.equal(state.modelCalls.length, 3); assert.equal(web.observed.inputs.length, 3); assert.equal(web.observed.reads, 1);
    same(state.attempts.map(attempt => attempt.toolId), ['core.guidance.load', deployment.spec.toolId], 'finite existing tool path');

    for (const [callIndex, call] of state.modelCalls.entries()) {
      assert.equal(call.status, 'accepted'); assert.equal(call.usageStatus, 'reported');
      const bytes = await artifact(profile, state, call.inputArtifact), envelope = AgentTurnCallInputSchema.parse(JSON.parse(bytes.toString('utf8')));
      assert.equal(envelope.options.callId, call.id); assert.equal(envelope.turn.packet.workId, state.id);
      same(envelope.turn, web.observed.inputs[callIndex], `persisted actual model input: ${call.id}`);
      const packet = envelope.turn.packet; assert.ok(packet.session); assert.ok(packet.personalMemory);
      same(packet.session.basis, applied, `model session basis: ${call.id}`);
      assert.equal(packet.session.interpretation, 'conversation_history_not_verified_evidence');
      const priorInput = packet.session.entries.filter(entry => entry.role === 'user' && entry.sourceId === original.messageId);
      assert.equal(priorInput.length, 1); assert.equal(priorInput[0]!.workId, original.workId);
      assert.equal(priorInput[0]!.sequence, original.sequence); assert.equal(priorInput[0]!.text, original.text);
      const currentInput = packet.session.entries.find(entry => entry.role === 'user' && entry.sourceId === request.messageId); assert.ok(currentInput);
      assert.equal(currentInput.workId, request.workId); assert.equal(currentInput.sequence, request.sequence); assert.equal(currentInput.text, request.text);
      assert.equal(packet.personalMemory.selectionId, selected.selectionId); same(packet.personalMemory.basis, selected.basis, `model memory basis: ${call.id}`);
      assert.equal(packet.personalMemory.interpretation, 'user_requested_memory_not_verified_evidence');
      same(packet.personalMemory.entries.map(entry => ({ ref: entry.ref, body: entry.body, sourceVersions: entry.sourceVersions })),
        [{ ref: selected.entries[0]!.ref, body: original.text, sourceVersions: memory.card.sourceVersions }], `model original personal memory: ${call.id}`);
      assert.equal(bytes.toString('utf8').includes(other.spec.preference), false, `foreign memory excluded: ${call.id}`);
      assert.ok(packet.evidence.every(evidence => evidence.facts.summary !== original.text));
      const reserved = publication(done, `model-reserve:${call.id}`, 'model_call_reserved');
      same(reserved.state.modelCalls.find(value => value.id === call.id)?.inputArtifact, call.inputArtifact, `model reserve input reference: ${call.id}`);
      const received = publication(done, `model-receive:${call.id}`, 'model_reply_received'); assert.ok(call.replyArtifact);
      same(received.state.modelCalls.find(value => value.id === call.id)?.replyArtifact, call.replyArtifact, `model receive reply reference: ${call.id}`);
      const reply = AgentTurnReplySchema.parse(JSON.parse((await artifact(profile, state, call.replyArtifact)).toString('utf8')));
      assert.equal(reply.status, 'ok'); if (reply.status !== 'ok') assert.fail(`model reply not accepted: ${call.id}`);
      const adopted = publication(done, `model-adopt:${call.id}`, reply.result.kind === 'plan' ? 'model_plan_accepted' : 'model_turn_accepted');
      assert.equal(adopted.state.modelCalls.find(value => value.id === call.id)?.status, 'accepted');
    }

    const attempt = state.attempts.find(value => value.toolId === deployment.spec.toolId); assert.ok(attempt?.resultArtifact);
    const rawResult = ToolResultSchema.parse(JSON.parse((await artifact(profile, state, attempt.resultArtifact)).toString('utf8')));
    assert.equal(rawResult.attemptId, attempt.id); assert.equal(rawResult.resultId, attempt.resultId); assert.equal(rawResult.status, 'success');
    assert.equal(rawResult.effectState, 'none'); same(rawResult.output, { summary: deployment.spec.sourceText }, 'original registered source output');
    assert.equal(attempt.adopted, true); assert.equal(attempt.status, 'succeeded');
    const received = publication(done, `receive:${attempt.id}`, 'result_received'), adopted = publication(done, `adopt:${attempt.id}`, 'result_settled');
    const receivedAttempt = received.state.attempts.find(value => value.id === attempt.id); assert.ok(receivedAttempt);
    assert.equal(receivedAttempt.status, 'received'); assert.equal(receivedAttempt.adopted, false);
    same(receivedAttempt.resultArtifact, attempt.resultArtifact, 'tool original received reference');
    assert.equal(adopted.state.attempts.find(value => value.id === attempt.id)?.adopted, true);
    same(adopted.state.evidence, rawResult.evidence, 'adoption uses the exact original tool evidence');
    same(state.evidence, rawResult.evidence, 'final evidence remains the tool original');
    assert.equal(state.evidence.length, 1); assert.equal(state.evidence[0]!.sourceId, deployment.spec.toolId);
    assert.notEqual(state.evidence[0]!.facts.summary, original.text);

    const answer = state.generatedAnswer; assert.ok(answer);
    const answerCall = state.modelCalls.find(value => value.id === answer.callId); assert.ok(answerCall?.replyArtifact);
    same(answer.inputArtifact, answerCall.inputArtifact, 'answer uses the exact model input artifact'); same(answer.input, applied, 'answer input receipt basis');
    assert.equal(answer.promptDigest, answerCall.agentTurnPromptDigest);
    same(answer.evidenceIds, state.evidence.map(value => value.id), 'answer cites only the independently read source');
    const answerBytes = await artifact(profile, state, answer.artifact), reply = AgentTurnReplySchema.parse(JSON.parse((await artifact(profile, state, answerCall.replyArtifact)).toString('utf8')));
    assert.ok(reply.status === 'ok' && reply.result.kind === 'answer');
    if (reply.status !== 'ok' || reply.result.kind !== 'answer') assert.fail('answer reply missing');
    assert.equal(answerBytes.equals(Buffer.from(reply.result.text)), true, 'answer artifact equals the original accepted reply bytes');
    assert.equal(answerBytes.equals(Buffer.from(deployment.spec.sourceText)), true);
    same(reply.result.evidenceIds, answer.evidenceIds, 'answer reply evidence IDs');
    const answerReceipt = publication(done, `model-adopt:${answer.callId}`, 'model_turn_accepted');
    same(answerReceipt.state.generatedAnswer, answer, 'original answer publication receipt');
    const deliveries = done.deliveries.filter(value => value.kind === 'result'); assert.equal(deliveries.length, 1);
    const delivery = deliveries[0]!; assert.equal(delivery.status, 'delivered'); assert.ok(delivery.externalId);
    assert.equal(Buffer.from(delivery.text).equals(answerBytes), true, 'final delivery retains exact answer bytes');
    same(delivery.context?.artifact, answer.artifact, 'delivery artifact reference');
    assert.equal(delivery.context?.generatedAnswerDigest, generatedAnswerDigest(profile.services, state));
    assert.equal(delivery.context?.responseId, state.conversation?.result?.id); assert.equal(delivery.id, state.conversation?.result?.id);
    same(delivery.context?.binding.session, scope, 'delivery session owner');
    const preparedEvents = done.events.filter(event => event.type === 'response_prepared' &&
      isDeepStrictEqual(event.data['payload'], { responseId: delivery.id, kind: 'result' }));
    assert.equal(preparedEvents.length, 1);
    same(publication(done, preparedEvents[0]!.commandId, 'response_prepared').state.conversation?.result, state.conversation?.result, 'original prepared response receipt');
    const history = await profile.sessions.repository.history(scope, state.policy, { limit: 64 }); assert.equal(history.nextCursor, null);
    const deliveredEntry = history.entries.filter(entry => entry.role === 'assistant' && entry.kind === 'result'); assert.equal(deliveredEntry.length, 1);
    assert.equal(deliveredEntry[0]!.sourceId, delivery.id); assert.equal(deliveredEntry[0]!.workId, state.id);
    assert.equal(deliveredEntry[0]!.status, 'delivered'); same(deliveredEntry[0]!.artifact, answer.artifact, 'session result artifact');
    assert.equal(Buffer.from(deliveredEntry[0]!.text).equals(answerBytes), true, 'session result preserves delivery bytes');
    preserved(await records(profile, source.workId), sourceBefore, 'completed source work');
    await web.app.close();

    web = await deployment.open(source.sessionId); profile = web.app.profile.general!;
    preserved(await records(profile, source.workId), sourceBefore, 'reopened source work');
    preserved(await records(profile, next.workId), done, 'reopened completed work');
    same(await inbox(profile, scope, original.messageId), original, 'reopened source inbox');
    same(await inbox(profile, scope, request.messageId), request, 'reopened later inbox');
    same(await (await profile.personalKnowledge(profile.actor)).get('linked-memory'), memory, 'reopened personal source');
    const replay = await web.request<WebCommandResult>(`/api/works/${next.workId}/commands`, run); assert.equal(replay.duplicate, true);
    preserved(await records(profile, next.workId), done, 'same command replay');
    same(await profile.sessions.repository.history(scope, state.policy, { limit: 64 }), history, 'replay preserves session entries');
    assert.equal(web.observed.inputs.length, 0); assert.equal(web.observed.reads, 0);
    assert.equal(profile.policy.allowWrites, false); assert.equal(profile.services.tools.some(tool => tool.definition.effect === 'write'), false);
    t.diagnostic(JSON.stringify({ stateBackend: deployment.spec.stateBackend, personalMemory: deployment.spec.personalMemory,
      sourceWorkId: source.workId, workId: state.id, sessionId: scope.sessionId, selectionCommandId: 'personal-memory-select:linked-selection',
      toolAttemptId: attempt.id, resultId: attempt.resultId, answerCallId: answer.callId, deliveryId: delivery.id,
      sourceDigest: original.digest, answerSha256: answer.artifact.sha256, modelCalls: 3, sourceCalls: 1, replayModelCalls: 0, replaySourceCalls: 0 }));
    await web.app.close();
  }
});
