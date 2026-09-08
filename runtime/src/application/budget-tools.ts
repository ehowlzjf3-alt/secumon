import { z } from 'zod';
import { GoalSchema, BudgetSchema } from './contracts.js';
import { BudgetVectorSchema } from './budget-delegation-contracts.js';
import { budgetSummary, ownExposure } from '../domain/budget-delegation.js';
import { effectiveExecutionLimits } from '../domain/execution-policy.js';
import type { Tool } from './ports.js';
import type { RuntimeServices } from './services.js';
import type { ExecutionRuntime } from './execution-runtime.js';
import type { WorkflowRuntime } from './workflow-runtime.js';
import { authorizedWork } from './work-resources.js';
import { asJson } from './plan-validator.js';
import { transact } from './work-transactions.js';
import { markCollaborationTool } from './collaboration-tool-identity.js';
import { toolInputSchema } from './tool-input-schema.js';

export const BUDGET_TOOL_IDS = ['core.budget.status', 'core.budget.allocate', 'core.budget.run', 'core.budget.increase',
  'core.budget.request', 'core.budget.return', 'core.budget.revoke', 'core.budget.reconcile'] as const;
const id = z.string().min(1).max(256);
const schemas = {
  status: z.strictObject({ offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(20).default(10) }),
  allocate: z.strictObject({ goal: GoalSchema, limits: BudgetSchema.shape.limits, recipientId: id.optional() }),
  run: z.strictObject({ grantId: id, maxSteps: z.number().int().min(1).max(100) }),
  increase: z.strictObject({ grantId: id, extra: BudgetVectorSchema }),
  request: z.strictObject({ extra: BudgetVectorSchema, reason: z.string().min(1).max(2000) }),
  return: z.strictObject({}),
  revoke: z.strictObject({ grantId: id }),
  reconcile: z.strictObject({ grantId: id }),
};
const descriptions = {
  status: 'Read this work resource ledger and delegated task usage. Resources belong to work, not the lifetime of a resident agent.',
  allocate: 'Reserve part of this work allowance for a temporary task. Without recipientId use this owner and scope; recipientId selects an explicitly registered host recipient and its fixed policy/scope. Host approval is required. Does not run it or create a resident-agent relationship.',
  run: 'Run an explicitly allocated temporary task through the same runtime. Peer consultation uses its own independent allowance instead.',
  increase: 'Add resources to an existing grant within this work original allowance. Does not increase the sponsor hard limit.',
  request: 'Record a request for additional resources for the sponsor or operator to consider. A request is not permission to spend more.',
  return: 'Stop using this task own delegated allowance and request its return. Measured usage and unresolved effects stay accountable; the resident agent session remains open.',
  revoke: 'Stop further use of a grant and start draining running calls. Unused resources return only after measured usage and effects are reconciled.',
  reconcile: 'Refresh actual delegated usage and return unused resources when the task is drained. Unknown usage remains held.',
};

/** Internal scheduling tools reuse the execution ledger; they do not grant access to another agent memory. */
export function createBudgetTools(deps: { services: RuntimeServices; execution: () => ExecutionRuntime; workflow: () => WorkflowRuntime }): Tool[] {
  return Object.entries(schemas).map(([operation, schema]): Tool => markCollaborationTool({
    definition: { provider: 'core', id: `core.budget.${operation}`, version: '1', description: descriptions[operation as keyof typeof descriptions],
      effect: 'read', destination: 'local', labels: [], inputSchema: toolInputSchema(schema), outputSchema: { type: 'object' } },
    async execute(task, context) {
      const base = { resultId: `${context.attemptId}:result`, attemptId: context.attemptId, effectState: 'none' as const,
        evidence: [], artifacts: [], cursor: null };
      try {
        if (context.signal.aborted) throw new Error('cancelled');
        schema.parse(task.input);
        await context.authorize?.();
        const state = await authorizedWork(deps.services.state, context.workId, context.policy);
        if (!state.policy.allowedTools.includes(task.toolId)) throw new Error('budget_tool_denied');
        const execution = deps.execution(), budget = execution.budgets;
        const commandId = deps.services.digester.digest(asJson({ workId: state.id, goalRevision: state.goal.revision, taskId: task.id, operation, input: task.input }));
        let output: unknown;
        if (operation === 'status') {
          const { offset, limit } = schemas.status.parse(task.input);
          const grants = (state.budgetGrants ?? []).slice(offset, offset + limit);
          const delegatedRequests = [];
          for (const grant of grants) {
            if (grant.status !== 'active') continue;
            const child = grant.childAddress ? await budget.child(state, grant) : await deps.services.state.get(grant.childWorkId);
            if (child?.budgetParent?.parentWorkId !== state.id || child.budgetParent.grantId !== grant.id) continue;
            for (const obligation of child.obligations) if (delegatedRequests.length < 20 && obligation.id.startsWith('budget-request:') && obligation.status === 'pending') {
              try {
                const request = schemas.request.parse(JSON.parse(obligation.reason));
                delegatedRequests.push({ grantId: grant.id, requestId: obligation.id, extra: request.extra,
                  ...(grant.childAddress ? {} : { reason: request.reason }) });
              } catch { /* Not a resource request. */ }
            }
          }
          output = { own: ownExposure(state), limits: effectiveExecutionLimits(state), summary: budgetSummary(state) ?? null,
            grants: grants.map(({ id, childWorkId, status, allocated, accounted, reserved, unmeasuredModelCalls }) =>
              ({ id, childWorkId, status, allocated, accounted, reserved, unmeasuredModelCalls })),
            nextOffset: offset + limit < (state.budgetGrants?.length ?? 0) ? offset + limit : null,
            recipients: (deps.services.budgetLedgers?.recipients() ?? []).filter(value => value.owner.tenantId === state.policy.tenantId).map(value => ({ id: value.id, scope: value.owner.scope })),
            requests: state.obligations.filter(value => value.id.startsWith('budget-request:')).slice(offset, offset + limit), delegatedRequests };
        } else if (operation === 'allocate') {
          const input = schemas.allocate.parse(task.input);
          if (!input.recipientId && input.goal.scope !== state.goal.scope) throw new Error('budget_scope_mismatch');
          const child = input.recipientId ? await budget.createRecipient(state.id, commandId, context.policy, state.goal.revision, input.recipientId, input.goal, input.limits) :
            await budget.createChild(state.id, commandId, context.policy, state.goal.revision,
              { id: `delegated:${commandId}`, goal: input.goal, limits: input.limits, policy: structuredClone(state.policy) });
          output = { workId: child.id, grantId: child.budgetParent!.grantId, status: child.status, sessionLifetimeChanged: false };
        } else if (operation === 'run') {
          const input = schemas.run.parse(task.input), grant = state.budgetGrants?.find(value => value.id === input.grantId);
          if (!grant || grant.status !== 'active') throw new Error('budget_grant_inactive');
          if (grant.childAddress) {
            const result = await budget.runRecipient(state.id, grant.id, context.policy, input.maxSteps, context.signal);
            output = { workId: grant.childWorkId, result, grant: await budget.reconcile(state.id, grant.id, context.policy) };
          } else {
            const stop = () => execution.interrupt(grant.childWorkId);
            context.signal.addEventListener('abort', stop, { once: true });
            try {
              const result = await deps.workflow().run(grant.childWorkId, context.policy, { maxSteps: input.maxSteps });
              output = { workId: grant.childWorkId, control: result.control, reason: result.reason,
                grant: await budget.reconcile(state.id, grant.id, context.policy) };
            } finally { context.signal.removeEventListener('abort', stop); }
          }
        } else if (operation === 'increase') {
          const input = schemas.increase.parse(task.input);
          output = { grant: await budget.increase(state.id, input.grantId, commandId, context.policy, state.goal.revision, input.extra) };
        } else if (operation === 'request') {
          const input = schemas.request.parse(task.input), requestId = `budget-request:${commandId}`;
          await transact(deps.services, state.id, requestId, 'budget_additional_requested', asJson(input), next => {
            if (next.goal.revision !== state.goal.revision) throw new Error('stale_user_command');
            next.obligations.push({ id: requestId, kind: 'response', reason: JSON.stringify(input), status: 'pending',
              wakeKey: requestId, dueAt: null, mode: 'waiting' });
          }, context.authorize);
          output = { requestId, status: 'pending', sponsorWorkId: state.budgetParent?.parentWorkId ?? null, allowanceChanged: false };
        } else if (operation === 'return') {
          output = { grant: await budget.returnAllocation(state.id, commandId, context.policy, state.goal.revision) };
        } else if (operation === 'revoke') {
          const input = schemas.revoke.parse(task.input);
          await budget.revoke(state.id, input.grantId, commandId, context.policy, state.goal.revision);
          output = { grant: await budget.reconcile(state.id, input.grantId, context.policy) };
        } else {
          const input = schemas.reconcile.parse(task.input);
          output = { grant: await budget.reconcile(state.id, input.grantId, context.policy) };
        }
        return { ...base, status: 'success', coverage: 'complete', output: asJson(output), error: null };
      } catch (error) {
        const code = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'budget_operation_unavailable';
        return { ...base, status: context.signal.aborted ? 'cancelled' : 'error', coverage: 'unknown', output: null,
          error: { code, retryable: operation === 'run' && code === 'budget_authority_denied' && !context.signal.aborted } };
      }
    },
  }, 'budget'));
}
