import type { ContextPacket, Json } from '../domain/model.js';
import type { AppliedSessionInput, SessionEntry } from '../domain/session.js';
import type { SessionSummaryView } from '../domain/session-compact.js';
import type { AgentTurnInput } from './agent-turn-types.js';
import type { ModelCallOptions, ModelInputEstimate, Planner } from './ports.js';
import { validateModelInputEstimate } from './model-input-budget.js';

/** An unpublished measurement shape. It is not a SessionContext, source receipt, or dispatchable packet. */
export interface ModelContextPreview {
  kind: 'model_context_preview';
  packet: Omit<ContextPacket, 'session'>;
  session?: { basis: AppliedSessionInput; entries: SessionEntry[]; summary: SessionSummaryView | null };
  turn?: Pick<AgentTurnInput, 'prompt' | 'previousAnswer'>;
}

const encodedBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
/** No fabricated SessionHead is inserted. A provider may measure this JSON shape locally only. */
export function modelContextPreviewPacket(preview: ModelContextPreview): Json {
  const { session: _untrustedSession, ...packet } = preview.packet as ContextPacket;
  if (_untrustedSession !== undefined) throw new Error('model_context_preview_invalid');
  return JSON.parse(JSON.stringify({ ...packet, ...(preview.session ? { session: {
    schemaVersion: preview.session.summary ? 2 : 1, basis: preview.session.basis, entries: preview.session.entries,
    ...(preview.session.summary ? { summary: preview.session.summary } : {}), interpretation: 'conversation_history_not_verified_evidence',
  } } : {}) })) as Json;
}
export function modelContextPreviewEnvelope(preview: ModelContextPreview, options: ModelCallOptions): Json {
  const packet = modelContextPreviewPacket(preview);
  return preview.turn ? { turn: { version: 1, packet, prompt: preview.turn.prompt as unknown as Json,
    ...(preview.turn.previousAnswer ? { previousAnswer: preview.turn.previousAnswer as unknown as Json } : {}) }, options: options as unknown as Json } :
    { packet, options: options as unknown as Json };
}

/** A conservative selection hint, always followed by measurement of the actual published request. */
export function estimateModelContextPreview(planner: Planner, preview: ModelContextPreview, options: ModelCallOptions): ModelInputEstimate {
  const envelopeBytes = encodedBytes(modelContextPreviewEnvelope(preview, options));
  const measured = planner.estimateContextPreview?.(structuredClone(preview), structuredClone(options)) ??
    { tokens: envelopeBytes + 2048, bytes: envelopeBytes, method: 'preview_utf8_bytes_with_template_allowance' };
  const valid = validateModelInputEstimate(measured, envelopeBytes);
  // The bounded head schema has two 64-hex hashes and two safe-integer fields. Reserve metadata separately, not as a fake head.
  const allowance = preview.session ? 512 : 0;
  if (!Number.isSafeInteger(valid.bytes + allowance) || !Number.isSafeInteger(valid.tokens + allowance)) throw new Error('model_input_estimate_invalid');
  return { bytes: valid.bytes + allowance, tokens: valid.tokens + allowance, method: 'preview_hint:' + valid.method.slice(0, 230) };
}
