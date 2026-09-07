import { z } from 'zod';
import type { AgentTurnResult } from '../domain/agent-turn.js';
import type { AgentTurnInput, AgentTurnReply } from './agent-turn-types.js';
import { ArtifactSchema, ContextPacketSchema, PlanProposalSchema } from './contracts.js';
import { AgentTurnPromptSchema, AnswerAssessmentSchema } from './agent-turn-base-contracts.js';
import { ToolDefinitionSchema } from './resource-contracts.js';

const id = z.string().min(1).max(256);
const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
export const AgentTurnAnswerSchema = z.strictObject({ kind: z.literal('answer'), text: z.string().min(1).max(64000), evidenceIds: z.array(id).max(1000), assessment: AnswerAssessmentSchema });
export const AgentTurnResultSchema: z.ZodType<AgentTurnResult> = z.discriminatedUnion('kind', [
  AgentTurnAnswerSchema,
  z.strictObject({ kind: z.literal('question'), question: z.string().min(1).max(8000) }),
  z.strictObject({ kind: z.literal('plan'), proposal: PlanProposalSchema }),
]);
export const AgentTurnInputSchema: z.ZodType<AgentTurnInput> = z.strictObject({ version: z.literal(1), packet: ContextPacketSchema, prompt: AgentTurnPromptSchema,
  previousAnswer: z.strictObject({ callId: id, artifact: ArtifactSchema, result: AgentTurnAnswerSchema }).optional() });
export const AgentTurnCallInputSchema = z.strictObject({ turn: AgentTurnInputSchema, options: z.strictObject({
  callId: id, maxOutputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), tools: z.array(ToolDefinitionSchema).max(1000),
}) });
export const AgentTurnReplySchema: z.ZodType<AgentTurnReply> = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), result: AgentTurnResultSchema, inputTokens: tokens, outputTokens: tokens, provider: id, model: id }),
  z.strictObject({ status: z.enum(['refused', 'truncated', 'invalid', 'error', 'cancelled']), code: id, inputTokens: tokens, outputTokens: tokens }),
]);
