import { z } from 'zod';
import { AgentTurnInputSchema } from '../application/agent-turn-contracts.js';
import { ContextPacketSchema } from '../application/contracts.js';
import type { ModelContextPreview } from '../application/model-context-preview.js';
import { ModelInputBudgetError, validateModelInputEstimate, validateModelInputEstimationProfile } from '../application/model-input-budget.js';
import type { ModelInputEstimate, ModelInputEstimationProfile } from '../application/ports.js';
import { frozen } from '../application/resource-contracts.js';
import { AppliedSessionInputSchema, SessionEntrySchema } from '../application/session-contracts.js';
import { SessionSummaryViewSchema } from '../application/session-compact-contracts.js';

export interface LocalModelInputEstimator {
  readonly profile: ModelInputEstimationProfile;
  /** Full requests match invoke; previews are headless measurement-only shapes. Both include their actual JSON encoding. Calculate locally. */
  estimate(request: unknown, serialized: string): ModelInputEstimate;
}
export interface RegisteredModelInputEstimator {
  readonly profile: ModelInputEstimationProfile;
  estimate(request: unknown): ModelInputEstimate;
}
const PreviewSessionSchema = z.strictObject({ basis: AppliedSessionInputSchema, entries: z.array(SessionEntrySchema).max(256), summary: SessionSummaryViewSchema.nullable() });

/** Validate the components without inventing a head or claiming this shape can be dispatched. */
export function validateStructuredContextPreview(value: ModelContextPreview): ModelContextPreview {
  if (!value || value.kind !== 'model_context_preview' || Object.keys(value).some(key => !['kind', 'packet', 'session', 'turn'].includes(key)))
    throw new Error('model_context_preview_invalid');
  const packet = ContextPacketSchema.parse(value.packet);
  if (packet.session !== undefined) throw new Error('model_context_preview_invalid');
  const session = value.session === undefined ? undefined : PreviewSessionSchema.parse(value.session);
  let turn: ModelContextPreview['turn'];
  if (value.turn !== undefined) {
    if (!value.turn || Object.keys(value.turn).some(key => !['prompt', 'previousAnswer'].includes(key))) throw new Error('model_context_preview_invalid');
    const parsed = AgentTurnInputSchema.parse({ version: 1, packet, ...value.turn });
    turn = { prompt: parsed.prompt, ...(parsed.previousAnswer === undefined ? {} : { previousAnswer: parsed.previousAnswer }) };
  }
  return frozen({ kind: 'model_context_preview', packet, ...(session === undefined ? {} : { session }), ...(turn === undefined ? {} : { turn }) });
}

/** Captures the selected function and metadata once; no global tokenizer lookup or network fallback. */
export function registerModelInputEstimator(templateRevision: string, selected?: LocalModelInputEstimator): RegisteredModelInputEstimator {
  const fallback = { id: 'utf8-bytes', revision: '1', templateRevision, kind: 'conservative_estimate' as const };
  if (selected !== undefined && typeof selected?.estimate !== 'function')
    throw new ModelInputBudgetError('model_window_configuration_invalid');
  const profile = validateModelInputEstimationProfile(selected === undefined ? fallback : selected?.profile);
  const calculate = selected === undefined ? null : selected.estimate;
  return Object.freeze({ profile, estimate(request: unknown): ModelInputEstimate {
    let serialized: string;
    try {
      const encoded = JSON.stringify(request);
      if (encoded === undefined) throw new Error('model_request_not_serializable');
      serialized = encoded;
    } catch (cause) { throw new ModelInputBudgetError('model_input_estimate_invalid', { cause }); }
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (calculate === null) return validateModelInputEstimate({ tokens: bytes, bytes, method: 'utf8_bytes_estimate' }, bytes);
    let result: unknown;
    try { result = calculate(request, serialized); }
    catch (cause) { throw new ModelInputBudgetError('model_input_estimate_invalid', { cause }); }
    return validateModelInputEstimate(result, bytes);
  } });
}
