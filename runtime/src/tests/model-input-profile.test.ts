import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelCall } from '../domain/model.js';
import type { ModelInputEstimationProfile, Planner } from '../application/ports.js';
import { ModelCallSchema } from '../application/contracts.js';
import { ModelInputBudgetError } from '../application/model-input-budget.js';
import { inputProfileDigest, inputProfileMatches, inputProfileSnapshot } from '../application/model-input-profile.js';
import { asJson } from '../application/plan-validator.js';
import { Sha256Digester } from '../infrastructure/digest.js';

const digester = new Sha256Digester();
const runtime = { maxInputBytes: 32000, maxOutputTokens: 500 };
function planner() {
  return { identity: { provider: 'synthetic', model: 'profile-test', revision: 'adapter-1' }, destination: 'local',
    capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true,
      maxInputTokens: 4000, contextWindowTokens: 12000, maxOutputTokens: 1000, maxInputBytes: 64000 },
    inputEstimation: { id: 'registered-estimator', revision: 'estimate-1', templateRevision: 'template-1',
      kind: 'tokenizer' as ModelInputEstimationProfile['kind'] } };
}
type ProfilePlanner = Parameters<typeof inputProfileSnapshot>[0];
function digest(value: ProfilePlanner = planner(), purpose: Parameters<typeof inputProfileSnapshot>[1] = 'planning', limits = runtime) {
  return inputProfileDigest(digester, inputProfileSnapshot(value, purpose, limits));
}

/** Field order matches the historical serialized ModelCall schema, before an input profile was available. */
function historicalCall(version: 2 | 3 | 4): ModelCall {
  return { id: `call-v${version}`, provider: 'synthetic', model: 'profile-test', adapterRevision: 'adapter-1',
    destination: 'local', owner: 'runtime-owner', goalRevision: 1,
    ...(version === 3 ? { purpose: 'session_compact' as const, compactInputDigest: 'compact-input', compactRequestId: 'request-1' } :
      version === 4 ? { purpose: 'agent_turn' as const, agentTurnPromptDigest: 'a'.repeat(64) } : {}),
    baseStateRevision: 1, basePlanRevision: 0, semanticDigest: `historical-semantic-v${version}`, semanticVersion: version,
    inputArtifact: { id: 'input', sha256: 'b'.repeat(64), byteLength: 123, mediaType: 'application/json', tenantId: 'synthetic', labels: [] },
    replyArtifact: null, inputEstimate: 50, maxOutputTokens: 100, tokenReservation: 150,
    inputTokens: null, outputTokens: null, usageStatus: 'reserved', status: 'reserved',
    startedAt: 1000, leaseUntil: 2000, finishedAt: null, expired: false, outcome: null, reason: 'historical reservation' };
}

for (const version of [2, 3, 4] as const) {
  test(`v${version} calls retain their historical JSON and digest without acquiring an input profile`, () => {
    const before = historicalCall(version), serialized = JSON.stringify(before), fingerprint = digester.digest(asJson(before));
    const parsed = ModelCallSchema.parse(JSON.parse(serialized));
    assert.equal(JSON.stringify(parsed), serialized);
    assert.equal(digester.digest(asJson(parsed)), fingerprint);
    assert.equal(Object.hasOwn(parsed, 'inputProfileDigest'), false);
    assert.equal(inputProfileMatches(parsed, digest()), null);
    assert.equal(JSON.stringify(parsed), serialized);
    const pinned = ModelCallSchema.parse({ ...before, inputProfileDigest: digest() });
    assert.equal(pinned.inputProfileDigest, digest());
    assert.equal(pinned.semanticDigest, before.semanticDigest);
    assert.equal(pinned.semanticVersion, version);
  });
}

test('input profile schema accepts only a full lowercase SHA256 pin and never defaults missing legacy metadata', () => {
  for (const value of [null, '', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), 123])
    assert.equal(ModelCallSchema.safeParse({ ...historicalCall(4), inputProfileDigest: value }).success, false);
  const { semanticVersion: _legacyVersion, ...beforeVersionedSemantics } = historicalCall(2);
  const parsed = ModelCallSchema.parse(beforeVersionedSemantics);
  assert.equal(Object.hasOwn(parsed, 'inputProfileDigest'), false);
  assert.equal(Object.hasOwn(parsed, 'semanticVersion'), false);
  assert.equal(JSON.stringify(parsed), JSON.stringify(beforeVersionedSemantics));
});

test('the snapshot normalizes absent optional capabilities and is independent of object property order', () => {
  const value = planner(), snapshot = inputProfileSnapshot(value, 'planning', runtime);
  const reordered = { inputEstimation: { kind: value.inputEstimation.kind, templateRevision: 'template-1', revision: 'estimate-1', id: 'registered-estimator' },
    capabilities: { ...value.capabilities }, destination: value.destination,
    identity: { revision: 'adapter-1', model: 'profile-test', provider: 'synthetic' } };
  assert.equal(digest(value), digest(reordered));
  assert.equal(snapshot.effectiveLimits.maxInputTokens, 4000);
  assert.equal(snapshot.effectiveLimits.maxInputBytes, 32000);
  const { contextWindowTokens: _window, maxOutputTokens: _output, maxInputBytes: _bytes, ...legacyCapabilities } = value.capabilities;
  const absent = { ...value, capabilities: legacyCapabilities };
  const explicitUndefined = { ...absent, capabilities: { ...legacyCapabilities, contextWindowTokens: undefined,
    maxOutputTokens: undefined, maxInputBytes: undefined } };
  assert.equal(digest(absent), digest(explicitUndefined));
  const normalized = inputProfileSnapshot(absent, 'planning', runtime);
  assert.deepEqual([normalized.capabilities.contextWindowTokens, normalized.capabilities.maxOutputTokens, normalized.capabilities.maxInputBytes],
    [null, null, null]);
});

test('raw capability, output reservation and runtime byte changes invalidate the profile even with unchanged effective input capacity', () => {
  const changes: ((value: ReturnType<typeof planner>) => void)[] = [
    value => { value.capabilities.structuredOutput = false; }, value => { value.capabilities.toolCalling = true; },
    value => { value.capabilities.images = true; }, value => { value.capabilities.cancellation = false; },
    value => { value.capabilities.maxInputTokens++; }, value => { value.capabilities.contextWindowTokens++; },
    value => { value.capabilities.maxOutputTokens++; }, value => { value.capabilities.maxInputBytes++; },
  ];
  for (const change of changes) { const value = planner(); change(value); assert.notEqual(digest(value), digest()); }
  assert.notEqual(digest(planner(), 'planning', { ...runtime, maxInputBytes: 32001 }), digest());
  assert.notEqual(digest(planner(), 'planning', { ...runtime, maxOutputTokens: 501 }), digest());
  const before = planner(), changed = planner(); changed.capabilities.maxInputBytes++;
  assert.deepEqual(inputProfileSnapshot(before, 'planning', runtime).effectiveLimits,
    inputProfileSnapshot(changed, 'planning', runtime).effectiveLimits);
  assert.notEqual(digest(before), digest(changed));
});

test('model identity, route, purpose and each estimator registration field participate in the pin', () => {
  const changes: ((value: ReturnType<typeof planner>) => void)[] = [
    value => { value.identity.provider = 'another'; }, value => { value.identity.model = 'another'; },
    value => { value.identity.revision = 'adapter-2'; }, value => { value.destination = 'another'; },
    value => { value.inputEstimation.id = 'another'; }, value => { value.inputEstimation.revision = 'estimate-2'; },
    value => { value.inputEstimation.templateRevision = 'template-2'; },
    value => { value.inputEstimation.kind = 'conservative_estimate'; },
  ];
  for (const change of changes) { const value = planner(); change(value); assert.notEqual(digest(value), digest()); }
  assert.equal(new Set(['planning', 'agent_turn', 'session_compact'].map(purpose =>
    digest(planner(), purpose as Parameters<typeof inputProfileSnapshot>[1]))).size, 3);
});

test('a snapshot is deeply copied and frozen without freezing caller settings or invoking estimator/model hooks', () => {
  const value = planner(), limits = { ...runtime }; let invocations = 0;
  const adapter = { ...value, estimateInput() { invocations++; throw new Error('must not estimate'); },
    propose() { invocations++; throw new Error('must not invoke'); } } satisfies Planner;
  const snapshot = inputProfileSnapshot(adapter, 'planning', limits), before = inputProfileDigest(digester, snapshot);
  for (const item of [snapshot, snapshot.identity, snapshot.capabilities, snapshot.runtime, snapshot.effectiveLimits, snapshot.inputEstimation])
    assert.equal(Object.isFrozen(item), true);
  assert.equal(Object.isFrozen(value.identity), false); assert.equal(Object.isFrozen(limits), false);
  value.identity.revision = 'adapter-2'; value.capabilities.maxInputTokens = 5000;
  value.inputEstimation.revision = 'estimate-2'; limits.maxOutputTokens = 600;
  assert.equal(inputProfileDigest(digester, snapshot), before);
  assert.notEqual(digest(adapter, 'planning', limits), before);
  assert.equal(invocations, 0);
});

test('a legacy estimator is pinned to adapter revision, not unregistered hook implementation or current request data', () => {
  const { inputEstimation: _profile, ...value } = planner();
  const first = { ...value, estimateInput: () => ({ tokens: 1, bytes: 1, method: 'old-hook' }) };
  const second = { ...value, estimateInput: () => ({ tokens: 2, bytes: 2, method: 'changed-hook' }) };
  assert.deepEqual(inputProfileSnapshot(first, 'planning', runtime).inputEstimation,
    { id: 'legacy_adapter_revision', revision: 'adapter-1', templateRevision: 'adapter-1', kind: 'legacy_adapter_revision' });
  // Unregistered hook changes are not detectable unless their adapter revision also changes.
  assert.equal(digest(first), digest(second));
  assert.notEqual(digest(first), digest({ ...second, identity: { ...second.identity, revision: 'adapter-2' } }));
  assert.equal(inputProfileMatches({}, digest(first)), null);
});

test('matching is tri-state and cannot treat an absent or malformed legacy pin as a verified current execution profile', () => {
  const current = digest(), call = { inputProfileDigest: current };
  assert.equal(inputProfileMatches(call, current), true);
  assert.equal(inputProfileMatches(call, digest(planner(), 'agent_turn')), false);
  assert.equal(inputProfileMatches({}, current), null);
  assert.equal(inputProfileMatches({ inputProfileDigest: 'invalid' }, 'invalid'), false);
  assert.deepEqual(call, { inputProfileDigest: current });
});

test('invalid model registration or window configuration fails explicitly without masquerading as request oversize', () => {
  const invalid: unknown[] = [
    { ...planner(), identity: undefined }, { ...planner(), identity: { ...planner().identity, revision: '' } },
    { ...planner(), destination: ' ' }, { ...planner(), capabilities: { ...planner().capabilities, images: 1 } },
    { ...planner(), capabilities: { ...planner().capabilities, maxInputBytes: NaN } },
    { ...planner(), capabilities: { ...planner().capabilities, contextWindowTokens: 500 } },
    { ...planner(), inputEstimation: null }, { ...planner(), inputEstimation: { ...planner().inputEstimation, revision: ' ' } },
    { ...planner(), inputEstimation: { ...planner().inputEstimation, kind: 'unknown' } },
    { ...planner(), inputEstimation: { ...planner().inputEstimation, undeclared: true } },
  ];
  const configurationError = (error: unknown) => error instanceof ModelInputBudgetError && error.code === 'model_window_configuration_invalid';
  for (const value of invalid) assert.throws(() => inputProfileSnapshot(value as ProfilePlanner, 'planning', runtime), configurationError);
  assert.throws(() => inputProfileSnapshot(planner(), 'invalid' as 'planning', runtime), configurationError);
  assert.throws(() => inputProfileSnapshot(planner(), 'planning', { ...runtime, maxInputBytes: -1 }), configurationError);
});
