import type { WorkState } from '../domain/model.js';
import type { SessionScope } from '../domain/session.js';
import type { SessionCompactCandidate, SessionCompactInput, SessionSummaryPublication, SessionSummaryRecord } from '../domain/session-compact.js';

export interface SessionSummaryRepository {
  summaryHead(scope: SessionScope): Promise<SessionSummaryRecord | null>;
  summary(scope: SessionScope, id: string): Promise<SessionSummaryRecord | null>;
  /** Selects an immutable usable historical prefix, never moving the active head backward. */
  summaryBefore(scope: SessionScope, throughSequence: number, policyDigest: string, before?: { throughSequence: number; revision: number }): Promise<SessionSummaryRecord | null>;
  publication(scope: SessionScope, callId: string): Promise<SessionSummaryRecord | null>;
  publishSummary(scope: SessionScope, expectedRevision: number, candidate: SessionSummaryPublication): Promise<SessionSummaryRecord | null>;
}
export interface SessionCompactPreparationOptions {
  force?: boolean;
  maxInputBytes?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  /** Synchronous local measurement of the complete provider request; never invokes a model. */
  measure?: (input: SessionCompactInput) => 'fit' | 'too_large';
}
export interface SessionCompactSource {
  /** Read-only bounded preparation. Null means no eligible prefix needs compacting. */
  prepareCompact(state: WorkState, options?: SessionCompactPreparationOptions): Promise<SessionCompactInput | null>;
  compactInputCurrent(state: WorkState, input: SessionCompactInput, signal?: AbortSignal): Promise<boolean>;
  publishCompact(state: WorkState, callId: string, input: SessionCompactInput, candidate: SessionCompactCandidate): Promise<SessionSummaryRecord>;
  compactPublication(state: WorkState, callId: string, input: SessionCompactInput): Promise<SessionSummaryRecord | null>;
}
