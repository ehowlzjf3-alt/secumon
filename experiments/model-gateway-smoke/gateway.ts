import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

export class GatewayError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, status?: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function loadOpenAIKey(file: string): string {
  let env: Record<string, string | undefined>;
  try { env = parseEnv(readFileSync(file, 'utf8')); }
  catch { throw new GatewayError('credential_file_unreadable'); }
  let url: URL;
  try { url = new URL(env.OPENAI_BASE_URL ?? env.OPENAI_API_BASE ?? ''); }
  catch { throw new GatewayError('credential_provider_unverified'); }
  if (url.origin !== 'https://api.openai.com' || url.username || url.password || url.search || url.hash) {
    throw new GatewayError('credential_provider_mismatch');
  }
  const key = env.OPENAI_API_KEY?.trim();
  if (!key || !/^sk-[A-Za-z0-9_-]{20,}$/.test(key)) throw new GatewayError('credential_format_invalid');
  return key;
}

export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type Message = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};
export type ChatRequest = {
  messages: Message[];
  tools?: Record<string, unknown>[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  response_format?: unknown;
};
export type Completion = {
  message: Message;
  finishReason: 'stop' | 'tool_calls';
  model: string;
  usage: { input: number | null; output: number | null; total: number | null };
  latencyMs: number;
};

function record(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function tokenCount(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

export function decodeCompletion(raw: unknown, latencyMs: number): Completion {
  if (!record(raw) || typeof raw.model !== 'string' || !Array.isArray(raw.choices) || raw.choices.length !== 1) {
    throw new GatewayError('invalid_response');
  }
  const choice = raw.choices[0];
  if (!record(choice) || !record(choice.message)) throw new GatewayError('invalid_response');
  if (choice.finish_reason !== 'stop' && choice.finish_reason !== 'tool_calls') throw new GatewayError('incomplete_response');
  const m = choice.message;
  if (m.refusal) throw new GatewayError('model_refusal');
  if (m.role !== 'assistant' || !(m.content === null || typeof m.content === 'string')) throw new GatewayError('invalid_response');
  let calls: ToolCall[] | undefined;
  if (m.tool_calls !== undefined) {
    if (!Array.isArray(m.tool_calls) || m.tool_calls.length === 0) throw new GatewayError('invalid_tool_calls');
    calls = m.tool_calls.map((t: unknown) => {
      if (!record(t) || t.type !== 'function' || typeof t.id !== 'string' || !t.id || !record(t.function) ||
          typeof t.function.name !== 'string' || typeof t.function.arguments !== 'string') {
        throw new GatewayError('invalid_tool_calls');
      }
      return { id: t.id, type: 'function', function: { name: t.function.name, arguments: t.function.arguments } };
    });
    if (new Set(calls.map(t => t.id)).size !== calls.length) throw new GatewayError('duplicate_tool_call_id');
  }
  if ((choice.finish_reason === 'tool_calls') !== Boolean(calls)) throw new GatewayError('invalid_tool_calls');
  const usage = record(raw.usage) ? raw.usage : {};
  return {
    message: { role: 'assistant', content: m.content, ...(calls ? { tool_calls: calls } : {}) },
    finishReason: choice.finish_reason, model: raw.model,
    usage: { input: tokenCount(usage.prompt_tokens), output: tokenCount(usage.completion_tokens), total: tokenCount(usage.total_tokens) },
    latencyMs,
  };
}

export class ChatGateway {
  #key: string;
  #fetch: typeof fetch;
  #attempts = 0;
  #timeoutMs: number;
  #model: string;
  constructor(key: string, options: { fetchImpl?: typeof fetch; timeoutMs?: number; model?: string } = {}) {
    this.#key = key;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#model = options.model ?? 'gpt-4o-mini';
  }
  get attempts() { return this.#attempts; }
  async complete(request: ChatRequest): Promise<Completion> {
    if (this.#attempts >= 3) throw new GatewayError('request_budget_exceeded');
    this.#attempts++;
    const started = performance.now();
    const signal = AbortSignal.timeout(this.#timeoutMs);
    try {
      const response = await this.#fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.#key}` },
        body: JSON.stringify({ ...request, model: this.#model, max_completion_tokens: 256, n: 1, store: false, temperature: 0 }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new GatewayError('http_error', response.status);
      }
      let raw: unknown;
      try { raw = await response.json(); } catch { throw new GatewayError('invalid_json_response'); }
      return decodeCompletion(raw, Math.round(performance.now() - started));
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError(signal.aborted ? 'request_timeout' : 'transport_error');
    }
  }
}

export function syntheticLookup(call: ToolCall): { evidence_id: string; value: number } {
  if (call.function.name !== 'lookup_fixture') throw new GatewayError('tool_not_allowed');
  let args: unknown;
  try { args = JSON.parse(call.function.arguments); } catch { throw new GatewayError('tool_arguments_invalid'); }
  if (!record(args) || Object.keys(args).length !== 1 || args.evidence_id !== 'SYN-001') {
    throw new GatewayError('tool_arguments_invalid');
  }
  return { evidence_id: 'SYN-001', value: 7 };
}

export function verifyAnswer(content: string | null): boolean {
  try {
    const v: unknown = JSON.parse(content ?? '');
    return record(v) && Object.keys(v).length === 2 && v.answer === 7 && v.evidence_id === 'SYN-001';
  } catch { return false; }
}
