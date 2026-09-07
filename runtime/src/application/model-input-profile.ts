import type { ModelCall } from '../domain/model.js';
import type { Digester, Planner } from './ports.js';
import { ModelIdentitySchema } from './model-contracts.js';
import { ModelInputBudgetError, resolveModelInputLimits, validateModelInputEstimationProfile,
  type ModelInputRuntimeLimits } from './model-input-budget.js';
import { asJson } from './plan-validator.js';

export type ModelInputPurpose = 'planning' | 'agent_turn' | 'session_compact';
type ProfilePlanner = Pick<Planner, 'identity' | 'destination' | 'capabilities' | 'inputEstimation'>;

/** Captures host registration, without estimating a request or invoking a model. */
export function inputProfileSnapshot(planner: ProfilePlanner, purpose: ModelInputPurpose, runtime: ModelInputRuntimeLimits) {
  const parsedIdentity = ModelIdentitySchema.safeParse(planner?.identity);
  if (!parsedIdentity.success || !['planning', 'agent_turn', 'session_compact'].includes(purpose) ||
      typeof planner.destination !== 'string' || !planner.destination.trim() || planner.destination.length > 256)
    throw new ModelInputBudgetError('model_window_configuration_invalid');
  const identity = Object.freeze(parsedIdentity.data), capabilities = planner.capabilities;
  const effectiveLimits = resolveModelInputLimits(capabilities, runtime);
  if ([capabilities.structuredOutput, capabilities.toolCalling, capabilities.images, capabilities.cancellation]
    .some(value => typeof value !== 'boolean')) throw new ModelInputBudgetError('model_window_configuration_invalid');
  // Legacy hooks have no independent registration. Changing their implementation without changing
  // the adapter revision remains undetectable; function text is not a stable execution identity.
  const inputEstimation = validateModelInputEstimationProfile(planner.inputEstimation === undefined ? {
    id: 'legacy_adapter_revision', revision: identity.revision, templateRevision: identity.revision, kind: 'legacy_adapter_revision',
  } : planner.inputEstimation);
  return Object.freeze({ version: 1 as const, purpose, identity, destination: planner.destination,
    capabilities: Object.freeze({ structuredOutput: capabilities.structuredOutput, toolCalling: capabilities.toolCalling,
      images: capabilities.images, cancellation: capabilities.cancellation, maxInputTokens: capabilities.maxInputTokens,
      contextWindowTokens: capabilities.contextWindowTokens ?? null, maxOutputTokens: capabilities.maxOutputTokens ?? null,
      maxInputBytes: capabilities.maxInputBytes ?? null }),
    runtime: Object.freeze({ maxInputBytes: runtime.maxInputBytes, maxOutputTokens: runtime.maxOutputTokens }),
    effectiveLimits, inputEstimation });
}

export type ModelInputProfileSnapshot = ReturnType<typeof inputProfileSnapshot>;

export function inputProfileDigest(digester: Digester, snapshot: ModelInputProfileSnapshot): string {
  return digester.digest(asJson(snapshot));
}

/** null means an unpinned historical call: the caller must check its original input's current fit.
 * This gate is for unsent input only, never for receiving usage or adopting an existing reply. */
export function inputProfileMatches(call: Pick<ModelCall, 'inputProfileDigest'>, currentDigest: string): boolean | null {
  if (call.inputProfileDigest === undefined) return null;
  return /^[a-f0-9]{64}$/.test(currentDigest) && call.inputProfileDigest === currentDigest;
}
