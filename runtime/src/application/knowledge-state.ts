import type { WorkState } from '../domain/model.js';
import type { RuntimeServices } from './services.js';
import { DataLifecycleService } from './data-lifecycle.js';
import { knowledgeInputsCurrent } from './knowledge-validity.js';
export { knowledgeInputsCurrent } from './knowledge-validity.js';
export async function refreshKnowledge(services: Pick<RuntimeServices, 'state' | 'artifacts' | 'clock' | 'digester' | 'knowledge' | 'inputs'>, workId: string, onChange?: (workId: string) => void): Promise<WorkState> {
  for (let n = 0; n < 8; n++) {
    const state = await services.state.get(workId); if (!state) throw new Error('work_not_found');
    if (await knowledgeInputsCurrent(services, state)) return state;
    try { return await new DataLifecycleService(services, onChange).invalidateKnowledge(workId, state.revision); }
    catch (error) { if (!(error instanceof Error && error.message === 'knowledge_state_changed')) throw error; }
  }
  throw new Error('knowledge_state_contention');
}
