import type { WorkState } from '../domain/model.js';
import type { PersonalMemoryContext } from '../domain/personal-memory.js';
import type { RuntimeServices } from './services.js';
import { asJson } from './plan-validator.js';

export function personalMemoryDigest(services: Pick<RuntimeServices, 'digester'>, state: WorkState): string | undefined {
  const selection = state.personalMemorySelection;
  return selection ? services.digester.digest(asJson(selection)) : undefined;
}
export async function readPersonalMemoryContext(services: Pick<RuntimeServices, 'personalMemories'>, state: WorkState) {
  if (!state.personalMemorySelection) return undefined;
  if (!services.personalMemories) throw new Error('personal_memory_unavailable');
  const context = await services.personalMemories.context(state);
  if (!context || !(await services.personalMemories.current(state, context))) throw new Error('personal_memory_changed');
  return context;
}
export async function personalMemoryContextCurrent(services: Pick<RuntimeServices, 'personalMemories'>, state: WorkState,
  context?: PersonalMemoryContext, signal?: AbortSignal): Promise<boolean> {
  if (!state.personalMemorySelection) return context === undefined && !signal?.aborted;
  if (!services.personalMemories || !context || signal?.aborted) return false;
  try { return await services.personalMemories.current(state, context, signal); } catch { return false; }
}
