import type { ArtifactRef, WorkState } from '../domain/model.js';

/** Release only a verified superseded head from the current projection; originals stay in their publication receipts. */
export function releaseObservationHead(state: WorkState, subscriptionId: string, previous: ArtifactRef | undefined, next: ArtifactRef): void {
  if (!previous || previous.id === next.id) return;
  const { artifacts: _artifacts, subscriptions, ...other } = state;
  const references = (value: unknown): boolean => {
    if (typeof value === 'string') return value === previous.id || value === previous.sha256 ||
      value === `mission:${previous.sha256}` || value === `resident:${previous.sha256}`;
    if (!value || typeof value !== 'object') return false;
    return Object.values(value).some(references);
  };
  if (references(other) || references(subscriptions?.filter(value => value.id !== subscriptionId))) return;
  state.artifacts = state.artifacts.filter(value => value.id !== previous.id);
}
