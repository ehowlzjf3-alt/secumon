import { z } from 'zod';
import type { WorkspaceCheckpoint, WorkspaceFile } from '../domain/workspace.js';
import { ArtifactSchema } from './contracts.js';

const id = z.string().min(1).max(256);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const WorkspacePathSchema = z.string().min(1).max(512).refine(path =>
  !/[\\:\x00-\x1f\x7f]/.test(path) && path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..'), 'invalid_workspace_path');
export const WorkspaceFileSchema: z.ZodType<WorkspaceFile> = z.strictObject({
  workId: id, attemptId: id, path: WorkspacePathSchema, tenantId: id, labels: z.array(id).max(10000), lifecycleGeneration: count,
  sha256: z.string().regex(/^[a-f0-9]{64}$/), byteLength: count,
});
export const WorkspaceCheckpointSchema: z.ZodType<WorkspaceCheckpoint> = z.strictObject({
  id, workId: id, attemptId: id, path: WorkspacePathSchema, artifact: ArtifactSchema, sourceEvidenceIds: z.array(id).max(10000), lifecycleGeneration: count, createdAt: count,
});
export const WorkspaceSourcesSchema = z.strictObject({ sourceEvidenceIds: z.array(id).max(10000).default([]) });
