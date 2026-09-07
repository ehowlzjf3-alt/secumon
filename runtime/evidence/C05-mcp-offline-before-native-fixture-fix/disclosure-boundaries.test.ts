import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DisclosurePolicy } from '../domain/disclosure.js';
import type { ContextPacket, Delivery, Policy, TaskSpec } from '../domain/model.js';
import type { ArtifactStore, ModelCallOptions, Planner, Tool } from '../application/ports.js';
import type { RuntimeServices } from '../application/services.js';
import { newWork } from '../application/new-work.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { ToolBroker, BrokerError } from '../application/tool-broker.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { PlanningRuntime } from '../application/planning-runtime.js';
import { ContextCompiler } from '../application/context-compiler.js';
import { buildContextPacket } from '../application/context-packet.js';
import { ConversationService } from '../application/conversation-service.js';
import { OutboxDispatcher } from '../application/outbox.js';
import { BudgetDelegationService } from '../application/budget-delegation.js';
import { transact } from '../application/work-transactions.js';
import { StructuredPlannerAdapter } from '../infrastructure/structured-planner.js';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { FakeClock } from '../infrastructure/fakes.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { adapters, advance, command, initial, openRepository, type Adapter } from './state-conformance-helpers.js';

const sentinel = 'SYNTHETIC_RESTRICTED_BODY_ONLY';
const actor = { tenantId: 'tenant-a', principalId: 'person-a' };
function policy(): Policy {
  const disclosure: DisclosurePolicy = { revision: 'boundary-v1', maxReleasesPerWork: 10, maxReleasedBytesPerWork: 10000, destinations: [
    { destination: 'local', surfaces: ['model', 'tool', 'channel'], allowedLabels: ['synthetic', 'secret'] },
    { destination: 'external', surfaces: ['model', 'tool', 'channel'], allowedLabels: ['synthetic'] },
  ] };
  return { ...actor, allowedTools: ['fixture.read'], allowedLabels: ['synthetic', 'secret'], allowedDestinations: ['local', 'external'], allowWrites: false, disclosure };
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function setup(t: TestContext, adapter: Adapter, destination = 'external', artifacts: ArtifactStore = new MemoryArtifactStore()) {
  const directory = await mkdtemp(join(tmpdir(), 'disclosure-boundary-'));
  const state = openRepository(adapter, directory);
  t.after(async () => { await state.close(); await rm(directory, { recursive: true, force: true }); });
  const estimates: string[] = []; const models: string[] = []; const tools: string[] = []; const sends: Delivery[] = []; const lookups: Delivery[] = [];
  const planner: Planner = { identity: { provider: 'synthetic', model: 'boundary', revision: '1' }, destination,
    capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 1000000 },
    estimateInput(packet, options) { const text = JSON.stringify({ packet, options }); estimates.push(text); return { tokens: text.length, bytes: Buffer.byteLength(text), method: 'synthetic' }; },
    async propose(packet, _signal, options) { models.push(JSON.stringify({ packet, options })); return { status: 'error', code: 'synthetic_result', inputTokens: 0, outputTokens: 0 }; } };
  const tool: Tool = { definition: { provider: 'fixture', id: 'fixture.read', version: '1', description: `Read ${sentinel}`, effect: 'read',
    destination, labels: ['synthetic'], inputSchema: { type: 'object' }, outputSchema: { type: 'object' } },
  async execute(task, context) { tools.push(JSON.stringify({ task, policy: context.policy })); return { resultId: `${context.attemptId}:result`, attemptId: context.attemptId,
    status: 'success', effectState: 'none', evidence: [], artifacts: [], output: { observed: true }, error: null, cursor: null, coverage: 'complete' }; } };
  const services: RuntimeServices = { state, artifacts, planner, tools: [tool], clock: new FakeClock(1000), ids: new RandomIds(), digester: new Sha256Digester(),
    sink: { capabilities: { idempotentSend: true }, async send(delivery) { sends.push(structuredClone(delivery)); return { status: 'unknown' }; },
      async lookup(delivery) { lookups.push(structuredClone(delivery)); return { status: 'unknown' }; } } };
  const seed = initial();
  const work = newWork({ id: seed.id, goal: { ...seed.goal, description: sentinel }, policy: policy(),
    limits: { ...seed.budget.limits, tokens: 1000000, wallTimeMs: 120000 }, now: services.clock.now() });
  assert.equal((await state.commit(command(work, 'accept'))).kind, 'committed');
  const contracts = new ToolContracts([tool], new AjvSchemas()); const execution = new ExecutionRuntime(services, contracts, 'executor');
  const planning = new PlanningRuntime(services, contracts, execution, 'planner');
  return { directory, services, state, contracts, execution, planning, workId: work.id, estimates, models, tools, sends, lookups };
}
async function dispatched(f: Awaited<ReturnType<typeof setup>>) {
  const work = await f.execution.state(f.workId);
  const task: TaskSpec = { id: 'read', description: sentinel, toolId: 'fixture.read', toolVersion: '1', input: { query: sentinel },
    effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: [] };
  await f.execution.submitPlan(f.workId, 'plan', { baseStateRevision: work.revision, baseGoalRevision: work.goal.revision, basePlanRevision: 0,
    reason: 'Synthetic execution boundary', tasks: [task], hypotheses: [] });
  const attempt = await f.execution.reserve(f.workId, task.id); assert.equal(await f.execution.dispatch(f.workId, attempt.id), true);
  return attempt;
}
async function bound(f: Awaited<ReturnType<typeof setup>>, destination: string) {
  const conversation = new ConversationService(f.services); const seed = await f.execution.state(f.workId);
  const accepted = await conversation.accept(actor, { messageId: 'channel-request', binding: { ...actor, channel: 'test', conversationId: 'chat', recipientId: actor.principalId, destination },
    goal: seed.goal, policy: seed.policy, limits: seed.budget.limits, completionRequiresDelivery: false });
  return { conversation, workId: accepted.workId, outbox: new OutboxDispatcher(f.services, 'sender', 100) };
}

for (const adapter of adapters) {
  test(`${adapter}: restricted work reaches neither external estimator nor model even without an evidence body`, async t => {
    const f = await setup(t, adapter);
    await assert.rejects(f.planning.reserve(f.workId), /model_disclosure_denied/);
    await assert.rejects(new ContextCompiler(f.services, f.contracts).prepare(await f.execution.state(f.workId),
      { callId: 'direct-context', maxInputBytes: 65536, maxInputTokens: 100000, maxOutputTokens: 100 }), /model_disclosure_denied/);
    assert.deepEqual(f.estimates, []); assert.deepEqual(f.models, []);
    const state = await f.execution.state(f.workId); assert.equal(state.modelCalls.length, 0); assert.equal(state.budget.reservedTokens, 0);
  });

  test(`${adapter}: authorized internal model retains the floor through a forced compact and stored request`, async t => {
    const f = await setup(t, adapter, 'local'); const work = await f.execution.state(f.workId);
    const prepared = await f.planning.context.prepare(work, { callId: 'compact-check', maxInputBytes: 65536, maxInputTokens: 100000, maxOutputTokens: 100, forceCompact: true });
    assert.deepEqual(prepared.packet.disclosureLabels, ['synthetic', 'secret']);
    assert.deepEqual([...prepared.head.artifact.labels].sort(), ['secret', 'synthetic']);
    assert.equal(prepared.packet.goal.description, sentinel);
    const call = await f.planning.reserve(f.workId); await f.planning.execute(f.workId, call.id);
    assert.ok(f.estimates.length > 0); assert.equal(f.models.length, 1); assert.match(f.models[0]!, new RegExp(sentinel));
    assert.deepEqual([...call.inputArtifact.labels].sort(), ['secret', 'synthetic']);
  });

  test(`${adapter}: disclosure revoked during source assembly stops the estimator before it receives prose`, async t => {
    const store = new MemoryArtifactStore(); const entered = gate(); const release = gate(); let held = false;
    const artifacts: ArtifactStore = { put: store.put.bind(store), exists: store.exists.bind(store), async get(ref, policy) {
      const bytes = await store.get(ref, policy);
      if (!held && ref.mediaType === 'text/plain') { held = true; entered.resolve(); await release.promise; }
      return bytes;
    } };
    const f = await setup(t, adapter, 'local', artifacts);
    const original = await artifacts.put(new TextEncoder().encode(sentinel), { tenantId: actor.tenantId, labels: ['secret'], mediaType: 'text/plain' });
    await transact(f.services, f.workId, 'add-original', 'evidence_added', {}, state => { state.evidence.push({ id: 'source', tenantId: actor.tenantId,
      scope: state.goal.scope, sourceId: 'synthetic-source', lineageId: 'synthetic-source', locator: `fixture://${sentinel}`, observedAt: 900, recordedAt: 1000,
      labels: ['secret'], coverage: 'complete', status: 'accepted', supersedes: [], derivedFrom: [], facts: { note: sentinel }, artifact: original }); });
    const preparing = f.planning.context.prepare(await f.execution.state(f.workId), { callId: 'stale-estimator', maxInputBytes: 65536, maxInputTokens: 100000, maxOutputTokens: 100 });
    const rejected = assert.rejects(preparing, /context_state_changed/); await entered.promise;
    try { await transact(f.services, f.workId, 'revoke-before-estimate', 'policy_changed', {}, state => { state.policy.disclosure!.destinations = []; }); }
    finally { release.resolve(); }
    await rejected; assert.equal(f.estimates.length, 0); assert.equal(f.models.length, 0);
  });

  test(`${adapter}: revoked model disclosure cancels a stored request before adapter entry`, async t => {
    const f = await setup(t, adapter, 'local'); const call = await f.planning.reserve(f.workId);
    await transact(f.services, f.workId, 'revoke-model', 'policy_changed', {}, state => {
      state.policy.disclosure!.destinations.find(d => d.destination === 'local')!.surfaces = ['tool', 'channel'];
    });
    await assert.rejects(f.planning.execute(f.workId, call.id), /model_not_dispatchable/);
    assert.equal(f.models.length, 0);
  });

  test(`${adapter}: disclosure revoked during stored model input read stops the final transport`, async t => {
    const store = new MemoryArtifactStore(); const entered = gate(); const release = gate(); let held = false;
    const artifacts: ArtifactStore = { put: store.put.bind(store), exists: store.exists.bind(store), async get(ref, policy) {
      const bytes = await store.get(ref, policy); const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      if (!held && parsed['packet'] && parsed['options']) { held = true; entered.resolve(); await release.promise; }
      return bytes;
    } };
    const f = await setup(t, adapter, 'local', artifacts); const call = await f.planning.reserve(f.workId);
    const running = f.planning.execute(f.workId, call.id); await entered.promise;
    try { await transact(f.services, f.workId, 'revoke-during-read', 'policy_changed', {}, state => {
      state.policy.disclosure!.destinations.find(d => d.destination === 'local')!.allowedLabels = ['synthetic'];
    }); } finally { release.resolve(); }
    await running; assert.equal(f.models.length, 0);
    const state = await f.execution.state(f.workId); assert.equal(state.budget.reservedTokens, 0); assert.equal(state.budget.used.unmeasuredModelCalls, 0);
  });

  test(`${adapter}: tool access labels cannot authorize restricted task inputs to an external tool`, async t => {
    const f = await setup(t, adapter); const attempt = await dispatched(f);
    await assert.rejects(new ToolBroker(f.state, f.contracts, f.services.digester, f.services.clock).invoke(f.workId, attempt.id, 'executor', new AbortController().signal),
      error => error instanceof BrokerError && error.code === 'tool_disclosure_denied');
    assert.equal(f.tools.length, 0);
  });

  test(`${adapter}: read permission narrowing does not relabel old task prose as public`, async t => {
    const f = await setup(t, adapter); const attempt = await dispatched(f);
    await transact(f.services, f.workId, 'reduce-read-scope', 'policy_changed', {}, state => { state.policy.allowedLabels = ['synthetic']; });
    const state = await f.execution.state(f.workId); assert.deepEqual(state.disclosureLabels, ['synthetic', 'secret']);
    const reopened = openRepository(adapter, f.directory);
    try { assert.deepEqual((await reopened.get(f.workId))!.disclosureLabels, ['synthetic', 'secret']); } finally { await reopened.close(); }
    assert.equal(state.plan!.tasks[0]!.input['query'], sentinel);
    await assert.rejects(new ToolBroker(f.state, f.contracts, f.services.digester, f.services.clock).invoke(f.workId, attempt.id, 'executor', new AbortController().signal),
      /tool_disclosure_denied/);
    assert.equal(f.tools.length, 0);
  });

  test(`${adapter}: authorized internal tool receives one invocation after current disclosure check`, async t => {
    const f = await setup(t, adapter, 'local'); const attempt = await dispatched(f);
    await new ToolBroker(f.state, f.contracts, f.services.digester, f.services.clock).invoke(f.workId, attempt.id, 'executor', new AbortController().signal);
    assert.equal(f.tools.length, 1); assert.match(f.tools[0]!, new RegExp(sentinel));
  });

  test(`${adapter}: changed disclosure during asynchronous tool preflight stops adapter entry`, async t => {
    const f = await setup(t, adapter, 'local'); const attempt = await dispatched(f); const entered = gate(); const release = gate();
    const broker = new ToolBroker(f.state, f.contracts, f.services.digester, f.services.clock, async () => { entered.resolve(); await release.promise; return true; });
    const pending = broker.invoke(f.workId, attempt.id, 'executor', new AbortController().signal);
    const rejected = assert.rejects(pending, /broker_execution_not_current/); await entered.promise;
    try { await transact(f.services, f.workId, 'revoke-tool', 'policy_changed', {}, state => { state.policy.disclosure!.destinations = []; }); }
    finally { release.resolve(); }
    await rejected; assert.equal(f.tools.length, 0);
  });

  test(`${adapter}: denied channel cannot receive even a queued acknowledgement from restricted work`, async t => {
    const f = await setup(t, adapter); const chat = await bound(f, 'external');
    await chat.outbox.flush(chat.workId, actor); assert.equal(f.sends.length, 0); assert.equal(f.lookups.length, 0);
    assert.equal((await f.state.deliveries(chat.workId))[0]!.status, 'superseded');
    await assert.rejects(chat.conversation.prepare(chat.workId, actor), /channel_disclosure_denied/);
  });

  test(`${adapter}: disclosure revocation preserves unknown delivery and prevents full-body lookup`, async t => {
    const f = await setup(t, adapter, 'local'); const chat = await bound(f, 'local');
    await chat.outbox.flush(chat.workId, actor); assert.equal(f.sends.length, 1);
    assert.equal((await f.state.deliveries(chat.workId))[0]!.status, 'unknown');
    await transact(f.services, chat.workId, 'revoke-channel', 'policy_changed', {}, state => { state.policy.disclosure!.destinations = []; });
    await chat.outbox.flush(chat.workId, actor); assert.equal(f.sends.length, 1); assert.equal(f.lookups.length, 0);
    assert.equal((await f.state.deliveries(chat.workId))[0]!.status, 'unknown');
  });

  test(`${adapter}: still-authorized unknown delivery uses lookup without resending`, async t => {
    const f = await setup(t, adapter, 'local'); const chat = await bound(f, 'local');
    await chat.outbox.flush(chat.workId, actor); await chat.outbox.flush(chat.workId, actor);
    assert.equal(f.sends.length, 1); assert.equal(f.lookups.length, 1); assert.deepEqual(f.lookups[0]!.text, f.sends[0]!.text);
  });

  test(`${adapter}: policy changed during artifact check stops an unknown question lookup`, async t => {
    const store = new MemoryArtifactStore(); const entered = gate(); const release = gate(); let armed = false; let held = false;
    const artifacts: ArtifactStore = { put: store.put.bind(store), get: store.get.bind(store), async exists(ref) {
      const result = await store.exists(ref);
      if (armed && !held && ref.mediaType === 'text/plain') { held = true; entered.resolve(); await release.promise; }
      return result;
    } };
    const f = await setup(t, adapter, 'local', artifacts); const chat = await bound(f, 'local');
    const send = f.services.sink.send.bind(f.services.sink);
    f.services.sink.send = async delivery => delivery.kind === 'ack' ? { status: 'delivered', externalId: 'ack-receipt' } : send(delivery);
    await transact(f.services, chat.workId, 'long-question', 'question_required', {}, state => { state.obligations.push({ id: 'question', kind: 'response',
      reason: sentinel.repeat(500), status: 'pending', wakeKey: 'answer', dueAt: null }); });
    const question = await chat.conversation.prepare(chat.workId, actor); assert.ok(question?.context?.artifact);
    await chat.outbox.flush(chat.workId, actor); assert.equal(f.sends.length, 1); armed = true;
    const running = chat.outbox.flush(chat.workId, actor); await entered.promise;
    try { await transact(f.services, chat.workId, 'revoke-during-lookup-check', 'policy_changed', {}, state => { state.policy.disclosure!.destinations = []; }); }
    finally { release.resolve(); }
    await running; assert.equal(f.lookups.length, 0); assert.equal(f.sends.length, 1);
    assert.equal((await f.state.deliveries(chat.workId)).find(delivery => delivery.kind === 'question')!.status, 'unknown');
  });

  test(`${adapter}: child budget cannot omit or expand parent disclosure policy`, async t => {
    const f = await setup(t, adapter, 'local'); const budgets = new BudgetDelegationService(f.services); const parent = await f.execution.state(f.workId);
    for (const kind of ['omitted', 'labels', 'surface', 'count', 'bytes'] as const) {
      const child = structuredClone(parent.policy);
      if (kind === 'omitted') delete child.disclosure;
      else if (kind === 'labels') child.disclosure!.destinations.find(d => d.destination === 'external')!.allowedLabels.push('secret');
      else if (kind === 'surface') child.disclosure!.destinations[0]!.surfaces.push('a2a');
      else if (kind === 'count') child.disclosure!.maxReleasesPerWork++;
      else child.disclosure!.maxReleasedBytesPerWork++;
      await assert.rejects(budgets.createChild(f.workId, `child-${kind}`, actor, 1, { id: `child-${kind}`, goal: parent.goal, policy: child,
        limits: { toolCalls: 1, modelCalls: 1, tokens: 1000, replans: 1, wallTimeMs: 1000 } }), /budget_policy_escalation/);
      assert.equal(await f.state.get(`child-${kind}`), null);
    }
  });

  test(`${adapter}: child read-scope narrowing inherits the parent prose floor and blocks model export`, async t => {
    const f = await setup(t, adapter, 'local'); const budgets = new BudgetDelegationService(f.services); const parent = await f.execution.state(f.workId);
    const childPolicy = structuredClone(parent.policy); childPolicy.allowedLabels = ['synthetic'];
    const child = await budgets.createChild(f.workId, 'private-child', actor, 1, { id: 'private-child', goal: parent.goal, policy: childPolicy,
      limits: { toolCalls: 1, modelCalls: 1, tokens: 1000, replans: 1, wallTimeMs: 1000 } });
    assert.equal(child.goal.description, sentinel); assert.deepEqual(child.policy.allowedLabels, ['synthetic']);
    assert.deepEqual(child.disclosureLabels, ['secret', 'synthetic']);
    await assert.rejects(f.planning.reserve(child.id), /model_disclosure_denied/);
    assert.equal(f.models.length, 0); assert.equal(f.estimates.length, 0);
    const reopened = openRepository(adapter, f.directory);
    try { assert.deepEqual((await reopened.get(child.id))!.disclosureLabels, ['secret', 'synthetic']); } finally { await reopened.close(); }
  });

  test(`${adapter}: legacy parent cannot classify copied work prose by creating a boundary-enabled child`, async t => {
    const f = await setup(t, adapter); const legacy = initial('legacy-parent'); legacy.goal.description = sentinel;
    await f.state.commit(command(legacy, 'legacy-parent-genesis')); const childPolicy = structuredClone(legacy.policy); childPolicy.disclosure = policy().disclosure;
    await assert.rejects(new BudgetDelegationService(f.services).createChild(legacy.id, 'classified-child', actor, 1,
      { id: 'classified-child', goal: legacy.goal, policy: childPolicy, limits: { toolCalls: 1, modelCalls: 1, tokens: 1000, replans: 1, wallTimeMs: 1000 } }),
    /budget_disclosure_history_unclassified/);
    assert.equal(await f.state.get('classified-child'), null);
  });

  test(`${adapter}: floor and active policy cannot be removed by a direct state commit`, async t => {
    const f = await setup(t, adapter); const before = await f.execution.state(f.workId);
    for (const kind of ['remove-floor', 'reduce-floor', 'remove-policy'] as const) {
      const next = advance(before);
      if (kind === 'remove-floor') delete next.disclosureLabels;
      else if (kind === 'reduce-floor') { next.policy.allowedLabels = ['synthetic']; next.disclosureLabels = ['synthetic']; }
      else delete next.policy.disclosure;
      await assert.rejects(f.state.commit(command(next, kind)), /disclosure_(labels_narrowed|policy_removal_denied)/);
      assert.deepEqual(await f.state.get(f.workId), before);
    }
  });

  test(`${adapter}: classifying a preexisting legacy work requires explicit migration`, async t => {
    const f = await setup(t, adapter); const legacy = initial('legacy-work');
    await f.state.commit(command(legacy, 'legacy-genesis'));
    const next = advance(legacy); next.policy.disclosure = policy().disclosure; next.disclosureLabels = [...next.policy.allowedLabels];
    await assert.rejects(f.state.commit(command(next, 'late-classification')), /disclosure_history_unclassified/);
    assert.deepEqual(await f.state.get(legacy.id), legacy);
  });
}

test('memory state adapter applies the same floor transition guard as persistent adapters', async () => {
  const store = new MemoryStateRepository();
  try {
    const seed = initial(); const work = newWork({ id: seed.id, goal: seed.goal, policy: policy(), limits: seed.budget.limits, now: 1000 });
    await store.commit(command(work, 'genesis'));
    const next = advance(work); next.disclosureLabels = ['synthetic']; next.policy.allowedLabels = ['synthetic'];
    await assert.rejects(store.commit(command(next, 'reduce')), /disclosure_labels_narrowed/); assert.deepEqual(await store.get(work.id), work);
  } finally { await store.close(); }
});

test('direct structured adapter denies estimation and transport using the retained context floor', async () => {
  const seed = initial(); const state = newWork({ id: seed.id, goal: { ...seed.goal, description: sentinel }, policy: policy(), limits: seed.budget.limits, now: 1000 });
  state.policy.allowedLabels = ['synthetic'];
  const packet: ContextPacket = buildContextPacket(state, new ToolContracts([], new AjvSchemas()));
  const options: ModelCallOptions = { callId: 'direct', maxOutputTokens: 100, tools: [] }; let entries = 0;
  const adapter = new StructuredPlannerAdapter({ identity: { provider: 'synthetic', model: 'boundary', revision: '1' }, destination: 'external',
    capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 100000 } },
  { async invoke() { entries++; throw new Error('must_not_enter'); } });
  assert.throws(() => adapter.estimateInput(packet, options), /model_disclosure_denied/);
  const reply = await adapter.propose(packet, new AbortController().signal, options);
  assert.equal(reply.status, 'invalid'); assert.equal(reply.code, 'model_disclosure_denied');
  assert.equal(entries, 0); assert.equal(JSON.stringify(reply).includes(sentinel), false);
});
