import type { ArtifactRef, Attempt, Json, ToolResult, WorkState } from './model.js';
import type { ReadProgress } from './read-checkpoint.js';
import { artifactBlocked } from './data-lifecycle.js';
import type { SessionContext } from './session.js';

export interface ContextReadCollection {
  attemptId: string;
  taskId: string;
  attemptStatus: Attempt['status'];
  progress: ReadProgress;
}
export function visibleReadProgress(state: WorkState, progress: ReadProgress): boolean {
  return progress.head.tenantId === state.policy.tenantId && progress.head.labels.every(label => state.policy.allowedLabels.includes(label)) &&
    !artifactBlocked(state, progress.head);
}
/** Canonical resume metadata only; checkpoint bodies and provider cursors remain in artifacts. */
export function readCollectionContext(state: WorkState): ContextReadCollection[] {
  return state.attempts.flatMap(attempt => {
    const progress = attempt.readProgress;
    return attempt.goalRevision === state.goal.revision && attempt.scope === state.goal.scope && progress &&
      progress.successorAttemptId === null && visibleReadProgress(state, progress) && !(progress.phase === 'complete' && attempt.adopted)
      ? [{ attemptId: attempt.id, taskId: attempt.taskId, attemptStatus: attempt.status, progress: structuredClone(progress) }] : [];
  });
}

export interface ContextObservation {
  attemptId: string;
  taskId: string;
  toolId: string;
  toolVersion: string;
  inputDigest: string;
  resultId: string;
  resultArtifact: ArtifactRef;
  status: ToolResult['status'];
  coverage: ToolResult['coverage'];
  representation: 'full' | 'reference';
  input?: Record<string, Json> | undefined;
  output?: Json | undefined;
  historical: boolean;
  reuse?: ToolResult['reuse'];
  sourceContracts?: { id: string; version: string; digest: string }[] | undefined;
}
export interface ContextGuidance {
  id: string;
  version: string;
  sha256: string;
  manifestDigest: string;
  artifact: ArtifactRef;
  rules: string[];
  body?: string | undefined;
}

export type ContextItemKind = 'tool' | 'evidence' | 'result' | 'guidance' | 'attempt';
export type ContextRepresentation = 'full' | 'reference' | 'omitted';
export interface ContextItem {
  key: string;
  kind: ContextItemKind;
  version: string;
  digest: string;
  fullBytes: number;
  referenceBytes: number;
  minimum: 'full' | 'reference' | 'omitted';
  maximum?: 'full' | 'reference' | undefined;
  priority: number;
  useMarker: string | null;
}
export interface ContextDecision {
  key: string;
  kind: ContextItemKind;
  version: string;
  digest: string;
  representation: ContextRepresentation;
  reason: string;
  bytes: number;
}
export interface ContextMemoEntry {
  key: string;
  digest: string;
  useMarker: string | null;
  lastUsedCycle: number;
  admittedCycle: number;
  lastIncludedCycle: number;
  lastEvictedCycle: number | null;
}
export interface ContextMemo {
  cycle: number;
  mode: 'full' | 'compact';
  entries: ContextMemoEntry[];
  evictions: number;
  reloads: number;
}
export interface ContextHead { artifact: ArtifactRef; basisRevision: number; cycle: number }
export interface ContextBasis {
  personalMemoryDigest?: string | undefined;
  session?: Pick<SessionContext, 'basis' | 'head'> | undefined;
  workId: string;
  stateRevision: number;
  goalRevision: number;
  planRevision: number;
  eventCursor: number;
  policyDigest: string;
  dataGeneration: number;
  toolsDigest: string;
  knowledgeDigest: string;
}
export interface ContextMetrics {
  baselinePacketBytes: number;
  baselineToolBytes: number;
  packetBytes: number;
  toolBytes: number;
  envelopeBytes: number;
  requestBytes: number;
  estimatedTokens: number;
  estimateMethod: string;
  outputTokenReservation: number;
  sourceReads: number;
  extraModelCalls: 0;
  evictions: number;
  reloads: number;
}
