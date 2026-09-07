import { z } from 'zod';
import type { BudgetGrant, BudgetMandate, BudgetParent, BudgetSummary, BudgetVector, BudgetWorkAddress } from '../domain/budget-delegation.js';
import { delegatedExposure, grantExposure, MAX_BUDGET_GRANTS, validBudgetMandate, validBudgetParent } from '../domain/budget-delegation.js';

const id = z.string().min(1).max(256);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const BudgetWorkAddressSchema: z.ZodType<BudgetWorkAddress> = z.strictObject({ tenantId: id, principalId: id, scope: id, workId: id });
export const BudgetVectorSchema: z.ZodType<BudgetVector> = z.strictObject({ toolCalls: count, modelCalls: count, tokens: count, replans: count });
export const BudgetMandateSchema: z.ZodType<BudgetMandate> = z.strictObject({ provider: id, referenceId: id, revision: count.min(1), childGoalRevision: count.min(1),
  attributes: z.record(z.string().min(1).max(64), id).optional() })
  .refine(validBudgetMandate, 'budget_mandate_invalid');
export const BudgetSummarySchema: z.ZodType<BudgetSummary> = z.strictObject({ accounting: z.literal('stored_snapshot'), parentPhase: z.enum(['pending', 'active', 'draining']).nullable(),
  grants: z.strictObject({ active: count, draining: count, settled: count }), delegated: BudgetVectorSchema, total: BudgetVectorSchema, unmeasuredChildModelCalls: count });
export const BudgetParentSchema: z.ZodType<BudgetParent> = z.strictObject({ parentWorkId: id, grantId: id, phase: z.enum(['pending', 'active', 'draining']), parentAddress: BudgetWorkAddressSchema.optional() })
  .refine(validBudgetParent, 'budget_delegation_invalid');
export const BudgetGrantSchema: z.ZodType<BudgetGrant> = z.strictObject({ id, childWorkId: id, parentGoalRevision: count.min(1), childScope: id,
  childAddress: BudgetWorkAddressSchema.optional(),
  childPolicyDigest: z.string().regex(/^[0-9a-f]{64}$/), allocated: BudgetVectorSchema, deadlineAt: count, status: z.enum(['active', 'draining', 'settled']),
  accounted: BudgetVectorSchema, reserved: BudgetVectorSchema, unmeasuredModelCalls: count, childStateRevision: count.min(1).nullable(), mandate: BudgetMandateSchema.optional() })
  .superRefine((grant, context) => {
    try { grantExposure(grant); }
    catch (error) { context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'budget_delegation_invalid' }); }
  });
export const BudgetGrantsSchema: z.ZodType<BudgetGrant[]> = z.array(BudgetGrantSchema).max(MAX_BUDGET_GRANTS)
  .superRefine((grants, context) => {
    try { delegatedExposure(grants); }
    catch (error) { context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'budget_delegation_invalid' }); }
  });
