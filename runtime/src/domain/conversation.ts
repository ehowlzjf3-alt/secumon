import type { ArtifactRef, Delivery, Json } from './model.js';
import type { AppliedSessionInput, SessionScope } from './session.js';

export interface ConversationBinding {
  id: string;
  channel: 'cli' | 'web' | 'knox' | 'test' | 'peer';
  conversationId: string;
  recipientId: string;
  destination: string;
  tenantId: string;
  principalId: string;
  session?: SessionScope | undefined;
}
export interface PreparedResponse {
  id: string;
  goalRevision: number;
  sourceRevision: number;
  evidenceIds: string[];
  evidenceDigest: string;
  generatedAnswerDigest?: string | undefined;
  artifact: ArtifactRef;
  labels: string[];
}
export interface ConversationState {
  bindings: ConversationBinding[];
  primaryBindingId: string;
  completionRequiresDelivery: boolean;
  result: PreparedResponse | null;
  session?: AppliedSessionInput | undefined;
  sessionReviewRequired?: boolean | undefined;
}
export interface DeliveryContext {
  binding: ConversationBinding;
  labels: string[];
  sourceRevision: number;
  dataGeneration?: number | undefined;
  responseId: string | null;
  evidenceIds: string[];
  evidenceDigest: string | null;
  generatedAnswerDigest?: string | undefined;
  obligationIds: string[];
  artifact: ArtifactRef | null;
}
export interface DeliveryDispatch {
  owner: string;
  leaseUntil: number;
  attempts: number;
  lastError: string | null;
}
export function deliveryContent(delivery: Delivery): Json {
  return JSON.parse(JSON.stringify({ id: delivery.id, workId: delivery.workId, goalRevision: delivery.goalRevision,
    destination: delivery.destination, kind: delivery.kind, text: delivery.text, context: delivery.context ?? null })) as Json;
}
export function deliveryObligationId(goalRevision: number) { return `response-delivery:${goalRevision}`; }
