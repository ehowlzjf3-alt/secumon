import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkState } from '../domain/model.js';
import type { SessionCompactInput, SessionSummaryRecord } from '../domain/session-compact.js';
import type { SessionContext } from '../domain/session.js';
import type { Planner, SessionCompactReply } from '../application/ports.js';
import type { RuntimeServices } from '../application/services.js';
import { PlanningRuntime } from '../application/planning-runtime.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { asJson } from '../application/plan-validator.js';
import { transact } from '../application/work-transactions.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';
import { FakeClock, FakeSink, FixtureReadTool, SequenceIds } from '../infrastructure/fakes.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { command, initial } from './state-conformance-helpers.js';

const actor = { tenantId: 'tenant-a', principalId: 'person-a' };
function ok(input: SessionCompactInput): SessionCompactReply {
  return { status: 'ok', provider: 'synthetic', model: 'compact', inputTokens: 19, outputTokens: 7,
    candidate: { inputDigest: input.inputDigest, content: { narrative: 'Keep future answers short.', retained: [
      { id: 'format', kind: 'constraint', text: 'Keep answers short.', status: 'active', citations: [
        { sequence: 1, sourceId: 'old-input', role: 'user', quote: 'Keep future answers short.' },
      ] },
    ] } } };
}
async function fixture(invoke: (input: SessionCompactInput, signal: AbortSignal) => Promise<SessionCompactReply> = async input => ok(input)) {
  const repository = new MemoryStateRepository(), artifacts = new MemoryArtifactStore(), digester = new Sha256Digester();
  const clock = new FakeClock(1100), tool = new FixtureReadTool([]), tools = new ToolContracts([tool], new AjvSchemas());
  const work = initial('compact-y'); work.budget.limits.tokens = 1000000;
  const scope = { ...actor, agentId: 'agent-a', sessionId: 'same-session' };
  work.conversation = { bindings: [{ id: 'binding', channel: 'test', conversationId: 'conversation', recipientId: actor.principalId,
    destination: 'local', ...actor, session: scope }], primaryBindingId: 'binding', completionRequiresDelivery: false, result: null,
    session: { scope, input: { messageId: 'new-input', sequence: 3, digest: digester.digest('new-input') } } };
  const entries: SessionContext['entries'] = [
    { sequence: 1, role: 'user', sourceId: 'old-input', workId: 'completed-x', text: 'Keep future answers short.', labels: ['synthetic'], artifact: null, status: 'received', kind: 'work' },
    { sequence: 3, role: 'user', sourceId: 'new-input', workId: work.id, text: 'Now compare another document.', labels: ['synthetic'], artifact: null, status: 'received', kind: 'work' },
  ];
  const context: SessionContext = { schemaVersion: 1, basis: work.conversation.session!, entries,
    head: { revision: 1, throughSequence: 3, digest: digester.digest(asJson(entries)), policyDigest: digester.digest(asJson(work.policy)) },
    interpretation: 'conversation_history_not_verified_evidence' };
  const input: SessionCompactInput = { schemaVersion: 1, purpose: 'session_compact', workId: work.id, basis: structuredClone(work.conversation.session!),
    policyDigest: context.head.policyDigest, inputDigest: digester.digest('fixed-prefix'), expectedHead: null, previous: null,
    prefix: { throughSequence: 1, digest: digester.digest(asJson([entries[0]])), entries: 1 }, entries: [entries[0]!], maxSummaryBytes: 4096,
    interpretation: 'conversation_history_not_verified_evidence' };
  const access = { current: true, needed: true, rawFits: true, publicationThrows: false }, calls: SessionCompactInput[] = [];
  let planCalls = 0, publications = 0;
  const receipts = new Map<string, SessionSummaryRecord>();
  const sameBasis = (value: WorkState) => digester.digest(asJson(value.conversation?.session ?? null)) === digester.digest(asJson(input.basis));
  const planner: Planner = { identity: { provider: 'synthetic', model: 'compact', revision: '1' }, destination: 'local',
    capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 100000 },
    estimateCompactInput: (compact, options) => ({ tokens: 100, bytes: Buffer.byteLength(JSON.stringify({ compact, options })), method: 'synthetic_bound' }),
    propose: async () => { planCalls++; throw new Error('planning_must_not_run'); },
    compact: async (value, signal, options) => { assert.deepEqual(options.tools, []); calls.push(structuredClone(value)); return invoke(value, signal); } };
  const services: RuntimeServices = { state: repository, artifacts, digester, clock, ids: new SequenceIds(), planner, tools: [tool], sink: new FakeSink(),
    sessions: { context: async () => { if (!access.rawFits) throw new Error('session_context_capacity'); return structuredClone(context); },
      current: async (value, _context, signal) => !signal?.aborted && access.current && sameBasis(value) },
    sessionCompacts: { prepareCompact: async () => access.needed ? structuredClone(input) : null,
      compactInputCurrent: async (value, fixed, signal) => !signal?.aborted && access.current && sameBasis(value) &&
        digester.digest(asJson(fixed)) === digester.digest(asJson(input)),
      compactPublication: async (_value, callId) => structuredClone(receipts.get(callId) ?? null),
      publishCompact: async (value, callId, fixed, candidate) => {
        assert.equal(value.id, work.id); assert.equal(candidate.inputDigest, fixed.inputDigest); publications++;
        const receipt: SessionSummaryRecord = { scope, workId: work.id, callId, inputDigest: fixed.inputDigest, content: candidate.content,
          prefix: fixed.prefix, previous: fixed.previous?.ref ?? null, createdAt: clock.now(), ref: { id: `summary-${callId}`, revision: publications,
            throughSequence: fixed.prefix.throughSequence, digest: digester.digest(asJson(candidate.content)), policyDigest: fixed.policyDigest } };
        receipts.set(callId, structuredClone(receipt)); access.needed = false;
        if (access.publicationThrows) throw new Error('publish_ack_unknown');
        return receipt;
      } } };
  assert.equal((await repository.commit(command(work, 'accept'))).kind, 'committed');
  const execution = new ExecutionRuntime(services, tools, 'worker');
  const planning = new PlanningRuntime(services, tools, execution, 'planner', { maxOutputTokens: 128 });
  const current = async () => (await repository.get(work.id))!;
  return { work, services, repository, execution, planning, tools, tool, artifacts, clock, input, access, receipts, calls, current,
    counts: () => ({ planCalls, publications }) };
}

test('compact uses the normal reservation and usage ledger while accepting no plan or tool execution', async () => {
  const f = await fixture(); const call = (await f.planning.requestCompact(f.work.id, { requestId: 'one', force: true, expectedGoalRevision: 1 }))!;
  assert.equal(call.purpose, 'session_compact'); assert.equal(call.semanticVersion, 3); assert.equal(call.compactInputDigest, f.input.inputDigest);
  const reserved = await f.current(); assert.equal(reserved.budget.reservedModelCalls, 1); assert.equal(reserved.budget.reservedTokens, 228);
  const envelope = JSON.parse(Buffer.from(await f.artifacts.get(call.inputArtifact, f.work.policy)).toString());
  assert.deepEqual(envelope.compact, f.input); assert.equal(envelope.packet, undefined); assert.deepEqual(envelope.options.tools, []);
  await f.planning.execute(f.work.id, call.id); assert.equal(await f.planning.adopt(f.work.id, call.id), true);
  const settled = await f.current(); assert.equal(settled.modelCalls[0]!.status, 'accepted'); assert.equal(settled.budget.used.modelCalls, 1);
  assert.equal(settled.budget.used.tokens, 26); assert.equal(settled.budget.reservedTokens, 0); assert.equal(settled.budget.reservedModelCalls, 0);
  assert.equal(settled.budget.used.replans, 0); assert.equal(settled.plan, null); assert.equal(settled.progress, undefined);
  assert.equal(f.calls.length, 1); assert.equal(f.counts().planCalls, 0); assert.equal(f.tool.invocations.length, 0);
  const replay = await f.planning.requestCompact(f.work.id, { requestId: 'one', force: true, expectedGoalRevision: 1 });
  assert.equal(replay!.id, call.id); assert.equal(replay!.status, 'accepted'); assert.equal((await f.current()).modelCalls.length, 1);
  assert.equal(await f.planning.compactStep(f.work.id, { auto: false }), null);
  await assert.rejects(f.planning.requestCompact(f.work.id, { requestId: 'one', force: false, expectedGoalRevision: 1 }), /idempotency_conflict/);
});

test('a no-op explicit compact request stays a no-op after later context growth', async () => {
  const f = await fixture(); f.access.needed = false;
  assert.equal(await f.planning.requestCompact(f.work.id, { requestId: 'nothing', force: true }), null);
  f.access.needed = true;
  assert.equal(await f.planning.requestCompact(f.work.id, { requestId: 'nothing', force: true }), null);
  assert.equal((await f.current()).modelCalls.length, 0); assert.equal(f.calls.length, 0);
});

test('stored compact response recovers after publication but before work adoption, even after lease expiry', async () => {
  const f = await fixture(); const call = (await f.planning.requestCompact(f.work.id))!;
  await f.planning.execute(f.work.id, call.id);
  const commit = f.repository.commit.bind(f.repository), interruption = new Error('before_compact_accept_commit');
  f.repository.commit = async request => { if (request.events.some(event => event.type === 'model_compact_accepted')) throw interruption; return commit(request); };
  await assert.rejects(f.planning.adopt(f.work.id, call.id), error => error === interruption);
  assert.equal((await f.current()).modelCalls[0]!.status, 'received'); assert.equal(f.receipts.size, 1);
  f.repository.commit = commit; f.clock.advance(call.leaseUntil - f.clock.now() + 1);
  const restarted = new PlanningRuntime(f.services, f.tools, f.execution, 'restarted', { maxOutputTokens: 128 });
  assert.equal(await restarted.adopt(f.work.id, call.id), true); assert.equal(await restarted.adopt(f.work.id, call.id), true);
  assert.equal(f.counts().publications, 1); assert.equal(f.calls.length, 1); assert.equal((await f.current()).budget.used.tokens, 26);
});

test('an uncertain publish acknowledgement is reconciled by receipt without a second candidate', async () => {
  const f = await fixture(); f.access.publicationThrows = true;
  const call = (await f.planning.requestCompact(f.work.id))!; await f.planning.execute(f.work.id, call.id);
  assert.equal(await f.planning.adopt(f.work.id, call.id), true); assert.equal(f.counts().publications, 1); assert.equal(f.calls.length, 1);
});

test('a timely received compact reply survives restart beyond its execution lease before first publication', async () => {
  const f = await fixture(); const call = (await f.planning.requestCompact(f.work.id))!;
  await f.planning.execute(f.work.id, call.id);
  assert.equal((await f.current()).modelCalls[0]!.status, 'received'); assert.equal((await f.current()).modelCalls[0]!.expired, false);
  assert.equal(f.receipts.size, 0);
  f.clock.advance(call.leaseUntil - f.clock.now() + 1);
  const restarted = new PlanningRuntime(f.services, f.tools, f.execution, 'restarted', { maxOutputTokens: 128 });
  assert.equal(await restarted.adopt(f.work.id, call.id), true);
  assert.equal(f.calls.length, 1); assert.equal(f.counts().publications, 1); assert.equal((await f.current()).budget.used.tokens, 26);
});

test('an undispatched compact cancellation returns its reserved resources', async () => {
  const f = await fixture(); await f.planning.requestCompact(f.work.id);
  await f.execution.command(f.work.id, 'cancel', actor, 1, { kind: 'cancel', reason: 'user_cancelled' });
  const state = await f.current(); assert.equal(state.modelCalls[0]!.status, 'cancelled'); assert.equal(state.modelCalls[0]!.usageStatus, 'not_called');
  assert.equal(state.budget.used.modelCalls, 0); assert.equal(state.budget.reservedModelCalls, 0); assert.equal(state.budget.reservedTokens, 0); assert.equal(f.calls.length, 0);
});

for (const boundary of ['input', 'cancel', 'authority'] as const) test(`late compact after ${boundary} does not publish but preserves reported usage`, async () => {
  let start!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async input => { start(); await gate; return ok(input); }); const call = (await f.planning.requestCompact(f.work.id))!;
  const running = f.planning.execute(f.work.id, call.id);
  try {
    await Promise.race([started, running.then(() => { throw new Error('provider_not_started'); })]);
    if (boundary === 'cancel') await f.execution.command(f.work.id, 'cancel', actor, 1, { kind: 'cancel', reason: 'user_cancelled' });
    else if (boundary === 'input') await f.execution.command(f.work.id, 'new-input', actor, 1, { kind: 'input', reason: 'new_instruction' },
      { ...structuredClone(f.input.basis), input: { messageId: 'newer-input', sequence: 4, digest: f.services.digester.digest('newer-input') } });
    else f.access.current = false;
    release(); await running; await f.planning.settlePending();
    assert.equal(await f.planning.adopt(f.work.id, call.id), false);
    const state = await f.current(); assert.equal(state.budget.used.tokens, 26); assert.equal(state.budget.used.modelCalls, 1);
    assert.equal(state.budget.reservedTokens, 0); assert.equal(state.modelCalls[0]!.status, 'rejected'); assert.equal(f.receipts.size, 0);
  } finally { release(); await running; await f.planning.settlePending(); }
});

test('compact transport failure retains unknown usage and prevents another unaccounted model call', async () => {
  const f = await fixture(async () => { throw new Error('transport_lost'); }); const call = (await f.planning.requestCompact(f.work.id))!;
  await f.planning.execute(f.work.id, call.id); assert.equal(await f.planning.adopt(f.work.id, call.id), false);
  const state = await f.current(); assert.equal(state.modelCalls[0]!.usageStatus, 'unknown'); assert.equal(state.budget.used.unmeasuredModelCalls, 1);
  assert.equal(state.budget.reservedTokens, call.tokenReservation); assert.equal(state.budget.used.tokens, 0);
  await assert.rejects(f.planning.requestCompact(f.work.id, { requestId: 'retry' }), /model_usage_unknown/); assert.equal(f.calls.length, 1);
});

test('compact-only orchestration uses bounded raw context after failure and refuses a missing checkpoint context', async () => {
  const f = await fixture(async () => ({ status: 'refused', code: 'provider_refused', inputTokens: 1, outputTokens: 0 }));
  const call = (await f.planning.requestCompact(f.work.id))!; await f.planning.execute(f.work.id, call.id); await f.planning.adopt(f.work.id, call.id);
  assert.equal(await f.planning.compactStep(f.work.id), null); assert.equal(f.counts().planCalls, 0);
  f.access.rawFits = false;
  await assert.rejects(f.planning.compactStep(f.work.id), /session_compact_failed/);
  assert.equal(f.calls.length, 1); assert.equal(f.receipts.size, 0);
});

test('a forged receipt cannot settle a compact response for another source manifest', async () => {
  const f = await fixture(); const call = (await f.planning.requestCompact(f.work.id))!; await f.planning.execute(f.work.id, call.id);
  const reply = ok(f.input); assert.equal(reply.status, 'ok'); if (reply.status !== 'ok') throw new Error('invalid_fixture');
  const receipt = await f.services.sessionCompacts!.publishCompact(await f.current(), call.id, f.input, reply.candidate);
  f.receipts.set(call.id, { ...receipt, prefix: { ...receipt.prefix, digest: '0'.repeat(64) } });
  await assert.rejects(f.planning.adopt(f.work.id, call.id), /session_compact_receipt_invalid/);
  assert.equal((await f.current()).modelCalls[0]!.status, 'received'); assert.equal((await f.current()).budget.used.tokens, 26);
});

test('compact estimation is checked before any reservation or provider call', async () => {
  const f = await fixture(); f.services.planner.estimateCompactInput = () => ({ tokens: 1, bytes: 1, method: 'underreported' });
  await assert.rejects(f.planning.requestCompact(f.work.id), /model_input_estimate_invalid/);
  assert.equal((await f.current()).modelCalls.length, 0); assert.equal((await f.current()).budget.reservedTokens, 0); assert.equal(f.calls.length, 0);
});

test('a policy change after receipt rejects publication without recharging usage', async () => {
  const f = await fixture(); const call = (await f.planning.requestCompact(f.work.id))!; await f.planning.execute(f.work.id, call.id);
  await transact(f.services, f.work.id, 'policy-restrict', 'policy_changed', {}, next => { next.policy.allowedDestinations = []; });
  assert.equal(await f.planning.adopt(f.work.id, call.id), false); assert.equal(f.receipts.size, 0); assert.equal((await f.current()).budget.used.tokens, 26);
});
