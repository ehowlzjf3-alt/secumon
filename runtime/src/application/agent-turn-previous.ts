import type { WorkState } from '../domain/model.js';
import type { AgentTurnInput } from './agent-turn-types.js';
import { AgentTurnAnswerSchema, AgentTurnCallInputSchema, AgentTurnReplySchema } from './agent-turn-contracts.js';
import { ArtifactSchema } from './contracts.js';
import { asJson } from './plan-validator.js';
import { sameSessionInput } from './session-context.js';
import { readGeneratedAnswerArtifact, type GeneratedAnswerServices } from './generated-answer.js';

/** Revalidate one directly reused draft, including after a new candidate replaces it. No recursive draft-chain traversal. */
export async function agentTurnPreviousAnswerCurrent(services: Pick<GeneratedAnswerServices, 'artifacts' | 'digester'>,
  state: WorkState, turn: AgentTurnInput): Promise<boolean> {
  if (!turn.previousAnswer) return true;
  try {
    const previous = turn.previousAnswer, artifact = ArtifactSchema.parse(previous.artifact);
    const result = AgentTurnAnswerSchema.parse(previous.result), digest = (value: unknown) => services.digester.digest(asJson(value));
    const calls = state.modelCalls.filter(value => value.id === previous.callId), call = calls[0];
    if (calls.length !== 1 || !call || call.purpose !== 'agent_turn' || call.semanticVersion !== 4 || call.status !== 'accepted' ||
      call.expired || call.outcome !== 'ok' || !call.replyArtifact || call.goalRevision !== state.goal.revision ||
      call.basePlanRevision !== (state.plan?.revision ?? 0)) return false;
    if (state.generatedAnswer?.callId === call.id && digest(state.generatedAnswer.artifact) !== digest(artifact)) return false;
    const envelope = AgentTurnCallInputSchema.parse(JSON.parse(await readGeneratedAnswerArtifact(services, state,
      call.inputArtifact, 'application/json', 1024 * 1024)));
    const source = envelope.turn, { digest: promptDigest, ...prompt } = source.prompt;
    if (envelope.options.callId !== call.id || envelope.options.maxOutputTokens !== call.maxOutputTokens ||
      source.packet.workId !== state.id || digest(source.packet.goal) !== digest(state.goal) ||
      !state.conversation?.session || !sameSessionInput(source.packet.session?.basis, state.conversation.session) ||
      !sameSessionInput(turn.packet.session?.basis, state.conversation.session) ||
      source.prompt.profile.agentId !== state.conversation.session.scope.agentId ||
      source.packet.policy.tenantId !== state.policy.tenantId || source.packet.policy.principalId !== state.policy.principalId ||
      promptDigest !== call.agentTurnPromptDigest || digest(prompt) !== promptDigest) return false;
    const text = await readGeneratedAnswerArtifact(services, state, artifact, 'text/plain', 256 * 1024);
    const reply = AgentTurnReplySchema.parse(JSON.parse(await readGeneratedAnswerArtifact(services, state,
      call.replyArtifact, 'application/json', 1024 * 1024)));
    return reply.status === 'ok' && reply.result.kind === 'answer' && reply.provider === call.provider && reply.model === call.model &&
      !!text.trim() && text === result.text && digest(reply.result) === digest(result);
  } catch { return false; }
}
