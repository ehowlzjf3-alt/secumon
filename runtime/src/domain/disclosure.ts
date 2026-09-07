import type { Json, Policy, Scalar, WorkState } from './model.js';

export type DisclosureSurface = 'model' | 'tool' | 'channel' | 'summary' | 'search' | 'log' | 'screen' | 'artifact' | 'a2a';
export interface DisclosurePolicy {
  revision: string;
  destinations: { destination: string; surfaces: DisclosureSurface[]; allowedLabels: string[] }[];
  maxReleasesPerWork: number;
  maxReleasedBytesPerWork: number;
}
export interface DisclosureRule {
  id: string;
  version: string;
  tenantId: string;
  principalId: string;
  scope: string;
  destination: string;
  surface: DisclosureSurface;
  sourceLabels: string[];
  releasedLabels: string[];
  fields: { sourceKey: string; outputKey: string; values: { from: Scalar; to: Scalar }[] }[];
  includeCoverage: boolean;
  maxSources: number;
  maxBytes: number;
}
export interface DisclosurePayload {
  schemaVersion: 1;
  kind: 'released_observations';
  observations: { source: number; basis: number[]; derived: boolean; facts: Record<string, Scalar>; coverage?: 'complete' | 'partial' | 'unknown' | undefined }[];
}
export interface DisclosureRecord {
  id: string;
  requestDigest: string;
  policyDigest: string;
  ruleId: string;
  ruleDigest: string;
  goalRevision: number;
  dataGeneration: number;
  evidenceIds: string[];
  sources: { evidenceId: string; digest: string }[];
  destination: string;
  surface: DisclosureSurface;
  labels: string[];
  payload: DisclosurePayload;
  payloadDigest: string;
  byteLength: number;
  createdAt: number;
}

/** Read authority and destination authority are independent checks. Missing optional policy is legacy behavior. */
export function allowsDisclosure(policy: Policy, destination: string, surface: DisclosureSurface, labels: readonly string[] = policy.allowedLabels): boolean {
  if (!policy.allowedDestinations.includes(destination) || !labels.every(label => policy.allowedLabels.includes(label))) return false;
  if (!policy.disclosure) return true;
  if (!labels.length) return false;
  const rules = policy.disclosure.destinations.filter(rule => rule.destination === destination);
  return rules.length === 1 && rules[0]!.surfaces.includes(surface) && labels.every(label => rules[0]!.allowedLabels.includes(label));
}

/** Unlabelled work prose keeps the greatest admitted label set even after current read authority is reduced. */
export function disclosureLabels(input: { policy: Policy; disclosureLabels?: string[] | undefined }): string[] {
  return [...new Set([...(input.disclosureLabels ?? []), ...input.policy.allowedLabels])].sort();
}

export function disclosurePolicyNarrows(parent: Policy, child: Policy): boolean {
  if (!parent.disclosure) return true;
  if (!child.disclosure || child.disclosure.maxReleasesPerWork > parent.disclosure.maxReleasesPerWork ||
      child.disclosure.maxReleasedBytesPerWork > parent.disclosure.maxReleasedBytesPerWork) return false;
  return child.disclosure.destinations.every(rule => rule.surfaces.every(surface => {
    const original = parent.disclosure!.destinations.find(item => item.destination === rule.destination);
    return original && original.surfaces.includes(surface) && rule.allowedLabels.every(label => original.allowedLabels.includes(label));
  }));
}

/** Adapters validate this under the same compare-and-swap lock as the state commit. */
export function disclosureTransitionError(prior: WorkState | null, next: WorkState): string | null {
  if (prior?.policy.disclosure && !next.policy.disclosure) return 'disclosure_policy_removal_denied';
  if (!next.policy.disclosure) return null;
  if (prior && !prior.disclosureLabels) return 'disclosure_history_unclassified';
  if (!next.disclosureLabels?.length || ![...(prior?.disclosureLabels ?? []), ...next.policy.allowedLabels].every(label => next.disclosureLabels!.includes(label))) return 'disclosure_labels_narrowed';
  const previous = prior?.disclosures ?? []; const records = next.disclosures ?? [];
  if (new Set(records.map(record => record.id)).size !== records.length) return 'disclosure_record_duplicate';
  if (previous.some(record => !records.some(candidate => candidate.id === record.id && JSON.stringify(candidate) === JSON.stringify(record)))) return 'disclosure_history_changed';
  return null;
}

export function releasedBytes(records: readonly DisclosureRecord[]): number {
  const total = records.reduce((sum, record) => sum + record.byteLength, 0);
  if (!Number.isSafeInteger(total)) throw new Error('disclosure_usage_overflow');
  return total;
}
export function disclosureJson(value: unknown): Json { return JSON.parse(JSON.stringify(value)) as Json; }
