export interface ProgressPolicy {
  maxUnproductiveSteps: number;
  maxRepeatedFailures: number;
  retryWindowMs: number;
  backoffMs: number;
  maxTrackedEntries: number;
}
export interface ProgressFailure {
  key: string;
  count: number;
  firstAt: number;
  lastAt: number;
  nextEligibleAt: number;
  deadlineAt: number;
}
export interface WorkProgress {
  schemaVersion: 1;
  goalRevision: number;
  policy: ProgressPolicy;
  processed: string[];
  knownKeys: string[];
  consecutiveUnproductive: number;
  productiveSteps: number;
  unproductiveSteps: number;
  failures: ProgressFailure[];
  saturated: boolean;
}
export interface ProgressObservation { goalRevision: number; operationId: string; keys: string[]; failureKey: string | null; at: number }
export type ProgressGate = { kind: 'blocked'; reason: string } | { kind: 'wait'; reason: string; wakeAt: number };

/** Persisted local evaluation policy; these values do not claim calibrated model performance. */
export const DEFAULT_PROGRESS_POLICY: Readonly<ProgressPolicy> = Object.freeze({ maxUnproductiveSteps: 3, maxRepeatedFailures: 3,
  retryWindowMs: 30000, backoffMs: 100, maxTrackedEntries: 10000 });

function invalid(): never { throw new Error('progress_invalid'); }
const count = (value: number) => Number.isSafeInteger(value) && value >= 0;
const key = (value: string) => typeof value === 'string' && value.length > 0 && value.length <= 512;
const unique = (values: string[]) => Array.isArray(values) && values.every(key) && new Set(values).size === values.length;
export function validProgressPolicy(policy: ProgressPolicy): boolean {
  return typeof policy === 'object' && policy !== null && Object.keys(policy).length === 5 && Object.keys(policy).every(field => Object.hasOwn(DEFAULT_PROGRESS_POLICY, field)) &&
    [policy.maxUnproductiveSteps, policy.maxRepeatedFailures, policy.maxTrackedEntries].every(value => count(value) && value >= 1 && value <= 10000) &&
    count(policy.retryWindowMs) && policy.retryWindowMs >= 1 && count(policy.backoffMs) && policy.backoffMs <= policy.retryWindowMs;
}
export function validWorkProgress(progress: WorkProgress): boolean {
  if (progress.schemaVersion !== 1 || !count(progress.goalRevision) || progress.goalRevision < 1 || !validProgressPolicy(progress.policy) ||
    !unique(progress.processed) || !unique(progress.knownKeys) || !Array.isArray(progress.failures) || typeof progress.saturated !== 'boolean') return false;
  if ([progress.processed.length, progress.knownKeys.length, progress.failures.length].some(size => size > progress.policy.maxTrackedEntries) ||
    ![progress.consecutiveUnproductive, progress.productiveSteps, progress.unproductiveSteps].every(count) ||
    progress.productiveSteps + progress.unproductiveSteps !== progress.processed.length || progress.consecutiveUnproductive > progress.unproductiveSteps ||
    progress.productiveSteps > progress.knownKeys.length || progress.failures.reduce((sum, failure) => sum + failure.count, 0) > progress.processed.length ||
    new Set(progress.failures.map(failure => failure.key)).size !== progress.failures.length) return false;
  return progress.failures.every(failure => key(failure.key) && [failure.count, failure.firstAt, failure.lastAt, failure.nextEligibleAt, failure.deadlineAt].every(count) &&
    failure.count >= 1 && failure.count <= progress.processed.length && failure.firstAt <= failure.lastAt &&
    failure.deadlineAt - failure.firstAt === progress.policy.retryWindowMs &&
    failure.nextEligibleAt === Math.min(failure.deadlineAt, failure.lastAt + Math.min(progress.policy.backoffMs, Number.MAX_SAFE_INTEGER - failure.lastAt)));
}

/** Each committed operation contributes once. Saturation retains prior custody instead of evicting deduplication records. */
export function observeProgress(prior: WorkProgress | null | undefined, input: ProgressObservation, policy?: ProgressPolicy): WorkProgress {
  if (!count(input.goalRevision) || input.goalRevision < 1 || !key(input.operationId) || !Array.isArray(input.keys) || !input.keys.every(key) ||
    (input.failureKey !== null && !key(input.failureKey)) || !count(input.at)) invalid();
  if (prior && !validWorkProgress(prior)) invalid();
  const selected = policy ?? prior?.policy ?? DEFAULT_PROGRESS_POLICY;
  if (!validProgressPolicy(selected)) invalid();
  if (prior && Object.keys(DEFAULT_PROGRESS_POLICY).some(field => prior.policy[field as keyof ProgressPolicy] !== selected[field as keyof ProgressPolicy]))
    throw new Error('progress_policy_changed');
  const next: WorkProgress = prior ? structuredClone(prior) : { schemaVersion: 1, goalRevision: input.goalRevision, policy: { ...selected }, processed: [], knownKeys: [],
    consecutiveUnproductive: 0, productiveSteps: 0, unproductiveSteps: 0, failures: [], saturated: false };
  if (next.processed.includes(input.operationId)) return next;
  if (input.goalRevision < next.goalRevision) throw new Error('progress_goal_stale');
  if (input.goalRevision > next.goalRevision) { next.goalRevision = input.goalRevision; next.consecutiveUnproductive = 0; }
  if (next.saturated) return next;
  const known = new Set(next.knownKeys); const novel = [...new Set(input.keys)].filter(value => !known.has(value));
  const failure = input.failureKey === null ? undefined : next.failures.find(value => value.key === input.failureKey);
  if (next.processed.length === selected.maxTrackedEntries || next.knownKeys.length + novel.length > selected.maxTrackedEntries ||
    (input.failureKey !== null && !failure && next.failures.length === selected.maxTrackedEntries)) { next.saturated = true; return next; }
  if (failure && input.at < failure.lastAt) throw new Error('progress_time_reversed');
  if (input.failureKey !== null && !failure && !Number.isSafeInteger(input.at + selected.retryWindowMs)) invalid();
  next.processed.push(input.operationId); next.knownKeys.push(...novel);
  if (novel.length) { next.productiveSteps++; next.consecutiveUnproductive = 0; }
  else { next.unproductiveSteps++; next.consecutiveUnproductive++; }
  if (input.failureKey !== null) {
    const deadline = failure?.deadlineAt ?? input.at + selected.retryWindowMs;
    const eligible = Math.min(deadline, input.at + Math.min(selected.backoffMs, Number.MAX_SAFE_INTEGER - input.at));
    if (failure) { failure.count++; failure.lastAt = input.at; failure.nextEligibleAt = eligible; }
    else next.failures.push({ key: input.failureKey, count: 1, firstAt: input.at, lastAt: input.at, nextEligibleAt: eligible, deadlineAt: deadline });
  }
  return next;
}
