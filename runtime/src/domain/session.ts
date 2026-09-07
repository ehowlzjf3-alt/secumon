import type { ArtifactRef, Json } from './model.js';
import type { SessionSummaryView } from './session-compact.js';

/** The host supplies agent and user identity; a conversation identifier grants no access. */
export interface SessionScope { tenantId: string; agentId: string; principalId: string; sessionId: string }
export interface SessionOwner { tenantId: string; agentId: string; principalId: string }
export interface SessionInputBasis { messageId: string; sequence: number; digest: string }
export interface AppliedSessionInput { scope: SessionScope; input: SessionInputBasis }
export interface SessionHead { revision: number; throughSequence: number; digest: string; policyDigest: string }
export interface SessionRecord {
  scope: SessionScope; createdAt: number; revision: number; lastSequence: number;
  activeWorkId: string | null; activeInputSequence: number; head: SessionHead | null;
}
export interface SessionIntake {
  scope: SessionScope; messageId: string; digest: string; text: string; payload: Json;
  kind: 'work' | 'input' | 'command'; workId: string; labels: string[]; receivedAt: number;
}
export interface SessionInbox extends SessionIntake {
  sequence: number; status: 'pending' | 'applied' | 'rejected'; rejection: string | null;
}
export interface SessionEntry {
  sequence: number; role: 'user' | 'assistant'; sourceId: string; workId: string;
  text: string; labels: string[]; artifact: ArtifactRef | null;
  status: 'received' | 'delivered'; kind: string;
}
export interface SessionPage { entries: SessionEntry[]; nextCursor: string | null }
interface SessionContextBase {
  basis: AppliedSessionInput; head: SessionHead;
  entries: SessionEntry[]; interpretation: 'conversation_history_not_verified_evidence';
}
export type SessionContext = SessionContextBase & ({ schemaVersion: 1 } | { schemaVersion: 2; summary: SessionSummaryView });
