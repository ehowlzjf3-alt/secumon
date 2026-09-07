import type { ArtifactRef, Scalar, ToolUsage, WorkState } from './model.js';
import { artifactBlocked } from './data-lifecycle.js';
import type { ComputerContinuationClaim } from './computer-continuation.js';

export interface ComputerElement {
  ref: string;
  role: string;
  name: string;
  value: string | null;
  visible: boolean;
  enabled: boolean;
}
export interface ComputerView {
  sessionId: string;
  epoch: number;
  surfaceId: string;
  revision: number;
  focusRevision: number;
  observedAt: number;
  elements: ComputerElement[];
  facts: Record<string, Scalar>;
  partial: boolean;
  omittedCount: number;
}
export interface ComputerSelector { role: string; name: string }
export type ComputerAction =
  | { kind: 'fill'; target: ComputerSelector; value: string }
  | { kind: 'click'; target: ComputerSelector };
export type ComputerCondition =
  | { kind: 'element_value'; target: ComputerSelector; value: string }
  | { kind: 'fact_equals'; key: string; value: Scalar };
export interface ComputerStep { action: ComputerAction; condition: ComputerCondition }
export interface ComputerLimits {
  maxSteps: number;
  maxObservations: number;
  maxElements: number;
  maxViewBytes: number;
  maxDurationMs: number;
  pollIntervalMs: number;
}
export interface ComputerDriverIdentity { id: string; version: string }
export const COMPUTER_INPUT_ASSURANCES = ['synchronous-local-v1', 'renderer-gated-dom-v1'] as const;
export type ComputerInputAssurance = typeof COMPUTER_INPUT_ASSURANCES[number];
export interface ComputerLease {
  sessionId: string;
  epoch: number;
  surfaceId: string;
  fence: number;
  workId: string;
  attemptId: string;
  expiresAt: number;
}
export type ComputerObserveInput = Record<string, never>;
export interface ComputerActInput { observationId: string; steps: ComputerStep[]; timeoutMs: number }
export interface ComputerProgress {
  head: ArtifactRef;
  phase: 'running' | 'complete' | 'partial' | 'unknown';
  completedSteps: number;
  pendingOperationId: string | null;
}
export interface ComputerObservationRecord {
  schemaVersion: 1;
  kind: 'computer_observation';
  workId: string;
  attemptId: string;
  goalRevision: number;
  scope: string;
  policyDigest: string;
  lifecycleGeneration: number;
  driver: ComputerDriverIdentity;
  view: ComputerView;
  usage: ToolUsage;
}
export interface ComputerCheckpointStep {
  index: number;
  operationId: string;
  action: ComputerAction;
  condition: ComputerCondition;
  before: ArtifactRef;
  after: ArtifactRef | null;
  status: 'intent' | 'applied' | 'not_applied' | 'unknown';
  verified: boolean;
  errorCode: string | null;
}
export interface ComputerCheckpointV1 {
  schemaVersion: 1;
  kind: 'computer_checkpoint';
  workId: string;
  attemptId: string;
  goalRevision: number;
  scope: string;
  policyDigest: string;
  lifecycleGeneration: number;
  taskDigest: string;
  contractDigest: string;
  driver: ComputerDriverIdentity;
  sessionId: string;
  epoch: number;
  deadlineAt: number;
  initialObservation: ArtifactRef;
  latestObservation: ArtifactRef;
  steps: ComputerCheckpointStep[];
  phase: ComputerProgress['phase'];
  stopReason: string | null;
  usage: ToolUsage;
}

export interface ComputerLineage {
  rootAttemptId: string;
  actionDeadlineAt: number;
  maxObservations: number;
  maxInputAttempts: number;
  maxSuccessors: number;
  depth: number;
  observationsUsed: number;
  inputAttemptsUsed: number;
}

export interface ComputerCheckpointV2 extends Omit<ComputerCheckpointV1, 'schemaVersion'> {
  schemaVersion: 2;
  lineage: ComputerLineage;
  entryObservation: ArtifactRef | null;
  continuation: { claim: ComputerContinuationClaim; inheritedObservation: ArtifactRef | null } | null;
}

export type ComputerCheckpoint = ComputerCheckpointV1 | ComputerCheckpointV2;

export function visibleComputerProgress(state: WorkState, progress: ComputerProgress): boolean {
  return !artifactBlocked(state, progress.head) && progress.head.tenantId === state.policy.tenantId &&
    progress.head.labels.every(label => state.policy.allowedLabels.includes(label));
}
