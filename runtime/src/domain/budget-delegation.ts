import type { Budget, WorkState } from './model.js';
import { effectiveExecutionLimits } from './execution-policy.js';

export interface BudgetVector { toolCalls: number; modelCalls: number; tokens: number; replans: number }
export interface BudgetOwner { tenantId: string; principalId: string; scope: string }
export interface BudgetWorkAddress extends BudgetOwner { workId: string }
export interface BudgetParent { parentWorkId: string; grantId: string; phase: 'pending' | 'active' | 'draining'; parentAddress?: BudgetWorkAddress | undefined }
export interface BudgetMandate { provider: string; referenceId: string; revision: number; childGoalRevision: number; attributes?: Record<string, string> | undefined }
export interface BudgetGrant {
  id: string;
  childWorkId: string;
  childAddress?: BudgetWorkAddress | undefined;
  parentGoalRevision: number;
  childScope: string;
  childPolicyDigest: string;
  allocated: BudgetVector;
  deadlineAt: number;
  status: 'active' | 'draining' | 'settled';
  accounted: BudgetVector;
  reserved: BudgetVector;
  unmeasuredModelCalls: number;
  childStateRevision: number | null;
  mandate?: BudgetMandate | undefined;
}
export interface BudgetExposureWork { budget: Budget; budgetGrants?: readonly BudgetGrant[] | undefined }
export interface BudgetSummary {
  accounting: 'stored_snapshot'; parentPhase: BudgetParent['phase'] | null;
  grants: { active: number; draining: number; settled: number };
  delegated: BudgetVector; total: BudgetVector; unmeasuredChildModelCalls: number;
}

export const BUDGET_DIMENSIONS = Object.freeze(['toolCalls', 'modelCalls', 'tokens', 'replans'] as const);
export const MAX_BUDGET_GRANTS = 10000;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const id = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const zero = (): BudgetVector => ({ toolCalls: 0, modelCalls: 0, tokens: 0, replans: 0 });
function invalid(): never { throw new Error('budget_delegation_invalid'); }
function add(left: number, right: number): number {
  if (left > Number.MAX_SAFE_INTEGER - right) throw new Error('budget_exposure_overflow');
  return left + right;
}
function plus(left: BudgetVector, right: BudgetVector): BudgetVector {
  const result = zero();
  for (const dimension of BUDGET_DIMENSIONS) result[dimension] = add(left[dimension], right[dimension]);
  return result;
}

/** Only additive dimensions are projected; a work Limits object may also carry wallTimeMs. */
export function validBudgetVector(value: unknown): value is BudgetVector {
  return object(value) && BUDGET_DIMENSIONS.every(dimension => count(value[dimension]));
}
export function validBudgetParent(value: unknown): value is BudgetParent {
  return object(value) && id(value['parentWorkId']) && id(value['grantId']) && ['pending', 'active', 'draining'].includes(value['phase'] as string) &&
    (value['parentAddress'] === undefined || validBudgetWorkAddress(value['parentAddress']) && value['parentAddress'].workId === value['parentWorkId']);
}
export function validBudgetWorkAddress(value: unknown): value is BudgetWorkAddress {
  return object(value) && ['tenantId', 'principalId', 'scope', 'workId'].every(key => id(value[key]));
}
export function validBudgetMandate(value: unknown): value is BudgetMandate {
  return object(value) && id(value['provider']) && id(value['referenceId']) && count(value['revision']) && value['revision'] >= 1 &&
    count(value['childGoalRevision']) && value['childGoalRevision'] >= 1 && (value['attributes'] === undefined ||
      object(value['attributes']) && Object.keys(value['attributes']).length <= 16 && Object.entries(value['attributes']).every(([key, item]) => id(key) && key.length <= 64 && id(item)));
}
export function validBudgetGrant(value: unknown): value is BudgetGrant {
  if (!object(value) || !id(value['id']) || !id(value['childWorkId']) || !id(value['childScope']) ||
    !count(value['parentGoalRevision']) || value['parentGoalRevision'] < 1 || !count(value['deadlineAt']) ||
    typeof value['childPolicyDigest'] !== 'string' || !/^[0-9a-f]{64}$/.test(value['childPolicyDigest']) ||
    !['active', 'draining', 'settled'].includes(value['status'] as string) || !validBudgetVector(value['allocated']) ||
    !validBudgetVector(value['accounted']) || !validBudgetVector(value['reserved']) || !count(value['unmeasuredModelCalls'])) return false;
  if (value['mandate'] !== undefined && !validBudgetMandate(value['mandate'])) return false;
  if (value['childAddress'] !== undefined && (!validBudgetWorkAddress(value['childAddress']) || value['childAddress'].workId !== value['childWorkId'])) return false;
  const revision = value['childStateRevision']; const accounted = value['accounted']; const reserved = value['reserved'];
  if (revision !== null && (!count(revision) || revision < 1)) return false;
  if (revision === null && (value['status'] === 'settled' || value['unmeasuredModelCalls'] !== 0 ||
    BUDGET_DIMENSIONS.some(dimension => accounted[dimension] !== 0 || reserved[dimension] !== 0))) return false;
  return true;
}

/** Existing logical usage plus local reservations, without elapsed-time or unknown-count conversion. */
export function ownExposure(work: Pick<BudgetExposureWork, 'budget'>): BudgetVector {
  if (!object(work) || !object(work.budget) || !validBudgetVector(work.budget.used) || !count(work.budget.used.unmeasuredModelCalls) ||
    !count(work.budget.reservedToolCalls) || !count(work.budget.reservedModelCalls) || !count(work.budget.reservedTokens)) invalid();
  return plus(work.budget.used, { toolCalls: work.budget.reservedToolCalls, modelCalls: work.budget.reservedModelCalls, tokens: work.budget.reservedTokens, replans: 0 });
}

/** An open grant retains its full escrow, including when observed child usage is smaller or unknown. */
export function grantExposure(grant: BudgetGrant): BudgetVector {
  if (!validBudgetGrant(grant)) invalid();
  const observed = plus(grant.accounted, grant.reserved);
  if (grant.status === 'settled') return observed;
  const result = zero();
  for (const dimension of BUDGET_DIMENSIONS) result[dimension] = Math.max(grant.allocated[dimension], observed[dimension]);
  return result;
}

/** Grant identity is unique; repeated records are invalid rather than an extra charge or a refund. */
export function delegatedExposure(grants: readonly BudgetGrant[]): BudgetVector {
  if (!Array.isArray(grants) || grants.length > MAX_BUDGET_GRANTS) invalid();
  const ids = new Set<string>(); const children = new Set<string>(); const mandates = new Set<string>(); let result = zero();
  for (const grant of grants) {
    const exposure = grantExposure(grant);
    if (ids.has(grant.id) || children.has(grant.childWorkId)) invalid();
    if (grant.mandate) {
      const key = JSON.stringify([grant.mandate.provider, grant.mandate.referenceId]);
      if (mandates.has(key)) invalid();
      mandates.add(key);
    }
    ids.add(grant.id); children.add(grant.childWorkId); result = plus(result, exposure);
  }
  return result;
}

export function totalExposure(work: BudgetExposureWork): BudgetVector {
  const own = ownExposure(work);
  return plus(own, delegatedExposure(work.budgetGrants === undefined ? [] : work.budgetGrants));
}

export function budgetSummary(work: WorkState): BudgetSummary | undefined {
  if (!work.budgetParent && !work.budgetGrants?.length) return undefined;
  const grants = work.budgetGrants ?? [];
  return { accounting: 'stored_snapshot', parentPhase: work.budgetParent?.phase ?? null,
    grants: { active: grants.filter(g => g.status === 'active').length, draining: grants.filter(g => g.status === 'draining').length, settled: grants.filter(g => g.status === 'settled').length },
    delegated: delegatedExposure(grants), total: totalExposure(work), unmeasuredChildModelCalls: grants.reduce((sum, g) => add(sum, g.unmeasuredModelCalls), 0) };
}

/** Positive excess remains visible after a lower limit or a provider's over-reservation usage report. */
export function budgetExcess(work: BudgetExposureWork, limits: BudgetVector): BudgetVector {
  if (!validBudgetVector(limits)) invalid();
  const exposure = totalExposure(work); const result = zero();
  for (const dimension of BUDGET_DIMENSIONS) result[dimension] = Math.max(0, exposure[dimension] - limits[dimension]);
  return result;
}

/** Reservations and replans share the same escrow-aware admission rule. Existing receipts may still settle. */
export function budgetAllocationError(work: WorkState, additional: Partial<BudgetVector> = {}): string | null {
  if (work.budgetParent && work.budgetParent.phase !== 'active') return `budget_child_${work.budgetParent.phase}`;
  try {
    const exposure = totalExposure(work); const limits = effectiveExecutionLimits(work);
    for (const dimension of BUDGET_DIMENSIONS) {
      const delta = additional[dimension] ?? 0;
      if (!count(delta)) return 'budget_delegation_invalid';
      // Preserve the existing mode-specific diagnostics for work without delegated exposure.
      if (!(work.budgetGrants?.length) && !work.budgetParent) continue;
      if (add(exposure[dimension], delta) > limits[dimension]) return `budget_${dimension === 'toolCalls' ? 'tool' : dimension === 'modelCalls' ? 'model' : dimension}_exhausted`;
    }
    return null;
  } catch (error) { return error instanceof Error ? error.message : 'budget_delegation_invalid'; }
}
