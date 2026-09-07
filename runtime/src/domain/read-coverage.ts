import type { Attempt, Goal, Policy } from './model.js';
import type { ReadCheckpoint } from './read-checkpoint.js';
import type { ReadCollectionState, ReadKey } from './read-collection.js';

/** A checkpoint projection. It adds no evidence and is not itself an authenticated source. */
export interface ReadCoverage {
  queryDigest: string;
  snapshot: string | null;
  expectedItems: number;
  completedItems: number;
  complete: boolean;
}
export interface CollectionRequirement { queryDigest: string; snapshot?: string | undefined }

export function validateReadCoverageManifest(manifest: ReadKey[]): void {
  if (!Array.isArray(manifest) || manifest.length > 10000) throw new Error('read_coverage_manifest_invalid');
  const seen = new Set<string>();
  for (const key of manifest) {
    if (!key || typeof key.id !== 'string' || key.id.length < 1 || key.id.length > 256 ||
      typeof key.inputDigest !== 'string' || !/^[a-f0-9]{64}$/.test(key.inputDigest) || seen.has(key.id))
      throw new Error('read_coverage_manifest_invalid');
    seen.add(key.id);
  }
}

/** Call on the merged collection after ordinary page validation; remote totals are not the denominator. */
export function validateReadCoverage(manifest: ReadKey[], collection: ReadCollectionState): void {
  validateReadCoverageManifest(manifest);
  const expected = new Map(manifest.map(key => [key.id, key.inputDigest])); const seen = new Set<string>();
  const pages = [...collection.pages, ...(collection.pending ? [collection.pending] : [])];
  for (const page of pages) {
    const pageIds = new Set<string>();
    for (const key of page.expected) {
      if (expected.get(key.id) !== key.inputDigest || seen.has(key.id)) throw new Error('read_coverage_item_mismatch');
      seen.add(key.id); pageIds.add(key.id);
    }
    const itemIds = new Set<string>();
    for (const item of page.items) {
      if (!pageIds.has(item.id) || expected.get(item.id) !== item.inputDigest || itemIds.has(item.id))
        throw new Error('read_coverage_item_mismatch');
      itemIds.add(item.id);
    }
    if (itemIds.size !== pageIds.size) throw new Error('read_coverage_item_mismatch');
  }
  if ((collection.exhausted || pages.some(page => page.exhausted)) && seen.size !== expected.size)
    throw new Error('read_coverage_incomplete');
}

export function projectReadCoverage(checkpoint: ReadCheckpoint): ReadCoverage | undefined {
  const manifest = checkpoint.coverageManifest;
  if (manifest === undefined) return undefined;
  validateReadCoverage(manifest, checkpoint.collection);
  const items = [...checkpoint.collection.pages, ...(checkpoint.collection.pending ? [checkpoint.collection.pending] : [])].flatMap(page => page.items);
  const completedItems = items.filter(item => item.status === 'success').length;
  return { queryDigest: checkpoint.queryDigest, snapshot: checkpoint.collection.snapshot, expectedItems: manifest.length, completedItems,
    complete: checkpoint.phase === 'complete' && checkpoint.collection.exhausted && checkpoint.collection.pending === null &&
      checkpoint.collection.snapshot !== null && completedItems === manifest.length };
}

/** Application boundaries must authenticate each candidate's exact checkpoint before consuming this projection. */
export function collectionCoverageCandidates(goal: Pick<Goal, 'revision' | 'scope'>, policy: Policy, attempts: readonly Attempt[],
  requirement: CollectionRequirement): Attempt[] {
  const counts = new Map<string, number>(); for (const attempt of attempts) counts.set(attempt.id, (counts.get(attempt.id) ?? 0) + 1);
  return attempts.filter(attempt => {
    const progress = attempt.readProgress; const coverage = progress?.coverage; const head = progress?.head;
    return counts.get(attempt.id) === 1 && attempt.adopted && attempt.status === 'succeeded' && attempt.effect === 'read' && attempt.effectState === 'none' &&
      attempt.goalRevision === goal.revision && attempt.scope === goal.scope && policy.allowedTools.includes(attempt.toolId) &&
      progress?.phase === 'complete' && progress.pendingItems === 0 &&
      coverage?.complete === true && coverage.queryDigest === requirement.queryDigest && coverage.snapshot !== null &&
      (requirement.snapshot === undefined || coverage.snapshot === requirement.snapshot) &&
      Number.isSafeInteger(coverage.expectedItems) && coverage.expectedItems >= 0 && coverage.expectedItems <= 10000 &&
      coverage.completedItems === coverage.expectedItems && progress.completedItems === coverage.completedItems &&
      head?.tenantId === policy.tenantId && head.labels.every(label => policy.allowedLabels.includes(label));
  });
}
