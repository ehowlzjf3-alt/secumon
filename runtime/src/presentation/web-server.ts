import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { WorkViewLevel } from '../domain/work-view.js';
import type { LocalWorkbench } from './local-workbench.js';
import { WebAcceptSchema, WebAttachSchema, WebCommandSchema, WebInputSchema, WebCompactSchema } from './web-contracts.js';
import { runtimeRoot } from './local-profile.js';
import { PersonalRememberSchema, PersonalReviseSchema, PersonalForgetSchema, PersonalRecallSchema } from './local-personal-memory.js';
import { MemoryDraftCreateSchema, MemoryDraftApplySchema, MemoryDraftResumeSchema } from '../application/personal-memory-draft-contracts.js';
import { WebGeneralRequestSchema } from './web-contracts.js';

export type WebWorkbench = Pick<LocalWorkbench, 'config' | 'list' | 'view' | 'accept' | 'attach' | 'command' | 'drain'> & Partial<Pick<LocalWorkbench, 'history' | 'input' | 'compactStatus' | 'compact' |
  'memorySearch' | 'memoryGet' | 'memoryRemember' | 'memoryRevise' | 'memoryForget' | 'memorySelected' | 'memoryRecall' |
  'memoryDraftCreate' | 'memoryDraftApply' | 'memoryDraftResume' | 'memoryDraftStatus' | 'generalAccept' | 'goalBasis'>>;
interface WebOptions {
  port?: number;
  /** Shorter limits are only for deterministic local transport tests. */
  pollMs?: number;
  streamLifetimeMs?: number;
  sessionLifetimeMs?: number;
  bootstrapLifetimeMs?: number;
  now?: () => number;
}
interface Session { csrf: string; expiresAt: number; requests: number; windowAt: number }
class HttpFailure extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
const secret = () => randomBytes(32).toString('hex');
const equals = (a: string, b: string) => {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const safeCodes: Record<string, number> = {
  agent_turn_provider_unavailable: 409, agent_turn_input_changed: 409, agent_turn_input_invalid: 409,
  invalid_web_input: 400, invalid_view_cursor: 400, invalid_view_level: 400, invalid_list_cursor: 400,
  invalid_execution_mode: 400, synthetic_scope_unavailable: 409, synthetic_plan_unavailable: 409,
  work_not_found: 404, work_not_authorized: 403, work_view_denied: 403, work_view_unavailable: 409,
  work_view_route_denied: 403, work_view_diagnostics_denied: 403, work_view_policy_denied: 403,
  workflow_policy_insufficient: 403, execution_authority_denied: 403, resume_policy_insufficient: 403,
  stale_goal_revision: 409, stale_control_revision: 409, command_payload_conflict: 409,
  idempotency_conflict: 409, request_payload_conflict: 409, work_terminal: 409,
  command_conflict: 409, work_already_running: 409, run_capacity_exceeded: 429,
  web_request_invalid: 400, web_scenario_unavailable: 400, web_list_cursor_invalid: 400, web_list_contention: 409,
  web_view_unavailable: 409, web_workbench_draining: 503, web_run_in_progress: 409,
  web_run_capacity: 429, web_work_paused: 409, work_view_knowledge_changed: 403,
  work_view_contention: 409, work_view_invalid_request: 400, stale_user_command: 409,
  stale_execution_control: 409, work_not_resumable: 409, work_not_plannable: 409,
  stale_session_input: 409, stale_work_policy: 409, agent_goal_change_unavailable: 409,
  invalid_goal_revision_or_criteria: 400, obligation_not_resolvable: 409,
  deadline_exceeded: 409, attempt_pending: 409, effect_unknown: 409,
  session_text_required: 400, session_unavailable: 403, session_work_unavailable: 403,
  session_attach_unsupported: 409,
  session_context_capacity: 409, session_current_input_unavailable: 409,
  session_compact_pending: 409, session_compact_capacity: 409, session_compact_unavailable: 409,
  session_compact_failed: 409, session_compact_request_conflict: 409, model_request_conflict: 409,
  model_not_needed: 409, model_reservation_stale: 409, model_input_limit: 409, model_call_pending: 409,
  model_input_required_overflow: 409, model_window_configuration_invalid: 409,
  model_input_profile_changed: 409, model_input_estimate_invalid: 500,
  session_input_pending: 409, session_recovery_capacity: 409, session_intake_invalid: 409,
  session_work_identity_conflict: 409, session_input_unavailable: 409,
  session_input_identity_conflict: 409, session_input_settlement_conflict: 409,
  invalid_session_cursor: 400, invalid_session_query: 400,
  request_identity_conflict: 409, request_not_authorized: 403,
  personal_memory_unavailable: 403, personal_memory_revision_changed: 409,
  knowledge_unavailable: 403, knowledge_not_authorized: 403, knowledge_conflict: 409, knowledge_revision_conflict: 409,
  knowledge_source_unavailable: 409, knowledge_source_invalid: 400, knowledge_invalid_request: 400,
  personal_memory_request_conflict: 409, personal_memory_state_changed: 409, personal_memory_selection_stale: 409,
  personal_memory_not_selectable: 409, personal_memory_capacity: 409, knowledge_contention: 409, knowledge_command_conflict: 409,
  personal_memory_read_only: 403, personal_memory_changed: 409,
  personal_memory_draft_unavailable: 403, personal_memory_draft_owner_mismatch: 403,
  personal_memory_draft_operation_missing: 404, personal_memory_draft_missing: 404,
  personal_memory_draft_invalid: 400, personal_memory_draft_conflict: 409,
  personal_memory_draft_source_conflict: 409, personal_memory_draft_outcome_unknown: 409,
  personal_memory_draft_contention: 409, personal_memory_draft_limit_exceeded: 413,
};
function publicFailure(error: unknown): HttpFailure {
  if (error instanceof HttpFailure) return error;
  if (error instanceof z.ZodError) return new HttpFailure(400, 'invalid_web_input');
  const code = error instanceof Error ? error.message : '';
  return new HttpFailure(safeCodes[code] ?? 500, Object.hasOwn(safeCodes, code) ? code : 'request_failed');
}
function sendJson(res: ServerResponse, status: number, value: unknown) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value));
}
function singleton(req: IncomingMessage, name: string): string | undefined {
  const values = req.headersDistinct[name];
  if (!values) return undefined;
  if (values.length !== 1) throw new HttpFailure(400, 'invalid_headers');
  return values[0];
}
function query(url: URL, names: string[]) {
  for (const key of url.searchParams.keys()) if (!names.includes(key) || url.searchParams.getAll(key).length !== 1) throw new HttpFailure(400, 'invalid_query');
  const cursor = url.searchParams.get('cursor') ?? undefined;
  if (cursor !== undefined && (cursor.length > 256 || /[\r\n\x00]/.test(cursor))) throw new HttpFailure(400, 'invalid_view_cursor');
  return cursor;
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(singleton(req, 'content-type') ?? '')) throw new HttpFailure(415, 'json_required');
  const declared = singleton(req, 'content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 32768)) throw new HttpFailure(413, 'body_too_large');
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string); length += bytes.length;
    if (length > 32768) throw new HttpFailure(413, 'body_too_large');
    chunks.push(bytes);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown; }
  catch { throw new HttpFailure(400, 'invalid_json'); }
}

/** Local synthetic UI transport. Authentication is process-local, not organization SSO. */
export async function startWebServer(workbench: WebWorkbench, options: WebOptions = {}) {
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid_web_port');
  const pollMs = Math.max(10, options.pollMs ?? 2000);
  const streamLifetime = Math.max(20, options.streamLifetimeMs ?? 60000);
  const sessionLifetime = Math.max(20, options.sessionLifetimeMs ?? 3600000);
  const now = options.now ?? Date.now;
  const bootstrap = secret(); const bootstrapExpires = now() + (options.bootstrapLifetimeMs ?? 600000);
  let bootstrapUsed = false; let stopping = false; let origin = ''; let authority = '';
  const cookieName = `work_session_${randomBytes(8).toString('hex')}`;
  const sessions = new Map<string, Session>();
  const streams = new Map<ServerResponse, { sessionId: string; close: () => void }>();
  let reads = 0; let mutations = 0; let viewReads = 0;
  const activeReads = new Set<Promise<unknown>>();
  async function readBounded<T>(action: () => Promise<T>): Promise<T> {
    if (activeReads.size >= 16) throw new HttpFailure(429, 'read_capacity');
    const pending = Promise.resolve().then(action); activeReads.add(pending);
    try { return await pending; } finally { activeReads.delete(pending); }
  }
  let bootstrapRequests = 0; let bootstrapWindow = now();
  const assets = new Map([
    ['/', { path: join(runtimeRoot, 'src/presentation/web/index.html'), type: 'text/html; charset=utf-8' }],
    ['/assets/styles.css', { path: join(runtimeRoot, 'src/presentation/web/styles.css'), type: 'text/css; charset=utf-8' }],
    ['/assets/client.js', { path: join(runtimeRoot, 'dist/presentation/web/client.js'), type: 'text/javascript; charset=utf-8' }],
    ['/assets/view-state.js', { path: join(runtimeRoot, 'dist/presentation/web/view-state.js'), type: 'text/javascript; charset=utf-8' }],
    ['/assets/personal-memory.js', { path: join(runtimeRoot, 'dist/presentation/web/personal-memory.js'), type: 'text/javascript; charset=utf-8' }],
  ]);
  function authenticated(req: IncomingMessage): { id: string; session: Session } {
    const cookies = (singleton(req, 'cookie') ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${cookieName}=`));
    if (cookies.length !== 1) throw new HttpFailure(401, 'session_required');
    const id = cookies[0]!.slice(cookieName.length + 1); const session = sessions.get(id);
    if (!session || session.expiresAt <= now()) { sessions.delete(id); throw new HttpFailure(401, 'session_expired'); }
    if (now() - session.windowAt >= 60000) { session.windowAt = now(); session.requests = 0; }
    if (++session.requests > 240) throw new HttpFailure(429, 'request_limit');
    return { id, session };
  }
  async function stream(req: IncomingMessage, res: ServerResponse, workId: string, sessionId: string, initialCursor?: string) {
    if (streams.size >= 4) throw new HttpFailure(429, 'stream_limit');
    let cursor = initialCursor; let ended = false; let timer: ReturnType<typeof setTimeout> | undefined; let compactDigest = '';
    const deadline = Math.min(now() + streamLifetime, sessions.get(sessionId)!.expiresAt);
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const close = () => { if (ended) return; ended = true; clearTimeout(timer); clearTimeout(expiry); streams.delete(res); res.end(); };
    const write = (event: string, data: unknown, id?: string) => {
      if (ended || res.destroyed) { close(); return; }
      if (!res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) close();
    };
    const available = () => {
      const session = sessions.get(sessionId);
      return !stopping && !!session && session.expiresAt > now();
    };
    streams.set(res, { sessionId, close });
    res.once('close', close);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    expiry = setTimeout(() => {
      if (!available()) write('unavailable', { code: 'session_expired' });
      close();
    }, Math.max(1, deadline - now()));
    const poll = async () => {
      if (ended) return;
      if (!available()) { write('unavailable', { code: 'session_expired' }); close(); return; }
      try {
        viewReads++;
        const value = await readBounded(() => workbench.view(workId, 'conversation', cursor));
        if (ended) return;
        if (!available()) { write('unavailable', { code: 'session_expired' }); close(); return; }
        cursor = value.cursor; write(value.kind === 'snapshot' ? 'view' : 'unchanged', value, value.cursor);
        if (workbench.config().persistentSession && workbench.compactStatus) {
          const compact = await readBounded(() => workbench.compactStatus!(workId));
          if (ended) return;
          if (!available()) { write('unavailable', { code: 'session_expired' }); close(); return; }
          const next = JSON.stringify(compact);
          if (next !== compactDigest) { compactDigest = next; write('context-status', compact); }
        }
      } catch { write('unavailable', { code: 'work_view_unavailable' }); close(); return; }
      if (!ended) timer = setTimeout(() => { void poll(); }, pollMs);
    };
    void req; await poll();
  }
  const server = createServer({ headersTimeout: 10000, requestTimeout: 15000, keepAliveTimeout: 5000, maxHeaderSize: 8192 }, (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    let counted: 'read' | 'mutation' | undefined;
    const handle = async () => {
      if (stopping) throw new HttpFailure(503, 'server_stopping');
      if (singleton(req, 'host') !== authority) throw new HttpFailure(403, 'host_denied');
      const method = req.method ?? '';
      const suppliedOrigin = singleton(req, 'origin');
      if ((suppliedOrigin !== undefined && suppliedOrigin !== origin) || (method !== 'GET' && method !== 'HEAD' && suppliedOrigin !== origin)) throw new HttpFailure(403, 'origin_denied');
      const site = singleton(req, 'sec-fetch-site');
      if (site && !['same-origin', 'none'].includes(site)) throw new HttpFailure(403, 'origin_denied');
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new HttpFailure(400, 'invalid_path');
      const url = new URL(req.url, origin);
      const asset = assets.get(url.pathname);
      if (asset && (method === 'GET' || method === 'HEAD')) {
        query(url, []); const bytes = await readFile(asset.path);
        res.writeHead(200, { 'Content-Type': asset.type }); res.end(method === 'HEAD' ? undefined : bytes); return;
      }
      if (!url.pathname.startsWith('/api/')) throw new HttpFailure(404, 'route_not_found');
      if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') throw new HttpFailure(405, 'method_not_allowed');
      if (method === 'GET') { if (reads >= 16) throw new HttpFailure(429, 'read_capacity'); reads++; counted = 'read'; }
      else { if (mutations >= 12) throw new HttpFailure(429, 'mutation_capacity'); mutations++; counted = 'mutation'; }
      if (url.pathname === '/api/session' && method === 'POST') {
        query(url, []);
        if (now() - bootstrapWindow >= 60000) { bootstrapRequests = 0; bootstrapWindow = now(); }
        if (++bootstrapRequests > 30) throw new HttpFailure(429, 'request_limit');
        const input = z.strictObject({ token: z.string().regex(/^[a-f0-9]{64}$/) }).parse(await body(req));
        if (bootstrapUsed || now() >= bootstrapExpires || !equals(input.token, bootstrap)) throw new HttpFailure(401, 'connect_token_invalid');
        bootstrapUsed = true; const id = secret(); const csrf = secret();
        sessions.set(id, { csrf, expiresAt: now() + sessionLifetime, requests: 0, windowAt: now() });
        res.setHeader('Set-Cookie', `${cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.ceil(sessionLifetime / 1000)}`);
        sendJson(res, 200, { csrf, config: workbench.config() }); return;
      }
      const { id: sessionId, session } = authenticated(req);
      const currentSession = () => {
        if (!sessions.has(sessionId) || session.expiresAt <= now()) throw new HttpFailure(401, 'session_expired');
      };
      const reply = (value: unknown) => {
        currentSession();
        sendJson(res, 200, value);
      };
      if (method !== 'GET' && !equals(singleton(req, 'x-work-csrf') ?? '', session.csrf)) throw new HttpFailure(403, 'csrf_denied');
      if (url.pathname === '/api/session') {
        query(url, []);
        if (method === 'GET') { sendJson(res, 200, { csrf: session.csrf, config: workbench.config() }); return; }
        if (method === 'DELETE') {
          sessions.delete(sessionId);
          for (const [response, active] of streams) if (active.sessionId === sessionId) { response.write(`event: unavailable\ndata: {"code":"session_expired"}\n\n`); active.close(); }
          res.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`); sendJson(res, 200, { disconnected: true }); return;
        }
        throw new HttpFailure(405, 'method_not_allowed');
      }
      if (url.pathname === '/api/requests' && method === 'POST') {
        if (!workbench.generalAccept) throw new HttpFailure(404, 'route_not_found');
        query(url, []); const input = WebGeneralRequestSchema.parse(await body(req)); currentSession();
        reply(await workbench.generalAccept(input)); return;
      }
      if (url.pathname === '/api/works') {
        if (method === 'GET') { const cursor = query(url, ['cursor']); reply(await readBounded(() => workbench.list(cursor))); return; }
        if (method === 'POST') { query(url, []); const input = WebAcceptSchema.parse(await body(req)); currentSession(); reply(await workbench.accept(input)); return; }
        throw new HttpFailure(405, 'method_not_allowed');
      }
      if (url.pathname === '/api/conversation' && method === 'GET') {
        if (!workbench.history) throw new HttpFailure(404, 'route_not_found');
        const cursor = query(url, ['cursor']); reply(await readBounded(() => workbench.history!(cursor))); return;
      }
      if (url.pathname === '/api/memories' && method === 'GET') {
        if (!workbench.memorySearch) throw new HttpFailure(404, 'route_not_found');
        query(url, ['query']); reply(await readBounded(() => workbench.memorySearch!(url.searchParams.get('query') ?? ''))); return;
      }
      if (url.pathname === '/api/memory-drafts/create' && method === 'POST') {
        if (!workbench.memoryDraftCreate) throw new HttpFailure(404, 'route_not_found');
        query(url, []); const input = MemoryDraftCreateSchema.parse(await body(req)); currentSession(); reply(await workbench.memoryDraftCreate(input)); return;
      }
      if (url.pathname === '/api/memory-drafts/apply' && method === 'POST') {
        if (!workbench.memoryDraftApply) throw new HttpFailure(404, 'route_not_found');
        query(url, []); const input = MemoryDraftApplySchema.parse(await body(req)); currentSession(); reply(await workbench.memoryDraftApply(input)); return;
      }
      if (url.pathname === '/api/memory-drafts/resume' && method === 'POST') {
        if (!workbench.memoryDraftResume) throw new HttpFailure(404, 'route_not_found');
        query(url, []); const input = MemoryDraftResumeSchema.parse(await body(req)); currentSession(); reply(await workbench.memoryDraftResume(input)); return;
      }
      if (url.pathname === '/api/memory-drafts/status' && method === 'GET') {
        if (!workbench.memoryDraftStatus) throw new HttpFailure(404, 'route_not_found');
        query(url, ['applyId', 'sessionId']); const input = MemoryDraftResumeSchema.parse({ applyId: url.searchParams.get('applyId'), sessionId: url.searchParams.get('sessionId') });
        reply(await readBounded(() => workbench.memoryDraftStatus!(input))); return;
      }
      if (url.pathname === '/api/memories/remember' && method === 'POST') {
        if (!workbench.memoryRemember) throw new HttpFailure(404, 'route_not_found');
        query(url, []); const input = PersonalRememberSchema.parse(await body(req)); currentSession(); reply(await workbench.memoryRemember(input)); return;
      }
      if (url.pathname === '/api/memories/revise' && method === 'POST') {
        if (!workbench.memoryRevise) throw new HttpFailure(404, 'route_not_found');
        query(url, []); const input = PersonalReviseSchema.parse(await body(req)); currentSession(); reply(await workbench.memoryRevise(input)); return;
      }
      if (url.pathname === '/api/memories/forget' && method === 'POST') {
        if (!workbench.memoryForget) throw new HttpFailure(404, 'route_not_found');
        query(url, []); const input = PersonalForgetSchema.parse(await body(req)); currentSession(); reply(await workbench.memoryForget(input)); return;
      }
      const memory = /^\/api\/memories\/([^/]+)$/.exec(url.pathname);
      if (memory && method === 'GET') {
        if (!workbench.memoryGet) throw new HttpFailure(404, 'route_not_found');
        query(url, []); let id: string;
        try { id = decodeURIComponent(memory[1]!); } catch { throw new HttpFailure(400, 'invalid_memory_id'); }
        if (!id || id.length > 256 || /[\x00-\x1f\x7f/]/.test(id)) throw new HttpFailure(400, 'invalid_memory_id');
        reply(await readBounded(() => workbench.memoryGet!(id))); return;
      }
      if (url.pathname === '/api/attach' && method === 'POST') { query(url, []); const input = WebAttachSchema.parse(await body(req)); currentSession(); reply(await workbench.attach(input)); return; }
      const match = /^\/api\/works\/([^/]+)\/(view|events|commands|inputs|compact|context-status|memories|goal-basis)$/.exec(url.pathname);
      if (!match) throw new HttpFailure(404, 'route_not_found');
      let workId: string;
      try { workId = decodeURIComponent(match[1]!); } catch { throw new HttpFailure(400, 'invalid_work_id'); }
      if (!workId || workId.length > 256 || /[\x00-\x1f\x7f/]/.test(workId)) throw new HttpFailure(400, 'invalid_work_id');
      if (match[2] === 'memories' && method === 'GET') {
        if (!workbench.memorySelected) throw new HttpFailure(404, 'route_not_found');
        query(url, []); reply(await readBounded(() => workbench.memorySelected!(workId))); return;
      }
      if (match[2] === 'memories' && method === 'POST') {
        if (!workbench.memoryRecall) throw new HttpFailure(404, 'route_not_found');
        query(url, []); const input = PersonalRecallSchema.parse(await body(req)); currentSession(); reply(await workbench.memoryRecall(workId, input)); return;
      }
      if (match[2] === 'view' && method === 'GET') {
        const cursor = query(url, ['cursor', 'level']); const level = url.searchParams.get('level') ?? 'conversation';
        if (!['conversation', 'details', 'diagnostics'].includes(level)) throw new HttpFailure(400, 'invalid_view_level');
        viewReads++; const value = await readBounded(() => workbench.view(workId, level as WorkViewLevel, cursor));
        if (!sessions.has(sessionId) || session.expiresAt <= now()) throw new HttpFailure(401, 'session_expired');
        sendJson(res, 200, value); return;
      }
      if (match[2] === 'events' && method === 'GET') {
        let cursor = query(url, ['cursor']); const last = singleton(req, 'last-event-id');
        if (last !== undefined && (last.length > 256 || /[\r\n\x00]/.test(last))) throw new HttpFailure(400, 'invalid_view_cursor');
        // Native EventSource sends the newest ID on reconnection; its original query can be older.
        cursor = last ?? cursor;
        await stream(req, res, workId, sessionId, cursor); return;
      }
      if (match[2] === 'commands' && method === 'POST') { query(url, []); const input = WebCommandSchema.parse(await body(req)); currentSession(); reply(await workbench.command(workId, input)); return; }
      if (match[2] === 'goal-basis' && method === 'GET') {
        if (!workbench.goalBasis) throw new HttpFailure(404, 'route_not_found');
        query(url, []); reply(await readBounded(() => workbench.goalBasis!(workId))); return;
      }
      if (match[2] === 'context-status' && method === 'GET') {
        if (!workbench.compactStatus) throw new HttpFailure(404, 'route_not_found');
        query(url, []); reply(await readBounded(() => workbench.compactStatus!(workId))); return;
      }
      if (match[2] === 'compact' && method === 'POST') {
        if (!workbench.compact) throw new HttpFailure(404, 'route_not_found');
        query(url, []); const input = WebCompactSchema.parse(await body(req)); currentSession(); reply(await workbench.compact(workId, input)); return;
      }
      if (match[2] === 'inputs' && method === 'POST') {
        if (!workbench.input) throw new HttpFailure(404, 'route_not_found');
        query(url, []); const input = WebInputSchema.parse(await body(req)); currentSession(); reply(await workbench.input(workId, input)); return;
      }
      throw new HttpFailure(405, 'method_not_allowed');
    };
    void handle().catch(error => {
      const failure = publicFailure(error);
      if (!res.headersSent) { if (!req.complete) res.setHeader('Connection', 'close'); sendJson(res, failure.status, { code: failure.code }); }
      else res.end();
    }).finally(() => { if (counted === 'read') reads--; else if (counted === 'mutation') mutations--; });
  });
  server.maxConnections = 48;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('web_address_unavailable');
  authority = `127.0.0.1:${address.port}`; origin = `http://${authority}`;
  let closing: Promise<void> | undefined;
  return {
    origin, connectUrl: `${origin}/#connect=${bootstrap}`,
    stats: () => ({ streams: streams.size, reads, mutations, activeReads: activeReads.size, viewReads }),
    close: () => closing ??= (async () => {
      stopping = true; for (const active of streams.values()) active.close(); sessions.clear();
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeIdleConnections(); await workbench.drain(); await Promise.allSettled([...activeReads]); await closed;
    })(),
  };
}
