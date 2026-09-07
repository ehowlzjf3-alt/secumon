import type { ToolExecution, ToolUsage, WorkState } from '../domain/model.js';
import { isEndedToolReservation } from '../domain/task-status.js';
export { isEndedToolReservation } from '../domain/task-status.js';
import { ToolExecutionSchema } from './contracts.js';

export function toolExecution(mode: ToolExecution['mode'], usage?: ToolUsage): ToolExecution {
  const uninvoked = mode === 'reused' || mode === 'not_invoked';
  return { mode, implementationCalls: mode === 'invoked' ? 1 : mode === 'unreported' ? null : 0,
    usage: uninvoked ? { transportCalls: 0, internalOperations: 0, imageBytes: 0, waitMs: 0 } :
      structuredClone(usage ?? { transportCalls: null, internalOperations: null, imageBytes: null, waitMs: null }) };
}

/** Refines one attempt's measurements; repeated observations are never summed. */
export function mergeToolExecution(prior: ToolExecution | undefined, reported: ToolExecution): ToolExecution {
  const next = ToolExecutionSchema.parse(reported);
  if (!prior) return structuredClone(next);
  const previous = ToolExecutionSchema.parse(prior);
  if (previous.mode !== next.mode && previous.mode !== 'unreported' && next.mode !== 'unreported')
    throw new Error('tool_execution_usage_conflict');
  const mode = previous.mode === 'unreported' ? next.mode : previous.mode;
  const usage = structuredClone(previous.usage);
  for (const key of ['transportCalls', 'internalOperations', 'imageBytes', 'waitMs'] as const) {
    const old = usage[key], incoming = next.usage[key];
    if (old !== null && incoming !== null && old !== incoming) throw new Error('tool_execution_usage_conflict');
    usage[key] = old ?? incoming;
  }
  return ToolExecutionSchema.parse({ mode, implementationCalls: mode === 'invoked' ? 1 : mode === 'unreported' ? null : 0, usage });
}

/** A dispatch without a settled local measurement remains unknown after a crash. */
export function summarizeToolExecution(state: WorkState) {
  const attempts = state.attempts.filter(a => a.status !== 'reserved' && !isEndedToolReservation(a) &&
    (a.execution || a.resultArtifact || a.status !== 'cancelled'));
  const reported = [...attempts.map(a => a.execution ?? toolExecution('unreported')),
    ...(state.computerReconciliations ?? []).filter(record => record.dispatchedAt !== null).map(record => record.execution)];
  const sum = (key: keyof ToolUsage) => ({ measured: reported.reduce((n, e) => n + (e.usage[key] ?? 0), 0), unknown: reported.filter(e => e.usage[key] === null).length });
  return { logicalAttempts: state.budget.used.toolCalls, invoked: reported.filter(e => e.mode === 'invoked').length,
    reused: reported.filter(e => e.mode === 'reused').length, notInvoked: reported.filter(e => e.mode === 'not_invoked').length,
    unknownInvocations: reported.filter(e => e.implementationCalls === null).length,
    transportCalls: sum('transportCalls'), internalOperations: sum('internalOperations'), imageBytes: sum('imageBytes'), waitMs: sum('waitMs') };
}
