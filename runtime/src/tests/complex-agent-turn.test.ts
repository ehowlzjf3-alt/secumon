import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentTurnService } from '../application/agent-turn-service.js';
import { AgentTurnInputSchema } from '../application/agent-turn-contracts.js';
import type { AgentTurnInput } from '../application/agent-turn-types.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { validateScenario } from '../application/fixtures.js';
import { readGeneratedAnswer } from '../application/generated-answer.js';
import type { Tool } from '../application/ports.js';
import type { AgentTurnResult } from '../domain/agent-turn.js';
import type { ContextPacket, Hypothesis, TaskSpec } from '../domain/model.js';
import { accessibleEvidence } from '../domain/completion.js';
import { hypothesesRequireReview } from '../domain/hypotheses.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { FixtureReadTool } from '../infrastructure/fakes.js';
import { StructuredAgentTurnAdapter } from '../infrastructure/structured-agent-turn.js';
import { openRegisteredHostModel, resolveHostModelRegistration, type AgentTurnHost } from '../presentation/host-models.js';

const scenario = validateScenario(JSON.parse(readFileSync(new URL('../../fixtures/documents-complex.json', import.meta.url), 'utf8')));
const actor = { tenantId: 'synthetic', principalId: 'learner' };
const original = '두 문서의 현행 보존기간이 같은지, 차이가 있으면 개정 이력까지 확인해 설명해 줘.';
const limits = { toolCalls: 10, modelCalls: 10, tokens: 1000000, replans: 3, wallTimeMs: 600000 };
const task = (id: string, source: string, dependsOn: string[]): TaskSpec => ({ id, description: '명시된 합성 원본 한 건 조회',
  toolId: 'fixture.read', toolVersion: '1', effect: 'read', input: { evidenceIds: [source] }, dependsOn, maxAttempts: 1, satisfies: [] });
const tasks = [task('read-old', 'doc-a-old', []), task('read-independent', 'doc-b', ['read-old']),
  task('read-amendment', 'doc-a-amendment', ['read-independent'])];
const hypotheses: Hypothesis[] = [
  { id: 'h90', question: '현행 보존기간은 얼마인가?', claim: '현행 보존기간은 90일이다.', predictedObservation: '현행 독립 자료가 90일을 명시한다.',
    falsifier: '유효한 현행 자료가 다른 보존기간을 명시한다.', status: 'open', supportIds: [], counterIds: [], reason: '아직 관측하지 않았다.' },
  { id: 'h30', question: '90일은 구본의 조건인가?', claim: '90일은 구본이고 현행 보존기간은 30일이다.', predictedObservation: '별도 문서와 유효 개정본이 30일을 명시한다.',
    falsifier: '현행 개정 자료가 90일을 유지한다.', status: 'open', supportIds: [], counterIds: [], reason: '개정 여부를 판별해야 한다.' },
];
function plan(packet: ContextPacket, selected: TaskSpec[], assessed: Hypothesis[]): AgentTurnResult {
  return { kind: 'plan', proposal: { baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision,
    basePlanRevision: packet.plan?.revision ?? 0, reason: '고정 합성 관측에 따른 판별 계획과 가설 검토', tasks: selected, hypotheses: assessed } };
}

/** Finite state-based transport; expected final facts and accounting are checked independently below. */
function decide(input: AgentTurnInput): AgentTurnResult {
  const p = input.packet, session = p.session;
  const current = session?.entries.find(entry => entry.sourceId === session.basis.input.messageId &&
    entry.sequence === session.basis.input.sequence && entry.workId === p.workId && entry.role === 'user');
  assert.equal(current?.text, original); assert.deepEqual(p.goal.criteria, []);
  const evidence = new Set(p.evidence.map(item => item.id));
  if (!p.plan) { assert.equal(evidence.size, 0); return plan(p, tasks.slice(0, 2), hypotheses); }
  if (p.execution?.attempts.some(attempt => attempt.taskId === 'read-amendment' && attempt.status === 'failed')) {
    assert.equal(evidence.has('doc-a-amendment'), false);
    return { kind: 'question', question: '개정 원문을 확인하지 못해 현행을 확정할 수 없습니다. 유효한 개정 자료를 제공해 주세요.' };
  }
  if (evidence.has('doc-a-amendment')) {
    assert.equal(evidence.has('doc-b'), true);
    if (p.hypotheses.find(h => h.id === 'h90')?.status !== 'refuted') return plan(p, tasks, [
      { ...hypotheses[0]!, status: 'refuted', counterIds: ['doc-b', 'doc-a-amendment'], reason: '개정본과 별도 현행 자료가 모두 30일을 명시한다.' },
      { ...hypotheses[1]!, status: 'supported', supportIds: ['doc-b', 'doc-a-amendment'], reason: '유효한 개정으로 구본이 대체되었다.' },
    ]);
    return { kind: 'answer', text: '두 문서의 현행 보존기간은 30일로 같습니다. 처음 관측한 90일은 구본이며 유효한 개정본이 이를 대체했습니다.',
      evidenceIds: ['doc-b', 'doc-a-amendment'], assessment: { type: 'model_self_review', verdict: 'satisfied', missing: [],
        counterarguments: ['초기 90일 관측은 유효한 개정으로 대체되었으므로 현행 독립 출처로 중복 계산하지 않았다.'],
        rationale: '고정된 합성 자료의 두 계보와 개정 관계를 대조한 결과이며 실제 모델 품질 평가는 아니다.' } };
  }
  if (evidence.has('doc-b')) {
    assert.equal(evidence.has('doc-a-old'), true);
    return plan(p, tasks, [
      { ...hypotheses[0]!, status: 'contested', supportIds: ['doc-a-old'], counterIds: ['doc-b'], reason: '별도 관측의 30일이 초기 90일을 반박한다.' },
      { ...hypotheses[1]!, status: 'contested', supportIds: ['doc-b'], counterIds: ['doc-a-old'], reason: '충돌을 판별할 개정 원본이 필요하다.' },
    ]);
  }
  assert.equal(evidence.has('doc-a-old'), true);
  return plan(p, tasks.slice(0, 2), [
    { ...hypotheses[0]!, status: 'supported', supportIds: ['doc-a-old'], reason: '초기 자료의 잠정 지지이며 별도 출처는 미관측이다.' },
    { ...hypotheses[1]!, status: 'refuted', counterIds: ['doc-a-old'], reason: '초기 자료는 90일이며 개정 여부는 아직 확인하지 못했다.' },
  ]);
}

async function fixture(t: TestContext, failAmendment: boolean) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'complex-agent-turn-'))), directory = join(base, 'agent');
  const hostOptions = { identityRegistryDirectory: join(base, 'registry') };
  mkdirSync(join(base, 'engine'), { mode: 0o700 });
  const profiles = new FileAgentProfileStore(join(base, 'engine')), initialized = profiles.initialize(directory);
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ ...initialized.config, model: { profile: 'complex-contract-v1' } }));
  const inputs: AgentTurnInput[] = [], reads: { taskId: string; attemptId: string }[] = [], transportErrors: string[] = [];
  const host: AgentTurnHost = { models: new Map([['complex-contract-v1', { execution: 'deterministic_fixture', async open(profile) {
    const identity = { provider: 'local-fixture', model: 'complex-contract', revision: '1' };
    const planner = new StructuredAgentTurnAdapter({ identity, profile, destination: 'local', maxRequestBytes: 65536,
      capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 100000, maxOutputTokens: 2048 } }, {
      async invoke(request) {
        inputs.push(structuredClone(request.input));
        try { return { provider: identity.provider, model: identity.model, finish: 'stop', content: JSON.stringify(decide(request.input)), usage: { inputTokens: 200, outputTokens: 50 } }; }
        catch (error) { transportErrors.push(String(error)); throw error; }
      },
    });
    return { planner, inputLimits: { maxInputBytes: 65536, maxOutputTokens: 2048 }, async close() {} };
  } }]]) };
  async function open() {
    const stores = await openAgentStores(profiles, directory, undefined, hostOptions);
    const selected = await openRegisteredHostModel(resolveHostModelRegistration(host, stores.profile.config.model!.profile), {
      agentId: stores.profile.identity.agentId, purpose: '범용 복합 조사 계약 시험', skillsMode: 'off' });
    const underlying = new FixtureReadTool(scenario.evidence);
    const tool: Tool = { definition: underlying.definition, async execute(task, context) {
      reads.push({ taskId: task.id, attemptId: context.attemptId });
      if (failAmendment && task.id === 'read-amendment') return { resultId: `${context.attemptId}:result`, attemptId: context.attemptId,
        status: 'error', error: { code: 'evidence_unavailable', retryable: false }, effectState: 'none', evidence: [], artifacts: [],
        output: null, cursor: null, coverage: 'unknown' };
      return underlying.execute(task, context);
    } };
    const composed = await composeRuntime({ services: { state: stores.state, artifacts: stores.artifacts, sink: stores.channel, tools: [tool],
      planner: selected.planner, ids: new RandomIds(), digester: new Sha256Digester(), clock: { now: () => Date.now() } },
      modelInputLimits: selected.inputLimits, session: { repository: stores.sessions, agentId: stores.profile.identity.agentId },
      schemas: new AjvSchemas(), guidanceSource: { list: async () => [], read: async () => { throw new Error('no_guidance'); } }, owner: 'complex-turn-test' });
    let closed = false;
    return { ...composed, stores, turns: new AgentTurnService(composed.sessions!, composed.services.digester), async close() {
      if (closed) return; closed = true; try { await selected.close(); } finally { await stores.close(); }
    } };
  }
  let current = await open();
  t.after(async () => { try { await current.close(); } finally { rmSync(base, { recursive: true, force: true }); } });
  return { inputs, reads, transportErrors, get current() { return current; }, async reopen() { await current.close(); current = await open(); } };
}

for (const fail of [false, true]) test(`general complex turn: ${fail ? 'failed discriminating read waits for a question without erasing the conflict' : 'late counterevidence adds only the discriminating task and answers from current independent sources'}`, { timeout: 60000 }, async t => {
  const f = await fixture(t, fail), session = await f.current.sessions!.open(actor, { channel: 'test', conversationId: 'complex' });
  const accepted = await f.current.turns.accept(actor, { sessionId: session.scope.sessionId, messageId: 'original', rawText: original,
    binding: { ...actor, channel: 'test', conversationId: 'complex', recipientId: actor.principalId, destination: 'local' },
    mode: 'deep', scope: scenario.goal.scope, policy: scenario.policy, limits });
  const workId = accepted.workId;
  assert.equal(accepted.state.goal.description, original); assert.deepEqual(accepted.state.goal.criteria, []);
  assert.equal(accepted.state.goal.responseRequirement!.requestTextDigest, f.current.services.digester.digest(original));
  assert.equal(f.inputs.length, 0); assert.equal(f.reads.length, 0);
  for (let step = 0; step < 30; step++) {
    if ((await f.current.runtime.state(workId)).evidence.some(item => item.id === 'doc-b')) break;
    const action = await f.current.planning!.step(workId);
    assert.equal(action.kind, 'continue', JSON.stringify({ action, errors: f.transportErrors }));
  }
  const before = await f.current.runtime.state(workId);
  assert.deepEqual(before.evidence.map(item => item.id).sort(), ['doc-a-old', 'doc-b']);
  assert.equal(hypothesesRequireReview(before), true); assert.equal(before.plan!.revision, 1);
  assert.equal(before.budget.used.modelCalls, 2); assert.equal(before.budget.used.replans, 0);
  assert.equal(before.attempts.length, 2); assert.ok(before.attempts.every(attempt => attempt.status === 'succeeded' && attempt.adopted));
  assert.equal(before.generatedAnswer, undefined);
  const originals = await Promise.all(before.attempts.map(async attempt => ({ ref: attempt.resultArtifact!,
    bytes: Buffer.from(await f.current.services.artifacts.get(attempt.resultArtifact!, before.policy)) })));
  const history = await f.current.sessions!.history(actor, session.scope.sessionId, before.policy, { limit: 100 });
  await f.reopen();
  assert.deepEqual(await f.current.runtime.state(workId), before);
  assert.deepEqual(await f.current.sessions!.history(actor, session.scope.sessionId, before.policy, { limit: 100 }), history);
  assert.equal(f.inputs.length, 2); assert.equal(f.reads.length, 2);
  const outcome = await f.current.workflow.run(workId, actor, { maxSteps: 60 });
  const done = await f.current.runtime.state(workId);
  assert.deepEqual(f.transportErrors, []); assert.equal(outcome.control.kind, fail ? 'wait' : 'complete', JSON.stringify(outcome));
  assert.equal(done.plan!.revision, 2); assert.equal(done.budget.used.replans, 1);
  assert.equal(done.budget.used.modelCalls, fail ? 4 : 5); assert.equal(done.budget.used.tokens, (fail ? 4 : 5) * 250);
  assert.equal(done.budget.used.toolCalls, 3); assert.deepEqual(f.reads.map(item => item.taskId), ['read-old', 'read-independent', 'read-amendment']);
  assert.deepEqual(done.attempts.slice(0, 2).map(item => item.id), before.attempts.map(item => item.id));
  assert.ok(done.attempts.filter(attempt => attempt.status === 'succeeded').every(attempt => attempt.adopted));
  assert.equal(done.budget.reservedTokens, 0); assert.equal(done.budget.reservedModelCalls, 0); assert.equal(done.budget.reservedToolCalls, 0);
  assert.ok(done.modelCalls.every(call => call.status === 'accepted' && call.usageStatus === 'reported' && call.inputEstimate > 1));
  for (const item of originals) assert.deepEqual(Buffer.from(await f.current.services.artifacts.get(item.ref, done.policy)), item.bytes);
  for (let index = 0; index < done.modelCalls.length; index++) {
    const call = done.modelCalls[index]!;
    const saved = JSON.parse(Buffer.from(await f.current.services.artifacts.get(call.inputArtifact!, done.policy)).toString());
    assert.deepEqual(AgentTurnInputSchema.parse(saved.turn), f.inputs[index]);
  }
  const deliveries = await f.current.services.state.deliveries(workId);
  if (fail) {
    assert.equal(outcome.reason, 'pending_obligation'); assert.equal(done.status, 'waiting');
    assert.equal(done.attempts[2]!.status, 'failed'); assert.equal(done.attempts[2]!.error?.code, 'evidence_unavailable');
    const failedOriginal = done.attempts[2]!.resultArtifact; assert.ok(failedOriginal);
    const failedResult = JSON.parse(Buffer.from(await f.current.services.artifacts.get(failedOriginal, done.policy)).toString());
    assert.equal(failedResult.status, 'error'); assert.equal(failedResult.error.code, 'evidence_unavailable');
    assert.deepEqual(failedResult.evidence, []);
    assert.ok(done.hypotheses.every(h => h.status === 'contested')); assert.equal(done.evidence.some(item => item.id === 'doc-a-amendment'), false);
    assert.equal(done.generatedAnswer, undefined); assert.equal(deliveries.filter(item => item.kind === 'result').length, 0);
    assert.equal(deliveries.filter(item => item.kind === 'question' && item.status === 'delivered').length, 1);
    assert.equal(done.obligations.filter(item => item.kind === 'response' && item.status === 'pending').length, 1);
  } else {
    const current = accessibleEvidence(done.evidence, done.policy, done.goal.scope);
    assert.deepEqual(current.map(item => item.id).sort(), ['doc-a-amendment', 'doc-b']);
    assert.deepEqual(current.map(item => item.sourceId).sort(), ['doc-a', 'doc-b']);
    assert.ok(current.every(item => item.facts['retention.days'] === 30));
    assert.ok(current.find(item => item.id === 'doc-a-amendment')!.supersedes.includes('doc-a-old'));
    assert.equal(done.hypotheses.find(h => h.id === 'h90')!.status, 'refuted');
    assert.equal(done.hypotheses.find(h => h.id === 'h30')!.status, 'supported');
    assert.equal(hypothesesRequireReview(done), false);
    assert.deepEqual([...done.generatedAnswer!.evidenceIds].sort(), ['doc-a-amendment', 'doc-b']);
    assert.match((await readGeneratedAnswer(f.current.services, done))!.text, /30일/);
    assert.equal(deliveries.filter(item => item.kind === 'result' && item.status === 'delivered').length, 1);
    assert.equal(done.conversation!.completionRequiresDelivery, true);
  }
  const ids = done.evidence.map(item => item.id);
  assert.ok(ids.every(id => ['doc-a-old', 'doc-b', 'doc-a-amendment'].includes(id)), 'counterargument text is never promoted into independent evidence');
  const modelCount = f.inputs.length, readCount = f.reads.length;
  await f.reopen();
  assert.equal((await f.current.workflow.run(workId, actor)).control.kind, fail ? 'wait' : 'complete');
  assert.equal(f.inputs.length, modelCount); assert.equal(f.reads.length, readCount);
  const reopened = await f.current.runtime.state(workId);
  assert.deepEqual(reopened.budget, done.budget); assert.deepEqual(reopened.attempts, done.attempts);
  assert.deepEqual(reopened.plan, done.plan); assert.deepEqual(reopened.hypotheses, done.hypotheses);
  assert.deepEqual(await f.current.services.state.deliveries(workId), deliveries);
});
