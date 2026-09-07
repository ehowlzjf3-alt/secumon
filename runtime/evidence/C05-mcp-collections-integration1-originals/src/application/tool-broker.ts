import type { StateRepository, Digester, Clock } from './ports.js';
import type { ToolContracts } from './tool-contracts.js';
import { asJson, taskDigest } from './plan-validator.js';
import { authorizedWork } from './work-resources.js';
import type { Attempt, TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import { assertBudgetAuthority } from './budget-delegation.js';
import { allowsDisclosure, disclosureLabels } from '../domain/disclosure.js';
import type { ComputerContinuationService, EffectProofValidator, RuntimeServices } from './services.js';
import { effectProofsCurrent } from './effect-proofs.js';
import { dataGeneration } from '../domain/data-lifecycle.js';
import { executionAuthorityCurrent, executionAuthoritySignal } from './execution-authority.js';

export interface InvocationHooks {
  reuse?: (state: WorkState, task: TaskSpec, attempt: Attempt) => Promise<ToolResult | null>;
  entered?: () => void;
  reused?: () => void;
  /** Host lifetime for finishing an already-dispatched response, independent of execution cancellation. */
  custodyCurrent?: () => boolean;
}

export class BrokerError extends Error {
  constructor(readonly code: string) { super(code); }
}
function custodyAttempt(attempt: Attempt) {
  return { id: attempt.id, taskId: attempt.taskId, toolId: attempt.toolId, toolVersion: attempt.toolVersion,
    inputDigest: attempt.inputDigest, contractDigest: attempt.contractDigest ?? null, scope: attempt.scope,
    goalRevision: attempt.goalRevision, planRevision: attempt.planRevision, owner: attempt.owner,
    startedAt: attempt.startedAt, leaseUntil: attempt.leaseUntil, effect: attempt.effect, effectState: attempt.effectState,
    readProgress: attempt.readProgress ?? null, reuse: attempt.reuse ?? null, computerUse: attempt.computerUse ?? null };
}
export class ToolBroker {
  constructor(readonly state: StateRepository, readonly tools: ToolContracts, readonly digester: Digester, readonly clock: Clock,
    readonly beforeInvoke?: (state: WorkState) => Promise<boolean>, readonly effects?: EffectProofValidator, readonly continuations?: ComputerContinuationService,
    readonly budgets?: Pick<RuntimeServices, 'budgetAuthority' | 'budgetChildren' | 'executionAuthority'>) {}
  async invoke(workId: string, attemptId: string, owner: string, signal: AbortSignal, hooks: InvocationHooks = {}) {
    const custodyStore = this.state, custodyDigester = this.digester;
    signal = executionAuthoritySignal(this.budgets ?? {}, signal);
    const dispatched = await this.state.receipt(workId, `dispatch:${attemptId}`);
    if (!dispatched) throw new BrokerError('broker_dispatch_missing');
    if (this.budgets?.executionAuthority) {
      const original = await this.state.get(workId);
      if (!original || !executionAuthorityCurrent(this.budgets, original)) throw new BrokerError('execution_authority_denied');
    }
    const state = await authorizedWork(this.state, workId, dispatched.state.policy); const attempt = state.attempts.find(a => a.id === attemptId);
    const task = state?.plan?.tasks.find(t => t.id === attempt?.taskId);
    if (!state || !attempt || !task || attempt.owner !== owner || attempt.status !== 'running' || attempt.goalRevision !== state.goal.revision ||
      state.goal.scope !== attempt.scope || taskDigest(task, this.digester) !== attempt.inputDigest || ['paused', 'cancelled', 'failed', 'completed'].includes(state.status) ||
      this.clock.now() >= Math.min(attempt.leaseUntil, state.deadlineAt) || signal.aborted) throw new BrokerError('broker_execution_not_current');
    if (task.computerResume) {
      if (!this.continuations) throw new BrokerError('computer_continuation_not_supported');
      try { await this.continuations.resolve(state, attemptId); } catch { throw new BrokerError('computer_continuation_unproven'); }
    }
    if (state.obligations.some(obligation => obligation.kind === 'effect_reconciliation' && obligation.status === 'pending'))
      throw new BrokerError('broker_effect_unresolved');
    const error = this.tools.checkExecution(task, state.policy); if (error) throw new BrokerError(error);
    const selectedDigest = attempt.contractDigest ?? this.digester.digest(asJson(this.tools.get(task.toolId, task.toolVersion)!.tool.definition));
    const contractCurrent = () => {
      const entry = this.tools.get(task.toolId, task.toolVersion);
      if (!entry || selectedDigest !== this.digester.digest(asJson(entry.tool.definition))) throw new BrokerError('tool_contract_changed');
      const error = this.tools.checkExecution(task, state.policy); if (error) throw new BrokerError(error);
      return entry;
    };
    contractCurrent();
    if (this.beforeInvoke && !(await this.beforeInvoke(state))) throw new BrokerError('broker_knowledge_changed');
    const reused = await hooks.reuse?.(state, task, attempt);
    if (hooks.reuse && this.beforeInvoke && !(await this.beforeInvoke(state))) throw new BrokerError('broker_knowledge_changed');
    try { await assertBudgetAuthority({ state: this.state, digester: this.digester, clock: this.clock,
      budgetAuthority: this.budgets?.budgetAuthority, budgetChildren: this.budgets?.budgetChildren }, state, {}, { kind: 'tool', task, attemptId }); }
    catch (error) { throw new BrokerError(error instanceof Error ? error.message : 'budget_grant_inactive'); }
    if (!(await effectProofsCurrent({ effects: this.effects }, state))) throw new BrokerError('broker_effect_proof_changed');
    const final = this.budgets?.executionAuthority ? await this.state.get(workId) : await authorizedWork(this.state, workId, dispatched.state.policy);
    if (!final || final.revision !== state.revision || this.budgets?.executionAuthority && this.digester.digest(asJson(final.policy)) !== this.digester.digest(asJson(dispatched.state.policy)) || signal.aborted) throw new BrokerError('broker_execution_not_current');
    if (!executionAuthorityCurrent(this.budgets ?? {}, final)) throw new BrokerError('execution_authority_denied');
    const entry = contractCurrent();
    if (this.clock.now() >= Math.min(attempt.leaseUntil, state.deadlineAt)) throw new BrokerError('broker_execution_not_current');
    if (reused) { hooks.reused?.(); return reused; }
    if (!allowsDisclosure(state.policy, entry.tool.definition.destination, 'tool', disclosureLabels(state))) throw new BrokerError('tool_disclosure_denied');
    const authorize = async () => {
      const raw = await this.state.get(workId);
      const current = await authorizedWork(this.state, workId, dispatched.state.policy);
      const active = current.attempts.find(value => value.id === attemptId);
      const currentTask = current.plan?.tasks.find(value => value.id === task.id);
      if (!raw || raw.revision !== current.revision ||
        this.digester.digest(asJson(raw.policy)) !== this.digester.digest(asJson(dispatched.state.policy)) ||
        !active || active.owner !== owner || active.status !== 'running' || signal.aborted ||
        ['paused', 'cancelled', 'failed', 'completed', 'blocked'].includes(current.status) || !currentTask ||
        active.goalRevision !== current.goal.revision || active.scope !== current.goal.scope ||
        active.planRevision !== current.plan?.revision || active.inputDigest !== attempt.inputDigest ||
        taskDigest(currentTask, this.digester) !== attempt.inputDigest || dataGeneration(current) !== dataGeneration(state) ||
        this.digester.digest(asJson(current.policy)) !== this.digester.digest(asJson(state.policy)) ||
        this.digester.digest(asJson(current.goal)) !== this.digester.digest(asJson(state.goal)) ||
        this.clock.now() >= Math.min(active.leaseUntil, current.deadlineAt) ||
        current.obligations.some(value => value.kind === 'effect_reconciliation' && value.status === 'pending'))
        throw new BrokerError('broker_execution_not_current');
      if (!executionAuthorityCurrent(this.budgets ?? {}, raw)) throw new BrokerError('execution_authority_denied');
      if (this.beforeInvoke && !(await this.beforeInvoke(current))) throw new BrokerError('broker_knowledge_changed');
      try { await assertBudgetAuthority({ state: this.state, digester: this.digester, clock: this.clock,
        budgetAuthority: this.budgets?.budgetAuthority, budgetChildren: this.budgets?.budgetChildren }, current, {}, { kind: 'tool', task: currentTask, attemptId }); }
      catch (error) { throw new BrokerError(error instanceof Error ? error.message : 'budget_grant_inactive'); }
      if (!(await effectProofsCurrent({ effects: this.effects }, current))) throw new BrokerError('broker_effect_proof_changed');
      const final = this.budgets?.executionAuthority ? await this.state.get(workId) : await authorizedWork(this.state, workId, dispatched.state.policy);
      if (!final || final.revision !== current.revision || this.budgets?.executionAuthority && this.digester.digest(asJson(final.policy)) !== this.digester.digest(asJson(dispatched.state.policy)) || signal.aborted ||
        this.clock.now() >= Math.min(active.leaseUntil, current.deadlineAt)) throw new BrokerError('broker_execution_not_current');
      if (!executionAuthorityCurrent(this.budgets ?? {}, final)) throw new BrokerError('execution_authority_denied');
      const selected = contractCurrent();
      if (selected !== entry) throw new BrokerError('tool_contract_changed');
      if (!allowsDisclosure(current.policy, selected.tool.definition.destination, 'tool', disclosureLabels(current)))
        throw new BrokerError('tool_disclosure_denied');
    };
    const definition = entry.tool.definition;
    const plainCustody = definition.effect === 'read' && definition.resultValidation === 'artifact-proof-v1' &&
      !definition.collection && !definition.reuse && !definition.computerContinuation && !definition.computerInputAssurance &&
      task.effect === 'read' && !task.readResume && !task.computerResume && attempt.effect === 'read' && attempt.effectState === 'none' &&
      !attempt.readProgress && !attempt.reuse && !attempt.computerUse;
    let custodyActive = true;
    let authorizeResponseCustody: (() => Promise<void>) | undefined;
    if (plainCustody) {
      const digest = (value: unknown) => custodyDigester.digest(asJson(value));
      const originalAttempt = dispatched.state.attempts.find(value => value.id === attemptId);
      const originalTask = dispatched.state.plan?.tasks.find(value => value.id === attempt.taskId);
      const tenantId = state.policy.tenantId, principalId = state.policy.principalId, generation = dataGeneration(state);
      const attemptPin = digest(custodyAttempt(attempt));
      if (dispatched.state.id !== workId || dispatched.state.createdAt !== state.createdAt || dispatched.state.policy.tenantId !== tenantId ||
        dispatched.state.policy.principalId !== principalId || dataGeneration(dispatched.state) !== generation ||
        dispatched.digest !== digest({ type: 'attempt_dispatched', data: { attemptId, owner } }) ||
        !originalAttempt || originalAttempt.status !== 'running' || digest(custodyAttempt(originalAttempt)) !== attemptPin ||
        !originalTask || digest(originalTask) !== digest(task) || taskDigest(originalTask, custodyDigester) !== attempt.inputDigest ||
        originalTask.toolId !== definition.id || originalTask.toolVersion !== definition.version ||
        !dispatched.state.plan || dispatched.state.plan.revision !== attempt.planRevision || dispatched.state.goal.revision !== attempt.goalRevision ||
        dispatched.state.plan.goalRevision !== attempt.goalRevision || dispatched.state.goal.scope !== attempt.scope ||
        (originalAttempt.contractDigest ?? selectedDigest) !== selectedDigest || digest(definition) !== selectedDigest)
        throw new BrokerError('broker_response_custody_invalid');
      // The immutable dispatch fixes the original task and contract even after a catalog refresh or goal change.
      const dispatchPin = digest(dispatched);
      const custodyCurrent = hooks.custodyCurrent ?? (() => true);
      const assertOpen = () => { if (!custodyActive || !custodyCurrent()) throw new BrokerError('broker_response_custody_closed'); };
      authorizeResponseCustody = async () => {
        assertOpen();
        const original = await custodyStore.receipt(workId, `dispatch:${attemptId}`);
        assertOpen();
        if (!original || digest(original) !== dispatchPin) throw new BrokerError('broker_response_custody_invalid');
        const current = await custodyStore.get(workId);
        assertOpen();
        const active = current?.attempts.find(value => value.id === attemptId);
        if (!current || current.id !== workId || current.createdAt !== original.state.createdAt || current.policy.tenantId !== tenantId || current.policy.principalId !== principalId ||
          current.revision < original.state.revision || dataGeneration(current) !== generation ||
          !active || digest(custodyAttempt(active)) !== attemptPin) throw new BrokerError('broker_response_custody_invalid');
        // Policy/goal/status/expiry changes cannot authorize a new send, but do not erase this original call's custody.
        // This read is not atomic with publication; the adapter also uses it in its existing pre-commit boundary.
      };
    }
    try {
      hooks.entered?.();
      return await entry.tool.execute(structuredClone(task), { workId, attemptId, policy: structuredClone(state.policy), signal, authorize,
        ...(authorizeResponseCustody ? { authorizeResponseCustody } : {}) });
    } finally { custodyActive = false; }
  }
}
