import type { ComputerAction, ComputerDriverIdentity, ComputerInputAssurance, ComputerLease, ComputerLimits, ComputerView } from '../domain/computer-use.js';
import type { ToolUsage } from '../domain/model.js';
import type { ComputerOperationIdentity, ComputerOperationLookupResult } from '../domain/computer-operation.js';

export interface ComputerObservationResult { view: ComputerView; usage: ToolUsage }
export interface ComputerActionResult {
  operationId: string;
  status: 'applied' | 'not_applied' | 'unknown';
  reason: string | null;
  usage: ToolUsage;
}
export interface ComputerWaitResult { status: 'changed' | 'timeout' | 'interrupted'; usage: ToolUsage }

/** A session grant fences one physical input surface; a work's Attempt lease alone does not provide that exclusion. */
export interface ComputerDriver {
  readonly identity: ComputerDriverIdentity;
  /** Omission retains the synchronous-local-v1 contract. This declaration grants no input authority. */
  readonly inputAssurance?: ComputerInputAssurance;
  acquire(request: { sessionId: string; workId: string; attemptId: string; deadlineAt: number }, signal: AbortSignal): Promise<ComputerLease>;
  observe(lease: ComputerLease, request: { maxElements: number; maxBytes: number }, signal: AbortSignal): Promise<ComputerObservationResult>;
  /**
   * After controlled waits, await authorizeInput before dispatching the one requested input.
   * Local (including omission): synchronously recheck grant, surface/focus, view and unique target immediately before input.
   * renderer-gated-dom-v1: host authority is a pre-dispatch sample; the renderer synchronously checks its grant,
   * view/focus/target/deadline and performs typed DOM events. This is neither native input nor atomic host revocation.
   * After dispatch, cancellation/timeout without proof of no input remains unknown; never replay to recover an acknowledgement.
   */
  act(lease: ComputerLease, request: { operationId: string; basis: ComputerView; targetRef: string; action: ComputerAction; deadlineAt: number }, signal: AbortSignal,
    authorizeInput: () => Promise<void>): Promise<ComputerActionResult>;
  wait(lease: ComputerLease, request: { afterRevision: number; maxWaitMs: number; deadlineAt: number }, signal: AbortSignal): Promise<ComputerWaitResult>;
  /** Authorize the current read grant for the same work; original attempt and epoch may predate this grant. Lookup never repeats an input. */
  lookup?(lease: ComputerLease, request: { identity: ComputerOperationIdentity }, signal: AbortSignal,
    authorizeRead: () => Promise<void>): Promise<ComputerOperationLookupResult>;
  /** Release only this grant; do not close a user-owned app or a newer owner's session. */
  release(lease: ComputerLease): Promise<void>;
}
export interface ComputerBinding {
  provider: string;
  id: string;
  version: string;
  description: string;
  destination: string;
  labels: string[];
  sessionId: string;
  driver: ComputerDriver;
  limits: ComputerLimits;
}
