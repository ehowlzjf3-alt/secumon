import type { ModelCall, WorkState } from '../domain/model.js';
import type { SessionCompactInput, SessionSummaryRecord } from '../domain/session-compact.js';
import type { ModelCallOptions } from './ports.js';
import type { RuntimeServices } from './services.js';
import { parseContract } from './contracts.js';
import { SessionCompactInputSchema } from './session-compact-contracts.js';
import { sameSessionInput, sessionInputsCurrent } from './session-context.js';
import { asJson } from './plan-validator.js';
import { assessInputFit, type ModelInputFit } from './model-input-budget.js';

export interface CompactRequestOptions { force?: boolean; requestId?: string; expectedGoalRevision?: number }
export interface CompactModelLimits { maxInputBytes: number; maxInputTokens: number; maxOutputTokens: number }
export interface CompactEnvelope { compact: SessionCompactInput; options: ModelCallOptions }

/** Purpose-specific preparation only. Reservation, invocation, usage and recovery stay in PlanningRuntime. */
export class SessionCompactCalls {
  constructor(readonly services: RuntimeServices) {}

  async prepare(state: WorkState, callId: string, limits: CompactModelLimits, force = false) {
    const source = this.services.sessionCompacts;
    if (!source || !this.services.planner.compact) throw new Error('session_compact_unavailable');
    const options: ModelCallOptions = { callId, maxOutputTokens: limits.maxOutputTokens, tools: [] };
    const measured: { last: { serialized: string; bytes: Uint8Array; fit: ModelInputFit } | null } = { last: null };
    const measure = (compact: SessionCompactInput) => {
      const serialized = JSON.stringify({ compact, options }), bytes = new TextEncoder().encode(serialized);
      const estimate = this.services.planner.estimateCompactInput?.(structuredClone(compact), structuredClone(options)) ??
        { tokens: bytes.byteLength + 2048, bytes: bytes.byteLength, method: 'utf8_bytes_with_template_allowance' };
      const fit = assessInputFit(estimate, limits, bytes.byteLength);
      measured.last = { serialized, bytes, fit };
      return fit.kind;
    };
    const value = await source.prepareCompact(state, { ...limits, force, measure });
    if (!value) return null;
    const compact = parseContract(SessionCompactInputSchema, value);
    // Legacy/custom sources may not invoke the optional callback. Validate their final input as well.
    if (measured.last?.serialized !== JSON.stringify({ compact, options })) measure(compact);
    const final = measured.last;
    if (!final || final.fit.kind !== 'fit') throw new Error('session_compact_capacity');
    if (!(await this.current(state, compact))) throw new Error('model_session_changed');
    return { compact, options, bytes: final.bytes, estimate: final.fit.estimate };
  }

  async load(state: WorkState, call: ModelCall): Promise<CompactEnvelope> {
    if (call.purpose !== 'session_compact' || call.semanticVersion !== 3 || !call.compactInputDigest) throw new Error('session_compact_input_invalid');
    const bytes = await this.services.artifacts.get(call.inputArtifact, state.policy);
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Partial<CompactEnvelope>;
    const compact = parseContract(SessionCompactInputSchema, value.compact);
    const options = value.options;
    if (compact.workId !== state.id || compact.inputDigest !== call.compactInputDigest || !options || options.callId !== call.id ||
      options.maxOutputTokens !== call.maxOutputTokens || !Array.isArray(options.tools) || options.tools.length) throw new Error('session_compact_input_invalid');
    return { compact, options };
  }

  async current(state: WorkState, input: SessionCompactInput, signal?: AbortSignal): Promise<boolean> {
    return !signal?.aborted && input.workId === state.id && sameSessionInput(input.basis, state.conversation?.session) &&
      !!this.services.sessionCompacts && await sessionInputsCurrent(this.services, state, signal) &&
      await this.services.sessionCompacts.compactInputCurrent(state, input, signal);
  }

  matchesReceipt(state: WorkState, call: ModelCall, input: SessionCompactInput, receipt: SessionSummaryRecord): boolean {
    const digest = (value: unknown) => this.services.digester.digest(asJson(value));
    return receipt.workId === state.id && receipt.callId === call.id && receipt.inputDigest === input.inputDigest &&
      digest(receipt.scope) === digest(input.basis.scope) && digest(receipt.prefix) === digest(input.prefix) &&
      digest(receipt.previous) === digest(input.previous?.ref ?? null) && receipt.ref.throughSequence === input.prefix.throughSequence &&
      receipt.ref.policyDigest === input.policyDigest;
  }
}
