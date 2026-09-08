import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentTurnInput } from '../application/agent-turn-types.js';
import type { MissionEvent, MissionEventSource } from '../application/mission-contracts.js';
import type { ContextPacket, Json, Policy } from '../domain/model.js';
import type { AgentTurnResult } from '../domain/agent-turn.js';
import type { SessionCompactCandidate, SessionCompactInput } from '../domain/session-compact.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { StructuredAgentTurnAdapter } from '../infrastructure/structured-agent-turn.js';
import { StructuredSessionCompactAdapter } from '../infrastructure/structured-session-compact.js';
import { openAgentTurnProfile, type AgentTurnProfile } from '../presentation/agent-turn-profile.js';
import type { AgentExecutionHost } from '../presentation/host-tools.js';
import type { RegisteredTurnPlanner } from '../presentation/host-models.js';

export type ResidentRole = 'first' | 'second';
type Driver = ReturnType<AgentTurnProfile['createResidentMissions']>;
export const RESIDENT_RULE = { id: 'same-rule', sourceId: 'observations', resourceId: 'same-resource',
  pollIntervalMs: 1000, maxResumes: 8, maxIdlePolls: 8, maxNoProgress: 3 };
const policy: Policy = { tenantId: 'resident-company', principalId: 'same-operator', allowedTools: [],
  allowedLabels: ['public'], allowedDestinations: ['local'], allowWrites: false };
export function residentEvent(id: string, body: string): MissionEvent {
  return { id, referenceId: RESIDENT_RULE.resourceId, kind: 'observation', occurredAt: 0, body: { text: body } };
}
function currentText(packet: ContextPacket) {
  assert.ok(packet.session); const input = packet.session.basis.input;
  const entry = packet.session.entries.find(value => value.role === 'user' && value.sourceId === input.messageId && value.sequence === input.sequence);
  assert.ok(entry, 'the current original input must be visible'); return entry.text;
}
function answer(text: string): AgentTurnResult {
  return { kind: 'answer', text, evidenceIds: [], assessment: { type: 'model_self_review', verdict: 'satisfied',
    rationale: 'Echo the current unreviewed event or explicit answer.', missing: [], counterarguments: ['The observation is not independently verified.'] } };
}

/** Actual separate profiles, SQLite by default; deterministic local model and observation callbacks only. */
export async function residentEntryFixture(t: TestContext, compact = false, options: { base?: string; stateBackend?: 'sqlite' | 'file-journal' } = {}) {
  const base = realpathSync(options.base ?? mkdtempSync(join(tmpdir(), 'resident-entry-'))), runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
  const profiles = new FileAgentProfileStore(runtimeRoot), roles = ['first', 'second'] as const;
  for (const role of roles) {
    const ready = profiles.initialize(join(base, role), { purpose: 'Handle generic incoming events continuously.', stateBackend: options.stateBackend ?? 'sqlite', personalMemory: 'sqlite' });
    writeFileSync(join(base, role, 'config.json'), JSON.stringify({ ...ready.config, model: { profile: 'resident-entry' },
      features: { ...ready.config.features, missions: true }, skills: { mode: 'off' } }), { mode: 0o600 });
  }
  const opened = new Map<ResidentRole, AgentTurnProfile>(), drivers = new Map<ResidentRole, Driver>();
  const pages = { first: [] as MissionEvent[][], second: [] as MissionEvent[][] };
  const observed = { inputs: { first: [] as AgentTurnInput[], second: [] as AgentTurnInput[] },
    polls: [] as { role: ResidentRole; cursor: number }[], closes: [] as ResidentRole[],
    compacts: [] as { role: ResidentRole; input: SessionCompactInput; candidate: SessionCompactCandidate }[] };
  const controls: { readMission?: boolean; beforePoll?: (role: ResidentRole, signal: AbortSignal) => Promise<void> } = {};
  const current = (role: ResidentRole = 'first') => { const profile = opened.get(role); assert.ok(profile); return profile; };
  const binding = (role: ResidentRole) => { const p = current(role); return { ...p.executionActor, channel: 'test' as const,
    conversationId: 'resident-conversation', recipientId: p.actor.principalId, destination: 'local' }; };
  function driver(role: ResidentRole = 'first') {
    let value = drivers.get(role);
    if (!value) { const p = current(role); value = p.createResidentMissions({ binding: binding(role), policy: p.policy, limits: p.limits }); drivers.set(role, value); }
    return value;
  }
  function host(role: ResidentRole): AgentExecutionHost {
    const identity = { provider: 'local-fixture', model: 'resident-' + role, revision: '1' };
    return { identityRegistryDirectory: join(base, 'registry'), tools: { async open() {
      return { tools: [], policy, limits: { toolCalls: 12, modelCalls: 12, tokens: 1000000, replans: 8, wallTimeMs: 3600000 }, async close() {} };
    } }, missions: { async open() {
      const source: MissionEventSource = { id: RESIDENT_RULE.sourceId, destination: 'local', labels: ['public'], async poll(input) {
        await input.authorize(); input.signal.throwIfAborted(); observed.polls.push({ role, cursor: input.cursor });
        await controls.beforePoll?.(role, input.signal); await input.authorize(); input.signal.throwIfAborted();
        const page = pages[role][input.cursor];
        return { cursor: page ? input.cursor + 1 : input.cursor, snapshotDigest: page ? 'page-' + (input.cursor + 1) : input.snapshotDigest,
          events: structuredClone(page ?? []) };
      } };
      return { sources: [source], async close() { observed.closes.push(role); } };
    } }, models: new Map([['resident-entry', { execution: 'deterministic_fixture', async open(profile) {
      const configuration = { identity, destination: 'local', maxRequestBytes: 131072,
        capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 100000, maxOutputTokens: 2048 } };
      const turn = new StructuredAgentTurnAdapter({ ...configuration, profile }, { async invoke(request, signal) {
        signal.throwIfAborted(); observed.inputs[role].push(structuredClone(request.input)); const text = currentText(request.input.packet);
        const marker = text.indexOf('{"kind":"unreviewed_resident_event"');
        const incoming = marker < 0 ? null : JSON.parse(text.slice(marker)) as { event: MissionEvent };
        const packet = request.input.packet;
        const missionOutputs = (packet.toolObservations ?? []).filter(value => value.toolId === 'mission.events' && value.status === 'success')
          .map(value => value.output).filter((value): value is Record<string, Json> => value !== null && typeof value === 'object' && !Array.isArray(value));
        const rules = missionOutputs.find(value => value['kind'] === 'mission_rules'), events = missionOutputs.find(value => value['kind'] === 'unreviewed_mission_events');
        const input: Record<string, Json> = rules ? (() => { const listed = rules['rules']; assert.ok(Array.isArray(listed)); const first = listed[0];
          assert.ok(first && typeof first === 'object' && !Array.isArray(first)); const rule = first['rule'];
          assert.ok(rule && typeof rule === 'object' && !Array.isArray(rule)); assert.equal(typeof rule['id'], 'string');
          return { ruleId: rule['id'] as string, maxBytes: 8192 }; })() : { maxBytes: 8192 };
        const result: AgentTurnResult = controls.readMission ? events ? answer('The mission reported: ' + JSON.stringify(events)) :
          { kind: 'plan', proposal: { baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision, basePlanRevision: packet.plan?.revision ?? 0,
            reason: 'Discover the registered rule, then read its current event before replying.', hypotheses: [], tasks: [{ id: rules ? 'read-current-event' : 'list-mission-rules', toolId: 'mission.events', toolVersion: '1',
              description: 'Read the unreviewed current event.', effect: 'read', input, dependsOn: [], satisfies: [], maxAttempts: 1 }] } } :
          incoming && JSON.stringify(incoming.event.body).includes('ASK_DATE') ?
            { kind: 'question', question: 'Which date should this event use?' } : answer(role + ': ' + (incoming ? JSON.stringify(incoming.event.body) : text));
        return { provider: identity.provider, model: identity.model, finish: 'stop', content: JSON.stringify(result), usage: { inputTokens: 200, outputTokens: 60 } };
      } });
      const compactor = new StructuredSessionCompactAdapter(configuration, { async invoke(request, signal) {
        signal.throwIfAborted(); const input = request.compact;
        const entry = input.entries.find(value => value.role === 'user' && value.text.includes('unreviewed_resident_event') && value.sequence > (input.previous?.ref.throughSequence ?? 0));
        assert.ok(entry); const candidate: SessionCompactCandidate = { inputDigest: input.inputDigest,
          content: { narrative: 'Earlier event discussions remain available in the same session.',
            retained: [...(input.previous?.content.retained ?? []), { id: 'event-reference-' + entry.sequence, kind: 'reference', status: 'active',
              text: 'Retain the original earlier event discussion.', citations: [{ sequence: entry.sequence, sourceId: entry.sourceId, role: entry.role, quote: entry.text.slice(0, 96) }] }] } };
        observed.compacts.push({ role, input: structuredClone(input), candidate: structuredClone(candidate) });
        return { provider: identity.provider, model: identity.model, finish: 'stop', content: JSON.stringify(candidate), usage: { inputTokens: 120, outputTokens: 40 } };
      } });
      const planner: RegisteredTurnPlanner = { identity: turn.identity, destination: turn.destination, capabilities: turn.capabilities, prompt: turn.prompt,
        inputEstimation: turn.inputEstimation, turn: turn.turn.bind(turn), propose: turn.propose.bind(turn), estimateTurnInput: turn.estimateTurnInput.bind(turn),
        estimateContextPreview: turn.estimateContextPreview.bind(turn), ...(compact ? { compact: compactor.compact.bind(compactor), estimateCompactInput: compactor.estimateCompactInput.bind(compactor) } : {}) };
      return { planner, inputLimits: { maxInputBytes: 131072, maxOutputTokens: 2048 }, async close() {} };
    } }]]) };
  }
  async function open() { for (const role of roles) opened.set(role, await openAgentTurnProfile(join(base, role), { provider: 'registered' }, host(role))); }
  async function close() { drivers.clear(); for (const role of roles) { const p = opened.get(role); if (p) { await p.close(); opened.delete(role); } } }
  t.after(async () => { await close(); rmSync(base, { recursive: true, force: true }); }); await open();
  const instruction = 'Respond only to the current event. Keep prior discussions for context without merging their goals or evidence.';
  const register = (role: ResidentRole = 'first') => driver(role).register({ rule: RESIDENT_RULE, instruction });
  async function due(workId: string, role: ResidentRole = 'first') {
    const status = await driver(role).status(workId), milliseconds = status.nextPollAt - Date.now();
    if (milliseconds > 0) await delay(milliseconds + 1);
  }
  async function memory(role: ResidentRole) { const p = current(role), knowledge = await p.personalKnowledge(p.actor);
    return (await knowledge.search({ namespace: 'personal', scope: 'personal', text: '', kinds: ['personal'], limit: 50 })).cards; }
  return { base, current, driver, binding, register, due, memory, observed, controls, pages,
    async reopen() { await close(); await open(); } };
}
