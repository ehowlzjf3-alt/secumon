import type { ArtifactRef } from './model.js';

/** Internal custody for an observed tool input. Keep it out of model/public output. */
export interface InputDependency { provider: string; workId: string; artifact: ArtifactRef }
