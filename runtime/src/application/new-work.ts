import type { Goal, Limits, Policy, WorkState } from '../domain/model.js';
import { WorkStateSchema, parseContract } from './contracts.js';
import { newExecutionControl } from '../domain/execution-policy.js';

export function newWork(input: { id: string; goal: Goal; policy: Policy; limits: Limits; now: number }): WorkState {
  return parseContract(WorkStateSchema, {
    schemaVersion: 1, id: input.id, revision: 1, goal: input.goal, policy: input.policy,
    ...(input.policy.disclosure ? { disclosureLabels: [...new Set(input.policy.allowedLabels)] } : {}),
    executionControl: newExecutionControl(input.goal.mode),
    status: 'ready', statusReason: 'request_accepted',
    budget: { limits: input.limits, used: { toolCalls: 0, modelCalls: 0, tokens: 0, replans: 0, unmeasuredModelCalls: 0 }, reservedToolCalls: 0, reservedModelCalls: 0, reservedTokens: 0 },
    plan: null, attempts: [], evidence: [], hypotheses: [], obligations: [], artifacts: [],
    createdAt: input.now, updatedAt: input.now, deadlineAt: input.now + input.limits.wallTimeMs,
  });
}
