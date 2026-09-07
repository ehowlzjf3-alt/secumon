import { AsyncLocalStorage } from 'node:async_hooks';
import { isAbsolute } from 'node:path';
import { Client, serializeMessage, type JSONRPCMessage, type ResponseCacheStore } from '@modelcontextprotocol/client';
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/client/stdio';
import { z } from 'zod';
import { JsonSchema } from '../application/contracts.js';
import type { Json } from '../domain/model.js';
import { Sha256Digester } from './digest.js';

export interface McpRemoteTool { name: string; inputSchema: Json; outputSchema?: Json | undefined }
export interface McpSession { endpointId: string; generation: number; protocolVersion: string; discoveryDigest: string }
export interface McpReply { session: McpSession; value: Json; transportCalls: number }
export interface McpDecodedResponse {
  readonly session: Readonly<McpSession>;
  readonly requestDigest: string;
  /** Host clock observed immediately after this request's SDK promise resolves. Not a wire arrival or commit timestamp. */
  readonly observedAt: number;
  readonly json: string;
  readonly byteLength: number;
  /** Local send-boundary entries, not proof of remote execution or billing. */
  readonly transportCalls: 0 | 1;
}
export interface McpCallContext {
  signal: AbortSignal;
  authorize: () => Promise<void>;
  /** Host-only synchronous custody observation; this does not authorize use of the response. */
  capture?: { now(): number; decoded(value: Readonly<McpDecodedResponse>): undefined };
}
export type McpCallStage = 'request' | 'response_validation' | 'capture' | 'post_response';
export type McpCallErrorOptions = ErrorOptions & { stage?: McpCallStage; cleanupError?: unknown };
export class McpCallError extends Error {
  readonly stage?: McpCallStage;
  readonly cleanupError?: unknown;
  constructor(readonly code: string, readonly sent: boolean, options?: McpCallErrorOptions) {
    super(code, options);
    if (options?.stage !== undefined) this.stage = options.stage;
    if (options && 'cleanupError' in options) this.cleanupError = options.cleanupError;
  }
}
export interface McpStdioConfig {
  endpointId: string; command: string; args: string[]; cwd: string; env?: Record<string, string>;
  maxMessageBytes?: number; maxRequestBytes?: number; maxConcurrent?: number; maxListPages?: number; maxTools?: number; timeoutMs?: number;
}
export interface McpStdioSnapshot {
  endpointId: string; pid: number | null; generation: number; connected: boolean; dirty: boolean; closed: boolean;
  activeCalls: number; discovering: boolean; processStarts: number; processCloses: number;
  wireRequests: number; toolCalls: number; listPages: number; requestBytes: number; responseBytes: number; protocolErrors: number;
}
export const MCP_PROTOCOL_VERSION = '2026-07-28';
const PROTOCOL = MCP_PROTOCOL_VERSION;
const id = z.string().min(1).max(256);
const remoteSchema: z.ZodType<McpRemoteTool> = z.strictObject({ name: id, inputSchema: JsonSchema, outputSchema: JsonSchema.optional() });
const configSchema = z.strictObject({ endpointId: id, command: z.string().min(1).max(4096), args: z.array(z.string().max(8192)).max(64),
  cwd: z.string().min(1).max(4096), env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(16384)).optional(),
  maxMessageBytes: z.number().int().min(256).max(4194304).default(262144),
  maxRequestBytes: z.number().int().min(256).max(1048576).default(65536),
  maxConcurrent: z.number().int().min(1).max(16).default(4), maxListPages: z.number().int().min(1).max(100).default(20),
  maxTools: z.number().int().min(1).max(1000).default(100), timeoutMs: z.number().int().min(10).max(60000).default(10000) });
const noCache: ResponseCacheStore = { get: () => undefined, set: () => 0, delete: () => {}, evict: () => {}, clear: () => {} };
const digest = (value: unknown) => new Sha256Digester().digest(JsonSchema.parse(value));
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
function failure(code: string, sent = false): never { throw new McpCallError(code, sent); }
interface Dispatch { session: McpSession; name: string; input: Record<string, Json>; signal: AbortSignal; authorize: () => Promise<void>; sent: boolean }

/** The SDK still owns framing/parsing, spawning and teardown. The final gate runs after SDK awaits, immediately before stdin.write. */
class GuardedStdio extends StdioClientTransport {
  constructor(parameters: StdioServerParameters, private readonly gate: (message: JSONRPCMessage) => Promise<() => void>, private readonly started: (pid: number | null) => void) { super(parameters); }
  override async start(): Promise<void> { await super.start(); this.started(this.pid); }
  override async send(message: JSONRPCMessage): Promise<void> { const finalCheck = await this.gate(message); finalCheck(); return super.send(message); }
}
interface Connection { client: Client; transport: GuardedStdio; ready: boolean; broken: boolean; closing: Promise<void> | null; pid: number | null }

/** Host-installed read-tool transport. Discovery is a bounded local manifest comparison, never a claim of an atomic remote listing. */
export class McpStdioClient {
  readonly #config: z.infer<typeof configSchema>;
  readonly #dispatch = new AsyncLocalStorage<Dispatch>();
  #connection: Connection | null = null;
  #session: McpSession | null = null;
  #allowed = new Map<string, McpRemoteTool>();
  #generation = 0;
  #closed = false;
  #dirty = true;
  #discovering = false;
  #active = 0;
  #counts = { processStarts: 0, processCloses: 0, wireRequests: 0, toolCalls: 0, listPages: 0, requestBytes: 0, responseBytes: 0, protocolErrors: 0 };
  constructor(config: McpStdioConfig) {
    try {
      this.#config = configSchema.parse(config);
      if (!isAbsolute(this.#config.command) || !isAbsolute(this.#config.cwd) || [this.#config.command, this.#config.cwd, ...this.#config.args,
        ...Object.values(this.#config.env ?? {})].some(value => value.includes('\0')) || bytes(this.#config.env ?? {}) > 65536) failure('mcp_config_invalid');
    } catch { failure('mcp_config_invalid'); }
  }
  snapshot(): McpStdioSnapshot {
    return { endpointId: this.#config.endpointId, pid: this.#connection?.transport.pid ?? null, generation: this.#generation,
      connected: this.#connection?.ready === true && !this.#connection.broken, dirty: this.#dirty, closed: this.#closed,
      activeCalls: this.#active, discovering: this.#discovering, ...this.#counts };
  }
  private dirty(): void { this.#dirty = true; this.#session = null; this.#allowed.clear(); this.#generation++; }
  private check(session: McpSession, signal: AbortSignal): void {
    if (signal.aborted) failure('mcp_cancelled');
    if (this.#closed) failure('mcp_closed');
    if (!this.#connection?.ready || this.#connection.broken || this.#dirty || !this.#session || digest(session) !== digest(this.#session)) failure('mcp_session_changed');
  }
  private signal(external: AbortSignal): { signal: AbortSignal; done(): void } {
    const timeout = new AbortController(); const timer = setTimeout(() => timeout.abort(), this.#config.timeoutMs);
    return { signal: AbortSignal.any([external, timeout.signal]), done: () => clearTimeout(timer) };
  }
  private async bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) { void promise.catch(() => {}); failure('mcp_cancelled'); }
    return new Promise<T>((resolve, reject) => {
      const abort = () => { cleanup(); reject(new McpCallError('mcp_cancelled', false)); };
      const cleanup = () => signal.removeEventListener('abort', abort);
      signal.addEventListener('abort', abort, { once: true });
      promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
  }
  private async shutdown(connection: Connection): Promise<void> {
    if (!connection.closing) {
      connection.broken = true; connection.ready = false;
      connection.closing = (async () => {
        const pid = connection.transport.pid ?? connection.pid;
        let closeFailure: unknown; let clientFailed = false;
        try { await connection.client.close(); } catch (error) { clientFailed = true; closeFailure = error; }
        try { await connection.transport.close(); }
        catch (cleanupError) {
          if (clientFailed) throw new McpCallError('mcp_close_unconfirmed', false, { cause: closeFailure, cleanupError });
          throw cleanupError;
        }
        if (clientFailed) throw closeFailure;
        // SDK close may return immediately after SIGKILL; observe this owned child's exit before declaring cleanup complete.
        if (pid !== null) {
          const deadline = Date.now() + 2000;
          while (true) {
            try { process.kill(pid, 0); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ESRCH') break;
              throw new McpCallError('mcp_close_unconfirmed', false, { cause: error });
            }
            if (Date.now() >= deadline) failure('mcp_close_unconfirmed');
            await new Promise<void>(resolve => setTimeout(resolve, 10));
          }
          this.#counts.processCloses++;
        }
      })();
    }
    const closing = connection.closing;
    try { await closing; }
    catch (error) {
      // A later explicit close may recheck an uncertain exit; concurrent callers still share this attempt.
      if (connection.closing === closing) connection.closing = null;
      throw error;
    }
  }
  private breakConnection(connection: Connection): void {
    if (this.#connection !== connection || connection.broken) return;
    this.#counts.protocolErrors++; this.dirty(); connection.broken = true; connection.ready = false;
    void this.shutdown(connection).catch(() => {});
  }
  private async connect(signal: AbortSignal): Promise<Connection> {
    const prior = this.#connection;
    if (prior && !prior.broken && prior.ready) return prior;
    if (prior) await this.shutdown(prior);
    if (signal.aborted || this.#closed) failure(this.#closed ? 'mcp_closed' : 'mcp_cancelled');
    let connection!: Connection;
    const environment: Record<string, string> = Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map(key => [key, '']));
    Object.assign(environment, this.#config.env ?? {});
    const transport = new GuardedStdio({ command: this.#config.command, args: [...this.#config.args], cwd: this.#config.cwd,
      env: environment, stderr: 'ignore', maxBufferSize: this.#config.maxMessageBytes }, async message => {
      const length = Buffer.byteLength(serializeMessage(message));
      const isTool = 'method' in message && message.method === 'tools/call'; const dispatch = this.#dispatch.getStore();
      if (length > this.#config.maxRequestBytes) failure('mcp_request_limit', dispatch?.sent ?? false);
      if (isTool) {
        if (!dispatch || dispatch.sent) failure('mcp_call_repeat_denied', dispatch?.sent ?? false);
        this.check(dispatch.session, dispatch.signal);
        if (!('params' in message) || digest((message.params as { name?: unknown })?.name) !== digest(dispatch.name) ||
          digest((message.params as { arguments?: unknown })?.arguments) !== digest(dispatch.input)) failure('mcp_request_changed');
        try { await this.bounded(Promise.resolve().then(dispatch.authorize), dispatch.signal); }
        catch (cause) { throw new McpCallError('mcp_authorization_denied', false, { stage: 'request', cause }); }
        this.check(dispatch.session, dispatch.signal);
      }
      return () => {
        if (this.#closed || connection.broken) failure('mcp_connection_closed', dispatch?.sent ?? false);
        if (isTool && dispatch) { this.check(dispatch.session, dispatch.signal); dispatch.sent = true; this.#counts.toolCalls++; }
        this.#counts.requestBytes += length;
        if ('id' in message && 'method' in message) this.#counts.wireRequests++;
      };
    }, pid => { connection.pid = pid; if (pid !== null) this.#counts.processStarts++; });
    const client = new Client({ name: 'secumon-local-reader', version: '1' }, {
      versionNegotiation: { mode: { pin: PROTOCOL }, probe: { timeoutMs: this.#config.timeoutMs, maxRetries: 0 } },
      supportedProtocolVersions: [PROTOCOL], capabilities: {}, inputRequired: { autoFulfill: false }, responseCacheStore: noCache,
      defaultCacheTtlMs: 0, listMaxPages: this.#config.maxListPages, enforceStrictCapabilities: true,
      listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: () => { if (this.#connection === connection) this.dirty(); } } },
    });
    connection = { client, transport, ready: false, broken: false, closing: null, pid: null }; this.#connection = connection;
    client.onerror = () => this.breakConnection(connection);
    client.onclose = () => { if (this.#connection === connection && !connection.broken) { this.dirty(); connection.broken = true; connection.ready = false; } };
    try {
      await this.bounded(client.connect(transport, { signal, timeout: this.#config.timeoutMs }), signal);
      connection.pid = transport.pid;
      if (this.#closed || connection.broken || client.getNegotiatedProtocolVersion() !== PROTOCOL) failure('mcp_protocol_unavailable');
      connection.ready = true; return connection;
    } catch { await this.shutdown(connection); failure(signal.aborted ? 'mcp_cancelled' : 'mcp_connect_failed'); }
  }
  async discover(expected: McpRemoteTool[], signal: AbortSignal): Promise<McpSession> {
    if (this.#closed) failure('mcp_closed');
    if (this.#discovering || this.#active > 0) failure('mcp_busy');
    let approved: McpRemoteTool[];
    try { approved = z.array(remoteSchema).min(1).max(this.#config.maxTools).parse(expected); if (new Set(approved.map(tool => tool.name)).size !== approved.length) failure('mcp_manifest_invalid'); }
    catch { failure('mcp_manifest_invalid'); }
    this.#discovering = true; this.dirty(); const budget = this.signal(signal);
    try {
      const connection = await this.connect(budget.signal); const generation = this.#generation;
      const found = new Map<string, McpRemoteTool>(); const cursors = new Set<string>(); let cursor: string | undefined; let totalBytes = 0;
      for (let pageIndex = 0; ; pageIndex++) {
        if (pageIndex >= this.#config.maxListPages) failure('mcp_list_page_limit');
        const page = await connection.client.request({ method: 'tools/list', ...(cursor === undefined ? {} : { params: { cursor } }) },
          { signal: budget.signal, timeout: this.#config.timeoutMs, maxTotalTimeout: this.#config.timeoutMs, resetTimeoutOnProgress: false });
        this.#counts.listPages++; const length = bytes(page); totalBytes += length; this.#counts.responseBytes += length;
        if (length > this.#config.maxMessageBytes || totalBytes > this.#config.maxMessageBytes) failure('mcp_list_byte_limit');
        if (this.#closed || budget.signal.aborted || connection.broken || generation !== this.#generation) failure('mcp_discovery_changed');
        if (found.size + page.tools.length > this.#config.maxTools) failure('mcp_tool_limit');
        for (const tool of page.tools) {
          const normalized = remoteSchema.parse({ name: tool.name, inputSchema: tool.inputSchema, ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }) });
          if (found.has(tool.name)) failure('mcp_duplicate_tool'); found.set(tool.name, normalized);
        }
        if (page.nextCursor === undefined) break;
        if (typeof page.nextCursor !== 'string' || !page.nextCursor.length || Buffer.byteLength(page.nextCursor) > 4096 || cursors.has(page.nextCursor)) failure('mcp_cursor_invalid');
        cursors.add(page.nextCursor); cursor = page.nextCursor;
      }
      for (const tool of approved) if (!found.has(tool.name) || digest(tool) !== digest(found.get(tool.name))) failure('mcp_manifest_mismatch');
      const session: McpSession = { endpointId: this.#config.endpointId, generation, protocolVersion: PROTOCOL,
        discoveryDigest: digest([...found.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) };
      this.#allowed = new Map(approved.map(tool => [tool.name, tool])); this.#session = session; this.#dirty = false;
      return structuredClone(session);
    } catch (error) {
      this.dirty();
      if (budget.signal.aborted && this.#connection) await this.shutdown(this.#connection);
      throw new McpCallError(error instanceof McpCallError ? error.code : 'mcp_discovery_failed', false);
    } finally { budget.done(); this.#discovering = false; }
  }
  async call(session: McpSession, name: string, input: Record<string, Json>, context: McpCallContext): Promise<McpReply> {
    let capture: McpCallContext['capture'];
    try {
      const observer = context.capture;
      if (observer !== undefined) {
        if (!observer || typeof observer.now !== 'function' || typeof observer.decoded !== 'function') throw new Error('mcp_capture_invalid');
        capture = { now: observer.now.bind(observer), decoded: observer.decoded.bind(observer) };
      }
    } catch (cause) { throw new McpCallError('mcp_capture_invalid', false, { stage: 'capture', cause }); }
    let captured: McpSession; let argumentsValue: Record<string, Json>;
    try { captured = z.strictObject({ endpointId: id, generation: z.number().int().positive(), protocolVersion: id, discoveryDigest: z.string().regex(/^[0-9a-f]{64}$/) }).parse(session);
      argumentsValue = z.record(z.string(), JsonSchema).parse(input); id.parse(name); }
    catch { failure('mcp_request_invalid'); }
    this.check(captured, context.signal);
    if (!this.#allowed.has(name)) failure('mcp_tool_not_approved');
    if (this.#active >= this.#config.maxConcurrent || this.#discovering) failure('mcp_concurrency_limit');
    if (bytes({ name, arguments: argumentsValue }) > this.#config.maxRequestBytes) failure('mcp_request_limit');
    const requestDigest = capture ? digest({ session: captured, name, input: argumentsValue }) : null;
    this.#active++; const budget = this.signal(context.signal); const connection = this.#connection!;
    const dispatch: Dispatch = { session: captured, name, input: argumentsValue, signal: budget.signal, authorize: context.authorize, sent: false };
    let stage: McpCallStage = 'request';
    try {
      const value = await this.#dispatch.run(dispatch, () => connection.client.request({ method: 'tools/call', params: { name, arguments: argumentsValue } },
        { signal: budget.signal, timeout: this.#config.timeoutMs, maxTotalTimeout: this.#config.timeoutMs, resetTimeoutOnProgress: false }));
      stage = 'capture';
      const observedAt = capture?.now();
      if (capture && (!Number.isSafeInteger(observedAt) || observedAt! < 0)) failure('mcp_capture_time_invalid', dispatch.sent);
      stage = 'response_validation';
      const parsed = JsonSchema.parse(value), json = JSON.stringify(parsed);
      const length = Buffer.byteLength(json); this.#counts.responseBytes += length;
      if (length > this.#config.maxMessageBytes) failure('mcp_response_limit', dispatch.sent);
      if (capture) {
        stage = 'capture';
        const observation: McpDecodedResponse = Object.freeze({ session: Object.freeze(structuredClone(captured)),
          requestDigest: requestDigest!, observedAt: observedAt!, json, byteLength: length, transportCalls: dispatch.sent ? 1 : 0 });
        const returned: unknown = capture.decoded(observation);
        if (returned !== undefined) {
          // Invalid async observers are never awaited and cannot leak an unhandled rejection.
          void Promise.resolve(returned).catch(() => {});
          failure('mcp_capture_async_unsupported', dispatch.sent);
        }
      }
      stage = 'post_response';
      this.check(captured, budget.signal);
      return { session: structuredClone(captured), value: parsed, transportCalls: dispatch.sent ? 1 : 0 };
    } catch (error) {
      if (dispatch.sent) {
        this.dirty();
        try { await this.shutdown(connection); }
        catch (cleanupError) { throw new McpCallError('mcp_close_unconfirmed', dispatch.sent, { stage, cause: error, cleanupError }); }
      }
      throw new McpCallError(error instanceof McpCallError ? error.code : budget.signal.aborted ? 'mcp_cancelled' : 'mcp_call_failed',
        dispatch.sent, { stage, cause: error });
    } finally { budget.done(); this.#active--; }
  }
  async close(): Promise<void> {
    if (!this.#closed) { this.#closed = true; this.dirty(); }
    if (this.#connection) await this.shutdown(this.#connection);
  }
}
