import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { z } from 'zod';
import { MissionEventSchema, MissionRuleSchema } from '../application/mission-contracts.js';
import { asJson } from '../application/plan-validator.js';
import type { MissionRule } from '../application/mission-contracts.js';
import { RESIDENT_RULE, residentEntryFixture, residentEvent } from './resident-missions-entry-fixture.js';

const checkpointSchema = z.object({ workId: z.string(), createdAt: z.number(), rule: MissionRuleSchema,
  goalRevision: z.number(), generation: z.number(), cursor: z.number(), status: z.enum(['active', 'closed']),
  events: z.array(MissionEventSchema), pendingRun: z.boolean(), reason: z.string().nullable(),
  claim: z.object({ owner: z.string(), until: z.number() }).nullable(),
  acknowledgedRead: z.object({ attemptId: z.string(), resultId: z.string() }).optional() });

/** Actual SQLite profiles, native reads and the existing deterministic model; no additional permissions or limits. */
export async function missionTerminalFixture(t: TestContext) {
  const f = await residentEntryFixture(t), p = f.current(); f.controls.readMission = true;
  const session = await p.sessions.open(p.actor, { channel: 'test', conversationId: 'resident-conversation' });
  const accepted = await p.turns.accept(p.actor, { sessionId: session.scope.sessionId, messageId: 'terminal-two-rules',
    rawText: 'Report the current observed event after reading both explicitly registered rules.', mode: 'auto',
    scope: p.scope, policy: p.policy, limits: p.limits, binding: f.binding('first') });
  const rules: MissionRule[] = [{ ...RESIDENT_RULE }, { ...RESIDENT_RULE, id: 'second-terminal-rule' }];
  // Two rules may watch the same source resource. Each still has its own original checkpoint and ACK.
  const event = residentEvent('terminal-original-event', 'TERMINAL_ORIGINAL_BODY'); f.pages.first.push([event]);
  for (const rule of rules) await p.missions!.register(accepted.workId, rule);
  await p.missions!.refresh(accepted.workId);
  const current = () => f.current();
  async function checkpoints() {
    const profile = current(), state = await profile.runtime.state(accepted.workId);
    return Promise.all(rules.map(async rule => {
      const subscription = state.subscriptions?.find(value => value.provider === 'mission' && value.id ===
        `mission-${profile.services.digester.digest(asJson({ agentId: profile.agentId, ruleId: rule.id }))}`);
      assert.ok(subscription);
      const artifact = state.artifacts.find(value => subscription.checkpointId === `mission:${value.sha256}`); assert.ok(artifact);
      const receipt = await profile.services.state.receipt(state.id, subscription.checkpointId); assert.ok(receipt);
      const bytes = await profile.services.artifacts.get(artifact, state.policy);
      const value = checkpointSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      assert.deepEqual(value.rule, rule); assert.equal(value.workId, state.id);
      return { subscription, artifact, receipt, bytes, value };
    }));
  }
  const original = await checkpoints();
  for (const [index, rule] of rules.entries()) {
    const state = await p.runtime.state(accepted.workId), taskId = `terminal-rule-read-${index}`;
    await p.runtime.submitPlan(state.id, `plan:${taskId}`, { baseStateRevision: state.revision, baseGoalRevision: state.goal.revision,
      basePlanRevision: state.plan?.revision ?? 0, reason: 'Read the exact current page for each registered rule.', hypotheses: [],
      tasks: [{ id: taskId, description: 'Read this rule without promoting it to evidence.', toolId: 'mission.events', toolVersion: '1',
        effect: 'read', input: { ruleId: rule.id, maxBytes: 8192 }, dependsOn: [], satisfies: [], maxAttempts: 1 }] });
    const attempt = await p.runtime.reserve(state.id, taskId);
    await p.runtime.execute(state.id, attempt.id); await p.runtime.adopt(state.id, attempt.id);
  }
  await p.missions!.refresh(accepted.workId);
  const prepared = await p.runtime.state(accepted.workId), acknowledged = await checkpoints();
  assert.equal(prepared.attempts.length, 2); assert.ok(prepared.attempts.every(value => value.adopted && value.status === 'succeeded'));
  assert.equal(prepared.budget.used.modelCalls, 0); assert.equal(prepared.budget.used.toolCalls, 2);
  assert.equal(prepared.progress?.policy.maxUnproductiveSteps, 3);
  assert.deepEqual(prepared.notifications, []);
  for (const item of acknowledged) { assert.deepEqual(item.value.events, [event]); assert.ok(item.value.acknowledgedRead); }

  async function completion() {
    const profile = current(), events = await profile.services.state.events(accepted.workId, 0);
    const event = events.findLast(value => value.type === 'control_selected' &&
      JSON.stringify(value.data.payload) === JSON.stringify({ kind: 'complete', reason: 'criteria_verified' }));
    assert.ok(event, 'a real control_selected complete event must exist');
    const commandId = `control:${event.revision - 1}`;
    const receipt = await profile.services.state.receipt(accepted.workId, commandId); assert.ok(receipt);
    assert.equal(receipt.state.status, 'completed');
    assert.equal(receipt.digest, profile.services.digester.digest({ type: 'control_selected', data: { kind: 'complete', reason: 'criteria_verified' } }));
    return { commandId, receipt };
  }
  async function records() {
    const profile = current(), state = await profile.runtime.state(accepted.workId), complete = await completion();
    const commandIds = [...new Set([complete.commandId, ...state.subscriptions!.map(value => value.checkpointId),
      ...state.attempts.flatMap(value => [`dispatch:${value.id}`, `receive:${value.id}`, `adopt:${value.id}`])])];
    const receipts = await Promise.all(commandIds.map(async commandId => {
      const receipt = await profile.services.state.receipt(state.id, commandId); assert.ok(receipt); return { commandId, receipt };
    }));
    const refs = new Map([...state.artifacts,
      ...state.attempts.flatMap(value => value.resultArtifact ? [value.resultArtifact] : []),
      ...state.modelCalls.flatMap(value => [value.inputArtifact, ...(value.replyArtifact ? [value.replyArtifact] : [])]),
      ...(state.conversation?.result ? [state.conversation.result.artifact] : [])].map(value => [value.id, value]));
    const originals = await Promise.all([...refs.values()].map(async artifact => ({ artifact,
      bytes: await profile.services.artifacts.get(artifact, state.policy) })));
    return { state, complete, receipts, originals, events: await profile.services.state.events(state.id, 0),
      deliveries: await profile.services.state.deliveries(state.id), inputs: structuredClone(f.observed.inputs.first), polls: structuredClone(f.observed.polls) };
  }
  async function preserve(prior: Awaited<ReturnType<typeof records>>, unchangedState = false) {
    const profile = current(), state = await profile.runtime.state(accepted.workId);
    if (unchangedState) {
      assert.deepEqual(state, prior.state);
      assert.deepEqual(await profile.services.state.events(state.id, 0), prior.events);
    }
    assert.deepEqual(state.goal, prior.state.goal); assert.deepEqual(state.policy, prior.state.policy);
    assert.deepEqual(state.attempts, prior.state.attempts); assert.deepEqual(state.modelCalls, prior.state.modelCalls);
    assert.deepEqual(state.budget, prior.state.budget); assert.deepEqual(state.evidence, prior.state.evidence);
    assert.deepEqual(state.conversation, prior.state.conversation);
    assert.deepEqual(await profile.services.state.deliveries(state.id), prior.deliveries);
    assert.deepEqual(f.observed.inputs.first, prior.inputs); assert.deepEqual(f.observed.polls, prior.polls);
    for (const { commandId, receipt } of prior.receipts)
      assert.deepEqual(await profile.services.state.receipt(state.id, commandId), receipt);
    for (const { artifact, bytes } of [...prior.originals, ...original])
      assert.deepEqual(await profile.services.artifacts.get(artifact, prior.state.policy), bytes);
    for (const item of original) assert.deepEqual(await profile.services.state.receipt(state.id, item.subscription.checkpointId), item.receipt);
  }
  async function interruptAfterComplete() {
    const profile = current(), run = profile.workflow.run, interruption = new Error('test_interrupt_after_actual_workflow_complete');
    let returnedComplete = false;
    profile.workflow.run = async (...args) => {
      const result = await run.apply(profile.workflow, args);
      assert.equal(result.control.kind, 'complete'); returnedComplete = true;
      throw interruption;
    };
    try { await assert.rejects(profile.missions!.tick(accepted.workId, profile.workflow, { maxSteps: 20 }), error => error === interruption); }
    finally { profile.workflow.run = run; }
    assert.equal(returnedComplete, true, 'the injected exception follows the actual ordinary workflow completion');
    const prior = await records(), raw = await checkpoints();
    assert.equal(prior.state.status, 'completed'); assert.ok(prior.state.subscriptions!.every(value => value.status === 'closed'));
    assert.ok(raw.some(value => value.value.status === 'active' && value.value.claim !== null));
    assert.equal(prior.state.budget.used.modelCalls, 1); assert.equal(prior.state.budget.used.toolCalls, 2);
    return prior;
  }
  return { f, current, workId: accepted.workId, rules, event, original, acknowledged, prepared, checkpoints, completion, records, preserve, interruptAfterComplete };
}
