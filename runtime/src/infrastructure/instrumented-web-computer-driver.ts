import type { ComputerDriver, ComputerActionResult, ComputerObservationResult, ComputerWaitResult } from '../application/computer-use-ports.js';
import type { ComputerLease } from '../domain/computer-use.js';
import type { ComputerOperationLookupResult } from '../domain/computer-operation.js';
import { ComputerActionSchema, ComputerLeaseSchema, ComputerViewSchema, ComputerActionResultSchema, ComputerObservationResultSchema, ComputerWaitResultSchema } from '../application/computer-use-contracts.js';
import { computerOperationIdentity, ComputerOperationIdentitySchema, ComputerOperationLookupResultSchema } from '../application/computer-operation-contracts.js';

export type WebComputerCommand =
  | { kind: 'acquire'; request: Parameters<ComputerDriver['acquire']>[0] }
  | { kind: 'observe'; lease: ComputerLease; request: Parameters<ComputerDriver['observe']>[1] }
  | { kind: 'act'; lease: ComputerLease; request: Parameters<ComputerDriver['act']>[1] }
  | { kind: 'wait'; lease: ComputerLease; request: Parameters<ComputerDriver['wait']>[1] }
  | { kind: 'lookup'; lease: ComputerLease; request: { identity: Parameters<NonNullable<ComputerDriver['lookup']>>[1]['identity'] } }
  | { kind: 'release'; lease: ComputerLease };

/** A host-installed, typed protocol. Neither JavaScript nor a navigation URL is a model argument. */
export interface InstrumentedWebTransport { request(command: WebComputerCommand, signal: AbortSignal): Promise<unknown> }
const usage = () => ({ transportCalls: 1, internalOperations: 0, imageBytes: 0, waitMs: 0 });
const uncertainUsage = () => ({ transportCalls: 1, internalOperations: null, imageBytes: 0, waitMs: null });
const maximumResponseBytes = 128 * 1024;

function checkedBody(value: unknown): unknown {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > maximumResponseBytes) throw new Error('computer_web_response_limit');
  return value;
}
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

/** DOM automation for an instrumented app, not native OS input or a general-site driver. */
export class InstrumentedWebComputerDriver implements ComputerDriver {
  readonly identity = Object.freeze({ id: 'instrumented-web-document-app', version: '1' });
  readonly inputAssurance = 'renderer-gated-dom-v1' as const;
  readonly #transport: InstrumentedWebTransport;
  readonly #operations = new Map<string, { digest: string; result: Promise<ComputerActionResult> }>();
  constructor(transport: InstrumentedWebTransport) { this.#transport = transport; }

  async acquire(request: Parameters<ComputerDriver['acquire']>[0], signal: AbortSignal): Promise<ComputerLease> {
    request = structuredClone(request);
    if (signal.aborted) throw new Error('computer_cancelled');
    const lease = ComputerLeaseSchema.parse(checkedBody(await this.#transport.request({ kind: 'acquire', request }, signal)));
    if (lease.sessionId !== request.sessionId || lease.workId !== request.workId || lease.attemptId !== request.attemptId || lease.expiresAt > request.deadlineAt)
      throw new Error('computer_web_lease_mismatch');
    return lease;
  }
  async observe(lease: ComputerLease, request: Parameters<ComputerDriver['observe']>[1], signal: AbortSignal): Promise<ComputerObservationResult> {
    lease = ComputerLeaseSchema.parse(lease); request = structuredClone(request);
    if (signal.aborted) throw new Error('computer_cancelled');
    const result = ComputerObservationResultSchema.parse(checkedBody(await this.#transport.request({ kind: 'observe', lease, request }, signal)));
    if (result.view.sessionId !== lease.sessionId || result.view.epoch !== lease.epoch || result.view.surfaceId !== lease.surfaceId)
      throw new Error('computer_web_view_mismatch');
    if (result.view.elements.length > request.maxElements || Buffer.byteLength(JSON.stringify(result.view)) > request.maxBytes)
      throw new Error('computer_observation_limit');
    return result;
  }
  async act(lease: ComputerLease, request: Parameters<ComputerDriver['act']>[1], signal: AbortSignal, authorizeInput: () => Promise<void>): Promise<ComputerActionResult> {
    const rejected = (reason: string): ComputerActionResult => ({ operationId: request.operationId, status: 'not_applied', reason, usage: { ...usage(), transportCalls: 0 } });
    try {
      lease = ComputerLeaseSchema.parse(lease); request = structuredClone(request);
      request.basis = ComputerViewSchema.parse(request.basis); request.action = ComputerActionSchema.parse(request.action);
      if (!Number.isSafeInteger(request.deadlineAt) || request.deadlineAt < 0) throw new Error('computer_deadline_invalid');
    }
    catch { return rejected('computer_web_request_invalid'); }
    let operation;
    try { operation = computerOperationIdentity(lease, request); }
    catch { return rejected('computer_operation_invalid'); }
    const key = JSON.stringify([operation.sessionId, operation.epoch, operation.workId, operation.attemptId, operation.operationId]);
    const digest = JSON.stringify({ lease, request });
    const previous = this.#operations.get(key);
    if (previous) return previous.digest === digest ? structuredClone(await previous.result) : { ...rejected('computer_operation_conflict'), status: 'unknown' };
    if (this.#operations.size >= 256) return rejected('computer_receipt_limit');
    let resolve!: (result: ComputerActionResult) => void;
    const result = new Promise<ComputerActionResult>(done => { resolve = done; });
    this.#operations.set(key, { digest, result });
    let sent = false;
    try {
      if (signal.aborted) { resolve(rejected('computer_cancelled')); return structuredClone(await result); }
      try { await authorizeInput(); }
      catch { resolve(rejected('computer_input_authorization_failed')); return structuredClone(await result); }
      if (signal.aborted) { resolve(rejected('computer_cancelled')); return structuredClone(await result); }
      // Authority is sampled here. The renderer checks its grant and DOM synchronously;
      // cancellation after this RPC starts cannot establish that no DOM input occurred.
      sent = true;
      const response = ComputerActionResultSchema.parse(checkedBody(await this.#transport.request({ kind: 'act', lease, request }, signal)));
      if (response.operationId !== request.operationId) throw new Error('computer_web_operation_mismatch');
      resolve(response);
    } catch {
      resolve({ operationId: request.operationId, status: sent ? 'unknown' : 'not_applied', reason: 'computer_web_transport_uncertain', usage: sent ? uncertainUsage() : { ...usage(), transportCalls: 0 } });
    }
    return structuredClone(await result);
  }
  async wait(lease: ComputerLease, request: Parameters<ComputerDriver['wait']>[1], signal: AbortSignal): Promise<ComputerWaitResult> {
    lease = ComputerLeaseSchema.parse(lease); request = structuredClone(request);
    if (signal.aborted) return { status: 'interrupted', usage: { ...usage(), transportCalls: 0 } };
    return ComputerWaitResultSchema.parse(checkedBody(await this.#transport.request({ kind: 'wait', lease, request }, signal)));
  }
  async lookup(lease: ComputerLease, request: Parameters<NonNullable<ComputerDriver['lookup']>>[1], signal: AbortSignal, authorizeRead: () => Promise<void>): Promise<ComputerOperationLookupResult> {
    lease = ComputerLeaseSchema.parse(lease); request = { identity: ComputerOperationIdentitySchema.parse(request.identity) };
    if (request.identity.workId !== lease.workId || request.identity.sessionId !== lease.sessionId) throw new Error('computer_operation_scope_mismatch');
    await authorizeRead();
    if (signal.aborted) throw new Error('computer_cancelled');
    const result = ComputerOperationLookupResultSchema.parse(checkedBody(await this.#transport.request({ kind: 'lookup', lease, request }, signal)));
    if (result.status === 'found' && (!same(result.receipt.identity, request.identity) || !same(result.receipt.driver, this.identity)))
      throw new Error('computer_web_receipt_mismatch');
    return result;
  }
  async release(lease: ComputerLease): Promise<void> {
    lease = ComputerLeaseSchema.parse(lease);
    await this.#transport.request({ kind: 'release', lease }, AbortSignal.timeout(2000));
  }
}

export interface WebComputerPageRequest { command: WebComputerCommand; origin: string; pathname: string }
export interface WebComputerPage {
  url(): string;
  evaluate(fn: (argument: WebComputerPageRequest) => Promise<unknown>, argument: WebComputerPageRequest): Promise<unknown>;
}

/** Inject a Page from the host's installed Playwright. This module does not launch or navigate browsers. */
export function createPlaywrightWebComputerTransport(page: WebComputerPage, fixtureUrl: string): InstrumentedWebTransport {
  const allowed = new URL(fixtureUrl);
  if (allowed.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(allowed.hostname) || !allowed.port || allowed.username || allowed.password || allowed.search || allowed.hash)
    throw new Error('computer_web_local_origin_required');
  return {
    async request(command, signal) {
      if (signal.aborted) throw new Error('computer_cancelled');
      const current = new URL(page.url());
      if (current.origin !== allowed.origin || current.pathname !== allowed.pathname) throw new Error('computer_web_navigation_changed');
      let onAbort!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => { reject(new Error('computer_web_rpc_interrupted')); };
        signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        const pending = page.evaluate(async argument => {
          if (location.origin !== argument.origin || location.pathname !== argument.pathname) throw new Error('computer_web_navigation_changed');
          const bridge = (window as unknown as { secumonComputer?: { request(command: WebComputerCommand): Promise<unknown> } }).secumonComputer;
          if (!bridge || typeof bridge.request !== 'function') throw new Error('computer_web_bridge_missing');
          return bridge.request(argument.command);
        }, { command, origin: allowed.origin, pathname: allowed.pathname });
        // Do not retry or claim cancellation of the browser-side promise when the host stops waiting.
        return await Promise.race([pending, aborted]);
      } finally { signal.removeEventListener('abort', onAbort); }
    },
  };
}
