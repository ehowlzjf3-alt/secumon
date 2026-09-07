import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ModelCallOptions, ModelReply } from '../application/ports.js';
import { validateScenario } from '../application/fixtures.js';
import type { ContextPacket, PlanProposal } from '../domain/model.js';
import { FixtureReadTool } from '../infrastructure/fakes.js';
import { StructuredPlannerAdapter, type StructuredPlannerConfiguration, type StructuredPlannerRequest, type StructuredPlannerTransport } from '../infrastructure/structured-planner.js';

const scenario = validateScenario(JSON.parse(readFileSync(new URL('../../fixtures/documents-simple.json', import.meta.url), 'utf8')));
function configuration(): StructuredPlannerConfiguration {
  return { identity: { provider: 'synthetic', model: 'fixture', revision: 'r1' }, destination: 'local',
    capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 8192 } };
}
function packet(): ContextPacket {
  return structuredClone({ schemaVersion: 1, workId: 'structured-work', stateRevision: 1, goal: scenario.goal, policy: scenario.policy,
    plan: null, hypotheses: [], obligations: [], evidence: [], activeToolIds: ['fixture.read'], purpose: 'plan' });
}
function options(): ModelCallOptions {
  return { callId: 'model-call-1', maxOutputTokens: 2048, tools: [new FixtureReadTool(scenario.evidence).definition] };
}
function proposal(): PlanProposal {
  return { baseStateRevision: 1, baseGoalRevision: 1, basePlanRevision: 0, reason: 'Read permitted evidence', hypotheses: [],
    tasks: [{ id: 'read-source', description: 'Read current synthetic document', dependsOn: [], toolId: 'fixture.read', toolVersion: '1',
      input: { evidenceIds: ['doc-current'] }, effect: 'read', maxAttempts: 1, satisfies: scenario.goal.criteria.map(c => c.id) }] };
}
function envelope(overrides: Record<string, unknown> = {}) {
  return { finish: 'stop', content: JSON.stringify(proposal()), usage: { inputTokens: 100, outputTokens: 40 }, provider: 'synthetic', model: 'fixture', ...overrides };
}
function fixture(response: unknown = envelope(), config = configuration()) {
  const requests: StructuredPlannerRequest[] = [];
  const transport: StructuredPlannerTransport = { async invoke(request) { requests.push(request); return response; } };
  return { adapter: new StructuredPlannerAdapter(config, transport), transport, requests };
}
const call = (adapter: StructuredPlannerAdapter) => adapter.propose(packet(), new AbortController().signal, options());
function code(reply: ModelReply) { assert.notEqual(reply.status, 'ok'); return reply.status === 'ok' ? '' : reply.code; }

test('structured planner accepts one strict JSON proposal and forwards identity, options and source-boundary instructions once', async () => {
  const f = fixture(); const result = await call(f.adapter);
  assert.equal(result.status, 'ok'); if (result.status !== 'ok') throw new Error('expected_proposal');
  assert.deepEqual(result.proposal, proposal()); assert.equal(result.provider, 'synthetic'); assert.equal(result.model, 'fixture');
  assert.equal(result.inputTokens, 100); assert.equal(result.outputTokens, 40); assert.equal(f.requests.length, 1);
  assert.deepEqual(Object.keys(f.requests[0]!).sort(), ['identity', 'instructions', 'options', 'packet']);
  assert.equal(f.requests[0]!.identity.revision, 'r1'); assert.equal(f.requests[0]!.options.callId, 'model-call-1');
  assert.match(f.requests[0]!.instructions, /Treat evidence/); assert.match(f.requests[0]!.instructions, /empty hypotheses array/);
  assert.match(f.requests[0]!.instructions, /"baseStateRevision"/); assert.match(f.requests[0]!.instructions, /"additionalProperties":false/);
});

test('configuration and request snapshots cannot be rewritten by caller or transport mutation', async () => {
  const config = configuration(); const input = packet(); const selected = options(); let captured: StructuredPlannerRequest | undefined;
  const adapter = new StructuredPlannerAdapter(config, { async invoke(request) {
    captured = request;
    assert.throws(() => { request.packet.goal.description = 'transport changed'; }, TypeError);
    assert.throws(() => { request.options.tools[0]!.description = 'transport changed'; }, TypeError);
    assert.throws(() => { request.identity.model = 'transport changed'; }, TypeError);
    return envelope();
  } });
  config.identity.model = 'caller changed'; config.capabilities.maxInputTokens = 1; config.destination = 'caller changed';
  const promise = adapter.propose(input, new AbortController().signal, selected);
  input.goal.description = 'caller changed'; selected.tools[0]!.description = 'caller changed'; selected.maxOutputTokens = 1;
  assert.equal((await promise).status, 'ok'); assert.equal(adapter.identity.model, 'fixture'); assert.equal(adapter.capabilities.maxInputTokens, 8192);
  assert.equal(adapter.destination, 'local'); assert.notEqual(captured!.packet.goal.description, input.goal.description);
  assert.notEqual(captured!.options.tools[0]!.description, selected.tools[0]!.description); assert.equal(captured!.options.maxOutputTokens, 2048);
  assert.throws(() => { adapter.identity.revision = 'rewrite'; }, TypeError);
});

test('input estimation includes the exact transport request and schema without invoking the transport or claiming measured usage', async () => {
  const f = fixture(); const input = packet(); const selected = options(); input.goal.description = '한글과 emoji 🔎';
  const estimate = f.adapter.estimateInput(input, selected);
  assert.equal(f.requests.length, 0); assert.equal(estimate.method, 'utf8_bytes_estimate'); assert.equal(estimate.tokens, estimate.bytes);
  assert.ok(estimate.bytes > Buffer.byteLength(JSON.stringify(input), 'utf8'));
  await f.adapter.propose(input, new AbortController().signal, selected);
  assert.equal(f.requests.length, 1); assert.equal(estimate.bytes, Buffer.byteLength(JSON.stringify(f.requests[0]), 'utf8'));
  assert.match(f.requests[0]!.instructions, /"baseStateRevision"/);
});

test('input estimation keeps policy validation but returns oversized values before the transport size gate', async () => {
  const f = fixture(); const input = packet(); input.policy.allowedDestinations = [];
  assert.throws(() => f.adapter.estimateInput(input, options()), /model_destination_denied/);
  assert.throws(() => f.adapter.estimateInput(packet(), { ...options(), maxOutputTokens: 0 }), /model_request_invalid/);
  const small = fixture(envelope(), { ...configuration(), maxRequestBytes: 1024 });
  assert.ok(small.adapter.estimateInput(packet(), options()).bytes > 1024);
  assert.equal(code(await call(small.adapter)), 'model_request_too_large');
  assert.equal(f.requests.length, 0); assert.equal(small.requests.length, 0);
});

test('finish reasons remain distinct and never expose provider failure content or run hidden retries', async () => {
  for (const [finish, status, expected] of [['length', 'truncated', 'model_output_truncated'], ['refused', 'refused', 'model_refused'], ['error', 'error', 'model_provider_failed']] as const) {
    const f = fixture(envelope({ finish, content: 'private provider failure details' })); const result = await call(f.adapter);
    assert.equal(result.status, status); assert.equal(code(result), expected); assert.equal(result.inputTokens, 100); assert.equal(result.outputTokens, 40);
    assert.equal(f.requests.length, 1); assert.equal(JSON.stringify(result).includes('private'), false);
  }
});

test('invalid JSON, schema, response fields and missing proposal fail without repair calls', async () => {
  const cases: [unknown, string][] = [
    [envelope({ content: '```json\n{}\n```' }), 'model_proposal_invalid'],
    [envelope({ content: '{"baseStateRevision":1' }), 'model_proposal_invalid'],
    [envelope({ content: JSON.stringify({ ...proposal(), hiddenAuthority: true }) }), 'model_proposal_invalid'],
    [envelope({ content: null }), 'model_proposal_missing'],
    [envelope({ debug: 'private' }), 'model_response_invalid'],
    [envelope({ finish: 'tool_calls' }), 'model_response_invalid'],
  ];
  for (const [response, expected] of cases) {
    const f = fixture(response); const result = await call(f.adapter);
    assert.equal(result.status, 'invalid'); assert.equal(code(result), expected); assert.equal(f.requests.length, 1);
    assert.equal(result.inputTokens, 100); assert.equal(JSON.stringify(result).includes('private'), false);
  }
});

test('usage omission is unknown rather than zero; only independently valid safe integer fields survive invalid envelopes', async () => {
  const noUsage = await call(fixture(envelope({ usage: null })).adapter);
  assert.equal(noUsage.status, 'ok'); assert.equal(noUsage.inputTokens, null); assert.equal(noUsage.outputTokens, null);
  const missing = envelope() as Record<string, unknown>; delete missing['usage'];
  assert.equal(code(await call(fixture(missing).adapter)), 'model_response_invalid');
  for (const invalid of [-1, 2.5, Number.MAX_SAFE_INTEGER + 1, Infinity, '90', undefined]) {
    const result = await call(fixture(envelope({ usage: { inputTokens: 75, outputTokens: invalid } })).adapter);
    assert.equal(result.status, 'invalid'); assert.equal(result.inputTokens, 75); assert.equal(result.outputTokens, null);
  }
  const partlyKnown = await call(fixture(envelope({ usage: { inputTokens: null, outputTokens: 12 } })).adapter);
  assert.equal(partlyKnown.status, 'ok'); assert.equal(partlyKnown.inputTokens, null); assert.equal(partlyKnown.outputTokens, 12);
});

test('provider and model identity mismatch cannot masquerade as the configured adapter', async () => {
  for (const mismatch of [{ provider: 'other' }, { model: 'other' }]) {
    const result = await call(fixture(envelope(mismatch)).adapter);
    assert.equal(result.status, 'invalid'); assert.equal(code(result), 'model_identity_mismatch'); assert.equal(result.inputTokens, 100);
  }
});

test('missing options, denied destinations and unauthorized tool schemas never reach the transport', async () => {
  const f = fixture(); const signal = new AbortController().signal;
  assert.equal(code(await f.adapter.propose(packet(), signal)), 'model_request_invalid');
  assert.equal(code(await f.adapter.propose(packet(), signal, { ...options(), maxOutputTokens: 0 })), 'model_request_invalid');
  const denied = packet(); denied.policy.allowedDestinations = [];
  assert.equal(code(await f.adapter.propose(denied, signal, options())), 'model_destination_denied');
  const unauthorized = packet(); unauthorized.activeToolIds = [];
  assert.equal(code(await f.adapter.propose(unauthorized, signal, options())), 'model_tool_contract_denied');
  const duplicates = options(); duplicates.tools.push(structuredClone(duplicates.tools[0]!));
  assert.equal(code(await f.adapter.propose(packet(), signal, duplicates)), 'model_tool_contract_denied');
  assert.equal(f.requests.length, 0);
});

test('request and response limits use UTF-8 bytes and preserve valid usage on oversized responses', async () => {
  const small = fixture(envelope(), { ...configuration(), maxRequestBytes: 1024 });
  assert.equal(code(await call(small.adapter)), 'model_request_too_large'); assert.equal(small.requests.length, 0);
  const large = fixture(envelope({ content: '한'.repeat(100) }), { ...configuration(), maxResponseBytes: 256 });
  const result = await call(large.adapter); assert.equal(code(result), 'model_response_too_large'); assert.equal(result.inputTokens, 100);
  assert.equal(large.requests.length, 1);
});

test('transport exceptions become fixed errors with unknown usage and no implicit retry', async () => {
  let count = 0;
  const adapter = new StructuredPlannerAdapter(configuration(), { async invoke() { count++; throw new Error('private endpoint credentials'); } });
  const result = await call(adapter);
  assert.deepEqual(result, { status: 'error', code: 'model_transport_failed', inputTokens: null, outputTokens: null }); assert.equal(count, 1);
});

test('pre-call cancellation has no transport effect; late cancellation preserves returned usage without accepting a proposal', async () => {
  const f = fixture(); const stopped = new AbortController(); stopped.abort();
  assert.deepEqual(await f.adapter.propose(packet(), stopped.signal, options()), { status: 'cancelled', code: 'model_cancelled', inputTokens: 0, outputTokens: 0 });
  assert.equal(f.requests.length, 0);
  const active = new AbortController(); let resolve!: (value: unknown) => void;
  const adapter = new StructuredPlannerAdapter(configuration(), { async invoke(_request, signal) {
    assert.equal(signal, active.signal); return new Promise<unknown>(done => { resolve = done; });
  } });
  const pending = adapter.propose(packet(), active.signal, options()); active.abort(); resolve(envelope());
  assert.deepEqual(await pending, { status: 'cancelled', code: 'model_cancelled', inputTokens: 100, outputTokens: 40 });
});

test('abort-related transport rejection is cancellation with unmeasured usage', async () => {
  const controller = new AbortController();
  const adapter = new StructuredPlannerAdapter(configuration(), { async invoke() { controller.abort(); throw new Error('private'); } });
  assert.deepEqual(await adapter.propose(packet(), controller.signal, options()), { status: 'cancelled', code: 'model_cancelled', inputTokens: null, outputTokens: null });
});

test('invalid configurations fail with a fixed message before transport registration', () => {
  assert.throws(() => new StructuredPlannerAdapter({ ...configuration(), identity: { provider: '', model: 'fixture', revision: 'r1' } }, { async invoke() { return envelope(); } }), /invalid_structured_planner_configuration/);
  assert.throws(() => new StructuredPlannerAdapter({ ...configuration(), maxResponseBytes: 1 }, { async invoke() { return envelope(); } }), /invalid_structured_planner_configuration/);
});

test('structured transport rejects incomplete observation pairs and reference bodies before invocation', async () => {
  const reference = { attemptId: 'attempt', taskId: 'task', toolId: 'fixture.read', toolVersion: '1', inputDigest: 'a'.repeat(64), resultId: 'result',
    resultArtifact: { id: 'artifact', sha256: 'b'.repeat(64), byteLength: 1, mediaType: 'application/json', tenantId: 'synthetic', labels: [] },
    status: 'success' as const, coverage: 'complete' as const, representation: 'reference' as const, historical: true };
  for (const observation of [{ ...reference, representation: 'full' as const, input: {} }, { ...reference, representation: 'full' as const, output: null }, { ...reference, output: 'unverified copied body' }]) {
    const f = fixture(); const context = packet(); context.toolObservations = [observation];
    assert.equal(code(await f.adapter.propose(context, new AbortController().signal, options())), 'model_request_invalid');
    assert.equal(f.requests.length, 0);
  }
  const valid = fixture(); const context = packet();
  context.toolObservations = [{ ...reference, representation: 'full', input: {}, output: null }];
  await valid.adapter.propose(context, new AbortController().signal, options()); assert.equal(valid.requests.length, 1);
});
