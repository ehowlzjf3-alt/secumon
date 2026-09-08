import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactRef, Delivery, Evidence, Policy, WorkState } from '../domain/model.js';
import type { WorkViewAccess, WorkViewOptions, WorkViewResult } from '../domain/work-view.js';
import type { ArtifactStore, StateRepository } from '../application/ports.js';
import type { WorkActor } from '../application/work-resources.js';
import { WorkViewService } from '../application/work-view-service.js';
import { ConversationService } from '../application/conversation-service.js';
import { OutboxDispatcher } from '../application/outbox.js';
import { DataLifecycleService } from '../application/data-lifecycle.js';
import { transact } from '../application/work-transactions.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { FakeClock, FakeSink, FixtureReadTool, ScriptedPlanner } from '../infrastructure/fakes.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { adapters, attempt, initial, openRepository, type Adapter } from './state-conformance-helpers.js';

const actor = { tenantId: 'tenant-a', principalId: 'person-a' };
const access: WorkViewAccess = { channel: 'test', conversationId: 'primary-chat', destination: 'local', recipientId: actor.principalId, allowDiagnostics: false };
function snapshot(result: WorkViewResult) { assert.equal(result.kind, 'snapshot'); if (result.kind !== 'snapshot') throw new Error('expected_snapshot'); return result; }
async function fixture(t: TestContext, adapter: Adapter, legacy = false) {
  const directory = await mkdtemp(join(tmpdir(), 'work-view-')); let repository = openRepository(adapter, directory);
  t.after(async () => { await repository.close(); await rm(directory, { recursive: true, force: true }); });
  const storage: StateRepository = { get: id => repository.get(id), receipt: (id, commandId) => repository.receipt(id, commandId), commit: request => repository.commit(request),
    eventPage: (...args) => repository.eventPage(...args), recentEventMetadata: (...args) => repository.recentEventMetadata(...args), conversationWorkPage: query => repository.conversationWorkPage(query),
    events: (id, after) => repository.events(id, after), deliveries: id => repository.deliveries(id), workIdsForConversation: (...args) => repository.workIdsForConversation(...args),
    runnable: now => repository.runnable(now), close: () => repository.close() };
  const objects = new MemoryArtifactStore(); const sink = new FakeSink(); const planner = new ScriptedPlanner([]); const tool = new FixtureReadTool([]);
  const services = { state: storage, artifacts: objects, clock: new FakeClock(1000), digester: new Sha256Digester(), ids: new RandomIds(), sink, planner, tools: [tool] };
  const conversation = new ConversationService(services); const seed = initial();
  const labels = ['synthetic', 'secret']; const policy: Policy = { ...seed.policy, allowedLabels: labels, allowedDestinations: ['local', 'secondary'],
    ...(legacy ? {} : { disclosure: { revision: 'v1', maxReleasesPerWork: 10, maxReleasedBytesPerWork: 100000, destinations: [
      { destination: 'local', surfaces: ['screen', 'channel', 'log'], allowedLabels: labels },
      { destination: 'secondary', surfaces: ['screen', 'channel', 'log'], allowedLabels: labels },
    ] } }) };
  const accepted = await conversation.accept(actor, { messageId: 'first-request', binding: { ...actor, channel: access.channel, conversationId: access.conversationId, destination: access.destination, recipientId: access.recipientId },
    goal: seed.goal, policy, limits: seed.budget.limits, completionRequiresDelivery: false });
  const deniedReads = new Set<string>(); const corruptReads = new Set<string>();
  let getHook: (() => Promise<void>) | null = null; let artifactHook: ((ref: ArtifactRef) => Promise<void>) | null = null;
  let knowledgeValid = true; let knowledgeHook: (() => void) | null = null;
  const calls = { commit: 0, put: 0, model: 0, tool: 0, send: 0, lookup: 0, artifacts: 0, knowledge: 0 };
  const forbidden = (key: 'commit' | 'put' | 'model' | 'tool' | 'send' | 'lookup'): never => { calls[key]++; throw new Error(`unexpected_${key}`); };
  const guardedState: StateRepository = { ...storage, async get(id) { await getHook?.(); return storage.get(id); }, commit: async () => forbidden('commit') };
  const guardedArtifacts: ArtifactStore = { async get(ref, policy) { calls.artifacts++; await artifactHook?.(ref); if (deniedReads.has(ref.id)) throw new Error('PRIVATE_ARTIFACT_ERROR');
    const bytes = await objects.get(ref, policy); return corruptReads.has(ref.id) ? new Uint8Array(bytes.byteLength) : bytes; }, exists: ref => objects.exists(ref), put: async () => forbidden('put') };
  const readServices = { state: guardedState, artifacts: guardedArtifacts, digester: services.digester,
    knowledge: { async validate() { calls.knowledge++; knowledgeHook?.(); return knowledgeValid; } },
    planner: { propose: () => forbidden('model') }, tools: [{ execute: () => forbidden('tool') }], sink: { send: () => forbidden('send'), lookup: () => forbidden('lookup') } };
  const view = new WorkViewService(readServices);
  let change = 0;
  const mutate = (edit: (state: WorkState) => Delivery[] | void) => transact(services, accepted.workId, `fixture-${++change}`, 'private_fixture_event', { privatePayload: 'RAW_EVENT_PAYLOAD' }, edit);
  return { workId: accepted.workId, services, view, conversation, policy, sink, planner, tool, calls, deniedReads, corruptReads, mutate,
    read: (options: WorkViewOptions = { level: 'conversation' }, viewer: WorkActor = actor, route: WorkViewAccess = access) => view.read(accepted.workId, viewer, route, options),
    setGetHook(hook: (() => Promise<void>) | null) { getHook = hook; }, setArtifactHook(hook: ((ref: ArtifactRef) => Promise<void>) | null) { artifactHook = hook; },
    setKnowledge(value: boolean) { knowledgeValid = value; }, setKnowledgeHook(hook: (() => void) | null) { knowledgeHook = hook; },
    async reopen() { await repository.close(); repository = openRepository(adapter, directory); },
    async result() {
      const artifact = await objects.put(new TextEncoder().encode('RAW_ORIGINAL_BYTES'), { tenantId: actor.tenantId, labels, mediaType: 'text/plain' });
      const evidence: Evidence = { id: 'evidence-1', tenantId: actor.tenantId, scope: seed.goal.scope, sourceId: 'source-1', lineageId: 'source-1', locator: 'fixture://verified-source',
        observedAt: 900, recordedAt: 1000, labels, coverage: 'complete', status: 'accepted', supersedes: [], derivedFrom: [], facts: { available: true }, artifact };
      await mutate(state => { state.evidence = [evidence]; state.artifacts.push(artifact); });
      const delivery = await conversation.prepare(accepted.workId, actor); assert.equal(delivery?.kind, 'result');
      return { artifact, evidence, delivery: delivery! };
    },
    async stateImage() { return { state: await storage.get(accepted.workId), events: await storage.events(accepted.workId, 0), deliveries: await storage.deliveries(accepted.workId) }; },
  };
}

for (const adapter of adapters) {
  test(`${adapter}: empty accepted work reads and reopens without executing, writing, or sending`, async t => {
    const f = await fixture(t, adapter); const before = await f.stateImage();
    const first = snapshot(await f.read()); assert.deepEqual(first.view.messages.map(message => message.kind), ['ack']); assert.equal(first.view.progress.resultReady, false);
    assert.equal(first.view.mode.requested, 'auto'); assert.equal(first.view.reply.observingPrimary, true); assert.equal(first.view.details, undefined); assert.equal(first.view.diagnostics, undefined);
    assert.deepEqual(await f.read({ level: 'conversation', cursor: first.cursor }), { kind: 'unchanged', cursor: first.cursor });
    await f.reopen(); assert.equal((await f.read({ level: 'conversation', cursor: first.cursor })).kind, 'unchanged');
    assert.deepEqual(await f.stateImage(), before);
    assert.deepEqual(Object.fromEntries(Object.entries(f.calls).filter(([key]) => !['artifacts', 'knowledge'].includes(key))), { commit: 0, put: 0, model: 0, tool: 0, send: 0, lookup: 0 });
    assert.equal(f.planner.inputs.length, 0); assert.equal(f.tool.invocations.length, 0); assert.equal(f.sink.delivered.size, 0);
  });

  test(`${adapter}: ownership, exact route, current read restriction, and diagnostics are distinct checks`, async t => {
    const f = await fixture(t, adapter); const cursor = snapshot(await f.read()).cursor;
    for (const viewer of [{ ...actor, tenantId: 'other' }, { ...actor, principalId: 'other' }, { ...actor, allowedLabels: ['synthetic'] }, { ...actor, allowedDestinations: [] }])
      await assert.rejects(f.read({ level: 'conversation', cursor }, viewer), /^Error: work_view_denied$/);
    for (const route of [{ ...access, channel: 'cli' as const }, { ...access, conversationId: 'another-chat' }, { ...access, destination: 'secondary' }, { ...access, recipientId: 'other' }])
      await assert.rejects(f.read({ level: 'conversation', cursor }, actor, route), /^Error: work_view_denied$/);
    await assert.rejects(f.read({ level: 'diagnostics' }), /^Error: work_view_diagnostics_denied$/);
    const diagnostics = snapshot(await f.read({ level: 'diagnostics' }, actor, { ...access, allowDiagnostics: true })); assert.ok(diagnostics.view.diagnostics); assert.ok(diagnostics.view.details);
    await f.mutate(state => { state.policy.disclosure!.destinations[0]!.surfaces = ['screen', 'channel']; });
    await assert.rejects(f.read({ level: 'diagnostics', cursor: diagnostics.cursor }, actor, { ...access, allowDiagnostics: true }), /^Error: work_view_diagnostics_denied$/);
    await f.mutate(state => { state.policy.disclosure!.destinations[0]!.surfaces = ['channel', 'log']; });
    await assert.rejects(f.read({ level: 'conversation', cursor }), /^Error: work_view_denied$/);
  });

  test(`${adapter}: legacy read labels also protect retained text`, async t => {
    const f = await fixture(t, adapter, true); const first = snapshot(await f.read());
    await assert.rejects(f.read({ level: 'conversation', cursor: first.cursor }, { ...actor, allowedLabels: ['synthetic'] }), /^Error: work_view_denied$/);
    assert.equal(snapshot(await f.read()).view.title, initial().goal.description);
  });

  test(`${adapter}: cursors bind level, route, actor rights, and work without moving the primary reply`, async t => {
    const f = await fixture(t, adapter); const secondRoute: WorkViewAccess = { ...access, channel: 'web', conversationId: 'second-chat', destination: 'secondary' };
    await f.conversation.attach(f.workId, actor, { ...actor, channel: secondRoute.channel, conversationId: secondRoute.conversationId, destination: secondRoute.destination, recipientId: secondRoute.recipientId });
    const image = await f.stateImage(); const first = snapshot(await f.read());
    for (const cursor of ['not-a-cursor', 'wv9:unsupported', 'wv1:old']) assert.equal((await f.read({ level: 'conversation', cursor })).kind, 'snapshot');
    const details = snapshot(await f.read({ level: 'details', cursor: first.cursor })); assert.notEqual(details.cursor, first.cursor);
    const secondary = snapshot(await f.read({ level: 'conversation', cursor: first.cursor }, actor, secondRoute)); assert.equal(secondary.view.reply.observingPrimary, false); assert.equal(secondary.view.reply.channel, 'test');
    assert.doesNotMatch(JSON.stringify(secondary.view), /primary-chat|second-chat|"destination"|"recipientId"/);
    assert.notEqual(snapshot(await f.read({ level: 'conversation', cursor: first.cursor }, { ...actor, allowedTools: [] })).cursor, first.cursor);
    assert.deepEqual(await f.stateImage(), image);
    const seed = initial(); const other = await f.conversation.accept(actor, { messageId: 'other-request', binding: { ...actor, channel: access.channel, conversationId: access.conversationId, destination: access.destination, recipientId: access.recipientId },
      goal: { ...seed.goal, description: 'Another work only' }, policy: f.policy, limits: seed.budget.limits, completionRequiresDelivery: false });
    const otherView = snapshot(await f.view.read(other.workId, actor, access, { level: 'conversation', cursor: first.cursor })); assert.notEqual(otherView.cursor, first.cursor); assert.equal(otherView.view.title, 'Another work only');
    await assert.rejects(f.read({ level: 'conversation', cursor: 'x'.repeat(257) }), /^Error: work_view_invalid_request$/);
  });

  test(`${adapter}: verified prepared results remain distinct from pending and unknown delivery`, async t => {
    const f = await fixture(t, adapter); const result = await f.result(); const before = await f.stateImage();
    const pending = snapshot(await f.read()); assert.equal(pending.view.progress.analysisReady, true); assert.equal(pending.view.progress.resultReady, true);
    assert.equal(pending.view.progress.resultDelivery, 'pending'); assert.equal(pending.view.messages.find(message => message.kind === 'result')!.deliveryStatus, 'pending');
    assert.match(pending.view.messages.at(-1)!.text, /true.*evidence-1/); assert.doesNotMatch(JSON.stringify(pending.view), /RAW_ORIGINAL_BYTES/); assert.deepEqual(await f.stateImage(), before);
    f.sink.outcome = 'unknown'; await new OutboxDispatcher(f.services, 'fixture-outbox').flush(f.workId, actor);
    const unknown = snapshot(await f.read({ level: 'conversation', cursor: pending.cursor })); assert.equal(unknown.view.progress.resultDelivery, 'unknown'); assert.equal(unknown.view.messages.find(message => message.id === result.delivery.id)!.deliveryStatus, 'unknown');
    assert.equal(unknown.view.progress.resultReady, true);
    f.sink.outcome = 'delivered'; await new OutboxDispatcher(f.services, 'fixture-outbox').flush(f.workId, actor);
    await new OutboxDispatcher(f.services, 'fixture-outbox').flush(f.workId, actor);
    const delivered = snapshot(await f.read()); assert.equal(delivered.view.progress.resultDelivery, 'delivered');
  });

  test(`${adapter}: missing source and corrupt response withhold a same-revision result before cursor matching`, async t => {
    const f = await fixture(t, adapter); const result = await f.result(); const first = snapshot(await f.read({ level: 'details' })); const revision = first.view.revision;
    f.deniedReads.add(result.artifact.id);
    const missing = snapshot(await f.read({ level: 'details', cursor: first.cursor })); assert.equal(missing.view.revision, revision); assert.equal(missing.view.progress.resultReady, false);
    assert.equal(missing.view.progress.analysisReady, false); assert.equal(missing.view.details!.evidence.length, 0); assert.equal(missing.view.messages.some(message => message.kind === 'result'), false);
    f.deniedReads.clear(); f.corruptReads.add(result.delivery.context!.artifact!.id);
    const corrupt = snapshot(await f.read({ level: 'details', cursor: first.cursor })); assert.equal(corrupt.view.progress.analysisReady, true); assert.equal(corrupt.view.progress.resultReady, false);
    assert.equal(corrupt.view.progress.resultDelivery, 'unavailable'); assert.equal(corrupt.view.revision, revision);
    assert.equal((await f.services.state.get(f.workId))!.revision, revision);
  });

  test(`${adapter}: originals, goals, cancellation, and hypothesis review invalidate historical replies`, async t => {
    const f = await fixture(t, adapter); await f.result();
    await f.mutate(state => { state.hypotheses = [{ id: 'hypothesis', question: 'Is it available?', claim: 'It is available', predictedObservation: 'available=true', falsifier: 'available=false', status: 'supported', supportIds: ['evidence-1'], counterIds: [], reason: 'verified' }];
      state.hypothesisAssessment = { goalRevision: state.goal.revision, evidenceIds: ['evidence-1'] }; });
    const supported = snapshot(await f.read({ level: 'details' })); assert.equal(supported.view.details!.hypotheses[0]!.status, 'supported');
    await new DataLifecycleService(f.services).change(f.workId, actor, 'retract-source', { action: 'retract', evidenceIds: ['evidence-1'], expectedGeneration: 0, reason: 'Original correction review', replacement: null });
    const retracted = snapshot(await f.read({ level: 'details', cursor: supported.cursor })); assert.equal(retracted.view.progress.resultReady, false); assert.equal(retracted.view.details!.hypotheses[0]!.reviewRequired, true);
    assert.equal(retracted.view.details!.hypotheses[0]!.status, null); assert.equal(retracted.view.details!.hypotheses[0]!.supportCount, null);
    await f.mutate(state => { state.goal.revision++; state.goal.description = 'New goal'; state.evidence = []; state.hypotheses = []; });
    const revised = snapshot(await f.read()); assert.equal(revised.view.goalRevision, 2); assert.equal(revised.view.title, 'New goal'); assert.equal(revised.view.messages.some(message => message.kind === 'result'), false);
    await f.mutate(state => { state.status = 'cancelled'; state.statusReason = 'Stopped by user'; });
    const cancelled = snapshot(await f.read()); assert.equal(cancelled.view.progress.status, 'cancelled'); assert.deepEqual(cancelled.view.messages.map(message => message.kind), ['ack']);
  });

  test(`${adapter}: only the current pending question is displayed and resolved questions disappear`, async t => {
    const f = await fixture(t, adapter); await f.mutate(state => { state.status = 'waiting'; state.obligations.push({ id: 'clarify', kind: 'response', reason: 'Which record should be checked?', status: 'pending', wakeKey: 'user', dueAt: null }); });
    const delivery = await f.conversation.prepare(f.workId, actor); assert.equal(delivery!.kind, 'question');
    const first = snapshot(await f.read()); assert.equal(first.view.progress.pendingQuestions, 1); assert.match(first.view.messages.at(-1)!.text, /Which record/); assert.equal(first.view.messages.at(-1)!.deliveryStatus, 'pending');
    await f.mutate(state => { state.obligations[0]!.status = 'satisfied'; });
    const resolved = snapshot(await f.read({ level: 'conversation', cursor: first.cursor })); assert.equal(resolved.view.progress.pendingQuestions, 0); assert.equal(resolved.view.messages.some(message => message.kind === 'question'), false);
  });

  test(`${adapter}: losing a separate hypothesis basis withholds the result consistently at every view level`, async t => {
    const f = await fixture(t, adapter); const { evidence: goalEvidence, artifact: goalArtifact } = await f.result();
    const basisArtifact = await f.services.artifacts.put(new TextEncoder().encode('RAW_HYPOTHESIS_BASIS'), { tenantId: actor.tenantId, labels: goalEvidence.labels, mediaType: 'text/plain' });
    const basis: Evidence = { ...goalEvidence, id: 'hypothesis-basis', sourceId: 'background-source', lineageId: 'background-source', locator: 'fixture://hypothesis-basis',
      facts: { background: 'supporting observation unrelated to the goal criterion' }, artifact: basisArtifact };
    await f.mutate(state => { state.evidence.push(basis); state.artifacts.push(basisArtifact);
      state.hypotheses = [{ id: 'hypothesis', question: 'Is the background consistent?', claim: 'The background is consistent', predictedObservation: 'Supporting observation',
        falsifier: 'Contradicting observation', status: 'supported', supportIds: [basis.id], counterIds: [], reason: 'Basis verified' }];
      state.hypothesisAssessment = { goalRevision: state.goal.revision, evidenceIds: [goalEvidence.id, basis.id].sort() }; });
    const before = await f.stateImage(); assert.deepEqual(before.state!.conversation!.result!.evidenceIds, [goalEvidence.id]);
    const previous = new Map<string, string>();
    for (const level of ['conversation', 'details', 'diagnostics'] as const) {
      const value = snapshot(await f.read({ level }, actor, { ...access, allowDiagnostics: true })); previous.set(level, value.cursor);
      assert.equal(value.view.progress.analysisReady, true); assert.equal(value.view.progress.resultReady, true);
      assert.equal(value.view.messages.filter(message => message.kind === 'result').length, 1);
      if (value.view.details) assert.equal(value.view.details.hypotheses[0]!.reviewRequired, false);
    }
    f.deniedReads.add(basisArtifact.id); assert.equal(await f.services.artifacts.exists(goalArtifact), true);
    for (const level of ['conversation', 'details', 'diagnostics'] as const) {
      const changed = snapshot(await f.read({ level, cursor: previous.get(level)! }, actor, { ...access, allowDiagnostics: true }));
      assert.equal(changed.view.revision, before.state!.revision); assert.equal(changed.view.progress.analysisReady, false); assert.equal(changed.view.progress.resultReady, false);
      assert.equal(changed.view.messages.some(message => message.kind === 'result'), false);
      if (changed.view.details) { assert.equal(changed.view.details.hypotheses[0]!.reviewRequired, true); assert.equal(changed.view.details.hypotheses[0]!.status, null);
        assert.equal(changed.view.details.hypotheses[0]!.supportCount, null); assert.deepEqual(changed.view.details.evidence.map(record => record.id), [goalEvidence.id]); }
    }
    f.deniedReads.clear(); let basisReads = 0;
    f.setArtifactHook(async ref => { if (ref.id === basisArtifact.id && ++basisReads === 2) f.deniedReads.add(ref.id); });
    const raced = snapshot(await f.read({ level: 'conversation', cursor: previous.get('conversation')! }, actor, { ...access, allowDiagnostics: true }));
    assert.equal(raced.view.progress.analysisReady, false); assert.equal(raced.view.progress.resultReady, false); assert.equal(raced.view.messages.some(message => message.kind === 'result'), false);
    assert.deepEqual(await f.stateImage(), before);
  });

  test(`${adapter}: a derived evidence card requires every original ancestor to remain available`, async t => {
    const f = await fixture(t, adapter); const { evidence, artifact } = await f.result();
    await f.mutate(state => { state.evidence.push({ ...evidence, id: 'derived', sourceId: 'derivation', lineageId: 'derivation', locator: 'fixture://derived', derivedFrom: [evidence.id], artifact: null }); });
    const before = snapshot(await f.read({ level: 'details' })); assert.deepEqual(before.view.details!.evidence.map(record => record.id), ['evidence-1', 'derived']);
    f.deniedReads.add(artifact.id);
    const missing = snapshot(await f.read({ level: 'details', cursor: before.cursor })); assert.equal(missing.view.details!.evidence.length, 0); assert.equal(missing.view.progress.resultReady, false);
    assert.equal(missing.view.revision, before.view.revision);
  });

  test(`${adapter}: knowledge changes reject current and repeated reads without refreshing state`, async t => {
    const f = await fixture(t, adapter); await f.mutate(state => { const read = attempt('succeeded'); read.knowledgeDependencies = [{ tenantId: actor.tenantId, knowledgeId: 'remembered', knowledgeRevision: 1, actorDigest: 'a'.repeat(64), parents: [],
      sources: [{ workId: 'source-work', evidenceId: 'original', sourceVersion: 'b'.repeat(64), generation: 0, workRevision: 1, policyDigest: 'c'.repeat(64) }] }]; state.attempts.push(read); });
    const first = snapshot(await f.read()); const before = await f.stateImage(); f.setKnowledge(false);
    await assert.rejects(f.read({ level: 'conversation', cursor: first.cursor }), /^Error: work_view_knowledge_changed$/); assert.deepEqual(await f.stateImage(), before);
    f.setKnowledge(true); let checks = 0; f.setKnowledgeHook(() => { if (++checks === 2) f.setKnowledge(false); });
    await assert.rejects(f.read({ level: 'conversation', cursor: first.cursor }), /^Error: work_view_knowledge_changed$/); assert.deepEqual(await f.stateImage(), before);
  });

  test(`${adapter}: revocation during artifact reads or final state checks prevents unchanged and snapshots`, async t => {
    const f = await fixture(t, adapter); await f.result(); const first = snapshot(await f.read());
    f.setArtifactHook(async () => { f.setArtifactHook(null); await f.mutate(state => { state.policy.disclosure!.destinations[0]!.surfaces = ['channel']; }); });
    await assert.rejects(f.read({ level: 'conversation', cursor: first.cursor }), /^Error: work_view_denied$/);
    await f.mutate(state => { state.policy.disclosure!.destinations[0]!.surfaces = ['channel', 'screen']; });
    let reads = 0; f.setGetHook(async () => { if (++reads === 3) { f.setGetHook(null); await f.mutate(state => { state.conversation!.bindings[0]!.conversationId = 'revoked-chat'; }); } });
    await assert.rejects(f.read({ level: 'conversation', cursor: first.cursor }), /^Error: work_view_denied$/);
  });

  test(`${adapter}: a disappearing original during projection is revalidated before returning a cached cursor`, async t => {
    const f = await fixture(t, adapter); const { artifact } = await f.result(); const first = snapshot(await f.read());
    let sourceReads = 0; f.setArtifactHook(async ref => { if (ref.id === artifact.id && ++sourceReads === 2) f.deniedReads.add(ref.id); });
    const changed = snapshot(await f.read({ level: 'conversation', cursor: first.cursor })); assert.equal(changed.view.revision, first.view.revision); assert.equal(changed.view.progress.resultReady, false);
    assert.equal(changed.view.messages.some(message => message.kind === 'result'), false);
  });

  test(`${adapter}: detail and diagnostic cards are bounded and omit raw inputs, outputs, event payloads, and controls`, async t => {
    const f = await fixture(t, adapter); await f.result();
    await f.mutate(state => { state.goal.description = `\x1b[31m${'긴 목표 '.repeat(1000)}\x1b[0m`; state.statusReason = `\x1b[2J${'상태 '.repeat(1000)}`;
      state.plan = { revision: 1, goalRevision: 1, reason: 'Plan overview', tasks: Array.from({ length: 23 }, (_, index) => ({ id: `task-${index}`, description: 'Current task', toolId: 'fixture.read', toolVersion: '1', input: { secret: 'RAW_TOOL_INPUT' }, effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: [] })) };
      state.hypotheses = Array.from({ length: 23 }, (_, index) => ({ id: `hypothesis-${index}`, question: 'Current question', claim: 'Claim', predictedObservation: 'HIDDEN_PREDICTION', falsifier: 'HIDDEN_FALSIFIER', status: 'open', supportIds: [], counterIds: [], reason: 'HIDDEN_INTERNAL_REASON' })); });
    const image = await f.stateImage(); const details = snapshot(await f.read({ level: 'diagnostics' }, actor, { ...access, allowDiagnostics: true })).view;
    assert.ok(details.title.length <= 160); assert.ok(details.progress.reason.length <= 256); assert.equal(details.details!.plan!.tasks.length, 20); assert.equal(details.details!.omitted.tasks, 3);
    assert.equal(details.details!.hypotheses.length, 20); assert.equal(details.details!.omitted.hypotheses, 3); assert.ok(details.diagnostics!.events.length > 0);
    assert.doesNotMatch(JSON.stringify(details), /RAW_TOOL_INPUT|RAW_ORIGINAL_BYTES|RAW_EVENT_PAYLOAD|HIDDEN_PREDICTION|HIDDEN_FALSIFIER|HIDDEN_INTERNAL_REASON|\\u001b/);
    assert.deepEqual(Object.keys(details.diagnostics!.events[0]!).sort(), ['at', 'revision', 'sequence', 'type']); assert.deepEqual(await f.stateImage(), image);
  });
}
