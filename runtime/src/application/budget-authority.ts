import type { BudgetMandate, BudgetVector } from '../domain/budget-delegation.js';
import type { Policy, TaskSpec } from '../domain/model.js';

export type BudgetOperation = { kind: 'general' | 'control' | 'model' } | { kind: 'plan'; tasks: TaskSpec[] } |
  { kind: 'tool'; task: TaskSpec; attemptId?: string };
export interface BudgetInvocation { workId: string; operation: BudgetOperation }

/** A host-owned authority reference grants resources independently of access to task content. */
export interface BudgetAuthorityBinding {
  mandate: BudgetMandate;
  grantId: string;
  parent: { workId: string; tenantId: string; principalId: string; goalRevision: number; scope?: string | undefined };
  child: { workId: string; goalRevision: number; goalDigest: string; scope: string; policy: Policy; allocated: BudgetVector; deadlineAt: number };
}
export interface BudgetAuthority {
  current(binding: BudgetAuthorityBinding, purpose: 'allocation' | 'execution', signal?: AbortSignal, invocation?: BudgetInvocation): Promise<boolean>;
}

/** The host routes these operations using the child's identity, never the sponsor's data session. */
export interface BudgetChildRuntime {
  available(actor: Pick<Policy, 'tenantId' | 'principalId'>): boolean;
  refreshEffects(workId: string): Promise<void>;
  effectsCurrent(workId: string, stateRevision: number): Promise<boolean>;
  interrupt(workId: string): Promise<void>;
}
