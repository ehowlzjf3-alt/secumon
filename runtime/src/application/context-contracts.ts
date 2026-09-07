import { z } from 'zod';
import type { ContextBasis, ContextDecision, ContextMemo, ContextMetrics } from '../domain/context.js';
import type { ContextPacket } from '../domain/model.js';
import type { ToolDefinition } from './ports.js';
import { ContextPacketSchema, ContextMetricsSchema } from './contracts.js';
import { ToolDefinitionSchema } from './resource-contracts.js';
import { AppliedSessionInputSchema, SessionHeadSchema } from './session-contracts.js';

const id = z.string().min(1).max(512);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
export interface ContextFrame {
  schemaVersion: 1;
  kind: 'model_context';
  basis: ContextBasis;
  packet: ContextPacket;
  tools: ToolDefinition[];
  decisions: ContextDecision[];
  memo: ContextMemo;
  metrics: ContextMetrics;
  protectedDigest: string;
}
export const ContextMemoSchema: z.ZodType<ContextMemo> = z.strictObject({ cycle: count.min(1), mode: z.enum(['full', 'compact']), entries: z.array(z.strictObject({
  key: id, digest: hash, useMarker: id.nullable(), lastUsedCycle: count, admittedCycle: count, lastIncludedCycle: count, lastEvictedCycle: count.nullable() })).max(128), evictions: count, reloads: count });
export const ContextFrameSchema: z.ZodType<ContextFrame> = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('model_context'),
  basis: z.strictObject({ workId: id, stateRevision: count.min(1), goalRevision: count.min(1), planRevision: count, eventCursor: count.min(1), policyDigest: hash, dataGeneration: count, toolsDigest: hash, knowledgeDigest: hash,
    personalMemoryDigest: hash.optional(),
    session: z.strictObject({ basis: AppliedSessionInputSchema, head: SessionHeadSchema }).optional() }),
  packet: ContextPacketSchema, tools: z.array(ToolDefinitionSchema).max(1000),
  decisions: z.array(z.strictObject({ key: id, kind: z.enum(['tool', 'evidence', 'result', 'guidance', 'attempt']), version: id, digest: hash,
    representation: z.enum(['full', 'reference', 'omitted']), reason: id, bytes: count })).max(50000), memo: ContextMemoSchema, metrics: ContextMetricsSchema, protectedDigest: hash });
