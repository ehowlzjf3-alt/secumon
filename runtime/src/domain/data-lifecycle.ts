import type { ArtifactRef, WorkState } from './model.js';

export function dataGeneration(state: WorkState): number { return state.dataLifecycle?.generation ?? 0; }
export function artifactBlocked(state: WorkState, ref: ArtifactRef): boolean {
  return state.dataLifecycle?.blockedArtifactIds.includes(ref.id) ?? false;
}
export function visibleArtifact(state: WorkState, ref: ArtifactRef): boolean {
  return !artifactBlocked(state, ref) && ref.tenantId === state.policy.tenantId && ref.labels.every(label => state.policy.allowedLabels.includes(label));
}
