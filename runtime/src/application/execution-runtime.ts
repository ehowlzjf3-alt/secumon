import { assertExecutionAuthority, executionAuthorityCurrent } from './execution-authority.js';
import { z } from 'zod';
import type { Control } from '../domain/control.js';
import { decideExecution, taskFailureKey } from './execution-decision.js';
import { acceptedToolProgressKeys, captureProgress } from './work-progress.js';
import { isComputerObservationTool } from './computer-tool-identity.js';
import type { Attempt, Json, PlanProposal, TaskSpec, ToolExecution, ToolResult, ToolUsage, WorkState } from '../domain/model.js';
import { GoalSchema, ObligationSchema, PlanProposalSchema, ToolResultSchema, parseContract } from './contracts.js';
import { transact } from './work-transactions.js';
import { validateEvidence } from './evidence-intake.js';
import { applyValidatedPlan, asJson, taskDigest, validatePlan } from './plan-validator.js';
import type { RuntimeServices } from './services.js';
import type { ToolContracts } from './tool-contracts.js';
import type { Tool } from './ports.js';
import { BrokerError, ToolBroker } from './tool-broker.js';
import { deliveryObligationId } from '../domain/conversation.js';
import { artifactBlocked, dataGeneration } from '../domain/data-lifecycle.js';
import { knowledgeInputsCurrent, refreshKnowledge } from './knowledge-state.js';
import { retainedKnowledgeDependencies, uniqueKnowledgeDependencies } from './knowledge-validity.js';
import { retainedInputDependencies, uniqueInputDependencies } from './input-validity.js';
import { ToolResultReuse } from './tool-result-reuse.js';
import { WorkResources } from './work-resources.js';
import { mergeToolExecution, toolExecution } from './tool-execution-usage.js';
import { ReadCheckpoints } from './read-checkpoints.js';
import type { ReadCollections } from './read-collections.js';
import { inspectReadConnectionControl } from './read-connection-control.js';
import { ReadReconciliation } from './read-reconciliation.js';
import { StoredToolResults, type StoredToolResultTicket } from './stored-tool-results.js';
import { StoredToolUsages } from './stored-tool-usage.js';
import { StoredReadUsages } from './stored-read-usage.js';
import { recordedStoredUsageAttempts } from './stored-usage-records.js';
import { assertReadWaitReady, validateReadWaits } from './read-waits.js';
import { executionControl } from '../domain/execution-policy.js';
import { visibleReadProgress } from '../domain/context.js';
import { prepareExecutionBoundary, requestExecutionMode } from './execution-control.js';
import { assertBudgetAuthority, BudgetDelegationService, cancelBudgetReservations } from './budget-delegation.js';
import { budgetAllocationError } from '../domain/budget-delegation.js';
import { refreshEffectProofs } from './effect-proofs.js';
import { controlProofsCurrent as effectProofsCurrent } from './control-proofs.js';
import type { AppliedSessionInput } from '../domain/session.js';
import { AppliedSessionInputSchema } from './session-contracts.js';
import { SessionInputBasisSchema } from './session-base-contracts.js';
import { sessionInputsCurrent } from './session-context.js';

export const UserCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('mode'), mode: z.enum(['auto', 'fast', 'deep']), reason: z.string().min(1).max(10000), expectedControlRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }),
  z.strictObject({ kind: z.enum(['pause', 'resume', 'cancel']), reason: z.string().min(1).max(10000) }),
  z.strictObject({ kind: z.literal('goal'), goal: GoalSchema, expectedControlRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expectedSessionInput: SessionInputBasisSchema.optional(), expectedPolicyDigest: z.string().regex(/^[0-9a-f]{64}$/).optional() }),
  z.strictObject({ kind: z.literal('wait'), obligation: ObligationSchema }),
  z.strictObject({ kind: z.literal('resolve'), obligationId: z.string().min(1), reason: z.string().min(1).max(10000) }),
  z.strictObject({ kind: z.literal('input'), reason: z.string().min(1).max(10000) }),
]);
export type UserCommand = z.infer<typeof UserCommandSchema>;
type Actor = { tenantId: string; principalId: string };
type Change = { state: WorkState; committed: boolean };

export class ExecutionRuntime {
  readonly budgets: BudgetDelegationService;
  readonly resultReuse: ToolResultReuse;
  readonly readCheckpoints: ReadCheckpoints;
  readonly readReconciliation: ReadReconciliation;
  private readonly storedResults: StoredToolResults;
  private readonly storedUsages: StoredToolUsages;
  private readonly storedReadUsages: StoredReadUsages;
  #restoring = new Map<string, Promise<WorkState>>();
  #signals = new Map<string, { workId: string; controller: AbortController }>();
  #pending = new Map<string, Promise<{ error: string | null }>>();
  #backgroundFailures = new Map<string, string>();
  #closing = false;
  #custodyOpen = true;
  constructor(readonly services: RuntimeServices, readonly tools: ToolContracts, readonly owner: string, readonly leaseMs = 30000,
    resultReuse?: ToolResultReuse, readonly readCollections?: ReadCollections) {
    if (!owner || !Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new Error('invalid_executor_configuration');
    if (resultReuse && (resultReuse.services !== services || resultReuse.tools !== tools)) throw new Error('reuse_runtime_mismatch');
    if (readCollections && (readCollections.services !== services || readCollections.contracts !== tools || readCollections.owner !== owner))
      throw new Error('read_collection_runtime_mismatch');
    this.resultReuse = resultReuse ?? new ToolResultReuse(services, tools, new WorkResources(services.state, services.artifacts, tools, services.digester, services.knowledge, undefined,
      { current: state => effectProofsCurrent(services, state) }, services.inputs));
    this.readCheckpoints = readCollections?.checkpoints ?? new ReadCheckpoints(services, tools);
    this.readReconciliation = new ReadReconciliation(services, tools);
    this.storedResults = new StoredToolResults(services, tools);
    this.storedUsages = new StoredToolUsages(services, tools);
    this.storedReadUsages = new StoredReadUsages(services, tools);
    this.budgets = new BudgetDelegationService(services, id => this.interrupt(id));
  }
  async state(workId: string) {
    const state = await this.services.state.get(workId);
    if (!state) throw new Error('work_not_found');
    return state;
  }
  control(state: WorkState): Control {
    return decideExecution(state, this.services.clock.now(), this.services.digester, task => this.executionError(state, task));
  }
  inspectedControl(state: WorkState): Promise<Control> {
    return inspectReadConnectionControl(this.services, this.tools, state, this.control(state));
  }
  private executionError(state: WorkState, task: TaskSpec): string | null {
    const error = this.tools.checkExecution(task, state.policy);
    return error === 'tool_connection_required' && this.readCollections?.isCompleteResumeCandidate(state, task) ? null : error;
  }
  private requireCallable(state: WorkState, task: TaskSpec): void {
    const error = this.executionError(state, task); if (error) throw new Error(error);
  }
  hasStoredResultCandidate(state: WorkState): boolean {
    return state.attempts.some(attempt => this.storedResults.candidate(state, attempt.id));
  }
  registerCancellation(workId: string, operationId: string, controller: AbortController): () => void {
    if (this.#signals.has(operationId)) throw new Error('operation_signal_registered');
    this.#signals.set(operationId, { workId, controller });
    return () => { if (this.#signals.get(operationId)?.controller === controller) this.#signals.delete(operationId); };
  }
  interrupt(workId: string): void { for (const value of this.#signals.values()) if (value.workId === workId) value.controller.abort(); }
  beginClose(): void {
    this.#closing = true;
    for (const value of this.#signals.values()) value.controller.abort();
  }
  /** Bound the local response finish after transports stop; never keep a publication permit alive past the deadline. */
  async finishClose(timeoutMs = 5000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('invalid_executor_close_limit');
    this.beginClose();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = Promise.all([...this.#pending.values()]);
      const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('executor_close_unconfirmed')), timeoutMs); });
      const results = await Promise.race([pending, expired]);
      if (results.some(result => result.error)) throw new Error('result_persistence_failed');
    } finally {
      if (timer) clearTimeout(timer);
      this.#custodyOpen = false;
    }
  }
  private async change(workId: string, commandId: string, data: Json, type: string, edit: (state: WorkState) => void, beforeCommit?: () => Promise<void>): Promise<Change> {
    return transact(this.services, workId, commandId, type, data, edit, beforeCommit);
  }
  private attempt(state: WorkState, id: string) {
    const attempt = state.attempts.find(a => a.id === id);
    if (!attempt) throw new Error('attempt_not_found');
    return attempt;
  }
  private effectObligation(state: WorkState, attempt: Attempt) {
    const id = `effect:${attempt.id}`;
    const existing = state.obligations.find(o => o.id === id);
    if (existing) existing.status = 'pending';
    else state.obligations.push({ id, kind: 'effect_reconciliation', reason: 'dispatched_effect_requires_reconciliation', status: 'pending', wakeKey: null, dueAt: null });
  }
  private currentTask(state: WorkState, attempt: Attempt): TaskSpec | undefined {
    const task = state.plan?.tasks.find(t => t.id === attempt.taskId);
    return task && attempt.goalRevision === state.goal.revision && attempt.scope === state.goal.scope &&
      taskDigest(task, this.services.digester) === attempt.inputDigest ? task : undefined;
  }
  async submitPlan(workId: string, commandId: string, proposal: PlanProposal) {
    proposal = parseContract(PlanProposalSchema, proposal);
    if (!this.services.continuations && proposal.tasks.some(task => task.computerResume)) throw new Error('computer_continuation_not_supported');
    await refreshKnowledge(this.services, workId, id => this.interrupt(id));
    await refreshEffectProofs(this.services, workId);
    await this.budgets.prepare(workId);
    const historicalTasks = (await this.services.state.events(workId, 0)).filter(e => ['plan_accepted', 'model_plan_accepted'].includes(e.type))
      .flatMap(e => parseContract(PlanProposalSchema, e.data['payload']).tasks);
    return (await this.change(workId, commandId, asJson(proposal), 'plan_accepted', state => {
      if (['cancelled', 'paused', 'failed', 'completed'].includes(state.status)) throw new Error('work_not_plannable');
      if (state.attempts.some(a => ['reserved', 'running', 'received'].includes(a.status))) throw new Error('attempt_pending');
      if (state.obligations.some(o => o.kind === 'effect_reconciliation' && o.status === 'pending')) throw new Error('effect_unknown');
      if (this.services.clock.now() >= state.deadlineAt) throw new Error('deadline_exceeded');
      const valid = validatePlan(proposal, state, this.tools, this.services.digester, historicalTasks);
      applyValidatedPlan(state, valid, this.services.digester);
    }, async () => {
      const current = await this.state(workId); await assertBudgetAuthority(this.services, current, current.plan ? { replans: 1 } : {}, { kind: 'plan', tasks: proposal.tasks });
      if (!(await effectProofsCurrent(this.services, current))) throw new Error('effect_proof_unavailable');
    })).state;
  }
  async command(workId: string, commandId: string, actor: Actor, expectedGoalRevision: number, input: UserCommand, sessionInput?: AppliedSessionInput) {
    const command = parseContract(UserCommandSchema, input);
    if (sessionInput) sessionInput = AppliedSessionInputSchema.parse(sessionInput);
    if (command.kind === 'input' && !sessionInput) throw new Error('session_input_required');
    const authorized = (state: WorkState) => {
      if (actor.tenantId !== state.policy.tenantId || actor.principalId !== state.policy.principalId) throw new Error('actor_not_authorized');
    };
    authorized(await this.state(workId));
    const result = await this.change(workId, commandId, asJson({ actor, expectedGoalRevision, command, ...(sessionInput ? { sessionInput } : {}) }), 'user_command', state => {
      authorized(state);
      if (command.kind === 'goal') {
        // Check the edited basis inside each CAS attempt, before replacing it with this command's input.
        if (command.expectedSessionInput && (!sessionInput || this.services.digester.digest(asJson(state.conversation?.session?.input ?? null)) !==
          this.services.digester.digest(asJson(command.expectedSessionInput)))) throw new Error('stale_session_input');
        if (command.expectedPolicyDigest && command.expectedPolicyDigest !== this.services.digester.digest(asJson(state.policy))) throw new Error('stale_work_policy');
      }
      if (sessionInput) {
        if (!state.conversation?.session || this.services.digester.digest(asJson(state.conversation.session.scope)) !== this.services.digester.digest(asJson(sessionInput.scope)) ||
          state.conversation.session.input.sequence >= sessionInput.input.sequence) throw new Error('session_input_order_conflict');
        state.conversation.session = sessionInput;
      }
      if (expectedGoalRevision !== state.goal.revision) throw new Error('stale_user_command');
      if (state.status === 'cancelled' || state.status === 'failed') throw new Error('work_terminal');
      if (command.kind === 'input') {
        if (state.status === 'completed') throw new Error('work_terminal');
        state.conversation!.sessionReviewRequired = true; state.conversation!.result = null;
        state.status = 'ready'; state.statusReason = 'session_input_applied';
      } else if (command.kind === 'mode') {
        requestExecutionMode(state, command.mode, command.reason, command.expectedControlRevision);
      } else if (command.kind === 'goal') {
        const control = executionControl(state);
        if (command.expectedControlRevision !== control.revision) throw new Error('stale_execution_control');
        if (command.goal.revision !== state.goal.revision + 1 || new Set(command.goal.criteria.map(c => c.id)).size !== command.goal.criteria.length) throw new Error('invalid_goal_revision_or_criteria');
        if (state.goal.scope !== command.goal.scope) { state.hypotheses = []; state.hypothesisAssessment = null; }
        if (state.goal.responseRequirement) for (const obligation of state.obligations) {
          if (obligation.kind !== 'response' || obligation.status !== 'pending' || obligation.source || !obligation.id.startsWith('agent-question:')) continue;
          const call = state.modelCalls.find(item => `agent-question:${item.id}` === obligation.id);
          if (call?.purpose === 'agent_turn' && call.status === 'accepted' && call.reason === 'agent_question_stored' &&
            call.goalRevision === state.goal.revision && obligation.wakeKey === obligation.id) {
            obligation.status = 'waived'; obligation.reason = 'agent_question_superseded_by_goal_change';
          }
        }
        state.goal = command.goal; state.status = 'ready'; state.statusReason = 'goal_changed';
        state.executionControl = { ...control, revision: control.revision + 1, requestedMode: command.goal.mode, strategy: command.goal.mode === 'deep' ? 'investigate' : 'direct', pending: null, lastReason: 'goal_changed' };
        if (state.progress) { state.progress.goalRevision = state.goal.revision; state.progress.consecutiveUnproductive = 0; }
        state.retryWakeAt = null;
        if (state.conversation) {
          state.conversation.result = null;
          if (command.goal.responseRequirement) state.conversation.sessionReviewRequired = true;
          for (const o of state.obligations) if (o.kind === 'delivery' && o.status === 'pending') o.status = 'waived';
          if (state.conversation.completionRequiresDelivery) state.obligations.push({ id: deliveryObligationId(state.goal.revision), kind: 'delivery', reason: 'result_delivery_required', status: 'pending', wakeKey: deliveryObligationId(state.goal.revision), dueAt: state.deadlineAt });
        }
      } else if (command.kind === 'wait') {
        if (command.obligation.source || command.obligation.mode || command.obligation.resumeToolIds || ['effect_reconciliation', 'delivery', 'budget_reconciliation'].includes(command.obligation.kind) || command.obligation.status !== 'pending' || state.obligations.some(o => o.id === command.obligation.id)) throw new Error('invalid_wait_obligation');
        state.obligations.push(command.obligation); state.status = 'waiting'; state.statusReason = 'pending_obligation';
      } else if (command.kind === 'resolve') {
        const obligation = state.obligations.find(o => o.id === command.obligationId);
        if (!obligation || obligation.source || obligation.status !== 'pending' || ['effect_reconciliation', 'delivery', 'budget_reconciliation'].includes(obligation.kind)) throw new Error('obligation_not_resolvable');
        obligation.status = 'satisfied'; state.status = 'ready'; state.statusReason = 'obligation_resolved';
        captureProgress(state, this.services.digester, `resolve:${commandId}`, this.services.clock.now());
      } else {
        if (command.kind === 'resume' && !['paused', 'blocked', 'waiting'].includes(state.status)) throw new Error('work_not_resumable');
        state.status = command.kind === 'pause' ? 'paused' : command.kind === 'cancel' ? 'cancelled' : 'ready'; state.statusReason = command.reason;
      }
      if (command.kind === 'cancel' || command.kind === 'pause' || command.kind === 'goal' || command.kind === 'input') {
        state.retryWakeAt = null;
        if (command.kind === 'cancel' && state.executionControl) state.executionControl.pending = null;
        for (const call of state.modelCalls) if (call.status === 'reserved') {
          call.status = 'cancelled'; call.usageStatus = 'not_called'; call.finishedAt = this.services.clock.now(); call.reason = 'reservation_cancelled';
          state.budget.reservedModelCalls--; state.budget.reservedTokens -= call.tokenReservation;
        }
        for (const call of state.modelCalls) if (call.status === 'running') { call.expired = true; call.reason = 'user_control_changed'; }
        if (command.kind === 'cancel') for (const obligation of state.obligations) if (obligation.kind === 'delivery' && obligation.status === 'pending') obligation.status = 'waived';
        if (command.kind === 'cancel' || command.kind === 'goal') {
          for (const subscription of state.subscriptions ?? []) subscription.status = 'closed';
          if (state.notifications) state.notifications = [];
        }
        for (const a of state.attempts) {
          if (a.status === 'reserved') { a.status = 'cancelled'; a.finishedAt = this.services.clock.now(); a.error = { code: 'reservation_cancelled', retryable: true }; state.budget.reservedToolCalls--; }
          if (a.effect === 'write' && a.status === 'running') this.effectObligation(state, a);
        }
        for (const record of state.computerReconciliations ?? []) if (['reserved', 'running', 'received'].includes(record.status)) {
          if (record.status === 'reserved') state.budget.reservedToolCalls--;
          record.status = 'failed'; record.finishedAt ??= this.services.clock.now(); record.reason = 'user_control_changed';
        }
      }
    });
    if (result.committed && (command.kind === 'cancel' || command.kind === 'pause' || command.kind === 'goal' || command.kind === 'input')) {
      for (const value of this.#signals.values()) if (value.workId === workId) value.controller.abort();
    }
    if ((command.kind === 'cancel' || command.kind === 'goal') && result.state.budgetGrants?.some(g => g.status !== 'settled')) return this.budgets.refresh(workId);
    return result.state;
  }
  async reserve(workId: string, taskId: string): Promise<Attempt> {
    if (this.services.executionAuthority) assertExecutionAuthority(this.services, await this.state(workId));
    if (!(await sessionInputsCurrent(this.services, await this.state(workId)))) throw new Error('session_input_pending');
    await refreshKnowledge(this.services, workId, id => this.interrupt(id));
    await prepareExecutionBoundary(this.services, workId);
    await this.budgets.prepare(workId);
    const id = this.services.ids.next('attempt');
    const prepared = await this.state(workId); const selected = prepared.plan?.tasks.find(task => task.id === taskId);
    const local = selected && this.readCollections?.isCompleteResumeCandidate(prepared, selected, id);
    const localEntry = local ? this.tools.get(selected!.toolId, selected!.toolVersion) : null;
    if (selected) this.requireCallable(prepared, selected);
    if (selected) {
      if (local) await this.readCollections!.assertCompleteResume(prepared, selected, id);
      else await assertReadWaitReady(this.services, this.tools, prepared, selected);
    }
    if (selected?.computerResume && !this.services.continuations) throw new Error('computer_continuation_not_supported');
    const claim = selected?.computerResume ? await this.services.continuations!.prepare(prepared, selected, id) : null;
    const result = await this.change(workId, `reserve:${id}`, { taskId, id, owner: this.owner }, 'attempt_reserved', state => {
      assertExecutionAuthority(this.services, state);
      const budget = budgetAllocationError(state, { toolCalls: 1 }); if (budget) throw new Error(budget);
      const control = this.control(state);
      if (control.kind !== 'continue' || control.action !== 'reserve' || control.id !== taskId) throw new Error('task_not_ready');
      const task = state.plan!.tasks.find(t => t.id === taskId)!;
      if (local && (state.revision !== prepared.revision || this.tools.get(task.toolId, task.toolVersion) !== localEntry))
        throw new Error('read_state_changed');
      if (task.computerResume && !this.services.continuations) throw new Error('computer_continuation_not_supported');
      if (claim) {
        if (state.revision !== prepared.revision || !selected || taskDigest(task, this.services.digester) !== claim.successorTaskDigest) throw new Error('computer_continuation_state_changed');
        state.computerContinuations = [...(state.computerContinuations ?? []), claim];
      }
      this.requireCallable(state, task);
      state.attempts.push({ id, taskId, planRevision: state.plan!.revision, goalRevision: state.goal.revision,
        toolId: task.toolId, toolVersion: task.toolVersion, inputDigest: taskDigest(task, this.services.digester), scope: state.goal.scope,
        contractDigest: this.services.digester.digest(asJson(this.tools.get(task.toolId, task.toolVersion)!.tool.definition)),
        execution: toolExecution('not_invoked'),
        effect: task.effect, effectState: 'none', status: 'reserved', owner: this.owner,
        leaseUntil: Math.min(state.deadlineAt, this.services.clock.now() + this.leaseMs), startedAt: claim?.createdAt ?? this.services.clock.now(), finishedAt: null,
        resultId: null, resultArtifact: null, adopted: false, error: null });
      state.budget.reservedToolCalls++; state.status = 'running'; state.statusReason = 'attempt_reserved'; state.retryWakeAt = null;
    }, async () => {
      const current = await this.state(workId);
      const selected = current.plan?.tasks.find(task => task.id === taskId);
      await assertBudgetAuthority(this.services, current, { toolCalls: 1 }, selected ? { kind: 'tool', task: selected } : { kind: 'general' });
      if (selected) {
        if (local) {
          if (current.revision !== prepared.revision || this.tools.get(selected.toolId, selected.toolVersion) !== localEntry) throw new Error('read_state_changed');
        } else await assertReadWaitReady(this.services, this.tools, current, selected);
      }
      if (!(await effectProofsCurrent(this.services, current))) throw new Error('effect_proof_unavailable');
      if (claim && selected) {
        if (current.revision !== prepared.revision) throw new Error('computer_continuation_state_changed');
        const checked = await this.services.continuations!.prepare(current, selected, id);
        if (this.services.digester.digest(asJson({ ...checked, createdAt: claim.createdAt })) !== this.services.digester.digest(asJson(claim))) throw new Error('computer_continuation_changed');
      }
      if (this.services.executionAuthority) assertExecutionAuthority(this.services, await this.state(workId));
      if (local && selected) {
        await this.readCollections!.assertCompleteResume(current, selected, id);
        if (this.tools.get(selected.toolId, selected.toolVersion) !== localEntry) throw new Error('read_contract_changed');
        assertExecutionAuthority(this.services, current);
      }
      if (selected) this.requireCallable(current, selected);
    });
    return this.attempt(result.state, id);
  }
  async dispatch(workId: string, attemptId: string): Promise<boolean> {
    if (this.services.executionAuthority) assertExecutionAuthority(this.services, await this.state(workId));
    await refreshKnowledge(this.services, workId, id => this.interrupt(id));
    await refreshEffectProofs(this.services, workId);
    await this.budgets.prepare(workId);
    const prepared = await this.state(workId), pending = this.attempt(prepared, attemptId), selected = this.currentTask(prepared, pending);
    const local = selected && this.readCollections?.isCompleteResumeCandidate(prepared, selected, attemptId);
    const localEntry = local ? this.tools.get(selected!.toolId, selected!.toolVersion) : null;
    if (pending.status === 'reserved' && selected) this.requireCallable(prepared, selected);
    const result = await this.change(workId, `dispatch:${attemptId}`, { attemptId, owner: this.owner }, 'attempt_dispatched', state => {
      assertExecutionAuthority(this.services, state);
      const a = this.attempt(state, attemptId); const task = this.currentTask(state, a);
      const budget = budgetAllocationError(state); if (budget) throw new Error(budget);
      if (a.status !== 'reserved' || a.owner !== this.owner || !task || ['cancelled', 'paused', 'failed'].includes(state.status)) throw new Error('attempt_not_dispatchable');
      if (task.computerResume && !this.services.continuations) throw new Error('computer_continuation_not_supported');
      if (this.services.clock.now() >= Math.min(a.leaseUntil, state.deadlineAt)) throw new Error('attempt_expired');
      if (local && (state.revision !== prepared.revision || this.tools.get(task.toolId, task.toolVersion) !== localEntry))
        throw new Error('read_state_changed');
      this.requireCallable(state, task);
      if (a.contractDigest && a.contractDigest !== this.services.digester.digest(asJson(this.tools.get(task.toolId, task.toolVersion)!.tool.definition))) throw new Error('tool_contract_changed');
      a.status = 'running'; a.effectState = a.effect === 'write' ? 'unknown' : 'none';
      a.execution = toolExecution('unreported');
      state.budget.reservedToolCalls--; state.budget.used.toolCalls++;
      state.status = 'running'; state.statusReason = 'attempt_running';
    }, async () => {
      const current = await this.state(workId);
      if (!(await sessionInputsCurrent(this.services, current))) throw new Error('session_input_pending');
      const attempt = this.attempt(current, attemptId); const task = this.currentTask(current, attempt);
      await assertBudgetAuthority(this.services, current, {}, task ? { kind: 'tool', task, attemptId } : { kind: 'general' });
      if (task) {
        if (local) {
          if (current.revision !== prepared.revision || this.tools.get(task.toolId, task.toolVersion) !== localEntry) throw new Error('read_state_changed');
        } else await assertReadWaitReady(this.services, this.tools, current, task);
      }
      if (task?.computerResume) await this.services.continuations!.resolve(current, attemptId);
      if (this.services.executionAuthority) assertExecutionAuthority(this.services, await this.state(workId));
      if (local && task) {
        await this.readCollections!.assertCompleteResume(current, task, attemptId);
        if (this.tools.get(task.toolId, task.toolVersion) !== localEntry) throw new Error('read_contract_changed');
        assertExecutionAuthority(this.services, current);
      }
      if (task) this.requireCallable(current, task);
    });
    return result.committed;
  }
  private failure(attempt: Attempt, code: string): ToolResult {
    return { resultId: `${attempt.id}:failure`, attemptId: attempt.id, status: 'error', effectState: attempt.effect === 'write' ? 'unknown' : 'none',
      evidence: [], artifacts: [], output: null, error: { code, retryable: attempt.effect === 'read' && code === 'tool_execution_failed' }, cursor: null, coverage: 'unknown' };
  }
  async execute(workId: string, attemptId: string): Promise<void> {
    if (this.#closing) throw new Error('executor_closed');
    if (!(await this.dispatch(workId, attemptId))) return;
    const state = await this.state(workId); const attempt = this.attempt(state, attemptId); const task = this.currentTask(state, attempt);
    const controller = new AbortController(); this.#signals.set(attemptId, { workId, controller });
    const authoritySignal = this.services.executionAuthority?.signal;
    const revoke = () => controller.abort();
    authoritySignal?.addEventListener('abort', revoke, { once: true });
    if (authoritySignal?.aborted) revoke();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop: (() => void) | undefined;
    try {
      if (!task || ['cancelled', 'paused', 'failed'].includes(state.status) || this.services.clock.now() >= Math.min(attempt.leaseUntil, state.deadlineAt)) {
        await this.receive(workId, attemptId, this.failure(attempt, 'dispatch_interrupted'), 'not_invoked'); return;
      }
      if (this.#closing) throw new Error('executor_closed');
      const broker = new ToolBroker(this.services.state, this.tools, this.services.digester, this.services.clock, async state =>
        !this.#closing && await knowledgeInputsCurrent(this.services, state) && await sessionInputsCurrent(this.services, state), this.services.effects, this.services.continuations, this.services, this.readCollections);
      const finished = (async () => {
        let result: unknown; let mode: ToolExecution['mode'] = 'not_invoked'; let invocationFailed = false;
        try { result = await broker.invoke(workId, attemptId, this.owner, controller.signal, {
          reuse: (state, task, attempt) => this.resultReuse.find(state, task, attempt),
          entered: () => { mode = 'invoked'; }, reused: () => { mode = 'reused'; },
          custodyCurrent: () => this.#custodyOpen,
        }); }
        catch (error) { invocationFailed = true; result = this.failure(attempt, error instanceof BrokerError ? error.code : 'tool_execution_failed'); }
        try {
          if (invocationFailed) {
            const accounted = await this.recordStoredUsage(workId, attemptId);
            const original = accounted?.attempts.find(value => value.id === attemptId);
            if (original && (original.resultArtifact || !['running', 'failed', 'unknown'].includes(original.status))) return { error: null };
          }
          await this.receive(workId, attemptId, result, mode);
          // Receiving closes a collection's request set. A failed page may still have an authenticated raw receipt.
          if (this.tools.get(attempt.toolId, attempt.toolVersion)?.tool.restoreReadUsage) {
            const receivedState = await this.state(workId);
            if (this.storedReadUsages.candidate(receivedState, attemptId) && (invocationFailed ||
              Object.values(this.attempt(receivedState, attemptId).execution?.usage ?? {}).some(value => value === null)))
              await this.recordStoredUsage(workId, attemptId);
          }
          return { error: null };
        }
        catch { this.#backgroundFailures.set(attemptId, 'result_persistence_failed'); return { error: 'result_persistence_failed' }; }
        finally { this.#signals.delete(attemptId); this.#pending.delete(attemptId); }
      })();
      this.#pending.set(attemptId, finished);
      const interrupted = new Promise<{ error: null }>(resolve => {
        stop = () => resolve({ error: null });
        controller.signal.addEventListener('abort', stop, { once: true });
        if (controller.signal.aborted) stop();
      });
      const duration = Math.max(1, Math.min(2147483647, attempt.leaseUntil - this.services.clock.now(), state.deadlineAt - this.services.clock.now()));
      timer = setTimeout(() => controller.abort(), duration);
      const outcome = await Promise.race([finished, interrupted]);
      if (outcome.error) throw new Error(outcome.error);
    } finally {
      authoritySignal?.removeEventListener('abort', revoke);
      if (timer) clearTimeout(timer);
      if (stop) controller.signal.removeEventListener('abort', stop);
      if (!this.#pending.has(attemptId)) this.#signals.delete(attemptId);
    }
  }
  pendingExecutions() { return [...this.#pending.keys()]; }
  backgroundFailures() { return [...this.#backgroundFailures].map(([attemptId, code]) => ({ attemptId, code })); }
  async settlePending(attemptId: string) {
    const outcome = await this.#pending.get(attemptId);
    if (outcome?.error || this.#backgroundFailures.has(attemptId)) throw new Error('result_persistence_failed');
  }
  /** Host-only accounting for a dispatched call. Does not return the raw body or change execution/adoption state. */
  async recordStoredUsage(workId: string, attemptId: string, authorize?: (state: WorkState) => void): Promise<WorkState | null> {
    for (let retry = 0; retry < 8; retry++) {
      if (!this.#custodyOpen) throw new Error('executor_closed');
      const state = await this.state(workId);
      authorize?.(state);
      const collection = this.storedReadUsages.candidate(state, attemptId);
      if (!collection && !this.storedUsages.candidate(state, attemptId)) return null;
      try {
        const inspection = collection ? await this.storedReadUsages.inspectCustody(state, attemptId) : null;
        const ticket = collection ? inspection && await this.storedReadUsages.prepareUsage(state, inspection) :
          await this.storedUsages.prepare(state, attemptId);
        authorize?.(state);
        if (!ticket) return null;
        const attempt = this.attempt(state, attemptId), reported = toolExecution('invoked', ticket.usage);
        const merged = mergeToolExecution(attempt.execution, reported);
        if (this.services.digester.digest(asJson(merged)) === this.services.digester.digest(asJson(attempt.execution ?? null))) return state;
        const source = 'receipt' in ticket ? this.services.digester.digest(asJson({ receipt: ticket.receipt, usage: ticket.usage })) :
          ticket.sourceDigest;
        return (await this.change(workId, `tool-usage:${attemptId}:${source}`, { attemptId, source }, 'tool_execution_usage_recorded', next => {
          authorize?.(next);
          if (next.revision !== state.revision) throw new Error('stored_usage_changed');
          this.attempt(next, attemptId).execution = mergeToolExecution(this.attempt(next, attemptId).execution, reported);
        }, async () => {
          const latest = await this.state(workId); authorize?.(latest);
          if ('receipt' in ticket) await this.storedUsages.assertCurrent(latest, ticket);
          else await this.storedReadUsages.assertCurrent(latest, ticket);
          authorize?.(await this.state(workId));
          if (!this.#custodyOpen) throw new Error('executor_closed');
        })).state;
      } catch (error) {
        if (!(error instanceof Error && ['stored_usage_changed', 'stored_usage_ticket_invalid',
          'stored_read_usage_changed', 'stored_read_usage_ticket_invalid'].includes(error.message))) throw error;
      }
    }
    throw new Error('stored_usage_contention');
  }
  /** One finite host pass over the original candidate IDs; it neither sends tools nor follows newly added attempts. */
  async reconcileStoredUsages(workId: string, authorize: (state: WorkState) => void) {
    if (!this.#custodyOpen) throw new Error('executor_closed');
    let selection: { entry: WorkState; candidates: string[]; recorded: Set<string> } | undefined;
    for (let retry = 0; retry < 8; retry++) {
      const entry = await this.state(workId); authorize(entry);
      const plain = entry.attempts.filter(attempt => this.storedUsages.candidate(entry, attempt.id)).map(attempt => attempt.id);
      const plainIds = new Set(plain);
      const candidates = entry.attempts.filter(attempt => plainIds.has(attempt.id) || this.storedReadUsages.candidate(entry, attempt.id)).map(attempt => attempt.id);
      // Collection receipts can arrive without changing the attempt head or its prior usage record.
      try { selection = { entry, candidates, recorded: await recordedStoredUsageAttempts(this.services, entry, plain) }; break; }
      catch (error) { if (!(error instanceof Error && error.message === 'stored_usage_changed')) throw error; }
    }
    if (!selection) throw new Error('stored_usage_contention');
    const { entry, candidates, recorded: alreadyRecorded } = selection;
    const originalAttempts = new Map(entry.attempts.map(attempt => [attempt.id, this.services.digester.digest(asJson(attempt))]));
    const changed: string[] = [];
    let restored = 0, skipped = 0;
    for (const attemptId of candidates) {
      const before = await this.state(workId); authorize(before);
      const selected = before.attempts.find(attempt => attempt.id === attemptId), previous = selected?.execution;
      if (selected && alreadyRecorded.has(attemptId) && this.services.digester.digest(asJson(selected)) === originalAttempts.get(attemptId)) {
        skipped++; continue;
      }
      restored++;
      const recorded = await this.recordStoredUsage(workId, attemptId, authorize);
      if (recorded && this.services.digester.digest(asJson(previous ?? null)) !==
          this.services.digester.digest(asJson(recorded.attempts.find(attempt => attempt.id === attemptId)?.execution ?? null))) changed.push(attemptId);
    }
    const current = await this.state(workId); authorize(current);
    if (!this.#custodyOpen) throw new Error('executor_closed');
    return { workId, inspected: candidates.length, restored, skipped, changed, stateRevision: current.revision };
  }
  async receive(workId: string, attemptId: string, value: unknown, executionMode: ToolExecution['mode'] = 'unreported') {
    for (let n = 0; n < 8; n++) {
      try { return await this.receiveOnce(workId, attemptId, value, executionMode); }
      catch (error) { if (!(error instanceof Error && error.message === 'result_lifecycle_changed')) throw error; }
    }
    throw new Error('result_receive_contention');
  }
  private async receiveOnce(workId: string, attemptId: string, value: unknown, executionMode: ToolExecution['mode'], restored?: StoredToolResultTicket) {
    if (!this.#custodyOpen) throw new Error('executor_closed');
    const current = await this.state(workId); const attempt = this.attempt(current, attemptId);
    if (restored) {
      if (restored.workId !== workId || restored.attemptId !== attemptId) throw new Error('stored_result_identity');
      if (attempt.resultArtifact) return current;
      await this.storedResults.assertCurrent(current, restored);
    } else if (attempt.owner !== this.owner) throw new Error('result_owner_mismatch');
    if (attempt.effectReceipt?.origin === 'reconciliation') return current;
    if (current.computerReconciliations?.some(record => record.sourceAttemptId === attemptId) ||
      current.computerContinuations?.some(record => record.sourceAttemptId === attemptId)) return current;
    if (attempt.resultArtifact && artifactBlocked(current, attempt.resultArtifact)) return current;
    if (!attempt.resultArtifact && attempt.status !== 'running' && !(['failed', 'unknown'].includes(attempt.status) && attempt.error?.code === 'lease_expired')) throw new Error('result_not_expected');
    const dispatched = await this.services.state.receipt(workId, `dispatch:${attemptId}`);
    if (!dispatched) throw new Error('result_without_dispatch');
    let result: ToolResult; let validated = false; let customProofTool: Tool | undefined;
    let received: ToolResult | undefined; let labelsNarrowed = false; let retainedUsage: ToolUsage | undefined;
    try {
      result = parseContract(ToolResultSchema, value); received = result;
      const origin = dispatched.state.policy;
      if (dataGeneration(dispatched.state) !== dataGeneration(current)) throw new Error('result_lifecycle_changed');
      if (origin.tenantId !== current.policy.tenantId || origin.principalId !== current.policy.principalId) throw new Error('result_policy_changed');
      if (!origin.allowedLabels.every(l => current.policy.allowedLabels.includes(l))) { labelsNarrowed = true; throw new Error('result_policy_changed'); }
      if (result.reuse) {
        const task = this.currentTask(current, attempt);
        if (executionMode !== 'reused' || !task || !(await this.resultReuse.validate(current, task, attempt, result))) throw new Error('invalid_reuse_result');
      } else if (executionMode === 'reused') throw new Error('missing_reuse_result');
      const inherited = retainedKnowledgeDependencies(current);
      const dependencies = uniqueKnowledgeDependencies([...inherited, ...(result.knowledgeDependencies ?? [])]);
      if (dependencies.length > 50 || (dependencies.length && (!this.services.knowledge || !(await this.services.knowledge.validate(dependencies, workId, current.policy))))) throw new Error('knowledge_dependency_changed');
      if (dependencies.length) result.knowledgeDependencies = dependencies;
      const inputs = uniqueInputDependencies([...retainedInputDependencies(current), ...(result.inputDependencies ?? [])]);
      if (inputs.length > 50 || (inputs.length && (!this.services.inputs || !(await this.services.inputs.validate(inputs, current))))) throw new Error('input_dependency_changed');
      if (inputs.length) result.inputDependencies = inputs;
      validateEvidence(result, attempt, current, this.services.digester);
      const entry = this.tools.get(attempt.toolId, attempt.toolVersion);
      if (!entry || ((result.status === 'success' || result.status === 'partial') && !entry.output(result.output))) throw new Error('invalid_tool_output');
      if (result.effectReceipt && (attempt.effect !== 'write' || !entry.tool.validateResult || !this.services.effects || result.effectReceipt.origin !== 'execution')) throw new Error('invalid_effect_receipt');
      if (attempt.contractDigest && attempt.contractDigest !== this.services.digester.digest(asJson(entry.tool.definition))) throw new Error('tool_contract_changed');
      for (const ref of [...result.artifacts, ...result.evidence.flatMap(e => e.artifact ? [e.artifact] : [])]) if (!(await this.services.artifacts.exists(ref))) throw new Error('artifact_unavailable');
      if (!(await this.readCheckpoints.validateResult(current, result))) throw new Error('invalid_collection_result');
      if (!(await this.tools.validateResult(current, result))) throw new Error('invalid_tool_proof');
      if (entry.tool.validateResult) customProofTool = entry.tool;
      validated = true;
    } catch {
      result = this.failure(attempt, 'invalid_tool_result');
      // A narrower current label policy rejects the body, not a valid measurement
      // from this dispatched invocation. Invalid envelopes and reused results add no trust.
      if (labelsNarrowed && received?.usage && executionMode === 'invoked' && !received.reuse) {
        try {
          const sent = dispatched.state.attempts.find(value => value.id === attemptId);
          const entry = this.tools.get(attempt.toolId, attempt.toolVersion);
          if (!sent || sent.status !== 'running' || sent.owner !== this.owner || sent.toolId !== attempt.toolId || sent.toolVersion !== attempt.toolVersion ||
            sent.inputDigest !== attempt.inputDigest || sent.scope !== attempt.scope || sent.effect !== attempt.effect ||
            sent.goalRevision !== attempt.goalRevision || sent.planRevision !== attempt.planRevision ||
            !entry || sent.contractDigest !== attempt.contractDigest ||
            attempt.contractDigest && attempt.contractDigest !== this.services.digester.digest(asJson(entry.tool.definition)) ||
            (received.status === 'success' || received.status === 'partial') && !entry.output(received.output)) throw new Error('result_usage_unattributed');
          validateEvidence(received, sent, dispatched.state, this.services.digester);
          retainedUsage = structuredClone(received.usage); result.usage = retainedUsage;
        } catch { /* An invalid original response cannot supply a trusted measurement. */ }
      }
    }
    if (restored && !validated) throw new Error('stored_result_validation_changed');
    const ref = await this.services.artifacts.put(new TextEncoder().encode(JSON.stringify(result)), {
      tenantId: dispatched.state.policy.tenantId, labels: validated ? [...dispatched.state.policy.allowedLabels] : [], mediaType: 'application/json',
    });
    if (validated && result.knowledgeDependencies?.length && !(await this.services.knowledge!.validate(result.knowledgeDependencies, workId, current.policy))) throw new Error('result_lifecycle_changed');
    if (validated && result.inputDependencies?.length && !(await this.services.inputs!.validate(result.inputDependencies, current))) throw new Error('result_lifecycle_changed');
    if (attempt.resultArtifact) {
      if (attempt.resultArtifact.id !== ref.id) throw new Error('result_identity_conflict');
      return current;
    }
    return (await this.change(workId, `receive:${attemptId}`, { attemptId, artifactId: ref.id }, 'result_received', state => {
      if (state.computerReconciliations?.some(record => record.sourceAttemptId === attemptId) ||
        state.computerContinuations?.some(record => record.sourceAttemptId === attemptId)) throw new Error('result_lifecycle_changed');
      if (dataGeneration(state) !== dataGeneration(current) || this.services.digester.digest(asJson(state.policy)) !== this.services.digester.digest(asJson(current.policy))) throw new Error('result_lifecycle_changed');
      const a = this.attempt(state, attemptId);
      if (restored && !this.storedResults.candidate(state, attemptId)) throw new Error('result_lifecycle_changed');
      if (a.effectReceipt?.origin === 'reconciliation') throw new Error('result_lifecycle_changed');
      if (a.resultArtifact) throw new Error('result_already_received');
      if (!['running', 'failed', 'unknown'].includes(a.status)) throw new Error('result_not_expected');
      const wasExpired = a.error?.code === 'lease_expired';
      a.resultArtifact = ref; a.resultId = result.resultId; a.status = 'received'; a.finishedAt = this.services.clock.now();
      a.effectState = result.effectState;
      if (validated && result.effectReceipt) a.effectReceipt = structuredClone(result.effectReceipt);
      a.execution = mergeToolExecution(a.execution, toolExecution(executionMode, validated ? result.usage : retainedUsage));
      if (result.reuse) a.reuse = structuredClone(result.reuse);
      if (restored) a.error = null;
      else if (wasExpired || this.services.clock.now() >= a.leaseUntil) a.error = { code: 'lease_expired', retryable: false };
      if (a.effect === 'write' && result.effectState === 'unknown') this.effectObligation(state, a);
      if (validated && a.effect === 'write' && result.effectState === 'none' && customProofTool) {
        const obligation = state.obligations.find(value => value.id === `effect:${a.id}` && value.kind === 'effect_reconciliation');
        if (obligation?.status === 'pending') obligation.status = 'satisfied';
      }
      if (!['cancelled', 'paused', 'failed', 'blocked', 'completed'].includes(state.status)) { state.status = 'ready'; state.statusReason = 'result_received'; }
    }, async () => {
      if (!this.#custodyOpen) throw new Error('executor_closed');
      if (restored) await this.storedResults.assertCurrent(await this.state(workId), restored);
      if (validated && result.inputDependencies?.length && !(await this.services.inputs!.validate(result.inputDependencies, await this.state(workId)))) throw new Error('result_lifecycle_changed');
      if (validated && result.collection && !(await this.readCheckpoints.validateResult(await this.state(workId), result))) throw new Error('result_lifecycle_changed');
      if (validated && customProofTool && (this.tools.get(attempt.toolId, attempt.toolVersion)?.tool !== customProofTool ||
        !(await this.tools.validateResult(await this.state(workId), result)))) throw new Error('result_lifecycle_changed');
      if (restored) {
        const latest = await this.state(workId);
        assertExecutionAuthority(this.services, latest);
        if (latest.revision !== current.revision) throw new Error('result_lifecycle_changed');
      }
      if (result.reuse && validated) {
        const latest = await this.state(workId); const consumer = this.attempt(latest, attemptId); const task = this.currentTask(latest, consumer);
        if (!task || !(await this.resultReuse.validate(latest, task, consumer, result))) throw new Error('result_lifecycle_changed');
      }
      if (!this.#custodyOpen) throw new Error('executor_closed');
    })).state;
  }
  async adopt(workId: string, attemptId: string) {
    for (let retry = 0; retry < 8; retry++) {
      try { return await this.adoptOnce(workId, attemptId); }
      catch (error) { if (!(error instanceof Error && error.message === 'reuse_adoption_changed')) throw error; }
    }
    throw new Error('reuse_adoption_contention');
  }
  private async adoptOnce(workId: string, attemptId: string) {
    const current = await this.state(workId); const attempt = this.attempt(current, attemptId);
    if (attempt.status !== 'received' || !attempt.resultArtifact) return current;
    if (!executionAuthorityCurrent(this.services, current) || artifactBlocked(current, attempt.resultArtifact) || attempt.resultArtifact.tenantId !== current.policy.tenantId || !attempt.resultArtifact.labels.every(l => current.policy.allowedLabels.includes(l))) {
      return (await this.change(workId, `adopt:${attemptId}`, { attemptId, rejection: 'result_permission_revoked' }, 'result_rejected', state => {
        const a = this.attempt(state, attemptId); if (a.status !== 'received') throw new Error('result_not_pending');
        a.status = a.effectState === 'unknown' ? 'unknown' : 'failed'; a.adopted = false; a.error = { code: 'result_permission_revoked', retryable: false };
        if (a.effect === 'write') this.effectObligation(state, a);
        if (!['cancelled', 'paused', 'failed', 'blocked', 'completed'].includes(state.status)) { state.status = 'ready'; state.statusReason = 'result_permission_revoked'; }
      })).state;
    }
    const result = parseContract(ToolResultSchema, JSON.parse(new TextDecoder().decode(await this.services.artifacts.get(attempt.resultArtifact, current.policy))));
    const dependenciesValid = !result.knowledgeDependencies?.length || Boolean(this.services.knowledge && await this.services.knowledge.validate(result.knowledgeDependencies, workId, current.policy));
    const inputsValid = !result.inputDependencies?.length || Boolean(this.services.inputs && await this.services.inputs.validate(result.inputDependencies, current));
    const currentTask = this.currentTask(current, attempt);
    const reuseValid = !result.reuse || Boolean(currentTask && await this.resultReuse.validate(current, currentTask, attempt, result));
    const collectionValid = await this.readCheckpoints.validateResult(current, result);
    const proofTool = this.tools.get(attempt.toolId, attempt.toolVersion)?.tool;
    const toolProofValid = await this.tools.validateResult(current, result);
    const provenNoEffect = toolProofValid && result.effectState === 'none' && Boolean(proofTool?.validateResult);
    let acceptedReuse = false;
    let acceptedCollection = false;
    let acceptedCustomProof = false;
    let accepted = false;
    await this.change(workId, `adopt:${attemptId}`, { attemptId, resultId: result.resultId }, 'result_settled', state => {
      const a = this.attempt(state, attemptId);
      if (a.status !== 'received') throw new Error('result_not_pending');
      const task = this.currentTask(state, a);
      let rejection: string | null = !toolProofValid ? 'tool_proof_unavailable' : !collectionValid ? 'read_checkpoint_unavailable' : !reuseValid ? 'reuse_source_changed' : !inputsValid ? 'input_dependency_changed' : !dependenciesValid ? 'knowledge_dependency_changed' : !task ? 'obsolete_result' : ['cancelled', 'paused', 'failed', 'blocked', 'completed'].includes(state.status) ? 'work_interrupted' :
        a.error?.code === 'lease_expired' ? 'lease_expired' : this.services.clock.now() >= state.deadlineAt ? 'result_after_deadline' : null;
      if (!rejection && (!executionAuthorityCurrent(this.services, state) || dataGeneration(state) !== dataGeneration(current) || artifactBlocked(state, attempt.resultArtifact!) ||
        this.services.digester.digest(asJson(state.policy)) !== this.services.digester.digest(asJson(current.policy)))) rejection = 'result_permission_revoked';
      if (!rejection && task) rejection = this.tools.check(task, state.policy);
      if (!rejection && a.contractDigest && a.contractDigest !== this.services.digester.digest(asJson(this.tools.get(a.toolId, a.toolVersion)!.tool.definition))) rejection = 'tool_contract_changed';
      if (!rejection) {
        try { validateEvidence(result, a, state, this.services.digester); } catch { rejection = 'invalid_evidence'; }
      }
      a.status = result.effectState === 'unknown' ? 'unknown' : result.status === 'success' ? 'succeeded' : result.status === 'error' ? 'failed' : result.status;
      a.adopted = !rejection && (result.status === 'success' || result.status === 'partial') && result.effectState !== 'unknown';
      accepted = a.adopted;
      acceptedReuse = a.adopted && Boolean(result.reuse);
      acceptedCollection = a.adopted && Boolean(result.collection);
      acceptedCustomProof = (a.adopted || provenNoEffect) && Boolean(proofTool?.validateResult);
      a.error = rejection ? { code: rejection, retryable: rejection === 'lease_expired' && a.effect === 'read' } : result.error;
      if (a.adopted) {
        if (result.knowledgeDependencies) a.knowledgeDependencies = structuredClone(result.knowledgeDependencies);
        if (result.inputDependencies) a.inputDependencies = structuredClone(result.inputDependencies);
        for (const e of result.evidence) if (!state.evidence.some(old => old.id === e.id)) state.evidence.push(e);
        for (const ref of result.artifacts) if (!state.artifacts.some(old => old.id === ref.id)) state.artifacts.push(ref);
      }
      if (a.effect === 'write' && !provenNoEffect && (result.effectState === 'unknown' || rejection !== null)) this.effectObligation(state, a);
      if (task && a.execution?.mode !== 'not_invoked' && !['cancelled', 'paused', 'failed', 'blocked', 'completed'].includes(state.status))
        captureProgress(state, this.services.digester,
          a.adopted && state.progress?.processed.includes(`attempt:${a.id}:settled`) ? `attempt:${a.id}:received:${a.resultId}:adopted` : `attempt:${a.id}:settled`, this.services.clock.now(), {
          failureKey: a.error ? taskFailureKey(state, task, this.services.digester) : null,
          additionalKeys: a.adopted && !result.reuse ? acceptedToolProgressKeys(state, task, result, this.services.digester,
            toolProofValid && proofTool?.definition.resultValidation === 'artifact-proof-v1' && Boolean(proofTool.validateResult) && isComputerObservationTool(proofTool)) : [],
        });
      if (!['cancelled', 'paused', 'failed', 'blocked', 'completed'].includes(state.status)) { state.status = 'ready'; state.statusReason = rejection ?? 'result_settled'; }
    }, async () => {
      if (inputsValid && result.inputDependencies?.length && !(await this.services.inputs!.validate(result.inputDependencies, await this.state(workId)))) throw new Error('reuse_adoption_changed');
      if (acceptedCustomProof && (this.tools.get(attempt.toolId, attempt.toolVersion)?.tool !== proofTool ||
        !(await this.tools.validateResult(await this.state(workId), result)))) throw new Error('tool_proof_changed');
      if (acceptedCollection && !(await this.readCheckpoints.validateResult(await this.state(workId), result))) throw new Error('reuse_adoption_changed');
      if (acceptedReuse) {
        const latest = await this.state(workId); const consumer = this.attempt(latest, attemptId); const task = this.currentTask(latest, consumer);
        if (!task || !(await this.resultReuse.validate(latest, task, consumer, result))) throw new Error('reuse_adoption_changed');
      }
      if (accepted && this.services.executionAuthority && !executionAuthorityCurrent(this.services, await this.state(workId))) throw new Error('reuse_adoption_changed');
    });
    return refreshKnowledge(this.services, workId, id => this.interrupt(id));
  }
  async recover(workId: string, attemptId: string) {
    const current = await this.state(workId);
    if (this.storedResults.candidate(current, attemptId)) {
      if (current.status === 'blocked') return current;
      if (this.attempt(current, attemptId).leaseUntil > this.services.clock.now()) throw new Error('attempt_not_expired');
      return this.restoreStoredResult(workId, attemptId);
    }
    await this.expireAttempt(workId, attemptId);
    const expired = await this.state(workId), progress = this.attempt(expired, attemptId).readProgress;
    if (!progress || visibleReadProgress(expired, progress)) await this.readReconciliation.reconcile(workId, attemptId);
    return this.services.effects?.recover ? this.services.effects.recover(workId, attemptId) : this.state(workId);
  }
  private async expireAttempt(workId: string, attemptId: string, collectionOnly = false): Promise<void> {
    const collectionGuard = (state: WorkState) => {
      if (!collectionOnly) return;
      assertExecutionAuthority(this.services, state);
      const attempt = this.attempt(state, attemptId);
      if (['cancelled', 'paused', 'failed', 'completed', 'blocked'].includes(state.status) || attempt.effect !== 'read' ||
        !this.tools.get(attempt.toolId, attempt.toolVersion)?.tool.definition.collection) throw new Error('read_state_changed');
    };
    await this.change(workId, `recover:${attemptId}`, { attemptId }, 'attempt_recovered', state => {
      collectionGuard(state);
      const a = this.attempt(state, attemptId);
      if (!['reserved', 'running'].includes(a.status) || a.leaseUntil > this.services.clock.now()) throw new Error('attempt_not_expired');
      const reserved = a.status === 'reserved';
      if (reserved) state.budget.reservedToolCalls--;
      a.status = !reserved && a.effect === 'write' ? 'unknown' : 'failed';
      a.effectState = a.status === 'unknown' ? 'unknown' : 'none'; a.finishedAt = this.services.clock.now();
      a.error = { code: reserved ? 'reservation_expired' : 'lease_expired', retryable: reserved || a.effect === 'read' };
      if (a.effectState === 'unknown') this.effectObligation(state, a);
      const task = this.currentTask(state, a);
      if (!reserved && task && !['cancelled', 'paused', 'failed'].includes(state.status))
        captureProgress(state, this.services.digester, `attempt:${a.id}:settled`, this.services.clock.now(), { failureKey: taskFailureKey(state, task, this.services.digester) });
      if (!['cancelled', 'paused', 'failed'].includes(state.status)) { state.status = 'ready'; state.statusReason = 'lease_expired'; }
    }, collectionOnly ? async () => { collectionGuard(await this.state(workId)); } : undefined);
  }
  private restoreStoredResult(workId: string, attemptId: string): Promise<WorkState> {
    const key = JSON.stringify([workId, attemptId]);
    const existing = this.#restoring.get(key); if (existing) return existing;
    const pending = this.restoreStoredResultOnce(workId, attemptId);
    this.#restoring.set(key, pending);
    void pending.finally(() => { if (this.#restoring.get(key) === pending) this.#restoring.delete(key); }).catch(() => {});
    return pending;
  }
  private async restoreStoredResultOnce(workId: string, attemptId: string): Promise<WorkState> {
    const initial = await this.state(workId);
    if (initial.status === 'blocked') return initial;
    if (!this.storedResults.candidate(initial, attemptId)) return initial;
    assertExecutionAuthority(this.services, initial);
    let code = 'stored_result_unavailable';
    try {
      const ticket = await this.storedResults.prepare(initial, attemptId);
      if (ticket) return await this.receiveOnce(workId, attemptId, ticket.result, 'invoked', ticket);
    } catch {
      code = 'stored_result_recovery_failed';
    }
    const current = await this.state(workId);
    if (current.status === 'blocked') return current;
    assertExecutionAuthority(this.services, current);
    if (!this.storedResults.candidate(current, attemptId) || current.revision !== initial.revision) return current;
    return (await this.change(workId, `stored-result-gate:${attemptId}:${current.revision}`, { attemptId, code }, 'stored_result_recovery_blocked', next => {
      if (next.revision !== current.revision || !this.storedResults.candidate(next, attemptId)) throw new Error('result_lifecycle_changed');
      assertExecutionAuthority(this.services, next);
      const attempt = this.attempt(next, attemptId);
      attempt.status = 'failed'; attempt.finishedAt = this.services.clock.now(); attempt.error = { code, retryable: false };
      next.status = 'blocked'; next.statusReason = code;
    }, async () => {
      const latest = await this.state(workId); assertExecutionAuthority(this.services, latest);
      if (latest.revision !== current.revision) throw new Error('result_lifecycle_changed');
    })).state;
  }
  /** Settles only already-dispatched durable responses, before context materialization or new allocation. */
  async settleStoredResult(workId: string): Promise<Control | null> {
    const state = await this.state(workId);
    const received = state.attempts.find(attempt => {
      if (attempt.status !== 'received' || attempt.effect !== 'read') return false;
      const tool = this.tools.get(attempt.toolId, attempt.toolVersion)?.tool;
      return !!tool?.restoreResult && tool.definition.resultValidation === 'artifact-proof-v1' &&
        !tool.definition.collection && !tool.definition.reuse && !tool.definition.computerContinuation && !tool.definition.computerInputAssurance;
    });
    if (received) {
      await this.adopt(workId, received.id);
      return { kind: 'continue', action: 'adopt', id: received.id, reason: 'stored_result_pending' };
    }
    const stored = state.attempts.find(attempt => attempt.leaseUntil <= this.services.clock.now() && this.storedResults.candidate(state, attempt.id));
    if (!stored) return null;
    assertExecutionAuthority(this.services, state);
    if (state.status === 'blocked') return { kind: 'blocked', reason: state.statusReason };
    await this.restoreStoredResult(workId, stored.id);
    return { kind: 'continue', action: 'recover', id: stored.id, reason: 'stored_result_checked' };
  }
  /** Settles one stored collection change without a model packet, new dispatch or effect recovery. */
  async settleStoredCollection(workId: string): Promise<Control | null> {
    if (this.#closing) throw new Error('executor_closed');
    let state = await this.state(workId);
    if (['cancelled', 'paused', 'failed', 'completed', 'blocked'].includes(state.status)) return null;
    const collection = (attempt: Attempt) => attempt.effect === 'read' &&
      !!this.tools.get(attempt.toolId, attempt.toolVersion)?.tool.definition.collection;
    const received = state.attempts.find(attempt => attempt.status === 'received' && collection(attempt));
    if (received) {
      assertExecutionAuthority(this.services, state);
      const settled = await this.adopt(workId, received.id);
      return settled.revision === state.revision ? null : { kind: 'continue', action: 'adopt', id: received.id, reason: 'stored_collection_pending' };
    }
    const expired = state.attempts.find(attempt => attempt.status === 'running' && collection(attempt) && attempt.leaseUntil <= this.services.clock.now());
    if (expired) {
      assertExecutionAuthority(this.services, state);
      await this.expireAttempt(workId, expired.id, true);
      state = await this.state(workId); assertExecutionAuthority(this.services, state);
      const progress = this.attempt(state, expired.id).readProgress;
      if (!['cancelled', 'paused', 'failed', 'completed', 'blocked'].includes(state.status) &&
        (!progress || visibleReadProgress(state, progress))) await this.readReconciliation.reconcile(workId, expired.id);
      return { kind: 'continue', action: 'recover', id: expired.id, reason: 'stored_collection_expired' };
    }
    for (const attempt of state.attempts) {
      if (!['failed', 'partial', 'cancelled', 'succeeded'].includes(attempt.status) || attempt.goalRevision !== state.goal.revision ||
        attempt.scope !== state.goal.scope || !attempt.readProgress || !visibleReadProgress(state, attempt.readProgress) || !attempt.readProgress.unknownCalls ||
        attempt.readProgress.successorAttemptId || !collection(attempt) ||
        !this.tools.get(attempt.toolId, attempt.toolVersion)?.tool.definition.collection?.responseRecovery) continue;
      assertExecutionAuthority(this.services, state);
      const settled = await this.readReconciliation.reconcile(workId, attempt.id);
      assertExecutionAuthority(this.services, settled);
      if (settled.revision !== state.revision) return { kind: 'continue', action: 'recover', id: attempt.id, reason: 'stored_collection_checked' };
      state = settled;
    }
    return null;
  }
  async step(workId: string): Promise<Control> {
    if (this.#closing) throw new Error('executor_closed');
    await refreshKnowledge(this.services, workId, id => this.interrupt(id));
    let state = await prepareExecutionBoundary(this.services, workId);
    const stored = await this.settleStoredResult(workId) ?? await this.settleStoredCollection(workId);
    if (stored) return stored;
    state = await this.state(workId);
    const initialControl = this.control(state);
    const settling = initialControl.kind === 'continue' && ['adopt', 'recover'].includes(initialControl.action);
    if (!settling && state.budgetGrants?.some(g => g.status !== 'settled')) state = await this.budgets.refresh(workId);
    if (!settling && !['cancelled', 'paused', 'failed', 'blocked', 'completed'].includes(state.status))
      await validateReadWaits(this.services, this.tools, state);
    const control = await this.inspectedControl(state);
    if (control.kind === 'continue') {
      try {
      if (control.action === 'reserve') await this.reserve(workId, control.id);
      if (control.action === 'dispatch') {
        const attempt = this.attempt(state, control.id);
        if (attempt.owner !== this.owner) return { kind: 'wait', reason: 'owned_by_another_executor', wakeAt: attempt.leaseUntil };
        await this.execute(workId, control.id);
      }
      if (control.action === 'adopt') await this.adopt(workId, control.id);
      if (control.action === 'recover') await this.recover(workId, control.id);
      return control;
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (code.startsWith('budget_') || ['tool_version_unavailable', 'tool_effect_mismatch', 'tool_permission_denied', 'invalid_tool_input', 'tool_contract_changed'].includes(code)) {
          await this.change(workId, `gate:${state.revision}`, { code }, 'execution_gate_rejected', next => {
            if (next.revision !== state.revision && !code.startsWith('budget_')) throw new Error('control_stale');
            if (['cancelled', 'paused', 'failed', 'completed'].includes(next.status)) return;
            if (code.startsWith('budget_')) cancelBudgetReservations(next, this.services.clock.now());
            for (const a of next.attempts) if (a.status === 'reserved') {
              a.status = 'failed'; a.error = { code, retryable: false }; a.finishedAt = this.services.clock.now(); next.budget.reservedToolCalls--;
            }
            next.status = 'blocked'; next.statusReason = code;
          });
          return { kind: 'blocked', reason: code };
        }
        if (['tool_connection_required', 'task_not_ready', 'attempt_not_dispatchable', 'attempt_expired', 'attempt_not_expired', 'result_not_pending', 'read_retry_not_due'].includes(code)) return this.inspectedControl(await this.state(workId));
        throw error;
      }
    }
    const status = control.kind === 'complete' ? 'completed' : control.kind === 'wait' ? 'waiting' : control.kind === 'replan' ? 'ready' : control.kind;
    const retryWakeAt = control.kind === 'wait' && ['retry_backoff', 'read_retry_wait'].includes(control.reason) ? control.wakeAt : null;
    if (state.status !== status || state.statusReason !== control.reason || (state.retryWakeAt ?? null) !== retryWakeAt) await this.change(workId, `control:${state.revision}`, asJson(control), 'control_selected', next => {
      if (next.revision !== state.revision) throw new Error('control_stale');
      next.status = status; next.statusReason = control.reason;
      if (control.kind === 'complete') for (const subscription of next.subscriptions ?? []) subscription.status = 'closed';
      next.retryWakeAt = retryWakeAt;
    }, async () => {
      if (control.kind === 'complete' && !(await effectProofsCurrent(this.services, await this.state(workId)))) throw new Error('effect_proof_unavailable');
    });
    return control;
  }
  async runUntilYield(workId: string, maxSteps = 20): Promise<Control | { kind: 'yield'; reason: string }> {
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 10000) throw new Error('invalid_step_limit');
    for (let count = 0; count < maxSteps; count++) {
      const control = await this.step(workId);
      if (control.kind !== 'continue') return control;
    }
    return { kind: 'yield', reason: 'step_limit' };
  }
}
