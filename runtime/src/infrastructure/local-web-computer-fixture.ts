import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { ComputerActionSchema, ComputerLeaseSchema } from '../application/computer-use-contracts.js';
import { ComputerOperationIdentitySchema, ComputerOperationReceiptSchema } from '../application/computer-operation-contracts.js';
import type { ComputerAction, ComputerLease } from '../domain/computer-use.js';
import type { ComputerOperationIdentity, ComputerOperationReceipt } from '../domain/computer-operation.js';
import { localWebComputerPageHtml, localWebComputerPageScript, type LocalWebApp, type LocalWebControl, type LocalWebDocument } from './local-web-computer-page.js';

export const LOCAL_WEB_COMPUTER_IDENTITY = Object.freeze({ id: 'instrumented-web-document-app', version: '1' });
export interface LocalWebComputerFixtureOptions { stateFile?: string; sessionId?: string; searchDelayMs?: number }
export interface LocalWebComputerActionFault { loseResponseAfterSave?: boolean }
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const id = z.string().min(1).max(256);
const appSchema = z.strictObject({ query: z.string().max(8192), note: z.string().max(8192), resultsReady: z.boolean(),
  savedNote: z.string().max(8192), saveCount: count, inputCount: count });
const storedSchema = z.strictObject({ version: z.literal(1), sessionId: id, epoch: count.min(1), revision: count,
  app: appSchema, receipts: z.array(ComputerOperationReceiptSchema).max(256) });
type Stored = z.infer<typeof storedSchema>;
const keyOf = (v: ComputerOperationIdentity) => JSON.stringify([v.sessionId, v.epoch, v.workId, v.attemptId, v.operationId]);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const cost = () => ({ transportCalls: 1, internalOperations: 1, imageBytes: 0, waitMs: 0 });
class FixtureFailure extends Error { constructor(readonly code: string, readonly status = 409) { super(code); } }
const fail = (code: string): never => { throw new FixtureFailure(code); };

/** Local cooperating app. Receipts prove app commits; renderer DOM dispatch is a separate, non-native boundary. */
export async function startLocalWebComputerFixture(options: LocalWebComputerFixtureOptions = {}) {
  const sessionId = id.parse(options.sessionId ?? 'synthetic-document');
  const searchDelayMs = count.max(30000).parse(options.searchDelayMs ?? 0);
  const stateFile = options.stateFile;
  let storageUncertain = false; let stopping = false;
  function decode(bytes: Buffer): Stored {
    if (bytes.byteLength > 16 * 1024 * 1024) fail('computer_storage_unavailable');
    const value = storedSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (value.sessionId !== sessionId || value.app.saveCount > value.app.inputCount) fail('computer_storage_unavailable');
    const keys = new Set<string>(); let sequence = 0;
    for (const receipt of value.receipts) {
      const key = keyOf(receipt.identity);
      if (keys.has(key) || !equal(receipt.driver, LOCAL_WEB_COMPUTER_IDENTITY) || receipt.identity.sessionId !== sessionId ||
          receipt.identity.epoch > value.epoch || receipt.effectSequence > value.app.inputCount || receipt.effectSequence < sequence ||
          receipt.outcome === 'applied' && receipt.effectSequence <= sequence) fail('computer_storage_unavailable');
      keys.add(key); sequence = receipt.effectSequence;
    }
    return value;
  }
  function readStored(): Stored {
    if (!stateFile || !statSync(stateFile).isFile() || statSync(stateFile).size > 16 * 1024 * 1024) fail('computer_storage_unavailable');
    return decode(readFileSync(stateFile!));
  }
  const old = stateFile && existsSync(stateFile) ? readStored() : null;
  let state: Stored = old ?? { version: 1, sessionId, epoch: randomInt(1, 2 ** 48), revision: 0,
    app: { query: '', note: '', resultsReady: false, savedNote: '', saveCount: 0, inputCount: 0 }, receipts: [] };
  function persist(next: Stored, initial = false) {
    if (storageUncertain) fail('computer_storage_uncertain');
    decode(Buffer.from(JSON.stringify(next)));
    if (stateFile) {
      if (!initial && !equal(readStored(), state)) fail('computer_stale_session');
      const folder = dirname(stateFile); mkdirSync(folder, { recursive: true, mode: 0o700 });
      const temp = `${stateFile}.tmp-${randomUUID()}`;
      try {
        writeFileSync(temp, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
        const file = openSync(temp, 'r'); try { fsyncSync(file); } finally { closeSync(file); }
        renameSync(temp, stateFile);
        const directory = openSync(folder, 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
      } catch { storageUncertain = true; fail('computer_storage_uncertain'); }
    }
    state = next;
  }
  persist({ ...state, epoch: state.epoch + 1, revision: state.revision + 1 }, true);
  let documentId: string | null = null; let surfaceId = ''; let lease: ComputerLease | null = null; let fence = 0; let humanOwned = false;
  let readiness: ReturnType<typeof setTimeout> | null = null; let readinessGeneration = 0;
  const channels = new Set<ServerResponse>();
  const controls = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const faults: LocalWebComputerActionFault[] = [];
  const metrics = { httpRequests: 0, requestBodyBytes: 0, responseBodyBytes: 0, streams: 0, appCommits: 0,
    rendererReportedDomInputsDispatched: 0, rendererReportedDomEventsHandled: 0, lostSaveResponses: 0,
    operations: { acquire: 0, release: 0, effects: 0, lookup: 0, human: 0 } };
  const key = randomBytes(32).toString('hex'); const nonce = randomBytes(18).toString('base64');
  let origin = ''; let authority = '';
  function publicState(): LocalWebDocument { return { documentId: documentId ?? '', sessionId, epoch: state.epoch, surfaceId, revision: state.revision, app: structuredClone(state.app) }; }
  function event(value: unknown) {
    const line = JSON.stringify(value) + '\n';
    for (const response of channels) {
      if (response.destroyed || response.writableEnded) { channels.delete(response); continue; }
      metrics.responseBodyBytes += Buffer.byteLength(line);
      if (!response.write(line)) { channels.delete(response); response.destroy(); }
    }
  }
  function publish() { event({ kind: 'state', value: publicState() }); }
  function stopReadiness() { readinessGeneration++; if (readiness) clearTimeout(readiness); readiness = null; }
  function startReadiness() {
    stopReadiness(); if (!searchDelayMs) return;
    const generation = readinessGeneration; const epoch = state.epoch;
    readiness = setTimeout(() => {
      readiness = null; if (generation !== readinessGeneration || epoch !== state.epoch || stopping) return;
      try { persist({ ...state, revision: state.revision + 1, app: { ...state.app, resultsReady: true } }); publish(); }
      catch { event({ kind: 'invalidated' }); lease = null; }
    }, searchDelayMs);
  }
  function assertDocument(value: string) {
    if (stopping || storageUncertain) fail('computer_storage_unavailable');
    if (!documentId || value !== documentId) fail('computer_stale_session');
    if (stateFile && !equal(readStored(), state)) fail('computer_stale_session');
  }
  function assertLease(value: ComputerLease) {
    if (humanOwned) fail('computer_human_owned');
    if (!lease || !equal(value, lease) || value.sessionId !== sessionId || value.epoch !== state.epoch || value.surfaceId !== surfaceId || value.fence !== fence) fail('computer_stale_lease');
    if (Date.now() >= value.expiresAt) fail('computer_lease_expired');
  }
  function nextApp(action: ComputerAction): LocalWebApp {
    const next = { ...state.app, inputCount: state.app.inputCount + 1 };
    if (action.kind === 'fill') {
      if (action.target.role !== 'textbox' || !['Query', 'Note'].includes(action.target.name)) fail('computer_action_unsupported');
      if (action.target.name === 'Query') { next.query = action.value; next.resultsReady = false; } else next.note = action.value;
    } else {
      if (action.target.role !== 'button' || !['Search', 'Save'].includes(action.target.name)) fail('computer_action_unsupported');
      if (action.target.name === 'Search') next.resultsReady = searchDelayMs === 0;
      else { next.savedNote = next.note; next.saveCount++; }
    }
    return next;
  }
  function afterAction(action: ComputerAction) {
    if (action.kind === 'fill' && action.target.name === 'Query') stopReadiness();
    if (action.kind === 'click' && action.target.name === 'Search') startReadiness();
    metrics.appCommits++; publish();
  }
  async function readBody(req: IncomingMessage): Promise<unknown> {
    if (req.headers['content-type'] !== 'application/json') throw new FixtureFailure('computer_json_required', 415);
    const declared = req.headers['content-length'];
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > 65536)) throw new FixtureFailure('computer_request_too_large', 413);
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of req) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string); length += bytes.length;
      if (length > 65536) throw new FixtureFailure('computer_request_too_large', 413); chunks.push(bytes); }
    metrics.requestBodyBytes += length;
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown; }
    catch { throw new FixtureFailure('computer_json_invalid', 400); }
  }
  function json(res: ServerResponse, value: unknown, status = 200) {
    if (res.destroyed || res.writableEnded) return;
    const data = JSON.stringify(value); metrics.responseBodyBytes += Buffer.byteLength(data);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(data);
  }
  const doc = { documentId: id };
  const server = createServer({ requestTimeout: 10000, headersTimeout: 5000, maxHeaderSize: 8192 }, (req, res) => {
    metrics.httpRequests++;
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
    const handle = async () => {
      if (stopping) throw new FixtureFailure('computer_fixture_closed', 503);
      if (req.headers.host !== authority || req.headersDistinct.host?.length !== 1) throw new FixtureFailure('computer_host_denied', 403);
      const url = new URL(req.url ?? '/', origin);
      if (url.origin !== origin || url.search || url.hash) throw new FixtureFailure('computer_route_denied', 404);
      if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/fixture.js')) {
        const content = url.pathname === '/' ? localWebComputerPageHtml(nonce) : localWebComputerPageScript(key);
        metrics.responseBodyBytes += Buffer.byteLength(content); res.writeHead(200, { 'Content-Type': url.pathname === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8' }); res.end(content); return;
      }
      if (req.method !== 'POST' || req.headers.origin !== origin || req.headersDistinct.origin?.length !== 1 || req.headersDistinct['x-fixture-key']?.length !== 1)
        throw new FixtureFailure('computer_request_denied', 403);
      const supplied = Buffer.from(String(req.headers['x-fixture-key'] ?? '')); const expected = Buffer.from(key);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new FixtureFailure('computer_request_denied', 403);
      const body = await readBody(req);
      if (url.pathname === '/api/document') {
        z.strictObject({}).parse(body); stopReadiness(); event({ kind: 'invalidated' });
        for (const channel of channels) channel.end(); channels.clear();
        for (const pending of controls.values()) { clearTimeout(pending.timer); pending.reject(new Error('computer_stale_session')); } controls.clear();
        persist({ ...state, epoch: state.epoch + 1, revision: state.revision + 1 });
        documentId = randomUUID(); surfaceId = `web-document-${state.epoch}`; lease = null; humanOwned = false; fence++;
        json(res, publicState()); return;
      }
      if (url.pathname === '/api/events') {
        const value = z.strictObject(doc).parse(body); assertDocument(value.documentId);
        if (channels.size) throw new FixtureFailure('computer_stream_busy', 409);
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' }); res.flushHeaders();
        channels.add(res); metrics.streams++; res.once('close', () => channels.delete(res)); return;
      }
      if (url.pathname === '/api/control-ack') {
        const value = z.strictObject({ ...doc, id }).parse(body); assertDocument(value.documentId);
        const pending = controls.get(value.id); if (pending) { clearTimeout(pending.timer); controls.delete(value.id); pending.resolve(); }
        json(res, {}); return;
      }
      if (url.pathname === '/api/owner') {
        const value = z.strictObject({ ...doc, human: z.boolean() }).parse(body); assertDocument(value.documentId);
        humanOwned = value.human; lease = null; fence++; json(res, {}); return;
      }
      if (url.pathname === '/api/acquire') {
        const value = z.strictObject({ ...doc, request: z.strictObject({ sessionId: id, workId: id, attemptId: id, deadlineAt: count }) }).parse(body);
        assertDocument(value.documentId); metrics.operations.acquire++;
        if (value.request.sessionId !== sessionId) fail('computer_session_mismatch'); if (humanOwned) fail('computer_human_owned');
        if (value.request.deadlineAt <= Date.now()) fail('computer_lease_expired');
        if (lease && lease.expiresAt > Date.now()) {
          if (lease.workId !== value.request.workId || lease.attemptId !== value.request.attemptId) fail('computer_session_busy');
        } else lease = { sessionId, epoch: state.epoch, surfaceId, fence: ++fence, workId: value.request.workId,
          attemptId: value.request.attemptId, expiresAt: value.request.deadlineAt };
        json(res, lease); return;
      }
      if (url.pathname === '/api/release') {
        const value = z.strictObject({ ...doc, lease: ComputerLeaseSchema }).parse(body); assertDocument(value.documentId); metrics.operations.release++;
        if (!humanOwned && equal(value.lease, lease)) { lease = null; fence++; } json(res, {}); return;
      }
      if (url.pathname === '/api/lookup') {
        const value = z.strictObject({ ...doc, lease: ComputerLeaseSchema, request: z.strictObject({ identity: ComputerOperationIdentitySchema }) }).parse(body);
        assertDocument(value.documentId); assertLease(value.lease); metrics.operations.lookup++;
        const identity = value.request.identity;
        if (identity.workId !== value.lease.workId || identity.sessionId !== sessionId) { json(res, { status: 'unknown', receipt: null, reason: 'computer_operation_scope_mismatch', usage: cost() }); return; }
        const canonical = stateFile ? readStored() : state;
        const receipt = canonical.receipts.find(item => keyOf(item.identity) === keyOf(identity));
        json(res, receipt && equal(receipt.identity, identity) ? { status: 'found', receipt, reason: null, usage: cost() }
          : { status: 'unknown', receipt: null, reason: receipt ? 'computer_operation_conflict' : 'computer_operation_unrecorded', usage: cost() }); return;
      }
      if (url.pathname === '/api/effect') {
        const value = z.strictObject({ ...doc, lease: ComputerLeaseSchema, identity: ComputerOperationIdentitySchema, deadlineAt: count,
          domInputsDispatched: count, domEventsHandled: count }).parse(body);
        assertDocument(value.documentId); assertLease(value.lease); metrics.operations.effects++;
        const identity = value.identity;
        if (identity.sessionId !== sessionId || identity.workId !== value.lease.workId || identity.attemptId !== value.lease.attemptId ||
            identity.epoch !== state.epoch || identity.surfaceId !== surfaceId || Date.now() >= value.deadlineAt) fail('computer_stale_operation');
        const prior = state.receipts.find(item => keyOf(item.identity) === keyOf(identity));
        if (prior) { if (!equal(prior.identity, identity)) fail('computer_operation_conflict'); json(res, publicState()); return; }
        if (state.receipts.length >= 256) fail('computer_receipt_limit');
        const next = nextApp(identity.action);
        const receipt: ComputerOperationReceipt = { schemaVersion: 1, kind: 'computer_operation_receipt', driver: LOCAL_WEB_COMPUTER_IDENTITY,
          identity, outcome: 'applied', decidedAt: Date.now(), effectSequence: next.inputCount };
        persist({ ...state, revision: state.revision + 1, app: next, receipts: [...state.receipts, receipt] });
        metrics.rendererReportedDomInputsDispatched = Math.max(metrics.rendererReportedDomInputsDispatched, value.domInputsDispatched);
        metrics.rendererReportedDomEventsHandled = Math.max(metrics.rendererReportedDomEventsHandled, value.domEventsHandled);
        afterAction(identity.action);
        const injection = faults[0];
        if (identity.action.kind === 'click' && identity.action.target.name === 'Save' && injection?.loseResponseAfterSave) {
          faults.shift(); metrics.lostSaveResponses++;
          // End an incomplete JSON response after the durable commit. A pre-header socket close
          // can be retried transparently by the browser and does not reliably model a lost response.
          const partial = '{"documentId":'; metrics.responseBodyBytes += Buffer.byteLength(partial);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(partial); return;
        }
        json(res, publicState()); return;
      }
      if (url.pathname === '/api/human') {
        const value = z.strictObject({ ...doc, action: ComputerActionSchema }).parse(body); assertDocument(value.documentId); metrics.operations.human++;
        humanOwned = true; lease = null; fence++;
        persist({ ...state, revision: state.revision + 1, app: nextApp(value.action) }); afterAction(value.action); json(res, publicState()); return;
      }
      throw new FixtureFailure('computer_route_denied', 404);
    };
    void handle().catch(error => {
      const failure = error instanceof FixtureFailure ? error : new FixtureFailure(error instanceof z.ZodError ? 'computer_request_invalid' : 'computer_fixture_failure', error instanceof z.ZodError ? 400 : 500);
      json(res, { error: failure.code }, failure.status);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('computer_fixture_address');
  authority = `127.0.0.1:${address.port}`; origin = `http://${authority}`;
  return {
    url: origin + '/', identity: LOCAL_WEB_COMPUTER_IDENTITY,
    snapshot: () => structuredClone({ app: state.app, ...state.app, version: state.version, epoch: state.epoch, revision: state.revision, sessionId, surfaceId,
      documentId, owner: humanOwned ? 'human' : lease ? 'agent' : 'available', lease, receipts: state.receipts,
      metrics, storageUncertain, nativeOsInput: false, automation: 'typed-dom', rendererCountsMeaning: 'last received per-document reports; not global native input counts' }),
    injectNextAction(injection: LocalWebComputerActionFault): void {
      const value = z.strictObject({ loseResponseAfterSave: z.literal(true) }).parse(injection);
      if (faults.length >= 16) throw new Error('computer_fault_limit'); faults.push(value);
    },
    async control(value: LocalWebControl): Promise<void> {
      if (stopping || channels.size !== 1 || !documentId) throw new Error('computer_document_unavailable');
      if (controls.size >= 16) throw new Error('computer_control_limit');
      if (value.kind === 'handoff' || value.kind === 'reclaim') { humanOwned = value.kind === 'handoff'; lease = null; fence++; }
      const operation = randomUUID();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { controls.delete(operation); reject(new Error('computer_control_unconfirmed')); }, 5000);
        controls.set(operation, { resolve, reject, timer }); event({ kind: 'control', id: operation, value });
      });
    },
    async close(): Promise<void> {
      if (stopping) return; stopping = true; stopReadiness(); lease = null;
      for (const pending of controls.values()) { clearTimeout(pending.timer); pending.reject(new Error('computer_fixture_closed')); } controls.clear();
      event({ kind: 'invalidated' }); for (const response of channels) response.end(); channels.clear();
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); server.closeAllConnections(); await closed;
    },
  };
}
