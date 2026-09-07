import type { ArtifactRef, Attempt, WorkState } from './model.js';

export interface ComputerResume {
  attemptId: string;
  checkpointId: string;
  reconciliation: { id: string; proofId: string } | null;
}

/** One immutable reservation per source attempt; original operations remain in their original artifacts. */
export interface ComputerContinuationClaim {
  sourceAttemptId: string;
  sourceHead: ArtifactRef;
  sourceResultArtifact: ArtifactRef | null;
  successorAttemptId: string;
  successorTaskDigest: string;
  mode: 'continue' | 'verify';
  reconciliation: { id: string; proofArtifact: ArtifactRef } | null;
  rootAttemptId: string;
  sourceContractDigest: string;
  contractDigest: string;
  goalRevision: number;
  scope: string;
  policyDigest: string;
  generation: number;
  createdAt: number;
  actionDeadlineAt: number;
  maxObservations: number;
  maxInputAttempts: number;
  maxSuccessors: number;
  depth: number;
  observationsUsed: number;
  inputAttemptsUsed: number;
  nextStep: number;
  totalSteps: number;
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

function taskIdentity(attempt: Attempt) {
  const { id, taskId, planRevision, goalRevision, toolId, toolVersion, inputDigest, contractDigest, scope, effect } = attempt;
  return { id, taskId, planRevision, goalRevision, toolId, toolVersion, inputDigest, contractDigest, scope, effect };
}
function sourceIdentity(attempt: Attempt) {
  return { ...taskIdentity(attempt), resultId: attempt.resultId, resultArtifact: attempt.resultArtifact, computerUse: attempt.computerUse };
}

/** Repository CAS validation binds the claim to an attempt; original bytes and current proof authority are validated by the runner. */
export function continuationTransitionError(prior: WorkState | null, next: WorkState): string | null {
  const previous = prior?.computerContinuations ?? []; const claims = next.computerContinuations ?? [];
  const sources = new Map(claims.map(claim => [claim.sourceAttemptId, claim]));
  if (claims.length > 1000 || sources.size !== claims.length || new Set(claims.map(claim => claim.successorAttemptId)).size !== claims.length)
    return 'computer_continuation_duplicate';
  if (previous.some(claim => !sources.has(claim.sourceAttemptId))) return 'computer_continuation_history_removed';
  for (const claim of claims) {
    const source = next.attempts.filter(attempt => attempt.id === claim.sourceAttemptId);
    const successor = next.attempts.filter(attempt => attempt.id === claim.successorAttemptId);
    const beforeSource = prior?.attempts.filter(attempt => attempt.id === claim.sourceAttemptId) ?? [];
    if (source.length !== 1 || beforeSource.length !== 1 || claim.sourceAttemptId === claim.successorAttemptId ||
        !source[0]!.computerUse || !same(source[0]!.computerUse!.head, claim.sourceHead) ||
        !same(source[0]!.resultArtifact, claim.sourceResultArtifact) || !same(sourceIdentity(beforeSource[0]!), sourceIdentity(source[0]!)))
      return 'computer_continuation_source_changed';
    const child = successor[0];
    if (successor.length !== 1 || !child || child.inputDigest !== claim.successorTaskDigest || child.contractDigest !== claim.contractDigest ||
        child.goalRevision !== claim.goalRevision || child.scope !== claim.scope || child.effect !== (claim.mode === 'continue' ? 'write' : 'read'))
      return 'computer_continuation_successor_changed';
    const beforeChild = prior?.attempts.filter(attempt => attempt.id === child.id) ?? [];
    const original = previous.find(value => value.sourceAttemptId === claim.sourceAttemptId);
    if (original) {
      if (!same(original, claim)) return 'computer_continuation_history_changed';
      if (beforeChild.length !== 1 || !same(taskIdentity(beforeChild[0]!), taskIdentity(child))) return 'computer_continuation_successor_changed';
      continue;
    }
    if (beforeChild.length || child.status !== 'reserved' || child.effectState !== 'none' || child.finishedAt !== null || child.resultId !== null ||
        child.resultArtifact !== null || child.computerUse !== undefined || child.readProgress !== undefined || child.reuse !== undefined || child.adopted ||
        child.execution?.mode !== 'not_invoked' || !['succeeded', 'partial', 'failed', 'cancelled', 'unknown'].includes(beforeSource[0]!.status) ||
        !['succeeded', 'partial', 'failed', 'cancelled', 'unknown'].includes(source[0]!.status)) return 'computer_continuation_reservation_invalid';
    if (source[0]!.goalRevision !== claim.goalRevision || source[0]!.scope !== claim.scope || source[0]!.contractDigest !== claim.sourceContractDigest ||
        next.goal.revision !== claim.goalRevision || next.goal.scope !== claim.scope || (next.dataLifecycle?.generation ?? 0) !== claim.generation ||
        !next.attempts.some(attempt => attempt.id === claim.rootAttemptId)) return 'computer_continuation_basis_changed';
    const task = next.plan?.tasks.find(value => value.id === child.taskId);
    const resume: ComputerResume = { attemptId: claim.sourceAttemptId, checkpointId: claim.sourceHead.id,
      reconciliation: claim.reconciliation ? { id: claim.reconciliation.id, proofId: claim.reconciliation.proofArtifact.id } : null };
    if (!task || !same(task.computerResume, resume) || task.readResume || Object.keys(task.input).length || task.toolId !== child.toolId ||
        task.toolVersion !== child.toolVersion || task.effect !== child.effect || next.plan!.revision !== child.planRevision)
      return 'computer_continuation_task_changed';
    if ((source[0]!.computerUse!.pendingOperationId !== null || source[0]!.computerUse!.phase === 'unknown') && !claim.reconciliation)
      return 'computer_continuation_proof_changed';
    if (claim.reconciliation) {
      const record = next.computerReconciliations?.find(value => value.id === claim.reconciliation!.id);
      if (!record || record.status !== 'settled' || record.sourceAttemptId !== claim.sourceAttemptId ||
          !same(record.sourceHead, claim.sourceHead) || !same(record.sourceResultArtifact, claim.sourceResultArtifact) ||
          !same(record.proofArtifact, claim.reconciliation.proofArtifact) || record.contractDigest !== claim.sourceContractDigest ||
          record.policyDigest !== claim.policyDigest || record.goalRevision !== claim.goalRevision || record.generation !== claim.generation)
        return 'computer_continuation_proof_changed';
    }
    const parent = previous.find(value => value.successorAttemptId === claim.sourceAttemptId);
    if (parent ? claim.rootAttemptId !== parent.rootAttemptId || claim.depth !== parent.depth + 1 || claim.actionDeadlineAt !== parent.actionDeadlineAt ||
        claim.maxObservations !== parent.maxObservations || claim.maxInputAttempts !== parent.maxInputAttempts || claim.maxSuccessors !== parent.maxSuccessors ||
        claim.totalSteps !== parent.totalSteps || claim.observationsUsed < parent.observationsUsed || claim.inputAttemptsUsed < parent.inputAttemptsUsed ||
        claim.nextStep < parent.nextStep || claim.policyDigest !== parent.policyDigest || claim.generation !== parent.generation :
      claim.rootAttemptId !== claim.sourceAttemptId || claim.depth !== 1) return 'computer_continuation_lineage_changed';
  }
  const added = claims.filter(claim => !previous.some(value => value.sourceAttemptId === claim.sourceAttemptId)).length;
  if (added && (!prior || next.budget.reservedToolCalls !== prior.budget.reservedToolCalls + added)) return 'computer_continuation_budget_unreserved';
  return null;
}
