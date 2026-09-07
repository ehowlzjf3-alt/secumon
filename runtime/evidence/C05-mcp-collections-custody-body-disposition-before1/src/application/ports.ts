import type { ArtifactRef, ContextPacket, Delivery, DomainEvent, Json, PlanProposal, Policy, StoredEvent, TaskSpec, ToolResult, ToolUsage, WorkState } from '../domain/model.js';
import type { ReadDeferral, ReadKey, ReadLimits, ReadPage, ReadRequest, ReadResponse } from '../domain/read-collection.js';
import type { ComputerInputAssurance } from '../domain/computer-use.js';
import type { SessionCompactCandidate, SessionCompactInput } from '../domain/session-compact.js';
import type { AgentTurnInput, AgentTurnPrompt, AgentTurnReply } from './agent-turn-types.js';
import type { ModelContextPreview } from './model-context-preview.js';

export interface CommitRequest {
  workId: string;
  expectedRevision: number;
  commandId: string;
  commandDigest: string;
  next: WorkState;
  events: DomainEvent[];
  deliveries: Delivery[];
}
export type CommitResult =
  | { kind: 'committed' | 'duplicate'; state: WorkState }
  | { kind: 'conflict'; actualRevision: number }
  | { kind: 'idempotency_conflict' };
export interface EventMetadata { sequence: number; revision: number; type: string; at: number }
export interface RecentEventMetadataQuery { throughRevision: number; limit: number }
export interface RecentEventMetadata { items: EventMetadata[]; omittedCount: number }
export interface ConversationWorkQuery {
  tenantId: string; principalId: string; channel: string; conversationId: string;
  cursor?: string; limit: number;
}
export interface ConversationWorkPage { workIds: string[]; nextCursor: string | null }
export interface StateRepository {
  get(workId: string): Promise<WorkState | null>;
  receipt(workId: string, commandId: string): Promise<{ digest: string; state: WorkState } | null>;
  commit(request: CommitRequest): Promise<CommitResult>;
  events(workId: string, afterSequence: number): Promise<StoredEvent[]>;
  recentEventMetadata(workId: string, query: RecentEventMetadataQuery): Promise<RecentEventMetadata>;
  deliveries(workId: string): Promise<Delivery[]>;
  workIdsForConversation(tenantId: string, principalId: string, channel: string, conversationId: string): Promise<string[]>;
  /** Adapter-scoped stable progress; a bounded inspected page can be empty with a continuation. */
  conversationWorkPage(query: ConversationWorkQuery): Promise<ConversationWorkPage>;
  runnable(now: number): Promise<string[]>;
  close(): Promise<void>;
}
export interface ArtifactStore {
  put(bytes: Uint8Array, attributes: { tenantId: string; labels: string[]; mediaType: string }): Promise<ArtifactRef>;
  get(ref: ArtifactRef, policy: Policy): Promise<Uint8Array>;
  exists(ref: ArtifactRef): Promise<boolean>;
}
export interface Clock { now(): number }
export interface IdGenerator { next(prefix: string): string }
export interface Digester { digest(value: Json): string }
export interface SchemaCompiler { compile(schema: Json): (value: unknown) => boolean }
export interface ModelCapabilities {
  structuredOutput: boolean;
  toolCalling: boolean;
  images: boolean;
  cancellation: boolean;
  maxInputTokens: number;
  contextWindowTokens?: number | undefined;
  maxOutputTokens?: number | undefined;
  maxInputBytes?: number | undefined;
}
/** Size of one complete provider request; this estimate is not reported model usage. */
export interface ModelInputEstimate { tokens: number; bytes: number; method: string }
/** Host registration, separate from the value estimated for a particular request. */
export interface ModelInputEstimationProfile {
  readonly id: string;
  readonly revision: string;
  readonly templateRevision: string;
  readonly kind: 'tokenizer' | 'conservative_estimate' | 'legacy_adapter_revision';
}
export interface ModelIdentity { provider: string; model: string; revision: string }
export interface ModelCallOptions { callId: string; maxOutputTokens: number; tools: ToolDefinition[] }
export type ModelReply =
  | { status: 'ok'; proposal: PlanProposal; inputTokens: number | null; outputTokens: number | null; provider: string; model: string }
  | { status: 'refused' | 'truncated' | 'invalid' | 'error' | 'cancelled'; code: string; inputTokens: number | null; outputTokens: number | null };
export type SessionCompactReply =
  | { status: 'ok'; candidate: SessionCompactCandidate; inputTokens: number | null; outputTokens: number | null; provider: string; model: string }
  | Exclude<ModelReply, { status: 'ok' }>;
export interface Planner {
  readonly prompt?: AgentTurnPrompt;
  readonly inputEstimation?: ModelInputEstimationProfile;
  estimateContextPreview?(preview: ModelContextPreview, options: ModelCallOptions): ModelInputEstimate;
  estimateTurnInput?(input: AgentTurnInput, options: ModelCallOptions): ModelInputEstimate;
  turn?(input: AgentTurnInput, signal: AbortSignal, options: ModelCallOptions): Promise<AgentTurnReply>;
  readonly identity?: ModelIdentity;
  readonly destination: string;
  readonly capabilities: ModelCapabilities;
  estimateInput?(packet: ContextPacket, options: ModelCallOptions): ModelInputEstimate;
  propose(packet: ContextPacket, signal: AbortSignal, options?: ModelCallOptions): Promise<ModelReply>;
  estimateCompactInput?(input: SessionCompactInput, options: ModelCallOptions): ModelInputEstimate;
  compact?(input: SessionCompactInput, signal: AbortSignal, options: ModelCallOptions): Promise<SessionCompactReply>;
}
export interface ToolDefinition {
  provider: string;
  id: string;
  version: string;
  description: string;
  effect: 'read' | 'write';
  inputSchema: Json;
  outputSchema: Json;
  destination: string;
  labels: string[];
  resultValidation?: 'artifact-proof-v1' | undefined;
  computerContinuation?: 'continue' | 'verify' | undefined;
  computerInputAssurance?: ComputerInputAssurance | undefined;
  collection?: { kind: 'batch' | 'paged'; limits: ReadLimits; pageValidation?: 'artifact-proof-v1' | undefined;
    deferralValidation?: 'artifact-proof-v1' | undefined; responseRecovery?: 'stored-response-v1' | undefined;
    coverage?: 'manifest-v1' | undefined } | undefined;
  reuse?: { mode: 'immutable'; sourceVersion: string } | { mode: 'ttl'; maxAgeMs: number } | undefined;
}
export type ToolAvailability = 'available' | 'stored_only';
export interface Tool {
  readonly definition: ToolDefinition;
  /** Host registration availability, separate from the immutable contract and stored-response proof. Omission preserves normal execution. */
  readonly availability?: ToolAvailability;
  execute(task: TaskSpec, context: { workId: string; attemptId: string; policy: Policy; signal: AbortSignal;
    /** Recheck current authority after adapter waits and immediately before sending. Does not make a remote send atomic with policy changes. */
    authorize?: () => Promise<void>;
    /** Check original-call custody only while execute is active. Grants neither current execution/disclosure nor result adoption; adapters recheck before publishing captured raw data. */
    authorizeResponseCustody?: () => Promise<void> }): Promise<ToolResult>;
  validateResult?(state: WorkState, result: ToolResult): Promise<boolean>;
  /** Reconstructs a simple read result from durable custody only; never dispatches or opens a remote session. */
  restoreResult?(state: WorkState, input: StoredToolResultInput): Promise<StoredToolResult>;
  /** Reads original-call custody and measurements without a body/projector or another call. input.task is the original dispatch task. */
  restoreUsage?(state: WorkState, input: StoredToolResultInput): Promise<StoredToolUsage>;
  validateReadPage?(state: WorkState, input: ReadPageProofInput): Promise<boolean>;
  validateReadDeferral?(state: WorkState, input: ReadDeferralProofInput): Promise<boolean>;
  /** Reads durable response custody only. It must never fetch, retry, or open a remote session. */
  restoreReadResponse?(state: WorkState, input: ReadResponseRestoreInput): Promise<ReadResponseRestoreResult>;
  /** Host-only measurements for one original collection request; never returns or projects a page. */
  restoreReadUsage?(state: WorkState, input: ReadUsageRestoreInput): Promise<ReadUsageRestoreResult>;
  readManifest?(task: TaskSpec): ReadKey[];
}
export interface StoredToolResultInput { attemptId: string; task: TaskSpec }
export type StoredToolResult = { kind: 'absent' } | {
  kind: 'available'; result: ToolResult; receivedAt: number;
  receipt: { commandId: string; digest: string; artifact: ArtifactRef };
};
export type StoredToolUsage = { kind: 'absent' } | {
  kind: 'available'; usage: ToolUsage; receivedAt: number;
  receipt: { commandId: string; digest: string; artifact: ArtifactRef };
  /** True only when the original receipt proves this ref belongs to custody, not current context. */
  custodyOnly: boolean;
  responseObserved: boolean;
};
export interface ReadPageProofInput { attemptId: string; task: TaskSpec; request: ReadRequest; page: ReadPage }
export interface ReadDeferralProofInput { attemptId: string; task: TaskSpec; request: ReadRequest; deferral: ReadDeferral }
export interface ReadResponseRestoreInput { attemptId: string; task: TaskSpec; request: ReadRequest; intentHead: ArtifactRef }
export type ReadResponseRestoreResult = { kind: 'absent' } | { kind: 'available'; response: ReadResponse; receivedAt: number };
export interface ReadUsageRestoreInput { attemptId: string; task: TaskSpec; request: ReadRequest; dispatchedAt: number }
export type ReadUsageRestoreResult = { kind: 'absent' } | (Extract<StoredToolUsage, { kind: 'available' }> & {
  intent: { commandId: string; digest: string; artifact: ArtifactRef };
});
export interface ReadCollectionSource {
  manifest?(task: TaskSpec): ReadKey[];
  fetch(task: TaskSpec, request: ReadRequest, context: { workId: string; attemptId: string; policy: Policy; signal: AbortSignal;
    /** Call after adapter waits and immediately before sending; includes current collection intent custody. */
    authorize?: () => Promise<void>;
    /** Original dispatch and this page intent only, bounded by the active invocation's custody lifetime. */
    authorizeResponseCustody?: () => Promise<void> }): Promise<ReadResponse>;
  validatePage?(state: WorkState, input: ReadPageProofInput): Promise<boolean>;
  validateDeferral?(state: WorkState, input: ReadDeferralProofInput): Promise<boolean>;
  restoreResponse?(state: WorkState, input: ReadResponseRestoreInput): Promise<ReadResponseRestoreResult>;
  restoreUsage?(state: WorkState, input: ReadUsageRestoreInput): Promise<ReadUsageRestoreResult>;
}
export interface ReadCollectionBinding {
  definition: ToolDefinition;
  source: ReadCollectionSource;
  /** Execution availability is host metadata; the definition and stored-response proof remain unchanged. */
  readonly availability?: ToolAvailability;
}
export interface MessageSink {
  readonly capabilities?: { idempotentSend: boolean };
  send(delivery: Delivery): Promise<{ status: 'delivered'; externalId: string } | { status: 'unknown' | 'retryable_error' }>;
  lookup?(delivery: Delivery): Promise<{ status: 'delivered'; externalId: string } | { status: 'absent' | 'unknown' }>;
}
