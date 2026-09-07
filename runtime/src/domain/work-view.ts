import type { ConversationBinding } from './conversation.js';
import type { Criterion, Delivery, Hypothesis, Mode, WorkStatus } from './model.js';

export type WorkViewLevel = 'conversation' | 'details' | 'diagnostics';
export interface WorkViewAccess {
  channel: ConversationBinding['channel'];
  conversationId: string;
  destination: string;
  recipientId: string;
  allowDiagnostics: boolean;
}
export interface WorkViewOptions { level: WorkViewLevel; cursor?: string | undefined }
export interface WorkViewMessage {
  id: string;
  kind: Delivery['kind'];
  text: string;
  deliveryStatus: Delivery['status'];
}
export interface WorkView {
  schemaVersion: 1;
  workId: string;
  revision: number;
  goalRevision: number;
  level: WorkViewLevel;
  title: string;
  mode: { requested: Mode; strategy: 'direct' | 'investigate'; pending: Mode | null; revision: number };
  reply: { channel: ConversationBinding['channel']; observingPrimary: boolean };
  progress: {
    status: WorkStatus;
    reason: string;
    updatedAt: number;
    activeAttempts: number;
    activeModels: number;
    analysisReady: boolean;
    resultReady: boolean;
    resultDelivery: Delivery['status'] | 'not_prepared' | 'unavailable';
    pendingQuestions: number;
  };
  messages: WorkViewMessage[];
  questions?: { id: string; reason: string }[] | undefined;
  details?: {
    goal: { description: string; scope: string; mode: Mode; revision?: number; criteria?: Criterion[]; editable?: boolean };
    plan: { revision: number; reason: string; tasks: { id: string; description: string; toolId: string; status: string }[] } | null;
    hypotheses: { id: string; question: string; claim: string; reviewRequired: boolean; status: Hypothesis['status'] | null; supportCount: number | null; counterCount: number | null }[];
    evidence: { id: string; sourceId: string; locator: string; observedAt: number; coverage: 'complete' | 'partial' | 'unknown' }[];
    omitted: { tasks: number; hypotheses: number; evidence: number };
  } | undefined;
  diagnostics?: {
    events: { sequence: number; revision: number; type: string; at: number }[];
    omittedEvents: number;
  } | undefined;
}
export type WorkViewResult = { kind: 'snapshot'; cursor: string; view: WorkView } | { kind: 'unchanged'; cursor: string };
