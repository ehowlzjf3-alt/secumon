import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkState } from '../domain/model.js';
import type { SessionCompactCandidate, SessionCompactInput } from '../domain/session-compact.js';
import { BUDGET_DIMENSIONS } from '../domain/budget-delegation.js';
import { ContextFrameSchema } from '../application/context-contracts.js';
import { StructuredSessionCompactAdapter } from '../infrastructure/structured-session-compact.js';
import { BUDGET_ENTRY_CHILD_LIMITS, BUDGET_ENTRY_EXTRA, BUDGET_ENTRY_REQUEST_REASON, BUDGET_ENTRY_SECRET,
  budgetAllocate, budgetIncrease, budgetObject, budgetRun, budgetStatus, budgetToolsEntryFixture,
  type BudgetEntryRole } from './budget-tools-entry-fixture.js';

type Fixture = Awaited<ReturnType<typeof budgetToolsEntryFixture>>;
const original = (state: WorkState) => ({ id: state.id, goal: state.goal, policy: state.policy, limits: state.budget.limits,
  deadlineAt: state.deadlineAt, session: state.conversation?.session ?? null });

async function stageWorkingSets(f: Fixture, sponsorWorkId: string, childWorkId: string) {
  const frames = [];
  for (const [role, workId] of [['sponsor', sponsorWorkId], ['recipient', childWorkId]] as const) {
    const profile = f.current(role), state = await profile.runtime.state(workId);
    const prepared = await profile.context.prepare(state, { callId: `budget-entry-working-set-${role}`, maxInputBytes: 131072,
      maxInputTokens: 100000, maxOutputTokens: 2048, forceCompact: true });
    assert.equal(prepared.frame.kind, 'model_context'); assert.equal(prepared.frame.memo.mode, 'compact');
    assert.equal(prepared.frame.metrics.extraModelCalls, 0);
    assert.equal(prepared.frame.basis.workId, workId); assert.equal(prepared.frame.basis.stateRevision, state.revision);
    assert.deepEqual(prepared.packet.goal, state.goal); assert.deepEqual(prepared.packet.execution?.budget, state.budget);
    assert.deepEqual(prepared.packet.session?.basis ?? null, state.conversation?.session ?? null);
    const bytes = await profile.services.artifacts.get(prepared.head.artifact, state.policy);
    assert.deepEqual(ContextFrameSchema.parse(JSON.parse(new TextDecoder().decode(bytes))), prepared.frame);
    // prepare stages a derived task frame; it neither installs contextHead nor publishes a model session summary.
    assert.deepEqual(await profile.runtime.state(workId), state);
    frames.push({ role, state, prepared, bytes });
  }
  return frames;
}

async function restoreWorkingSets(f: Fixture, frames: Awaited<ReturnType<typeof stageWorkingSets>>) {
  for (const { role, state, prepared, bytes } of frames) {
    const profile = f.current(role), current = await profile.runtime.state(state.id);
    assert.deepEqual(original(current), original(state)); assert.deepEqual(current.budget, state.budget);
    assert.deepEqual(current.budgetGrants, state.budgetGrants); assert.deepEqual(current.budgetParent, state.budgetParent);
    assert.deepEqual(current.contextHead, state.contextHead);
    assert.deepEqual(await profile.services.artifacts.get(prepared.head.artifact, current.policy), bytes);
    const restored = await profile.recovery.restore(state.id, profile.actor);
    assert.equal(restored.packet.workId, state.id); assert.deepEqual(restored.packet.context.goal, state.goal);
    assert.deepEqual(restored.packet.context.session?.basis ?? null, state.conversation?.session ?? null);
    assert.deepEqual(restored.packet.runtime.budget, state.budget); assert.equal(restored.packet.runtime.deadlineAt, state.deadlineAt);
    assert.deepEqual(await profile.runtime.state(state.id), current, 'recovery reads canonical state without resetting its ledger');
  }
}

async function privateStores(f: Fixture, workId: string) {
  const pair = await f.child(workId), sponsor = f.current('sponsor'), recipient = f.current('recipient');
  assert.equal(JSON.stringify([pair.parent, f.observed.sponsorInputs]).includes(BUDGET_ENTRY_SECRET), false);
  assert.equal(JSON.stringify([pair.parent, f.observed.sponsorInputs]).includes(BUDGET_ENTRY_REQUEST_REASON), false);
  assert.equal(await sponsor.services.artifacts.exists(f.raw('recipient')), false);
  assert.equal(await recipient.services.artifacts.exists(f.raw('sponsor')), false);
  await assert.rejects(sponsor.services.artifacts.get(f.raw('recipient'), sponsor.policy));
  await assert.rejects(recipient.services.artifacts.get(f.raw('sponsor'), recipient.policy));
  assert.deepEqual(await f.memory('sponsor'), []); assert.deepEqual(await f.memory('recipient'), []);
}

function settled(pair: Awaited<ReturnType<Fixture['child']>>) {
  assert.equal(pair.state.status, 'completed'); assert.equal(pair.grant.status, 'settled');
  assert.equal(pair.grant.unmeasuredModelCalls, 0);
  for (const dimension of BUDGET_DIMENSIONS) {
    assert.equal(pair.grant.accounted[dimension], pair.state.budget.used[dimension], dimension);
    assert.equal(pair.grant.reserved[dimension], 0, dimension);
  }
}

test('budget compact entry: a real session summary charges only its sponsor once and an active separate grant survives task frames and reopen', { timeout: 180000 }, async t => {
  const compacts: { role: BudgetEntryRole; input: SessionCompactInput; candidate: SessionCompactCandidate }[] = [];
  const f = await budgetToolsEntryFixture(t, { compactPlanner(role, identity) {
    const adapter = new StructuredSessionCompactAdapter({ identity, destination: 'local', maxRequestBytes: 131072,
      capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 100000, maxOutputTokens: 2048 } },
    { async invoke(request, signal) {
      signal.throwIfAborted(); assert.deepEqual(request.options.tools, []);
      const input = request.compact, entry = input.entries.find(value => value.role === 'user' && value.text.length > 0 &&
        value.sequence > (input.previous?.ref.throughSequence ?? 0)); assert.ok(entry, 'compact must quote a real new user entry');
      const retained = structuredClone(input.previous?.content.retained ?? []), quote = entry.text.slice(0, 96);
      retained.push({ id: `budget-source-${entry.sequence}`, kind: 'reference', status: 'active', text: 'Retain the explicit resource request.',
        citations: [{ sequence: entry.sequence, sourceId: entry.sourceId, role: entry.role, quote }] });
      const candidate: SessionCompactCandidate = { inputDigest: input.inputDigest, content: { narrative: 'Resource requests remain tied to their original work.', retained } };
      assert.ok(Buffer.byteLength(JSON.stringify(candidate.content)) < Buffer.byteLength(JSON.stringify({ previous: input.previous?.content ?? null, entries: input.entries })));
      compacts.push({ role, input: structuredClone(input), candidate: structuredClone(candidate) });
      return { provider: identity.provider, model: identity.model, finish: 'stop', content: JSON.stringify(candidate), usage: { inputTokens: 120, outputTokens: 40 } };
    } });
    return { compact: adapter.compact.bind(adapter), estimateCompactInput: adapter.estimateCompactInput.bind(adapter) };
  } });
  f.controls.steps = [];
  let historySession: string | undefined;
  for (let index = 0; index < 6; index++) {
    const accepted = await f.accept(`history-${index}`), profile = f.current('sponsor');
    historySession ??= accepted.sessionId; assert.equal(accepted.sessionId, historySession);
    const run = await profile.workflow.run(accepted.workId, profile.executionActor, { maxSteps: 20 });
    assert.equal(run.control.kind, 'complete', JSON.stringify(run));
  }
  assert.equal(compacts.length, 0, 'the six completed history works do not require an implicit compact');
  f.controls.steps = [budgetStatus, budgetAllocate(), budgetRun];
  const accepted = await f.accept('active-grant-summary'), sponsor = f.current('sponsor');
  assert.equal(accepted.sessionId, historySession);
  assert.equal((await f.through(accepted.workId, 2)).result.status, 'success');
  const before = await f.child(accepted.workId), history = await sponsor.sessions.history(sponsor.actor, accepted.sessionId, sponsor.policy, { limit: 50 });
  assert.equal(before.grant.status, 'active'); assert.equal(before.state.modelCalls.length, 0); assert.equal(before.state.attempts.length, 0);
  const genesis = await f.current('recipient').services.state.receipt(before.state.id, 'budget.child-genesis'); assert.ok(genesis);
  const planning = sponsor.compactPlanning; assert.ok(planning);
  const call = await planning.requestCompact(accepted.workId, { requestId: 'active-grant-summary-once', force: true, expectedGoalRevision: 1 }); assert.ok(call);
  assert.equal(call.purpose, 'session_compact'); await planning.execute(accepted.workId, call.id);
  assert.equal(await planning.adopt(accepted.workId, call.id), true);
  const compacted = await f.child(accepted.workId), publication = await sponsor.sessions.compactPublication(compacted.parent, call.id, compacts[0]!.input);
  assert.ok(publication); assert.equal(compacts.length, 1); assert.equal(compacts[0]!.role, 'sponsor');
  assert.equal(publication.inputDigest, compacts[0]!.input.inputDigest); assert.deepEqual(publication.content, compacts[0]!.candidate.content);
  const charged = compacted.parent.modelCalls.find(value => value.id === call.id); assert.ok(charged);
  assert.equal(charged.status, 'accepted'); assert.equal(charged.inputTokens, 120); assert.equal(charged.outputTokens, 40);
  assert.deepEqual(compacted.parent.budget.used, { ...before.parent.budget.used,
    modelCalls: before.parent.budget.used.modelCalls + 1, tokens: before.parent.budget.used.tokens + 160 });
  assert.equal(compacted.parent.budget.reservedModelCalls, before.parent.budget.reservedModelCalls);
  assert.equal(compacted.parent.budget.reservedTokens, before.parent.budget.reservedTokens);
  assert.deepEqual(original(compacted.parent), original(before.parent));
  // Compact reservation reconciles the still-unexecuted recipient's first real ledger observation.
  assert.equal(before.grant.childStateRevision, null);
  assert.equal(compacted.grant.childStateRevision, before.state.revision);
  assert.deepEqual(compacted.grant, { ...before.grant, childStateRevision: before.state.revision });
  assert.deepEqual(compacted.state, before.state); assert.deepEqual(compacted.parent.plan, before.parent.plan);
  assert.deepEqual(compacted.parent.evidence, []); assert.equal(compacted.parent.generatedAnswer, undefined);
  const summarizedContext = await sponsor.sessions.context(compacted.parent); assert.ok(summarizedContext?.schemaVersion === 2);
  assert.deepEqual(summarizedContext.summary.ref, publication.ref);
  const duplicate = await planning.requestCompact(accepted.workId, { requestId: 'active-grant-summary-once', force: true, expectedGoalRevision: 1 });
  assert.equal(duplicate?.id, call.id); assert.equal(compacts.length, 1);
  assert.deepEqual((await sponsor.runtime.state(accepted.workId)).budget, compacted.parent.budget);
  const frames = await stageWorkingSets(f, accepted.workId, before.state.id);
  assert.equal(compacts.length, 1); assert.equal(f.observed.runs.length, 0); await privateStores(f, accepted.workId);
  const sponsorCalls = f.observed.sponsorInputs.length; await f.reopen(); await restoreWorkingSets(f, frames);
  const reopened = f.current('sponsor'), held = await f.child(accepted.workId);
  assert.deepEqual(await reopened.sessions.compactPublication(held.parent, call.id, compacts[0]!.input), publication);
  assert.deepEqual((await reopened.sessions.history(reopened.actor, accepted.sessionId, reopened.policy, { limit: 50 })).entries, history.entries);
  assert.deepEqual(await f.current('recipient').services.state.receipt(before.state.id, 'budget.child-genesis'), genesis);
  assert.equal(f.observed.sponsorInputs.length, sponsorCalls); assert.equal(f.observed.recipientInputs.length, 0); assert.equal(compacts.length, 1);
  assert.equal((await f.through(accepted.workId, 3)).result.status, 'success');
  const continued = f.observed.sponsorInputs.slice(sponsorCalls).find(input => input.packet.workId === accepted.workId); assert.ok(continued);
  const continuedSession = continued.packet.session; assert.ok(continuedSession?.schemaVersion === 2);
  assert.deepEqual(continuedSession.summary.ref, publication.ref, 'the actual next model call uses the published session summary');
  assert.deepEqual(continuedSession.summary.content, publication.content);
  const done = await f.child(accepted.workId); settled(done);
  assert.equal(done.grant.id, before.grant.id); assert.equal(done.state.id, before.state.id); assert.deepEqual(original(done.parent), original(before.parent));
  assert.deepEqual(original(done.state), original(before.state)); assert.equal(f.observed.reads.length, 1);
  const completed = await reopened.workflow.run(accepted.workId, reopened.executionActor, { maxSteps: 12 });
  assert.equal(completed.control.kind, 'complete', JSON.stringify(completed)); await privateStores(f, accepted.workId);
});

test('budget compact entry: task working sets and reopen preserve a pending request before the same observed grant is increased and resumed', { timeout: 180000 }, async t => {
  const f = await budgetToolsEntryFixture(t, { child: 'request' });
  f.controls.steps = [budgetStatus, budgetAllocate(), budgetRun, budgetStatus, budgetIncrease, budgetRun];
  const accepted = await f.accept('pending-request-frames');
  assert.equal((await f.through(accepted.workId, 3)).result.status, 'success');
  const status = await f.through(accepted.workId, 4); assert.equal(status.result.status, 'success');
  const before = await f.child(accepted.workId), obligation = before.state.obligations.find(value => value.id.startsWith('budget-request:'));
  assert.ok(obligation); assert.equal(obligation.status, 'pending'); assert.equal(before.grant.status, 'active');
  assert.deepEqual(budgetObject(status.result.output)['delegatedRequests'], [{ grantId: before.grant.id, requestId: obligation.id, extra: BUDGET_ENTRY_EXTRA }]);
  const requestReceipt = await f.current('recipient').services.state.receipt(before.state.id, obligation.id); assert.ok(requestReceipt);
  const requestResult = await f.result('recipient', before.state.id, 'recipient-request');
  assert.equal(requestResult.result.status, 'success'); assert.equal(f.observed.reads.length, 0);
  const frames = await stageWorkingSets(f, accepted.workId, before.state.id);
  const calls = { sponsor: f.observed.sponsorInputs.length, recipient: f.observed.recipientInputs.length };
  await privateStores(f, accepted.workId); await f.reopen(); await restoreWorkingSets(f, frames);
  const held = await f.child(accepted.workId);
  assert.deepEqual(held.grant, before.grant); assert.deepEqual(held.state.obligations.find(value => value.id === obligation.id), obligation);
  assert.deepEqual(await f.current('recipient').services.state.receipt(before.state.id, obligation.id), requestReceipt);
  assert.deepEqual((await f.result('recipient', before.state.id, 'recipient-request')).bytes, requestResult.bytes);
  assert.equal(f.observed.sponsorInputs.length, calls.sponsor); assert.equal(f.observed.recipientInputs.length, calls.recipient);
  assert.equal((await f.through(accepted.workId, 5)).result.status, 'success');
  const increased = await f.child(accepted.workId);
  assert.equal(increased.grant.id, before.grant.id); assert.equal(increased.state.id, before.state.id);
  assert.deepEqual(increased.state.budget.limits, { ...BUDGET_ENTRY_CHILD_LIMITS, toolCalls: BUDGET_ENTRY_CHILD_LIMITS.toolCalls + 1 });
  assert.equal(increased.state.obligations.find(value => value.id === obligation.id)?.status, 'satisfied');
  assert.deepEqual(original(increased.parent), original(before.parent)); assert.equal(increased.state.deadlineAt, before.state.deadlineAt);
  assert.equal(f.observed.reads.length, 0, 'increase is permission, not recipient execution');
  assert.equal((await f.through(accepted.workId, 6)).result.status, 'success');
  const done = await f.child(accepted.workId); settled(done);
  assert.equal(done.grant.id, before.grant.id); assert.equal(done.state.id, before.state.id); assert.equal(done.parent.budgetGrants!.length, 1);
  assert.equal(f.observed.reads.length, 1); assert.equal(done.state.budget.used.toolCalls, 2); assert.equal(done.state.budget.used.modelCalls, 2);
  assert.deepEqual(await f.current('recipient').services.state.receipt(before.state.id, obligation.id), requestReceipt);
  assert.deepEqual((await f.result('recipient', before.state.id, 'recipient-request')).bytes, requestResult.bytes);
  const completed = await f.current('sponsor').workflow.run(accepted.workId, f.current('sponsor').executionActor, { maxSteps: 12 });
  assert.equal(completed.control.kind, 'complete', JSON.stringify(completed)); await privateStores(f, accepted.workId);
});
