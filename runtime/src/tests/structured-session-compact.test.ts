import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelCallOptions, SessionCompactReply } from '../application/ports.js';
import type { SessionCompactCandidate, SessionCompactInput } from '../domain/session-compact.js';
import { PlanningRuntime } from '../application/planning-runtime.js';
import { FixtureReadTool } from '../infrastructure/fakes.js';
import { sha256 } from '../infrastructure/digest.js';
import { StructuredSessionCompactAdapter, STRUCTURED_SESSION_COMPACT_TEMPLATE_REVISION,
  type StructuredSessionCompactConfiguration, type StructuredSessionCompactRequest,
  type StructuredSessionCompactTransport } from '../infrastructure/structured-session-compact.js';
import { windowFixture } from './session-window-helpers.js';

const hash = 'a'.repeat(64);
function configuration(): StructuredSessionCompactConfiguration {
  return { identity: { provider: 'synthetic', model: 'window-fixture', revision: '1' }, destination: 'local',
    capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 100000 } };
}
function input(): SessionCompactInput {
  return { schemaVersion: 1, purpose: 'session_compact', workId: 'compact-work',
    basis: { scope: { tenantId: 'tenant', agentId: 'agent', principalId: 'person', sessionId: 'session' },
      input: { messageId: 'current', sequence: 3, digest: hash } },
    policyDigest: hash, inputDigest: hash, expectedHead: null, previous: null,
    prefix: { throughSequence: 1, digest: hash, entries: 1 },
    entries: [{ sequence: 1, sourceId: 'original', workId: 'earlier-work', role: 'user', kind: 'work', status: 'received',
      artifact: null, labels: ['synthetic'], text: 'Keep this constraint. 한글 🔎\n' + 'Source context. '.repeat(60) }],
    maxSummaryBytes: 4096, interpretation: 'conversation_history_not_verified_evidence' };
}
function options(): ModelCallOptions { return { callId: 'compact-call', maxOutputTokens: 128, tools: [] }; }
function candidate(value: SessionCompactInput): SessionCompactCandidate {
  const source = value.entries.find(entry => entry.role === 'user'); assert.ok(source);
  const quote = source.text.split('\n')[0]!;
  return { inputDigest: value.inputDigest, content: { narrative: 'Retain the cited constraint.',
    retained: [...structuredClone(value.previous?.content.retained ?? []), { id: `retained-${source.sequence}`, kind: 'constraint',
      text: quote, status: 'active', citations: [{ sequence: source.sequence, sourceId: source.sourceId, role: source.role, quote }] }] } };
}
function envelope(value = input(), overrides: Record<string, unknown> = {}) {
  return { finish: 'stop', content: JSON.stringify(candidate(value)), usage: { inputTokens: 19, outputTokens: 7 },
    provider: 'synthetic', model: 'window-fixture', ...overrides };
}
function fixture(response: unknown = envelope(), config = configuration()) {
  const requests: StructuredSessionCompactRequest[] = [];
  const transport: StructuredSessionCompactTransport = { async invoke(request) { requests.push(request); return response; } };
  return { adapter: new StructuredSessionCompactAdapter(config, transport), requests, transport };
}
const invoke = (adapter: StructuredSessionCompactAdapter) => adapter.compact(input(), new AbortController().signal, options());
function code(reply: SessionCompactReply) { assert.notEqual(reply.status, 'ok'); return reply.status === 'ok' ? '' : reply.code; }

test('compact estimation and invocation use the same frozen source, previous summary, instructions and candidate schema', async () => {
  const measured: { request: unknown; serialized: string }[] = [], sent: StructuredSessionCompactRequest[] = [];
  const config = configuration(), estimatorProfile = { id: 'local-counter', revision: 'r1', templateRevision: 'counter-v1', kind: 'conservative_estimate' as const };
  const estimator = { profile: estimatorProfile, estimate(request: unknown, serialized: string) {
    measured.push({ request, serialized }); return { tokens: Math.ceil(serialized.length / 2), bytes: Buffer.byteLength(serialized), method: 'local-synthetic-counter' };
  } };
  config.inputEstimator = estimator;
  const adapter = new StructuredSessionCompactAdapter(config, { async invoke(request) {
    sent.push(request); assert.equal(Object.isFrozen(request), true);
    assert.throws(() => { request.compact.entries[0]!.text = 'mutated'; }, TypeError);
    assert.throws(() => { request.options.tools.push(new FixtureReadTool([]).definition); }, TypeError);
    return envelope(request.compact);
  } });
  const value = input(), selected = options();
  value.previous = { ref: { id: 'prior-summary', revision: 1, throughSequence: 1, digest: hash, policyDigest: hash },
    content: { narrative: 'Earlier constraint remains open.', retained: [] } };
  value.expectedHead = value.previous.ref; value.entries[0]!.sequence = 2; value.prefix.throughSequence = 2;
  const estimate = adapter.estimateCompactInput(value, selected); assert.equal(sent.length, 0);
  const pending = adapter.compact(value, new AbortController().signal, selected);
  value.entries[0]!.text = 'caller changed'; selected.maxOutputTokens = 1; config.identity.model = 'changed';
  const result = await pending;
  assert.equal(result.status, 'ok'); if (result.status !== 'ok') assert.fail('expected candidate');
  assert.deepEqual(result.candidate, candidate(sent[0]!.compact)); assert.equal(result.inputTokens, 19); assert.equal(result.outputTokens, 7);
  assert.equal(sent.length, 1); assert.equal(measured.length, 1); assert.equal(measured[0]!.serialized, JSON.stringify(sent[0]));
  assert.deepEqual(measured[0]!.request, sent[0]); assert.equal(estimate.bytes, Buffer.byteLength(JSON.stringify(sent[0])));
  assert.ok(estimate.tokens !== estimate.bytes); assert.deepEqual(Object.keys(sent[0]!).sort(), ['compact', 'identity', 'instructions', 'options']);
  assert.match(sent[0]!.instructions, /unresolved hypotheses, counterarguments/); assert.match(sent[0]!.instructions, /"changedBy"/);
  assert.match(sent[0]!.instructions, /"additionalProperties":false/); assert.match(measured[0]!.serialized, /Earlier constraint remains open/);
  assert.match(measured[0]!.serialized, /한글/); assert.equal(sent[0]!.options.maxOutputTokens, 128); assert.equal(adapter.identity.model, 'window-fixture');
  assert.equal(adapter.inputEstimation.templateRevision, `${STRUCTURED_SESSION_COMPACT_TEMPLATE_REVISION}:${sha256(JSON.stringify({
    instructions: sent[0]!.instructions, estimatorTemplateRevision: estimatorProfile.templateRevision,
  }))}`);
  const changed = new StructuredSessionCompactAdapter({ ...configuration(), inputEstimator: { ...estimator,
    profile: { ...estimatorProfile, templateRevision: 'counter-v2' } } }, { async invoke() { throw new Error('unused'); } });
  assert.notEqual(changed.inputEstimation.templateRevision, adapter.inputEstimation.templateRevision);
});

test('fallback estimation is local and oversized estimates remain numeric while exact transport byte caps are inclusive', async () => {
  const f = fixture(), bytes = f.adapter.estimateCompactInput(input(), options()).bytes;
  assert.equal(f.requests.length, 0); assert.equal(f.adapter.estimateCompactInput(input(), options()).tokens, bytes);
  assert.equal(f.adapter.estimateCompactInput(input(), options()).method, 'utf8_bytes_estimate');
  const exact = fixture(envelope(), { ...configuration(), maxRequestBytes: bytes });
  assert.equal((await invoke(exact.adapter)).status, 'ok'); assert.equal(exact.requests.length, 1);
  const small = fixture(envelope(), { ...configuration(), maxRequestBytes: bytes + 1,
    capabilities: { ...configuration().capabilities, maxInputBytes: bytes - 1 } });
  assert.equal(small.adapter.estimateCompactInput(input(), options()).bytes, bytes);
  const rejected = await invoke(small.adapter); assert.equal(code(rejected), 'model_request_too_large');
  assert.equal(rejected.inputTokens, 0); assert.equal(rejected.outputTokens, 0); assert.equal(small.requests.length, 0);
});

test('invalid compact inputs and nonempty tool options are rejected before estimating or invoking a provider', async () => {
  let estimates = 0, calls = 0;
  const adapter = new StructuredSessionCompactAdapter({ ...configuration(), inputEstimator: {
    profile: { id: 'strict', revision: '1', templateRevision: '1', kind: 'conservative_estimate' },
    estimate(_request, serialized) { estimates++; return { tokens: 100, bytes: Buffer.byteLength(serialized), method: 'strict' }; },
  } }, { async invoke() { calls++; return envelope(); } });
  const toolOptions = { ...options(), tools: [new FixtureReadTool([]).definition] };
  assert.throws(() => adapter.estimateCompactInput(input(), toolOptions), /model_tool_contract_denied/);
  assert.equal(code(await adapter.compact(input(), new AbortController().signal, toolOptions)), 'model_tool_contract_denied');
  const malformed = { ...input(), policy: { allow: true } } as SessionCompactInput;
  assert.throws(() => adapter.estimateCompactInput(malformed, options()), /model_request_invalid/);
  assert.equal(code(await adapter.compact(malformed, new AbortController().signal, options())), 'model_request_invalid');
  assert.equal(code(await adapter.compact(input(), new AbortController().signal, { ...options(), maxOutputTokens: 0 })), 'model_request_invalid');
  assert.equal(estimates, 0); assert.equal(calls, 0);
});

test('invalid registered compact estimates preserve their failure instead of selecting a fallback or calling transport', () => {
  const injected = new Error('local-counter-failed'); let calls = 0;
  for (const failure of ['bytes', 'tokens', 'throw'] as const) {
    const adapter = new StructuredSessionCompactAdapter({ ...configuration(), inputEstimator: {
      profile: { id: 'bad', revision: '1', templateRevision: '1', kind: 'conservative_estimate' },
      estimate(_request, serialized) { if (failure === 'throw') throw injected;
        return { tokens: failure === 'tokens' ? Number.NaN : 100, bytes: failure === 'bytes' ? 1 : Buffer.byteLength(serialized), method: 'bad' }; },
    } }, { async invoke() { calls++; return envelope(); } });
    assert.throws(() => adapter.estimateCompactInput(input(), options()), (error: unknown) => error instanceof Error &&
      error.message === 'model_input_estimate_invalid' && (failure !== 'throw' || error.cause === injected));
  }
  assert.equal(calls, 0);
});

test('finish reasons and model identity failures never publish a partial candidate or trigger a repair call', async () => {
  for (const [override, status, expected] of [
    [{ finish: 'length' }, 'truncated', 'model_output_truncated'], [{ finish: 'refused' }, 'refused', 'model_refused'],
    [{ finish: 'error' }, 'error', 'model_provider_failed'], [{ provider: 'other' }, 'invalid', 'model_identity_mismatch'],
    [{ model: 'other' }, 'invalid', 'model_identity_mismatch'],
  ] as const) {
    const f = fixture(envelope(input(), override)), reply = await invoke(f.adapter);
    assert.equal(reply.status, status); assert.equal(code(reply), expected); assert.equal('candidate' in reply, false);
    assert.equal(reply.inputTokens, 19); assert.equal(reply.outputTokens, 7); assert.equal(f.requests.length, 1);
  }
});

test('missing, incomplete or invalid candidate JSON and oversized responses retain known usage without synthetic repairs', async () => {
  for (const [response, expected] of [
    [envelope(input(), { content: null }), 'model_compact_missing'],
    [envelope(input(), { content: '{"inputDigest":' }), 'model_compact_invalid'],
    [envelope(input(), { content: '```json\n{}\n```' }), 'model_compact_invalid'],
    [envelope(input(), { content: JSON.stringify({ ...candidate(input()), summaryId: 'model-owned' }) }), 'model_compact_invalid'],
    [envelope(input(), { finish: 'tool_calls' }), 'model_response_invalid'],
  ] as const) {
    const f = fixture(response), reply = await invoke(f.adapter);
    assert.equal(code(reply), expected); assert.equal(reply.inputTokens, 19); assert.equal(f.requests.length, 1);
  }
  const response = envelope(), bytes = Buffer.byteLength(JSON.stringify(response));
  assert.equal((await invoke(fixture(response, { ...configuration(), maxResponseBytes: bytes }).adapter)).status, 'ok');
  const small = fixture(response, { ...configuration(), maxResponseBytes: bytes - 1 });
  const reply = await invoke(small.adapter); assert.equal(code(reply), 'model_response_too_large');
  assert.equal(reply.inputTokens, 19); assert.equal(reply.outputTokens, 7); assert.equal(small.requests.length, 1);
});

test('usage null, missing and partly invalid values stay unknown independently rather than becoming zero', async () => {
  const missing = envelope() as Record<string, unknown>; delete missing['usage'];
  const omitted = await invoke(fixture(missing).adapter); assert.equal(code(omitted), 'model_response_invalid');
  assert.equal(omitted.inputTokens, null); assert.equal(omitted.outputTokens, null);
  const unknown = await invoke(fixture(envelope(input(), { usage: null })).adapter);
  assert.equal(unknown.status, 'ok'); assert.equal(unknown.inputTokens, null); assert.equal(unknown.outputTokens, null);
  const partial = await invoke(fixture(envelope(input(), { usage: { inputTokens: null, outputTokens: 7 } })).adapter);
  assert.equal(partial.status, 'ok'); assert.equal(partial.inputTokens, null); assert.equal(partial.outputTokens, 7);
  for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '7', undefined]) {
    const reply = await invoke(fixture(envelope(input(), { usage: { inputTokens: 19, outputTokens: invalid } })).adapter);
    assert.equal(code(reply), 'model_response_invalid'); assert.equal(reply.inputTokens, 19); assert.equal(reply.outputTokens, null);
  }
});

test('cancellation distinguishes unsent input from returned usage and transport uncertainty without retries', async () => {
  const before = new AbortController(); before.abort(); const f = fixture();
  const unsent = await f.adapter.compact(input(), before.signal, options());
  assert.equal(unsent.status, 'cancelled'); assert.equal(unsent.inputTokens, 0); assert.equal(f.requests.length, 0);
  const late = new AbortController(); let calls = 0;
  const received = new StructuredSessionCompactAdapter(configuration(), { async invoke() { calls++; late.abort(); return envelope(); } });
  const cancelled = await received.compact(input(), late.signal, options());
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.inputTokens, 19); assert.equal(cancelled.outputTokens, 7);
  const failed = new StructuredSessionCompactAdapter(configuration(), { async invoke() { calls++; throw new Error('transport-lost'); } });
  const unknown = await invoke(failed); assert.equal(code(unknown), 'model_transport_failed');
  assert.equal(unknown.inputTokens, null); assert.equal(unknown.outputTokens, null); assert.equal(calls, 2);
});

function attach(f: Awaited<ReturnType<typeof windowFixture>>, transport: StructuredSessionCompactTransport) {
  const adapter = new StructuredSessionCompactAdapter(configuration(), transport);
  f.services.planner = { ...f.planner, identity: adapter.identity, destination: adapter.destination, capabilities: adapter.capabilities,
    inputEstimation: adapter.inputEstimation, compact: adapter.compact.bind(adapter), estimateCompactInput: adapter.estimateCompactInput.bind(adapter) };
  return adapter;
}

test('a stored structured compact reply resumes through the existing summary receipt and usage ledger once', async t => {
  const f = await windowFixture(t, 5), history = await f.history(); let calls = 0;
  attach(f, { async invoke(request) { calls++; return envelope(request.compact); } });
  const planning = f.compactPlanning!, call = await planning.requestCompact(f.workId, { force: true, requestId: 'structured-once' }); assert.ok(call);
  await planning.execute(f.workId, call.id); assert.equal((await f.current()).modelCalls[0]!.status, 'received');
  assert.equal(await f.repository.summaryHead(f.session.scope), null);
  const resumed = new PlanningRuntime(f.services, planning.tools, f.runtime, 'resumed', planning.config);
  assert.equal(await resumed.adopt(f.workId, call.id), true); assert.equal(await resumed.adopt(f.workId, call.id), true);
  const state = await f.current(); assert.equal(state.modelCalls[0]!.status, 'accepted');
  assert.equal(state.budget.used.modelCalls, 1); assert.equal(state.budget.used.tokens, 26); assert.equal(state.budget.reservedTokens, 0);
  assert.equal(calls, 1); assert.deepEqual(await f.history(), history);
  const publication = await f.repository.publication(f.session.scope, call.id); assert.ok(publication);
  const context = await f.sessions.context(state); assert.equal(context?.schemaVersion, 2);
  if (context?.schemaVersion !== 2) assert.fail('expected accepted summary');
  assert.deepEqual(context.summary.ref, publication.ref); assert.equal(context.entries.at(-1)!.sourceId, state.conversation!.session!.input.messageId);
  assert.equal((await resumed.requestCompact(f.workId, { force: true, requestId: 'structured-once' }))!.id, call.id); assert.equal(calls, 1);
});

test('schema-valid compact candidates still undergo existing digest, source citation and summary-size checks', async t => {
  for (const failure of ['digest', 'citation', 'size'] as const) {
    const f = await windowFixture(t, 5); let calls = 0;
    attach(f, { async invoke(request) {
      calls++; const value = candidate(request.compact);
      if (failure === 'digest') value.inputDigest = 'f'.repeat(64);
      if (failure === 'citation') value.content.retained[0]!.citations[0]!.quote = 'This quote was never in the source.';
      if (failure === 'size') value.content.narrative = 'x'.repeat(request.compact.maxSummaryBytes + 1);
      return envelope(request.compact, { content: JSON.stringify(value) });
    } });
    const call = await f.compactPlanning!.requestCompact(f.workId, { force: true }); assert.ok(call);
    await f.compactPlanning!.execute(f.workId, call.id); assert.equal(await f.compactPlanning!.adopt(f.workId, call.id), false);
    const state = await f.current(); assert.equal(state.modelCalls[0]!.status, 'rejected'); assert.equal(calls, 1);
    assert.equal(await f.repository.summaryHead(f.session.scope), null); assert.equal(state.budget.used.tokens, 26);
    assert.equal(state.budget.reservedTokens, 0);
  }
});

test('structured compact transport loss preserves the unknown-usage reservation and blocks another unaccounted call', async t => {
  const f = await windowFixture(t, 5); let calls = 0;
  attach(f, { async invoke() { calls++; throw new Error('lost-after-send'); } });
  const call = await f.compactPlanning!.requestCompact(f.workId, { force: true }); assert.ok(call);
  await f.compactPlanning!.execute(f.workId, call.id); assert.equal(await f.compactPlanning!.adopt(f.workId, call.id), false);
  const state = await f.current(); assert.equal(state.modelCalls[0]!.usageStatus, 'unknown');
  assert.equal(state.budget.used.unmeasuredModelCalls, 1); assert.equal(state.budget.reservedTokens, call.tokenReservation);
  await assert.rejects(f.compactPlanning!.requestCompact(f.workId, { force: true, requestId: 'do-not-repeat' }), /model_usage_unknown/);
  assert.equal(calls, 1); assert.equal(await f.repository.summaryHead(f.session.scope), null);
});
