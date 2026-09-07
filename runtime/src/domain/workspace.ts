import type { ArtifactRef } from './model.js';

export interface WorkspaceFile {
  workId: string;
  attemptId: string;
  path: string;
  tenantId: string;
  labels: string[];
  lifecycleGeneration: number;
  sha256: string;
  byteLength: number;
}

export interface WorkspaceCheckpoint {
  id: string;
  workId: string;
  attemptId: string;
  path: string;
  artifact: ArtifactRef;
  sourceEvidenceIds: string[];
  lifecycleGeneration: number;
  createdAt: number;
}
