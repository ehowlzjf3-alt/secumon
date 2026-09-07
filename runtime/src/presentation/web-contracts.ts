import { z } from 'zod';
import { GoalSchema } from '../application/contracts.js';
import type { WorkView, WorkViewResult } from '../domain/work-view.js';
import type { SessionPage } from '../domain/session.js';
import type { SessionSummaryRef } from '../domain/session-compact.js';
import type { AgentTurnModelInfo } from './host-models.js';
import { SessionInputBasisSchema } from '../application/session-base-contracts.js';
import type { SessionInputBasis } from '../domain/session.js';

const id = z.string().min(1).max(256);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const mode = z.enum(['auto', 'fast', 'deep']);
const reason = z.string().trim().min(1).max(1000);
const rawText = z.string().min(1).max(10000).refine(value => value.trim().length > 0);
const base = { requestId: id, expectedGoalRevision: revision, rawText: rawText.optional() };
export const WebAcceptSchema = z.strictObject({ requestId: id, scenarioId: z.enum(['documents-simple', 'observations-simple', 'documents-question']), mode,
  title: z.string().trim().min(1).max(160).optional(), rawText: rawText.optional() });
export const WebGeneralRequestSchema = z.strictObject({ requestId: id, mode, rawText });
export type WebGeneralRequest = z.infer<typeof WebGeneralRequestSchema>;
export const WebInputSchema = z.strictObject({ requestId: id, expectedGoalRevision: revision, rawText });
export const WebCompactSchema = z.strictObject({ requestId: id, expectedGoalRevision: revision });
export type WebCompactInput = z.infer<typeof WebCompactSchema>;
export interface WebCompactStatus {
  workId: string; sessionId: string; stateRevision: number;
  stage: 'idle' | 'needed' | 'queued' | 'running' | 'validating' | 'ready' | 'failed' | 'unknown' | 'cancelled';
  provider: 'synthetic' | 'registered' | null;
  reason: string | null;
  summary: SessionSummaryRef | null;
  call: { id: string; status: string; requestId: string | null; inputTokens: number | null; outputTokens: number | null } | null;
  originalHistoryPreserved: true;
}
export interface WebCompactResult { requestId: string; callId: string | null; status: WebCompactStatus }
export const WebAttachSchema = z.strictObject({ requestId: id, workId: id });
export const WebCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...base, kind: z.literal('run'), reason: reason.optional() }),
  z.strictObject({ ...base, kind: z.enum(['pause', 'resume', 'cancel']), reason: reason.optional() }),
  z.strictObject({ ...base, kind: z.literal('mode'), mode, expectedControlRevision: revision, reason }),
  z.strictObject({ ...base, kind: z.literal('goal'), goal: GoalSchema, expectedControlRevision: revision }),
  z.strictObject({ ...base, kind: z.literal('request-goal'), rawText, expectedControlRevision: revision,
    expectedInput: SessionInputBasisSchema, mode }),
  z.strictObject({ ...base, kind: z.literal('resolve'), obligationId: id, reason }),
]);
export type WebAcceptInput = z.infer<typeof WebAcceptSchema>;
export type WebAttachInput = z.infer<typeof WebAttachSchema>;
export type WebCommandInput = z.infer<typeof WebCommandSchema>;
export type WebInput = z.infer<typeof WebInputSchema>;
export interface WebGoalBasis {
  workId: string; description: string; expectedGoalRevision: number; expectedControlRevision: number;
  expectedInput: SessionInputBasis; mode: 'auto' | 'fast' | 'deep';
}
export interface WebConversation extends SessionPage { sessionId: string }
export type WorkCard = Pick<WorkView, 'workId' | 'title' | 'goalRevision' | 'mode' | 'progress' | 'reply'>;
export interface WorkList { items: WorkCard[]; nextCursor: string | null }
export interface WorkbenchConfig {
  profile: 'local-synthetic' | 'local-registered';
  generalRequests?: boolean;
  conversationId: string;
  persistentSession?: { agentId: string; sessionId?: string };
  memoryDrafts?: boolean;
  personalMemoryBackend?: 'sqlite' | 'documents' | 'postgres';
  compactProvider?: 'synthetic' | 'registered' | null;
  modelInfo?: AgentTurnModelInfo;
  scenarios: { id: WebAcceptInput['scenarioId']; title: string; description: string }[];
  modes: ('auto' | 'fast' | 'deep')[];
  allowDiagnostics: true;
  model: 'disabled' | 'synthetic-agent-turn' | 'registered-agent-turn';
  deliveryMeaning: 'local-channel-storage';
  pageSize: 20;
}
export interface WebAcceptResult { workId: string; accepted: boolean; sessionId?: string }
export interface WebAttachResult { workId: string; attached: boolean; duplicate: boolean; view: WorkViewResult }
export interface WebCommandResult { workId: string; accepted: true; duplicate: boolean; view: WorkViewResult }
