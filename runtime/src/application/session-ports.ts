import type { Policy, WorkState } from '../domain/model.js';
import type { AppliedSessionInput, SessionContext, SessionEntry, SessionHead, SessionInbox, SessionIntake, SessionOwner, SessionPage, SessionRecord, SessionScope } from '../domain/session.js';
import type { SessionSourceManifest, SessionSummaryView } from '../domain/session-compact.js';
import type { SessionSummaryRepository } from './session-compact-ports.js';

export interface SessionRepository extends SessionSummaryRepository {
  /** Explicit sessionId resumes only; newSession creates. Otherwise the owner/route alias resumes. */
  open(owner: SessionOwner, options: { route: string; sessionId?: string; newSession?: boolean; now: number }): Promise<SessionRecord>;
  get(scope: SessionScope): Promise<SessionRecord>;
  receive(input: SessionIntake): Promise<{ input: SessionInbox; created: boolean }>;
  input(scope: SessionScope, messageId: string): Promise<SessionInbox | null>;
  pending(scope: SessionScope, limit: number): Promise<SessionInbox[]>;
  settle(scope: SessionScope, messageId: string, digest: string, result: { status: 'applied' } | { status: 'rejected'; reason: string }): Promise<SessionInbox>;
  history(scope: SessionScope, policy: Policy, options: { limit: number; cursor?: string; afterSequence?: number; throughSequence?: number }): Promise<SessionPage>;
  publishHead(scope: SessionScope, expectedRevision: number, candidate: Omit<SessionHead, 'revision'>): Promise<SessionHead | null>;
  head(scope: SessionScope, candidate: Omit<SessionHead, 'revision'>): Promise<SessionHead | null>;
  /** Retains an older immutable prefix without replacing the active session head or consuming its tail. */
  retainHead(scope: SessionScope, candidate: Omit<SessionHead, 'revision'>): Promise<SessionHead>;
}

/** Read-only preparation. A candidate is not a published SessionHead or a valid SessionContext. */
interface SessionDraftBasis {
  basis: AppliedSessionInput;
  currentInput: SessionEntry;
  summary: SessionSummaryView | null;
  sourceManifest: SessionSourceManifest;
  totalEntries: number;
  totalBytes: number;
}
export type SessionContextDraft = SessionDraftBasis & ({
  status: 'complete';
  entries: SessionEntry[];
  candidate: Omit<SessionHead, 'revision'>;
} | {
  status: 'capacity';
  reason: 'entries' | 'bytes';
});

export interface SessionContextProvider {
  context(state: WorkState): Promise<SessionContext | null>;
  current(state: WorkState, context?: SessionContext, signal?: AbortSignal): Promise<boolean>;
  inspectContext?(state: WorkState): Promise<SessionContextDraft | null>;
  draftCurrent?(state: WorkState, draft: SessionContextDraft, signal?: AbortSignal): Promise<boolean>;
  materializeContext?(state: WorkState, draft: SessionContextDraft): Promise<SessionContext>;
}
