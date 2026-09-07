import type { AgentTurnResult } from '../domain/agent-turn.js';
import type { ArtifactRef, ContextPacket } from '../domain/model.js';
import type { ModelCallOptions, ModelReply } from './ports.js';

export interface AgentTurnProfile {
  agentId: string;
  purpose: string;
  skillsMode: 'off' | 'explicit' | 'on-demand';
}
export interface AgentTurnPrompt {
  version: 1;
  digest: string;
  instructions: string;
  profile: AgentTurnProfile;
}
export interface AgentTurnInput {
  version: 1;
  packet: ContextPacket;
  prompt: AgentTurnPrompt;
  previousAnswer?: { callId: string; artifact: ArtifactRef; result: Extract<AgentTurnResult, { kind: 'answer' }> } | undefined;
}
export type AgentTurnReply =
  | { status: 'ok'; result: AgentTurnResult; inputTokens: number | null; outputTokens: number | null; provider: string; model: string }
  | Exclude<ModelReply, { status: 'ok' }>;
export interface AgentTurnProvider {
  readonly prompt: AgentTurnPrompt;
  estimateTurnInput(input: AgentTurnInput, options: ModelCallOptions): { tokens: number; bytes: number; method: string };
  turn(input: AgentTurnInput, signal: AbortSignal, options: ModelCallOptions): Promise<AgentTurnReply>;
}
