import type { ModelCapabilities, ModelInputEstimate, ModelInputEstimationProfile } from './ports.js';

export class ModelInputBudgetError extends Error {
  constructor(readonly code: 'model_window_configuration_invalid' | 'model_input_estimate_invalid', options?: ErrorOptions) {
    super(code, options); this.name = 'ModelInputBudgetError';
  }
}

export interface ModelInputLimits {
  readonly maxInputTokens: number;
  readonly maxInputBytes: number;
  /** The output reservation requested for this call; it is never silently reduced. */
  readonly maxOutputTokens: number;
  readonly contextWindowTokens: number | null;
  readonly declaredMaxInputTokens: number;
  readonly declaredMaxOutputTokens: number | null;
}
export interface ModelInputRuntimeLimits { maxInputBytes: number; maxOutputTokens: number }
export type ModelInputFit =
  | { kind: 'fit'; estimate: ModelInputEstimate; exceeds: { tokens: false; bytes: false } }
  | { kind: 'too_large'; estimate: ModelInputEstimate; exceeds: { tokens: boolean; bytes: boolean } };

function positive(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function nonnegative(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function invalidConfiguration(): never { throw new ModelInputBudgetError('model_window_configuration_invalid'); }

export function validateModelInputEstimationProfile(value: unknown): ModelInputEstimationProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidConfiguration();
  const profile = value as Record<string, unknown>;
  if (Object.keys(profile).some(key => !['id', 'revision', 'templateRevision', 'kind'].includes(key))) invalidConfiguration();
  const id = profile['id'], revision = profile['revision'], templateRevision = profile['templateRevision'], kind = profile['kind'];
  for (const item of [id, revision, templateRevision]) if (typeof item !== 'string' || !item.trim() || item.length > 256) invalidConfiguration();
  if (kind !== 'tokenizer' && kind !== 'conservative_estimate' && kind !== 'legacy_adapter_revision') invalidConfiguration();
  return Object.freeze({ id: id as string, revision: revision as string, templateRevision: templateRevision as string, kind });
}

/** Model window capacity is distinct from the work's spend/allocation ledger. */
export function resolveModelInputLimits(capabilities: ModelCapabilities, runtime: ModelInputRuntimeLimits): ModelInputLimits {
  if (!capabilities || !runtime || !positive(capabilities.maxInputTokens) || !positive(runtime.maxInputBytes) || !positive(runtime.maxOutputTokens)) invalidConfiguration();
  for (const value of [capabilities.contextWindowTokens, capabilities.maxOutputTokens, capabilities.maxInputBytes])
    if (value !== undefined && !positive(value)) invalidConfiguration();
  const output = runtime.maxOutputTokens, window = capabilities.contextWindowTokens ?? null;
  const outputCap = capabilities.maxOutputTokens ?? null;
  if ((outputCap !== null && output > outputCap) || (window !== null && output >= window)) invalidConfiguration();
  const maxInputTokens = window === null ? capabilities.maxInputTokens : Math.min(capabilities.maxInputTokens, window - output);
  if (!positive(maxInputTokens) || !Number.isSafeInteger(maxInputTokens + output)) invalidConfiguration();
  return Object.freeze({ maxInputTokens, maxInputBytes: Math.min(runtime.maxInputBytes, capabilities.maxInputBytes ?? runtime.maxInputBytes),
    maxOutputTokens: output, contextWindowTokens: window, declaredMaxInputTokens: capabilities.maxInputTokens, declaredMaxOutputTokens: outputCap });
}

/** Reject malformed estimates instead of treating provider errors as a reason to compact user data. */
export function validateModelInputEstimate(value: unknown, minimumEnvelopeBytes: number): ModelInputEstimate {
  if (!nonnegative(minimumEnvelopeBytes) || !value || typeof value !== 'object' || Array.isArray(value))
    throw new ModelInputBudgetError('model_input_estimate_invalid');
  const estimate = value as Record<string, unknown>;
  if (!positive(estimate['tokens']) || !nonnegative(estimate['bytes']) || estimate['bytes'] < minimumEnvelopeBytes ||
      typeof estimate['method'] !== 'string' || estimate['method'].trim().length === 0 || estimate['method'].length > 256)
    throw new ModelInputBudgetError('model_input_estimate_invalid');
  return Object.freeze({ tokens: estimate['tokens'], bytes: estimate['bytes'], method: estimate['method'] });
}

export function assessInputFit(estimate: ModelInputEstimate, limits: Pick<ModelInputLimits, 'maxInputTokens' | 'maxInputBytes'>,
  minimumEnvelopeBytes: number): ModelInputFit {
  if (!limits || !positive(limits.maxInputTokens) || !positive(limits.maxInputBytes)) invalidConfiguration();
  const validated = validateModelInputEstimate(estimate, minimumEnvelopeBytes);
  const tokens = validated.tokens > limits.maxInputTokens, bytes = validated.bytes > limits.maxInputBytes;
  return tokens || bytes ? { kind: 'too_large', estimate: validated, exceeds: { tokens, bytes } } :
    { kind: 'fit', estimate: validated, exceeds: { tokens: false, bytes: false } };
}
