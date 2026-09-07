import type { WorkState } from '../domain/model.js';
import type { RuntimeServices } from './services.js';
import type { KnowledgeDependency } from '../domain/knowledge.js';

export function uniqueKnowledgeDependencies(dependencies: KnowledgeDependency[]) {
  return [...new Map(dependencies.map(dependency => [JSON.stringify({ ...dependency,
    sources: dependency.sources.map(({ workRevision: _revision, ...source }) => source) }), dependency])).values()];
}

export function retainedKnowledgeDependencies(state: WorkState) {
  // A later goal or evidence edit can unadopt attempts while retaining derived
  // evidence/files. Keep custody until the whole copied view is quarantined.
  return uniqueKnowledgeDependencies([...state.attempts.flatMap(a => a.knowledgeDependencies ?? []),
    ...(state.personalMemorySelection?.entries.map(entry => entry.dependency) ?? [])]);
}
export async function knowledgeInputsCurrent(services: Pick<RuntimeServices, 'knowledge' | 'inputs'>, state: WorkState): Promise<boolean> {
  const dependencies = retainedKnowledgeDependencies(state);
  const hasInputs = state.attempts.some(attempt => attempt.inputDependencies?.length);
  if (!dependencies.length && !hasInputs) return true;
  if (services.inputs) {
    try { return await services.inputs.current(state); } catch { return false; }
  }
  if (hasInputs) return false;
  if (!dependencies.length) return true;
  if (!services.knowledge) return false;
  for (let offset = 0; offset < dependencies.length; offset += 50) {
    if (!(await services.knowledge.validate(dependencies.slice(offset, offset + 50), state.id, state.policy))) return false;
  }
  return true;
}
