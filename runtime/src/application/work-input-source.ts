import type { InputDependency } from '../domain/inputs.js';
import type { KnowledgeDependency, TrustedKnowledgeActor } from '../domain/knowledge.js';
import type { WorkState } from '../domain/model.js';
import type { InputAuthority } from './knowledge-ports.js';
import type { StateRepository } from './ports.js';
import type { RuntimeServices } from './services.js';
import type { SourceInputInspection } from './source-input-inspection.js';

/** A host-pinned owner environment for the input graph; no mutation or lifecycle ports are exposed. */
export interface WorkInputSource {
  readonly id: string;
  /** In-process owner identity, preserved by host wrappers and never serialized into a reference. */
  readonly identity?: object;
  readonly state: Pick<StateRepository, 'get'>;
  readonly authority: InputAuthority;
  inspectInput(dependency: InputDependency, work: WorkState, actor: TrustedKnowledgeActor, signal: AbortSignal): Promise<SourceInputInspection>;
  inspectMemory(dependencies: KnowledgeDependency[], actor: TrustedKnowledgeActor, signal: AbortSignal, work: WorkState): Promise<SourceInputInspection>;
  effectsCurrent(state: WorkState): Promise<boolean>;
  inspectCoverage(state: WorkState): ReturnType<NonNullable<NonNullable<RuntimeServices['readCoverage']>['inspect']>>;
}

/** Internal closure edge. A persisted board reference must resolve this again through its registered owner. */
export interface SourceWork { workId: string; source: WorkInputSource }
