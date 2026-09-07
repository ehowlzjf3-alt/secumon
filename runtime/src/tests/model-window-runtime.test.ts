import test from 'node:test';
import assert from 'node:assert/strict';
import { windowFixture } from './session-window-helpers.js';
import { modelContextPreviewEnvelope } from '../application/model-context-preview.js';

test('required input overflow prevents preventive compact even when the session entry threshold is exceeded', async t => {
  const f = await windowFixture(t, 8, { maxContextEntries: 4, keepRecentEntries: 1 });
  f.planner.capabilities.maxInputTokens = 1;
  let writes = 0; const put = f.services.artifacts.put.bind(f.services.artifacts);
  f.services.artifacts.put = async (...args) => { writes++; return put(...args); };
  await assert.rejects(f.compactPlanning!.compactStep(f.workId), /model_input_required_overflow/);
  const state = await f.current();
  assert.equal(state.modelCalls.length, 0); assert.equal(f.planner.inputs.length, 0); assert.equal(writes, 0);
  assert.equal(state.budget.reservedModelCalls, 0); assert.equal(state.budget.used.modelCalls, 0);
});

test('malformed estimates are not hidden by an optional raw-session fallback', async t => {
  const f = await windowFixture(t, 8, { maxContextEntries: 4, keepRecentEntries: 1 });
  f.services.planner = { ...f.planner, estimateContextPreview: () => ({ tokens: NaN, bytes: 0, method: 'broken' }) };
  await assert.rejects(f.compactPlanning!.compactStep(f.workId), /model_input_estimate_invalid/);
  assert.equal((await f.current()).modelCalls.length, 0); assert.equal(f.planner.inputs.length, 0);
});

test('an optional compact capacity failure reuses the same whole-request preparation through reservation', async t => {
  const f = await windowFixture(t, 8, { triggerRatio: 0.1, targetRatio: 0.05, keepRecentEntries: 1 });
  let inspections = 0; const inspect = f.context.inspect.bind(f.context);
  f.context.inspect = async (...args) => { inspections++; return inspect(...args); };
  f.planner.estimateCompactInput = (compact, options) => ({ tokens: 100001,
    bytes: Buffer.byteLength(JSON.stringify({ compact, options })), method: 'synthetic_compact_capacity' });
  assert.equal(await f.compactPlanning!.compactStep(f.workId), null);
  assert.equal(await f.compactPlanning!.compactStep(f.workId), null);
  const call = await f.compactPlanning!.reserve(f.workId);
  assert.equal(call.purpose, undefined); assert.equal(call.status, 'reserved');
  assert.equal(inspections, 1); assert.equal((await f.current()).modelCalls.length, 1);
  assert.equal(f.planner.inputs.length, 0);
});

test('an actual published request is remeasured and cannot use a fitting preview as permission to exceed the limit', async t => {
  const f = await windowFixture(t, 2);
  f.services.planner = { ...f.planner,
    estimateContextPreview: (preview, options) => ({ tokens: 1000,
      bytes: Buffer.byteLength(JSON.stringify(modelContextPreviewEnvelope(preview, options))), method: 'synthetic_preview' }),
    estimateInput: (packet, options) => ({ tokens: 100001,
      bytes: Buffer.byteLength(JSON.stringify({ packet, options })), method: 'synthetic_actual_request' }),
  };
  await assert.rejects(f.compactPlanning!.reserve(f.workId), /model_input_limit/);
  const state = await f.current(); assert.equal(state.modelCalls.length, 0); assert.equal(f.planner.inputs.length, 0);
  assert.equal(state.budget.reservedTokens, 0); assert.equal(state.contextHead, undefined);
});

test('a setting change while inspecting invalidates the unsent preparation before any reservation', async t => {
  const f = await windowFixture(t, 2);
  const inspect = f.context.inspect.bind(f.context);
  f.context.inspect = async (...args) => { const result = await inspect(...args); f.planner.capabilities.maxInputTokens--; return result; };
  await assert.rejects(f.compactPlanning!.reserve(f.workId), /model_input_profile_changed/);
  assert.equal((await f.current()).modelCalls.length, 0); assert.equal(f.planner.inputs.length, 0);
});
