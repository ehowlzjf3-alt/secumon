import type { PersonalMemoryContext } from '../domain/personal-memory.js';
import type { WorkState } from '../domain/model.js';
import type { KnowledgeService } from './knowledge-service.js';
import type { WorkActor } from './work-resources.js';

export type PersonalKnowledgeFactory = (actor: WorkActor, workId?: string) => Promise<KnowledgeService>;
export interface PersonalMemoryContextProvider {
  context(state: WorkState): Promise<PersonalMemoryContext | null>;
  current(state: WorkState, context?: PersonalMemoryContext, signal?: AbortSignal): Promise<boolean>;
}
