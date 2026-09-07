import { z } from 'zod';
import type { AnswerAssessment, ResponseRequirement } from '../domain/agent-turn.js';
import type { AgentTurnProfile, AgentTurnPrompt } from './agent-turn-types.js';

const id = z.string().min(1).max(256);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const ResponseRequirementSchema: z.ZodType<ResponseRequirement> = z.strictObject({
  version: z.literal(1), requestMessageId: id, requestTextDigest: digest, format: z.literal('text'),
});
export const AnswerAssessmentSchema: z.ZodType<AnswerAssessment> = z.strictObject({
  type: z.literal('model_self_review'), verdict: z.enum(['satisfied', 'needs_work']), rationale: z.string().min(1).max(8000),
  missing: z.array(z.string().min(1).max(2000)).max(32), counterarguments: z.array(z.string().min(1).max(2000)).max(32),
});
export const AgentTurnProfileSchema: z.ZodType<AgentTurnProfile> = z.strictObject({
  agentId: id, purpose: z.string().max(4000), skillsMode: z.enum(['off', 'explicit', 'on-demand']),
});
export const AgentTurnPromptSchema: z.ZodType<AgentTurnPrompt> = z.strictObject({
  version: z.literal(1), digest, instructions: z.string().min(1).max(24000), profile: AgentTurnProfileSchema,
});
