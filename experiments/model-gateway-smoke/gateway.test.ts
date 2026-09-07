import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatGateway, GatewayError, decodeCompletion, loadOpenAIKey, syntheticLookup, verifyAnswer } from './gateway.ts';

const raw = () => ({ model: 'fixture-model', choices: [{ message: { role: 'assistant', content: 'READY' }, finish_reason: 'stop' }] });
const request = { messages: [{ role: 'user' as const, content: 'synthetic' }] };
const fakeKey = 'sk-synthetic-not-a-real-key-for-tests';
const hasCode = (code: string) => (e: unknown) => e instanceof GatewayError && e.code === code;

test('hard request/output budget, pinned origin, redirect block and no stored completions', async () => {
  let count = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    count++;
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'gpt-4o-mini');
    assert.equal(body.max_completion_tokens, 256);
    assert.equal(body.store, false);
    assert.equal(body.n, 1);
    return Response.json(raw());
  };
  const g = new ChatGateway(fakeKey, { fetchImpl });
  for (let i = 0; i < 3; i++) await g.complete(request);
  await assert.rejects(g.complete(request), hasCode('request_budget_exceeded'));
  assert.equal(count, 3);
});

test('HTTP errors do not log provider body or retry', async () => {
  let count = 0;
  const g = new ChatGateway(fakeKey, { fetchImpl: async () => { count++; return new Response(fakeKey, { status: 401 }); } });
  await assert.rejects(g.complete(request), (e: unknown) => {
    assert.ok(e instanceof GatewayError);
    assert.equal(e.code, 'http_error'); assert.equal(e.status, 401);
    assert.ok(!String(e).includes(fakeKey)); return true;
  });
  assert.equal(count, 1);
});

test('transport error cannot propagate secret text', async () => {
  const g = new ChatGateway(fakeKey, { fetchImpl: async () => { throw new Error(fakeKey); } });
  await assert.rejects(g.complete(request), hasCode('transport_error'));
});

test('deadline aborts the request without retry', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const g = new ChatGateway(fakeKey, { timeoutMs: 10, fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }) });
    await assert.rejects(g.complete(request), hasCode('request_timeout'));
    assert.equal(g.attempts, 1);
  } finally { clearTimeout(keepAlive); }
});

test('truncated, refused and malformed output cannot be accepted', () => {
  const truncated = raw(); truncated.choices[0].finish_reason = 'length';
  assert.throws(() => decodeCompletion(truncated, 0), hasCode('incomplete_response'));
  const refused = raw(); Object.assign(refused.choices[0].message, { refusal: 'synthetic' });
  assert.throws(() => decodeCompletion(refused, 0), hasCode('model_refusal'));
  assert.throws(() => decodeCompletion({}, 0), hasCode('invalid_response'));
  assert.deepEqual(decodeCompletion(raw(), 0).usage, { input: null, output: null, total: null });
});

test('tool dispatcher rejects unknown names, extra arguments and unrecognized evidence', () => {
  const call = { id: 'synthetic-call', type: 'function' as const, function: { name: 'lookup_fixture', arguments: '{"evidence_id":"SYN-001"}' } };
  assert.deepEqual(syntheticLookup(call), { evidence_id: 'SYN-001', value: 7 });
  assert.throws(() => syntheticLookup({ ...call, function: { ...call.function, name: 'unknown_tool' } }), hasCode('tool_not_allowed'));
  for (const args of ['{', '{"evidence_id":"unknown"}', '{"evidence_id":"SYN-001","extra":1}']) {
    assert.throws(() => syntheticLookup({ ...call, function: { ...call.function, arguments: args } }), hasCode('tool_arguments_invalid'));
  }
  assert.equal(verifyAnswer('{"answer":7,"evidence_id":"SYN-001"}'), true);
  assert.equal(verifyAnswer('{"answer":8,"evidence_id":"SYN-001"}'), false);
  assert.equal(verifyAnswer('{"answer":7,"evidence_id":"SYN-002"}'), false);
});

test('duplicate tool IDs and missing calls are rejected', () => {
  const call = { id: 'same', type: 'function', function: { name: 'lookup_fixture', arguments: '{}' } };
  const response = { model: 'fixture', choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [call, call] } }] };
  assert.throws(() => decodeCompletion(response, 0), hasCode('duplicate_tool_call_id'));
  response.choices[0].message.tool_calls = [];
  assert.throws(() => decodeCompletion(response, 0), hasCode('invalid_tool_calls'));
});

test('credential parser verifies provider and never evaluates shell expressions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'model-smoke-'));
  const file = join(directory, '.env');
  try {
    writeFileSync(file, `OPENAI_BASE_URL=https://internal.invalid/v1\nOPENAI_API_KEY=${fakeKey}\n`, { mode: 0o600 });
    assert.throws(() => loadOpenAIKey(file), hasCode('credential_provider_mismatch'));
    writeFileSync(file, `OPENAI_BASE_URL=https://api.openai.com/v1\nOPENAI_API_KEY=${fakeKey}\n`);
    assert.equal(loadOpenAIKey(file), fakeKey);
    writeFileSync(file, 'OPENAI_BASE_URL=https://api.openai.com/v1\nOPENAI_API_KEY=$(echo unevaluated)\n');
    assert.throws(() => loadOpenAIKey(file), hasCode('credential_format_invalid'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
