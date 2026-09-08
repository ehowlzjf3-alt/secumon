import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeRuntime } from '../application/compose-runtime.js';
import { PEER_TOOL_IDS } from '../application/peer-agents.js';
import type { PeerAgent, PeerRequest, PeerTicket } from '../application/peer-contracts.js';
import { PeerReviewSchema } from '../application/peer-contracts.js';
import { ToolResultSchema } from '../application/contracts.js';
import { asJson } from '../application/plan-validator.js';
import type { Hypothesis, TaskSpec, WorkState } from '../domain/model.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { FakeClock, FakeSink, ScriptedPlanner, SequenceIds } from '../infrastructure/fakes.js';
import { advance, command, initial, openRepository, type Adapter } from './state-conformance-helpers.js';

export const peerHypothesis: Hypothesis = { id: 'hypothesis', question: 'Why did the deployment fail?', claim: 'The new configuration caused it.',
  predictedObservation: 'Failures start with the configuration change.', falsifier: 'The same failure predates the change.',
  status: 'open', supportIds: [], counterIds: [], reason: 'Compare a distinct explanation.' };
export const signal = () => new AbortController().signal;
export function peerProbe() {
  const digester = new Sha256Digester(), digest = (value: unknown) => digester.digest(asJson(value));
  const identity = { agentId: 'recipient-agent', revision: '1', role: 'resident' as const,
    model: { provider: 'local-fixture', model: 'reviewer', revision: '1' } };
  const observed = { requests: [] as PeerRequest[], tickets: [] as PeerTicket[], runs: [] as { request: PeerRequest; ticket: PeerTicket }[], checks: 0 };
  const controls: { status: 'answer' | 'waiting'; current: boolean; ticketDigest?: string; targetVersion?: string;
    beforeRequest?: () => Promise<void>; beforeRun?: () => Promise<void> } = { status: 'answer', current: true };
  const peer: PeerAgent = { identity, destination: 'local', allowedLabels: ['synthetic', 'public', 'internal'],
    async request(request) {
      assert.equal(this, peer); observed.requests.push(structuredClone(request)); await controls.beforeRequest?.();
      const ticket = { requestId: request.id, requestDigest: controls.ticketDigest ?? digest(request), workId: 'recipient-work', sessionId: 'recipient-session', goalRevision: 1 };
      observed.tickets.push(structuredClone(ticket)); return ticket;
    },
    async run(request, ticket) {
      assert.equal(this, peer); observed.runs.push(structuredClone({ request, ticket })); await controls.beforeRun?.();
      const text = controls.status === 'waiting' ? null : request.kind === 'review' ? JSON.stringify(PeerReviewSchema.parse({ schemaVersion: 1,
        targetVersion: controls.targetVersion ?? request.target!.version, target: request.target!.hypothesis.claim,
        alternative: 'An earlier dependency failure is another explanation.', basis: { kind: 'none', reason: 'No independent source was read by this fixture.' },
        discriminatingQuestions: ['Does the failure occur before the change?'], impact: 'Check the earlier records before accepting the hypothesis.' })) : 'A peer assessment requiring local verification.';
      return { ticket: structuredClone(ticket), status: controls.status, text, answerDigest: text === null ? null : digest(text),
        reason: controls.status === 'waiting' ? 'waiting_for_source' : 'agent_answer_stored', labels: [...request.labels],
        model: structuredClone(identity.model), observedAt: 1100, stateRevision: 1 };
    },
    // This bounded caller-port probe does not replace the separate RuntimePeerAgent current/source validation tests.
    async current() { assert.equal(this, peer); observed.checks++; return controls.current; },
  };
  return { peer, identity, observed, controls, digest };
}

export async function peerServiceFixture(t: TestContext, adapter: Adapter = 'sqlite') {
  const directory = await mkdtemp(join(tmpdir(), 'secumon-peer-service-'));
  let state = openRepository(adapter, directory);
  const artifacts = new FileArtifactStore(join(directory, 'artifacts')), clock = new FakeClock(1100), ids = new SequenceIds(), digester = new Sha256Digester();
  const probe = peerProbe(); let sequence = 0;
  const compose = () => composeRuntime({ services: { state, artifacts, clock, ids, digester, tools: [], planner: new ScriptedPlanner([]), sink: new FakeSink() },
    peers: { agents: new Map([['reviewer', probe.peer]]), agentId: 'caller-agent' }, schemas: new AjvSchemas(),
    guidanceSource: { list: async () => [], read: async () => { throw new Error('unused'); } }, owner: 'worker', leaseMs: 10000, enablePlanning: false });
  const work = initial('caller-work'); work.policy.allowedTools = [...PEER_TOOL_IDS]; work.hypotheses = [structuredClone(peerHypothesis)];
  await state.commit(command(work, 'seed')); let bundle = await compose();
  const prepare = async (input: TaskSpec['input'], toolId: string = PEER_TOOL_IDS[0]) => {
    const current = (await state.get(work.id))!;
    const task: TaskSpec = { id: `peer-task-${++sequence}`, description: 'Ask a registered peer without treating its assessment as evidence',
      toolId, toolVersion: '1', effect: 'read', input, dependsOn: [], maxAttempts: 1, satisfies: [] };
    await bundle.runtime.submitPlan(work.id, `peer-plan-${sequence}`, { baseStateRevision: current.revision, baseGoalRevision: current.goal.revision,
      basePlanRevision: current.plan?.revision ?? 0, reason: 'Check the peer boundary', hypotheses: structuredClone(current.hypotheses), tasks: [task] });
    return { task, attempt: await bundle.runtime.reserve(work.id, task.id) };
  };
  const invoke = async (pending: Awaited<ReturnType<typeof prepare>>, abortSignal = signal()) => {
    await bundle.runtime.dispatch(work.id, pending.attempt.id);
    return bundle.services.tools.find(tool => tool.definition.id === pending.task.toolId)!.execute(pending.task,
      { workId: work.id, attemptId: pending.attempt.id, policy: (await state.get(work.id))!.policy, signal: abortSignal });
  };
  const execute = async (input: TaskSpec['input'], toolId: string = PEER_TOOL_IDS[0]) => {
    const pending = await prepare(input, toolId); await bundle.runtime.execute(work.id, pending.attempt.id);
    await bundle.runtime.settlePending(pending.attempt.id); await bundle.runtime.adopt(work.id, pending.attempt.id);
    const current = (await state.get(work.id))!, attempt = current.attempts.find(item => item.id === pending.attempt.id)!;
    const result = ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(await artifacts.get(attempt.resultArtifact!, current.policy))));
    return { ...pending, state: current, attempt, result };
  };
  const edit = async (change: (value: WorkState) => void) => { const next = advance((await state.get(work.id))!); change(next); await state.commit(command(next, `edit-${++sequence}`)); };
  const reopen = async () => { await state.close(); state = openRepository(adapter, directory); bundle = await compose(); };
  t.after(async () => { await state.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, artifacts, clock, probe, get bundle() { return bundle; }, get state() { return state; }, prepare, invoke, execute, edit, reopen };
}
export const consultInput = { peerId: 'reviewer', kind: 'consult', request: 'Compare an independent explanation.' };
export const reviewInput = { peerId: 'reviewer', kind: 'review', request: 'Challenge this current hypothesis.', targetHypothesisId: peerHypothesis.id };
export function deferred() {
  let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve };
}
