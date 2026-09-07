import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import type { Clock } from '../application/ports.js';
import type { ComputerActionResult, ComputerDriver, ComputerObservationResult, ComputerWaitResult } from '../application/computer-use-ports.js';
import type { ComputerAction, ComputerElement, ComputerLease, ComputerView } from '../domain/computer-use.js';
import type { ComputerOperationIdentity, ComputerOperationLookupResult, ComputerOperationReceipt } from '../domain/computer-operation.js';
import { computerOperationIdentity, ComputerOperationIdentitySchema, ComputerOperationReceiptSchema } from '../application/computer-operation-contracts.js';
import { ComputerActionSchema, ComputerLeaseSchema, ComputerViewSchema } from '../application/computer-use-contracts.js';

type Usage = { transportCalls: number; internalOperations: number; imageBytes: number; waitMs: number };
const emptyUsage = (): Usage => ({ transportCalls: 0, internalOperations: 0, imageBytes: 0, waitMs: 0 });
function integer(value: number, minimum = 0): boolean { return Number.isSafeInteger(value) && value >= minimum; }

/** Test-host virtual time. No wall-clock sleeps, external timers or actual GUI are used. */
export class SyntheticComputerClock implements Clock {
  #time: number;
  #listeners = new Set<() => void>();
  #scheduled = new Map<number, { at: number; run: () => void }>();
  #sequence = 0;
  constructor(start = 0) { if (!integer(start)) throw new Error('invalid_clock_start'); this.#time = start; }
  now(): number { return this.#time; }
  subscribe(listener: () => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  schedule(at: number, run: () => void): () => void {
    if (!integer(at) || at < this.#time) throw new Error('invalid_clock_schedule');
    const id = ++this.#sequence; this.#scheduled.set(id, { at, run }); return () => { this.#scheduled.delete(id); };
  }
  advance(milliseconds: number): void {
    if (!integer(milliseconds) || !integer(this.#time + milliseconds)) throw new Error('invalid_clock_advance');
    const end = this.#time + milliseconds;
    for (;;) {
      const next = [...this.#scheduled].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.#time = next[1].at; this.#scheduled.delete(next[0]); next[1].run();
      for (const listener of [...this.#listeners]) listener();
    }
    this.#time = end; for (const listener of [...this.#listeners]) listener();
  }
}

interface AppState { query: string; note: string; resultsReady: boolean; savedNote: string; saveCount: number; inputCount: number }
interface PersistedState { version: 2; epoch: number; app: AppState; receipts: ComputerOperationReceipt[] }
const maxReceipts = 256;
const maxStateBytes = 16 * 1024 * 1024;
const operationKey = (identity: ComputerOperationIdentity): string => JSON.stringify([
  identity.sessionId, identity.epoch, identity.workId, identity.attemptId, identity.operationId,
]);
const sameIdentity = (left: ComputerOperationIdentity, right: ComputerOperationIdentity): boolean => JSON.stringify(left) === JSON.stringify(right);
export interface SyntheticComputerAppliedEvent { operationId: string; action: ComputerAction; workId: string; attemptId: string; inputCount: number; saveCount: number }
export interface SyntheticComputerOptions {
  clock?: SyntheticComputerClock;
  sessionId?: string;
  /** One test host owns this file. App contents survive a killed child; this is not a cross-process session lock. */
  stateFile?: string;
  /** Refuse new inputs when full; receipts are never silently evicted. */
  receiptLimit?: number;
  searchDelayMs?: number;
  /** Host-only crash marker, after app and receipt are durable and before the action response. */
  onActApplied?: (event: SyntheticComputerAppliedEvent) => void;
}
export interface SyntheticComputerMutation {
  query?: string; note?: string; resultsReady?: boolean;
  elements?: ComputerElement[]; focused?: boolean; surfaceId?: string; rerender?: boolean;
}
export interface SyntheticComputerInjection {
  delayBeforeInputMs?: number;
  outcome?: 'applied_unknown' | 'not_applied_timeout';
  /** Test hook runs before the final synchronous validation, never after validation and before input. */
  beforeInput?: () => void;
}
interface Invocation { operationId: string; workId: string; attemptId: string; status: ComputerActionResult['status']; reason: string | null; inputCount: number }
type ActRequest = Parameters<ComputerDriver['act']>[1];
interface Operation { digest: string; response: Promise<ComputerActionResult> }

/** A deterministic document-app fixture. Its ownership guarantee is limited to this driver instance. */
export class SyntheticComputerDriver implements ComputerDriver {
  readonly identity = Object.freeze({ id: 'synthetic-document-app', version: '2' });
  readonly clock: SyntheticComputerClock;
  readonly sessionId: string;
  #stateFile: string | undefined;
  #onActApplied: SyntheticComputerOptions['onActApplied'];
  #searchDelayMs: number;
  #app: AppState;
  #receipts: ComputerOperationReceipt[];
  #receiptLimit: number;
  #storageUncertain = false;
  #epoch: number;
  #surfaceId = 'synthetic-document-window';
  #revision = 0;
  #focusRevision = 0;
  #focused = true;
  #humanOwned = false;
  #fence = 0;
  #lease: ComputerLease | null = null;
  #elements: ComputerElement[];
  #usage = emptyUsage();
  #sessionCalls = { acquire: 0, release: 0 };
  #listeners = new Set<() => void>();
  #injections: SyntheticComputerInjection[] = [];
  #operations = new Map<string, Operation>();
  #invocations: Invocation[] = [];
  #invocationsOmitted = 0;
  #cancelReadiness: (() => void) | null = null;

  constructor(options: SyntheticComputerOptions = {}) {
    this.clock = options.clock ?? new SyntheticComputerClock(); this.sessionId = options.sessionId ?? 'synthetic-document';
    if (!this.sessionId || this.sessionId.length > 256) throw new Error('invalid_synthetic_session');
    this.#stateFile = options.stateFile; this.#onActApplied = options.onActApplied; this.#searchDelayMs = options.searchDelayMs ?? 0;
    if (!integer(this.#searchDelayMs)) throw new Error('invalid_search_delay');
    this.#receiptLimit = options.receiptLimit ?? maxReceipts;
    if (!integer(this.#receiptLimit, 1) || this.#receiptLimit > maxReceipts) throw new Error('invalid_receipt_limit');
    const stored = this.#stateFile && existsSync(this.#stateFile) ? this.#readStored() : null;
    this.#app = stored?.app ?? { query: '', note: '', resultsReady: false, savedNote: '', saveCount: 0, inputCount: 0 };
    this.#receipts = stored?.receipts ?? [];
    this.#epoch = stored ? stored.epoch + 1 : randomInt(1, 2 ** 48);
    if (!integer(this.#epoch, 1)) throw new Error('synthetic_epoch_exhausted');
    this.#elements = this.#defaultElements(); this.#persist(this.#app, this.#receipts, true);
  }

  snapshot() {
    return structuredClone({ ...this.#app, sessionId: this.sessionId, epoch: this.#epoch, surfaceId: this.#surfaceId,
      viewRevision: this.#revision, focusRevision: this.#focusRevision, focused: this.#focused, fence: this.#fence,
      owner: this.#humanOwned ? 'human' : this.#lease ? 'agent' : 'available', lease: this.#lease,
      usage: this.#usage, sessionCalls: this.#sessionCalls, invocations: this.#invocations, invocationsOmitted: this.#invocationsOmitted, elements: this.#elements });
  }
  injectNextAction(injection: SyntheticComputerInjection): void {
    if (injection.delayBeforeInputMs !== undefined && !integer(injection.delayBeforeInputMs)) throw new Error('invalid_action_delay');
    this.#injections.push({ ...injection });
  }
  mutate(change: SyntheticComputerMutation): void {
    const next = { ...this.#app };
    if (change.query !== undefined) { next.query = change.query; next.resultsReady = false; this.#cancelReadiness?.(); this.#cancelReadiness = null; }
    if (change.note !== undefined) next.note = change.note;
    if (change.resultsReady !== undefined) next.resultsReady = change.resultsReady;
    this.#persist(next); this.#app = next;
    if (change.focused !== undefined) { this.#focused = change.focused; this.#focusRevision++; }
    if (change.surfaceId !== undefined) { this.#surfaceId = change.surfaceId; this.#focusRevision++; }
    this.#revision++;
    if (change.elements) this.#elements = structuredClone(change.elements);
    else if (change.rerender) this.#elements = this.#defaultElements();
    this.#syncValues(); this.#notify();
  }
  handoff(): void { this.#humanOwned = true; this.#focused = false; this.#invalidateSession(); }
  reclaim(): void { this.#humanOwned = false; this.#focused = true; this.#invalidateSession(); }
  restart(): void { this.#cancelReadiness?.(); this.#cancelReadiness = null; this.#invalidateSession(); this.#elements = this.#defaultElements(); }

  async acquire(request: Parameters<ComputerDriver['acquire']>[0], signal: AbortSignal): Promise<ComputerLease> {
    this.#sessionCalls.acquire++;
    if (signal.aborted) throw new Error('computer_cancelled');
    if (request.sessionId !== this.sessionId) throw new Error('computer_session_mismatch');
    if (!request.workId || !request.attemptId || !integer(request.deadlineAt) || request.deadlineAt <= this.clock.now()) throw new Error('computer_lease_expired');
    if (this.#humanOwned) throw new Error('computer_human_owned');
    if (this.#lease && this.#lease.expiresAt > this.clock.now()) {
      if (this.#lease.workId !== request.workId || this.#lease.attemptId !== request.attemptId) throw new Error('computer_session_busy');
      return structuredClone(this.#lease);
    }
    this.#lease = { sessionId: this.sessionId, epoch: this.#epoch, surfaceId: this.#surfaceId, fence: ++this.#fence,
      workId: request.workId, attemptId: request.attemptId, expiresAt: request.deadlineAt };
    this.#notify(); return structuredClone(this.#lease);
  }
  async release(lease: ComputerLease): Promise<void> {
    this.#sessionCalls.release++;
    if (!this.#humanOwned && this.#sameLease(lease)) { this.#lease = null; this.#fence++; this.#notify(); }
  }
  async observe(lease: ComputerLease, request: Parameters<ComputerDriver['observe']>[1], signal: AbortSignal): Promise<ComputerObservationResult> {
    const usage = this.#beginCall(); this.#operation(usage);
    const invalid = this.#leaseError(lease, signal); if (invalid) throw new Error(invalid);
    this.#assertStorage();
    if (!integer(request.maxElements, 1) || !integer(request.maxBytes, 1)) throw new Error('computer_observation_limit');
    const view = this.#view();
    while (view.elements.length > request.maxElements || Buffer.byteLength(JSON.stringify(view)) > request.maxBytes) {
      if (!view.elements.length) throw new Error('computer_observation_limit');
      view.elements.pop(); view.partial = true; view.omittedCount++;
    }
    return { view, usage };
  }
  async act(lease: ComputerLease, request: ActRequest, signal: AbortSignal, authorizeInput: () => Promise<void>): Promise<ComputerActionResult> {
    const usage = this.#beginCall();
    let identity: ComputerOperationIdentity;
    const action = ComputerActionSchema.safeParse(request.action);
    if (!action.success) return this.#result(lease, request, 'not_applied', 'computer_action_unsupported', usage);
    const view = ComputerViewSchema.safeParse(request.basis);
    if (!view.success) return this.#result(lease, request, 'not_applied', 'computer_view_invalid', usage);
    try {
      lease = ComputerLeaseSchema.parse(lease);
      request = { operationId: request.operationId, basis: view.data, targetRef: request.targetRef, action: action.data, deadlineAt: request.deadlineAt };
      identity = computerOperationIdentity(lease, request);
    }
    catch { return this.#result(lease, request, 'not_applied', 'computer_operation_invalid', usage); }
    const key = operationKey(identity);
    const digest = JSON.stringify({ lease, request }); const previous = this.#operations.get(key);
    if (previous) {
      if (previous.digest !== digest) return this.#result(lease, request, 'unknown', 'computer_operation_conflict', usage);
      const response = await previous.response; return { ...structuredClone(response), usage };
    }
    if (this.#receipts.some(receipt => operationKey(receipt.identity) === key))
      return this.#result(lease, request, 'unknown', 'computer_operation_conflict', usage);
    if (this.#receipts.length >= this.#receiptLimit || this.#operations.size >= maxReceipts)
      return this.#result(lease, request, 'not_applied', 'computer_receipt_limit', usage);
    // Register before any host callback/await so a concurrent retry joins this operation.
    let resolve!: (value: ComputerActionResult) => void;
    const response = new Promise<ComputerActionResult>(done => { resolve = done; }); this.#operations.set(key, { digest, response });
    const injection = this.#injections.shift();
    let effectStarted = false;
    const reject = (reason: string): ComputerActionResult => {
      const prior = this.#receipts.find(receipt => operationKey(receipt.identity) === key);
      if (prior) return this.#result(lease, request, 'unknown', 'computer_operation_conflict', usage);
      if (this.#receipts.length < this.#receiptLimit && identity.epoch <= this.#epoch && identity.sessionId === this.sessionId) {
        const receipts = [...this.#receipts, this.#receipt(identity, 'not_applied', this.#app.inputCount)];
        this.#persist(this.#app, receipts); this.#receipts = receipts;
      }
      return this.#result(lease, request, 'not_applied', reason, usage);
    };
    try {
      if (injection?.delayBeforeInputMs) await this.#delay(lease, injection.delayBeforeInputMs, request.deadlineAt, signal, usage);
      injection?.beforeInput?.();
      try { await authorizeInput(); }
      catch {
        resolve(reject('computer_input_authorization_failed'));
        return structuredClone(await response);
      }
      // No await or host callback is permitted between this check and the synthetic input commit.
      this.#operation(usage);
      const invalid = this.#inputError(lease, request, signal);
      this.#assertStorage();
      const prior = this.#receipts.find(receipt => operationKey(receipt.identity) === key);
      if (prior) resolve(this.#result(lease, request, 'unknown', 'computer_operation_conflict', usage));
      else if (invalid) { resolve(reject(invalid)); }
      else if (this.#receipts.length >= this.#receiptLimit) { resolve(this.#result(lease, request, 'not_applied', 'computer_receipt_limit', usage)); }
      else if (injection?.outcome === 'not_applied_timeout') { resolve(reject('computer_input_timeout')); }
      else {
        const next = this.#nextApp(request.action);
        const receipts = [...this.#receipts, this.#receipt(identity, 'applied', next.inputCount)];
        effectStarted = true; this.#persist(next, receipts); this.#app = next; this.#receipts = receipts;
        this.#revision++; this.#focusRevision++; this.#syncValues();
        if (request.action.kind === 'fill' && request.action.target.name === 'Query') { this.#cancelReadiness?.(); this.#cancelReadiness = null; }
        if (request.action.kind === 'click' && request.action.target.name === 'Search') this.#startSearch();
        this.#onActApplied?.({ operationId: request.operationId, action: structuredClone(request.action), workId: lease.workId,
          attemptId: lease.attemptId, inputCount: this.#app.inputCount, saveCount: this.#app.saveCount });
        this.#notify();
        resolve(this.#result(lease, request, injection?.outcome === 'applied_unknown' ? 'unknown' : 'applied',
          injection?.outcome === 'applied_unknown' ? 'computer_response_unknown' : null, usage));
      }
    } catch {
      this.#notify();
      if (!effectStarted) {
        try { resolve(reject('computer_driver_failure')); }
        catch { resolve(this.#result(lease, request, 'not_applied', 'computer_driver_failure', usage)); }
      } else resolve(this.#result(lease, request, 'unknown', 'computer_driver_failure', usage));
    }
    return structuredClone(await response);
  }
  async lookup(lease: ComputerLease, request: { identity: ComputerOperationIdentity }, signal: AbortSignal,
    authorizeRead: () => Promise<void>): Promise<ComputerOperationLookupResult> {
    const usage = this.#beginCall(); this.#operation(usage);
    const unknown = (reason: string): ComputerOperationLookupResult => ({ status: 'unknown', receipt: null, reason, usage });
    let identity: ComputerOperationIdentity;
    try { lease = structuredClone(lease); identity = ComputerOperationIdentitySchema.parse(request.identity); }
    catch { return unknown('computer_operation_invalid'); }
    const guard = (): string | null => this.#leaseError(lease, signal)
      ?? (identity.workId !== lease.workId || identity.sessionId !== this.sessionId ? 'computer_operation_scope_mismatch' : null);
    const invalid = guard(); if (invalid) return unknown(invalid);
    try { await authorizeRead(); } catch { return unknown('computer_read_authorization_failed'); }
    const changed = guard(); if (changed) return unknown(changed);
    try {
      // The file is authoritative even if an acknowledgement was lost after rename.
      const stored = this.#stateFile ? this.#readStored() : null;
      if (stored && stored.epoch !== this.#epoch) return unknown('computer_stale_session');
      const receipts = stored?.receipts ?? this.#receipts;
      const receipt = receipts.find(item => operationKey(item.identity) === operationKey(identity));
      if (!receipt) return unknown('computer_operation_unrecorded');
      if (!sameIdentity(receipt.identity, identity)) return unknown('computer_operation_conflict');
      return { status: 'found', receipt: structuredClone(receipt), reason: null, usage };
    } catch { return unknown('computer_receipt_unavailable'); }
  }
  async wait(lease: ComputerLease, request: Parameters<ComputerDriver['wait']>[1], signal: AbortSignal): Promise<ComputerWaitResult> {
    const usage = this.#beginCall(); const start = this.clock.now();
    if (!integer(request.afterRevision) || !integer(request.maxWaitMs) || !integer(request.deadlineAt)) throw new Error('invalid_computer_wait');
    const end = Math.min(start + request.maxWaitMs, request.deadlineAt, lease.expiresAt);
    return new Promise(resolve => {
      let finished = false; let unsubscribeClock = () => {}; let cancelTimer = () => {};
      const check = () => {
        if (finished) return; this.#operation(usage);
        const invalid = this.#leaseError(lease, signal) ?? this.#storageError();
        const status = invalid && invalid !== 'computer_lease_expired' ? 'interrupted' : this.clock.now() >= end ? 'timeout'
          : invalid ? 'interrupted' : this.#revision !== request.afterRevision ? 'changed' : null;
        if (!status) return;
        finished = true; this.#listeners.delete(check); unsubscribeClock(); cancelTimer(); signal.removeEventListener('abort', check);
        this.#elapsed(usage, this.clock.now() - start); resolve({ status, usage });
      };
      this.#listeners.add(check); unsubscribeClock = this.clock.subscribe(check); signal.addEventListener('abort', check, { once: true });
      if (end >= this.clock.now()) cancelTimer = this.clock.schedule(end, check);
      check();
    });
  }

  #defaultElements(): ComputerElement[] {
    return [['Query', 'textbox'], ['Search', 'button'], ['Note', 'textbox'], ['Save', 'button']].map(([name, role], index) =>
      ({ ref: `e${this.#epoch}-${this.#revision}-${index}`, role: role!, name: name!, value: role === 'textbox' ? name === 'Query' ? this.#app.query : this.#app.note : null, visible: true, enabled: true }));
  }
  #syncValues(): void { for (const element of this.#elements) { if (element.role === 'textbox' && element.name === 'Query') element.value = this.#app.query; if (element.role === 'textbox' && element.name === 'Note') element.value = this.#app.note; } }
  #view(): ComputerView {
    return { sessionId: this.sessionId, epoch: this.#epoch, surfaceId: this.#surfaceId, revision: this.#revision,
      focusRevision: this.#focusRevision, observedAt: this.clock.now(), elements: structuredClone(this.#elements),
      facts: { resultsReady: this.#app.resultsReady, savedNote: this.#app.savedNote, saveCount: this.#app.saveCount }, partial: false, omittedCount: 0 };
  }
  #sameLease(lease: ComputerLease): boolean {
    return this.#lease !== null && (['sessionId', 'epoch', 'surfaceId', 'fence', 'workId', 'attemptId', 'expiresAt'] as const).every(key => lease[key] === this.#lease![key]);
  }
  #leaseError(lease: ComputerLease, signal: AbortSignal): string | null {
    if (signal.aborted) return 'computer_cancelled';
    if (this.#humanOwned) return 'computer_human_owned';
    if (!this.#sameLease(lease) || lease.sessionId !== this.sessionId || lease.epoch !== this.#epoch || lease.surfaceId !== this.#surfaceId || lease.fence !== this.#fence) return 'computer_stale_lease';
    if (this.clock.now() >= lease.expiresAt) return 'computer_lease_expired';
    return null;
  }
  #inputError(lease: ComputerLease, request: ActRequest, signal: AbortSignal): string | null {
    const invalid = this.#leaseError(lease, signal); if (invalid) return invalid;
    if (!integer(request.deadlineAt) || this.clock.now() >= request.deadlineAt) return 'computer_deadline';
    const basis = request.basis;
    if (!this.#focused || basis.focusRevision !== this.#focusRevision) return 'computer_focus_changed';
    if (basis.sessionId !== this.sessionId || basis.epoch !== this.#epoch || basis.surfaceId !== this.#surfaceId || basis.revision !== this.#revision || basis.observedAt > this.clock.now()) return 'computer_stale_view';
    const matching = this.#elements.filter(element => element.role === request.action.target.role && element.name === request.action.target.name);
    const observed = basis.elements.filter(element => element.ref === request.targetRef);
    if (matching.length !== 1) return 'computer_target_ambiguous';
    const target = matching[0]!;
    if (observed.length !== 1 || target.ref !== request.targetRef || observed[0]!.role !== target.role || observed[0]!.name !== target.name || !observed[0]!.visible || !observed[0]!.enabled) return 'computer_target_changed';
    if (!target.visible || !target.enabled) return 'computer_target_unavailable';
    if (request.action.kind === 'fill' && (target.role !== 'textbox' || !['Query', 'Note'].includes(target.name) || typeof request.action.value !== 'string' || request.action.value.length > 8192)) return 'computer_action_unsupported';
    if (request.action.kind === 'click' && (target.role !== 'button' || !['Search', 'Save'].includes(target.name))) return 'computer_action_unsupported';
    if (request.action.kind !== 'click' && request.action.kind !== 'fill') return 'computer_action_unsupported';
    return null;
  }
  #nextApp(action: ComputerAction): AppState {
    const app = { ...this.#app, inputCount: this.#app.inputCount + 1 };
    if (action.kind === 'fill') { if (action.target.name === 'Query') { app.query = action.value; app.resultsReady = false; } else app.note = action.value; }
    else if (action.target.name === 'Search') app.resultsReady = this.#searchDelayMs === 0;
    else { app.savedNote = app.note; app.saveCount++; }
    return app;
  }
  #startSearch(): void {
    this.#cancelReadiness?.(); this.#cancelReadiness = null;
    if (this.#searchDelayMs === 0) return;
    const query = this.#app.query; const epoch = this.#epoch;
    this.#cancelReadiness = this.clock.schedule(this.clock.now() + this.#searchDelayMs, () => {
      this.#cancelReadiness = null;
      if (this.#epoch !== epoch || this.#app.query !== query) return;
      const next = { ...this.#app, resultsReady: true };
      try { this.#persist(next); }
      catch {
        this.#storageUncertain = true; this.#lease = null; this.#fence++; this.#notify(); return;
      }
      this.#app = next; this.#revision++; this.#notify();
    });
  }
  #invalidateSession(): void {
    if (!integer(this.#epoch + 1, 1)) throw new Error('synthetic_epoch_exhausted');
    this.#assertStorage();
    this.#epoch++; this.#revision++; this.#focusRevision++; this.#fence++; this.#lease = null;
    this.#persist(this.#app, this.#receipts, true); this.#notify();
  }
  #notify(): void { for (const listener of [...this.#listeners]) listener(); }
  #beginCall(): Usage { const usage = emptyUsage(); usage.transportCalls = 1; this.#usage.transportCalls++; return usage; }
  #operation(usage: Usage): void { usage.internalOperations++; this.#usage.internalOperations++; }
  #elapsed(usage: Usage, elapsed: number): void { usage.waitMs += elapsed; this.#usage.waitMs += elapsed; }
  #result(lease: ComputerLease, request: ActRequest, status: ComputerActionResult['status'], reason: string | null, usage: Usage): ComputerActionResult {
    if (this.#invocations.length >= maxReceipts) { this.#invocations.shift(); this.#invocationsOmitted++; }
    this.#invocations.push({ operationId: request.operationId, workId: lease.workId, attemptId: lease.attemptId, status, reason, inputCount: this.#app.inputCount });
    return { operationId: request.operationId, status, reason, usage };
  }
  async #delay(lease: ComputerLease, milliseconds: number, deadlineAt: number, signal: AbortSignal, usage: Usage): Promise<void> {
    const start = this.clock.now(); const end = Math.min(start + milliseconds, deadlineAt, lease.expiresAt);
    await new Promise<void>(resolve => {
      let finished = false; let unsubscribeClock = () => {}; let cancelTimer = () => {};
      const check = () => {
        if (finished || !(this.#leaseError(lease, signal) ?? this.#storageError()) && this.clock.now() < end) return;
        finished = true; this.#listeners.delete(check); unsubscribeClock(); cancelTimer(); signal.removeEventListener('abort', check);
        this.#elapsed(usage, this.clock.now() - start); resolve();
      };
      this.#listeners.add(check); unsubscribeClock = this.clock.subscribe(check); signal.addEventListener('abort', check, { once: true });
      if (end >= this.clock.now()) cancelTimer = this.clock.schedule(end, check); check();
    });
  }
  #receipt(identity: ComputerOperationIdentity, outcome: ComputerOperationReceipt['outcome'], effectSequence: number): ComputerOperationReceipt {
    return ComputerOperationReceiptSchema.parse({ schemaVersion: 1, kind: 'computer_operation_receipt', driver: this.identity,
      identity, outcome, decidedAt: this.clock.now(), effectSequence });
  }
  #readStored(): PersistedState {
    const file = openSync(this.#stateFile!, 'r');
    try {
      const stat = fstatSync(file);
      if (!stat.isFile() || stat.size > maxStateBytes) throw new Error('invalid_synthetic_app_state');
      const bytes = Buffer.allocUnsafe(stat.size + 1); let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(file, bytes, offset, bytes.length - offset, offset);
        if (count === 0) break; offset += count;
      }
      if (offset !== stat.size || fstatSync(file).size !== stat.size) throw new Error('invalid_synthetic_app_state');
      return this.#decode(bytes.subarray(0, offset).toString('utf8'));
    } finally { closeSync(file); }
  }
  #decode(text: string): PersistedState {
    if (Buffer.byteLength(text) > maxStateBytes) throw new Error('invalid_synthetic_app_state');
    const value = JSON.parse(text) as PersistedState & { version: number }; const app = value?.app;
    const version = (value as { version?: number } | null)?.version;
    const exactKeys = (object: object, keys: string[]): boolean => Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
    if (!value || (version !== 1 && version !== 2) || !exactKeys(value, version === 1 ? ['version', 'epoch', 'app'] : ['version', 'epoch', 'app', 'receipts']) ||
      !integer(value.epoch, 1) || !app || !exactKeys(app, ['query', 'note', 'resultsReady', 'savedNote', 'saveCount', 'inputCount']) ||
      typeof app.query !== 'string' || app.query.length > 8192 || typeof app.note !== 'string' || app.note.length > 8192 ||
      typeof app.savedNote !== 'string' || app.savedNote.length > 8192 || typeof app.resultsReady !== 'boolean' || !integer(app.saveCount) ||
      !integer(app.inputCount) || app.saveCount > app.inputCount) throw new Error('invalid_synthetic_app_state');
    const normalizedApp: AppState = { query: app.query, note: app.note, resultsReady: app.resultsReady,
      savedNote: app.savedNote, saveCount: app.saveCount, inputCount: app.inputCount };
    const entries = version === 1 ? [] : value.receipts;
    if (!Array.isArray(entries) || entries.length > maxReceipts) throw new Error('invalid_synthetic_app_state');
    const keys = new Set<string>(); let sequence = 0;
    const receipts = entries.map(entry => {
      const parsed = ComputerOperationReceiptSchema.safeParse(entry);
      if (!parsed.success) throw new Error('invalid_synthetic_app_state');
      const receipt = parsed.data; const key = operationKey(receipt.identity);
      if (receipt.driver.id !== this.identity.id || receipt.driver.version !== this.identity.version || receipt.identity.sessionId !== this.sessionId ||
        receipt.identity.epoch > value.epoch || keys.has(key) || receipt.effectSequence > app.inputCount || receipt.effectSequence < sequence ||
        receipt.outcome === 'applied' && receipt.effectSequence <= sequence) throw new Error('invalid_synthetic_app_state');
      keys.add(key); sequence = receipt.effectSequence; return receipt;
    });
    return { version: 2, epoch: value.epoch, app: normalizedApp, receipts };
  }
  #assertStorage(): void {
    if (this.#storageUncertain) throw new Error('computer_storage_uncertain');
    if (!this.#stateFile) return;
    const stored = this.#readStored();
    if (stored.epoch !== this.#epoch || JSON.stringify(stored.app) !== JSON.stringify(this.#app) ||
      JSON.stringify(stored.receipts) !== JSON.stringify(this.#receipts)) throw new Error('computer_stale_session');
  }
  #storageError(): string | null { try { this.#assertStorage(); return null; } catch { return 'computer_storage_unavailable'; } }
  #persist(app: AppState, receipts = this.#receipts, initial = false): void {
    if (!initial) this.#assertStorage();
    const serialized = JSON.stringify({ version: 2, epoch: this.#epoch, app, receipts });
    this.#decode(serialized);
    if (!this.#stateFile) return;
    const directory = dirname(this.#stateFile); mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.#stateFile}.tmp-${randomUUID()}`;
    try {
      writeFileSync(temporary, serialized, { mode: 0o600, flag: 'wx' });
      const file = openSync(temporary, 'r'); try { fsyncSync(file); } finally { closeSync(file); }
      renameSync(temporary, this.#stateFile);
      const folder = openSync(directory, 'r'); try { fsyncSync(folder); } finally { closeSync(folder); }
    } catch { this.#storageUncertain = true; throw new Error('computer_storage_uncertain'); }
  }
}
