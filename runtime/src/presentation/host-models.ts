import { captureEngineApi, type EngineApiRegistration } from '../application/engine-extension-contracts.js';
import type { AgentTurnProfile as PromptProfile, AgentTurnPrompt } from '../application/agent-turn-types.js';
import { AgentTurnProfileSchema, AgentTurnPromptSchema } from '../application/agent-turn-base-contracts.js';
import { ModelIdentitySchema } from '../application/model-contracts.js';
import { resolveModelInputLimits, validateModelInputEstimationProfile, type ModelInputRuntimeLimits } from '../application/model-input-budget.js';
import type { ModelIdentity, ModelInputEstimationProfile, Planner } from '../application/ports.js';
import { frozen } from '../application/resource-contracts.js';
import { createAgentTurnPrompt, matchesAgentTurnPrompt } from '../infrastructure/agent-turn-prompt.js';
import { StructuredModelConfigurationSchema } from '../infrastructure/structured-planner.js';

export type RegisteredTurnPlanner = Planner & {
  readonly identity: ModelIdentity;
  readonly prompt: AgentTurnPrompt;
  readonly inputEstimation: ModelInputEstimationProfile;
  turn: NonNullable<Planner['turn']>;
  estimateTurnInput: NonNullable<Planner['estimateTurnInput']>;
  estimateContextPreview: NonNullable<Planner['estimateContextPreview']>;
};
export interface OpenedHostModel {
  planner: RegisteredTurnPlanner;
  inputLimits: ModelInputRuntimeLimits;
  close(): Promise<void>;
}
export interface HostModelRegistration extends EngineApiRegistration {
  execution: 'deterministic_fixture' | 'host_transport';
  open(profile: PromptProfile): Promise<OpenedHostModel>;
}
export interface AgentTurnHost { models: ReadonlyMap<string, HostModelRegistration> }
export interface AgentTurnModelInfo {
  selection: 'synthetic' | 'registered';
  profileName: string | null;
  identity: ModelIdentity;
  compact: boolean;
  execution: HostModelRegistration['execution'];
}

function invalid(cause?: unknown): Error {
  return new Error('agent_model_registration_invalid', cause === undefined ? undefined : { cause });
}

/** Resolve only an exact host-owned name; configuration values never name executable modules. */
export function resolveHostModelRegistration(host: AgentTurnHost | undefined, name: string | null): HostModelRegistration {
  if (!name || !host) throw new Error('agent_turn_provider_unavailable');
  if (name.length > 120 || name.trim() !== name || /[\x00-\x1f\x7f]/.test(name)) throw invalid();
  let registration: HostModelRegistration | undefined;
  try { registration = host.models.get(name); }
  catch (error) { throw invalid(error); }
  if (registration === undefined) throw new Error('agent_turn_provider_unavailable');
  if (!registration || !['deterministic_fixture', 'host_transport'].includes(registration.execution) || typeof registration.open !== 'function') throw invalid();
  // Capture selection and method before an asynchronous open; later map edits do not redirect this lease.
  const api = captureEngineApi(registration), open = registration.open;
  return Object.freeze({ execution: registration.execution, ...(api.engineApi ? { engineApi: api.engineApi } : {}),
    open(profile: PromptProfile) { api.assertCurrent(); return open.call(registration, profile); } });
}

function snapshotPlanner(source: RegisteredTurnPlanner, profile: PromptProfile, limits: ModelInputRuntimeLimits): RegisteredTurnPlanner {
  if (!source || typeof source !== 'object') throw invalid();
  const identity = frozen(ModelIdentitySchema.parse(source.identity));
  const prompt = frozen(AgentTurnPromptSchema.parse(source.prompt));
  if (!matchesAgentTurnPrompt(prompt, createAgentTurnPrompt(profile))) throw invalid();
  const capabilities = frozen(StructuredModelConfigurationSchema.shape.capabilities.parse(source.capabilities));
  if (!capabilities.structuredOutput || typeof source.destination !== 'string' || !source.destination.trim() || source.destination.length > 256) throw invalid();
  resolveModelInputLimits(capabilities, limits);
  const inputEstimation = validateModelInputEstimationProfile(source.inputEstimation);
  const { propose, turn, estimateTurnInput, estimateContextPreview, estimateInput, compact, estimateCompactInput } = source;
  if (typeof propose !== 'function' || typeof turn !== 'function' || typeof estimateTurnInput !== 'function' || typeof estimateContextPreview !== 'function' ||
      estimateInput !== undefined && typeof estimateInput !== 'function' || compact !== undefined && typeof compact !== 'function' ||
      estimateCompactInput !== undefined && typeof estimateCompactInput !== 'function' || (compact === undefined) !== (estimateCompactInput === undefined)) throw invalid();
  return frozen({ identity, prompt, capabilities, inputEstimation, destination: source.destination,
    propose: propose.bind(source), turn: turn.bind(source), estimateTurnInput: estimateTurnInput.bind(source),
    estimateContextPreview: estimateContextPreview.bind(source), ...(estimateInput ? { estimateInput: estimateInput.bind(source) } : {}),
    ...(compact && estimateCompactInput ? { compact: compact.bind(source), estimateCompactInput: estimateCompactInput.bind(source) } : {}) });
}

/** Preserve the original failure and every independent cleanup failure, attempting each closer once. */
export async function closeAgentTurnResources(closers: readonly (() => Promise<void>)[], primary?: { error: unknown }): Promise<void> {
  const errors: unknown[] = primary ? [primary.error] : [];
  for (const close of closers) { try { await close(); } catch (error) { errors.push(error); } }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'agent_profile_cleanup_failed', { cause: errors[0] });
}

/** The factory receives no authority or stored originals. Only the runtime invokes its captured methods. */
export async function openRegisteredHostModel(registration: HostModelRegistration, profile: PromptProfile): Promise<OpenedHostModel> {
  const expected = frozen(AgentTurnProfileSchema.parse(structuredClone(profile)));
  const api = captureEngineApi(registration); api.assertCurrent();
  const opened = await registration.open(expected);
  let close: (() => Promise<void>) | undefined;
  try {
    if (!opened || typeof opened.close !== 'function') throw invalid();
    const rawClose = opened.close.bind(opened); let closing: Promise<void> | undefined;
    close = () => closing ??= Promise.resolve().then(rawClose);
    const supplied = opened.inputLimits;
    if (!supplied || Object.keys(supplied).some(key => !['maxInputBytes', 'maxOutputTokens'].includes(key))) throw invalid();
    const inputLimits = frozen({ maxInputBytes: supplied.maxInputBytes, maxOutputTokens: supplied.maxOutputTokens });
    const planner = snapshotPlanner(opened.planner, expected, inputLimits);
    return Object.freeze({ planner, inputLimits, close });
  } catch (error) {
    const primary = error instanceof Error && error.message === 'agent_model_registration_invalid' ? error : invalid(error);
    await closeAgentTurnResources(close ? [close] : [], { error: primary });
    throw primary;
  }
}
