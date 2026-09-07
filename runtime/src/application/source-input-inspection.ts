import type { KnowledgeDependency } from '../domain/knowledge.js';
import type { SourceWork } from './work-input-source.js';

/** Internal source inspection, not a complete input validation or a model-facing result.
 * The caller must validate every returned work and memory dependency in the same finite closure. */
export interface SourceInputInspection {
  version: string;
  sourceWorkIds: string[];
  /** Foreign work edges explicitly pinned by the reader; never a global state-store fallback. */
  sourceWorks?: SourceWork[] | undefined;
  knowledgeDependencies: KnowledgeDependency[];
  bytesRead: number;
  validUntil?: number | null | undefined;
  current(): Promise<boolean>;
}
