import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { z } from 'zod';
import type { AgentTurnResult } from '../domain/agent-turn.js';
import type { ContextPacket, Json } from '../domain/model.js';
import { BOARD_WRITE_TOOLS } from '../application/board-commands.js';
import { MissionEventSchema, MissionRuleSchema, type MissionEvent, type MissionEventSource } from '../application/mission-contracts.js';
import { ToolResultSchema } from '../application/contracts.js';
import type { AgentTurnProfile } from '../presentation/agent-turn-profile.js';
import type { HostMissionRegistration } from '../presentation/host-missions.js';
import { boardDeploymentFixture, SOURCE_TOOL, specs } from './board-deployment-entry-fixture.js';
import { RESIDENT_RULE, residentEvent } from './resident-missions-entry-fixture.js';

export const COMPOSITION_RULE = { ...RESIDENT_RULE, id: 'board-and-mission', resourceId: 'board-event-resource' };
export const SECOND_RULE = { ...COMPOSITION_RULE, id: 'unread-other-rule', resourceId: 'other-event-resource' };
const eventPage = z.object({ kind: z.literal('unreviewed_mission_events'), rule: MissionRuleSchema, events: z.array(MissionEventSchema), cursor: z.number() });
const rulePage = z.object({ kind: z.literal('mission_rules'), rules: z.array(z.object({ rule: MissionRuleSchema })) });
const checkpointPage = z.object({ rule: MissionRuleSchema, events: z.array(MissionEventSchema), cursor: z.number(),
  pendingRun: z.boolean(), status: z.enum(['active', 'closed']), reason: z.string().nullable(),
  claim: z.object({ owner: z.string(), until: z.number() }).nullable(),
  acknowledgedRead: z.object({ attemptId: z.string(), resultId: z.string() }).optional() });

function missionPlan(packet: ContextPacket, input: Record<string, Json>): AgentTurnResult {
  assert.ok(packet.activeToolIds.includes('mission.events'));
  return { kind: 'plan', proposal: { baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision,
    basePlanRevision: packet.plan?.revision ?? 0, reason: 'Read the registered current event before the board reply.', hypotheses: [],
    tasks: [{ id: `mission-read-${packet.stateRevision}`, toolId: 'mission.events', toolVersion: '1', effect: 'read',
      description: 'Read unreviewed mission input.', input, dependsOn: [], satisfies: [], maxAttempts: 1 }] } };
}

/** Reuses the actual independent SQLite deployments and board source registry; only the optional local mission port/model prelude is added. */
export function boardMissionCompositionFixture(t: TestContext, model = false) {
  const pages = new Map<string, MissionEvent[][]>();
  const observed = { polls: [] as { agentId: string; resourceId: string; cursor: number }[], opens: [] as string[], closes: [] as string[] };
  const missions: HostMissionRegistration = { async open(context) {
    observed.opens.push(context.agentId);
    const source: MissionEventSource = { id: COMPOSITION_RULE.sourceId, destination: 'local', labels: ['synthetic'], async poll(input) {
      await input.authorize(); input.signal.throwIfAborted();
      observed.polls.push({ agentId: context.agentId, resourceId: input.resourceId, cursor: input.cursor });
      const page = pages.get(input.resourceId)?.[input.cursor];
      return { cursor: page ? input.cursor + 1 : input.cursor, snapshotDigest: page ? `page-${input.cursor + 1}` : input.snapshotDigest,
        events: structuredClone(page ?? []) };
    } };
    return { sources: [source], async close() { observed.closes.push(context.agentId); } };
  } };
  const base = boardDeploymentFixture(t, { missions, turn(input, which) {
    if (!model || which !== 1) return undefined;
    const packet = input.packet, observations = packet.toolObservations ?? [];
    const outputs = observations.filter(value => value.toolId === 'mission.events' && value.status === 'success').map(value => value.output);
    const listed = outputs.map(value => rulePage.safeParse(value)).find(value => value.success);
    const read = outputs.map(value => eventPage.safeParse(value)).find(value => value.success);
    if (!read?.success) {
      if (!listed?.success) return missionPlan(packet, { maxBytes: 8192 });
      const selected = listed.data.rules.find(value => value.rule.resourceId === COMPOSITION_RULE.resourceId); assert.ok(selected);
      return missionPlan(packet, { ruleId: selected.rule.id, maxBytes: 8192 });
    }
    // A full current event page includes its rule even when the bounded packet no longer includes the earlier list.
    assert.equal(read.data.rule.resourceId, COMPOSITION_RULE.resourceId);
    const published = observations.findLast(value => value.toolId === BOARD_WRITE_TOOLS[0] && value.status === 'success');
    if (!published) return undefined; // The existing finite board model reads the source and publishes the cited reply.
    const own = packet.evidence.find(value => value.sourceId === SOURCE_TOOL); assert.ok(own);
    assert.equal(own.facts.summary, specs[1].source);
    return { kind: 'answer', text: `${specs[1].source} Unreviewed mission input: ${JSON.stringify(read.data.events)}`,
      evidenceIds: [own.id], assessment: { type: 'model_self_review', verdict: 'satisfied', missing: [],
        rationale: 'The original source supports the board reply; the mission event is reported as unreviewed input.',
        counterarguments: ['A mission observation is not independent evidence.'] } };
  } });
  function enqueue(rule = COMPOSITION_RULE, text = 'COMPOSED_MISSION_ORIGINAL') {
    const value = { ...residentEvent(`${rule.id}-event`, text), referenceId: rule.resourceId };
    pages.set(rule.resourceId, [[value]]); return value;
  }
  return { ...base, observedMissions: observed, enqueue };
}

export async function compositionCheckpoint(profile: AgentTurnProfile, workId: string, rule = COMPOSITION_RULE) {
  const state = await profile.runtime.state(workId);
  const subscription = state.subscriptions?.find(value => value.provider === 'mission' && value.resourceId === rule.resourceId); assert.ok(subscription);
  const artifact = state.artifacts.find(value => subscription.checkpointId === `mission:${value.sha256}`); assert.ok(artifact);
  const receipt = await profile.services.state.receipt(workId, subscription.checkpointId); assert.ok(receipt);
  const bytes = await profile.services.artifacts.get(artifact, state.policy);
  const value = checkpointPage.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  assert.equal(value.rule.id, rule.id); assert.equal(value.cursor, subscription.cursor);
  return { state, subscription, artifact, receipt, bytes, value };
}

/** Real reserve/execute/adopt and original receipts; this helper never injects a result or mutates work state. */
export async function compositionRead(profile: AgentTurnProfile, workId: string, toolId: string, input: Record<string, Json>) {
  const state = await profile.runtime.state(workId), taskId = `composition-read-${state.revision}`;
  await profile.runtime.submitPlan(workId, `plan-${taskId}`, { baseStateRevision: state.revision, baseGoalRevision: state.goal.revision,
    basePlanRevision: state.plan?.revision ?? 0, reason: 'Read the actual provider input in this work.', hypotheses: [],
    tasks: [{ id: taskId, toolId, toolVersion: '1', effect: 'read', description: toolId, input, dependsOn: [], satisfies: [], maxAttempts: 1 }] });
  const reserved = await profile.runtime.reserve(workId, taskId);
  await profile.runtime.execute(workId, reserved.id); await profile.runtime.adopt(workId, reserved.id);
  const current = await profile.runtime.state(workId), attempt = current.attempts.find(value => value.id === reserved.id); assert.ok(attempt);
  assert.equal(attempt.status, 'succeeded'); assert.equal(attempt.adopted, true); assert.ok(attempt.resultArtifact);
  const bytes = await profile.services.artifacts.get(attempt.resultArtifact, current.policy);
  const result = ToolResultSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  assert.equal(result.resultId, attempt.resultId); assert.equal(result.attemptId, attempt.id);
  const received = await profile.services.state.receipt(workId, `receive:${attempt.id}`), adopted = await profile.services.state.receipt(workId, `adopt:${attempt.id}`);
  assert.ok(received); assert.ok(adopted);
  return { attempt, result, bytes, received, adopted };
}
