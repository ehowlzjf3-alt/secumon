import { z } from 'zod';

const id = z.string().min(1).max(256);
const memoryId = z.string().min(1).max(160);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const title = z.string().trim().min(1).max(200);
const body = z.string().min(1).max(10000).refine(value => value.trim().length > 0);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const MemoryDraftOwnerSchema = z.strictObject({ tenantId: id, agentId: id, principalId: id });
export type MemoryDraftOwner = z.infer<typeof MemoryDraftOwnerSchema>;
export const MemoryDraftOriginSchema = z.strictObject({ schemaVersion: z.literal(1), draftId: z.uuid(),
  owner: MemoryDraftOwnerSchema, storeId: z.uuid(), memoryId, baseRevision: revision, baseTitle: title, baseBodyDigest: digest });
export type MemoryDraftOrigin = z.infer<typeof MemoryDraftOriginSchema>;
export const MemoryDraftContentSchema = z.strictObject({ origin: MemoryDraftOriginSchema, title, body });
export type MemoryDraftContent = z.infer<typeof MemoryDraftContentSchema>;
export const MemoryDraftIntentSchema = z.strictObject({ schemaVersion: z.literal(1), applyId: z.uuid(), origin: MemoryDraftOriginSchema,
  title, body, reason: z.string().trim().min(1).max(1000), sessionId: id, workId: id, expectedGoalRevision: revision,
  sourceMessageId: memoryId, memoryCommandId: memoryId, action: z.enum(['revise', 'unchanged']) });
export type MemoryDraftIntent = z.infer<typeof MemoryDraftIntentSchema>;
export const MemoryDraftCreateSchema = z.strictObject({ draftId: z.uuid(), memoryId });
export type MemoryDraftCreateInput = z.infer<typeof MemoryDraftCreateSchema>;
export const MemoryDraftApplySchema = z.strictObject({ draftId: z.uuid(), applyId: z.uuid(), sessionId: id,
  workId: id, expectedGoalRevision: revision, reason: z.string().trim().min(1).max(1000) });
export type MemoryDraftApplyInput = z.infer<typeof MemoryDraftApplySchema>;
export const MemoryDraftResumeSchema = z.strictObject({ applyId: z.uuid(), sessionId: id });
export type MemoryDraftResumeInput = z.infer<typeof MemoryDraftResumeSchema>;

export interface MemoryDraftRepository {
  create(owner: MemoryDraftOwner, input: { draftId: string; memoryId: string; baseRevision: number; title: string; body: string }): Promise<{ origin: MemoryDraftOrigin; path: string }>;
  read(owner: MemoryDraftOwner, draftId: string): Promise<MemoryDraftContent>;
  bind(owner: MemoryDraftOwner, intent: MemoryDraftIntent): Promise<MemoryDraftIntent>;
  operation(owner: MemoryDraftOwner, applyId: string): Promise<MemoryDraftIntent | null>;
}

export interface MemoryDraftStatus {
  applyId: string;
  draftId: string;
  memoryId: string;
  workId: string;
  sessionId: string;
  baseRevision: number;
  stage: 'prepared' | 'source_pending' | 'source_rejected' | 'memory_pending' | 'complete' | 'unchanged';
  sourceStatus: 'not_received' | 'pending' | 'applied' | 'rejected';
  sourceMessageId: string;
  appliedRevision: number | null;
  currentRevision: number | null;
  currentStatus: 'active' | 'retracted' | 'deleted' | null;
  reason: string | null;
}
