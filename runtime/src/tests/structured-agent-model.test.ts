import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AgentTurnInput, AgentTurnProfile } from '../application/agent-turn-types.js';
import { validateScenario } from '../application/fixtures.js';
import type { ModelContextPreview } from '../application/model-context-preview.js';
import type { ModelCallOptions, ModelInputEstimationProfile } from '../application/ports.js';
import { asJson } from '../application/plan-validator.js';
import type { AgentTurnResult } from '../domain/agent-turn.js';
import type { SessionCompactInput } from '../domain/session-compact.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { FixtureReadTool } from '../infrastructure/fakes.js';
import type { LocalModelInputEstimator } from '../infrastructure/model-input-estimator.js';
import { StructuredAgentModel } from '../infrastructure/structured-agent-model.js';
import { StructuredAgentTurnAdapter, type StructuredAgentTurnConfiguration, type StructuredAgentTurnRequest } from '../infrastructure/structured-agent-turn.js';
import { StructuredSessionCompactAdapter, type StructuredSessionCompactRequest } from '../infrastructure/structured-session-compact.js';

const scenario = validateScenario(JSON.parse(readFileSync(new URL('../../fixtures/documents-simple.json', import.meta.url), 'utf8')));
const profile: AgentTurnProfile = { agentId: 'registered-agent', purpose: '범용 등록 계약 시험', skillsMode: 'off' };
const hash = 'a'.repeat(64);
function configuration(): StructuredAgentTurnConfiguration {
  return { profile: { ...profile }, identity: { provider: 'fixture', model: 'registered', revision: 'r1' }, destination: 'local',
    capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 100_000 }, maxRequestBytes: 65_536 };
}
function input(model: StructuredAgentModel): AgentTurnInput {
  return { version: 1, prompt: model.prompt, packet: structuredClone({ schemaVersion: 1, workId: 'registered-work', stateRevision: 1,
    goal: scenario.goal, policy: scenario.policy, plan: null, hypotheses: [], obligations: [], evidence: [], activeToolIds: ['fixture.read'], purpose: 'plan',
    session: { schemaVersion: 1, interpretation: 'conversation_history_not_verified_evidence',
      basis: { scope: { tenantId: 'synthetic', agentId: model.prompt.profile.agentId, principalId: 'learner', sessionId: 'conversation' },
        input: { messageId: 'current', sequence: 3, digest: hash } },
      head: { revision: 1, throughSequence: 3, digest: hash, policyDigest: hash },
      entries: [{ sequence: 3, sourceId: 'current', workId: 'registered-work', role: 'user', text: '현재 요청 한글 🔎',
        labels: ['synthetic'], artifact: null, status: 'received', kind: 'work' }] },
  }) };
}
function compactInput(): SessionCompactInput {
  return { schemaVersion: 1, purpose: 'session_compact', workId: 'registered-work',
    basis: { scope: { tenantId: 'synthetic', agentId: profile.agentId, principalId: 'learner', sessionId: 'conversation' },
      input: { messageId: 'current', sequence: 3, digest: hash } },
    policyDigest: hash, inputDigest: hash, expectedHead: null, previous: null, prefix: { throughSequence: 1, digest: hash, entries: 1 },
    entries: [{ sequence: 1, sourceId: 'earlier', workId: 'earlier-work', role: 'user', text: '원문 보존',
      labels: ['synthetic'], artifact: null, status: 'received', kind: 'work' }],
    maxSummaryBytes: 4096, interpretation: 'conversation_history_not_verified_evidence' };
}
function options(tools = true): ModelCallOptions { return { callId: 'registered-call', maxOutputTokens: 2048,
  tools: tools ? [new FixtureReadTool(scenario.evidence).definition] : [] }; }
const answer: AgentTurnResult = { kind: 'answer', text: '등록 모델 응답', evidenceIds: [], assessment: {
  type: 'model_self_review', verdict: 'satisfied', rationale: '형식 확인', missing: [], counterarguments: ['독립 검증 결과는 아님'],
} };
function fixture(turnConfig = configuration(), compactConfig = configuration(), overrides: Record<string, unknown> = {}) {
  const turns: StructuredAgentTurnRequest[] = [], compacts: StructuredSessionCompactRequest[] = [];
  const turn = new StructuredAgentTurnAdapter(turnConfig, { async invoke(request) {
    turns.push(request); return { provider: 'fixture', model: 'registered', finish: 'stop', content: JSON.stringify(answer),
      usage: { inputTokens: 17, outputTokens: null }, ...overrides };
  } });
  const { profile: _profile, ...compactConfiguration } = compactConfig;
  const compact = new StructuredSessionCompactAdapter(compactConfiguration, { async invoke(request) {
    compacts.push(request); return { provider: 'fixture', model: 'registered', finish: 'stop',
      content: JSON.stringify({ inputDigest: request.compact.inputDigest, content: { narrative: '원문을 유지한다.', retained: [] } }),
      usage: { inputTokens: null, outputTokens: 7 }, ...overrides };
  } });
  return { turn, compact, turns, compacts, model: new StructuredAgentModel(turn, compact) };
}

test('combined model delegates detached turn, compact and preview methods without changing provider usage or request bytes', async () => {
  const f = fixture(), value = input(f.model), selected = options(), compactValue = compactInput();
  const { session, ...packet } = value.packet; assert.ok(session);
  const preview: ModelContextPreview = { kind: 'model_context_preview', packet, turn: { prompt: value.prompt },
    session: { basis: session.basis, entries: session.entries, summary: null } };
  const { estimateTurnInput, estimateContextPreview, estimateCompactInput, turn, compact, propose } = f.model;
  const estimated = estimateTurnInput(value, selected), compactEstimate = estimateCompactInput(compactValue, options(false));
  assert.deepEqual(estimateContextPreview(preview, selected), f.turn.estimateContextPreview(preview, selected));
  assert.deepEqual(estimated, f.turn.estimateTurnInput(value, selected));
  assert.equal(f.turns.length, 0); assert.equal(f.compacts.length, 0);
  const turnReply = await turn(value, new AbortController().signal, selected);
  assert.equal(turnReply.status, 'ok'); if (turnReply.status !== 'ok') assert.fail('answer_expected');
  assert.deepEqual(turnReply.result, answer); assert.equal(turnReply.provider, 'fixture'); assert.equal(turnReply.model, 'registered');
  assert.equal(turnReply.inputTokens, 17); assert.equal(turnReply.outputTokens, null);
  const compactReply = await compact(compactValue, new AbortController().signal, options(false));
  assert.equal(compactReply.status, 'ok'); if (compactReply.status !== 'ok') assert.fail('candidate_expected');
  assert.equal(compactReply.inputTokens, null); assert.equal(compactReply.outputTokens, 7); assert.equal(compactReply.provider, turnReply.provider);
  assert.equal(estimated.bytes, Buffer.byteLength(JSON.stringify(f.turns[0])));
  assert.equal(compactEstimate.bytes, Buffer.byteLength(JSON.stringify(f.compacts[0])));
  assert.equal(f.turns.length, 1); assert.equal(f.compacts.length, 1);
  const legacy = await propose(value.packet, new AbortController().signal, selected);
  assert.equal(legacy.status, 'invalid'); assert.equal(legacy.code, 'model_turn_route_required');
  assert.equal(f.turns.length, 1); assert.equal(f.compacts.length, 1);
});

test('different purpose identities, destinations or effective capabilities cannot be registered as one model', () => {
  const changes: ((value: StructuredAgentTurnConfiguration) => void)[] = [
    value => { value.identity.provider = 'other'; }, value => { value.identity.model = 'other'; },
    value => { value.identity.revision = 'r2'; }, value => { value.destination = 'remote'; },
    value => { value.capabilities.maxInputTokens = 99_999; }, value => { value.capabilities.contextWindowTokens = 101_000; },
    value => { value.capabilities.maxOutputTokens = 1024; }, value => { value.maxRequestBytes = 65_535; },
    value => { value.capabilities.maxInputBytes = 65_535; }, value => { value.capabilities.images = true; },
  ];
  for (const change of changes) {
    const config = configuration(); change(config);
    assert.throws(() => fixture(configuration(), config), /structured_agent_model_mismatch/);
  }
  const config = configuration(); config.capabilities.maxInputBytes = 65_536; config.maxRequestBytes = 100_000;
  assert.deepEqual(fixture(configuration(), config).model.capabilities.maxInputBytes, 65_536);
});

function estimator(profile: ModelInputEstimationProfile): LocalModelInputEstimator {
  return { profile, estimate(_request, serialized) { const bytes = Buffer.byteLength(serialized); return { tokens: bytes, bytes, method: 'local-test-estimate' }; } };
}
const estimatorProfile: ModelInputEstimationProfile = { id: 'registered-counter', revision: '1', templateRevision: 'template-1', kind: 'tokenizer' };
function profiled(turnProfile = estimatorProfile, compactProfile = estimatorProfile, hostProfile = profile) {
  return fixture({ ...configuration(), profile: hostProfile, inputEstimator: estimator(turnProfile) },
    { ...configuration(), inputEstimator: estimator(compactProfile) });
}

test('combined estimation fingerprint covers every child profile field and the host-bound main prompt', () => {
  const base = profiled(), digest = base.model.inputEstimation.templateRevision;
  const alternatives = [{ ...estimatorProfile, id: 'other' }, { ...estimatorProfile, revision: '2' },
    { ...estimatorProfile, templateRevision: 'template-2' }, { ...estimatorProfile, kind: 'conservative_estimate' as const },
    { ...estimatorProfile, kind: 'legacy_adapter_revision' as const }];
  for (const changed of alternatives) {
    assert.notEqual(profiled(changed).model.inputEstimation.templateRevision, digest);
    assert.notEqual(profiled(estimatorProfile, changed).model.inputEstimation.templateRevision, digest);
  }
  for (const changed of [{ ...profile, purpose: '다른 목적' }, { ...profile, agentId: 'other-agent' }, { ...profile, skillsMode: 'explicit' as const }])
    assert.notEqual(profiled(estimatorProfile, estimatorProfile, changed).model.inputEstimation.templateRevision, digest);
  assert.equal(profiled({ kind: 'tokenizer', templateRevision: 'template-1', revision: '1', id: 'registered-counter' }).model.inputEstimation.templateRevision, digest);
  assert.equal(base.model.inputEstimation.kind, 'tokenizer'); assert.equal(fixture().model.inputEstimation.kind, 'conservative_estimate');
  assert.equal(profiled(estimatorProfile, alternatives[4]!).model.inputEstimation.kind, 'legacy_adapter_revision');
  const expected = new Sha256Digester().digest(asJson({ version: 1,
    turn: { estimation: base.turn.inputEstimation, prompt: { version: base.turn.prompt.version, digest: base.turn.prompt.digest } },
    compact: { estimation: base.compact.inputEstimation },
  }));
  assert.equal(digest, `structured-agent-model-v1:${expected}`);
});

test('combined metadata is frozen and preserves child request guards and identity failure without fallback calls', async () => {
  const config = configuration(), f = fixture(config); config.identity.model = 'after-construction'; config.capabilities.maxInputTokens = 1;
  assert.equal(f.model.identity.model, 'registered'); assert.equal(f.model.capabilities.maxInputTokens, 100_000);
  assert.throws(() => { f.model.prompt.profile.agentId = 'changed'; }, TypeError);
  assert.throws(() => { (f.model.inputEstimation as { revision: string }).revision = 'changed'; }, TypeError);
  const denied = input(f.model); denied.packet.policy.allowedDestinations = [];
  const turn = await f.model.turn(denied, new AbortController().signal, options());
  assert.equal(turn.status, 'invalid'); assert.equal(turn.code, 'model_destination_denied');
  const compact = await f.model.compact(compactInput(), new AbortController().signal, options());
  assert.equal(compact.status, 'invalid'); assert.equal(compact.code, 'model_tool_contract_denied');
  assert.equal(f.turns.length, 0); assert.equal(f.compacts.length, 0);
  const mismatch = fixture(configuration(), configuration(), { provider: 'other' });
  const rejected = await mismatch.model.turn(input(mismatch.model), new AbortController().signal, options());
  assert.equal(rejected.status, 'invalid'); assert.equal(rejected.code, 'model_identity_mismatch');
  assert.equal(rejected.inputTokens, 17); assert.equal(rejected.outputTokens, null); assert.equal(mismatch.turns.length, 1);
});
