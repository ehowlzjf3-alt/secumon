import { z } from 'zod';
import { A2aMessageSchema, A2aReplySchema, A2aTaskSchema, type A2aCall, type A2aMessage, type A2aPeer } from '../application/a2a-contracts.js';
import { JsonSchema } from '../application/contracts.js';
import { frozen } from '../application/resource-contracts.js';

const EnvelopeSchema = z.union([
  z.strictObject({ jsonrpc: z.literal('2.0'), id: z.string(), result: JsonSchema }),
  z.strictObject({ jsonrpc: z.literal('2.0'), id: z.string().nullable(), error: z.strictObject({ code: z.number().int(), message: z.string().max(4096), data: JsonSchema.optional() }) }),
]);
export interface A2aJsonRpcOptions {
  id: string; endpoint: string; destination: string; labels: readonly string[];
  headers?: Readonly<Record<string, string>>; fetch?: typeof fetch; timeoutMs?: number; maximumBytes?: number;
}

/** Observe the original promise even after cancellation; a host fetch may ignore its signal. */
function interrupted<T>(pending: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', abort); reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    void pending.then(value => {
      if (settled) { late?.(value); return; }
      settled = true; signal.removeEventListener('abort', abort); resolve(value);
    }, error => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', abort); reject(error);
    });
    if (signal.aborted) abort();
  });
}
/** Cancellation starts synchronously; a broken source's cleanup must not replace or indefinitely delay the first error. */
function cancelBody(source: { cancel(reason?: unknown): Promise<void> } | null, reason: unknown) {
  try { void source?.cancel(reason).catch(() => {}); } catch { /* Preserve the request failure. */ }
}
function discardResponse(response: Response, reason: unknown) {
  try { cancelBody(response.body, reason); } catch { /* A late response cannot reopen the failed request. */ }
}

/** Fixed host endpoint, JSON-RPC 2.0 + A2A-Version 1.0. No discovery, retries, redirect following or fallback. */
export class A2aJsonRpcPeer implements A2aPeer {
  readonly id: string; readonly protocolVersion = '1.0' as const; readonly destination: string; readonly labels: readonly string[];
  readonly #endpoint: string; readonly #headers: Readonly<Record<string, string>>; readonly #fetch: typeof fetch;
  readonly #timeout: number; readonly #maximum: number; readonly #lifetime = new AbortController();
  readonly #pending = new Set<Promise<unknown>>();
  constructor(options: A2aJsonRpcOptions) {
    const endpoint = new URL(options.endpoint);
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash ||
      endpoint.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)) throw new Error('a2a_endpoint_invalid');
    this.id = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).refine(value => value !== 'core').parse(options.id);
    this.destination = z.string().min(1).max(256).parse(options.destination);
    this.labels = Object.freeze(z.array(z.string().min(1).max(256)).max(64).parse(options.labels));
    this.#timeout = z.number().int().min(1).max(60000).parse(options.timeoutMs ?? 10000);
    this.#maximum = z.number().int().min(512).max(1024 * 1024).parse(options.maximumBytes ?? 262144);
    const headers = { ...(options.headers ?? {}) };
    if (Object.keys(headers).some(key => ['a2a-version', 'content-type', 'accept', 'host', 'content-length'].includes(key.toLowerCase()))) throw new Error('a2a_reserved_header');
    this.#headers = frozen({ ...headers, 'Content-Type': 'application/json', Accept: 'application/json', 'A2A-Version': '1.0' });
    this.#endpoint = endpoint.href; this.#fetch = options.fetch ?? globalThis.fetch;
  }
  private request(method: string, params: unknown, call: A2aCall) {
    const pending = this.requestOnce(method, params, call); this.#pending.add(pending);
    void pending.then(() => this.#pending.delete(pending), () => this.#pending.delete(pending));
    return pending;
  }
  private async requestOnce(method: string, params: unknown, call: A2aCall) {
    const requestId = z.string().min(1).max(256).parse(call.requestId);
    const signal = AbortSignal.any([this.#lifetime.signal, call.signal, AbortSignal.timeout(this.#timeout)]);
    const body = JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params });
    if (Buffer.byteLength(body) > this.#maximum) throw new Error('a2a_request_too_large');
    signal.throwIfAborted();
    await (call.authorize ? interrupted(call.authorize(), signal) : undefined);
    signal.throwIfAborted();
    // Aborting observation cannot undo a SendMessage/CancelTask already accepted remotely. Never replay it here.
    const response = await interrupted(this.#fetch(this.#endpoint, { method: 'POST', headers: this.#headers, body, signal, redirect: 'error' }),
      signal, value => discardResponse(value, signal.reason));
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, failed = false;
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      signal.throwIfAborted();
      if (!response.ok || !response.body || !response.headers.get('content-type')?.split(';')[0]?.trim().match(/^application\/(?:json|a2a\+json)$/i))
        throw new Error(`a2a_http_error:${response.status}`);
      reader = response.body.getReader();
      while (true) {
        signal.throwIfAborted();
        const next = await interrupted(reader.read(), signal); signal.throwIfAborted(); if (next.done) break;
        size += next.value.byteLength; if (size > this.#maximum) throw new Error('a2a_response_too_large');
        chunks.push(next.value);
      }
      const envelope = EnvelopeSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
      if (envelope.id !== requestId) throw new Error('a2a_response_identity');
      if ('error' in envelope) throw new Error(`a2a_rpc_error:${envelope.error.code}`, { cause: envelope.error });
      signal.throwIfAborted(); return envelope.result;
    } catch (error) {
      failed = true; if (reader) cancelBody(reader, error); else discardResponse(response, error); throw error;
    } finally {
      try { reader?.releaseLock(); } catch (error) { if (!failed) throw error; }
    }
  }
  async send(input: A2aMessage, call: A2aCall) {
    const message = A2aMessageSchema.parse(structuredClone(input));
    if (message.role !== 'ROLE_USER') throw new Error('a2a_sender_role_invalid');
    return A2aReplySchema.parse(await this.request('SendMessage', { message,
      configuration: { returnImmediately: true, historyLength: 0, acceptedOutputModes: ['text/plain', 'application/json'] } }, call));
  }
  async get(taskId: string, call: A2aCall) {
    const id = A2aTaskSchema.shape.id.parse(taskId);
    const task = A2aTaskSchema.parse(await this.request('GetTask', { id, historyLength: 0 }, call));
    if (task.id !== id) throw new Error('a2a_task_identity'); return task;
  }
  async cancel(taskId: string, call: A2aCall) {
    const id = A2aTaskSchema.shape.id.parse(taskId);
    const task = A2aTaskSchema.parse(await this.request('CancelTask', { id }, call));
    if (task.id !== id) throw new Error('a2a_task_identity'); return task;
  }
  async close() { this.#lifetime.abort(); await Promise.allSettled([...this.#pending]); }
}
