import { AgentTurnInputSchema, AgentTurnReplySchema, AgentTurnResultSchema } from '../application/agent-turn-contracts.js';
import type { AgentTurnInput, AgentTurnProfile, AgentTurnPrompt, AgentTurnProvider, AgentTurnReply } from '../application/agent-turn-types.js';
import type { ModelCallOptions, ModelCapabilities, ModelIdentity, ModelInputEstimate, ModelInputEstimationProfile, ModelReply, Planner } from '../application/ports.js';
import { modelContextPreviewPacket, type ModelContextPreview } from '../application/model-context-preview.js';
import { frozen } from '../application/resource-contracts.js';
import type { ContextPacket } from '../domain/model.js';
import { createAgentTurnPrompt, matchesAgentTurnPrompt } from './agent-turn-prompt.js';
import { registerModelInputEstimator, validateStructuredContextPreview, type RegisteredModelInputEstimator } from './model-input-estimator.js';
import { StructuredModelConfigurationSchema, StructuredModelOptionsSchema, StructuredModelResponseSchema,
  structuredModelUsage, structuredModelWithinBytes, structuredModelRequestPolicy, type StructuredPlannerConfiguration } from './structured-planner.js';

export interface StructuredAgentTurnRequest { identity: ModelIdentity; input: AgentTurnInput; options: ModelCallOptions }
export interface StructuredAgentTurnTransport { invoke(request: StructuredAgentTurnRequest, signal: AbortSignal): Promise<unknown> }
export interface StructuredAgentTurnConfiguration extends StructuredPlannerConfiguration { profile: AgentTurnProfile }

type RequestCode = 'model_destination_denied' | 'model_disclosure_denied' | 'model_tool_contract_denied' |
  'model_request_too_large' | 'model_request_invalid' | 'model_prompt_mismatch' | 'model_agent_identity_mismatch';
class TurnRequestError extends Error { constructor(readonly code: RequestCode) { super(code); } }
const noUsage = () => ({ inputTokens: 0, outputTokens: 0 });

/** Transport-neutral structured turn; only the host-provided transport may contact a model. */
export class StructuredAgentTurnAdapter implements Planner, AgentTurnProvider {
  readonly identity: ModelIdentity;
  readonly destination: string;
  readonly capabilities: ModelCapabilities;
  readonly inputEstimation: ModelInputEstimationProfile;
  readonly prompt: AgentTurnPrompt;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;
  readonly #invoke: StructuredAgentTurnTransport['invoke'];
  readonly #estimator: RegisteredModelInputEstimator;

  constructor(configuration: StructuredAgentTurnConfiguration, transport: StructuredAgentTurnTransport) {
    const { profile, inputEstimator, ...base } = configuration;
    const parsed = StructuredModelConfigurationSchema.safeParse(base);
    if (!parsed.success || !transport || typeof transport.invoke !== 'function') throw new Error('invalid_structured_agent_turn_configuration');
    const config = frozen(parsed.data);
    this.prompt = createAgentTurnPrompt(profile);
    this.identity = config.identity; this.destination = config.destination;
    this.#maxRequestBytes = Math.min(config.maxRequestBytes, config.capabilities.maxInputBytes ?? config.maxRequestBytes);
    this.capabilities = frozen({ ...config.capabilities, maxInputBytes: this.#maxRequestBytes });
    this.#maxResponseBytes = config.maxResponseBytes;
    this.#estimator = registerModelInputEstimator('structured-agent-turn-request-v1', inputEstimator);
    this.inputEstimation = this.#estimator.profile;
    this.#invoke = transport.invoke.bind(transport);
    Object.freeze(this);
  }

  private requestSnapshot(input: AgentTurnInput, options: ModelCallOptions, enforceBytes = true): { request: StructuredAgentTurnRequest } {
    try {
      const turn = AgentTurnInputSchema.parse(input); const selected = StructuredModelOptionsSchema.parse(options);
      if (!matchesAgentTurnPrompt(turn.prompt, this.prompt)) throw new TurnRequestError('model_prompt_mismatch');
      const packet = turn.packet;
      if (packet.session && packet.session.basis.scope.agentId !== this.prompt.profile.agentId) throw new TurnRequestError('model_agent_identity_mismatch');
      const denied = structuredModelRequestPolicy(packet, selected, this.destination);
      if (denied) throw new TurnRequestError(denied);
      const request = frozen({ identity: { ...this.identity }, input: turn, options: selected });
      if (enforceBytes && !structuredModelWithinBytes(request, this.#maxRequestBytes)) throw new TurnRequestError('model_request_too_large');
      return { request };
    } catch (error) { throw error instanceof TurnRequestError ? error : new TurnRequestError('model_request_invalid'); }
  }

  estimateTurnInput(input: AgentTurnInput, options: ModelCallOptions): ModelInputEstimate {
    return this.#estimator.estimate(this.requestSnapshot(input, options, false).request);
  }

  estimateContextPreview(preview: ModelContextPreview, options: ModelCallOptions): ModelInputEstimate {
    let request: unknown;
    try {
      const draft = validateStructuredContextPreview(preview), selected = StructuredModelOptionsSchema.parse(options);
      if (!draft.turn) throw new TurnRequestError('model_request_invalid');
      if (!matchesAgentTurnPrompt(draft.turn.prompt, this.prompt)) throw new TurnRequestError('model_prompt_mismatch');
      if (draft.session && draft.session.basis.scope.agentId !== this.prompt.profile.agentId) throw new TurnRequestError('model_agent_identity_mismatch');
      const denied = structuredModelRequestPolicy(draft.packet, selected, this.destination);
      if (denied) throw new TurnRequestError(denied);
      request = frozen({ identity: { ...this.identity }, input: { version: 1, packet: modelContextPreviewPacket(draft), ...draft.turn }, options: selected });
    } catch (error) { throw error instanceof TurnRequestError ? error : new TurnRequestError('model_request_invalid'); }
    return this.#estimator.estimate(request);
  }

  async propose(_packet: ContextPacket, signal: AbortSignal, _options?: ModelCallOptions): Promise<ModelReply> {
    return { status: signal.aborted ? 'cancelled' : 'invalid', code: signal.aborted ? 'model_cancelled' : 'model_turn_route_required', ...noUsage() };
  }

  async turn(input: AgentTurnInput, signal: AbortSignal, options: ModelCallOptions): Promise<AgentTurnReply> {
    if (signal.aborted) return { status: 'cancelled', code: 'model_cancelled', ...noUsage() };
    let request: StructuredAgentTurnRequest;
    try { request = this.requestSnapshot(input, options).request; }
    catch (error) { return { status: 'invalid', code: error instanceof TurnRequestError ? error.code : 'model_request_invalid', ...noUsage() }; }
    let raw: unknown;
    try { raw = await this.#invoke(request, signal); }
    catch { return { status: signal.aborted ? 'cancelled' : 'error', code: signal.aborted ? 'model_cancelled' : 'model_transport_failed', inputTokens: null, outputTokens: null }; }
    const usage = structuredModelUsage(raw);
    if (signal.aborted) return { status: 'cancelled', code: 'model_cancelled', ...usage };
    if (!structuredModelWithinBytes(raw, this.#maxResponseBytes)) return { status: 'invalid', code: 'model_response_too_large', ...usage };
    try {
      const parsed = StructuredModelResponseSchema.safeParse(raw);
      if (!parsed.success) return { status: 'invalid', code: 'model_response_invalid', ...usage };
      const reply = parsed.data;
      if (reply.provider !== this.identity.provider || reply.model !== this.identity.model) return { status: 'invalid', code: 'model_identity_mismatch', ...usage };
      if (reply.finish === 'length') return { status: 'truncated', code: 'model_output_truncated', ...usage };
      if (reply.finish === 'refused') return { status: 'refused', code: 'model_refused', ...usage };
      if (reply.finish === 'error') return { status: 'error', code: 'model_provider_failed', ...usage };
      if (reply.content === null) return { status: 'invalid', code: 'model_turn_missing', ...usage };
      let value: unknown;
      try { value = JSON.parse(reply.content) as unknown; }
      catch { return { status: 'invalid', code: 'model_turn_invalid', ...usage }; }
      const result = AgentTurnResultSchema.safeParse(value);
      if (!result.success) return { status: 'invalid', code: 'model_turn_invalid', ...usage };
      return AgentTurnReplySchema.parse({ status: 'ok', result: result.data, provider: this.identity.provider, model: this.identity.model, ...usage });
    } catch { return { status: 'invalid', code: 'model_response_invalid', ...usage }; }
  }
}
