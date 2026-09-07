import type { Goal, Json, Limits, Policy, WorkState } from '../domain/model.js';
import { BUDGET_DIMENSIONS, MAX_BUDGET_GRANTS, budgetAllocationError, grantExposure, ownExposure, totalExposure, validBudgetVector, type BudgetGrant, type BudgetMandate, type BudgetVector, type BudgetWorkAddress } from '../domain/budget-delegation.js';
import { effectiveExecutionLimits } from '../domain/execution-policy.js';
import type { RuntimeServices } from './services.js';
import { newWork } from './new-work.js';
import { transact } from './work-transactions.js';
import { BudgetSchema, parseContract } from './contracts.js';
import type { Clock, Digester, StateRepository } from './ports.js';
import { allowsDisclosure, disclosureLabels, disclosurePolicyNarrows } from '../domain/disclosure.js';
import { effectProofsCurrent, refreshEffectProofs } from './effect-proofs.js';
import { BudgetMandateSchema } from './budget-delegation-contracts.js';
import { budgetAddressMatches, budgetWorkAddress, type BudgetWorkLedger, type BudgetWorkLedgers } from './budget-work-ledgers.js';
import type { BudgetAuthority, BudgetAuthorityBinding, BudgetChildRuntime, BudgetInvocation, BudgetOperation } from './budget-authority.js';

type Actor = Pick<Policy, 'tenantId' | 'principalId'>;
type ChildInput = { id: string; goal: Goal; policy: Policy; limits: Limits; mandate?: BudgetMandate; deadlineAt?: number; address?: BudgetWorkAddress };
type ReadServices = { state: StateRepository; clock: Clock; digester: Digester; budgetAuthority?: BudgetAuthority | undefined; budgetChildren?: BudgetChildRuntime | undefined; budgetLedgers?: BudgetWorkLedgers | undefined; budgetLedger?: BudgetWorkLedger | undefined };
const MAX_DEPTH = 8;
const MAX_ACTIVE_NODES = 1024;
const zero = (): BudgetVector => ({ toolCalls: 0, modelCalls: 0, tokens: 0, replans: 0 });
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
const terminal = (work: WorkState) => ['cancelled', 'failed', 'completed'].includes(work.status);
const owner = (state: WorkState, actor: Actor) => {
  if (state.policy.tenantId !== actor.tenantId || state.policy.principalId !== actor.principalId) throw new Error('actor_not_authorized');
};
function narrowed(child: Policy, parent: Policy) {
  return child.tenantId === parent.tenantId && child.principalId === parent.principalId && (!child.allowWrites || parent.allowWrites) &&
    child.allowedTools.every(x => parent.allowedTools.includes(x)) && child.allowedLabels.every(x => parent.allowedLabels.includes(x)) &&
    child.allowedDestinations.every(x => parent.allowedDestinations.includes(x)) && disclosurePolicyNarrows(parent, child);
}
function inheritedDisclosure(parent: WorkState, child: WorkState) {
  if (!parent.policy.disclosure) return !child.policy.disclosure;
  return Boolean(child.policy.disclosure && child.disclosureLabels && disclosureLabels(parent).every(label => child.disclosureLabels!.includes(label)));
}
const vector = (limits: BudgetVector): BudgetVector => ({ toolCalls: limits.toolCalls, modelCalls: limits.modelCalls, tokens: limits.tokens, replans: limits.replans });
function plus(left: number, right: number): number {
  const value = left + right; if (!Number.isSafeInteger(value) || value < 0) throw new Error('budget_exposure_overflow'); return value;
}
function at<T extends ReadServices>(services: T, address?: BudgetWorkAddress): T & { budgetLedger?: BudgetWorkLedger | undefined } {
  if (!address) return services;
  const ledger = services.budgetLedgers?.resolve(address); if (!ledger?.current()) throw new Error('budget_owner_ledger_unavailable');
  return { ...services, state: ledger.state, ...('artifacts' in services ? { artifacts: ledger.artifacts } : {}), budgetLedger: ledger };
}
const workKey = (state: WorkState) => JSON.stringify(budgetWorkAddress(state));
function linked(parent: WorkState, grant: BudgetGrant, child: WorkState) {
  if (child.budgetParent?.parentWorkId !== parent.id || child.budgetParent.grantId !== grant.id || grant.childWorkId !== child.id ||
    !!grant.childAddress !== !!child.budgetParent.parentAddress ||
    grant.childAddress && (!budgetAddressMatches(grant.childAddress, child) || !budgetAddressMatches(child.budgetParent.parentAddress!, parent)))
    throw new Error('budget_child_binding_changed');
}
function ownLedger(services: ReadServices, state: WorkState) {
  if (!state.budgetParent?.parentAddress && !state.budgetGrants?.some(grant => grant.childAddress)) return undefined;
  const ledger = services.budgetLedgers?.resolve(budgetWorkAddress(state));
  if (!ledger?.owns(services.state)) throw new Error('budget_owner_ledger_changed');
  return ledger;
}
async function load(services: ReadServices, id: string) {
  const work = await services.state.get(id); if (!work) throw new Error('work_not_found'); ownLedger(services, work); return work;
}
function grantFor(parent: WorkState, id: string) {
  const grant = parent.budgetGrants?.find(g => g.id === id); if (!grant) throw new Error('budget_grant_missing'); return grant;
}
function binding(services: Pick<ReadServices, 'digester'>, parent: WorkState, grant: BudgetGrant, child: WorkState) {
  linked(parent, grant, child);
  if (child.goal.scope !== grant.childScope || services.digester.digest(json(child.policy)) !== grant.childPolicyDigest ||
    (grant.mandate ? child.policy.tenantId !== parent.policy.tenantId || child.goal.revision !== grant.mandate.childGoalRevision :
      !narrowed(child.policy, parent.policy) || !inheritedDisclosure(parent, child)))
    throw new Error('budget_child_binding_changed');
}
function authorityBinding(digester: Digester, parent: WorkState, child: WorkState, grantId: string, mandate: BudgetMandate, allocated: BudgetVector, deadlineAt: number): BudgetAuthorityBinding {
  return { mandate: structuredClone(mandate), grantId,
    parent: { workId: parent.id, tenantId: parent.policy.tenantId, principalId: parent.policy.principalId, goalRevision: parent.goal.revision,
      ...(child.budgetParent?.parentAddress ? { scope: parent.goal.scope } : {}) },
    child: { workId: child.id, goalRevision: child.goal.revision, goalDigest: digester.digest(json(child.goal)), scope: child.goal.scope,
      policy: structuredClone(child.policy), allocated: vector(allocated), deadlineAt } };
}
async function authorized(services: ReadServices, parent: WorkState, child: WorkState, grantId: string, mandate: BudgetMandate,
  allocated: BudgetVector, deadlineAt: number, purpose: 'allocation' | 'execution', invocation?: BudgetInvocation) {
  if (child.policy.tenantId !== parent.policy.tenantId || child.goal.revision !== mandate.childGoalRevision) throw new Error('budget_mandate_binding_changed');
  const routed = !!child.budgetParent?.parentAddress;
  const authority = routed ? services.budgetLedgers : services.budgetAuthority;
  const children = services.budgetChildren, ledgers = services.budgetLedgers;
  if (!authority || !routed && !children) throw new Error('budget_authority_unavailable');
  const available = () => {
    if (routed) {
      if (!ledgers) throw new Error('budget_owner_ledger_unavailable');
      ledgers.resolve(child.budgetParent!.parentAddress!); ledgers.resolve(budgetWorkAddress(child));
    } else if (!children!.available(child.policy)) throw new Error('budget_child_runtime_unavailable');
  };
  available();
  const deadline = Math.min(parent.deadlineAt, child.deadlineAt, deadlineAt);
  if (services.clock.now() >= deadline) throw new Error('budget_deadline_exceeded');
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<boolean>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error('budget_authority_timeout')); controller.abort(); }, Math.min(10000, deadline - services.clock.now()));
    });
    if (!(await Promise.race([authority.current(authorityBinding(services.digester, parent, child, grantId, mandate, allocated, deadlineAt), purpose, controller.signal,
      invocation ? structuredClone(invocation) : undefined), timeout]))) throw new Error('budget_authority_denied');
  } finally { if (timer !== undefined) clearTimeout(timer); }
  if ((routed ? services.budgetLedgers : services.budgetAuthority) !== authority || services.budgetChildren !== children || services.budgetLedgers !== ledgers) throw new Error('budget_authority_changed');
  if (services.clock.now() >= deadline) throw new Error('budget_deadline_exceeded');
  available();
}

/** Refresh numeric exposure from child originals without writing a snapshot or exposing their content. */
async function liveExposure(services: ReadServices, state: WorkState, cache: Map<string, BudgetVector>, visiting = new Set<string>()): Promise<BudgetVector> {
  const stateKey = workKey(state);
  if (visiting.has(stateKey) || visiting.size > MAX_DEPTH) throw new Error('budget_hierarchy_invalid');
  const cached = cache.get(stateKey); if (cached) return cached;
  if (cache.size + visiting.size >= MAX_ACTIVE_NODES) throw new Error('budget_hierarchy_limit');
  const exposure = ownExposure(state); const chain = new Set(visiting).add(stateKey);
  for (const grant of state.budgetGrants ?? []) {
    let held = grantExposure(grant);
    if (grant.status !== 'settled') {
      const childServices = at(services, grant.childAddress), child = await load(childServices, grant.childWorkId);
      linked(state, grant, child);
      const current = await liveExposure(childServices, child, cache, chain);
      held = { ...held }; for (const d of BUDGET_DIMENSIONS) held[d] = Math.max(held[d], current[d]);
    }
    for (const d of BUDGET_DIMENSIONS) exposure[d] = plus(exposure[d], held[d]);
  }
  cache.set(stateKey, exposure); return exposure;
}

/** Read-only authority check repeated at reservation publication and immediately before adapter entry. */
export async function assertBudgetAuthority(services: ReadServices, state: WorkState, additional: Partial<BudgetVector> = {}, operation: BudgetOperation = { kind: 'general' }): Promise<void> {
  const origin = ownLedger(services, state);
  const local = budgetAllocationError(state, additional); if (local) throw new Error(local);
  const live = new Map<string, BudgetVector>(); const own = await liveExposure(services, state, live); const ownLimits = effectiveExecutionLimits(state);
  if ((state.budgetParent || state.budgetGrants?.length) && BUDGET_DIMENSIONS.some(d => plus(own[d], additional[d] ?? 0) > ownLimits[d])) throw new Error('budget_allocation_exceeded');
  let child = state, childServices = services; const visited = new Set([workKey(child)]);
  while (child.budgetParent) {
    const parentServices = at(childServices, child.budgetParent.parentAddress), parent = await load(parentServices, child.budgetParent.parentWorkId);
    if (visited.size > MAX_DEPTH || visited.has(workKey(parent))) throw new Error('budget_hierarchy_invalid');
    visited.add(workKey(parent));
    const grant = grantFor(parent, child.budgetParent.grantId); binding(services, parent, grant, child);
    if (grant.mandate) {
      await authorized(services, parent, child, grant.id, grant.mandate, grant.allocated, grant.deadlineAt, 'execution', { workId: state.id, operation });
      if ((await load(parentServices, parent.id)).revision !== parent.revision || (await load(childServices, child.id)).revision !== child.revision) throw new Error('budget_authority_state_changed');
    }
    if (child.budgetParent.phase !== 'active' || grant.status !== 'active') throw new Error('budget_grant_inactive');
    if (grant.parentGoalRevision !== parent.goal.revision) throw new Error('budget_parent_goal_changed');
    if (terminal(parent) || parent.status === 'paused') throw new Error('budget_parent_interrupted');
    if (services.clock.now() >= Math.min(parent.deadlineAt, grant.deadlineAt, child.deadlineAt)) throw new Error('budget_deadline_exceeded');
    const limits = effectiveExecutionLimits(parent); const exposure = await liveExposure(parentServices, parent, live);
    if (BUDGET_DIMENSIONS.some(d => exposure[d] > limits[d] || child.budget.limits[d] > grant.allocated[d])) throw new Error('budget_parent_exhausted');
    child = parent; childServices = parentServices;
  }
  if (origin && (!origin.current() || !origin.owns(services.state))) throw new Error('budget_owner_ledger_changed');
}

/** Cancel only reservations known not to have entered an implementation. Running usage stays accountable. */
export function cancelBudgetReservations(state: WorkState, now: number) {
  for (const call of state.modelCalls) if (call.status === 'reserved') {
    call.status = 'cancelled'; call.usageStatus = 'not_called'; call.finishedAt = now; call.reason = 'reservation_cancelled';
    state.budget.reservedModelCalls--; state.budget.reservedTokens -= call.tokenReservation;
  }
  for (const a of state.attempts) if (a.status === 'reserved') {
    a.status = 'cancelled'; a.finishedAt = now; a.error = { code: 'reservation_cancelled', retryable: true }; state.budget.reservedToolCalls--;
  }
  for (const record of state.computerReconciliations ?? []) if (record.status === 'reserved') {
    record.status = 'failed'; record.finishedAt ??= now; record.reason = 'reservation_cancelled'; state.budget.reservedToolCalls--;
  }
}

function observed(child: WorkState) {
  const accounted = vector(child.budget.used);
  const reserved: BudgetVector = { toolCalls: child.budget.reservedToolCalls, modelCalls: child.budget.reservedModelCalls, tokens: child.budget.reservedTokens, replans: 0 };
  let unmeasuredModelCalls = child.budget.used.unmeasuredModelCalls;
  for (const grant of child.budgetGrants ?? []) {
    const exposure = grantExposure(grant);
    for (const d of BUDGET_DIMENSIONS) { accounted[d] = plus(accounted[d], grant.accounted[d]); reserved[d] = plus(reserved[d], exposure[d] - grant.accounted[d]); }
    unmeasuredModelCalls = plus(unmeasuredModelCalls, grant.unmeasuredModelCalls);
  }
  return { accounted, reserved, unmeasuredModelCalls, childStateRevision: child.revision };
}
function drained(child: WorkState) {
  return child.budgetParent?.phase === 'draining' && !child.attempts.some(a => ['reserved', 'running', 'received'].includes(a.status)) &&
    !child.computerReconciliations?.some(record => ['reserved', 'running', 'received'].includes(record.status)) &&
    !child.modelCalls.some(c => ['reserved', 'running', 'received'].includes(c.status)) && !child.budget.used.unmeasuredModelCalls &&
    !child.budget.reservedToolCalls && !child.budget.reservedModelCalls && !child.budget.reservedTokens &&
    !child.budgetGrants?.some(g => g.status !== 'settled') && !child.obligations.some(o => o.kind === 'effect_reconciliation' && o.status === 'pending');
}

export class BudgetDelegationService {
  constructor(readonly services: RuntimeServices, readonly onFence?: (workId: string) => void) {}
  private selected(address?: BudgetWorkAddress) { return new BudgetDelegationService(at(this.services, address), address ? undefined : this.onFence); }
  async child(parent: WorkState, grant: BudgetGrant): Promise<WorkState> {
    const child = await load(at(this.services, grant.childAddress), grant.childWorkId); linked(parent, grant, child); return child;
  }
  async createRecipient(parentWorkId: string, commandId: string, actor: Actor, expectedGoalRevision: number,
    recipientId: string, goal: Goal, limits: Limits): Promise<WorkState> {
    const parent = await load(this.services, parentWorkId); owner(parent, actor);
    const recipient = this.services.budgetLedgers?.recipient(recipientId);
    if (!recipient || recipient.owner.tenantId !== parent.policy.tenantId ||
      !disclosureLabels(parent).every(label => recipient.policy.allowedLabels.includes(label)) ||
      !allowsDisclosure(parent.policy, 'local', 'a2a', disclosureLabels(parent))) throw new Error('budget_recipient_denied');
    const childId = `delegated:${this.services.digester.digest(json({ parent: budgetWorkAddress(parent), commandId, recipientId }))}`;
    const grantId = `budget:${this.services.digester.digest(json({ parentWorkId, commandId }))}`;
    return this.createChild(parentWorkId, commandId, actor, expectedGoalRevision, { id: childId,
      goal: { ...structuredClone(goal), scope: recipient.owner.scope }, policy: structuredClone(recipient.policy), limits: structuredClone(limits),
      address: { ...recipient.owner, workId: childId }, mandate: { provider: 'host-budget-ledger', referenceId: grantId,
        revision: recipient.revision, childGoalRevision: goal.revision, attributes: { recipientId } } });
  }
  async runRecipient(parentWorkId: string, grantId: string, actor: Actor, maxSteps: number, signal: AbortSignal): Promise<unknown> {
    const parent = await load(this.services, parentWorkId); owner(parent, actor);
    const grant = grantFor(parent, grantId), child = await this.child(parent, grant);
    if (!grant.childAddress || !grant.mandate || grant.status !== 'active' || signal.aborted) throw new Error('budget_grant_inactive');
    const childServices = at(this.services, grant.childAddress), ledger = childServices.budgetLedger!;
    await assertBudgetAuthority(childServices, child, {}, { kind: 'control' });
    const currentParent = await load(this.services, parentWorkId), currentChild = await load(childServices, child.id);
    if (currentParent.revision !== parent.revision || currentChild.revision !== child.revision || signal.aborted) throw new Error('budget_authority_state_changed');
    const stop = () => { void ledger.interrupt(child.id).catch(() => undefined); };
    signal.addEventListener('abort', stop, { once: true });
    try { return await ledger.run(child.id, maxSteps, signal); }
    finally { signal.removeEventListener('abort', stop); }
  }
  private async checkCreation(parent: WorkState, child: WorkState, actor: Actor, expectedGoalRevision: number, mandate?: BudgetMandate) {
    owner(parent, actor);
    if (parent.goal.revision !== expectedGoalRevision) throw new Error('stale_user_command');
    if (terminal(parent) || parent.status === 'paused') throw new Error('budget_parent_interrupted');
    if (mandate) {
      if (!child.budgetParent) throw new Error('budget_child_binding_changed');
      if (child.budgetParent.parentAddress && !this.services.budgetLedgers?.resolve(child.budgetParent.parentAddress).owns(this.services.state))
        throw new Error('budget_owner_ledger_changed');
      await authorized(this.services, parent, child, child.budgetParent.grantId, mandate, vector(child.budget.limits), child.deadlineAt, 'allocation');
    } else {
      if (!narrowed(child.policy, parent.policy)) throw new Error('budget_policy_escalation');
      if (child.policy.disclosure && !parent.policy.disclosure) throw new Error('budget_disclosure_history_unclassified');
      if (!inheritedDisclosure(parent, child)) throw new Error('budget_disclosure_labels_not_inherited');
    }
    if (child.deadlineAt > parent.deadlineAt || this.services.clock.now() >= child.deadlineAt) throw new Error('budget_deadline_exceeded');
    await assertBudgetAuthority(this.services, parent);
    // The new edge must leave room for the final child in the bounded chain.
    let ancestor = parent, ancestorServices: ReadServices = this.services; const seen = new Set([workKey(child)]);
    for (;;) {
      if (seen.has(workKey(ancestor)) || seen.size > MAX_DEPTH) throw new Error('budget_hierarchy_invalid');
      seen.add(workKey(ancestor)); if (!ancestor.budgetParent) break;
      ancestorServices = at(ancestorServices, ancestor.budgetParent.parentAddress);
      ancestor = await load(ancestorServices, ancestor.budgetParent.parentWorkId);
    }
    if (mandate && (await load(this.services, parent.id)).revision !== parent.revision) throw new Error('budget_authority_state_changed');
  }
  async createChild(parentWorkId: string, commandId: string, actor: Actor, expectedGoalRevision: number, input: ChildInput): Promise<WorkState> {
    const parent = await load(this.services, parentWorkId); owner(parent, actor);
    if (!commandId.trim()) throw new Error('invalid_command_id');
    if (input.deadlineAt !== undefined && (!Number.isSafeInteger(input.deadlineAt) || input.deadlineAt < 0)) throw new Error('budget_deadline_invalid');
    const mandate = input.mandate === undefined ? undefined : parseContract(BudgetMandateSchema, input.mandate);
    const digest = this.services.digester.digest(json({ parentWorkId, commandId, actor, expectedGoalRevision, input }));
    const grantId = `budget:${this.services.digester.digest(json({ parentWorkId, commandId }))}`;
    if (input.address && (!mandate || input.address.workId !== input.id || input.address.scope !== input.goal.scope || input.address.tenantId !== input.policy.tenantId || input.address.principalId !== input.policy.principalId)) throw new Error('budget_child_binding_changed');
    const childServices = at(this.services, input.address);
    const receiptId = 'budget.child-genesis';
    const receipt = await childServices.state.receipt(input.id, receiptId);
    let child: WorkState;
    if (receipt) {
      if (receipt.digest !== digest) throw new Error('idempotency_conflict');
      child = await load(childServices, input.id);
      if (child.budgetParent?.parentWorkId !== parentWorkId || child.budgetParent.grantId !== grantId) throw new Error('budget_child_binding_changed');
      if (child.budgetParent.phase !== 'pending') return child;
    } else {
      if (await childServices.state.get(input.id)) throw new Error('budget_child_exists');
      child = newWork({ ...input, now: this.services.clock.now() });
      if (!mandate && parent.policy.disclosure && child.policy.disclosure) child.disclosureLabels = [...new Set([...disclosureLabels(parent), ...disclosureLabels(child)])].sort();
      if (input.address) child.disclosureLabels = [...new Set([...disclosureLabels(parent), ...disclosureLabels(child)])].sort();
      child.deadlineAt = Math.min(child.deadlineAt, parent.deadlineAt, input.deadlineAt ?? Number.MAX_SAFE_INTEGER);
      child.budgetParent = { parentWorkId, grantId, phase: 'pending', ...(input.address ? { parentAddress: budgetWorkAddress(parent) } : {}) }; child.status = 'blocked'; child.statusReason = 'budget_child_pending';
      await this.checkCreation(parent, child, actor, expectedGoalRevision, mandate);
      const result = await childServices.state.commit({ workId: child.id, expectedRevision: 0, commandId: receiptId, commandDigest: digest, next: child,
        events: [{ type: 'budget_child_pending', at: child.createdAt, data: { parentWorkId, grantId } }], deliveries: [] });
      if (result.kind === 'idempotency_conflict') throw new Error('idempotency_conflict');
      if (result.kind === 'conflict') throw new Error('budget_child_exists');
      child = await load(childServices, input.id);
    }
    const genesis = (await childServices.state.receipt(child.id, receiptId))!.state;
    await this.prepare(parentWorkId);
    const latestParent = await load(this.services, parentWorkId);
    await this.checkCreation(latestParent, genesis, actor, expectedGoalRevision, mandate);
    await transact(this.services, parentWorkId, `budget-grant:${commandId}`, 'budget_granted', { grantId, childWorkId: child.id, digest }, next => {
      owner(next, actor);
      if (next.goal.revision !== expectedGoalRevision) throw new Error('stale_user_command');
      if (terminal(next) || next.status === 'paused') throw new Error('budget_parent_interrupted');
      if (!mandate && !narrowed(genesis.policy, next.policy)) throw new Error('budget_policy_escalation');
      if (!mandate && !inheritedDisclosure(next, genesis)) throw new Error('budget_disclosure_labels_not_inherited');
      if (mandate && next.budgetGrants?.some(g => g.mandate?.provider === mandate.provider && g.mandate.referenceId === mandate.referenceId)) throw new Error('budget_mandate_already_allocated');
      if (next.budgetGrants?.some(g => g.id === grantId || g.childWorkId === child.id)) throw new Error('budget_child_exists');
      if ((next.budgetGrants?.length ?? 0) >= MAX_BUDGET_GRANTS) throw new Error('budget_grant_limit');
      const allocation = vector(genesis.budget.limits); const exposure = totalExposure(next); const limits = effectiveExecutionLimits(next);
      if (BUDGET_DIMENSIONS.some(d => plus(exposure[d], allocation[d]) > limits[d])) throw new Error('budget_allocation_exceeded');
      (next.budgetGrants ??= []).push({ id: grantId, childWorkId: child.id, ...(input.address ? { childAddress: structuredClone(input.address) } : {}), parentGoalRevision: next.goal.revision, childScope: genesis.goal.scope,
        childPolicyDigest: this.services.digester.digest(json(genesis.policy)), allocated: allocation, deadlineAt: genesis.deadlineAt, status: 'active',
        accounted: zero(), reserved: zero(), unmeasuredModelCalls: 0, childStateRevision: null, ...(mandate ? { mandate: structuredClone(mandate) } : {}) });
      next.obligations.push({ id: grantId, kind: 'budget_reconciliation', reason: 'delegated_usage_requires_settlement', status: 'pending', wakeKey: grantId, dueAt: genesis.deadlineAt });
    }, async () => {
      const current = await load(this.services, parentWorkId);
      await this.checkCreation(current, genesis, actor, expectedGoalRevision, mandate);
      await assertBudgetAuthority(this.services, current, vector(genesis.budget.limits));
    });
    await transact(childServices, child.id, `budget-activate:${grantId}`, 'budget_child_activated', { grantId }, next => {
      if (next.budgetParent?.phase !== 'pending' || next.budgetParent.grantId !== grantId || next.revision !== genesis.revision) throw new Error('budget_activation_stale');
      next.budgetParent.phase = 'active'; next.status = 'ready'; next.statusReason = 'budget_child_active';
    }, async () => {
      const current = await load(this.services, parentWorkId); const grant = grantFor(current, grantId);
      await this.checkCreation(current, genesis, actor, expectedGoalRevision, mandate);
      if (grant.status !== 'active') throw new Error('budget_grant_inactive');
    });
    const activated = await load(childServices, child.id);
    // Allocation can prepare a request while its execution permit is still pending.
    if (mandate) {
      const current = await load(this.services, parentWorkId); const grant = grantFor(current, grantId);
      await authorized(this.services, current, activated, grantId, mandate, grant.allocated, grant.deadlineAt, 'allocation');
    } else await assertBudgetAuthority(childServices, activated);
    return activated;
  }
  private async fence(childId: string, parentId: string, grantId: string) {
    const parent = await load(this.services, parentId), grant = grantFor(parent, grantId), childServices = at(this.services, grant.childAddress);
    const prior = await load(childServices, childId);
    linked(parent, grant, prior);
    if (prior.budgetParent?.parentWorkId !== parentId || prior.budgetParent.grantId !== grantId) throw new Error('budget_child_binding_changed');
    if (prior.budgetParent.phase !== 'draining') await transact(childServices, childId, `budget-fence:${grantId}`, 'budget_child_fenced', { parentId, grantId }, child => {
      if (child.budgetParent?.parentWorkId !== parentId || child.budgetParent.grantId !== grantId) throw new Error('budget_child_binding_changed');
      child.budgetParent.phase = 'draining'; cancelBudgetReservations(child, this.services.clock.now());
      for (const call of child.modelCalls) if (call.status === 'running') { call.expired = true; call.reason = 'budget_grant_revoked'; }
      for (const a of child.attempts) if (a.status === 'running' && a.effect === 'write' && !child.obligations.some(o => o.id === `effect:${a.id}`))
        child.obligations.push({ id: `effect:${a.id}`, kind: 'effect_reconciliation', reason: 'dispatched_effect_requires_reconciliation', status: 'pending', wakeKey: null, dueAt: null });
      if (!terminal(child) && child.status !== 'paused') { child.status = 'blocked'; child.statusReason = 'budget_child_draining'; }
      child.retryWakeAt = null;
    });
    if (!grant.childAddress) this.onFence?.(childId);
    if (childServices.budgetLedger) await childServices.budgetLedger.interrupt(childId);
    else if (this.services.budgetChildren) {
      await this.services.budgetChildren.interrupt(childId);
    } else if (grantFor(parent, grantId).mandate) throw new Error('budget_child_runtime_unavailable');
  }
  private async markDraining(parentId: string, grantId: string) {
    const prior = await load(this.services, parentId); if (grantFor(prior, grantId).status !== 'active') return;
    await transact(this.services, parentId, `budget-drain:${grantId}`, 'budget_grant_draining', { grantId }, next => {
      const grant = grantFor(next, grantId); if (grant.status === 'active') grant.status = 'draining';
    });
  }
  async revoke(parentWorkId: string, grantId: string, commandId: string, actor: Actor, expectedGoalRevision: number): Promise<WorkState> {
    owner(await load(this.services, parentWorkId), actor);
    await transact(this.services, parentWorkId, `budget-revoke:${commandId}`, 'budget_revoke_requested', { grantId, actor: json(actor), expectedGoalRevision }, next => {
      owner(next, actor); if (next.goal.revision !== expectedGoalRevision) throw new Error('stale_user_command');
      const grant = grantFor(next, grantId); if (grant.status === 'active') grant.status = 'draining';
    });
    await this.reconcile(parentWorkId, grantId, actor); return load(this.services, parentWorkId);
  }
  /** The recipient may stop using its own grant without acting as the sponsor. */
  async returnAllocation(childWorkId: string, commandId: string, actor: Actor, expectedGoalRevision: number): Promise<BudgetGrant> {
    const child = await load(this.services, childWorkId); owner(child, actor);
    if (!child.budgetParent || !commandId.trim() || child.goal.revision !== expectedGoalRevision) throw new Error('budget_return_invalid');
    const { parentWorkId, grantId } = child.budgetParent;
    await transact(this.services, childWorkId, `budget-return:${commandId}`, 'budget_return_requested', { actor: json(actor), grantId, expectedGoalRevision }, next => {
      owner(next, actor);
      if (next.goal.revision !== expectedGoalRevision || next.budgetParent?.parentWorkId !== parentWorkId || next.budgetParent.grantId !== grantId)
        throw new Error('budget_child_binding_changed');
    });
    const parentService = this.selected(child.budgetParent.parentAddress);
    const parent = await load(parentService.services, parentWorkId); linked(parent, grantFor(parent, grantId), child);
    await parentService.markDraining(parentWorkId, grantId);
    await parentService.sync(parentWorkId, grantId, new Set());
    return grantFor(await load(parentService.services, parentWorkId), grantId);
  }
  private async sync(parentWorkId: string, grantId: string, visited: Set<string>): Promise<BudgetGrant> {
    let parent = await load(this.services, parentWorkId); let grant = grantFor(parent, grantId);
    if (visited.has(workKey(parent)) || visited.size >= MAX_DEPTH) throw new Error('budget_hierarchy_invalid');
    const chain = new Set(visited).add(workKey(parent));
    if (grant.status === 'settled') return grant;
    const childService = this.selected(grant.childAddress), childServices = at(this.services, grant.childAddress);
    let child = await load(childServices, grant.childWorkId);
    linked(parent, grant, child);
    // Accounting and fencing require the immutable link, even when policy or scope has since changed.
    if (child.budgetParent?.parentWorkId !== parent.id || child.budgetParent.grantId !== grant.id || chain.has(workKey(child))) throw new Error('budget_child_binding_changed');
    let invalid = false; try { binding(this.services, parent, grant, child); } catch { invalid = true; }
    let shouldDrain = invalid || terminal(parent) || terminal(child) || grant.parentGoalRevision !== parent.goal.revision ||
      this.services.clock.now() >= Math.min(parent.deadlineAt, grant.deadlineAt, child.deadlineAt) || child.budgetParent.phase === 'draining';
    if (!shouldDrain && grant.status === 'active' && grant.mandate) {
      try { await authorized(this.services, parent, child, grant.id, grant.mandate, grant.allocated, grant.deadlineAt, 'allocation'); }
      catch (error) {
        // An unavailable reader is not evidence of revocation. Retain escrow and retry from persisted state.
        if (error instanceof Error && ['budget_authority_denied', 'budget_mandate_binding_changed', 'budget_deadline_exceeded'].includes(error.message)) shouldDrain = true;
        else throw error;
      }
    }
    if (grant.status === 'active' && shouldDrain) { await this.markDraining(parent.id, grant.id); parent = await load(this.services, parent.id); grant = grantFor(parent, grant.id); }
    if (grant.status === 'draining') {
      await this.fence(child.id, parent.id, grant.id); child = await load(childServices, child.id);
      for (const nested of child.budgetGrants ?? []) if (nested.status === 'active') await childService.markDraining(child.id, nested.id);
    }
    for (const nested of child.budgetGrants ?? []) if (nested.status !== 'settled') await childService.sync(child.id, nested.id, chain);
    if (childServices.budgetLedger) {
      await childServices.budgetLedger.refreshEffects(child.id); child = await load(childServices, child.id);
    } else if (this.services.budgetChildren) {
      await this.services.budgetChildren.refreshEffects(child.id); child = await load(childServices, child.id);
    } else {
      if (grant.mandate) throw new Error('budget_child_runtime_unavailable');
      child = await refreshEffectProofs(this.services, child.id);
    }
    const usage = observed(child);
    const settled = grant.status === 'draining' && drained(child);
    const status = settled ? 'settled' : grant.status;
    const current = grantFor(await load(this.services, parent.id), grant.id);
    if (current.childStateRevision === child.revision && current.status === status) return current;
    await transact(this.services, parent.id, `budget-observe:${grant.id}:${child.revision}:${status}`, 'budget_usage_observed', { grantId: grant.id, childRevision: child.revision, status }, next => {
      const target = grantFor(next, grant.id);
      if (target.status === 'settled' || (target.childStateRevision ?? 0) > child.revision) return;
      Object.assign(target, usage);
      if (settled && target.status === 'draining') {
        target.status = 'settled';
        const obligation = next.obligations.find(o => o.id === grant.id && o.kind === 'budget_reconciliation'); if (obligation) obligation.status = 'satisfied';
      }
      if (next.status === 'waiting' && next.statusReason === 'budget_delegation_pending' || next.status === 'blocked' && next.statusReason.startsWith('budget_') && !next.budgetParent && !budgetAllocationError(next)) {
        next.status = 'ready'; next.statusReason = 'budget_usage_reconciled';
      }
    }, async () => {
      if (settled) {
        const currentProof = childServices.budgetLedger ? await childServices.budgetLedger.effectsCurrent(child.id, child.revision) : this.services.budgetChildren ? await this.services.budgetChildren.effectsCurrent(child.id, child.revision) :
          !grant.mandate && await effectProofsCurrent(this.services, child);
        if (!currentProof || (await load(childServices, child.id)).revision !== child.revision) throw new Error('budget_child_proof_changed');
      }
    });
    return grantFor(await load(this.services, parent.id), grant.id);
  }
  async reconcile(parentWorkId: string, grantId: string, actor: Actor): Promise<BudgetGrant> {
    owner(await load(this.services, parentWorkId), actor); return this.sync(parentWorkId, grantId, new Set());
  }
  /** Increase one existing grant within the sponsor's original limit. Parent escrow is published first. */
  async increase(parentWorkId: string, grantId: string, commandId: string, actor: Actor, expectedGoalRevision: number, extra: BudgetVector): Promise<BudgetGrant> {
    const parent = await load(this.services, parentWorkId); owner(parent, actor);
    if (!commandId.trim() || !BUDGET_DIMENSIONS.every(d => Number.isSafeInteger(extra[d]) && extra[d] >= 0) ||
      !BUDGET_DIMENSIONS.some(d => extra[d] > 0)) throw new Error('budget_increase_invalid');
    const request = { grantId, actor: json(actor), expectedGoalRevision, extra: json(extra) };
    await transact(this.services, parentWorkId, `budget-increase:${commandId}`, 'budget_grant_increased', request, next => {
      owner(next, actor);
      const grant = grantFor(next, grantId);
      if (next.goal.revision !== expectedGoalRevision || grant.parentGoalRevision !== expectedGoalRevision || terminal(next) || next.status === 'paused' ||
        grant.status !== 'active' || this.services.clock.now() >= grant.deadlineAt) throw new Error('budget_grant_inactive');
      const limits = effectiveExecutionLimits(next), exposure = totalExposure(next);
      for (const dimension of BUDGET_DIMENSIONS) {
        if (plus(exposure[dimension], extra[dimension]) > limits[dimension]) throw new Error('budget_allocation_exceeded');
        grant.allocated[dimension] = plus(grant.allocated[dimension], extra[dimension]);
      }
    }, async () => {
      const latest = await load(this.services, parentWorkId), grant = grantFor(latest, grantId), child = await this.child(latest, grant);
      binding(this.services, latest, grant, child);
      await assertBudgetAuthority(this.services, latest, extra);
      if (grant.mandate) {
        const allocated = vector(grant.allocated);
        for (const dimension of BUDGET_DIMENSIONS) allocated[dimension] = plus(allocated[dimension], extra[dimension]);
        await authorized(this.services, latest, child, grantId, grant.mandate, allocated, grant.deadlineAt, 'allocation');
      }
    });
    // A retry finishes this step from the original receipt; it never allocates the increment twice.
    const receipt = await this.services.state.receipt(parentWorkId, `budget-increase:${commandId}`);
    if (!receipt) throw new Error('budget_increase_receipt_missing');
    const target = grantFor(receipt.state, grantId);
    await transact(at(this.services, target.childAddress), target.childWorkId, `budget-increase:${parentWorkId}:${commandId}`, 'budget_child_limit_increased',
      { parentWorkId, grantId, allocated: json(target.allocated) }, child => {
        if (child.budgetParent?.parentWorkId !== parentWorkId || child.budgetParent.grantId !== grantId || child.budgetParent.phase !== 'active')
          throw new Error('budget_grant_inactive');
        for (const dimension of BUDGET_DIMENSIONS) child.budget.limits[dimension] = Math.max(child.budget.limits[dimension], target.allocated[dimension]);
        const remaining = vector(extra);
        for (const obligation of child.obligations) if (obligation.id.startsWith('budget-request:') && obligation.status === 'pending') {
          try {
            const requested: unknown = JSON.parse(obligation.reason)?.extra;
            if (validBudgetVector(requested) && BUDGET_DIMENSIONS.every(d => requested[d] <= remaining[d])) {
              for (const dimension of BUDGET_DIMENSIONS) remaining[dimension] -= requested[dimension];
              obligation.status = 'satisfied';
            }
          } catch { /* Other response obligations are unaffected. */ }
        }
      }, async () => {
        const latest = await load(this.services, parentWorkId), grant = grantFor(latest, grantId);
        if (grant.status !== 'active' || terminal(latest) || latest.status === 'paused' || latest.goal.revision !== expectedGoalRevision ||
          BUDGET_DIMENSIONS.some(d => grant.allocated[d] < target.allocated[d])) throw new Error('budget_grant_inactive');
      });
    return grantFor(await load(this.services, parentWorkId), grantId);
  }
  /** Refresh accounting without gating received results, recovery, or a valid completion decision. */
  async refresh(workId: string): Promise<WorkState> {
    const state = await load(this.services, workId);
    if (!state.budgetGrants?.some(g => g.status !== 'settled')) return state;
    for (const grant of state.budgetGrants ?? []) if (grant.status !== 'settled') await this.sync(workId, grant.id, new Set());
    return load(this.services, workId);
  }
  async prepare(workId: string): Promise<WorkState> {
    let state = await load(this.services, workId); let root = state, rootServices = this.services; const seen = new Set([workKey(state)]);
    if (state.budgetParent && state.budgetParent.phase !== 'active') throw new Error(`budget_child_${state.budgetParent.phase}`);
    while (root.budgetParent) {
      rootServices = at(rootServices, root.budgetParent.parentAddress);
      root = await load(rootServices, root.budgetParent.parentWorkId);
      if (seen.has(workKey(root)) || seen.size > MAX_DEPTH) throw new Error('budget_hierarchy_invalid');
      seen.add(workKey(root));
    }
    if (root.budgetGrants?.some(g => g.status !== 'settled')) {
      const refreshed = await new BudgetDelegationService(rootServices).refresh(root.id); state = workKey(root) === workKey(state) ? refreshed : await load(this.services, workId);
    }
    await assertBudgetAuthority(this.services, state, {}, { kind: 'control' }); return state;
  }
  async reduceLimits(workId: string, commandId: string, actor: Actor, expectedGoalRevision: number, limits: Limits): Promise<WorkState> {
    const prior = await load(this.services, workId); owner(prior, actor);
    parseContract(BudgetSchema, { ...prior.budget, limits });
    await transact(this.services, workId, `budget-limits:${commandId}`, 'budget_limits_reduced', { actor: json(actor), expectedGoalRevision, limits: json(limits) }, next => {
      owner(next, actor); if (next.goal.revision !== expectedGoalRevision) throw new Error('stale_user_command');
      if (BUDGET_DIMENSIONS.some(d => limits[d] > next.budget.limits[d]) || limits.wallTimeMs > next.budget.limits.wallTimeMs) throw new Error('budget_limit_increase_denied');
      next.budget.limits = structuredClone(limits); next.deadlineAt = Math.min(next.deadlineAt, next.createdAt + limits.wallTimeMs);
      cancelBudgetReservations(next, this.services.clock.now());
    });
    const current = await this.refresh(workId); const exposure = totalExposure(current); const effective = effectiveExecutionLimits(current);
    if (BUDGET_DIMENSIONS.some(d => exposure[d] > effective[d])) {
      for (const grant of current.budgetGrants ?? []) if (grant.status === 'active') await this.markDraining(workId, grant.id);
      return this.refresh(workId);
    }
    return current;
  }
}
