import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionCompactCalls } from '../application/session-compact-runtime.js';
import { windowFixture } from './session-window-helpers.js';

test('compact candidates halve at most nine times over one source scan and preserve complete prefix boundaries', async t => {
  const f = await windowFixture(t, 257, { maxContextBytes: 1000000, maxCompactInputBytes: 1000000, maxCompactEntries: 256 }, 40);
  const state = await f.current(), record = await f.repository.get(f.session.scope), counts: number[] = [];
  const history = f.repository.history.bind(f.repository); let reads = 0;
  f.repository.history = async (...args) => { reads++; return history(...args); };
  await assert.rejects(f.sessions.prepareCompact(state, { force: true, maxInputBytes: 1000000, maxInputTokens: 1000000,
    measure: input => { counts.push(input.entries.length); assert.equal(input.prefix.throughSequence, input.entries.at(-1)!.sequence);
      assert.ok(input.prefix.throughSequence < input.basis.input.sequence); return 'too_large'; } }), /session_compact_capacity/);
  assert.deepEqual(counts, [256, 128, 64, 32, 16, 8, 4, 2, 1]);
  assert.equal(reads, 5, 'candidate reduction reuses the original bounded pages instead of rescanning sources');
  assert.deepEqual(await f.current(), state); assert.deepEqual(await f.repository.get(f.session.scope), record); assert.equal(f.planner.inputs.length, 0);
});

test('one fitting reduced compact input owns exactly one actual call and usage settlement', async t => {
  const f = await windowFixture(t, 17), before = await f.current(), history = await f.history(), sizes: number[] = [];
  f.planner.estimateCompactInput = (input, options) => { sizes.push(input.entries.length); return {
    tokens: input.entries.length * 10000, bytes: Buffer.byteLength(JSON.stringify({ compact: input, options })), method: 'synthetic_entry_window' }; };
  const call = await f.compactPlanning!.requestCompact(f.workId, { force: true, requestId: 'reduced-once' }); assert.ok(call);
  assert.deepEqual(sizes, [16, 8]);
  const reserved = await f.current(); assert.equal(reserved.modelCalls.length, 1); assert.equal(reserved.budget.reservedModelCalls, 1);
  const input = JSON.parse(Buffer.from(await f.services.artifacts.get(call.inputArtifact, before.policy)).toString());
  assert.equal(input.compact.entries.length, 8); assert.equal(input.compact.inputDigest, call.compactInputDigest);
  assert.ok(input.compact.prefix.throughSequence < input.compact.basis.input.sequence); assert.deepEqual(input.options.tools, []);
  await f.compactPlanning!.execute(f.workId, call.id); assert.equal(await f.compactPlanning!.adopt(f.workId, call.id), true);
  const settled = await f.current(); assert.equal(f.planner.inputs.length, 1); assert.equal(f.planner.inputs[0]!.inputDigest, call.compactInputDigest);
  assert.equal(settled.budget.used.modelCalls, 1); assert.equal(settled.budget.used.tokens, 10); assert.equal(settled.budget.reservedTokens, 0);
  assert.deepEqual(await f.history(), history);
  assert.equal((await f.compactPlanning!.requestCompact(f.workId, { force: true, requestId: 'reduced-once' }))!.id, call.id);
  assert.equal(f.planner.inputs.length, 1);
});

for (const invalid of ['bytes', 'tokens', 'throw'] as const) test(`invalid compact estimate ${invalid} is not a reason to shrink or reserve another input`, async t => {
  const f = await windowFixture(t, 5), before = await f.current(); let estimates = 0;
  const error = new Error('injected_estimator_failure');
  f.planner.estimateCompactInput = (input, options) => { estimates++;
    if (invalid === 'throw') throw error;
    return { tokens: invalid === 'tokens' ? Number.NaN : 100,
      bytes: invalid === 'bytes' ? 1 : Buffer.byteLength(JSON.stringify({ compact: input, options })), method: 'invalid_synthetic_estimate' }; };
  await assert.rejects(f.compactPlanning!.requestCompact(f.workId, { force: true }), invalid === 'throw' ? (caught: unknown) => caught === error : /model_input_estimate_invalid/);
  assert.equal(estimates, 1); assert.equal((await f.current()).modelCalls.length, 0); assert.deepEqual((await f.current()).budget, before.budget);
  assert.equal(f.planner.inputs.length, 0); assert.equal(await f.repository.summaryHead(f.session.scope), null);
});

test('a one-entry source cannot be compacted by deleting the current user input', async t => {
  const f = await windowFixture(t, 1, { maxContextBytes: 1024 }, 6000), before = await f.current(); let estimates = 0;
  await assert.rejects(f.sessions.prepareCompact(before, { force: true, measure: () => { estimates++; return 'fit'; } }), /session_compact_capacity/);
  assert.equal(estimates, 0); assert.equal((await f.history()).entries[0]!.text, (await f.repository.input(f.session.scope, 'source-0'))!.text);
  assert.deepEqual(await f.current(), before);
});

test('a registered whole-request estimate replaces the old token-to-byte guess without altering source text', async t => {
  const f = await windowFixture(t, 5), state = await f.current(); let estimates = 0;
  f.planner.estimateCompactInput = (input, options) => { estimates++; return {
    tokens: 1, bytes: Buffer.byteLength(JSON.stringify({ compact: input, options })), method: 'explicit_synthetic_small_token_count' }; };
  const prepared = await new SessionCompactCalls(f.services).prepare(state, 'small-token-window',
    { maxInputBytes: 65536, maxInputTokens: 2, maxOutputTokens: 128 }, true);
  assert.ok(prepared); assert.equal(estimates, 1); assert.equal(prepared.compact.entries.length, 4);
  assert.ok(prepared.bytes.byteLength > 2 * 3, 'the old bytes-per-token guess would have rejected this synthetic estimate');
  assert.equal(prepared.compact.entries[0]!.text, (await f.repository.input(f.session.scope, 'source-0'))!.text);
  assert.equal((await f.current()).modelCalls.length, 0); assert.equal(f.planner.inputs.length, 0);
});

test('source changes during local compact measurement are rejected before storing or reserving its input', async t => {
  const f = await windowFixture(t, 5), state = await f.current(); let measured = false;
  const history = f.repository.history.bind(f.repository);
  f.repository.history = async (...args) => { const page = await history(...args); return measured ? { ...page,
    entries: page.entries.map(entry => entry.sourceId === 'source-0' ? { ...entry, text: 'changed after measurement' } : entry) } : page; };
  f.planner.estimateCompactInput = (input, options) => { measured = true; return {
    tokens: 100, bytes: Buffer.byteLength(JSON.stringify({ compact: input, options })), method: 'source_change_probe' }; };
  const calls = new SessionCompactCalls(f.services); let puts = 0;
  const put = f.services.artifacts.put.bind(f.services.artifacts); f.services.artifacts.put = async (...args) => { puts++; return put(...args); };
  await assert.rejects(calls.prepare(state, 'measure-only', { maxInputBytes: 65536, maxInputTokens: 100000, maxOutputTokens: 128 }, true), /model_session_changed/);
  assert.equal(puts, 0); assert.deepEqual(await f.current(), state); assert.equal(f.planner.inputs.length, 0);
});
