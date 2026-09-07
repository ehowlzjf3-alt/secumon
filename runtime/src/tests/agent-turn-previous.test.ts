import test from 'node:test';
import assert from 'node:assert/strict';
import type { ArtifactRef, ModelCall } from '../domain/model.js';
import type { AgentTurnInput, AgentTurnReply } from '../application/agent-turn-types.js';
import type { ArtifactStore } from '../application/ports.js';
import { agentTurnPreviousAnswerCurrent } from '../application/agent-turn-previous.js';
import { generatedAnswerBasis } from '../application/generated-answer.js';
import { newWork } from '../application/new-work.js';
import { asJson } from '../application/plan-validator.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { Sha256Digester } from '../infrastructure/digest.js';

/** Synthetic accepted originals; no provider is invoked and no model-quality claim is made. */
async function fixture() {
  const digester = new Sha256Digester(), originals = new MemoryArtifactStore();
  const failures = { missing: '', corrupt: '' }, reads: string[] = [];
  const artifacts: ArtifactStore = { put: (bytes, attributes) => originals.put(bytes, attributes), exists: ref => originals.exists(ref),
    async get(ref, policy) { reads.push(ref.id); if (failures.missing === ref.id) throw new Error('artifact_unavailable');
      const bytes = await originals.get(ref, policy); if (failures.corrupt === ref.id && bytes.length) bytes[0] = bytes[0]! ^ 1; return bytes; } };
  const services = { artifacts, digester }, state = newWork({ id: 'previous-work', now: 1,
    goal: { revision: 1, description: '한 가지 예시를 설명해 줘.', scope: 'general', mode: 'auto', criteria: [],
      responseRequirement: { version: 1, requestMessageId: 'message-1', requestTextDigest: digester.digest('한 가지 예시를 설명해 줘.'), format: 'text' } },
    policy: { tenantId: 'tenant-1', principalId: 'user-1', allowedTools: [], allowedLabels: ['internal'], allowedDestinations: ['model'], allowWrites: false },
    limits: { toolCalls: 1, modelCalls: 5, tokens: 10000, replans: 1, wallTimeMs: 60000 } });
  const basis = { scope: { tenantId: 'tenant-1', principalId: 'user-1', agentId: 'agent-1', sessionId: 'session-1' },
    input: { messageId: 'message-1', sequence: 1, digest: digester.digest('applied-input') } };
  state.conversation = { bindings: [], primaryBindingId: 'test-binding', completionRequiresDelivery: false, result: null, session: basis };
  const promptBody = { version: 1 as const, instructions: 'Complete the requested explanation.', profile: { agentId: 'agent-1', purpose: '', skillsMode: 'off' as const } };
  const source: AgentTurnInput = { version: 1, prompt: { ...promptBody, digest: digester.digest(asJson(promptBody)) },
    packet: { schemaVersion: 1, workId: state.id, stateRevision: state.revision, goal: state.goal, policy: state.policy,
      plan: null, hypotheses: [], obligations: [], evidence: [], activeToolIds: [], purpose: 'respond',
      session: { schemaVersion: 1, basis, head: { revision: 1, throughSequence: 1, digest: digester.digest('head'), policyDigest: digester.digest('policy') },
        entries: [], interpretation: 'conversation_history_not_verified_evidence' } } };
  const attrs = { tenantId: state.policy.tenantId, labels: ['internal'], mediaType: 'application/json' };
  const result = { kind: 'answer' as const, text: '예시를 추가해야 하는 초안입니다.', evidenceIds: [],
    assessment: { type: 'model_self_review' as const, verdict: 'needs_work' as const, rationale: 'The requested example is still missing.',
      missing: ['Example'], counterarguments: ['This draft is incomplete.'] } };
  const reply: AgentTurnReply = { status: 'ok', result, provider: 'synthetic', model: 'synthetic-turn', inputTokens: 10, outputTokens: 5 };
  const options = { callId: 'source-call', maxOutputTokens: 1000, tools: [] };
  const inputArtifact = await artifacts.put(new TextEncoder().encode(JSON.stringify({ turn: source, options })), attrs);
  const replyArtifact = await artifacts.put(new TextEncoder().encode(JSON.stringify(reply)), attrs);
  const artifact = await artifacts.put(new TextEncoder().encode(result.text), { ...attrs, mediaType: 'text/plain' });
  const call: ModelCall = { id: options.callId, purpose: 'agent_turn', semanticVersion: 4, agentTurnPromptDigest: source.prompt.digest,
    provider: reply.provider, model: reply.model, adapterRevision: '1', destination: 'model', owner: 'worker', goalRevision: 1,
    baseStateRevision: 1, basePlanRevision: 0, semanticDigest: generatedAnswerBasis(services, state), inputArtifact, replyArtifact,
    inputEstimate: 10, maxOutputTokens: 1000, tokenReservation: 1010, inputTokens: 10, outputTokens: 5, usageStatus: 'reported',
    status: 'accepted', startedAt: 1, leaseUntil: 1000, finishedAt: 2, expired: false, outcome: 'ok', reason: 'synthetic_accepted' };
  state.modelCalls.push(call);
  state.generatedAnswer = { id: 'source-answer', callId: call.id, goalRevision: 1, planRevision: 0, dataGeneration: 0, input: basis,
    inputArtifact, promptDigest: source.prompt.digest, basisDigest: generatedAnswerBasis(services, state), artifact,
    evidenceIds: [], observedEvidenceIds: [], assessment: result.assessment, createdAt: 2 };
  const turn: AgentTurnInput = { ...structuredClone(source), previousAnswer: { callId: call.id, artifact, result } };
  return { services, state, source, turn, call, options, attrs, failures, reads, refs: { artifact, inputArtifact, replyArtifact } };
}

test('one previous needs-work draft remains verifiable after the current candidate has been replaced', async () => {
  const f = await fixture();
  assert.equal(await agentTurnPreviousAnswerCurrent(f.services, f.state, f.turn), true);
  const nextBody = await f.services.artifacts.put(new TextEncoder().encode('예시를 보완한 다음 답변'), { ...f.attrs, mediaType: 'text/plain' });
  f.state.generatedAnswer = { ...f.state.generatedAnswer!, id: 'next-answer', callId: 'next-call', artifact: nextBody };
  assert.equal(await agentTurnPreviousAnswerCurrent(f.services, f.state, f.turn), true);
  const before = JSON.stringify(f.state);
  f.failures.missing = f.refs.replyArtifact.id;
  assert.equal(await agentTurnPreviousAnswerCurrent(f.services, f.state, f.turn), false);
  assert.equal(JSON.stringify(f.state), before, 'missing original is detected without a work revision change or mutation');
});

for (const mode of ['missing', 'corrupt'] as const) for (const part of ['artifact', 'inputArtifact', 'replyArtifact'] as const) {
  test(`previous ${part} ${mode} cannot survive as copied text in the next input`, async () => {
    const f = await fixture(), before = JSON.stringify(f.state);
    assert.equal(await agentTurnPreviousAnswerCurrent(f.services, f.state, f.turn), true);
    f.failures[mode] = f.refs[part].id;
    assert.equal(await agentTurnPreviousAnswerCurrent(f.services, f.state, f.turn), false);
    assert.equal(JSON.stringify(f.state), before);
  });
}

test('previous draft cannot reuse a foreign, blocked or now unauthorized input or body reference', async () => {
  const f = await fixture();
  for (const part of ['artifact', 'inputArtifact', 'replyArtifact'] as const) {
    const state = structuredClone(f.state), turn = structuredClone(f.turn);
    const ref = part === 'artifact' ? turn.previousAnswer!.artifact : state.modelCalls[0]![part]!;
    ref.tenantId = 'foreign-tenant';
    assert.equal(await agentTurnPreviousAnswerCurrent(f.services, state, turn), false);
  }
  const blocked = structuredClone(f.state);
  blocked.dataLifecycle = { generation: 1, blockedArtifactIds: [f.refs.inputArtifact.id], changes: [] };
  assert.equal(await agentTurnPreviousAnswerCurrent(f.services, blocked, f.turn), false);
  const reduced = structuredClone(f.state); reduced.policy.allowedLabels = [];
  assert.equal(await agentTurnPreviousAnswerCurrent(f.services, reduced, f.turn), false);
});

test('previous call status, identity and current goal or plan cannot be replaced by an accepted body copy', async () => {
  const f = await fixture();
  for (const mutation of [
    (call: ModelCall) => { call.status = 'received'; },
    (call: ModelCall) => { call.expired = true; },
    (call: ModelCall) => { call.outcome = 'error'; },
    (call: ModelCall) => { call.purpose = 'planning'; },
    (call: ModelCall) => { call.goalRevision++; },
    (call: ModelCall) => { call.basePlanRevision++; },
  ]) {
    const state = structuredClone(f.state); mutation(state.modelCalls[0]!);
    assert.equal(await agentTurnPreviousAnswerCurrent(f.services, state, f.turn), false);
  }
  const duplicate = structuredClone(f.state); duplicate.modelCalls.push(structuredClone(duplicate.modelCalls[0]!));
  assert.equal(await agentTurnPreviousAnswerCurrent(f.services, duplicate, f.turn), false);
  const foreignSession = structuredClone(f.state); foreignSession.conversation!.session!.scope.sessionId = 'another-session';
  assert.equal(await agentTurnPreviousAnswerCurrent(f.services, foreignSession, f.turn), false);
});

test('previous copied assessment and an alternative current-candidate body ref must match the originals exactly', async () => {
  const f = await fixture(), altered = structuredClone(f.turn);
  altered.previousAnswer!.result.assessment.missing = [];
  altered.previousAnswer!.result.assessment.verdict = 'satisfied';
  assert.equal(await agentTurnPreviousAnswerCurrent(f.services, f.state, altered), false);
  const otherRef = await f.services.artifacts.put(new TextEncoder().encode(f.turn.previousAnswer!.result.text),
    { ...f.attrs, mediaType: 'text/plain', labels: [] });
  const substituted = structuredClone(f.turn); substituted.previousAnswer!.artifact = otherRef;
  assert.equal(await agentTurnPreviousAnswerCurrent(f.services, f.state, substituted), false, 'same bytes do not replace the pinned current-candidate ref');
  const invalid = await f.services.artifacts.put(new Uint8Array([0xc3, 0x28]), { ...f.attrs, mediaType: 'text/plain' });
  const malformed = structuredClone(f.turn); malformed.previousAnswer!.artifact = invalid;
  const state = structuredClone(f.state); state.generatedAnswer!.artifact = invalid;
  assert.equal(await agentTurnPreviousAnswerCurrent(f.services, state, malformed), false, 'valid byte hash cannot make invalid UTF8 into source text');
});

test('no previous draft performs no reads; a prior input names an older draft without recursively reopening that chain', async () => {
  const f = await fixture();
  assert.equal(await agentTurnPreviousAnswerCurrent(f.services, f.state, f.source), true); assert.equal(f.reads.length, 0);
  const olderRef: ArtifactRef = { ...f.refs.artifact, id: 'unavailable-older-draft' };
  const olderInput = { ...f.source, previousAnswer: { ...f.turn.previousAnswer!, callId: 'older-call', artifact: olderRef } };
  f.call.inputArtifact = await f.services.artifacts.put(new TextEncoder().encode(JSON.stringify({ turn: olderInput, options: f.options })), f.attrs);
  assert.equal(await agentTurnPreviousAnswerCurrent(f.services, f.state, f.turn), true);
  assert.equal(f.reads.includes(olderRef.id), false, 'only the directly reused input, body and reply are reopened');
});
