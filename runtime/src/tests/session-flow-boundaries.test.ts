import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ContextPacket } from '../domain/model.js';
import type { ModelReply, Planner } from '../application/ports.js';
import { PlanningRuntime } from '../application/planning-runtime.js';
import { asJson } from '../application/plan-validator.js';
import { ScriptedPlanner } from '../infrastructure/fakes.js';
import { actor, request, initialize, open, finish } from './session-flow-helpers.js';

async function fixture(t: TestContext, backend: 'sqlite' | 'file-journal' = 'sqlite') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'session-boundaries-')));
  mkdirSync(join(base, 'engine'), { mode: 0o700 }); initialize(base, backend); const f = await open(base);
  t.after(async () => { await f.close(); rmSync(base, { recursive: true, force: true }); });
  const session = await f.sessions!.open(actor, { channel: 'test', conversationId: 'conversation' });
  const first = await f.sessions!.accept(actor, { sessionId: session.scope.sessionId, rawText: 'Answer briefly using the current document.', request: request('original') });
  return { ...f, session, first };
}
function answer(packet: ContextPacket): ModelReply {
  return { status: 'ok', provider: 'scripted', model: 'fixture', inputTokens: 21, outputTokens: 13,
    proposal: { baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision, basePlanRevision: packet.plan?.revision ?? 0,
      reason: 'A delayed synthetic plan from the original session input', hypotheses: [], tasks: [{ id: 'delayed-read',
        description: 'Read the current synthetic document', toolId: 'fixture.read', toolVersion: '1', input: { evidenceIds: ['doc-current'] },
        dependsOn: [], effect: 'read', maxAttempts: 1, satisfies: packet.goal.criteria.map(value => value.id) }] } };
}
function delayedPlanner() {
  let start!: () => void; const started = new Promise<void>(resolve => { start = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const base = new ScriptedPlanner([]); const packets: ContextPacket[] = [];
  const planner: Planner = { identity: base.identity, destination: base.destination, capabilities: base.capabilities,
    propose: async packet => { packets.push(structuredClone(packet)); start(); await gate; return answer(packet); } };
  return { planner, packets, started, release };
}

for (const backend of ['sqlite', 'file-journal'] as const) {
  test(`${backend}: actual session input cancels an unsent model reservation and returns its allocation`, { timeout: 20000 }, async t => {
    const f = await fixture(t, backend); const planner = new ScriptedPlanner([answer]); f.services.planner = planner;
    const planning = new PlanningRuntime(f.services, f.contracts, f.runtime, 'boundary-planner', {}, f.context);
    const call = await planning.reserve(f.first.workId); assert.equal(call.semanticVersion, 3);
    const input = JSON.parse(Buffer.from(await f.stores.artifacts.get(call.inputArtifact, f.first.state.policy)).toString());
    assert.equal(input.packet.session.basis.input.messageId, 'original');
    await f.sessions!.input(actor, { sessionId: f.session.scope.sessionId, messageId: 'amendment', workId: f.first.workId,
      rawText: 'Before acting, compare two independent documents.', expectedGoalRevision: 1 });
    await assert.rejects(planning.execute(f.first.workId, call.id), /model_not_dispatchable/);
    const state = await f.runtime.state(f.first.workId); const cancelled = state.modelCalls.find(value => value.id === call.id)!;
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.usageStatus, 'not_called');
    assert.equal(state.budget.reservedModelCalls, 0); assert.equal(state.budget.reservedTokens, 0); assert.equal(state.budget.used.modelCalls, 0);
    assert.equal(state.conversation!.sessionReviewRequired, true); assert.equal(state.conversation!.session!.input.messageId, 'amendment');
    assert.equal(planner.inputs.length, 0); assert.equal(f.tool.invocations.length, 0);
    assert.equal((await f.stores.sessions.input(f.session.scope, 'amendment'))!.status, 'applied');
  });

  for (const change of ['input', 'cancel'] as const) test(`${backend}: real session ${change} during a model call rejects the late proposal and preserves usage`, { timeout: 20000 }, async t => {
    const f = await fixture(t, backend); const delayed = delayedPlanner(); f.services.planner = delayed.planner;
    const planning = new PlanningRuntime(f.services, f.contracts, f.runtime, 'boundary-planner', {}, f.context);
    let running: Promise<void> | undefined;
    try {
      const call = await planning.reserve(f.first.workId); running = planning.execute(f.first.workId, call.id);
      await Promise.race([delayed.started, running.then(() => { throw new Error('model_did_not_reach_provider'); })]);
      assert.equal(delayed.packets[0]!.session!.entries.find(entry => entry.sourceId === 'original')!.text, 'Answer briefly using the current document.');
      const value = { sessionId: f.session.scope.sessionId, messageId: 'during-model', workId: f.first.workId,
        rawText: change === 'input' ? 'Change the requested format before continuing.' : 'Cancel this work now.', expectedGoalRevision: 1 };
      if (change === 'input') await f.sessions!.input(actor, value);
      else await f.sessions!.command(actor, { ...value, command: { kind: 'cancel', reason: 'user_cancelled' } });
      delayed.release(); await running; await planning.settlePending();
      assert.equal(await planning.adopt(f.first.workId, call.id), false);
      const state = await f.runtime.state(f.first.workId); const settled = state.modelCalls.find(item => item.id === call.id)!;
      assert.equal(settled.status, 'rejected'); assert.equal(settled.expired, true); assert.equal(settled.usageStatus, 'reported');
      assert.equal(state.budget.used.modelCalls, 1); assert.equal(state.budget.used.tokens, 34); assert.equal(state.budget.reservedTokens, 0);
      assert.equal(state.plan, null); assert.equal(f.tool.invocations.length, 0); assert.equal(delayed.packets.length, 1);
      assert.equal(state.conversation!.session!.input.messageId, 'during-model');
      if (change === 'cancel') assert.equal(state.status, 'cancelled'); else assert.equal(state.conversation!.sessionReviewRequired, true);
      const input = await f.stores.sessions.input(f.session.scope, 'during-model'); assert.equal(input!.status, 'applied'); assert.equal(input!.text, value.rawText);
    } finally { delayed.release(); if (running) await running; await planning.settlePending(); }
  });

  test(`${backend}: durable raw input left pending prevents tool execution and outbox sends until the same input is recovered`, async t => {
    const f = await fixture(t, backend); const state = await f.runtime.state(f.first.workId);
    await f.runtime.submitPlan(state.id, 'prepare-read', { baseStateRevision: state.revision, baseGoalRevision: state.goal.revision, basePlanRevision: 0,
      reason: 'Explicit plan before the interrupted input', hypotheses: [], tasks: [{ id: 'read', description: 'Read synthetic source', toolId: 'fixture.read', toolVersion: '1',
        input: { evidenceIds: ['doc-current'] }, dependsOn: [], effect: 'read', maxAttempts: 1, satisfies: state.goal.criteria.map(value => value.id) }] });
    const attempt = await f.runtime.reserve(state.id, 'read');
    const originalReceive = f.stores.sessions.receive.bind(f.stores.sessions);
    const interrupted = new Error('after_inbox_before_application');
    f.stores.sessions.receive = async input => { const stored = await originalReceive(input); if (input.messageId === 'pending-input') throw interrupted; return stored; };
    let sends = 0; const originalSend = f.stores.channel.send.bind(f.stores.channel);
    f.stores.channel.send = async delivery => { sends++; return originalSend(delivery); };
    try {
      await assert.rejects(f.sessions!.input(actor, { sessionId: f.session.scope.sessionId, messageId: 'pending-input', workId: state.id,
        rawText: 'Wait for this instruction before taking the next step.', expectedGoalRevision: 1 }), error => error === interrupted);
      const pending = await f.stores.sessions.input(f.session.scope, 'pending-input'); assert.equal(pending!.status, 'pending');
      assert.equal((await f.runtime.state(state.id)).conversation!.session!.input.messageId, 'original');
      await assert.rejects(f.runtime.execute(state.id, attempt.id), /session_input_pending/);
      await f.outbox.flush(state.id, actor);
      assert.equal(sends, 0); assert.equal(f.tool.invocations.length, 0);
      assert.equal((await f.stores.state.deliveries(state.id))[0]!.status, 'pending');
      assert.equal((await f.runtime.state(state.id)).attempts.find(value => value.id === attempt.id)!.status, 'reserved');
      f.stores.sessions.receive = originalReceive;
      await f.sessions!.resume(actor, f.session.scope.sessionId);
      assert.equal((await f.stores.sessions.input(f.session.scope, 'pending-input'))!.status, 'applied');
      const recovered = await f.runtime.state(state.id);
      assert.equal(recovered.conversation!.session!.input.messageId, 'pending-input');
      assert.equal(recovered.attempts.find(value => value.id === attempt.id)!.status, 'cancelled');
      assert.equal(recovered.budget.used.toolCalls, 0); assert.equal(recovered.budget.reservedToolCalls, 0);
      await f.outbox.flush(state.id, actor); assert.equal(sends, 1);
      assert.equal((await f.stores.state.deliveries(state.id))[0]!.status, 'delivered');
    } finally { f.stores.sessions.receive = originalReceive; f.stores.channel.send = originalSend; }
  });
}

test('real session provider rejects a full pending page even when the blocked work appears only after that page', async t => {
  const f = await fixture(t); const state = await f.runtime.state(f.first.workId);
  // Exactly one page plus its hidden matching entry exercises the finite query boundary.
  for (let index = 0; index < 257; index++) {
    const messageId = `queued-${index}`; const workId = index === 256 ? state.id : `other-work-${index}`;
    const text = 'queued raw input'; const payload = asJson({ expectedGoalRevision: 1, command: { kind: 'input', reason: 'queued' } });
    await f.stores.sessions.receive({ scope: f.session.scope, messageId, kind: 'input', workId, text, payload, labels: state.policy.allowedLabels,
      digest: f.services.digester.digest(asJson({ scope: f.session.scope, text, payload, kind: 'input', workId })), receivedAt: f.services.clock.now() });
  }
  const page = await f.stores.sessions.pending(f.session.scope, 256); assert.equal(page.length, 256);
  assert.equal(page.some(input => input.workId === state.id), false);
  assert.equal((await f.stores.sessions.input(f.session.scope, 'queued-256'))!.status, 'pending');
  assert.equal(await f.sessions!.current(state), false);
  await assert.rejects(f.sessions!.context(state), /session_input_pending/);
  await f.outbox.flush(state.id, actor); assert.equal((await f.stores.state.deliveries(state.id))[0]!.status, 'pending');
  assert.equal((await f.stores.sessions.get(f.session.scope)).lastSequence, f.first.sequence + 257);
});

test('real session history does not authorize a missing source artifact merely because a derived context remains readable', async t => {
  const f = await fixture(t); await finish(f, f.first.workId);
  const next = await f.sessions!.accept(actor, { sessionId: f.session.scope.sessionId, rawText: 'Continue with the same answer format.', request: request('next') });
  const compiled = await f.context.prepare(next.state, { callId: 'before-source-loss', maxOutputTokens: 100, maxInputBytes: 1000000, maxInputTokens: 1000000 });
  const original = compiled.packet.session!.entries.find(entry => entry.kind === 'result')!.artifact; assert(original);
  unlinkSync(join(f.stores.profile.paths.artifacts, `${original.id}.blob`));
  assert.equal(await f.stores.artifacts.exists(compiled.head.artifact), true);
  assert.equal(await f.sessions!.current(next.state, compiled.packet.session), false);
  assert.equal(await f.context.sourcesCurrent(compiled.packet, next.state), false);
  await assert.rejects(f.sessions!.context(next.state), /session_source_unavailable/);
  await assert.rejects(f.context.prepare(next.state, { callId: 'after-source-loss', maxOutputTokens: 100, maxInputBytes: 1000000, maxInputTokens: 1000000 }), /session_source_unavailable/);
  assert.equal((await f.runtime.state(next.workId)).modelCalls.length, 0);
  assert.equal((await f.stores.sessions.input(f.session.scope, 'original'))!.text, 'Answer briefly using the current document.');
});
