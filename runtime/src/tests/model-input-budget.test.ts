import test from 'node:test';
import assert from 'node:assert/strict';
import { assessInputFit, ModelInputBudgetError, resolveModelInputLimits, validateModelInputEstimate, validateModelInputEstimationProfile } from '../application/model-input-budget.js';
import type { ModelCapabilities } from '../application/ports.js';

function capabilities(overrides: Partial<ModelCapabilities> = {}): ModelCapabilities {
  return { structuredOutput: true, toolCalling: true, images: false, cancellation: true, maxInputTokens: 1000, ...overrides };
}
const runtime = { maxInputBytes: 10_000, maxOutputTokens: 100 };
const hasCode = (code: ModelInputBudgetError['code']) => (error: unknown) => error instanceof ModelInputBudgetError && error.code === code;

test('unregistered total window preserves legacy input capacity without inventing a total or reducing output', () => {
  const limits = resolveModelInputLimits(capabilities(), runtime);
  assert.deepEqual(limits, { maxInputTokens: 1000, maxInputBytes: 10_000, maxOutputTokens: 100,
    contextWindowTokens: null, declaredMaxInputTokens: 1000, declaredMaxOutputTokens: null });
  assert.equal(assessInputFit({ tokens: 1000, bytes: 10_000, method: 'legacy-local' }, limits, 100).kind, 'fit');
  assert.equal(Object.isFrozen(limits), true);
});

test('window reserves output exactly and applies independent byte and input caps at the inclusive boundary', () => {
  const limits = resolveModelInputLimits(capabilities({ contextWindowTokens: 900, maxOutputTokens: 100, maxInputBytes: 500 }), runtime);
  assert.equal(limits.maxInputTokens, 800); assert.equal(limits.maxOutputTokens, 100); assert.equal(limits.maxInputBytes, 500);
  assert.deepEqual(assessInputFit({ tokens: 800, bytes: 500, method: 'test' }, limits, 499).exceeds, { tokens: false, bytes: false });
  assert.deepEqual(assessInputFit({ tokens: 801, bytes: 500, method: 'test' }, limits, 499), {
    kind: 'too_large', estimate: { tokens: 801, bytes: 500, method: 'test' }, exceeds: { tokens: true, bytes: false } });
  assert.deepEqual(assessInputFit({ tokens: 800, bytes: 501, method: 'test' }, limits, 499).exceeds, { tokens: false, bytes: true });
  assert.deepEqual(assessInputFit({ tokens: 801, bytes: 501, method: 'test' }, limits, 499).exceeds, { tokens: true, bytes: true });
  assert.equal(resolveModelInputLimits(capabilities({ maxInputTokens: 400, contextWindowTokens: 900, maxInputBytes: 20_000 }), runtime).maxInputTokens, 400);
  assert.equal(resolveModelInputLimits(capabilities({ maxInputBytes: 20_000 }), runtime).maxInputBytes, 10_000);
});

test('invalid windows and impossible output reservations are configuration errors, not compact candidates', () => {
  const bad = hasCode('model_window_configuration_invalid');
  for (const value of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    for (const key of ['maxInputTokens', 'contextWindowTokens', 'maxOutputTokens', 'maxInputBytes'] as const)
      assert.throws(() => resolveModelInputLimits(capabilities({ [key]: value }), runtime), bad, key + ':' + value);
    assert.throws(() => resolveModelInputLimits(capabilities(), { ...runtime, maxInputBytes: value }), bad);
    assert.throws(() => resolveModelInputLimits(capabilities(), { ...runtime, maxOutputTokens: value }), bad);
  }
  for (const extra of [{ maxOutputTokens: 99 }, { contextWindowTokens: 100 }, { contextWindowTokens: 99 }, { maxInputTokens: Number.MAX_SAFE_INTEGER }])
    assert.throws(() => resolveModelInputLimits(capabilities(extra), runtime), bad);
  assert.throws(() => assessInputFit({ tokens: 1, bytes: 1, method: 'test' }, { maxInputTokens: 0, maxInputBytes: 1 }, 0), bad);
});

test('malformed estimates and underreported request bytes fail instead of being classified too large', () => {
  const limits = resolveModelInputLimits(capabilities(), runtime), bad = hasCode('model_input_estimate_invalid');
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => assessInputFit({ tokens: value, bytes: 100, method: 'test' }, limits, 100), bad);
  for (const value of [-1, 99, 100.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => assessInputFit({ tokens: 1, bytes: value, method: 'test' }, limits, 100), bad);
  for (const method of ['', '  ', 'x'.repeat(257)]) assert.throws(() => assessInputFit({ tokens: 1, bytes: 100, method }, limits, 100), bad);
  for (const value of [null, undefined, [], Promise.resolve({ tokens: 1, bytes: 100, method: 'async' })])
    assert.throws(() => validateModelInputEstimate(value, 100), bad);
  const original = { tokens: 8, bytes: 100, method: 'known-local-v1' }, fit = assessInputFit(original, limits, 100);
  original.tokens = 999; assert.equal(fit.estimate.tokens, 8); assert.equal(Object.isFrozen(fit.estimate), true);
});

test('estimator profiles are strict copied registrations independent from per-request estimates', () => {
  const raw = { id: 'local-test', revision: '1', templateRevision: 'wire-2', kind: 'tokenizer' as const };
  const profile = validateModelInputEstimationProfile(raw); raw.id = 'changed'; assert.equal(profile.id, 'local-test'); assert.equal(Object.isFrozen(profile), true);
  for (const invalid of [{ ...raw, id: '' }, { ...raw, revision: ' ' }, { ...raw, templateRevision: 'a'.repeat(257) },
    { ...raw, kind: 'model-name-guess' }, { ...raw, hiddenNetworkEndpoint: 'denied' }])
    assert.throws(() => validateModelInputEstimationProfile(invalid), hasCode('model_window_configuration_invalid'));
});
