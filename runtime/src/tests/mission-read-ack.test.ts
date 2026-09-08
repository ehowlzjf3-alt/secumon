import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { transact } from '../application/work-transactions.js';
import { RESIDENT_RULE, residentEntryFixture, residentEvent } from './resident-missions-entry-fixture.js';
import type { MissionRule } from '../application/mission-contracts.js';

async function fixture(t: TestContext, body = 'ACK_ORIGINAL') {
  const f = await residentEntryFixture(t), p = f.current();
  const session = await p.sessions.open(p.actor, { channel: 'test', conversationId: 'resident-conversation' });
  const accepted = await p.turns.accept(p.actor, { sessionId: session.scope.sessionId, messageId: 'ack-request', rawText: 'Read the observed event before answering.',
    mode: 'auto', scope: p.scope, policy: p.policy, limits: p.limits, binding: f.binding('first') });
  const event = residentEvent('ack-event', body); f.pages.first.push([event]); let serial = 0;
  const current = () => f.current();
  async function read(ruleId?: string, maxBytes = 8192) {
    const p = current(), state = await p.runtime.state(accepted.workId), taskId = `read-${++serial}`;
    await p.runtime.submitPlan(state.id, `plan-${serial}`, { baseStateRevision: state.revision, baseGoalRevision: state.goal.revision,
      basePlanRevision: state.plan?.revision ?? 0, reason: 'Explicitly read the registered event.', hypotheses: [],
      tasks: [{ id: taskId, description: 'Read mission input', toolId: 'mission.events', toolVersion: '1', effect: 'read',
        input: { ...(ruleId ? { ruleId } : {}), maxBytes }, dependsOn: [], satisfies: [], maxAttempts: 1 }] });
    const attempt = await p.runtime.reserve(state.id, taskId); await p.runtime.execute(state.id, attempt.id); await p.runtime.adopt(state.id, attempt.id);
    const settled = await p.runtime.state(state.id); return settled.attempts.find(value => value.id === attempt.id)!;
  }
  async function checkpoint(rule: MissionRule) {
    const p = current(), state = await p.runtime.state(accepted.workId), subscription = state.subscriptions?.find(value => value.resourceId === rule.resourceId);
    assert.ok(subscription); const artifact = state.artifacts.find(value => subscription.checkpointId === `mission:${value.sha256}`); assert.ok(artifact);
    const receipt = await p.services.state.receipt(state.id, subscription.checkpointId); assert.ok(receipt);
    const bytes = await p.services.artifacts.get(artifact, state.policy);
    const value = z.object({ events: z.array(z.unknown()), cursor: z.number(), pendingRun: z.boolean(), status: z.enum(['active', 'closed']),
      claim: z.object({ owner: z.string(), until: z.number() }).nullable(), reason: z.string().nullable(),
      acknowledgedRead: z.object({ attemptId: z.string(), resultId: z.string() }).optional() }).parse(JSON.parse(new TextDecoder().decode(bytes)));
    return { state, subscription, artifact, receipt, bytes, value };
  }
  return { f, current, workId: accepted.workId, event, read, checkpoint };
}

test('full native mission reads acknowledge only their exact rule and retain original pages across reopen', async t => {
  const h = await fixture(t), other = { ...RESIDENT_RULE, id: 'another-rule', resourceId: 'another-resource' }, p = h.current();
  await p.missions!.register(h.workId, RESIDENT_RULE); await p.missions!.register(h.workId, other);
  await p.missions!.refresh(h.workId); const original = await h.checkpoint(RESIDENT_RULE);
  assert.equal(original.state.notifications?.length, 2); assert.equal(original.value.acknowledgedRead, undefined);
  assert.equal((await h.read()).status, 'succeeded'); await p.missions!.refresh(h.workId);
  assert.equal((await h.checkpoint(RESIDENT_RULE)).value.acknowledgedRead, undefined, 'listing is not an event-body read');
  const read = await h.read(RESIDENT_RULE.id); assert.equal(read.adopted, true);
  // This sentinel has no claimed board proof; it only checks that the mission ACK does not delete another provider's notice.
  const foreign = { id: 'foreign-notice', provider: 'board', subscriptionId: original.subscription.id, resourceId: 'unrelated-board',
    referenceId: 'unrelated-post', goalRevision: 1, observedPlanRevision: 0, receivedAt: Date.now() };
  await transact(p.services, h.workId, 'unrelated-notice', 'test_unrelated_notice', {}, state => { state.notifications!.push(foreign); });
  await p.missions!.refresh(h.workId); const acknowledged = await h.checkpoint(RESIDENT_RULE);
  assert.deepEqual(acknowledged.value.acknowledgedRead, { attemptId: read.id, resultId: read.resultId });
  assert.deepEqual(acknowledged.value.events, [h.event]);
  assert.deepEqual(acknowledged.state.notifications?.filter(value => value.provider === 'board'), [foreign]);
  assert.deepEqual(acknowledged.state.notifications?.filter(value => value.provider === 'mission').map(value => value.resourceId), [other.resourceId]);
  assert.equal((await h.checkpoint(other)).value.acknowledgedRead, undefined);
  assert.equal(acknowledged.state.obligations.find(value => value.id === 'mission-wait')?.status, 'satisfied');
  assert.deepEqual(acknowledged.state.evidence, []); assert.notEqual(acknowledged.state.status, 'completed');
  assert.equal(acknowledged.state.budget.used.modelCalls, 0);
  await h.f.reopen(); const reopened = await h.checkpoint(RESIDENT_RULE);
  assert.deepEqual(reopened.bytes, acknowledged.bytes); assert.deepEqual(reopened.receipt, acknowledged.receipt);
  assert.deepEqual((await h.current().missions!.readEvents(h.workId, RESIDENT_RULE.id)).events, [h.event]);
  assert.deepEqual(await h.current().services.artifacts.get(original.artifact, original.state.policy), original.bytes);
  assert.deepEqual(await h.current().services.state.receipt(h.workId, original.subscription.checkpointId), original.receipt);
});

test('partial mission output and an old-goal read cannot acknowledge unread current input', async t => {
  const h = await fixture(t, 'large original '.repeat(200)), p = h.current();
  await p.missions!.register(h.workId, RESIDENT_RULE); await p.missions!.refresh(h.workId);
  const partial = await h.read(RESIDENT_RULE.id, 512); assert.equal(partial.status, 'partial'); assert.equal(partial.adopted, true);
  await p.missions!.refresh(h.workId); assert.equal((await h.checkpoint(RESIDENT_RULE)).value.acknowledgedRead, undefined);
  assert.equal((await p.runtime.state(h.workId)).notifications?.length, 1);
  const full = await h.read(RESIDENT_RULE.id); assert.equal(full.status, 'succeeded');
  const before = await p.runtime.state(h.workId);
  await p.runtime.command(h.workId, 'new-goal', p.actor, 1, { kind: 'goal', goal: { ...before.goal, revision: 2 }, expectedControlRevision: before.executionControl!.revision });
  const currentRule = { ...RESIDENT_RULE, id: 'new-goal-rule', resourceId: 'new-goal-resource' };
  await p.missions!.register(h.workId, currentRule); await p.missions!.refresh(h.workId);
  const current = await h.checkpoint(currentRule); assert.equal(current.value.acknowledgedRead, undefined);
  assert.deepEqual(current.value.events, [h.event]); assert.equal(current.state.notifications?.length, 1);
  assert.equal(current.state.attempts.find(value => value.id === full.id)?.goalRevision, 1);
  assert.equal(current.state.budget.used.modelCalls, 0);
});

test('copied mission descriptors and a provider withdrawn during result reading cannot issue an acknowledgment', async t => {
  const h = await fixture(t), p = h.current(), native = p.services.tools.find(value => value.definition.id === 'mission.events'); assert.ok(native);
  await p.missions!.register(h.workId, RESIDENT_RULE); await p.missions!.refresh(h.workId);
  p.contracts.replaceProvider('mission', [{ definition: structuredClone(native.definition), execute: native.execute.bind(native) }],
    { expectedEpoch: p.contracts.providerEpoch('mission'), sourceRevision: 'copied' });
  const copied = await h.read(RESIDENT_RULE.id); assert.equal(copied.status, 'succeeded'); assert.equal(copied.adopted, true);
  await p.missions!.refresh(h.workId); assert.equal((await h.checkpoint(RESIDENT_RULE)).value.acknowledgedRead, undefined);
  p.contracts.replaceProvider('mission', [native], { expectedEpoch: p.contracts.providerEpoch('mission'), sourceRevision: 'native-again' });
  const original = await h.read(RESIDENT_RULE.id); assert.ok(original.resultArtifact);
  const get = p.services.artifacts.get.bind(p.services.artifacts); let withdrawn = false;
  p.services.artifacts.get = async (ref, policy) => {
    const bytes = await get(ref, policy);
    if (!withdrawn && ref.id === copied.resultArtifact!.id) {
      withdrawn = true; p.contracts.replaceProvider('mission', [], { expectedEpoch: p.contracts.providerEpoch('mission'), sourceRevision: 'withdrawn' });
    }
    return bytes;
  };
  try { await assert.rejects(p.missions!.refresh(h.workId), /invocation_unavailable|mission_state_changed/); }
  finally { p.services.artifacts.get = get; }
  assert.equal(withdrawn, true); assert.equal((await h.checkpoint(RESIDENT_RULE)).value.acknowledgedRead, undefined);
  assert.equal((await p.runtime.state(h.workId)).notifications?.length, 1);
});

test('verified mission completion closes its checkpoint and releases the claim while preserving the original page across reopen', { timeout: 120000 }, async t => {
  const h = await fixture(t), p = h.current(); h.f.controls.readMission = true;
  await p.missions!.register(h.workId, RESIDENT_RULE); await p.missions!.refresh(h.workId);
  const original = await h.checkpoint(RESIDENT_RULE);
  const result = await p.missions!.tick(h.workId, p.workflow, { maxSteps: 20 }); assert.equal(result.kind, 'ran');
  if (result.kind !== 'ran') return;
  assert.equal(result.result.control.kind, 'complete');
  const closed = await h.checkpoint(RESIDENT_RULE);
  assert.equal(closed.state.status, 'completed'); assert.equal(closed.value.status, 'closed');
  assert.equal(closed.value.reason, 'completed'); assert.equal(closed.value.claim, null); assert.equal(closed.value.pendingRun, false);
  assert.deepEqual(closed.value.events, [h.event]); assert.equal(closed.value.cursor, original.value.cursor);
  assert.ok(closed.value.acknowledgedRead); assert.deepEqual(closed.state.notifications, []);
  assert.equal(closed.state.obligations.find(value => value.id === 'mission-wait')?.status, 'satisfied');
  assert.equal(closed.state.budget.used.modelCalls, 3); assert.equal(closed.state.budget.used.toolCalls, 2);
  assert.deepEqual(closed.state.evidence, []); assert.deepEqual(await h.f.memory('first'), []);
  assert.deepEqual(closed.receipt.state.subscriptions?.find(value => value.id === closed.subscription.id), closed.subscription);
  await h.f.reopen(); const reopened = await h.checkpoint(RESIDENT_RULE);
  assert.deepEqual(reopened.bytes, closed.bytes); assert.deepEqual(reopened.receipt, closed.receipt);
  const view = await h.current().missions!.readEvents(h.workId, RESIDENT_RULE.id);
  assert.equal(view.status, 'closed'); assert.deepEqual(view.events, [h.event]);
  assert.equal((await h.current().missions!.tick(h.workId, h.current().workflow)).kind, 'idle');
  assert.deepEqual(await h.current().runtime.state(h.workId), closed.state);
  assert.deepEqual(await h.current().services.artifacts.get(original.artifact, original.state.policy), original.bytes);
  assert.deepEqual(await h.current().services.state.receipt(h.workId, original.subscription.checkpointId), original.receipt);
});

test('a completion receipt corrupted after workflow return cannot release a mission claim or replace its original checkpoint', { timeout: 120000 }, async t => {
  const h = await fixture(t), p = h.current(); h.f.controls.readMission = true;
  await p.missions!.register(h.workId, RESIDENT_RULE);
  const receipt = p.services.state.receipt.bind(p.services.state), run = p.workflow.run.bind(p.workflow);
  const observed: { finished: boolean; corrupted: number; completion?: { commandId: string; receipt: NonNullable<Awaited<ReturnType<typeof receipt>>> } } =
    { finished: false, corrupted: 0 };
  p.services.state.receipt = async (workId, commandId) => {
    const value = await receipt(workId, commandId);
    if (workId === h.workId && commandId.startsWith('control:') && value?.state.status === 'completed') {
      observed.completion ??= { commandId, receipt: structuredClone(value) };
      if (observed.finished) { observed.corrupted++; return { ...value, digest: '0'.repeat(64) }; }
    }
    return value;
  };
  p.workflow.run = async (...args) => { const result = await run(...args); assert.equal(result.control.kind, 'complete'); observed.finished = true; return result; };
  try { await assert.rejects(p.missions!.tick(h.workId, p.workflow, { maxSteps: 20 }), /^Error: mission_state_changed$/); }
  finally { p.services.state.receipt = receipt; p.workflow.run = run; }
  assert.equal(observed.finished, true); assert.ok(observed.corrupted > 0); assert.ok(observed.completion);
  const retained = await h.checkpoint(RESIDENT_RULE);
  assert.equal(retained.state.status, 'completed'); assert.equal(retained.subscription.status, 'closed');
  assert.equal(retained.value.status, 'active'); assert.ok(retained.value.claim); assert.equal(retained.value.pendingRun, true);
  assert.deepEqual(retained.value.events, [h.event]); assert.ok(retained.value.acknowledgedRead);
  assert.equal(retained.subscription.checkpointId, observed.completion.receipt.state.subscriptions?.find(value => value.id === retained.subscription.id)?.checkpointId);
  assert.deepEqual(await receipt(h.workId, observed.completion.commandId), observed.completion.receipt, 'the injected bad observation did not rewrite the actual completion receipt');
  const original = retained.receipt.state.subscriptions?.find(value => value.id === retained.subscription.id); assert.ok(original);
  assert.equal(original.status, 'active'); assert.equal(original.checkpointId, retained.subscription.checkpointId);
  await assert.rejects(p.missions!.readEvents(h.workId, RESIDENT_RULE.id), /^Error: mission_state_changed$/);
  assert.equal(retained.state.budget.used.modelCalls, 3); assert.equal(retained.state.budget.used.toolCalls, 2);
  assert.deepEqual(retained.state.evidence, []);
});
