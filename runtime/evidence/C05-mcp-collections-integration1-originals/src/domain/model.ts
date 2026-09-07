import type { ConversationState, DeliveryContext, DeliveryDispatch } from './conversation.js';
import type { WorkspaceCheckpoint } from './workspace.js';
import type { KnowledgeDependency } from './knowledge.js';
import type { InputDependency } from './inputs.js';
import type { ReadCollectionProof, ReadProgress, ReadResume } from './read-checkpoint.js';
import type { ContextHead, ContextMetrics, ContextObservation, ContextGuidance } from './context.js';
import type { ExecutionControl } from './execution-policy.js';
import type { WorkProgress } from './work-progress.js';
import type { BudgetGrant, BudgetParent, BudgetSummary } from './budget-delegation.js';
import type { DisclosurePolicy, DisclosureRecord } from './disclosure.js';
import type { ComputerProgress } from './computer-use.js';
import type { ComputerReconciliation } from './computer-reconciliation.js';
import type { ComputerContinuationClaim, ComputerResume } from './computer-continuation.js';
import type { ExternalNotification, ExternalSubscription } from './external-events.js';
import type { SessionContext } from './session.js';
import type { PersonalMemoryContext, PersonalMemorySelection } from './personal-memory.js';
import type { GeneratedAnswer, ResponseRequirement } from './agent-turn.js';

export type Scalar = string | number | boolean | null;
export type Json = Scalar | Json[] | { [key: string]: Json };
export type WorkStatus = 'ready' | 'running' | 'waiting' | 'blocked' | 'paused' | 'cancelled' | 'failed' | 'completed';
export type Mode = 'auto' | 'fast' | 'deep';
export type Effect = 'read' | 'write';
export type EffectState = 'none' | 'confirmed' | 'unknown';

export interface Criterion {
  id: string;
  description: string;
  key: string;
  operator: 'equals' | 'present';
  equals: Scalar;
  minIndependentSources: number;
  requireCompleteCoverage: boolean;
  requireCollection?: { queryDigest: string; snapshot?: string | undefined } | undefined;
}
export interface Goal {
  responseRequirement?: ResponseRequirement | undefined;
  revision: number;
  description: string;
  scope: string;
  mode: Mode;
  criteria: Criterion[];
}
export interface Policy {
  disclosure?: DisclosurePolicy | undefined;
  tenantId: string;
  principalId: string;
  allowedTools: string[];
  allowedLabels: string[];
  allowedDestinations: string[];
  allowWrites: boolean;
}
export interface Limits {
  toolCalls: number;
  modelCalls: number;
  tokens: number;
  replans: number;
  wallTimeMs: number;
}
export interface Usage {
  toolCalls: number;
  modelCalls: number;
  tokens: number;
  replans: number;
  unmeasuredModelCalls: number;
}
export interface Budget {
  limits: Limits;
  used: Usage;
  reservedToolCalls: number;
  reservedModelCalls: number;
  reservedTokens: number;
}
export interface ArtifactRef {
  id: string;
  sha256: string;
  byteLength: number;
  mediaType: string;
  tenantId: string;
  labels: string[];
}
export interface Evidence {
  id: string;
  tenantId: string;
  scope: string;
  sourceId: string;
  lineageId: string;
  locator: string;
  observedAt: number;
  recordedAt: number;
  labels: string[];
  coverage: 'complete' | 'partial' | 'unknown';
  status: 'accepted' | 'retracted';
  access?: 'available' | 'restricted' | 'deleted' | undefined;
  supersedes: string[];
  derivedFrom: string[];
  facts: Record<string, Scalar>;
  artifact: ArtifactRef | null;
}
export interface DataLifecycle {
  generation: number;
  blockedArtifactIds: string[];
  changes: { id: string; action: 'retract' | 'correct' | 'restrict' | 'delete' | 'dependency_changed'; principalId: string; at: number;
    evidenceIds: string[]; replacementId: string | null; reason: string; purge: 'not_requested' | 'pending_retention_review' }[];
}
export interface Hypothesis {
  id: string;
  question: string;
  claim: string;
  predictedObservation: string;
  falsifier: string;
  status: 'open' | 'supported' | 'contested' | 'refuted' | 'inconclusive';
  supportIds: string[];
  counterIds: string[];
  reason: string;
}
export interface Obligation {
  id: string;
  kind: 'response' | 'evidence' | 'effect_reconciliation' | 'delivery' | 'budget_reconciliation';
  reason: string;
  status: 'pending' | 'satisfied' | 'waived';
  wakeKey: string | null;
  dueAt: number | null;
  mode?: 'actionable' | 'waiting' | undefined;
  source?: { provider: string; resourceId: string; externalId: string; role: 'requester' | 'assignee'; goalRevision: number; attemptId: string } | undefined;
  resumeToolIds?: string[] | undefined;
}
export interface TaskSpec {
  id: string;
  description: string;
  dependsOn: string[];
  toolId: string;
  toolVersion: string;
  input: Record<string, Json>;
  effect: Effect;
  freshness?: 'fresh' | 'allow_reuse' | undefined;
  readResume?: ReadResume | undefined;
  computerResume?: ComputerResume | undefined;
  maxAttempts: number;
  satisfies: string[];
}
export interface Plan {
  revision: number;
  goalRevision: number;
  reason: string;
  tasks: TaskSpec[];
}
export interface PlanProposal {
  baseStateRevision: number;
  baseGoalRevision: number;
  basePlanRevision: number;
  reason: string;
  tasks: TaskSpec[];
  hypotheses: Hypothesis[];
}
export interface Attempt {
  id: string;
  taskId: string;
  planRevision: number;
  goalRevision: number;
  toolId: string;
  toolVersion: string;
  inputDigest: string;
  contractDigest?: string | undefined;
  scope: string;
  effect: Effect;
  effectState: EffectState;
  status: 'reserved' | 'running' | 'received' | 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'unknown';
  owner: string;
  leaseUntil: number;
  startedAt: number;
  finishedAt: number | null;
  resultId: string | null;
  resultArtifact: ArtifactRef | null;
  adopted: boolean;
  knowledgeDependencies?: KnowledgeDependency[] | undefined;
  inputDependencies?: InputDependency[] | undefined;
  effectReceipt?: EffectReceipt | undefined;
  reuse?: ToolReuseOrigin | undefined;
  execution?: ToolExecution | undefined;
  readProgress?: ReadProgress | undefined;
  computerUse?: ComputerProgress | undefined;
  error: { code: string; retryable: boolean } | null;
}
export interface ToolReuseOrigin {
  attemptId: string;
  resultId: string;
  resultArtifact: ArtifactRef;
  observedAt: number;
  cacheKey: string;
}
export interface ToolUsage {
  transportCalls: number | null;
  internalOperations: number | null;
  imageBytes: number | null;
  waitMs: number | null;
}
export interface ToolExecution {
  mode: 'invoked' | 'reused' | 'not_invoked' | 'unreported';
  implementationCalls: 0 | 1 | null;
  usage: ToolUsage;
}
export interface ToolResult {
  resultId: string;
  attemptId: string;
  status: 'success' | 'partial' | 'error' | 'cancelled';
  effectState: EffectState;
  evidence: Evidence[];
  artifacts: ArtifactRef[];
  output: Json;
  error: { code: string; retryable: boolean } | null;
  cursor: string | null;
  coverage: 'complete' | 'partial' | 'unknown';
  knowledgeDependencies?: KnowledgeDependency[] | undefined;
  inputDependencies?: InputDependency[] | undefined;
  effectReceipt?: EffectReceipt | undefined;
  reuse?: ToolReuseOrigin | undefined;
  usage?: ToolUsage | undefined;
  collection?: ReadCollectionProof | undefined;
}
export interface EffectReceipt {
  provider: string;
  operationId: string;
  outcome: 'applied' | 'not_applied';
  origin: 'execution' | 'reconciliation';
  artifact: ArtifactRef;
  observedAt: number;
}
export interface ModelCall {
  id: string;
  /** Input execution settings only; absent historical calls do not acquire a retroactive profile pin. */
  inputProfileDigest?: string | undefined;
  personalMemoryDigest?: string | undefined;
  /** Absent on historical calls means planning; compact shares the same usage ledger. */
  purpose?: 'planning' | 'session_compact' | 'agent_turn' | undefined;
  agentTurnPromptDigest?: string | undefined;
  compactInputDigest?: string | undefined;
  compactRequestId?: string | undefined;
  provider: string;
  model: string;
  adapterRevision: string;
  destination: string;
  owner: string;
  goalRevision: number;
  baseStateRevision: number;
  basePlanRevision: number;
  semanticDigest: string;
  semanticVersion?: 2 | 3 | 4 | undefined;
  failureKey?: string | undefined;
  inputArtifact: ArtifactRef;
  replyArtifact: ArtifactRef | null;
  inputEstimate: number;
  maxOutputTokens: number;
  tokenReservation: number;
  inputTokens: number | null;
  outputTokens: number | null;
  usageStatus: 'reserved' | 'reported' | 'unknown' | 'not_called';
  status: 'reserved' | 'running' | 'received' | 'accepted' | 'rejected' | 'unknown' | 'cancelled';
  startedAt: number;
  leaseUntil: number;
  finishedAt: number | null;
  expired: boolean;
  outcome: 'ok' | 'refused' | 'truncated' | 'invalid' | 'error' | 'cancelled' | null;
  reason: string;
  contextMetrics?: ContextMetrics | undefined;
}
export interface WorkState {
  generatedAnswer?: GeneratedAnswer | undefined;
  personalMemorySelection?: PersonalMemorySelection | undefined;
  personalMemoryReviewRequired?: boolean | undefined;
  computerContinuations?: ComputerContinuationClaim[] | undefined;
  computerReconciliations?: ComputerReconciliation[] | undefined;
  disclosureLabels?: string[] | undefined;
  disclosures?: DisclosureRecord[] | undefined;
  schemaVersion: 1;
  executionControl?: ExecutionControl | undefined;
  progress?: WorkProgress | undefined;
  retryWakeAt?: number | null | undefined;
  contextHead?: ContextHead | null | undefined;
  id: string;
  revision: number;
  goal: Goal;
  policy: Policy;
  status: WorkStatus;
  statusReason: string;
  budget: Budget;
  budgetParent?: BudgetParent | undefined;
  budgetGrants?: BudgetGrant[] | undefined;
  plan: Plan | null;
  attempts: Attempt[];
  modelCalls: ModelCall[];
  evidence: Evidence[];
  hypotheses: Hypothesis[];
  hypothesisAssessment: { goalRevision: number; evidenceIds: string[] } | null;
  obligations: Obligation[];
  subscriptions?: ExternalSubscription[] | undefined;
  notifications?: ExternalNotification[] | undefined;
  artifacts: ArtifactRef[];
  conversation: ConversationState | null;
  dataLifecycle?: DataLifecycle | undefined;
  workspaceCheckpoints?: WorkspaceCheckpoint[] | undefined;
  createdAt: number;
  updatedAt: number;
  deadlineAt: number;
}
export interface DomainEvent {
  type: string;
  at: number;
  data: Record<string, Json>;
}
export interface StoredEvent extends DomainEvent {
  workId: string;
  revision: number;
  sequence: number;
  commandId: string;
}
export interface Delivery {
  id: string;
  workId: string;
  goalRevision: number;
  destination: string;
  kind: 'ack' | 'question' | 'result' | 'failure';
  text: string;
  status: 'pending' | 'sending' | 'delivered' | 'unknown' | 'superseded' | 'failed';
  externalId: string | null;
  context?: DeliveryContext | null;
  dispatch?: DeliveryDispatch | null;
}
export interface CompletionCheck {
  complete: boolean;
  criteria: { id: string; met: boolean; evidenceIds: string[]; reasons: string[] }[];
  blockers: string[];
}
export interface ContextPacket {
  personalMemory?: PersonalMemoryContext | undefined;
  session?: SessionContext | undefined;
  notifications?: ExternalNotification[] | undefined;
  computerContinuations?: ComputerContinuationClaim[] | undefined;
  computerReconciliations?: ComputerReconciliation[] | undefined;
  disclosureLabels?: string[] | undefined;
  readCollections?: { attemptId: string; taskId: string; attemptStatus: Attempt['status']; progress: ReadProgress }[] | undefined;
  schemaVersion: 1;
  workId: string;
  stateRevision: number;
  goal: Goal;
  policy: Policy;
  plan: Plan | null;
  hypotheses: Hypothesis[];
  obligations: Obligation[];
  evidence: Evidence[];
  activeToolIds: string[];
  purpose: 'plan' | 'assess' | 'respond';
  planningFeedback?: { callId: string; reason: string }[];
  retrievedKnowledge?: { entries: { attemptId: string; toolId: string; output: Json }[]; omitted: number; interpretation: 'prior_observations_not_fresh_evidence' } | undefined;
  toolObservations?: ContextObservation[] | undefined;
  evidenceReferences?: Pick<Evidence, 'id' | 'sourceId' | 'locator' | 'observedAt' | 'coverage' | 'status'>[] | undefined;
  activeGuidance?: ContextGuidance[] | undefined;
  contextView?: { policyTools: 'active_subset'; planTasks: 'frontier'; omitted: { tools: number; evidence: number; attempts: number; tasks: number; results: number }; discoveryToolIds: string[] } | undefined;
  execution?: { budget: Budget; deadlineAt: number; attempts: Attempt[]; hypothesisAssessment: WorkState['hypothesisAssessment'];
    control?: ExecutionControl | undefined; progress?: ProgressSummary | undefined; delegation?: BudgetSummary | undefined } | undefined;
}
export type ProgressSummary = Pick<WorkProgress, 'consecutiveUnproductive' | 'productiveSteps' | 'unproductiveSteps' | 'saturated'>;
