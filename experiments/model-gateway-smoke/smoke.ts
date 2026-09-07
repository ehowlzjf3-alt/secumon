import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { ChatGateway, GatewayError, loadOpenAIKey, syntheticLookup, verifyAnswer } from './gateway.ts';
import type { Completion, Message } from './gateway.ts';

const cases: Record<string, unknown>[] = [];
const keyFromStdin = process.argv.includes('--key-stdin');
let gateway: ChatGateway | undefined;
let failure: { code: string; status?: number } | undefined;
function saveCase(name: string, result: Completion, passed: boolean) {
  cases.push({ name, passed, modelReturned: result.model, latencyMs: result.latencyMs, usage: result.usage });
  if (!passed) throw new GatewayError('semantic_assertion_failed');
}

try {
  if (keyFromStdin) {
    const input = createInterface({ input: process.stdin, terminal: false });
    let key: string;
    try {
      const [line] = await once(input, 'line', { signal: AbortSignal.timeout(60_000) });
      key = String(line).trim();
    } finally { input.close(); process.stdin.pause(); }
    if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(key)) throw new GatewayError('credential_format_invalid');
    gateway = new ChatGateway(key);
    key = '';
  } else {
    let settings: { credentialFile: string };
    try { settings = JSON.parse(readFileSync(new URL('local.settings.json', import.meta.url), 'utf8')); }
    catch { throw new GatewayError('local_settings_missing'); }
    gateway = new ChatGateway(loadOpenAIKey(settings.credentialFile));
  }
  const plain = await gateway.complete({ messages: [{ role: 'user', content: 'Reply with exactly READY and nothing else.' }] });
  saveCase('plain_text', plain, plain.message.content?.trim() === 'READY');

  const messages: Message[] = [
    { role: 'system', content: 'This is a synthetic compatibility test. Obtain a value from lookup_fixture and cite its evidence_id. Do not invent a value.' },
    { role: 'user', content: 'Look up evidence SYN-001. Return its value as answer and its evidence_id.' },
  ];
  const tool = {
    type: 'function', function: {
      name: 'lookup_fixture', description: 'Read one synthetic fixture by evidence identifier.', strict: true,
      parameters: { type: 'object', properties: { evidence_id: { type: 'string' } }, required: ['evidence_id'], additionalProperties: false },
    },
  };
  const selected = await gateway.complete({ messages, tools: [tool], tool_choice: { type: 'function', function: { name: 'lookup_fixture' } }, parallel_tool_calls: false });
  const calls = selected.message.tool_calls ?? [];
  if (calls.length !== 1) throw new GatewayError('expected_one_tool_call');
  const evidence = syntheticLookup(calls[0]);
  saveCase('forced_tool_call_and_validated_arguments', selected, true);

  const answer = await gateway.complete({
    messages: [...messages, selected.message, { role: 'tool', tool_call_id: calls[0].id, content: JSON.stringify(evidence) }],
    response_format: { type: 'json_schema', json_schema: { name: 'fixture_answer', strict: true, schema: {
      type: 'object', properties: { answer: { type: 'integer' }, evidence_id: { type: 'string' } }, required: ['answer', 'evidence_id'], additionalProperties: false,
    } } },
  });
  saveCase('tool_result_to_structured_answer', answer, verifyAnswer(answer.message.content));
} catch (error) {
  failure = error instanceof GatewayError ? { code: error.code, ...(error.status ? { status: error.status } : {}) } : { code: 'local_setup_error' };
}

const report = {
  createdAt: new Date().toISOString(), nodeVersion: process.version, modelRequested: 'gpt-4o-mini',
  endpoint: 'https://api.openai.com/v1/chat/completions', data: 'synthetic_only',
  credentialSource: keyFromStdin ? 'ephemeral_stdin' : 'referenced_env_file',
  limits: { maximumRequests: 3, maximumOutputTokensPerRequest: 256, timeoutMsPerRequest: 20000, retries: 0 },
  attemptedRequests: gateway?.attempts ?? 0, passed: !failure && cases.length === 3, cases, ...(failure ? { failure } : {}),
  notTested: ['internal_open_source_model', 'automatic_tool_selection', 'long_horizon_core', 'streaming', 'context_compaction', 'resume', 'internal_MCP'],
};
writeFileSync(new URL(keyFromStdin ? 'supplied-key-result.json' : 'smoke-result.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
