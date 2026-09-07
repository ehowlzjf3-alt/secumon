import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AgentTurnInput, AgentTurnProfile, AgentTurnReply } from '../application/agent-turn-types.js';
import { AgentTurnInputSchema } from '../application/agent-turn-contracts.js';
import { validateScenario } from '../application/fixtures.js';
import { resolveModelInputLimits } from '../application/model-input-budget.js';
import type { ModelContextPreview } from '../application/model-context-preview.js';
import type { ModelCallOptions, ToolDefinition } from '../application/ports.js';
import { createResourceTools, type ResourceDependencies } from '../application/resource-tools.js';
import type { SessionCompactInput } from '../domain/session-compact.js';
import { FixtureReadTool } from '../infrastructure/fakes.js';
import { StructuredAgentModel } from '../infrastructure/structured-agent-model.js';
import { StructuredModelOptionsSchema } from '../infrastructure/structured-planner.js';
import { SyntheticAgentTurnPlanner, SYNTHETIC_AGENT_TURN_REQUESTS as requests, SYNTHETIC_AGENT_TURN_CORRECTION as correction } from '../infrastructure/synthetic-agent-turn.js';
import { SyntheticProfilePlanner } from '../presentation/agent-turn-profile.js';
import { createLocalContractHost, LOCAL_CONTRACT_MODEL_PROFILE } from '../presentation/local-contract-model.js';
import { openRegisteredHostModel, resolveHostModelRegistration, type RegisteredTurnPlanner } from '../presentation/host-models.js';

const scenario = validateScenario(JSON.parse(readFileSync(new URL('../../fixtures/documents-simple.json', import.meta.url), 'utf8')));
const profile: AgentTurnProfile = { agentId: 'contract-agent', purpose: '범용 담당 계약 시험', skillsMode: 'off' };
const hash = 'a'.repeat(64);
function input(planner: RegisteredTurnPlanner, text: string): AgentTurnInput {
  return { version: 1, prompt: planner.prompt, packet: structuredClone({ schemaVersion: 1, workId: 'contract-work', stateRevision: 1,
    goal: scenario.goal, policy: scenario.policy, plan: null, hypotheses: [], obligations: [], evidence: [], activeToolIds: ['fixture.read'], purpose: 'plan',
    session: { schemaVersion: 1, interpretation: 'conversation_history_not_verified_evidence',
      basis: { scope: { tenantId: 'synthetic', agentId: planner.prompt.profile.agentId, principalId: 'learner', sessionId: 'conversation' },
        input: { messageId: 'current', sequence: 3, digest: hash } },
      head: { revision: 1, throughSequence: 3, digest: hash, policyDigest: hash },
      entries: [{ sequence: 3, sourceId: 'current', workId: 'contract-work', role: 'user', text,
        labels: ['synthetic'], artifact: null, status: 'received', kind: 'work' }] },
  }) };
}
function options(tools = true): ModelCallOptions { return { callId: 'contract-call', maxOutputTokens: 2048,
  tools: tools ? [new FixtureReadTool(scenario.evidence).definition] : [] }; }
function compactInput(): SessionCompactInput {
  return { schemaVersion: 1, purpose: 'session_compact', workId: 'contract-work',
    basis: { scope: { tenantId: 'synthetic', agentId: profile.agentId, principalId: 'learner', sessionId: 'conversation' },
      input: { messageId: 'current', sequence: 3, digest: hash } },
    policyDigest: hash, inputDigest: hash, previous: null, expectedHead: null, prefix: { throughSequence: 2, digest: hash, entries: 2 },
    entries: [
      { sequence: 1, sourceId: 'user-1', workId: 'earlier-work', role: 'user', text: requests.rewrite,
        labels: ['synthetic'], artifact: null, status: 'received', kind: 'work' },
      { sequence: 2, sourceId: 'answer-2', workId: 'earlier-work', role: 'assistant', text: `[합성 규칙 결과] ${correction}`,
        labels: ['synthetic'], artifact: null, status: 'delivered', kind: 'result' },
    ], maxSummaryBytes: 8192, interpretation: 'conversation_history_not_verified_evidence' };
}
async function opened(selected = profile) {
  return openRegisteredHostModel(resolveHostModelRegistration(createLocalContractHost(), LOCAL_CONTRACT_MODEL_PROFILE), selected);
}
function result(reply: AgentTurnReply) { assert.equal(reply.status, 'ok'); if (reply.status !== 'ok') assert.fail('result_expected'); return reply.result; }

test('local contract is an exact named finite fixture with one model identity and bounded turn/compact registration', async () => {
  const host = createLocalContractHost(); assert.deepEqual([...host.models.keys()], ['local-contract-v1']);
  const registration = resolveHostModelRegistration(host, LOCAL_CONTRACT_MODEL_PROFILE);
  assert.equal(registration.execution, 'deterministic_fixture');
  const raw = await registration.open(profile);
  assert.ok(raw.planner instanceof StructuredAgentModel);
  assert.deepEqual(raw.planner.identity, { ...new SyntheticAgentTurnPlanner(profile).identity, revision: 'registered-1' });
  assert.deepEqual(raw.planner.prompt.profile, profile); assert.equal(raw.planner.destination, 'local');
  assert.equal(typeof raw.planner.compact, 'function'); assert.equal(typeof raw.planner.estimateCompactInput, 'function');
  assert.deepEqual(raw.inputLimits, { maxInputBytes: 65_536, maxOutputTokens: 2048 });
  const limits = resolveModelInputLimits(raw.planner.capabilities, raw.inputLimits);
  assert.equal(limits.maxInputTokens, 100_000); assert.equal(limits.maxInputBytes, 65_536);
  assert.equal(limits.maxOutputTokens, 2048); assert.equal(raw.planner.inputEstimation.kind, 'conservative_estimate');
  assert.throws(() => resolveHostModelRegistration(host, 'LOCAL-CONTRACT-V1'), /agent_turn_provider_unavailable/);
  await raw.close(); await raw.close();
});

test('known turn rules pass through the real structured adapters and arbitrary text remains a refusal', async t => {
  const model = await opened(); t.after(model.close); const { planner } = model;
  const fixture = new SyntheticAgentTurnPlanner(profile), signal = new AbortController().signal;
  for (const text of [requests.rewrite, requests.question, requests.clarification, requests.read, requests.followup]) {
    const value = input(planner, text), reply = await planner.turn(value, signal, options());
    const expected = await fixture.turn(value, signal, options());
    assert.deepEqual(reply, expected); assert.equal(reply.inputTokens, 0); assert.equal(reply.outputTokens, 0);
  }
  const corrected = result(await planner.turn(input(planner, requests.rewrite), signal, options()));
  assert.equal(corrected.kind, 'answer'); if (corrected.kind === 'answer') {
    assert.equal(corrected.text, `[합성 규칙 결과] ${correction}`);
    assert.match(corrected.assessment.rationale, /실제 모델의 의미 판단은 아니다/);
  }
  for (const text of ['자유 문장 의미를 해석해서 처리해 줘.', requests.rewrite + ' 추가 지시']) {
    const refused = await planner.turn(input(planner, text), signal, options());
    assert.equal(refused.status, 'refused'); assert.equal(refused.code, 'model_refused');
    assert.equal(refused.inputTokens, 0); assert.equal(refused.outputTokens, 0);
  }
});

// Read the real tool contract without allowing this proposal-only fixture to access a store or execute a tool.
const evidenceGet = createResourceTools(new Proxy({} as ResourceDependencies, {
  get() { assert.fail('proposal_must_not_access_resource_dependencies'); },
})).find(tool => tool.definition.id === 'core.evidence.get')!.definition;
function recallInput(planner: RegisteredTurnPlanner, text: string = requests.read): AgentTurnInput {
  const value = input(planner, text);
  value.packet.activeToolIds = ['core.evidence.get']; value.packet.policy.allowedTools = ['core.evidence.get'];
  value.packet.contextView = { policyTools: 'active_subset', planTasks: 'frontier',
    omitted: { tools: 1, evidence: 1, attempts: 0, tasks: 0, results: 0 }, discoveryToolIds: ['core.evidence.get'] };
  return value;
}
function recallOptions(definition: ToolDefinition = evidenceGet): ModelCallOptions {
  return { ...options(false), tools: [structuredClone(definition)] };
}

test('registered read rule proposes the existing evidence getter only for the current applied request with omitted evidence', async t => {
  const model = await opened(); t.after(model.close); const signal = new AbortController().signal;
  for (const kind of ['work', 'input', 'command']) {
    const value = recallInput(model.planner); value.packet.session!.entries[0]!.kind = kind;
    value.packet.stateRevision = 7;
    const reply = await model.planner.turn(value, signal, recallOptions()), planned = result(reply);
    assert.equal(planned.kind, 'plan'); if (planned.kind !== 'plan') assert.fail('recall_plan_expected');
    assert.equal(planned.proposal.baseStateRevision, 7); assert.equal(planned.proposal.baseGoalRevision, scenario.goal.revision);
    assert.equal(planned.proposal.basePlanRevision, 0); assert.equal(planned.proposal.tasks.length, 1);
    const task = planned.proposal.tasks[0]!;
    assert.equal(task.toolId, 'core.evidence.get'); assert.equal(task.toolVersion, evidenceGet.version); assert.equal(task.effect, 'read');
    assert.deepEqual(task.input, { evidenceId: 'doc-current', detail: 'evidence', maxBytes: 4096 });
    assert.deepEqual(task.dependsOn, []); assert.equal(task.maxAttempts, 1);
    assert.equal(reply.inputTokens, 0); assert.equal(reply.outputTokens, 0);
    assert.deepEqual(value.packet.evidence, [], 'a proposal does not inject evidence or claim a fresh read');
  }
});

test('old quoted read requests and present evidence cannot activate the finite omitted-evidence recall rule', async t => {
  const model = await opened(); t.after(model.close); const signal = new AbortController().signal;
  const quoted = recallInput(model.planner, '현재 지원하지 않는 요청');
  quoted.packet.goal.description = requests.read;
  quoted.packet.session!.entries.unshift({ ...quoted.packet.session!.entries[0]!, sequence: 1, sourceId: 'old-read', text: requests.read });
  assert.equal((await model.planner.turn(quoted, signal, recallOptions())).status, 'refused');
  for (const mismatch of ['workId', 'sequence', 'sourceId', 'kind', 'role'] as const) {
    const value = recallInput(model.planner), entry = value.packet.session!.entries[0]!;
    if (mismatch === 'workId') entry.workId = 'another-work';
    else if (mismatch === 'sequence') entry.sequence = 2;
    else if (mismatch === 'sourceId') entry.sourceId = 'different-input';
    else if (mismatch === 'kind') entry.kind = 'result';
    else entry.role = 'assistant';
    assert.equal((await model.planner.turn(value, signal, recallOptions())).status, 'refused', mismatch);
  }
  const absent = recallInput(model.planner); delete absent.packet.contextView;
  const noneOmitted = recallInput(model.planner); noneOmitted.packet.contextView!.omitted.evidence = 0;
  for (const value of [absent, noneOmitted]) assert.equal(result(await model.planner.turn(value, signal, recallOptions())).kind, 'question');
  const present = recallInput(model.planner), current = structuredClone(scenario.evidence.find(item => item.id === 'doc-current')!);
  present.packet.evidence = [current];
  assert.equal(result(await model.planner.turn(present, signal, recallOptions())).kind, 'answer');
  current.status = 'retracted';
  assert.equal(result(await model.planner.turn(present, signal, recallOptions())).kind, 'question');
});

test('evidence recall requires the exact read tool version and the outer adapter still enforces active tool permissions', async t => {
  const model = await opened(); t.after(model.close); const signal = new AbortController().signal;
  assert.equal(result(await model.planner.turn(recallInput(model.planner), signal, options(false))).kind, 'question');
  assert.equal(result(await model.planner.turn(recallInput(model.planner), signal, recallOptions({ ...evidenceGet, version: '2' }))).kind, 'question');
  const writable = recallInput(model.planner); writable.packet.policy.allowWrites = true;
  assert.equal(result(await model.planner.turn(writable, signal, recallOptions({ ...evidenceGet, effect: 'write' }))).kind, 'question');
  for (const denied of ['inactive', 'policy', 'destination', 'label'] as const) {
    const value = recallInput(model.planner), selected = recallOptions();
    if (denied === 'inactive') value.packet.activeToolIds = [];
    else if (denied === 'policy') value.packet.policy.allowedTools = [];
    else if (denied === 'destination') selected.tools[0]!.destination = 'unapproved';
    else selected.tools[0]!.labels = ['unapproved'];
    const reply = await model.planner.turn(value, signal, selected);
    assert.equal(reply.status, 'invalid'); assert.equal(reply.code, 'model_tool_contract_denied');
    assert.equal(reply.inputTokens, 0); assert.equal(reply.outputTokens, 0);
  }
});

test('local registration measures full structured requests and headless previews without synthetic one-token shortcuts', async t => {
  const model = await opened(); t.after(model.close); const { planner } = model;
  const value = input(planner, requests.rewrite), selected = options();
  const estimate = planner.estimateTurnInput(value, selected);
  const request = { identity: planner.identity, input: AgentTurnInputSchema.parse(value), options: StructuredModelOptionsSchema.parse(selected) };
  assert.deepEqual(request.input.packet.planningFeedback, []); assert.equal('planningFeedback' in value.packet, false);
  assert.equal(estimate.bytes, Buffer.byteLength(JSON.stringify(request)));
  assert.equal(estimate.tokens, estimate.bytes); assert.ok(estimate.tokens > 1); assert.equal(estimate.method, 'utf8_bytes_estimate');
  const { session, ...packet } = value.packet; assert.ok(session);
  const preview: ModelContextPreview = { kind: 'model_context_preview', packet, turn: { prompt: value.prompt },
    session: { basis: session.basis, entries: session.entries, summary: null } };
  const previewEstimate = planner.estimateContextPreview(preview, selected);
  assert.equal(previewEstimate.tokens, previewEstimate.bytes); assert.ok(previewEstimate.bytes < estimate.bytes);
  assert.ok(previewEstimate.bytes > Buffer.byteLength(JSON.stringify(packet)));
  const compactValue = compactInput(); assert.ok(planner.estimateCompactInput);
  const compactEstimate = planner.estimateCompactInput(compactValue, options(false));
  assert.equal(compactEstimate.tokens, compactEstimate.bytes);
  assert.ok(compactEstimate.bytes > Buffer.byteLength(JSON.stringify({ compact: compactValue, options: options(false) })));
  const oversized = input(planner, 'x'.repeat(65_536));
  assert.ok(planner.estimateTurnInput(oversized, selected).bytes > model.inputLimits.maxInputBytes);
  const rejected = await planner.turn(oversized, new AbortController().signal, selected);
  assert.equal(rejected.status, 'invalid'); assert.equal(rejected.code, 'model_request_too_large'); assert.equal(rejected.inputTokens, 0);
});

test('the existing compact rules preserve prior items and exact source quotes after structured parsing', async t => {
  const model = await opened(); t.after(model.close); const { planner } = model; assert.ok(planner.compact);
  const fixture = new SyntheticProfilePlanner(new SyntheticAgentTurnPlanner(profile)), signal = new AbortController().signal;
  const firstInput = compactInput(), first = await planner.compact(firstInput, signal, options(false));
  assert.deepEqual(first, await fixture.compact(firstInput, signal, options(false)));
  assert.equal(first.status, 'ok'); if (first.status !== 'ok') assert.fail('candidate_expected');
  assert.equal(first.provider, planner.identity.provider); assert.equal(first.model, planner.identity.model);
  assert.equal(first.inputTokens, 0); assert.equal(first.outputTokens, 0);
  assert.equal(first.candidate.content.retained.length, 2);
  assert.ok(first.candidate.content.retained.some(item => item.kind === 'outcome' && item.citations.some(citation => citation.quote.includes(correction))));
  const secondInput = compactInput(); secondInput.basis.input.sequence = 5;
  secondInput.previous = { ref: { id: 'first-summary', revision: 1, throughSequence: 2, digest: hash, policyDigest: hash }, content: first.candidate.content };
  secondInput.expectedHead = secondInput.previous.ref; secondInput.prefix = { throughSequence: 3, digest: hash, entries: 1 };
  secondInput.entries = [{ ...firstInput.entries[0]!, sequence: 3, sourceId: 'user-3', kind: 'input' }];
  const second = await planner.compact(secondInput, signal, options(false));
  assert.deepEqual(second, await fixture.compact(secondInput, signal, options(false)));
  assert.equal(second.status, 'ok'); if (second.status !== 'ok') assert.fail('candidate_expected');
  assert.deepEqual(second.candidate.content.retained.map(item => item.id), first.candidate.content.retained.map(item => item.id));
  assert.equal(second.candidate.content.retained[0]!.changedBy!.sequence, 3);
  assert.equal(second.candidate.content.retained[1]!.citations[0]!.sequence, 2);
  const arbitrary = compactInput(); arbitrary.entries[0]!.text = '이 문장을 자유롭게 요약해 주세요.';
  const refused = await planner.compact(arbitrary, signal, options(false));
  assert.equal(refused.status, 'refused'); assert.equal(refused.code, 'model_refused'); assert.equal(refused.inputTokens, 0);
});

test('host profile changes alter the combined fingerprint while scoped request guards and early cancellation remain active', async t => {
  const original = { ...profile }, first = await opened(original); t.after(first.close); original.purpose = 'after-open';
  const again = await opened(); t.after(again.close);
  assert.deepEqual(first.planner.inputEstimation, again.planner.inputEstimation);
  assert.equal(first.planner.prompt.profile.purpose, profile.purpose);
  const changed = await opened({ ...profile, purpose: '다른 목적' }); t.after(changed.close);
  assert.notEqual(changed.planner.prompt.digest, first.planner.prompt.digest);
  assert.notEqual(changed.planner.inputEstimation.templateRevision, first.planner.inputEstimation.templateRevision);
  const wrongAgent = input(first.planner, requests.rewrite); wrongAgent.packet.session!.basis.scope.agentId = 'other-agent';
  const invalid = await first.planner.turn(wrongAgent, new AbortController().signal, options());
  assert.equal(invalid.status, 'invalid'); assert.equal(invalid.code, 'model_agent_identity_mismatch'); assert.equal(invalid.inputTokens, 0);
  const stopped = new AbortController(); stopped.abort();
  const cancelled = await first.planner.turn(input(first.planner, requests.rewrite), stopped.signal, options());
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.inputTokens, 0); assert.equal(cancelled.outputTokens, 0);
  assert.ok(first.planner.compact);
  const compact = await first.planner.compact(compactInput(), stopped.signal, options(false));
  assert.equal(compact.status, 'cancelled'); assert.equal(compact.inputTokens, 0); assert.equal(compact.outputTokens, 0);
});
