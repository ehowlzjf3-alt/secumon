import type { AppliedSessionInput, SessionEntry, SessionScope } from './session.js';

export interface SessionQuote {
  sequence: number; sourceId: string; role: 'user' | 'assistant'; quote: string;
}
export interface SessionRetainedItem {
  id: string;
  kind: 'constraint' | 'hypothesis' | 'counterargument' | 'open_question' | 'decision' | 'outcome' | 'reference';
  text: string;
  status: 'active' | 'contested' | 'refuted' | 'resolved' | 'superseded';
  citations: SessionQuote[];
  /** A changed prior item retains its identity and cites the later source for the change. */
  changedBy?: SessionQuote | undefined;
}
export interface SessionSummaryContent { narrative: string; retained: SessionRetainedItem[] }
export interface SessionSummaryRef {
  id: string; revision: number; throughSequence: number; digest: string; policyDigest: string;
}
export interface SessionSummaryView { ref: SessionSummaryRef; content: SessionSummaryContent }
export interface SessionSourceManifest { throughSequence: number; digest: string; entries: number }
export interface SessionCompactInput {
  schemaVersion: 1; purpose: 'session_compact'; workId: string; basis: AppliedSessionInput;
  policyDigest: string; inputDigest: string;
  expectedHead: SessionSummaryRef | null;
  previous: SessionSummaryView | null;
  prefix: SessionSourceManifest;
  /** Only the new bounded source segment, after the previous summary's prefix. */
  entries: SessionEntry[];
  maxSummaryBytes: number;
  interpretation: 'conversation_history_not_verified_evidence';
}
export interface SessionCompactCandidate {
  inputDigest: string; content: SessionSummaryContent;
}
export interface SessionSummaryRecord {
  scope: SessionScope; ref: SessionSummaryRef; content: SessionSummaryContent;
  workId: string; callId: string; inputDigest: string; prefix: SessionSourceManifest;
  previous: SessionSummaryRef | null; createdAt: number;
}
export type SessionSummaryPublication = Omit<SessionSummaryRecord, 'ref'> & {
  ref: Omit<SessionSummaryRef, 'revision'>;
};
export interface SessionCompactLimits {
  maxContextBytes: number; maxContextEntries: number;
  triggerRatio: number; targetRatio: number; keepRecentEntries: number;
  maxCompactInputBytes: number; maxCompactEntries: number; maxSummaryBytes: number;
}
