import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeRuntime } from '../application/compose-runtime.js';
import { PlanningRuntime } from '../application/planning-runtime.js';
import { ContextFrameStore } from '../application/context-store.js';
import { knowledgeInputsCurrent, refreshKnowledge } from '../application/knowledge-state.js';
import { retainedKnowledgeDependencies } from '../application/knowledge-validity.js';
import { personalMemoryDigest } from '../application/personal-memory-context.js';
import { DataLifecycleService } from '../application/data-lifecycle.js';
import { decide } from '../domain/control.js';
import type { ModelCallOptions, ModelReply, Planner } from '../application/ports.js';
import type { ContextPacket } from '../domain/model.js';
import type { PersonalMemoryRef, TrustedKnowledgeActor } from '../domain/knowledge.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';
import { FixtureReadTool } from '../infrastructure/fakes.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { actor, scenario, request, initialize } from './session-flow-helpers.js';

const remembered = '개인 기억: 답변은 한국어 세 문장으로 시작한다.';
class DelayedPlanner implements Planner {
  identity = { provider: 'synthetic', model: 'memory-context', revision: '1' };
  destination = 'local';
  capabilities = { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 100000 };
  inputs: ContextPacket[] = [];
  private entered!: () => void;
  readonly started = new Promise<void>(resolve => { this.entered = resolve; });
  private finish!: (reply: ModelReply) => void;
  estimateInput(packet: ContextPacket, options: ModelCallOptions) {
    const bytes = Buffer.byteLength(JSON.stringify({ packet, options }));
    return { bytes, tokens: Math.ceil(bytes / 3), method: 'synthetic_memory_fixture' };
  }
  async propose(packet: ContextPacket): Promise<ModelReply> {
    this.inputs.push(structuredClone(packet)); this.entered();
    return new Promise(resolve => { this.finish = resolve; });
  }
  release() {
    const packet = this.inputs.at(-1)!;
    this.finish({ status: 'ok', provider: this.identity.provider, model: this.identity.model, inputTokens: 11, outputTokens: 7,
      proposal: { baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision, basePlanRevision: packet.plan?.revision ?? 0,
        reason: 'Synthetic selected-memory plan', hypotheses: [], tasks: [{ id: 'read', description: 'Read a synthetic document', toolId: 'fixture.read', toolVersion: '1',
          input: { evidenceIds: ['doc-current'] }, dependsOn: [], effect: 'read', maxAttempts: 1, satisfies: packet.goal.criteria.map(c => c.id) }] } });
  }
}
async function setup(t: TestContext, backend: 'sqlite' | 'file-journal' = 'sqlite', personalMemory: 'sqlite' | 'documents' = 'sqlite') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'personal-memory-context-'))); mkdirSync(join(base, 'engine'), { mode: 0o700 }); initialize(base, backend, 'agent', personalMemory);
  const hostOptions = { identityRegistryDirectory: join(base, 'registry') };
  let stores = await openAgentStores(new FileAgentProfileStore(join(base, 'engine')), join(base, 'agent'), undefined, hostOptions);
  const planner = new DelayedPlanner();
  const trusted: TrustedKnowledgeActor = { ...actor, agentId: stores.profile.identity.agentId, allowedLabels: scenario.policy.allowedLabels,
    allowedDestinations: ['local'], allowedScopes: [scenario.goal.scope], allowedNamespaces: ['personal'], canPublish: false, canReview: false };
  const compose = () => composeRuntime({ services: { state: stores.state, artifacts: stores.artifacts, sink: stores.channel, tools: [new FixtureReadTool(scenario.evidence)],
    planner, ids: new RandomIds(), digester: new Sha256Digester(), clock: { now: () => Date.now() } }, schemas: new AjvSchemas(),
    guidanceSource: { list: async () => [], read: async () => { throw new Error('no_guidance'); } }, session: { repository: stores.sessions, agentId: stores.profile.identity.agentId },
    knowledge: { repository: stores.knowledge, actors: { current: async () => structuredClone(trusted) } }, owner: 'personal-memory-context', enablePlanning: false });
  const c = await compose();
  const xSession = await c.sessions!.open(actor, { channel: 'test', conversationId: 'x', newSession: true });
  const x = await c.sessions!.accept(actor, { sessionId: xSession.scope.sessionId, rawText: remembered, request: request('remember-source') });
  const memory = await c.personalKnowledge!(actor);
  const saved = await memory.remember({ id: 'response-format', commandId: 'remember-format', title: '응답 형식',
    source: { sessionId: xSession.scope.sessionId, messageId: 'remember-source', quote: remembered }, expiresAt: null });
  const ref: PersonalMemoryRef = { ...saved.card.owner!, tenantId: actor.tenantId, id: saved.card.id, revision: saved.card.revision };
  const ySession = await c.sessions!.open(actor, { channel: 'test', conversationId: 'y', newSession: true });
  const y = await c.sessions!.accept(actor, { sessionId: ySession.scope.sessionId, rawText: '새 업무의 문서를 확인해 줘.', request: request('new-work') });
  const select = async (commandId = 'select-format', refs = [ref]) => {
    const state = await c.runtime.state(y.workId);
    return c.personalMemories!.select(y.workId, actor, { commandId, refs, expectedGoalRevision: state.goal.revision, expectedStateRevision: state.revision });
  };
  t.after(async () => { await stores.close(); rmSync(base, { recursive: true, force: true }); });
  const reopen = async () => { await stores.close(); stores = await openAgentStores(new FileAgentProfileStore(join(base, 'engine')), join(base, 'agent'), undefined, hostOptions); return compose(); };
  return { c, planner, x, y, xSession, ySession, memory, ref, select, reopen, trusted, stores: () => stores };
}

for (const backend of ['sqlite', 'file-journal'] as const) for (const personalMemory of ['sqlite', 'documents'] as const) {
  test(`${backend}/${personalMemory}: explicit personal recall reaches the real packet, frame and reopened resume without copying the old session`, async t => {
    const h = await setup(t, backend, personalMemory), before = await h.c.runtime.state(h.y.workId);
    await h.select();
    const state = await h.c.runtime.state(h.y.workId);
    assert.equal(state.attempts.length, 0); assert.deepEqual(state.budget.used, before.budget.used);
    assert.equal(retainedKnowledgeDependencies(state).length, 1); assert.equal(await knowledgeInputsCurrent(h.c.services, state), true);
    const prepared = await h.c.context.prepare(state, { callId: 'selected-packet', maxOutputTokens: 1024, maxInputBytes: 65536, maxInputTokens: 100000 });
    assert.equal(prepared.packet.personalMemory?.entries[0]?.body, remembered);
    assert.equal(prepared.frame.basis.personalMemoryDigest, personalMemoryDigest(h.c.services, state));
    assert.equal(prepared.packet.personalMemory?.interpretation, 'user_requested_memory_not_verified_evidence');
    assert.ok(!JSON.stringify(prepared.packet.session).includes(remembered));
    assert.doesNotMatch(JSON.stringify(prepared.packet.personalMemory), /actorDigest|policyDigest|knowledgeDependencies/);
    const resume = await h.c.recovery.restore(h.y.workId, actor), reopened = await h.reopen();
    const restored = await reopened.recovery.restore(h.y.workId, actor, resume.artifact);
    assert.equal(restored.packet.context.personalMemory?.entries[0]?.body, remembered);
    assert.equal(restored.packet.workId, h.y.workId); assert.notEqual(h.x.workId, h.y.workId);
    assert.equal(h.planner.inputs.length, 0);
  });
}

test('omitted, forged or unavailable personal context cannot stage or validate a selected work frame', async t => {
  const h = await setup(t); await h.select(); const state = await h.c.runtime.state(h.y.workId);
  const prepared = await h.c.context.prepare(state, { callId: 'source-frame', maxOutputTokens: 1024, maxInputBytes: 65536, maxInputTokens: 100000 });
  const missing = structuredClone(prepared.packet); delete missing.personalMemory;
  assert.equal(await h.c.context.sourcesCurrent(missing, state), false);
  const forged = structuredClone(prepared.frame); forged.packet.personalMemory!.entries[0]!.body = 'forged memory';
  assert.equal(await h.c.context.sourcesCurrent(forged.packet, state), false);
  await assert.rejects(new ContextFrameStore(h.c.services).stage(state, forged), /context_state_changed/);
  delete h.c.services.personalMemories;
  await assert.rejects(h.c.context.prepare(state, { callId: 'provider-missing', maxOutputTokens: 1024, maxInputBytes: 65536, maxInputTokens: 100000 }), /personal_memory_unavailable/);
});

test('selection is idempotent and refuses a same-goal newer input, foreign owner, and a cancelled work', async t => {
  const h = await setup(t), state = await h.c.runtime.state(h.y.workId);
  const args = { commandId: 'once', refs: [h.ref], expectedGoalRevision: state.goal.revision, expectedStateRevision: state.revision };
  assert.equal((await h.c.personalMemories!.select(h.y.workId, actor, args)).applied, true);
  assert.equal((await h.c.personalMemories!.select(h.y.workId, actor, args)).applied, false);
  await assert.rejects(h.c.personalMemories!.select(h.y.workId, actor, { ...args, refs: [] }), /idempotency_conflict/);
  const selected = await h.c.runtime.state(h.y.workId);
  await h.c.sessions!.input(actor, { sessionId: h.ySession.scope.sessionId, messageId: 'later-input', workId: h.y.workId, rawText: '새 지시를 추가한다.', expectedGoalRevision: selected.goal.revision });
  await assert.rejects(h.c.personalMemories!.select(h.y.workId, actor, { ...args, commandId: 'late', expectedStateRevision: selected.revision }), /personal_memory_selection_stale/);
  await assert.rejects(h.select('foreign', [{ ...h.ref, agentId: 'different-agent' }]), /personal_memory_unavailable/);
  const latest = await h.c.runtime.state(h.y.workId);
  await h.c.runtime.command(h.y.workId, 'cancel-work', actor, latest.goal.revision, { kind: 'cancel', reason: 'Synthetic cancellation' });
  await assert.rejects(h.select('after-cancel'), /personal_memory_not_selectable/);
});

for (const personalMemory of ['sqlite', 'documents'] as const) test(`${personalMemory}: forgetting during a real delayed synthetic model call rejects the reply while preserving reported usage`, async t => {
  const h = await setup(t, 'sqlite', personalMemory); await h.select(); const planning = new PlanningRuntime(h.c.services, h.c.contracts, h.c.runtime, 'delayed-personal');
  const call = await planning.reserve(h.y.workId), pending = planning.execute(h.y.workId, call.id);
  await h.planner.started;
  assert.equal(h.planner.inputs[0]?.personalMemory?.entries[0]?.body, remembered);
  await h.memory.forgetPersonal({ id: h.ref.id, expectedRevision: h.ref.revision, commandId: 'forget-format', reason: 'User explicitly forgot this preference' });
  h.planner.release(); await pending;
  assert.equal(await planning.adopt(h.y.workId, call.id), false);
  const state = await h.c.runtime.state(h.y.workId), recorded = state.modelCalls.find(value => value.id === call.id)!;
  assert.equal(recorded.usageStatus, 'reported'); assert.equal(recorded.inputTokens, 11); assert.equal(recorded.outputTokens, 7);
  assert.equal(state.budget.used.tokens, 18); assert.notEqual(recorded.status, 'accepted'); assert.equal(state.personalMemorySelection, undefined);
  const restored = await h.c.recovery.restore(h.y.workId, actor);
  assert.equal(restored.packet.context.personalMemory, undefined); assert.ok(!JSON.stringify(restored.packet).includes(remembered));
});

test('a changed revision invalidates an existing frame and the replacement needs a fresh explicit selection', async t => {
  const h = await setup(t); await h.select(); const state = await h.c.runtime.state(h.y.workId);
  const prepared = await h.c.context.prepare(state, { callId: 'old-selection', maxOutputTokens: 1024, maxInputBytes: 65536, maxInputTokens: 100000 });
  const correction = '정정한 기억: 첫 요약 뒤에 자세한 설명을 붙인다.';
  await h.c.sessions!.input(actor, { sessionId: h.xSession.scope.sessionId, messageId: 'correct-source', workId: h.x.workId, rawText: correction, expectedGoalRevision: 1 });
  const next = await h.memory.revisePersonal({ id: h.ref.id, expectedRevision: h.ref.revision, commandId: 'correct-format', reason: 'New explicit preference', title: '응답 형식',
    source: { sessionId: h.xSession.scope.sessionId, messageId: 'correct-source', quote: correction } });
  assert.equal(await h.c.context.sourcesCurrent(prepared.packet, state), false);
  await refreshKnowledge(h.c.services, h.y.workId);
  await h.select('replace-format', [{ ...h.ref, revision: next.revision }]);
  const fresh = await h.c.runtime.state(h.y.workId);
  const changed = await h.c.context.prepare(fresh, { callId: 'new-selection', maxOutputTokens: 1024, maxInputBytes: 65536, maxInputTokens: 100000 });
  assert.equal(changed.packet.personalMemory!.entries[0]!.body, correction);
  assert.notEqual(changed.frame.basis.personalMemoryDigest, prepared.frame.basis.personalMemoryDigest);
  const review = fresh.obligations.find(value => value.status === 'pending' && value.reason === 'knowledge_dependency_changed_review_required')!;
  assert.ok(review, 'reselection alone does not retroactively resolve the earlier quarantine review');
  const waiting = decide(fresh, h.c.services.clock.now());
  assert.equal(waiting.kind, 'wait'); assert.equal(waiting.reason, 'pending_obligation');
  await h.c.runtime.command(h.y.workId, 'resolve-corrected-memory-review', actor, fresh.goal.revision,
    { kind: 'resolve', obligationId: review.id, reason: 'The new source and explicitly selected revision were checked; old derived copies remain quarantined.' });
  const resolved = await h.c.runtime.state(h.y.workId);
  assert.equal(resolved.obligations.find(value => value.id === review.id)?.status, 'satisfied');
  assert.equal(resolved.personalMemoryReviewRequired, true);
  const replanning = decide(resolved, h.c.services.clock.now());
  assert.equal(replanning.kind, 'replan'); assert.equal(replanning.reason, 'personal_memory_requires_review');
});

for (const selection of ['clear', 'recall'] as const) {
  test(`${selection} preserves a pre-existing work-memory quarantine review and its completion gate`, async t => {
    const h = await setup(t), before = await h.c.runtime.state(h.y.workId);
    assert.equal(before.personalMemorySelection, undefined);
    const invalidated = await new DataLifecycleService(h.c.services).invalidateKnowledge(h.y.workId, before.revision);
    const review = invalidated.obligations.find(value => value.reason === 'knowledge_dependency_changed_review_required')!;
    assert.equal(review.status, 'pending');
    const generation = invalidated.dataLifecycle!.generation;

    await h.select(`select-after-work-quarantine-${selection}`, selection === 'clear' ? [] : [h.ref]);
    const selected = await h.c.runtime.state(h.y.workId);
    assert.equal(selected.dataLifecycle!.generation, generation, 'the unrelated review was created before this selection');
    assert.deepEqual(selected.obligations.find(value => value.id === review.id), review,
      'personal recall or clearing does not resolve a pre-existing work-memory review');
    assert.equal(selected.personalMemoryReviewRequired, true, 'a new selection still needs its own plan review');
    assert.equal((await h.c.personalMemories!.selected(h.y.workId, actor)).available, true);
    const control = decide(selected, h.c.services.clock.now());
    assert.equal(control.kind, 'wait');
    assert.equal(control.reason, 'pending_obligation', 'the prior review remains a gate even after a usable personal selection');
    assert.equal(h.planner.inputs.length, 0);
  });
}

test('replacing a selection waives only its newly created quarantine review', async t => {
  const h = await setup(t), before = await h.c.runtime.state(h.y.workId);
  const invalidated = await new DataLifecycleService(h.c.services).invalidateKnowledge(h.y.workId, before.revision);
  const priorReview = invalidated.obligations.find(value => value.reason === 'knowledge_dependency_changed_review_required')!;
  await h.select('recall-with-prior-review');
  await h.select('replace-with-prior-review');
  const selected = await h.c.runtime.state(h.y.workId);
  assert.equal(selected.obligations.find(value => value.id === priorReview.id)?.status, 'pending');
  const createdReview = selected.obligations.find(value => value.id === `data-review:${selected.dataLifecycle!.generation}`)!;
  assert.notEqual(createdReview.id, priorReview.id);
  assert.equal(createdReview.reason, 'knowledge_dependency_changed_review_required');
  assert.equal(createdReview.status, 'waived');
  assert.equal(selected.personalMemoryReviewRequired, true);
  const control = decide(selected, h.c.services.clock.now());
  assert.equal(control.kind, 'wait'); assert.equal(control.reason, 'pending_obligation');
  assert.equal((await h.c.personalMemories!.selected(h.y.workId, actor)).available, true);
  assert.equal(h.planner.inputs.length, 0);
});
