import { z } from 'zod';
import type { BudgetGrant } from '../domain/budget-delegation.js';
import type { TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import { effectiveExecutionLimits } from '../domain/execution-policy.js';
import { BudgetSchema, GoalSchema, ObligationSchema } from './contracts.js';
import { BudgetGrantSchema, BudgetSummarySchema, BudgetVectorSchema } from './budget-delegation-contracts.js';

const id = z.string().min(1).max(256), count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const grantCard = z.strictObject({ id, childWorkId: id, status: z.enum(['active', 'draining', 'settled']),
  allocated: BudgetVectorSchema, accounted: BudgetVectorSchema, reserved: BudgetVectorSchema, unmeasuredModelCalls: count });
const request = z.strictObject({ extra: BudgetVectorSchema, reason: z.string().min(1).max(2000) });
const statusPage = z.strictObject({ own: BudgetVectorSchema, limits: BudgetSchema.shape.limits, summary: BudgetSummarySchema.nullable(),
  grants: z.array(grantCard).max(20), nextOffset: count.nullable(), recipients: z.array(z.strictObject({ id, scope: id })).max(64),
  requests: z.array(ObligationSchema).max(20), delegatedRequests: z.array(z.strictObject({ grantId: id, requestId: id,
    extra: BudgetVectorSchema, reason: z.string().min(1).max(2000).optional() })).max(20) });
const allocation = z.strictObject({ workId: id, grantId: id, status: z.string(), sessionLifetimeChanged: z.literal(false) });
const requested = z.strictObject({ requestId: id, status: z.literal('pending'), sponsorWorkId: id.nullable(), allowanceChanged: z.literal(false) });
const vector = (value: z.infer<typeof BudgetVectorSchema>) => ({ toolCalls: value.toolCalls, modelCalls: value.modelCalls, tokens: value.tokens, replans: value.replans });
const owner = (grant: BudgetGrant) => ({ scope: grant.childScope, policyDigest: grant.childPolicyDigest,
  principalId: grant.childAddress?.principalId ?? null, tenantId: grant.childAddress?.tenantId ?? null });
const card = (grant: BudgetGrant) => ({ id: grant.id, childWorkId: grant.childWorkId, status: grant.status,
  allocated: grant.allocated, accounted: grant.accounted, reserved: grant.reserved, unmeasuredModelCalls: grant.unmeasuredModelCalls });

/** Native budget results have already passed ordinary contract, authority and adoption checks. This only classifies preparation. */
export function budgetProgressKeys(state: WorkState, task: TaskSpec, result: ToolResult,
  key: (kind: string, value: unknown) => string): string[] {
  if (result.status !== 'success' || result.coverage !== 'complete' || result.artifacts.length || result.cursor !== null) return [];
  const same = (left: unknown, right: unknown) => key('compare', left) === key('compare', right);
  const currentGrant = (grantId: string) => {
    const found = (state.budgetGrants ?? []).find(value => value.id === grantId);
    return found?.parentGoalRevision === state.goal.revision && BudgetGrantSchema.safeParse(found).success ? found : undefined;
  };
  // A fresh task/command/grant ID, a refreshed revision, or a later clock is not resource progress.
  // Accounted/reserved values here belong to the delegated task, never to the caller's polling costs.
  const grantKey = (grant: BudgetGrant) => key('budget-grant', { owner: owner(grant), status: grant.status,
    allocated: grant.allocated, accounted: grant.accounted, reserved: grant.reserved, unmeasuredModelCalls: grant.unmeasuredModelCalls });
  const requestKey = (extra: z.infer<typeof BudgetVectorSchema>, basis: unknown) =>
    key('budget-request', { basis, extra, status: 'pending' });
  const ownRequest = (obligation: z.infer<typeof ObligationSchema>) => {
    if (!obligation.id.startsWith('budget-request:') || obligation.kind !== 'response' || obligation.status !== 'pending') return [];
    try {
      const parsed = request.parse(JSON.parse(obligation.reason));
      if (!Object.values(parsed.extra).some(value => value > 0)) return [];
      return [requestKey(parsed.extra, { scope: state.goal.scope, parentScope: state.budgetParent?.parentAddress?.scope ?? null })];
    } catch { return []; }
  };
  if (task.toolId === 'core.budget.status') {
    const page = statusPage.safeParse(result.output);
    if (!page.success || !same(page.data.limits, effectiveExecutionLimits(state))) return [];
    const keys = [key('budget-limits', { scope: state.goal.scope, limits: page.data.limits })];
    for (const recipient of page.data.recipients) keys.push(key('budget-recipient', recipient));
    for (const entry of page.data.grants) {
      const grant = currentGrant(entry.id);
      if (!grant || !same(entry, card(grant))) return [];
      keys.push(grantKey(grant));
    }
    for (const entry of page.data.requests) {
      const current = state.obligations.find(value => value.id === entry.id);
      if (!current || !same(current, entry)) return [];
      keys.push(...ownRequest(current));
    }
    for (const entry of page.data.delegatedRequests) {
      const grant = currentGrant(entry.grantId);
      if (!grant || grant.status !== 'active' || !entry.requestId.startsWith('budget-request:')) return [];
      if (Object.values(entry.extra).some(value => value > 0)) keys.push(requestKey(entry.extra, owner(grant)));
    }
    return [...new Set(keys)];
  }
  if (task.toolId === 'core.budget.allocate') {
    const output = allocation.safeParse(result.output), goal = GoalSchema.safeParse(task.input['goal']), limits = BudgetSchema.shape.limits.safeParse(task.input['limits']);
    if (!output.success || !goal.success || !limits.success) return [];
    const grant = currentGrant(output.data.grantId);
    if (!grant || grant.childWorkId !== output.data.workId || !same(grant.allocated, vector(limits.data))) return [];
    const { revision: _revision, criteria, responseRequirement: _response, ...content } = goal.data;
    const semanticGoal = { ...content, scope: grant.childScope, criteria: criteria.map(({ id: _id, ...criterion }) => criterion) };
    return [grantKey(grant), key('budget-allocation', { owner: owner(grant), goal: semanticGoal, allocated: grant.allocated })];
  }
  if (task.toolId === 'core.budget.request') {
    const output = requested.safeParse(result.output), input = request.safeParse(task.input);
    if (!output.success || !input.success || output.data.sponsorWorkId !== (state.budgetParent?.parentWorkId ?? null)) return [];
    const obligation = state.obligations.find(value => value.id === output.data.requestId);
    if (!obligation) return [];
    try { if (!same(request.parse(JSON.parse(obligation.reason)), input.data)) return []; } catch { return []; }
    return ownRequest(obligation);
  }
  if (!['core.budget.run', 'core.budget.increase', 'core.budget.return', 'core.budget.revoke', 'core.budget.reconcile'].includes(task.toolId) ||
    result.output === null || typeof result.output !== 'object' || Array.isArray(result.output)) return [];
  const parsed = BudgetGrantSchema.safeParse(result.output['grant']);
  if (!parsed.success) return [];
  const grant = parsed.data;
  if (task.toolId === 'core.budget.return') {
    if (state.budgetParent?.grantId !== grant.id || grant.childWorkId !== state.id || state.budgetParent.phase !== 'draining' || grant.status === 'active') return [];
  } else {
    const current = currentGrant(grant.id);
    if (!current || task.input['grantId'] !== grant.id || !same(current, grant)) return [];
  }
  return [grantKey(grant)];
}
