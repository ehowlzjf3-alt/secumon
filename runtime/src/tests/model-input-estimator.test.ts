import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateScenario } from '../application/fixtures.js';
import { ModelInputBudgetError } from '../application/model-input-budget.js';
import { estimateModelContextPreview, type ModelContextPreview } from '../application/model-context-preview.js';
import type { AgentTurnInput } from '../application/agent-turn-types.js';
import type { ModelCallOptions, ModelInputEstimate } from '../application/ports.js';
import type { ContextPacket } from '../domain/model.js';
import { FixtureReadTool } from '../infrastructure/fakes.js';
import { registerModelInputEstimator, type LocalModelInputEstimator } from '../infrastructure/model-input-estimator.js';
import { StructuredPlannerAdapter, type StructuredPlannerConfiguration, type StructuredPlannerRequest } from '../infrastructure/structured-planner.js';
import { StructuredAgentTurnAdapter, type StructuredAgentTurnConfiguration, type StructuredAgentTurnRequest } from '../infrastructure/structured-agent-turn.js';

const scenario = validateScenario(JSON.parse(readFileSync(new URL('../../fixtures/documents-simple.json', import.meta.url), 'utf8')));
const profile = { id: 'test-local-counter', revision: '1', templateRevision: 'fixture-wire-v1', kind: 'conservative_estimate' as const };
function packet(): ContextPacket {
  return structuredClone({ schemaVersion: 1, workId: 'input-size-work', stateRevision: 1, goal: scenario.goal, policy: scenario.policy,
    plan: null, hypotheses: [], obligations: [], evidence: [], activeToolIds: ['fixture.read'], purpose: 'plan' });
}
function config(): StructuredPlannerConfiguration {
  return { identity: { provider: 'fixture', model: 'local-counter', revision: 'r1' }, destination: 'local',
    capabilities: { structuredOutput: true, toolCalling: true, images: false, cancellation: true, maxInputTokens: 100_000 } };
}
function turnConfig(): StructuredAgentTurnConfiguration { return { ...config(), profile: { agentId: 'size-agent', purpose: '일반 요청', skillsMode: 'off' } }; }
function options(): ModelCallOptions {
  const tool = new FixtureReadTool(scenario.evidence).definition;
  tool.description = 'ASCII and 한국어 🔎 — '.repeat(20);
  return { callId: 'measure-call', maxOutputTokens: 100, tools: [tool] };
}
function turn(adapter: StructuredAgentTurnAdapter): AgentTurnInput {
  const context = packet(); context.goal.description = '현재 원문은 고치지 않는다. ASCII 한글 🔎';
  return { version: 1, packet: context, prompt: adapter.prompt,
    previousAnswer: { callId: 'earlier-call', artifact: { id: 'draft', sha256: 'a'.repeat(64), byteLength: 123, mediaType: 'application/json', tenantId: 'synthetic', labels: ['synthetic'] },
      result: { kind: 'answer', text: '보완해야 할 이전 초안 '.repeat(30), evidenceIds: [],
        assessment: { type: 'model_self_review', verdict: 'needs_work', rationale: '원문 확인 필요', missing: ['원문'], counterarguments: ['다른 해석'] } } } };
}
const response = { finish: 'refused', content: null, usage: { inputTokens: 13, outputTokens: 2 }, provider: 'fixture', model: 'local-counter' };
const estimateFrom = (serialized: string): ModelInputEstimate => ({ tokens: Math.max(1, Math.ceil(serialized.length / 2)), bytes: Buffer.byteLength(serialized), method: 'fixture-counter-v1' });

test('registered planning estimator sees exactly the frozen request sent to transport including tool schema and instructions', async () => {
  const measured: { request: unknown; serialized: string }[] = [], sent: StructuredPlannerRequest[] = [];
  const estimator: LocalModelInputEstimator = { profile, estimate(request, serialized) {
    measured.push({ request, serialized }); assert.equal(Object.isFrozen(request), true); return estimateFrom(serialized);
  } };
  const adapter = new StructuredPlannerAdapter({ ...config(), inputEstimator: estimator }, { async invoke(request) { sent.push(request); return response; } });
  const context = packet(); context.goal.description = '한국어 원문과 ASCII 🔎'; const selected = options();
  const estimate = adapter.estimateInput(context, selected); assert.equal(sent.length, 0); assert.equal(measured.length, 1);
  assert.deepEqual(adapter.inputEstimation, profile); assert.notEqual(estimate.tokens, estimate.bytes);
  const reply = await adapter.propose(context, new AbortController().signal, selected);
  assert.equal(reply.status, 'refused'); assert.equal(reply.inputTokens, 13); assert.equal(reply.outputTokens, 2);
  assert.equal(measured.length, 1, 'dispatch does not perform an unregistered second estimate');
  assert.deepEqual(measured[0]!.request, sent[0]); assert.equal(measured[0]!.serialized, JSON.stringify(sent[0]));
  assert.equal(estimate.bytes, Buffer.byteLength(JSON.stringify(sent[0])));
  assert.match(measured[0]!.serialized, /baseStateRevision/); assert.match(measured[0]!.serialized, /ASCII and 한국어/);
  const preview = adapter.estimateContextPreview({ kind: 'model_context_preview', packet: context }, selected);
  assert.equal(preview.bytes, estimate.bytes); assert.equal(measured[1]!.serialized, JSON.stringify(sent[0])); assert.equal(sent.length, 1);
});

test('registered main-turn estimator includes prompt, source text and previous draft without sending a preview', async () => {
  const measured: string[] = [], sent: StructuredAgentTurnRequest[] = [];
  const adapter = new StructuredAgentTurnAdapter({ ...turnConfig(), inputEstimator: { profile, estimate(request, serialized) {
    measured.push(serialized); assert.equal(Object.isFrozen(request), true); return estimateFrom(serialized);
  } } }, { async invoke(request) { sent.push(request); return response; } });
  const input = turn(adapter), selected = options(), estimated = adapter.estimateTurnInput(input, selected);
  assert.equal(sent.length, 0); await adapter.turn(input, new AbortController().signal, selected);
  assert.equal(measured[0], JSON.stringify(sent[0])); assert.equal(estimated.bytes, Buffer.byteLength(JSON.stringify(sent[0])));
  assert.match(measured[0]!, /previousAnswer/); assert.match(measured[0]!, /보완해야 할 이전 초안/);
  assert.match(measured[0]!, /model_self_review, not independent validation/); assert.match(measured[0]!, /현재 원문/);
  assert.throws(() => { sent[0]!.input.previousAnswer!.result.text = 'mutated'; }, TypeError);
});

test('oversized estimates remain numeric while both adapters enforce exact transport byte caps', async () => {
  let calls = 0;
  const transport = { async invoke() { calls++; return response; } };
  const planner = new StructuredPlannerAdapter({ ...config(), maxRequestBytes: 1024 }, transport);
  assert.equal(planner.capabilities.maxInputBytes, 1024); assert.ok(planner.estimateInput(packet(), options()).bytes > 1024);
  const rejected = await planner.propose(packet(), new AbortController().signal, options());
  assert.equal(rejected.status, 'invalid'); assert.equal(rejected.code, 'model_request_too_large');
  const large = new StructuredAgentTurnAdapter(turnConfig(), transport), input = turn(large), selected = options();
  const bytes = large.estimateTurnInput(input, selected).bytes;
  const exact = new StructuredAgentTurnAdapter({ ...turnConfig(), maxRequestBytes: bytes }, transport);
  assert.equal((await exact.turn(input, new AbortController().signal, selected)).status, 'refused');
  const small = new StructuredAgentTurnAdapter({ ...turnConfig(), maxRequestBytes: bytes + 1,
    capabilities: { ...config().capabilities, maxInputBytes: bytes - 1, contextWindowTokens: 2000, maxOutputTokens: 500 } }, transport);
  assert.equal(small.capabilities.maxInputBytes, bytes - 1); assert.equal(small.capabilities.contextWindowTokens, 2000);
  assert.equal(small.estimateTurnInput(input, selected).bytes, bytes);
  const refused = await small.turn(input, new AbortController().signal, selected);
  assert.equal(refused.status, 'invalid'); assert.equal(refused.code, 'model_request_too_large');
  assert.equal(calls, 1);
});

test('estimation keeps request policy and prompt validation before the registered local function runs', () => {
  let estimates = 0; const estimator: LocalModelInputEstimator = { profile, estimate(_request, text) { estimates++; return estimateFrom(text); } };
  const transport = { async invoke() { throw new Error('must_not_invoke'); } };
  const planner = new StructuredPlannerAdapter({ ...config(), inputEstimator: estimator }, transport);
  const context = packet(); context.policy.allowedDestinations = [];
  assert.throws(() => planner.estimateInput(context, options()), /model_destination_denied/);
  const adapter = new StructuredAgentTurnAdapter({ ...turnConfig(), inputEstimator: estimator }, transport), input = turn(adapter);
  input.prompt = { ...input.prompt, instructions: 'forged' };
  assert.throws(() => adapter.estimateTurnInput(input, options()), /model_prompt_mismatch/);
  const denied = turn(adapter); denied.packet.activeToolIds = [];
  assert.throws(() => adapter.estimateTurnInput(denied, options()), /model_tool_contract_denied/);
  assert.equal(estimates, 0);
});

test('registered estimation rejects underreported bytes and invalid tokens and preserves thrown causes without fallback', () => {
  for (const value of [0, -1, NaN, Infinity, 1.5]) {
    const estimator = registerModelInputEstimator('test', { profile, estimate(_request, serialized) { return { tokens: value, bytes: Buffer.byteLength(serialized), method: 'bad' }; } });
    assert.throws(() => estimator.estimate(Object.freeze({ text: '한글' })), error => error instanceof ModelInputBudgetError && error.code === 'model_input_estimate_invalid');
  }
  const short = registerModelInputEstimator('test', { profile, estimate() { return { tokens: 1, bytes: 1, method: 'bad-bytes' }; } });
  assert.throws(() => short.estimate(Object.freeze({ text: '한글' })), /model_input_estimate_invalid/);
  const cause = new Error('local estimator failed'); let attempts = 0;
  const throws = registerModelInputEstimator('test', { profile, estimate() { attempts++; throw cause; } });
  assert.throws(() => throws.estimate(Object.freeze({ text: 'original' })), error => error instanceof ModelInputBudgetError && error.cause === cause);
  assert.equal(attempts, 1);
});

test('registration captures profile and function while legacy fallback retains its known method', () => {
  const metadata = { ...profile }, selected: LocalModelInputEstimator = { profile: metadata, estimate(_request, text) { return estimateFrom(text); } };
  const registered = registerModelInputEstimator('test', selected); metadata.revision = 'changed';
  selected.estimate = () => { throw new Error('replaced function must not run'); };
  assert.equal(registered.profile.revision, '1'); assert.equal(Object.isFrozen(registered.profile), true);
  assert.equal(registered.estimate(Object.freeze({ text: 'hello' })).method, 'fixture-counter-v1');
  const fallback = registerModelInputEstimator('stable-template'); const value = fallback.estimate(Object.freeze({ text: '한글 🔎' }));
  assert.equal(value.tokens, value.bytes); assert.equal(value.method, 'utf8_bytes_estimate');
  assert.deepEqual(fallback.profile, { id: 'utf8-bytes', revision: '1', templateRevision: 'stable-template', kind: 'conservative_estimate' });
});

function previewOf(input: AgentTurnInput): ModelContextPreview {
  const { session, ...packet } = input.packet;
  return { kind: 'model_context_preview', packet,
    ...(session === undefined ? {} : { session: { basis: session.basis, entries: session.entries, summary: session.schemaVersion === 2 ? session.summary : null } }),
    turn: { prompt: input.prompt, ...(input.previousAnswer === undefined ? {} : { previousAnswer: input.previousAnswer }) } };
}

test('headless context preview is a local hint with the same request fields and cannot be dispatched as a published input', async () => {
  const measured: unknown[] = [], sent: StructuredAgentTurnRequest[] = [];
  const adapter = new StructuredAgentTurnAdapter({ ...turnConfig(), inputEstimator: { profile, estimate(request, text) {
    measured.push(request); return estimateFrom(text);
  } } }, { async invoke(request) { sent.push(request); return response; } });
  const full = turn(adapter), selected = options();
  full.packet.session = { schemaVersion: 1, interpretation: 'conversation_history_not_verified_evidence',
    basis: { scope: { tenantId: 'synthetic', agentId: 'size-agent', principalId: 'operator', sessionId: 'session' }, input: { messageId: 'message', sequence: 1, digest: 'a'.repeat(64) } },
    head: { revision: 1, throughSequence: 1, digest: 'b'.repeat(64), policyDigest: 'c'.repeat(64) },
    entries: [{ sequence: 1, sourceId: 'message', workId: full.packet.workId, role: 'user', text: '보존할 현재 원문', labels: ['synthetic'], artifact: null, status: 'received', kind: 'work' }] };
  const preview = previewOf(full), hint = adapter.estimateContextPreview(preview, selected);
  assert.equal(sent.length, 0); assert.equal(hint.bytes, Buffer.byteLength(JSON.stringify(measured[0])));
  const draft = measured[0] as { input: AgentTurnInput };
  assert.equal(Object.hasOwn(draft.input.packet.session!, 'head'), false); assert.equal(Object.isFrozen(draft.input), true);
  const rejected = await adapter.turn(draft.input, new AbortController().signal, selected);
  assert.equal(rejected.status, 'invalid'); assert.equal(rejected.code, 'model_request_invalid'); assert.equal(sent.length, 0);
  const envelopeHint = estimateModelContextPreview(adapter, preview, selected);
  assert.equal(envelopeHint.bytes, hint.bytes + 512); assert.equal(envelopeHint.tokens, hint.tokens + 512, 'head allowance is applied once by the orchestrator');
  const actual = adapter.estimateTurnInput(full, selected); assert.ok(actual.bytes > hint.bytes);
  await adapter.turn(full, new AbortController().signal, selected);
  const actualWithoutHead = JSON.parse(JSON.stringify(sent[0])) as { input: { packet: { session: Record<string, unknown> } } };
  delete actualWithoutHead.input.packet.session['head']; assert.deepEqual(actualWithoutHead, measured[0]);
  assert.equal(actual.bytes, Buffer.byteLength(JSON.stringify(sent[0]))); assert.equal(sent.length, 1);
});

test('preview estimates retain actual prompt, identity, disclosure and tool validation without treating the preview as authority', () => {
  let estimates = 0;
  const estimator: LocalModelInputEstimator = { profile, estimate(_request, text) { estimates++; return estimateFrom(text); } };
  const transport = { async invoke() { throw new Error('must_not_invoke'); } };
  const adapter = new StructuredAgentTurnAdapter({ ...turnConfig(), inputEstimator: estimator }, transport);
  const altered = previewOf(turn(adapter)); altered.turn!.prompt = { ...altered.turn!.prompt, digest: 'f'.repeat(64) };
  assert.throws(() => adapter.estimateContextPreview(altered, options()), /model_prompt_mismatch/);
  const foreign = previewOf(turn(adapter)); foreign.session = {
    basis: { scope: { tenantId: 'synthetic', agentId: 'someone-else', principalId: 'operator', sessionId: 'session' }, input: { messageId: 'm', sequence: 1, digest: 'a'.repeat(64) } },
    entries: [], summary: null };
  assert.throws(() => adapter.estimateContextPreview(foreign, options()), /model_agent_identity_mismatch/);
  const withFakeHead = structuredClone(foreign); Object.assign(withFakeHead.session!, { head: { revision: 1 } });
  assert.throws(() => adapter.estimateContextPreview(withFakeHead, options()), /model_request_invalid/);
  const denied = previewOf(turn(adapter)); denied.packet.policy.disclosure = { revision: '1', destinations: [], maxReleasesPerWork: 0, maxReleasedBytesPerWork: 0 };
  assert.throws(() => adapter.estimateContextPreview(denied, options()), /model_disclosure_denied/);
  const inactive = previewOf(turn(adapter)); inactive.packet.activeToolIds = [];
  assert.throws(() => adapter.estimateContextPreview(inactive, options()), /model_tool_contract_denied/);
  const planner = new StructuredPlannerAdapter({ ...config(), inputEstimator: estimator }, transport);
  assert.throws(() => planner.estimateContextPreview(previewOf(turn(adapter)), options()), /model_request_invalid/);
  const plain: ModelContextPreview = { kind: 'model_context_preview', packet: packet() }; plain.packet.policy.allowedDestinations = [];
  assert.throws(() => planner.estimateContextPreview(plain, options()), /model_destination_denied/);
  assert.equal(estimates, 0);
});
