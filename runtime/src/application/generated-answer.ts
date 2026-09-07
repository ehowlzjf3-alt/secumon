import type { ArtifactRef, Delivery, WorkState } from '../domain/model.js';
import { accessibleEvidence } from '../domain/completion.js';
import { dataGeneration, visibleArtifact } from '../domain/data-lifecycle.js';
import type { AgentTurnInput } from './agent-turn-types.js';
import { AgentTurnCallInputSchema, AgentTurnReplySchema } from './agent-turn-contracts.js';
import { ArtifactSchema, GeneratedAnswerSchema } from './contracts.js';
import type { ModelCallOptions } from './ports.js';
import type { RuntimeServices } from './services.js';
import { asJson } from './plan-validator.js';
import { sameSessionInput, sessionContextCurrent } from './session-context.js';
import { personalMemoryContextCurrent } from './personal-memory-context.js';
import { knowledgeInputsCurrent } from './knowledge-validity.js';

export interface GeneratedAnswerValidator {
  /** Revalidate prompt/tool/guidance sources and the original response request's applied receipt, owner, labels and text digest.
   * The original request may have left the packet's raw tail after compact; it must still be checked in canonical session storage. */
  current(state: WorkState, input: AgentTurnInput, options: ModelCallOptions): Promise<boolean>;
}
export type GeneratedAnswerServices = Pick<RuntimeServices, 'digester' | 'sessions' | 'personalMemories' | 'knowledge' | 'inputs'> & {
  state: Pick<RuntimeServices['state'], 'get'>;
  artifacts: Pick<RuntimeServices['artifacts'], 'get'>;
  generatedAnswers?: GeneratedAnswerValidator | undefined;
};

/** Business inputs only: accepting, preparing and delivering this answer cannot invalidate its own basis. */
export function generatedAnswerBasis(services: Pick<RuntimeServices, 'digester'>, state: WorkState): string {
  return services.digester.digest(asJson({ workId: state.id, goal: state.goal, policy: state.policy, plan: state.plan,
    attempts: state.attempts, evidence: state.evidence, hypotheses: state.hypotheses, hypothesisAssessment: state.hypothesisAssessment,
    obligations: state.obligations.filter(obligation => obligation.kind !== 'delivery'),
    computerReconciliations: state.computerReconciliations ?? [], computerContinuations: state.computerContinuations ?? [],
    notifications: state.notifications ?? [], disclosureLabels: state.disclosureLabels ?? [], dataGeneration: dataGeneration(state),
    session: state.conversation?.session ?? null, sessionReviewRequired: state.conversation?.sessionReviewRequired ?? false,
    personalMemorySelection: state.personalMemorySelection ?? null, personalMemoryReviewRequired: state.personalMemoryReviewRequired ?? false }));
}

/** Includes the assessment and both source/body references, not just unchanged fact evidence. */
export function generatedAnswerDigest(services: Pick<RuntimeServices, 'digester'>, state: WorkState): string | undefined {
  return state.goal.responseRequirement && state.generatedAnswer ? services.digester.digest(asJson(state.generatedAnswer)) : undefined;
}

export async function readGeneratedAnswerArtifact(services: Pick<GeneratedAnswerServices, 'artifacts'>, state: WorkState,
  reference: ArtifactRef, mediaType: string, maximum: number): Promise<string> {
  const ref = ArtifactSchema.parse(reference);
  // The accepted call and answer pin these references; model inputs/replies need not also be in the work artifact list.
  if (!visibleArtifact(state, ref) || ref.mediaType !== mediaType || ref.byteLength > maximum) throw new Error('generated_answer_artifact_unavailable');
  const bytes = await services.artifacts.get(structuredClone(ref), state.policy);
  if (bytes.byteLength !== ref.byteLength || bytes.byteLength > maximum) throw new Error('generated_answer_artifact_unavailable');
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
  const sha256 = Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
  if (sha256 !== ref.sha256) throw new Error('generated_answer_artifact_unavailable');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** No writes or inference. Failure never falls back to an unverified answer body. */
export async function readGeneratedAnswerCandidate(services: GeneratedAnswerServices, state: WorkState): Promise<{ text: string; answerDigest: string } | null> {
  if (!state.goal.responseRequirement || !state.generatedAnswer || !services.generatedAnswers) return null;
  try {
    const answer = GeneratedAnswerSchema.parse(state.generatedAnswer), requirement = state.goal.responseRequirement;
    const digest = (value: unknown) => services.digester.digest(asJson(value));
    const answerDigest = digest(answer);
    if (answer.basisDigest !== generatedAnswerBasis(services, state) || answer.goalRevision !== state.goal.revision ||
      answer.planRevision !== (state.plan?.revision ?? 0) || answer.dataGeneration !== dataGeneration(state) ||
      !sameSessionInput(answer.input, state.conversation?.session) || answer.input.scope.tenantId !== state.policy.tenantId ||
      answer.input.scope.principalId !== state.policy.principalId ||
      state.conversation?.sessionReviewRequired || state.personalMemoryReviewRequired) return null;
    const calls = state.modelCalls.filter(call => call.id === answer.callId), call = calls[0];
    if (calls.length !== 1 || !call || call.purpose !== 'agent_turn' || call.semanticVersion !== 4 || call.status !== 'accepted' ||
      call.expired || call.outcome !== 'ok' || !call.replyArtifact || call.goalRevision !== answer.goalRevision ||
      call.basePlanRevision !== answer.planRevision || call.agentTurnPromptDigest !== answer.promptDigest ||
      digest(call.inputArtifact) !== digest(answer.inputArtifact)) return null;
    const envelope = AgentTurnCallInputSchema.parse(JSON.parse(await readGeneratedAnswerArtifact(services, state, answer.inputArtifact, 'application/json', 1024 * 1024)));
    const { turn, options } = envelope, packet = turn.packet;
    const { digest: promptDigest, ...prompt } = turn.prompt;
    if (options.callId !== call.id || options.maxOutputTokens !== call.maxOutputTokens ||
      promptDigest !== answer.promptDigest || digest(prompt) !== promptDigest || turn.prompt.profile.agentId !== answer.input.scope.agentId ||
      packet.workId !== state.id || digest(packet.goal) !== digest(state.goal) ||
      !sameSessionInput(packet.session?.basis, answer.input)) return null;
    const source = packet.session?.entries.filter(entry => entry.role === 'user' && entry.sourceId === requirement.requestMessageId && entry.workId === state.id);
    if (!source || source.length > 1 || source.some(entry => entry.sequence > answer.input.input.sequence ||
      !entry.labels.every(label => state.policy.allowedLabels.includes(label)) || services.digester.digest(entry.text) !== requirement.requestTextDigest)) return null;
    const visibleIds = accessibleEvidence(state.evidence, state.policy, state.goal.scope).map(item => item.id).sort();
    if (digest([...answer.observedEvidenceIds].sort()) !== digest(visibleIds) || new Set(answer.evidenceIds).size !== answer.evidenceIds.length ||
      answer.evidenceIds.some(id => !visibleIds.includes(id))) return null;
    const text = await readGeneratedAnswerArtifact(services, state, answer.artifact, 'text/plain', 256 * 1024);
    const reply = AgentTurnReplySchema.parse(JSON.parse(await readGeneratedAnswerArtifact(services, state, call.replyArtifact, 'application/json', 1024 * 1024)));
    if (reply.status !== 'ok' || reply.result.kind !== 'answer' || reply.provider !== call.provider || reply.model !== call.model ||
      !text.trim() || text !== reply.result.text || digest(reply.result.evidenceIds) !== digest(answer.evidenceIds) ||
      digest(reply.result.assessment) !== digest(answer.assessment)) return null;
    if (!(await knowledgeInputsCurrent(services, state)) || !(await sessionContextCurrent(services, state, packet.session)) ||
      !(await personalMemoryContextCurrent(services, state, packet.personalMemory)) || !(await services.generatedAnswers.current(state, turn, options))) return null;
    // Storage/currentness checks can suspend. Recheck the work after the final external source check.
    const latest = await services.state.get(state.id);
    if (!latest || latest.revision !== state.revision || generatedAnswerDigest(services, latest) !== answerDigest ||
      generatedAnswerBasis(services, latest) !== answer.basisDigest) return null;
    return { text, answerDigest };
  } catch { return null; }
}

export async function readGeneratedAnswer(services: GeneratedAnswerServices, state: WorkState): Promise<{ text: string; answerDigest: string } | null> {
  if (state.generatedAnswer?.assessment.verdict !== 'satisfied' || state.generatedAnswer.assessment.missing.length) return null;
  return readGeneratedAnswerCandidate(services, state);
}

export async function generatedAnswerCurrent(services: GeneratedAnswerServices, state: WorkState,
  expected: string | undefined = generatedAnswerDigest(services, state)): Promise<boolean> {
  if (!state.goal.responseRequirement) return expected === undefined;
  const answer = await readGeneratedAnswer(services, state);
  return answer !== null && answer.answerDigest === expected;
}

export function responseText(text: string, artifact: ArtifactRef): string {
  return text.length <= 12000 ? text : `${text.slice(0, 11000)}\n… 일부 결과를 줄여 표시했습니다. 전체 결과 산출물: ${artifact.id}`;
}

/** The saved outbound body must be the projection of the verified candidate, not merely share its ID. */
export async function generatedDeliveryCurrent(services: GeneratedAnswerServices, state: WorkState, delivery: Delivery): Promise<boolean> {
  if (delivery.kind !== 'result') return true;
  if (!state.goal.responseRequirement) return delivery.context?.generatedAnswerDigest === undefined;
  const answer = await readGeneratedAnswer(services, state), candidate = state.generatedAnswer;
  if (!answer || !candidate || delivery.context?.generatedAnswerDigest !== answer.answerDigest ||
    state.conversation?.result?.generatedAnswerDigest !== answer.answerDigest) return false;
  const digest = (value: unknown) => services.digester.digest(asJson(value));
  return digest(delivery.context.artifact) === digest(candidate.artifact) &&
    digest(state.conversation.result.artifact) === digest(candidate.artifact) && delivery.text === responseText(answer.text, candidate.artifact);
}
