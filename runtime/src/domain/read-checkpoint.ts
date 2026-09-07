import type { KnowledgeDependency } from './knowledge.js';
import type { ArtifactRef, Goal, Policy } from './model.js';
import type { ReadCollectionState, ReadKey, ReadLimits, ReadRequest } from './read-collection.js';
import type { ReadCoverage } from './read-coverage.js';

export interface ReadCall {
  request: ReadRequest;
  attemptId: string;
  status: 'intent' | 'accepted' | 'deferred' | 'rejected' | 'unknown';
  response: ArtifactRef | null;
  dispatchedAt: number;
  receivedAt: number | null;
  errorCode: string | null;
}

export interface ReadCheckpoint {
  schemaVersion: 1;
  kind: 'read_checkpoint';
  operationId: string;
  workId: string;
  rootAttemptId: string;
  attemptId: string;
  goal: Goal;
  policy: Policy;
  lifecycleGeneration: number;
  toolId: string;
  toolVersion: string;
  queryDigest: string;
  contractDigest: string;
  limits: ReadLimits;
  collection: ReadCollectionState;
  calls: ReadCall[];
  parent: { attemptId: string; checkpoint: ArtifactRef } | null;
  artifacts: ArtifactRef[];
  knowledgeDependencies: KnowledgeDependency[];
  phase: 'running' | 'partial' | 'complete';
  stopReason: string | null;
  createdAt: number;
  updatedAt: number;
  retryAt?: number | null | undefined;
  coverageManifest?: ReadKey[] | undefined;
}

export interface ReadResume { attemptId: string; checkpointId: string }
export interface ReadProgress {
  operationId: string;
  head: ArtifactRef;
  callCount: number;
  remainingCalls: number;
  completedPages: number;
  completedItems: number;
  pendingItems: number;
  unknownCalls: number;
  phase: ReadCheckpoint['phase'];
  successorAttemptId: string | null;
  retryAt?: number | null | undefined;
  queryDigest?: string | undefined;
  coverage?: ReadCoverage | undefined;
}
export interface ReadCollectionProof { operationId: string; checkpoint: ArtifactRef }
