import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PEER_TOOL_IDS } from '../application/peer-agents.js';
import { PeerReviewSchema, type PeerAgent, type PeerRequest, type PeerReply, type PeerTicket } from '../application/peer-contracts.js';
import type { AgentTurnInput } from '../application/agent-turn-types.js';
import type { Tool } from '../application/ports.js';
import type { AgentTurnResult } from '../domain/agent-turn.js';
import type { ContextPacket, Evidence, Hypothesis, Json, TaskSpec } from '../domain/model.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { StructuredAgentTurnAdapter } from '../infrastructure/structured-agent-turn.js';
import { openAgentTurnProfile, type AgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { createRuntimePeerAgent } from '../presentation/host-peers.js';
import type { AgentExecutionHost } from '../presentation/host-tools.js';

export const PEER_TENANT = 'peer-deployment', PEER_SOURCE = 'deployment.peer.document';
const PROFILE = 'peer-entry-model', engine = fileURLToPath(new URL('../../', import.meta.url));
export const peerSpecs = [{ key: 'a', principalId: 'schedule-reader', purpose: '일정 원본을 확인하고 동료 의견을 평가한다.' },
  { key: 'b', principalId: 'retention-reader', purpose: '보존 조건을 확인하고 동료 의견을 평가한다.' }] as const;
const modelIdentity = (which: 0 | 1) => ({ provider: 'local-fixture', model: `peer-entry-${peerSpecs[which].key}`, revision: '1' });
export type PeerEntryMode = 'consult' | 'review' | 'resume';
type Observation = { inputs: AgentTurnInput[]; reads: { workId: string; attemptId: string; phase: string }[]; errors: string[] };
export type PeerEntryOpened = { profile: AgentTurnProfile; observed: Observation; close(): Promise<void> };
type Exchange = { to: 0 | 1; role: 'resident' | 'temporary'; request: PeerRequest; ticket: PeerTicket; reply?: PeerReply };
export const peerObject = (value: Json | undefined): Record<string, Json> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const initialHypothesis: Hypothesis = { id: 'retention', question: '현행 보존기간은 얼마인가?', claim: '현행 보존기간은 90일이다.',
  predictedObservation: '유효한 현행 원본에서 90일을 확인한다.', falsifier: '현행 개정 원본이 다른 보존기간을 명시한다.',
  status: 'open', supportIds: [], counterIds: [], reason: '원본과 독립된 검토가 필요하다.' };

/** Decisions use only this invocation's public packet, including observed peer request IDs. */
function nextTurn(packet: ContextPacket, which: 0 | 1): AgentTurnResult {
  const input = JSON.parse(packet.goal.description) as Record<string, Json>;
  const answer = (text: string, evidenceIds: string[] = []): AgentTurnResult => ({ kind: 'answer', text, evidenceIds,
    assessment: { type: 'model_self_review', verdict: 'satisfied', rationale: '반환된 원문과 의견의 출처를 구분했다.', missing: [], counterarguments: [] } });
  if (typeof input.targetVersion === 'string') {
    const hypothesis = peerObject(input.hypothesis); assert.equal(typeof hypothesis?.claim, 'string');
    const review = PeerReviewSchema.parse({ schemaVersion: 1, targetVersion: input.targetVersion, target: hypothesis!.claim,
      alternative: '90일은 구본의 조건이고 현행 개정은 다른 기간일 수 있다.',
      basis: { kind: 'none', reason: '수신자에게 현행 개정 원본은 없으며 이 반론은 판별할 가정이다.' },
      discriminatingQuestions: ['현재 유효한 개정 원본의 보존기간은 얼마인가?'], impact: '현행 개정 원본을 확인하기 전 90일 결론은 유보해야 한다.' });
    return answer(JSON.stringify(review));
  }
  if (input.entry === 'receiver') {
    assert.equal(typeof input.token, 'string');
    return answer(`담당 ${peerSpecs[which].key}의 상담 의견: ${input.token}`);
  }
  assert.equal(input.entry, 'caller'); assert.equal(typeof input.token, 'string');
  const observations = packet.toolObservations ?? [];
  assert.ok(observations.every(value => value.status === 'success'), 'failed peer calls must not become answers');
  const peer = peerObject(observations.findLast(value => value.toolId === PEER_TOOL_IDS[0])?.output);
  const resumed = peerObject(observations.findLast(value => value.toolId === PEER_TOOL_IDS[1])?.output);
  const baseline = packet.evidence.find(value => value.sourceId === PEER_SOURCE && value.facts.phase === 'baseline');
  const current = packet.evidence.find(value => value.sourceId === PEER_SOURCE && value.facts.phase === 'current');
  type Choice = { toolId: string; input: Record<string, Json>; description?: string };
  const plan = (choices: Choice[], hypotheses: Hypothesis[] = []): AgentTurnResult => ({ kind: 'plan', proposal: {
    baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision, basePlanRevision: packet.plan?.revision ?? 0,
    reason: '동료 의견을 원본 관측과 구분하여 다음 필요한 단계를 수행한다.', hypotheses,
    tasks: choices.map((choice, index): TaskSpec => {
      assert.ok(packet.activeToolIds.includes(choice.toolId));
      return { ...choice, id: `step-${packet.stateRevision}-${index + 1}`, description: choice.description ?? choice.toolId,
        toolVersion: '1', effect: 'read', dependsOn: index ? [`step-${packet.stateRevision}-${index}`] : [], maxAttempts: 1, satisfies: [] };
    }) } });
  const consult: Choice = { toolId: PEER_TOOL_IDS[0], input: input.mode === 'review'
    ? { peerId: String(input.peerId), kind: 'review', request: `가설을 별도 문맥에서 검토해 주세요: ${input.token}`, targetHypothesisId: initialHypothesis.id }
    : { peerId: String(input.peerId), kind: 'consult', request: JSON.stringify({ entry: 'receiver', token: input.token }) } };
  const source = (phase: string): Choice => ({ toolId: PEER_SOURCE, input: { phase } });
  if (input.mode === 'review') {
    if (current) {
      assert.ok(baseline);
      if (packet.hypotheses.find(value => value.id === initialHypothesis.id)?.status !== 'refuted')
        return plan([], [{ ...initialHypothesis, status: 'refuted', supportIds: [baseline.id], counterIds: [current.id],
          reason: '동료 반론이 아닌 실제 개정 원본의 30일 관측으로 초기 가설을 반박했다.' }]);
      return answer('현행 개정 원본은 30일이다. 동료 반론은 조회 방향이며 독립 근거로 세지 않았다.', [baseline.id, current.id]);
    }
    if (!baseline) return plan([source('baseline')], [initialHypothesis]);
    if (!peer) return plan([consult], [{ ...initialHypothesis, status: 'supported', supportIds: [baseline.id], reason: '초기 원본은 90일이며 개정 여부를 독립 검토한다.' }]);
    assert.equal(peer.status, 'answer'); assert.equal(peer.interpretation, 'peer_assessment_not_independent_evidence');
    const review = PeerReviewSchema.parse(peer.review); assert.equal(review.target, initialHypothesis.claim); assert.equal(review.basis.kind, 'none');
    return plan([{ ...source('current'), description: review.discriminatingQuestions[0]! }], [{ ...initialHypothesis,
      status: 'inconclusive', supportIds: [baseline.id], reason: review.impact }]);
  }
  if (!peer) return plan(input.mode === 'resume' ? [consult, source('baseline')] : [consult]);
  assert.equal(peer.status, 'answer'); assert.equal(peer.interpretation, 'peer_assessment_not_independent_evidence');
  if (input.mode === 'resume' && !resumed) {
    assert.ok(baseline); assert.equal(typeof peer.requestId, 'string');
    return plan([{ toolId: PEER_TOOL_IDS[1], input: { requestId: peer.requestId! } }]);
  }
  if (resumed) { assert.equal(resumed.requestId, peer.requestId); assert.equal(resumed.recipientWorkId, peer.recipientWorkId); assert.equal(resumed.text, peer.text); }
  assert.equal(typeof peer.text, 'string');
  return answer(`동료 의견으로만 기록한다: ${peer.text}`, baseline ? [baseline.id] : []);
}

export function peerDeploymentFixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'peer-deployment-entry-'))), identityRegistryDirectory = join(base, 'registry');
  const profiles = new FileAgentProfileStore(engine);
  const ready = peerSpecs.map(spec => {
    const value = profiles.initialize(join(base, spec.key), { name: spec.principalId, purpose: spec.purpose, stateBackend: 'sqlite', personalMemory: 'sqlite' });
    writeFileSync(join(value.root, 'config.json'), JSON.stringify({ ...value.config, model: { profile: PROFILE }, skills: { mode: 'off' },
      features: { peers: true, board: false, archive: false, missions: false, a2a: false } }), { mode: 0o600 });
    return value;
  });
  const observed: [Observation, Observation] = [{ inputs: [], reads: [], errors: [] }, { inputs: [], reads: [], errors: [] }];
  const current = new Map<0 | 1, PeerEntryOpened>(), exchanges: Exchange[] = [];
  const peers = (which: 0 | 1, role: 'resident' | 'temporary' = 'resident') => {
    const opened = current.get(which); assert.ok(opened, 'receiver profile must be open'); const p = opened.profile;
    return createRuntimePeerAgent({ agentId: p.agentId, revision: '1', role, scope: p.scope, policy: p.policy,
      limits: p.limits, sessions: p.sessions, workflow: p.workflow, maxSteps: 32 });
  };
  const forwarding = (to: 0 | 1, role: 'resident' | 'temporary'): PeerAgent => ({
    identity: { agentId: ready[to]!.identity.agentId, revision: '1', role, model: modelIdentity(to) }, destination: 'local', allowedLabels: ['synthetic'],
    async request(request, signal) { const ticket = await peers(to, role).request(request, signal);
      exchanges.push({ to, role, request: structuredClone(request), ticket: structuredClone(ticket) }); return ticket; },
    async run(request, ticket, signal) { const reply = await peers(to, role).run(request, ticket, signal);
      const exchange = exchanges.findLast(value => value.to === to && value.request.id === request.id); assert.ok(exchange);
      exchange.reply = structuredClone(reply); return reply; },
    current: (request, reply) => peers(to, role).current(request, reply),
  });
  async function open(which: 0 | 1): Promise<PeerEntryOpened> {
    assert.equal(current.has(which), false); const to = which === 0 ? 1 : 0, spec = peerSpecs[which];
    const host: AgentExecutionHost = { identityRegistryDirectory,
      peers: { async open() { return { peers: new Map([['resident', forwarding(to, 'resident')], ['temporary', forwarding(to, 'temporary')]]),
        allowedTools: PEER_TOOL_IDS, async close() {} }; } },
      models: new Map([[PROFILE, { execution: 'deterministic_fixture', async open(profile) {
        assert.equal(profile.purpose, spec.purpose); const identity = modelIdentity(which), counts = new Map<string, number>();
        const planner = new StructuredAgentTurnAdapter({ identity, profile, destination: 'local', maxRequestBytes: 65536,
          capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 100000, maxOutputTokens: 2048 } }, {
          async invoke(request) {
            observed[which].inputs.push(structuredClone(request.input)); const workId = request.input.packet.workId;
            const count = (counts.get(workId) ?? 0) + 1; counts.set(workId, count); assert.ok(count <= 12, 'finite public peer loop');
            try { return { provider: identity.provider, model: identity.model, finish: 'stop', content: JSON.stringify(nextTurn(request.input.packet, which)),
              usage: { inputTokens: 200, outputTokens: 80 } }; }
            catch (error) { observed[which].errors.push(String(error)); throw error; }
          } });
        return { planner, inputLimits: { maxInputBytes: 65536, maxOutputTokens: 2048 }, async close() {} };
      } }]]),
      tools: { async open(context, assembly) {
        assert.ok(assembly);
        const tool: Tool = { definition: { provider: 'deployment', id: PEER_SOURCE, version: '1', effect: 'read', destination: 'local', labels: ['synthetic'],
          description: '담당 자신의 보존 원본 또는 현행 개정 원본을 읽는다.',
          inputSchema: { type: 'object', properties: { phase: { enum: ['baseline', 'current'] } }, required: ['phase'], additionalProperties: false }, outputSchema: { type: 'object' } },
          async execute(task, invocation) {
            await invocation.authorize?.(); const phase = String(task.input.phase), days = phase === 'baseline' ? 90 : 30;
            observed[which].reads.push({ workId: invocation.workId, attemptId: invocation.attemptId, phase });
            const artifact = await assembly.custody.artifacts.put(new TextEncoder().encode(`${spec.key}/${phase}: 보존기간 ${days}일`),
              { tenantId: PEER_TENANT, labels: ['synthetic'], mediaType: 'text/plain' }); await invocation.authorize?.();
            const now = assembly.custody.clock.now();
            const evidence: Evidence = { id: `${phase}-${invocation.workId}`, tenantId: PEER_TENANT, scope: context.scope, sourceId: PEER_SOURCE,
              lineageId: `${context.agentId}:${phase}`, locator: `fixture://${context.agentId}/${phase}`, observedAt: now, recordedAt: now,
              labels: ['synthetic'], coverage: 'complete', status: 'accepted', supersedes: [], derivedFrom: [], facts: { phase, days }, artifact };
            return { resultId: `${invocation.attemptId}:result`, attemptId: invocation.attemptId, status: 'success', coverage: 'complete', effectState: 'none',
              evidence: [evidence], artifacts: [artifact], output: { phase, days }, error: null, cursor: null };
          } };
        return { tools: [tool], policy: { tenantId: PEER_TENANT, principalId: spec.principalId, allowWrites: false,
          allowedTools: [PEER_SOURCE], allowedDestinations: ['local'], allowedLabels: ['synthetic'] },
          limits: { toolCalls: 12, modelCalls: 12, tokens: 1000000, replans: 8, wallTimeMs: 600000 }, async close() {} };
      } } };
    const profile = await openAgentTurnProfile(ready[which]!.root, { provider: 'registered' }, host); let closing: Promise<void> | undefined;
    const opened: PeerEntryOpened = { profile, observed: observed[which], close() {
      return closing ??= profile.close().finally(() => { if (current.get(which) === opened) current.delete(which); });
    } }; current.set(which, opened); return opened;
  }
  t.after(async () => {
    const errors: unknown[] = []; for (const value of [...current.values()]) try { await value.close(); } catch (error) { errors.push(error); }
    try { rmSync(base, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'peer_entry_cleanup_failed');
  });
  return { base, ready, profiles, observed, exchanges, peers, open,
    async reopen(which: 0 | 1) { await current.get(which)?.close(); return open(which); } };
}

export async function acceptPeerEntry(opened: PeerEntryOpened, token: string, mode: PeerEntryMode = 'consult', peerId = 'resident') {
  const p = opened.profile, session = await p.sessions.open(p.actor, { channel: 'test', conversationId: 'peer-entry' });
  return p.turns.accept(p.actor, { sessionId: session.scope.sessionId, messageId: token,
    rawText: JSON.stringify({ entry: 'caller', mode, peerId, token }), mode: 'deep', scope: p.scope, policy: p.policy, limits: p.limits,
    binding: { ...p.executionActor, channel: 'test', conversationId: 'peer-entry', recipientId: p.actor.principalId, destination: 'local' } });
}
export async function runPeerEntry(opened: PeerEntryOpened, workId: string) {
  const p = opened.profile, result = await p.workflow.run(workId, p.actor, { maxSteps: 64 }), state = await p.runtime.state(workId);
  assert.equal(result.control.kind, 'complete', JSON.stringify({ control: result.control, status: state.status, reason: state.statusReason,
    models: state.modelCalls.map(value => ({ status: value.status, reason: value.reason })),
    attempts: state.attempts.map(value => ({ toolId: value.toolId, status: value.status, error: value.error })), errors: opened.observed.errors }));
  assert.deepEqual(opened.observed.errors, []); return state;
}
