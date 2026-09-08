import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArtifactSchema } from '../application/contracts.js';
import type { CollaborationTrial } from '../application/collaboration-evaluation.js';
import { PEER_TOOL_IDS } from '../application/peer-agents.js';
import type { PeerAgent, PeerReply, PeerRequest, PeerTicket } from '../application/peer-contracts.js';
import type { AgentTurnInput } from '../application/agent-turn-types.js';
import { readGeneratedAnswer } from '../application/generated-answer.js';
import type { Tool } from '../application/ports.js';
import type { AgentTurnResult } from '../domain/agent-turn.js';
import type { EvaluationCase, EvaluationEntry, EvaluationObservation } from '../domain/execution-evaluation.js';
import type { ArtifactRef, ContextPacket, Delivery, Evidence, WorkState } from '../domain/model.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { StructuredAgentTurnAdapter } from '../infrastructure/structured-agent-turn.js';
import { openAgentTurnProfile, type AgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { createRuntimePeerAgent } from '../presentation/host-peers.js';
import type { AgentExecutionHost } from '../presentation/host-tools.js';
import { peerObject } from './peer-deployment-entry-fixture.js';

export const TRIAL_QUESTION = '현행 보존 원문의 보존기간을 확인하고 근거를 인용해 답하세요.';
export const TRIAL_ANSWER = '현행 보존기간은 30일입니다. 현행 원문을 직접 확인했습니다.';
export const TRIAL_SOURCE = 'trial.retention.read';
export const TRIAL_ORIGINAL = { id: 'retention-original', sourceId: TRIAL_SOURCE, lineageId: 'retention-original-v1', observedAt: 1700000000000 };
export const TRIAL_BYTES = new TextEncoder().encode('현행 보존 원문 revision 1: 보존기간은 30일이다.');
const PROFILE = 'collaboration-trial', TENANT = 'collaboration-profile-trial';
const engine = fileURLToPath(new URL('../../', import.meta.url));
type Arm = 'single' | 'collaborative';
type Role = 'primary' | 'peer';
type Exchange = { request: PeerRequest; ticket: PeerTicket; reply?: PeerReply };
type CommitOriginal = { commandId: string; digest: string; observation: EvaluationObservation };
type Participant = { role: Role; root: string; statePath: string; profile: AgentTurnProfile; originals: Map<string, CommitOriginal[]>;
  entries: Map<string, EvaluationEntry[]>; models: AgentTurnInput[]; sourceReads: string[] };
export type RecordedProfileTrial = { trial: CollaborationTrial; primary: AgentTurnProfile; peer: AgentTurnProfile | null;
  participants: Participant[]; exchanges: Exchange[]; finalDeliveries: Map<string, Delivery[]>;
  answer: Awaited<ReturnType<typeof readGeneratedAnswer>>; originalInput: Awaited<ReturnType<AgentTurnProfile['sessions']['repository']['input']>> };

function decide(packet: ContextPacket, role: Role): AgentTurnResult {
  const answer = (text: string, evidenceIds: string[] = []): AgentTurnResult => ({ kind: 'answer', text, evidenceIds,
    assessment: { type: 'model_self_review', verdict: 'satisfied', rationale: '직접 관측한 원문과 동료 의견을 구분했다.', missing: [], counterarguments: [] } });
  assert.equal(packet.goal.description, TRIAL_QUESTION);
  if (role === 'peer') return answer('의견: 현행 원문을 직접 확인하고 보존기간을 인용하세요. 이 의견은 독립 근거가 아닙니다.');
  assert.ok((packet.toolObservations ?? []).every(value => value.status === 'success'), 'failed observations cannot become a trial answer');
  const peer = peerObject(packet.toolObservations?.findLast(value => value.toolId === PEER_TOOL_IDS[0])?.output);
  const original = packet.evidence.find(value => value.id === TRIAL_ORIGINAL.id);
  if (original) {
    assert.equal(original.sourceId, TRIAL_SOURCE); assert.equal(original.facts.days, 30);
    return answer(TRIAL_ANSWER, [original.id]);
  }
  const consult = packet.activeToolIds.includes(PEER_TOOL_IDS[0]) && !peer;
  if (peer) { assert.equal(peer.status, 'answer'); assert.equal(peer.interpretation, 'peer_assessment_not_independent_evidence'); }
  const toolId = consult ? PEER_TOOL_IDS[0] : TRIAL_SOURCE; assert.ok(packet.activeToolIds.includes(toolId));
  return { kind: 'plan', proposal: { baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision,
    basePlanRevision: packet.plan?.revision ?? 0, reason: consult ? '동료 의견을 먼저 요청한 뒤 자기 원문을 확인한다.' : '동일 현행 원문을 직접 확인한다.',
    hypotheses: [], tasks: [{ id: `trial-${packet.stateRevision}`, description: toolId, toolId, toolVersion: '1', effect: 'read',
      input: consult ? { peerId: 'reviewer', kind: 'consult', request: TRIAL_QUESTION } : {}, dependsOn: [], satisfies: [], maxAttempts: 1 }] } };
}
function evaluationCase(arm: Arm): EvaluationCase {
  return { id: `actual-profile-${arm}`, family: 'observation_review', fixtureId: 'same-retention-question-v1', backend: 'sqlite', mode: 'auto', variant: 'simple',
    oracle: { expectedFinal: 'complete', completionEligible: true, requiredEvidenceIds: [TRIAL_ORIGINAL.id], originals: [TRIAL_ORIGINAL], facts: { days: 30 },
      finalHypothesis: null, forbiddenEvidenceIds: [], noCompletionBefore: null,
      response: { kind: 'exact_text', text: TRIAL_ANSWER, sha256: createHash('sha256').update(TRIAL_ANSWER, 'utf8').digest('hex') } } };
}

/** Actual independent host profiles; only the presence of a registered peer differs between the two primary arms. */
export function collaborationProfileTrialFixture(t: { after(callback: () => Promise<void>): void }) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'collaboration-profile-trial-'))), profiles = new FileAgentProfileStore(engine);
  const configuredOutput = process.env.SECUMON_TEST_COLLABORATION_OUTPUT;
  if (configuredOutput) mkdirSync(configuredOutput, { recursive: true, mode: 0o700 });
  // Reports and captured original bytes survive temporary profile cleanup, including an assertion failure.
  const output = realpathSync(mkdtempSync(join(configuredOutput ?? tmpdir(), 'collaboration-profile-originals-')));
  const opened: AgentTurnProfile[] = [], recorded = new Map<Arm, RecordedProfileTrial>();
  const written = new Map<string, string>(); let totalBytes = 0;
  const persist = (name: string, value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value)); assert.ok(bytes.byteLength <= 16 * 1024 * 1024, 'bounded trial record');
    assert.ok(totalBytes + bytes.byteLength <= 64 * 1024 * 1024, 'bounded original archive');
    writeFileSync(join(output, name), bytes, { flag: 'wx', mode: 0o600 }); totalBytes += bytes.byteLength;
  };
  async function saveArtifacts(participants: Participant[]) {
    const manifest: { role: Role; workId: string; ref: ArtifactRef; file: string }[] = [];
    mkdirSync(join(output, 'artifacts'), { recursive: true, mode: 0o700 });
    for (const participant of participants) for (const [workId, commits] of participant.originals) {
      const refs = new Map<string, ArtifactRef>();
      const visit = (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        const parsed = ArtifactSchema.safeParse(value);
        if (parsed.success) { refs.set(JSON.stringify(parsed.data), parsed.data); return; }
        for (const nested of Array.isArray(value) ? value : Object.values(value)) visit(nested);
      };
      visit(commits);
      const state = await participant.profile.runtime.state(workId);
      for (const ref of refs.values()) {
        assert.ok(ref.byteLength <= 4 * 1024 * 1024, 'bounded captured original');
        const bytes = await participant.profile.services.artifacts.get(ref, state.policy);
        assert.equal(bytes.byteLength, ref.byteLength); assert.equal(createHash('sha256').update(bytes).digest('hex'), ref.sha256);
        const file = `artifacts/${ref.sha256}.bin`;
        if (!written.has(file)) {
          assert.ok(totalBytes + bytes.byteLength <= 64 * 1024 * 1024, 'bounded original archive');
          writeFileSync(join(output, file), bytes, { flag: 'wx', mode: 0o600 }); written.set(file, ref.sha256); totalBytes += bytes.byteLength;
        }
        manifest.push({ role: participant.role, workId, ref, file });
      }
    }
    return manifest;
  }
  t.after(async () => {
    const errors: unknown[] = []; for (const p of [...opened].reverse()) try { await p.close(); } catch (error) { errors.push(error); }
    if (!errors.length) try { rmSync(base, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'collaboration_profile_cleanup_failed');
  });
  async function run(arm: Arm, signal: AbortSignal): Promise<CollaborationTrial> {
    signal.throwIfAborted(); assert.equal(recorded.has(arm), false, 'each arm runs once');
    mkdirSync(join(base, arm), { mode: 0o700 });
    const participants: Participant[] = [], exchanges: Exchange[] = []; let recipient: PeerAgent | null = null;
    async function open(role: Role) {
      const ready = profiles.initialize(join(base, arm, role), { name: `trial-${role}`, purpose: role === 'primary' ? '현행 원문에 근거해 사용자 질문에 답한다.' : '동료에게 독립 근거로 승격하지 않는 검토 의견을 제공한다.',
        stateBackend: 'sqlite', personalMemory: 'sqlite' });
      writeFileSync(join(ready.root, 'config.json'), JSON.stringify({ ...ready.config, model: { profile: PROFILE }, skills: { mode: 'off' },
        features: { peers: arm === 'collaborative' && role === 'primary', board: false, archive: false, missions: false, a2a: false } }), { mode: 0o600 });
      const originals = new Map<string, CommitOriginal[]>(), entries = new Map<string, EvaluationEntry[]>(), models: AgentTurnInput[] = [], sourceReads: string[] = [];
      const entry = (workId: string, value: EvaluationEntry) => { const values = entries.get(workId) ?? []; values.push(value); entries.set(workId, values); };
      const host: AgentExecutionHost = { identityRegistryDirectory: join(base, 'registry'),
        ...(arm === 'collaborative' && role === 'primary' ? { peers: { async open() {
          assert.ok(recipient); const actual = recipient;
          const forwarding: PeerAgent = { identity: actual.identity, destination: actual.destination, allowedLabels: actual.allowedLabels,
            async request(request, cancellation) { const ticket = await actual.request(request, cancellation); exchanges.push({ request: structuredClone(request), ticket: structuredClone(ticket) }); return ticket; },
            async run(request, ticket, cancellation) { const reply = await actual.run(request, ticket, cancellation), exchange = exchanges.find(value => value.request.id === request.id); assert.ok(exchange);
              exchange.reply = structuredClone(reply); return reply; }, current: actual.current.bind(actual) };
          return { peers: new Map([['reviewer', forwarding]]), allowedTools: PEER_TOOL_IDS, async close() {} };
        } } } : {}),
        models: new Map([[PROFILE, { execution: 'deterministic_fixture', async open(profile) {
          const identity = { provider: 'local-fixture', model: `collaboration-trial-${role}`, revision: '1' }, counts = new Map<string, number>();
          const planner = new StructuredAgentTurnAdapter({ identity, profile, destination: 'local', maxRequestBytes: 65536,
            capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 100000, maxOutputTokens: 2048 } }, {
            async invoke(request, cancellation) {
              signal.throwIfAborted(); cancellation.throwIfAborted(); const input = request.input; models.push(structuredClone(input));
              const count = (counts.get(input.packet.workId) ?? 0) + 1; counts.set(input.packet.workId, count); assert.ok(count <= 8, 'finite ordinary trial loop');
              entry(input.packet.workId, { kind: 'model', at: Date.now(), id: request.options.callId, sourceKey: null });
              return { provider: identity.provider, model: identity.model, finish: 'stop', content: JSON.stringify(decide(input.packet, role)), usage: { inputTokens: 200, outputTokens: 80 } };
            } });
          return { planner, inputLimits: { maxInputBytes: 65536, maxOutputTokens: 2048 }, async close() {} };
        } }]]),
        tools: { async open(context, assembly) {
          assert.ok(assembly);
          const tool: Tool = { definition: { provider: 'trial', id: TRIAL_SOURCE, version: '1', effect: 'read', destination: 'local', labels: ['synthetic'],
            description: '현행 보존 원문을 직접 읽는다.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, outputSchema: { type: 'object' } },
            async execute(_task, invocation) {
              signal.throwIfAborted(); await invocation.authorize?.(); sourceReads.push(invocation.workId);
              const artifact = await assembly.custody.artifacts.put(TRIAL_BYTES, { tenantId: TENANT, labels: ['synthetic'], mediaType: 'text/plain' });
              await invocation.authorize?.();
              const evidence: Evidence = { ...TRIAL_ORIGINAL, tenantId: TENANT, scope: context.scope, locator: 'fixture://retention/current', recordedAt: assembly.custody.clock.now(),
                labels: ['synthetic'], coverage: 'complete', status: 'accepted', supersedes: [], derivedFrom: [], facts: { days: 30 }, artifact };
              return { resultId: `${invocation.attemptId}:result`, attemptId: invocation.attemptId, status: 'success', coverage: 'complete', effectState: 'none',
                evidence: [evidence], artifacts: [artifact], output: { days: 30 }, error: null, cursor: null };
            } };
          return { tools: role === 'primary' ? [tool] : [], policy: { tenantId: TENANT, principalId: `trial-${role}`, allowWrites: false,
            allowedTools: role === 'primary' ? [TRIAL_SOURCE] : [], allowedLabels: ['synthetic'], allowedDestinations: ['local'] },
            limits: { toolCalls: 12, modelCalls: 12, tokens: 1000000, replans: 8, wallTimeMs: 600000 }, async close() {} };
        } } };
      const profile = await openAgentTurnProfile(ready.root, { provider: 'registered' }, host); opened.push(profile);
      const commit = profile.services.state.commit.bind(profile.services.state), dispatched = new Set<string>();
      profile.services.state.commit = async request => {
        const result = await commit(request);
        if (result.kind === 'committed') {
          const receipt = await profile.services.state.receipt(request.workId, request.commandId); assert.ok(receipt); assert.deepEqual(receipt.state, result.state);
          const deliveries = await profile.services.state.deliveries(request.workId), values = originals.get(request.workId) ?? [];
          let response: { artifact: ArtifactRef; text: string } | undefined;
          if (result.state.generatedAnswer) {
            const artifact = result.state.generatedAnswer.artifact, bytes = await profile.services.artifacts.get(artifact, result.state.policy);
            assert.equal(bytes.byteLength, artifact.byteLength); assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
            response = { artifact: structuredClone(artifact), text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
          }
          const at = Date.now();
          assert.ok(values.length < 256, 'bounded original commit inventory');
          values.push({ commandId: request.commandId, digest: receipt.digest, observation: { at, stage: request.commandId, state: structuredClone(result.state),
            eventTypes: request.events.map(value => value.type), deliveries: structuredClone(deliveries), ...(response ? { response } : {}) } }); originals.set(request.workId, values);
          // Durable running transitions retain dispatch charges even if a later observation is only the final settled attempt.
          for (const attempt of result.state.attempts) if (attempt.status === 'running' && !dispatched.has(attempt.id)) {
            dispatched.add(attempt.id); entry(request.workId, { kind: 'tool', at, id: attempt.id, sourceKey: `${attempt.toolId}@${attempt.toolVersion}:${attempt.inputDigest}` });
          }
        }
        return result;
      };
      const send = profile.services.sink.send.bind(profile.services.sink), lookup = profile.services.sink.lookup?.bind(profile.services.sink);
      profile.services.sink.send = async delivery => { entry(delivery.workId, { kind: 'send', at: Date.now(), id: delivery.id, sourceKey: null }); return send(delivery); };
      if (lookup) profile.services.sink.lookup = async delivery => { entry(delivery.workId, { kind: 'lookup', at: Date.now(), id: delivery.id, sourceKey: null }); return lookup(delivery); };
      const participant = { role, root: ready.root, statePath: ready.paths.state, profile, originals, entries, models, sourceReads }; participants.push(participant); return participant;
    }
    if (arm === 'collaborative') {
      const peer = await open('peer'), p = peer.profile;
      recipient = createRuntimePeerAgent({ agentId: p.agentId, revision: '1', role: 'temporary', scope: p.scope, policy: p.policy, limits: p.limits,
        sessions: p.sessions, workflow: p.workflow, maxSteps: 32 });
    }
    const primary = await open('primary'), p = primary.profile;
    const startedAt = Date.now(), wallStart = performance.now(); let runError: string | null = null, finalControl = 'error';
    const session = await p.sessions.open(p.actor, { channel: 'test', conversationId: 'same-user-question' });
    const intake = await p.turns.accept(p.actor, { sessionId: session.scope.sessionId, messageId: 'same-question-v1', rawText: TRIAL_QUESTION, mode: 'auto',
      scope: p.scope, policy: p.policy, limits: p.limits,
      binding: { ...p.executionActor, channel: 'test', conversationId: 'same-user-question', recipientId: p.actor.principalId, destination: 'local' } });
    const stop = () => p.runtime.interrupt(intake.workId); signal.addEventListener('abort', stop, { once: true });
    try { signal.throwIfAborted(); finalControl = (await p.workflow.run(intake.workId, p.actor, { maxSteps: 32 })).control.kind; }
    catch (error) { runError = error instanceof Error ? `${error.name}: ${error.message}` : String(error); }
    finally { signal.removeEventListener('abort', stop); }
    const finalDeliveries = new Map<string, Delivery[]>(), finals: WorkState[] = [];
    for (const participant of participants) for (const workId of participant.originals.keys()) {
      finals.push(await participant.profile.runtime.state(workId)); finalDeliveries.set(workId, await participant.profile.services.state.deliveries(workId));
    }
    const final = await p.runtime.state(intake.workId), observations = (primary.originals.get(intake.workId) ?? []).map(value => value.observation);
    assert.ok(observations.length); assert.deepEqual(observations.at(-1)!.state, final);
    assert.deepEqual(observations.at(-1)!.deliveries, finalDeliveries.get(intake.workId));
    const finishedAt = Date.now(), trial: CollaborationTrial = { primary: { case: evaluationCase(arm), observations, entries: primary.entries.get(intake.workId) ?? [],
      finalControl, startedAt, finishedAt, wallElapsedMs: performance.now() - wallStart, runError },
      participants: finals, participantInventoryComplete: finals.length === 1 + exchanges.length && exchanges.every(value => finals.some(state => state.id === value.ticket.workId)) };
    const answer = await readGeneratedAnswer(p.services, final), originalInput = await p.sessions.repository.input(session.scope, 'same-question-v1');
    const saved: RecordedProfileTrial = { trial, primary: p, peer: participants.find(value => value.role === 'peer')?.profile ?? null,
      participants, exchanges, finalDeliveries, answer, originalInput }; recorded.set(arm, saved);
    persist(`${arm}-trial.json`, trial);
    persist(`${arm}-originals.json`, { question: TRIAL_QUESTION, mode: 'auto', source: { original: TRIAL_ORIGINAL, bytes: [...TRIAL_BYTES] }, originalInput, answer,
      exchanges, participants: participants.map(value => ({ role: value.role, agentId: value.profile.agentId, root: value.root,
        commits: [...value.originals], entries: [...value.entries], modelInputs: value.models, sourceReads: value.sourceReads })), finalDeliveries: [...finalDeliveries],
      artifacts: await saveArtifacts(participants) });
    return trial;
  }
  return { base, output, recorded, persist, run };
}
