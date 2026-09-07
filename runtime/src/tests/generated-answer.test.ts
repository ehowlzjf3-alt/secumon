import test from 'node:test';
import assert from 'node:assert/strict';
import type { ArtifactRef, ContextPacket, ModelCall } from '../domain/model.js';
import type { AppliedSessionInput, SessionContext } from '../domain/session.js';
import type { AnswerAssessment } from '../domain/agent-turn.js';
import type { AgentTurnInput, AgentTurnPrompt, AgentTurnReply } from '../application/agent-turn-types.js';
import { agentTurnPreviousAnswerCurrent } from '../application/agent-turn-previous.js';
import { ConversationService, resultProof, type AcceptRequest } from '../application/conversation-service.js';
import { OutboxDispatcher } from '../application/outbox.js';
import { WorkViewService } from '../application/work-view-service.js';
import { generatedAnswerBasis, generatedAnswerCurrent, readGeneratedAnswer, readGeneratedAnswerCandidate, type GeneratedAnswerServices } from '../application/generated-answer.js';
import type { RuntimeServices } from '../application/services.js';
import type { ArtifactStore } from '../application/ports.js';
import { asJson } from '../application/plan-validator.js';
import { transact } from '../application/work-transactions.js';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { FakeClock, FakeSink } from '../infrastructure/fakes.js';
import { Sha256Digester } from '../infrastructure/digest.js';

const actor = { tenantId: 'synthetic', principalId: 'reader' };
const rawText = '일반 문장으로 답해 주세요.';
const assessment = { type: 'model_self_review' as const, verdict: 'satisfied' as const,
  rationale: 'The synthetic response follows the requested format.', missing: [], counterarguments: ['No independent factual claim is being made.'] };

/** Synthetic accepted-call boundary. Production intake/model lifecycle is covered by the agent-turn integration suite. */
async function fixture(memory = false) {
  const state = new MemoryStateRepository(), originals = new MemoryArtifactStore(), digester = new Sha256Digester();
  const clock = new FakeClock(1788566400000), sink = new FakeSink();
  const flags = { session: true, memory: true, sources: true, originalRequest: true, omitOriginal: false, corrupt: '', sourceChecks: 0, memoryChecks: 0 };
  const artifacts: ArtifactStore = { put: (bytes, attributes) => originals.put(bytes, attributes), exists: ref => originals.exists(ref),
    async get(ref, policy) { const bytes = await originals.get(ref, policy); if (flags.corrupt === ref.id && bytes.length) bytes[0] = bytes[0]! ^ 1; return bytes; } };
  let applied: AppliedSessionInput = { scope: { ...actor, agentId: 'agent-1', sessionId: 'session-1' },
    input: { messageId: 'input-1', sequence: 1, digest: digester.digest({ text: rawText, payload: 'synthetic-intake' }) } };
  let workId = '';
  const session = (): SessionContext => ({ schemaVersion: 1, basis: applied,
    head: { revision: applied.input.sequence, throughSequence: applied.input.sequence, digest: digester.digest(rawText), policyDigest: digester.digest(actor) },
    entries: [
      ...(!flags.omitOriginal ? [{ sequence: 1, role: 'user' as const, sourceId: 'input-1', workId, text: rawText, labels: ['internal'], artifact: null, status: 'received' as const, kind: 'work' }] : []),
      ...(applied.input.sequence > 1 ? [{ sequence: applied.input.sequence, role: 'user' as const, sourceId: applied.input.messageId,
        workId, text: '후속 설명입니다.', labels: ['internal'], artifact: null, status: 'received' as const, kind: 'command' }] : []),
    ],
    interpretation: 'conversation_history_not_verified_evidence' });
  const services: GeneratedAnswerServices & Pick<RuntimeServices, 'state' | 'artifacts' | 'clock' | 'sink'> = { state, artifacts, digester, clock, sink,
    sessions: { context: async () => session(), current: async () => flags.session },
    personalMemories: { context: async value => value.personalMemorySelection ? { schemaVersion: 1,
      selectionId: value.personalMemorySelection.selectionId, basis: applied, entries: [], interpretation: 'user_requested_memory_not_verified_evidence' } : null,
    current: async () => { flags.memoryChecks++; return flags.memory; } },
    generatedAnswers: { current: async (state, turn) => { flags.sourceChecks++; return flags.sources && flags.originalRequest &&
      await agentTurnPreviousAnswerCurrent(services, state, turn); } } };
  const conversation = new ConversationService(services), outbox = new OutboxDispatcher(services, 'sender', 100);
  const request: AcceptRequest = { messageId: 'input-1', binding: { ...actor, channel: 'test', conversationId: 'chat-1', recipientId: actor.principalId, destination: 'local' },
    goal: { revision: 1, description: rawText, scope: 'generic', mode: 'auto', criteria: [],
      responseRequirement: { version: 1, requestMessageId: 'input-1', requestTextDigest: digester.digest(rawText), format: 'text' } },
    policy: { ...actor, allowedTools: [], allowedLabels: ['internal'], allowedDestinations: ['local', 'synthetic-model'], allowWrites: false },
    limits: { toolCalls: 5, modelCalls: 5, tokens: 10000, replans: 3, wallTimeMs: 60000 }, completionRequiresDelivery: true };
  workId = (await conversation.accept(actor, request, applied)).workId;
  await outbox.flush(workId, actor);
  if (memory) await transact(services, workId, 'memory-select', 'test_memory_selected', {}, next => {
    next.personalMemorySelection = { schemaVersion: 1, selectionId: 'empty-explicit-selection', basis: applied,
      policy: { allowedLabels: next.policy.allowedLabels, allowedDestinations: next.policy.allowedDestinations }, entries: [] };
  });
  async function adopt(text = '요청하신 일반 문장 답변입니다.', suffix = '1', review: AnswerAssessment = assessment,
    previousAnswer?: AgentTurnInput['previousAnswer']) {
    const current = (await state.get(workId))!;
    const promptBody = { version: 1 as const, instructions: 'Reply to the current user request.', profile: { agentId: applied.scope.agentId, purpose: '', skillsMode: 'off' as const } };
    const prompt: AgentTurnPrompt = { ...promptBody, digest: digester.digest(asJson(promptBody)) };
    const personalMemory = await services.personalMemories!.context(current);
    const packet: ContextPacket = { schemaVersion: 1, workId, stateRevision: current.revision, goal: current.goal, policy: current.policy,
      plan: current.plan, hypotheses: current.hypotheses, obligations: current.obligations, evidence: current.evidence, activeToolIds: [], purpose: 'respond',
      session: session(), ...(personalMemory ? { personalMemory } : {}) };
    const callId = `turn-${suffix}`, options = { callId, maxOutputTokens: 1000, tools: [] };
    const attributes = { tenantId: actor.tenantId, labels: ['internal'], mediaType: 'application/json' };
    const inputArtifact = await artifacts.put(new TextEncoder().encode(JSON.stringify({ turn: { version: 1, packet, prompt,
      ...(previousAnswer ? { previousAnswer } : {}) }, options })), attributes);
    const reply: AgentTurnReply = { status: 'ok', result: { kind: 'answer', text, evidenceIds: [], assessment: review },
      provider: 'synthetic', model: 'synthetic-turn', inputTokens: 10, outputTokens: 5 };
    const replyArtifact = await artifacts.put(new TextEncoder().encode(JSON.stringify(reply)), attributes);
    const artifact = await artifacts.put(new TextEncoder().encode(text), { ...attributes, mediaType: 'text/plain' });
    const call: ModelCall = { id: callId, purpose: 'agent_turn', semanticVersion: 4, agentTurnPromptDigest: prompt.digest,
      provider: reply.provider, model: reply.model, adapterRevision: '1', destination: 'synthetic-model', owner: 'model-worker',
      goalRevision: 1, baseStateRevision: current.revision, basePlanRevision: 0, semanticDigest: generatedAnswerBasis(services, current),
      inputArtifact, replyArtifact, inputEstimate: 10, maxOutputTokens: 1000, tokenReservation: 1010,
      inputTokens: 10, outputTokens: 5, usageStatus: 'reported', status: 'accepted', startedAt: clock.now(),
      leaseUntil: clock.now() + 30000, finishedAt: clock.now(), expired: false, outcome: 'ok', reason: 'synthetic_answer_accepted' };
    await transact(services, workId, `answer-${suffix}`, 'test_answer_accepted', {}, next => {
      next.modelCalls.push(call); next.budget.used.modelCalls++; next.budget.used.tokens += 15;
      next.generatedAnswer = { id: `answer-${suffix}`, callId, goalRevision: 1, planRevision: 0, dataGeneration: 0,
        input: applied, inputArtifact, promptDigest: prompt.digest, basisDigest: generatedAnswerBasis(services, next),
        artifact, evidenceIds: [], observedEvidenceIds: [], assessment: review, createdAt: clock.now() };
    });
    return { artifact, inputArtifact, replyArtifact, text };
  }
  async function followUp() {
    applied = { scope: applied.scope, input: { messageId: 'input-2', sequence: 2, digest: digester.digest('후속 설명입니다.') } };
    await transact(services, workId, 'follow-up', 'test_input_applied', {}, next => { next.conversation!.session = applied; });
  }
  return { services, state, artifacts, flags, sink, conversation, outbox, workId, adopt, followUp };
}

test('generated answer uses verified text and keeps its basis across preparation, delivery and usage accounting', async () => {
  const f = await fixture(), original = await f.adopt();
  const before = (await f.state.get(f.workId))!, basis = generatedAnswerBasis(f.services, before);
  assert.equal(resultProof(before).readiness.complete, true);
  assert.equal((await readGeneratedAnswer(f.services, before))?.text, original.text);
  const delivery = await f.conversation.prepare(f.workId, actor);
  assert.equal(delivery?.text, original.text); assert.deepEqual(delivery?.context?.artifact, original.artifact);
  assert.ok(delivery?.context?.generatedAnswerDigest);
  await f.outbox.flush(f.workId, actor);
  const after = (await f.state.get(f.workId))!;
  assert.equal(generatedAnswerBasis(f.services, after), basis);
  assert.equal(after.obligations.find(value => value.kind === 'delivery')?.status, 'satisfied');
  assert.equal((await f.conversation.snapshot(f.workId, actor)).resultReady, true);
  assert.equal(await f.conversation.prepare(f.workId, actor), null);
  assert.equal([...f.sink.delivered.values()].filter(value => value.kind === 'result').length, 1);
});

for (const part of ['artifact', 'inputArtifact', 'replyArtifact'] as const) test(`same-length raw ${part} corruption cannot prepare or send generated text`, async () => {
  const f = await fixture(), refs = await f.adopt();
  await f.conversation.prepare(f.workId, actor);
  f.flags.corrupt = refs[part].id;
  assert.equal(await readGeneratedAnswer(f.services, (await f.state.get(f.workId))!), null);
  assert.equal((await f.conversation.snapshot(f.workId, actor)).resultReady, false);
  await f.outbox.flush(f.workId, actor);
  assert.equal([...f.sink.delivered.values()].filter(value => value.kind === 'result').length, 0);
  assert.equal((await f.state.deliveries(f.workId)).find(value => value.kind === 'result')?.status, 'superseded');
});

test('a replacement answer with unchanged evidence gets a new result ID and supersedes the old outbound answer', async () => {
  const f = await fixture(); await f.adopt('첫 답변');
  const old = (await f.conversation.prepare(f.workId, actor))!;
  await f.adopt('수정한 답변', '2');
  const current = (await f.conversation.prepare(f.workId, actor))!;
  assert.notEqual(current.id, old.id);
  assert.equal(current.context?.evidenceDigest, old.context?.evidenceDigest);
  assert.notEqual(current.context?.generatedAnswerDigest, old.context?.generatedAnswerDigest);
  await f.outbox.flush(f.workId, actor);
  const deliveries = await f.state.deliveries(f.workId);
  assert.equal(deliveries.find(value => value.id === old.id)?.status, 'superseded');
  assert.equal(deliveries.find(value => value.id === current.id)?.status, 'delivered');
  assert.deepEqual([...f.sink.delivered.values()].filter(value => value.kind === 'result').map(value => value.text), ['수정한 답변']);
});

for (const changed of ['assessment', 'call', 'prompt', 'session', 'business obligation'] as const) test(`${changed} change cannot reuse the accepted generated candidate`, async () => {
  const f = await fixture(); await f.adopt(); await f.conversation.prepare(f.workId, actor);
  await transact(f.services, f.workId, `change-${changed}`, 'test_source_changed', {}, next => {
    if (changed === 'assessment') next.generatedAnswer!.assessment.rationale = 'Changed without an original model reply.';
    if (changed === 'call') next.modelCalls[0]!.status = 'rejected';
    if (changed === 'prompt') next.generatedAnswer!.promptDigest = '0'.repeat(64);
    if (changed === 'session') next.conversation!.session!.scope.sessionId = 'other-session';
    if (changed === 'business obligation') next.obligations.push({ id: 'review', kind: 'evidence', reason: 'new source required', status: 'pending', wakeKey: null, dueAt: null });
  });
  assert.equal(await generatedAnswerCurrent(f.services, (await f.state.get(f.workId))!), false);
  await f.outbox.flush(f.workId, actor);
  assert.equal([...f.sink.delivered.values()].filter(value => value.kind === 'result').length, 0);
});

for (const source of ['session', 'memory', 'sources'] as const) test(`external ${source} currentness loss after prepare blocks dispatch without a work revision change`, async () => {
  const f = await fixture(source === 'memory'); await f.adopt();
  await f.conversation.prepare(f.workId, actor);
  const revision = (await f.state.get(f.workId))!.revision;
  f.flags[source] = false;
  assert.equal((await f.conversation.snapshot(f.workId, actor)).resultReady, false);
  assert.equal((await f.state.get(f.workId))!.revision, revision);
  await f.outbox.flush(f.workId, actor);
  assert.equal([...f.sink.delivered.values()].filter(value => value.kind === 'result').length, 0);
  if (source === 'memory') assert.ok(f.flags.memoryChecks > 0);
});

test('outbox rejects a substituted outbound body even when candidate references and response ID match', async () => {
  const f = await fixture(); await f.adopt(); const delivery = (await f.conversation.prepare(f.workId, actor))!;
  await transact(f.services, f.workId, 'substitute-outbound', 'test_delivery_changed', {}, () => [{ ...delivery, text: 'Unverified substituted content' }]);
  await f.outbox.flush(f.workId, actor);
  assert.equal([...f.sink.delivered.values()].filter(value => value.kind === 'result').length, 0);
  assert.equal((await f.state.deliveries(f.workId)).find(value => value.id === delivery.id)?.status, 'superseded');
});

test('delivery rechecks source currentness after claiming and cannot acknowledge a late stale response', async () => {
  const f = await fixture(); await f.adopt(); const delivery = (await f.conversation.prepare(f.workId, actor))!;
  const originalCurrent = f.services.generatedAnswers!.current;
  f.services.generatedAnswers!.current = async (state, input, options) => {
    const outgoing = (await f.state.deliveries(f.workId)).find(value => value.id === delivery.id);
    return outgoing?.status !== 'sending' && await originalCurrent(state, input, options);
  };
  await f.outbox.flush(f.workId, actor);
  assert.equal([...f.sink.delivered.values()].filter(value => value.kind === 'result').length, 0);
  assert.equal((await f.state.get(f.workId))!.obligations.find(value => value.kind === 'delivery')?.status, 'pending');
});

test('request source text and bound agent identity are verified independently of a permissive source adapter', async () => {
  const f = await fixture(); const refs = await f.adopt();
  const current = (await f.state.get(f.workId))!;
  const bytes = await f.artifacts.get(refs.inputArtifact, current.policy);
  const original = JSON.parse(new TextDecoder().decode(bytes));
  for (const field of ['text', 'agentId']) {
    const tampered = structuredClone(original);
    if (field === 'text') tampered.turn.packet.session.entries[0].text = 'Different user request';
    else tampered.turn.prompt.profile.agentId = 'foreign-agent';
    if (field === 'agentId') {
      const { digest: _digest, ...body } = tampered.turn.prompt;
      tampered.turn.prompt.digest = f.services.digester.digest(asJson(body));
    }
    const ref: ArtifactRef = await f.artifacts.put(new TextEncoder().encode(JSON.stringify(tampered)),
      { tenantId: actor.tenantId, labels: ['internal'], mediaType: 'application/json' });
    await transact(f.services, f.workId, `tamper-original-${field}`, 'test_original_replaced', {}, state => {
      state.generatedAnswer!.inputArtifact = ref; state.modelCalls[0]!.inputArtifact = ref;
      state.generatedAnswer!.promptDigest = tampered.turn.prompt.digest; state.modelCalls[0]!.agentTurnPromptDigest = tampered.turn.prompt.digest;
    });
    assert.equal(await readGeneratedAnswer(f.services, (await f.state.get(f.workId))!), null);
  }
});

test('needs-work candidates can inform another turn but cannot prepare or deliver a final response', async () => {
  const f = await fixture(); const original = await f.adopt('아직 보완할 초안입니다.', '1', { ...assessment, verdict: 'needs_work', missing: ['Requested example is missing.'] });
  const current = (await f.state.get(f.workId))!;
  assert.equal((await readGeneratedAnswerCandidate(f.services, current))?.text, original.text);
  assert.equal(await readGeneratedAnswer(f.services, current), null);
  assert.equal(resultProof(current).readiness.complete, false);
  assert.equal(await f.conversation.prepare(f.workId, actor), null);
  f.flags.corrupt = original.artifact.id;
  assert.equal(await readGeneratedAnswerCandidate(f.services, current), null);
});

test('a new prepared answer cannot deliver copied draft text after its prior source is corrupted without a state change', async () => {
  const f = await fixture();
  const draft = await f.adopt('보완해야 할 초안', '1', { ...assessment, verdict: 'needs_work', missing: ['Example'] });
  const previous = (await f.state.get(f.workId))!.generatedAnswer!;
  await f.adopt('초안을 보완한 최종 답변', '2', assessment, { callId: previous.callId, artifact: draft.artifact,
    result: { kind: 'answer', text: draft.text, evidenceIds: previous.evidenceIds, assessment: previous.assessment } });
  const delivery = await f.conversation.prepare(f.workId, actor);
  assert.equal(delivery?.text, '초안을 보완한 최종 답변');
  const revision = (await f.state.get(f.workId))!.revision;
  f.flags.corrupt = draft.artifact.id;
  assert.equal(await readGeneratedAnswer(f.services, (await f.state.get(f.workId))!), null);
  assert.equal((await f.conversation.snapshot(f.workId, actor)).resultReady, false);
  assert.equal((await f.state.get(f.workId))!.revision, revision);
  await f.outbox.flush(f.workId, actor);
  assert.equal([...f.sink.delivered.values()].filter(value => value.kind === 'result').length, 0);
  assert.equal((await f.state.deliveries(f.workId)).find(value => value.id === delivery?.id)?.status, 'superseded');
});

test('a later applied input preserves the first request, and an omitted old raw request still requires original-source validation', async () => {
  const f = await fixture(); await f.followUp(); await f.adopt('후속 설명을 반영한 답변');
  assert.equal((await readGeneratedAnswer(f.services, (await f.state.get(f.workId))!))?.text, '후속 설명을 반영한 답변');
  f.flags.omitOriginal = true;
  await f.adopt('원 요청은 별도 저장소에서 대조한 답변', '2');
  assert.equal((await readGeneratedAnswer(f.services, (await f.state.get(f.workId))!))?.text, '원 요청은 별도 저장소에서 대조한 답변');
  f.flags.originalRequest = false;
  assert.equal(await readGeneratedAnswer(f.services, (await f.state.get(f.workId))!), null);
});

const viewAccess = { channel: 'test' as const, conversationId: 'chat-1', destination: 'local', recipientId: actor.principalId, allowDiagnostics: false };
function reader(f: Awaited<ReturnType<typeof fixture>>) {
  return new WorkViewService({ state: { get: id => f.state.get(id), deliveries: id => f.state.deliveries(id),
    recentEventMetadata: (id, query) => f.state.recentEventMetadata(id, query) }, artifacts: { get: (ref, policy) => f.artifacts.get(ref, policy) },
    digester: f.services.digester, sessions: f.services.sessions, personalMemories: f.services.personalMemories, generatedAnswers: f.services.generatedAnswers });
}
test('read-only work view shows the generated body and withholds the old prepared body after candidate replacement', async () => {
  const f = await fixture(); await f.adopt('화면에 표시할 답변'); await f.conversation.prepare(f.workId, actor);
  const view = reader(f), revision = (await f.state.get(f.workId))!.revision;
  const first = await view.read(f.workId, actor, viewAccess, { level: 'conversation' });
  assert.equal(first.kind, 'snapshot');
  if (first.kind !== 'snapshot') assert.fail('snapshot expected');
  assert.equal(first.view.progress.resultReady, true);
  assert.deepEqual(first.view.messages.filter(value => value.kind === 'result').map(value => value.text), ['화면에 표시할 답변']);
  assert.equal((await f.state.get(f.workId))!.revision, revision, 'projection cannot commit or execute');
  await f.adopt('아직 전달을 준비하지 않은 새 답변', '2');
  const replaced = await view.read(f.workId, actor, viewAccess, { level: 'conversation' });
  assert.equal(replaced.kind, 'snapshot');
  if (replaced.kind !== 'snapshot') assert.fail('snapshot expected');
  assert.equal(replaced.view.progress.resultReady, false);
  assert.deepEqual(replaced.view.messages.filter(value => value.kind === 'result'), []);
});

test('work view cursor cannot retain a generated response after personal-memory currentness changes externally', async () => {
  const f = await fixture(true); await f.adopt(); await f.conversation.prepare(f.workId, actor);
  const view = reader(f), first = await view.read(f.workId, actor, viewAccess, { level: 'conversation' });
  assert.equal(first.kind, 'snapshot');
  const revision = (await f.state.get(f.workId))!.revision;
  f.flags.memory = false;
  const changed = await view.read(f.workId, actor, viewAccess, { level: 'conversation', cursor: first.cursor });
  assert.equal(changed.kind, 'snapshot');
  if (changed.kind !== 'snapshot') assert.fail('changed snapshot expected');
  assert.equal(changed.view.progress.analysisReady, false); assert.equal(changed.view.progress.resultReady, false);
  assert.deepEqual(changed.view.messages.filter(value => value.kind === 'result'), []);
  assert.equal((await f.state.get(f.workId))!.revision, revision);
});
