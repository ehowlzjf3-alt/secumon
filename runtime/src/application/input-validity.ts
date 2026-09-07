import type { WorkState } from '../domain/model.js';
import type { InputDependency } from '../domain/inputs.js';
import type { RuntimeServices } from './services.js';
import { knowledgeInputsCurrent } from './knowledge-validity.js';

export function uniqueInputDependencies(dependencies: InputDependency[]): InputDependency[] {
  return [...new Map(dependencies.map(value => [JSON.stringify(value), value])).values()];
}
export function retainedInputDependencies(state: WorkState): InputDependency[] {
  return uniqueInputDependencies(state.attempts.flatMap(attempt => attempt.inputDependencies ?? []));
}
export async function workInputsCurrent(services: Pick<RuntimeServices, 'knowledge' | 'inputs'>, state: WorkState): Promise<boolean> {
  return knowledgeInputsCurrent(services, state);
}
