import type { EvaluationSample } from '../domain/execution-evaluation.js';
import type { Json, WorkState } from '../domain/model.js';
import { scoreEvaluation } from './execution-evaluation.js';
import { asJson } from './plan-validator.js';

export interface CollaborationTrial {
  /** Same fixture, mode and oracle in both arms; each runner owns its isolated stores. */
  primary: EvaluationSample;
  /** Final originals of every participating work, including separately funded peers. */
  participants: readonly WorkState[];
  participantInventoryComplete: boolean;
}
const dimensions = ['toolCalls', 'modelCalls', 'tokens', 'replans'] as const;
function identity(state: WorkState) { return JSON.stringify([state.policy.tenantId, state.policy.principalId, state.goal.scope, state.id]); }
function canonicalSnapshot(state: WorkState) {
  // Stored JSON object key order is not evidence; execution history and every snapshot value remain part of the comparison.
  return JSON.stringify(asJson(state), (_key, value: Json) => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
}
function trialMetrics(trial: CollaborationTrial) {
  const score = scoreEvaluation(trial.primary), final = trial.primary.observations.at(-1)?.state;
  if (!final) throw new Error('collaboration_evaluation_missing_observation');
  const works = new Map<string, WorkState>();
  for (const state of [final, ...trial.participants]) {
    const key = identity(state), previous = works.get(key);
    if (previous && (previous.revision !== state.revision || canonicalSnapshot(previous) !== canonicalSnapshot(state)))
      throw new Error('collaboration_evaluation_conflicting_snapshot');
    if (!previous) works.set(key, state);
  }
  const usage = { toolCalls: 0, modelCalls: 0, tokens: 0, replans: 0, unmeasuredModelCalls: 0 };
  let pending = false;
  for (const state of works.values()) {
    // Sum original local usage only. Sponsor grant snapshots would count recipient usage twice.
    for (const dimension of [...dimensions, 'unmeasuredModelCalls'] as const) {
      const amount = state.budget.used[dimension];
      if (!Number.isSafeInteger(amount) || amount < 0 || !Number.isSafeInteger(usage[dimension] + amount))
        throw new Error('collaboration_evaluation_invalid_usage');
      usage[dimension] += amount;
    }
    pending ||= state.budget.reservedToolCalls > 0 || state.budget.reservedModelCalls > 0 || state.budget.reservedTokens > 0 ||
      state.attempts.some(value => ['reserved', 'running', 'received'].includes(value.status)) ||
      state.modelCalls.some(value => ['reserved', 'running', 'received'].includes(value.status));
  }
  return { score, usage, participatingWorks: works.size,
    usageComplete: trial.participantInventoryComplete && !pending && usage.unmeasuredModelCalls === 0 };
}

/** Reuses the existing oracle evaluator; agreement among models never increases the evidence score. */
export function compareCollaboration(single: CollaborationTrial, collaborative: CollaborationTrial) {
  const { id: _singleId, ...leftCase } = single.primary.case;
  const { id: _collaborativeId, ...rightCase } = collaborative.primary.case;
  if (JSON.stringify(leftCase) !== JSON.stringify(rightCase)) throw new Error('collaboration_evaluation_case_mismatch');
  const alone = trialMetrics(single), together = trialMetrics(collaborative);
  return {
    schemaVersion: 1, case: leftCase, single: alone, collaborative: together,
    delta: { toolCalls: together.usage.toolCalls - alone.usage.toolCalls,
      modelCalls: together.usage.modelCalls - alone.usage.modelCalls, tokens: together.usage.tokens - alone.usage.tokens,
      wallElapsedMs: together.score.latency.wallElapsedMs - alone.score.latency.wallElapsedMs },
    interpretation: {
      addedVerifiedCompletion: !alone.score.goalCompleted && together.score.goalCompleted,
      eliminatedContractFailure: !alone.score.contractPassed && together.score.contractPassed,
      comparableCost: alone.usageComplete && together.usageComplete,
      scope: 'recorded_trial_only',
    },
  };
}

/** Optional runner seam. Calling this executes the supplied trials; report construction alone never invokes a model. */
export async function runCollaborationComparison(run: (mode: 'single' | 'collaborative', signal: AbortSignal) => Promise<CollaborationTrial>, signal: AbortSignal) {
  signal.throwIfAborted(); const single = await run('single', signal);
  signal.throwIfAborted(); const collaborative = await run('collaborative', signal);
  signal.throwIfAborted(); return compareCollaboration(single, collaborative);
}
