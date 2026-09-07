import type { ModelCall, WorkState } from '../domain/model.js';
import type { AgentTurnInput } from './agent-turn-types.js';
import type { ModelCallOptions } from './ports.js';
import type { RuntimeServices } from './services.js';
import { ContextCompiler, type ContextInspection, type PreparedContext } from './context-compiler.js';
import { AgentTurnCallInputSchema, AgentTurnInputSchema } from './agent-turn-contracts.js';
import { AgentTurnPromptSchema } from './agent-turn-base-contracts.js';
import { asJson } from './plan-validator.js';
import { sameSessionInput, sessionInputsCurrent } from './session-context.js';
import { readGeneratedAnswerCandidate } from './generated-answer.js';
import type { CompactModelLimits } from './session-compact-runtime.js';
import { validateModelInputEstimate } from './model-input-budget.js';

export interface AgentTurnEnvelope { turn: AgentTurnInput; options: ModelCallOptions }
export interface PreparedAgentTurn extends PreparedContext { turn: AgentTurnInput; bytes: Uint8Array }

/** Purpose-specific input only; model lifecycle and accounting remain in PlanningRuntime. */
export class AgentTurnCalls {
  readonly #preparations = new WeakMap<ContextInspection, () => Promise<PreparedAgentTurn>>();
  constructor(readonly services: RuntimeServices, readonly context: ContextCompiler) {}
  private digest(value: unknown) { return this.services.digester.digest(asJson(value)); }
  promptCurrent(state: WorkState, input: AgentTurnInput): boolean {
    const prompt = this.services.planner.prompt;
    if (!this.services.planner.turn || !prompt || !state.goal.responseRequirement || !state.conversation?.session) return false;
    const { digest, ...body } = input.prompt;
    return digest === this.digest(body) && this.digest(input.prompt) === this.digest(prompt) &&
      input.prompt.profile.agentId === state.conversation.session.scope.agentId &&
      !(prompt.profile.skillsMode === 'off' && (input.packet.activeGuidance?.length ?? 0) > 0);
  }
  private async inputBuilder(state: WorkState) {
    if (!this.services.planner.turn || !this.services.planner.prompt) throw new Error('agent_turn_provider_unavailable');
    const prompt = AgentTurnPromptSchema.parse(this.services.planner.prompt);
    const candidate = await readGeneratedAnswerCandidate(this.services, state);
    const previousAnswer: AgentTurnInput['previousAnswer'] = candidate && state.generatedAnswer ? {
      callId: state.generatedAnswer.callId, artifact: state.generatedAnswer.artifact, result: { kind: 'answer', text: candidate.text,
        evidenceIds: state.generatedAnswer.evidenceIds, assessment: state.generatedAnswer.assessment },
    } : undefined;
    const input = (packet: AgentTurnInput['packet']): AgentTurnInput => ({ version: 1, packet, prompt, ...(previousAnswer ? { previousAnswer } : {}) });
    const estimateInput = (packet: AgentTurnInput['packet'], options: ModelCallOptions) => {
      const turn = input(packet), bytes = new TextEncoder().encode(JSON.stringify({ turn, options })).byteLength;
      return validateModelInputEstimate(this.services.planner.estimateTurnInput?.(structuredClone(turn), structuredClone(options)) ??
        { tokens: bytes + 2048, bytes, method: 'utf8_bytes_with_template_allowance' }, bytes);
    };
    return { input, estimateInput, previewTurn: { prompt, ...(previousAnswer ? { previousAnswer } : {}) } };
  }
  private async finish(state: WorkState, prepared: PreparedContext, input: (packet: AgentTurnInput['packet']) => AgentTurnInput): Promise<PreparedAgentTurn> {
    const turn = AgentTurnInputSchema.parse(input(prepared.packet));
    if (!(await this.outgoingCurrent(state, turn, prepared.options))) throw new Error('agent_turn_input_changed');
    return { ...prepared, turn, bytes: new TextEncoder().encode(JSON.stringify({ turn, options: prepared.options })) };
  }
  async prepare(state: WorkState, callId: string, limits: CompactModelLimits): Promise<PreparedAgentTurn> {
    const builder = await this.inputBuilder(state);
    return this.finish(state, await this.context.prepare(state, { ...limits, callId, estimateInput: builder.estimateInput }), builder.input);
  }
  async inspect(state: WorkState, callId: string, limits: CompactModelLimits): Promise<ContextInspection> {
    const builder = await this.inputBuilder(state);
    const inspection = await this.context.inspect(state, { ...limits, callId, estimateInput: builder.estimateInput, previewTurn: builder.previewTurn });
    if (inspection.kind === 'fits') this.#preparations.set(inspection, async () => this.finish(state, await this.context.materialize(inspection), builder.input));
    return inspection;
  }
  async materialize(inspection: ContextInspection): Promise<PreparedAgentTurn> {
    const prepare = this.#preparations.get(inspection);
    if (!prepare || inspection.kind !== 'fits') throw new Error('context_preparation_unavailable');
    this.#preparations.delete(inspection); return prepare();
  }
  async load(state: WorkState, call: ModelCall): Promise<AgentTurnEnvelope> {
    if (call.purpose !== 'agent_turn' || call.semanticVersion !== 4 || !call.agentTurnPromptDigest) throw new Error('agent_turn_input_invalid');
    const bytes = await this.services.artifacts.get(call.inputArtifact, state.policy);
    const input = AgentTurnCallInputSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (input.turn.packet.workId !== state.id || input.turn.prompt.digest !== call.agentTurnPromptDigest ||
      input.options.callId !== call.id || input.options.maxOutputTokens !== call.maxOutputTokens) throw new Error('agent_turn_input_invalid');
    return input;
  }
  async outgoingCurrent(state: WorkState, input: AgentTurnInput, options: ModelCallOptions, signal?: AbortSignal): Promise<boolean> {
    return await this.current(state, input, options, signal) && this.context.outgoingDefinitionsCurrent(input.packet, options, state);
  }
  async current(state: WorkState, input: AgentTurnInput, options: ModelCallOptions, signal?: AbortSignal): Promise<boolean> {
    return !signal?.aborted && this.promptCurrent(state, input) && input.packet.workId === state.id &&
      this.digest(input.packet.goal) === this.digest(state.goal) && sameSessionInput(input.packet.session?.basis, state.conversation?.session) &&
      await sessionInputsCurrent(this.services, state, signal) && this.context.definitionsCurrent(input.packet, options, state) &&
      !!this.services.generatedAnswers && await this.services.generatedAnswers.current(state, input, options) &&
      await this.context.sourcesCurrent(input.packet, state, signal);
  }
}
