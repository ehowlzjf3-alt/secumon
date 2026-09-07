import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import type { Delivery } from '../domain/model.js';
import type { MessageSink, StateRepository } from '../application/ports.js';
import { ConversationService, type AcceptRequest } from '../application/conversation-service.js';
import { OutboxDispatcher } from '../application/outbox.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { validateScenario } from '../application/fixtures.js';
import { transact } from '../application/work-transactions.js';
import { FakeClock, FakeSink, FixtureReadTool, ScriptedPlanner } from '../infrastructure/fakes.js';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { SqliteStateRepository } from '../infrastructure/sqlite-state.js';
import { LocalChannel } from '../infrastructure/local-channel.js';
import { Sha256Digester, RandomIds } from '../infrastructure/digest.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';

const actor = { tenantId: 'synthetic', principalId: 'learner' };
const scenario = validateScenario(JSON.parse(readFileSync(new URL('../../fixtures/documents-simple.json', import.meta.url), 'utf8')));
function setup(state: StateRepository = new MemoryStateRepository(), sink: MessageSink = new FakeSink()) {
  const tool = new FixtureReadTool(scenario.evidence);
  const services = { state, sink, artifacts: new MemoryArtifactStore(), clock: new FakeClock(1788566400000), ids: new RandomIds(), digester: new Sha256Digester(), tools: [tool], planner: new ScriptedPlanner([]) };
  return { services, tool, conversation: new ConversationService(services), outbox: new OutboxDispatcher(services, 'sender-1', 100),
    runtime: new ExecutionRuntime(services, new ToolContracts([tool], new AjvSchemas()), 'executor-1') };
}
function request(messageId = 'm1', completionRequiresDelivery = true): AcceptRequest {
  return { messageId, binding: { ...actor, channel: 'cli', conversationId: 'chat-a', destination: 'local', recipientId: 'learner' },
    goal: scenario.goal, policy: scenario.policy, limits: { toolCalls: 10, modelCalls: 2, tokens: 10000, replans: 3, wallTimeMs: 60000 }, completionRequiresDelivery };
}
async function ready(f: ReturnType<typeof setup>, required = true) {
  const { workId } = await f.conversation.accept(actor, request('m1', required)); await f.outbox.flush(workId, actor);
  const state = await f.runtime.state(workId);
  await f.runtime.submitPlan(workId, 'plan', { baseStateRevision: state.revision, baseGoalRevision: 1, basePlanRevision: 0, reason: 'synthetic source lookup', hypotheses: [],
    tasks: [{ id: 'read', description: 'read source', toolId: 'fixture.read', toolVersion: '1', input: { evidenceIds: ['doc-current'] }, effect: 'read', dependsOn: [], maxAttempts: 2, satisfies: state.goal.criteria.map(c => c.id) }] });
  await f.runtime.runUntilYield(workId); return workId;
}
async function deliveredResult(f: ReturnType<typeof setup>, workId: string) { return (await f.services.state.deliveries(workId)).find(d => d.kind === 'result')!; }

test('request acceptance is atomic, duplicate input is stable and each conversation can bind several works', async () => {
  const f = setup(); const first = await f.conversation.accept(actor, request());
  assert.equal(first.accepted, true); assert.equal((await f.conversation.accept(actor, request())).accepted, false);
  await assert.rejects(f.conversation.accept(actor, { ...request(), goal: { ...scenario.goal, description: 'different goal' } }), /request_identity_conflict/);
  await assert.rejects(f.conversation.accept({ ...actor, principalId: 'another' }, request()), /request_not_authorized/);
  const second = await f.conversation.accept(actor, request('m2'));
  assert.deepEqual(await f.conversation.list(actor, 'cli', 'chat-a'), [first.workId, second.workId].sort());
  assert.deepEqual(await f.conversation.list({ ...actor, tenantId: 'other' }, 'cli', 'chat-a'), []);
  await f.conversation.attach(first.workId, actor, { ...request().binding, conversationId: 'chat-b' });
  assert.deepEqual(await f.conversation.list(actor, 'cli', 'chat-b'), [first.workId]);
  assert.equal((await f.services.state.deliveries(first.workId)).length, 1);
  assert.equal((await f.runtime.state(first.workId)).conversation!.bindings.length, 2);
});

test('failed acceptance commit creates neither a work nor a reception acknowledgment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'conversation-atomic-')); const path = join(dir, 'state.sqlite'); const store = new SqliteStateRepository(path);
  try {
    const db = new DatabaseSync(path); db.exec("CREATE TRIGGER fail_accept BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'injected_accept_failure'); END;"); db.close();
    const sink = new FakeSink(); const f = setup(store, sink);
    await assert.rejects(f.conversation.accept(actor, request()), /injected_accept_failure/);
    assert.deepEqual(await f.conversation.list(actor, 'cli', 'chat-a'), []); assert.equal(sink.delivered.size, 0);
    const check = new DatabaseSync(path); assert.equal(check.prepare('SELECT COUNT(*) AS n FROM deliveries').get()!['n'], 0); check.close();
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('analysis, response preparation, delivery and completion are distinct; retransmission never collects evidence again', async () => {
  const sink = new FakeSink(); const f = setup(undefined, sink); const id = await ready(f);
  let view = await f.conversation.snapshot(id, actor); assert.equal(view.analysisReady, true); assert.equal(view.resultReady, false); assert.equal(view.status, 'waiting');
  const result = await f.conversation.prepare(id, actor); assert.equal(result!.kind, 'result'); assert.equal(await f.conversation.prepare(id, actor), null);
  view = await f.conversation.snapshot(id, actor); assert.equal(view.resultReady, true); assert.equal(view.resultDelivery, 'pending');
  sink.outcome = 'retryable_error'; await f.outbox.flush(id, actor);
  assert.equal((await f.runtime.runUntilYield(id)).kind, 'wait'); assert.equal((await deliveredResult(f, id)).status, 'pending');
  sink.outcome = 'delivered'; await f.outbox.flush(id, actor);
  assert.equal((await f.runtime.runUntilYield(id)).kind, 'complete'); assert.equal(f.tool.invocations.length, 1);
  assert.equal((await f.runtime.state(id)).budget.used.toolCalls, 1); assert.equal(sink.delivered.size, 2);
  assert.match(result!.text, /doc-current/); assert.match(result!.text, /출처/);
});

test('analysis-only completion does not pretend that its result was prepared or delivered', async () => {
  const f = setup(); const id = await ready(f, false); const view = await f.conversation.snapshot(id, actor);
  assert.equal(view.status, 'completed'); assert.equal(view.resultReady, false); assert.equal(view.resultDelivery, 'not_prepared');
  await f.conversation.prepare(id, actor); await f.outbox.flush(id, actor); assert.equal((await f.conversation.snapshot(id, actor)).resultDelivery, 'delivered');
});

test('pending questions are grouped once and resolving a question cannot waive required result delivery', async () => {
  const sink = new FakeSink(); const f = setup(undefined, sink); const { workId: id } = await f.conversation.accept(actor, request());
  for (const n of [1, 2]) await f.runtime.command(id, `wait-${n}`, actor, 1, { kind: 'wait', obligation: { id: `q${n}`, kind: 'response', reason: `clarify ${n}`, status: 'pending', wakeKey: `reply-${n}`, dueAt: null } });
  const question = await f.conversation.prepare(id, actor); assert.deepEqual(question!.context!.obligationIds, ['q1', 'q2']);
  assert.equal(await f.conversation.prepare(id, actor), null); await f.outbox.flush(id, actor); await f.outbox.flush(id, actor);
  assert.equal([...sink.delivered.values()].filter(d => d.kind === 'question').length, 1);
  await f.runtime.command(id, 'resolve-q1', actor, 1, { kind: 'resolve', obligationId: 'q1', reason: 'reply received' });
  await assert.rejects(f.runtime.command(id, 'fake-delivery', actor, 1, { kind: 'resolve', obligationId: 'response-delivery:1', reason: 'pretend done' }), /obligation_not_resolvable/);
  const next = await f.conversation.prepare(id, actor); assert.deepEqual(next!.context!.obligationIds, ['q2']);
});

test('independent dispatchers claim once and receipt reconciliation after restart does not send again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'conversation-receipt-')); const path = join(dir, 'channel.sqlite'); let channel = new LocalChannel(path); let sends = 0;
  const sink: MessageSink = { capabilities: { idempotentSend: true }, async send(d) { sends++; await channel.send(d); return { status: 'unknown' }; }, lookup: d => channel.lookup(d) };
  try {
    const f = setup(undefined, sink); const { workId: id } = await f.conversation.accept(actor, request());
    await Promise.all([f.outbox.flush(id, actor), new OutboxDispatcher(f.services, 'sender-2', 100).flush(id, actor)]);
    assert.equal(sends, 1); assert.equal((await f.services.state.deliveries(id))[0]!.status, 'unknown');
    channel.close(); channel = new LocalChannel(path);
    await new OutboxDispatcher(f.services, 'sender-after-restart', 100).flush(id, actor);
    assert.equal(sends, 1); assert.equal((await f.services.state.deliveries(id))[0]!.status, 'delivered');
    const messages = await channel.messages(actor, 'cli', 'chat-a'); assert.equal(messages.length, 1);
    assert.deepEqual(await channel.messages({ ...actor, principalId: 'other' }, 'cli', 'chat-a'), []);
    const d = (await f.services.state.deliveries(id))[0]!; assert.equal((await channel.send({ ...d, text: 'changed' })).status, 'unknown');
    assert.equal((await channel.messages(actor, 'cli', 'chat-a'))[0]!.text, messages[0]!.text);
  } finally { channel.close(); await rm(dir, { recursive: true, force: true }); }
});

test('ambiguous delivery with no idempotency stays unknown, including repeated and timed-out lookup', async () => {
  let sends = 0; const sink: MessageSink = { async send() { sends++; return { status: 'unknown' }; }, async lookup() { return { status: 'absent' }; } };
  const f = setup(undefined, sink); const { workId: id } = await f.conversation.accept(actor, request());
  await f.outbox.flush(id, actor); await new OutboxDispatcher(f.services, 'another', 20).flush(id, actor); await f.outbox.flush(id, actor);
  assert.equal(sends, 1); assert.equal((await f.services.state.deliveries(id))[0]!.status, 'unknown');
  const hanging: MessageSink = { send: d => sink.send(d), lookup: async () => new Promise(() => {}) };
  await new OutboxDispatcher({ ...f.services, sink: hanging }, 'bounded', 5).flush(id, actor);
  assert.equal((await f.services.state.deliveries(id))[0]!.status, 'unknown');
});

test('idempotent absent receipt permits only a bounded later retry and permanent failure stays visible', async () => {
  const sink = new FakeSink(); sink.outcome = 'unknown'; const f = setup(undefined, sink); const { workId: id } = await f.conversation.accept(actor, request());
  await f.outbox.flush(id, actor); await f.outbox.flush(id, actor);
  assert.equal((await f.services.state.deliveries(id))[0]!.status, 'pending');
  sink.outcome = 'retryable_error'; await f.outbox.flush(id, actor); await f.outbox.flush(id, actor); await f.outbox.flush(id, actor);
  const d = (await f.services.state.deliveries(id))[0]!; assert.equal(d.status, 'failed'); assert.equal(d.dispatch!.attempts, 3);
});

for (const change of ['goal', 'cancel', 'labels', 'destination'] as const) test(`${change} before delivery prevents an obsolete or unauthorized result from being sent`, async () => {
  const sink = new FakeSink(); const f = setup(undefined, sink); const id = await ready(f); await f.conversation.prepare(id, actor);
  if (change === 'goal') await f.runtime.command(id, 'change', actor, 1, { kind: 'goal', expectedControlRevision: (await f.runtime.state(id)).executionControl?.revision ?? 1, goal: { ...scenario.goal, revision: 2, scope: 'new-scope' } });
  else if (change === 'cancel') await f.runtime.command(id, 'change', actor, 1, { kind: 'cancel', reason: 'user cancellation' });
  else await transact(f.services, id, 'revoke', 'policy_updated', {}, state => { if (change === 'labels') state.policy.allowedLabels = []; else state.policy.allowedDestinations = []; });
  await f.outbox.flush(id, actor); assert.equal([...sink.delivered.values()].filter(d => d.kind === 'result').length, 0);
  assert.equal((await deliveredResult(f, id)).status, 'superseded');
  if (change === 'goal') assert.equal((await f.runtime.state(id)).obligations.find(o => o.id === 'response-delivery:2')!.status, 'pending');
});

test('pause preserves pending delivery and resume can complete it without another source call', async () => {
  const f = setup(); const id = await ready(f); await f.conversation.prepare(id, actor);
  await f.runtime.command(id, 'pause', actor, 1, { kind: 'pause', reason: 'review first' }); await f.outbox.flush(id, actor);
  assert.equal((await deliveredResult(f, id)).status, 'pending');
  await f.runtime.command(id, 'resume', actor, 1, { kind: 'resume', reason: 'continue' }); await f.outbox.flush(id, actor);
  assert.equal((await f.runtime.runUntilYield(id)).kind, 'complete'); assert.equal(f.tool.invocations.length, 1);
});

test('late confirmed delivery is historical and cannot satisfy a revised goal', async () => {
  const base = new FakeSink(); let started!: () => void; let release!: () => void;
  const invoked = new Promise<void>(resolve => { started = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const sink: MessageSink = { capabilities: { idempotentSend: true }, lookup: d => base.lookup(d), async send(d: Delivery) { if (d.kind === 'result') { started(); await gate; } return base.send(d); } };
  const f = setup(undefined, sink); const id = await ready(f); await f.conversation.prepare(id, actor);
  const sending = f.outbox.flush(id, actor); await invoked;
  await f.runtime.command(id, 'goal', actor, 1, { kind: 'goal', expectedControlRevision: (await f.runtime.state(id)).executionControl?.revision ?? 1, goal: { ...scenario.goal, revision: 2, scope: 'new-scope' } });
  release(); await sending; const state = await f.runtime.state(id);
  assert.equal((await deliveredResult(f, id)).status, 'delivered'); assert.equal(state.obligations.find(o => o.id === 'response-delivery:2')!.status, 'pending'); assert.notEqual(state.status, 'completed');
});

test('an uncertain old-goal delivery retains its uncertainty when superseded by a new goal', async () => {
  const sink = new FakeSink(); const f = setup(undefined, sink); const id = await ready(f); await f.conversation.prepare(id, actor);
  sink.outcome = 'unknown'; await f.outbox.flush(id, actor);
  await f.runtime.command(id, 'goal', actor, 1, { kind: 'goal', expectedControlRevision: (await f.runtime.state(id)).executionControl?.revision ?? 1, goal: { ...scenario.goal, revision: 2, scope: 'new-scope' } }); await f.outbox.flush(id, actor);
  assert.equal((await deliveredResult(f, id)).status, 'unknown'); assert.notEqual((await f.runtime.state(id)).status, 'completed');
  assert.equal((await f.conversation.snapshot(id, actor)).unresolvedDeliveries, 1);
});

test('SIGKILL between channel commit and outbox settlement recovers from two reopened databases without another send', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'conversation-kill-')); const path = join(dir, 'state.sqlite'); let store = new SqliteStateRepository(path);
  try {
    const initial = setup(store); const { workId: id } = await initial.conversation.accept(actor, request()); await store.close();
    const child = fork(new URL('./outbox-worker.js', import.meta.url), [dir, id], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const exit = once(child, 'exit', { signal: AbortSignal.timeout(10000) }); const message = once(child, 'message', { signal: AbortSignal.timeout(10000) });
    assert.equal((await message)[0].persisted, 'delivered'); assert.equal((await exit)[1], 'SIGKILL');
    store = new SqliteStateRepository(path); const channel = new LocalChannel(join(dir, 'channel.sqlite')); let resends = 0;
    try {
      const sink: MessageSink = { capabilities: channel.capabilities, lookup: d => channel.lookup(d), async send(d) { resends++; return channel.send(d); } };
      const recovered = setup(store, sink); recovered.services.clock.advance(1001);
      assert.equal((await store.deliveries(id))[0]!.status, 'sending');
      await recovered.outbox.flush(id, actor);
      assert.equal((await store.deliveries(id))[0]!.status, 'delivered'); assert.equal(resends, 0);
      assert.equal((await channel.messages(actor, 'cli', 'chat-a')).length, 1);
    } finally { channel.close(); }
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a never-dispatched response can be prepared after permission restoration, and large questions retain their full artifact', async () => {
  const f = setup(); const id = await ready(f); await f.conversation.prepare(id, actor);
  await transact(f.services, id, 'revoke', 'policy_updated', {}, state => { state.policy.allowedLabels = []; }); await f.outbox.flush(id, actor);
  await transact(f.services, id, 'restore', 'policy_updated', {}, state => { state.policy.allowedLabels = [...scenario.policy.allowedLabels]; });
  assert.equal((await f.conversation.prepare(id, actor))!.kind, 'result'); await f.outbox.flush(id, actor); assert.equal((await f.runtime.runUntilYield(id)).kind, 'complete');
  const second = await f.conversation.accept(actor, request('large-question'));
  for (let n = 0; n < 15; n++) await f.runtime.command(second.workId, `wait-${n}`, actor, 1, { kind: 'wait', obligation: { id: `q${n}`, kind: 'response', reason: '확인할 내용 '.repeat(1000), status: 'pending', wakeKey: `reply-${n}`, dueAt: null } });
  const question = (await f.conversation.prepare(second.workId, actor))!;
  assert.ok(question.text.length < 12000); assert.match(question.text, /전체 질문 산출물/);
  const full = await f.services.artifacts.get(question.context!.artifact!, scenario.policy); assert.ok(full!.byteLength > 100000);
  assert.match(new TextDecoder().decode(full!), /\(q14\)/); await f.outbox.flush(second.workId, actor);
});
