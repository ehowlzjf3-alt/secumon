import type { ComputerDriverIdentity } from './computer-use.js';
import type { ArtifactRef, Attempt, EffectState, ToolExecution, WorkState } from './model.js';

/** References historical input and separately recorded lookup proof; it does not adopt the original task result. */
export interface ComputerReconciliation {
  id: string;
  sourceAttemptId: string;
  obligationId: string;
  sourceHead: ArtifactRef;
  sourceResultArtifact: ArtifactRef | null;
  requestArtifact: ArtifactRef;
  responseArtifact: ArtifactRef | null;
  proofArtifact: ArtifactRef | null;
  operationId: string;
  stepIndex: number;
  goalRevision: number;
  policyDigest: string;
  generation: number;
  contractDigest: string;
  driver: ComputerDriverIdentity;
  owner: string;
  leaseUntil: number;
  createdAt: number;
  dispatchedAt: number | null;
  finishedAt: number | null;
  status: 'reserved' | 'running' | 'received' | 'settled' | 'failed';
  execution: ToolExecution;
  reason: string | null;
  outcome: 'applied' | 'not_applied' | 'unknown' | null;
  effectState: EffectState;
}

function same(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) &&
    left.length === right.length && left.every((value, index) => same(value, right[index]));
  const a = left as Record<string, unknown>; const b = right as Record<string, unknown>;
  const keys = Object.keys(a).filter(key => a[key] !== undefined);
  return keys.length === Object.keys(b).filter(key => b[key] !== undefined).length && keys.every(key => Object.hasOwn(b, key) && same(a[key], b[key]));
}

function basis(record: ComputerReconciliation) {
  const { id, sourceAttemptId, obligationId, sourceHead, sourceResultArtifact, requestArtifact, operationId, stepIndex,
    goalRevision, policyDigest, generation, contractDigest, driver, owner, leaseUntil, createdAt } = record;
  return { id, sourceAttemptId, obligationId, sourceHead, sourceResultArtifact, requestArtifact, operationId, stepIndex,
    goalRevision, policyDigest, generation, contractDigest, driver, owner, leaseUntil, createdAt };
}

function sourceIdentity(attempt: Attempt) {
  const { id, taskId, planRevision, goalRevision, toolId, toolVersion, inputDigest, contractDigest, scope, effect,
    resultId, resultArtifact, computerUse } = attempt;
  return { id, taskId, planRevision, goalRevision, toolId, toolVersion, inputDigest, contractDigest, scope, effect,
    resultId, resultArtifact, computerUse };
}

const transitions: Record<ComputerReconciliation['status'], readonly ComputerReconciliation['status'][]> = {
  reserved: ['reserved', 'running', 'failed'], running: ['running', 'received', 'failed'],
  received: ['received', 'settled', 'failed'], settled: ['settled', 'failed'], failed: ['failed'],
};

/** Runs inside every repository's CAS boundary; artifact contents and driver authority are checked by the service. */
export function reconciliationTransitionError(prior: WorkState | null, next: WorkState): string | null {
  const previous = prior?.computerReconciliations ?? []; const records = next.computerReconciliations ?? [];
  const current = new Map(records.map(record => [record.id, record]));
  if (records.length > 1000 || current.size !== records.length) return 'computer_reconciliation_duplicate';
  if (previous.some(record => !current.has(record.id))) return 'computer_reconciliation_history_removed';
  const originals = new Map(previous.map(record => [record.id, record]));
  for (const record of records) {
    const source = next.attempts.filter(attempt => attempt.id === record.sourceAttemptId);
    if (source.length !== 1 || source[0]!.effect !== 'write' || !source[0]!.computerUse ||
        !same(source[0]!.computerUse!.head, record.sourceHead) || !same(source[0]!.resultArtifact, record.sourceResultArtifact)) return 'computer_reconciliation_source_changed';
    const before = prior?.attempts.filter(attempt => attempt.id === record.sourceAttemptId) ?? [];
    if (prior && (before.length !== 1 || !same(sourceIdentity(before[0]!), sourceIdentity(source[0]!)))) return 'computer_reconciliation_source_changed';
    const original = originals.get(record.id);
    if (!original) {
      if (record.status !== 'reserved') return 'computer_reconciliation_initial_status';
      continue;
    }
    if (!same(basis(original), basis(record))) return 'computer_reconciliation_identity_changed';
    if (!transitions[original.status].includes(record.status)) return 'computer_reconciliation_status_invalid';
    if ((original.responseArtifact !== null && !same(original.responseArtifact, record.responseArtifact)) ||
        (original.proofArtifact !== null && !same(original.proofArtifact, record.proofArtifact)) ||
        (original.dispatchedAt !== null && original.dispatchedAt !== record.dispatchedAt) ||
        (original.finishedAt !== null && original.finishedAt !== record.finishedAt)) return 'computer_reconciliation_history_changed';
    if (original.status === 'failed' && !same(original, record)) return 'computer_reconciliation_terminal_changed';
    const knownOutcome = original.outcome === 'applied' || original.outcome === 'not_applied';
    if ((knownOutcome && record.outcome !== original.outcome) ||
        (original.outcome === 'unknown' && record.outcome === null) ||
        (original.effectState !== 'unknown' && record.effectState !== original.effectState) ||
        ((!knownOutcome && (record.outcome === 'applied' || record.outcome === 'not_applied') ||
          original.effectState === 'unknown' && record.effectState !== 'unknown') && !['received', 'settled'].includes(record.status))) return 'computer_reconciliation_claim_changed';
  }
  return null;
}
