import type { WorkState } from '../domain/model.js';
import type { ArtifactStore } from './ports.js';
import type { WorkInputSource } from './work-input-source.js';

export interface BoardWorkSource {
  readonly inputs: WorkInputSource;
  readonly artifacts: Pick<ArtifactStore, 'get' | 'exists'>;
  /** Uses this owner's proof services. Graph collection uses inputs instead to retain one finite closure. */
  current(state: WorkState): Promise<boolean>;
}
export interface BoardWorkSources {
  /** Resolve a board-declared author/work only. Missing or ambiguous mappings must not select another owner. */
  resolve(identity: { tenantId: string; principalId: string; workId: string }): Promise<BoardWorkSource | null>;
}
