import type { Attempt, TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import type { ComputerContinuationClaim } from '../domain/computer-continuation.js';
import type { ComputerActInput, ComputerCheckpointV2 } from '../domain/computer-use.js';
import { dataGeneration, visibleArtifact } from '../domain/data-lifecycle.js';
import { allowsDisclosure, disclosureLabels } from '../domain/disclosure.js';
import type { RuntimeServices, ComputerContinuationService } from './services.js';
import type { ComputerUse, BoundComputerBinding } from './computer-use.js';
import type { ComputerReconciliations } from './computer-reconciliation.js';
import { ToolContracts, type RegisteredTool, toolAllowed } from './tool-contracts.js';
import { ComputerContinuationClaimSchema, ComputerContinuationsSchema, ToolResultSchema, WorkStateSchema, parseContract } from './contracts.js';
import { ComputerActInputSchema } from './computer-use-contracts.js';
import { asJson, taskDigest } from './plan-validator.js';
import { cancelBudgetReservations } from './budget-delegation.js';

const obligationId = 'computer-continuations:proof';
const terminal = (attempt: Attempt) => ['succeeded', 'partial', 'failed', 'cancelled', 'unknown'].includes(attempt.status);
function fail(code: string): never { throw new Error(code); }
type Kind = 'act' | 'continue' | 'verify';
type Selection = { binding: BoundComputerBinding; kind: Kind; entry: RegisteredTool };
type Resolved = { claim: ComputerContinuationClaim; rootInput: ComputerActInput; sourceCheckpoint: ComputerCheckpointV2 };

/** Internal coordination only. The caller supplies canonical work state after authenticating a work actor. */
export class ComputerContinuations implements ComputerContinuationService {
  readonly #bindings = new Map<string, Selection>();
  constructor(readonly services: RuntimeServices, readonly contracts: ToolContracts,
    readonly computer: Pick<ComputerUse, 'inspectCheckpoint' | 'validateResult'>,
    readonly reconciliations: Pick<ComputerReconciliations, 'proofCurrent'>,
    bindings: readonly BoundComputerBinding[], readonly interrupt?: (workId: string) => void) {
    for (const binding of bindings) for (const kind of ['act', 'continue', 'verify'] as const) {
      const entry = contracts.get(`${binding.id}.${kind}`, binding.version);
      if (!entry || kind !== 'act' && entry.tool.definition.computerContinuation !== kind) fail('computer_continuation_binding_missing');
      const key = JSON.stringify([entry.tool.definition.id, binding.version]);
      if (this.#bindings.has(key)) fail('computer_continuation_binding_duplicate');
      this.#bindings.set(key, { binding, kind, entry });
    }
  }
  private digest(value: unknown) { return this.services.digester.digest(asJson(value ?? null)); }
  private same(left: unknown, right: unknown) { return this.digest(left) === this.digest(right); }
  private attempt(state: WorkState, id: string) {
    const matches = state.attempts.filter(attempt => attempt.id === id);
    if (matches.length !== 1) fail('computer_continuation_attempt_missing'); return matches[0]!;
  }
  private selected(attempt: Pick<Attempt, 'toolId' | 'toolVersion' | 'contractDigest'>, state: WorkState): Selection {
    const selected = this.#bindings.get(JSON.stringify([attempt.toolId, attempt.toolVersion]));
    if (!selected || this.contracts.get(attempt.toolId, attempt.toolVersion) !== selected.entry ||
      attempt.contractDigest !== this.digest(selected.entry.tool.definition) || !toolAllowed(selected.entry.tool.definition, state.policy) ||
      !allowsDisclosure(state.policy, selected.binding.destination, 'tool', disclosureLabels(state))) fail('computer_continuation_contract_changed');
    return selected;
  }
  private async canonical(state: WorkState) {
    const current = await this.services.state.get(state.id);
    if (!current || !this.same(current, state)) fail('computer_continuation_state_changed');
  }
  /** This runs before any recursive checkpoint reader. Edges decrease depth toward one bounded root. */
  private graph(state: WorkState) {
    const claims = parseContract(ComputerContinuationsSchema, state.computerContinuations ?? []);
    const successors = new Map(claims.map(claim => [claim.successorAttemptId, claim]));
    for (const claim of claims) {
      const source = this.attempt(state, claim.sourceAttemptId); const child = this.attempt(state, claim.successorAttemptId);
      if (!source.computerUse || !terminal(source) || !this.same(source.computerUse.head, claim.sourceHead) ||
        !this.same(source.resultArtifact, claim.sourceResultArtifact) || source.contractDigest !== claim.sourceContractDigest ||
        source.goalRevision !== claim.goalRevision || source.scope !== claim.scope || child.goalRevision !== claim.goalRevision || child.scope !== claim.scope ||
        child.inputDigest !== claim.successorTaskDigest || child.contractDigest !== claim.contractDigest || child.effect !== (claim.mode === 'continue' ? 'write' : 'read') ||
        child.startedAt !== claim.createdAt) fail('computer_continuation_claim_changed');
      let current = claim; const seen = new Set<string>();
      for (;;) {
        if (seen.has(current.successorAttemptId) || seen.size >= 8) fail('computer_continuation_graph_invalid');
        seen.add(current.successorAttemptId);
        const parent = successors.get(current.sourceAttemptId);
        if (!parent) {
          if (current.depth !== 1 || current.rootAttemptId !== current.sourceAttemptId || current.rootAttemptId !== claim.rootAttemptId)
            fail('computer_continuation_graph_invalid');
          break;
        }
        if (current.depth !== parent.depth + 1 || current.rootAttemptId !== parent.rootAttemptId || current.actionDeadlineAt !== parent.actionDeadlineAt ||
          current.maxObservations !== parent.maxObservations || current.maxInputAttempts !== parent.maxInputAttempts || current.maxSuccessors !== parent.maxSuccessors ||
          current.totalSteps !== parent.totalSteps || current.policyDigest !== parent.policyDigest || current.generation !== parent.generation ||
          current.goalRevision !== parent.goalRevision || current.scope !== parent.scope || current.createdAt < parent.createdAt ||
          current.observationsUsed < parent.observationsUsed || current.inputAttemptsUsed < parent.inputAttemptsUsed || current.nextStep < parent.nextStep)
          fail('computer_continuation_graph_invalid');
        current = parent;
      }
    }
    return { claims, successors };
  }
  private async resultCurrent(state: WorkState, attempt: Attempt, selected: Selection) {
    if (!attempt.resultArtifact) return;
    const ref = attempt.resultArtifact;
    if (!visibleArtifact(state, ref) || ref.mediaType !== 'application/json' || ref.byteLength > 262144) fail('computer_continuation_result_unavailable');
    let result: ToolResult;
    try {
      const bytes = await this.services.artifacts.get(ref, state.policy);
      if (bytes.byteLength !== ref.byteLength) fail('computer_continuation_result_unavailable');
      result = parseContract(ToolResultSchema, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    } catch { fail('computer_continuation_result_unavailable'); }
    if (result.attemptId !== attempt.id || result.resultId !== attempt.resultId ||
      !(await this.computer.validateResult(selected.binding, selected.entry.tool.definition, selected.kind, state, result)))
      fail('computer_continuation_result_unavailable');
  }
  private async rootInput(state: WorkState, rootAttemptId: string): Promise<ComputerActInput> {
    const root = this.attempt(state, rootAttemptId); const selected = this.selected(root, state);
    if (selected.kind !== 'act' || root.effect !== 'write') fail('computer_continuation_root_invalid');
    const receipt = await this.services.state.receipt(state.id, `dispatch:${root.id}`);
    const original = receipt?.state.attempts.find(attempt => attempt.id === root.id);
    const task = receipt?.state.plan?.tasks.find(task => task.id === root.taskId);
    if (!receipt || !original || !task || original.status !== 'running' || original.owner !== root.owner ||
      original.inputDigest !== root.inputDigest || original.contractDigest !== root.contractDigest || original.goalRevision !== root.goalRevision ||
      original.scope !== root.scope || task.computerResume || taskDigest(task, this.services.digester) !== root.inputDigest ||
      receipt.state.id !== state.id || receipt.state.policy.tenantId !== state.policy.tenantId ||
      receipt.digest !== this.digest({ type: 'attempt_dispatched', data: { attemptId: root.id, owner: root.owner } }))
      fail('computer_continuation_root_unproven');
    return parseContract(ComputerActInputSchema, task.input);
  }
  private async derive(state: WorkState, task: TaskSpec, successorAttemptId: string, createdAt: number): Promise<Resolved> {
    const graph = this.graph(state); const resume = task.computerResume;
    if (!resume || task.readResume || Object.keys(task.input).length || successorAttemptId === resume.attemptId) fail('computer_continuation_task_invalid');
    const source = this.attempt(state, resume.attemptId);
    if (!terminal(source) || !source.computerUse || source.computerUse.head.id !== resume.checkpointId) fail('computer_continuation_source_not_ready');
    const parent = graph.successors.get(source.id); const selection = this.selected(source, state);
    const targetEntry = this.contracts.get(task.toolId, task.toolVersion);
    const mode = targetEntry?.tool.definition.computerContinuation;
    if (!mode || this.contracts.check(task, state.policy)) fail('computer_continuation_task_invalid');
    const target = this.selected({ toolId: task.toolId, toolVersion: task.toolVersion, contractDigest: this.digest(targetEntry!.tool.definition) }, state);
    if (target.kind !== mode || target.binding.id !== selection.binding.id || target.binding.version !== selection.binding.version)
      fail('computer_continuation_binding_changed');
    const verified = await this.computer.inspectCheckpoint(state, source.id, source.computerUse.head);
    if (verified.cp.schemaVersion !== 2) fail('computer_continuation_legacy_checkpoint');
    const cp = verified.cp;
    if (cp.goalRevision !== source.goalRevision || cp.scope !== source.scope || cp.policyDigest !== this.digest(state.policy) ||
      cp.lifecycleGeneration !== dataGeneration(state) || !this.same(cp.driver, selection.binding.identity) || cp.sessionId !== selection.binding.sessionId)
      fail('computer_continuation_source_changed');
    if (cp.lineage.maxObservations !== selection.binding.limits.maxObservations || cp.lineage.maxInputAttempts !== selection.binding.limits.maxSteps * 2 ||
      cp.lineage.maxSuccessors !== 8 || cp.lineage.depth >= cp.lineage.maxSuccessors) fail('computer_continuation_limits_changed');
    if (parent ? !this.same(cp.continuation?.claim, parent) || cp.lineage.depth !== parent.depth || cp.lineage.rootAttemptId !== parent.rootAttemptId ||
      cp.lineage.actionDeadlineAt !== parent.actionDeadlineAt || cp.lineage.maxObservations !== parent.maxObservations ||
      cp.lineage.maxInputAttempts !== parent.maxInputAttempts || cp.lineage.maxSuccessors !== parent.maxSuccessors ||
      cp.lineage.observationsUsed < parent.observationsUsed || cp.lineage.inputAttemptsUsed < parent.inputAttemptsUsed :
      cp.continuation !== null || cp.lineage.depth !== 0 || cp.lineage.rootAttemptId !== source.id) fail('computer_continuation_lineage_changed');
    const rootInput = await this.rootInput(state, cp.lineage.rootAttemptId);
    const start = parent?.nextStep ?? 0;
    if ((parent && parent.totalSteps !== rootInput.steps.length) || start + cp.steps.length > rootInput.steps.length ||
      cp.steps.some((step, index) => step.index !== index || !this.same({ action: step.action, condition: step.condition }, rootInput.steps[start + index])))
      fail('computer_continuation_steps_changed');
    const pending = cp.steps.filter(step => step.status === 'intent' || step.status === 'unknown');
    let reconciliation: ComputerContinuationClaim['reconciliation'] = null;
    let pendingApplied = false;
    if (pending.length) {
      if (pending.length !== 1 || pending[0] !== cp.steps.at(-1) || !resume.reconciliation) fail('computer_continuation_proof_required');
      const record = state.computerReconciliations?.find(record => record.id === resume.reconciliation!.id);
      if (!record || record.status !== 'settled' || record.sourceAttemptId !== source.id || !this.same(record.sourceHead, source.computerUse.head) ||
        !this.same(record.sourceResultArtifact, source.resultArtifact) || record.operationId !== pending[0]!.operationId || record.stepIndex !== pending[0]!.index ||
        record.contractDigest !== source.contractDigest || record.goalRevision !== cp.goalRevision || record.policyDigest !== cp.policyDigest ||
        record.generation !== cp.lifecycleGeneration || !record.proofArtifact || record.proofArtifact.id !== resume.reconciliation.proofId ||
        !['applied', 'not_applied'].includes(record.outcome ?? '') || !(await this.reconciliations.proofCurrent(state, record.id)))
        fail('computer_continuation_proof_changed');
      reconciliation = { id: record.id, proofArtifact: record.proofArtifact }; pendingApplied = record.outcome === 'applied';
    } else if (resume.reconciliation) fail('computer_continuation_proof_unexpected');
    let applied = 0; let stopped = false;
    for (const step of cp.steps) {
      const knownApplied = step.status === 'applied' || ((step.status === 'intent' || step.status === 'unknown') && pendingApplied);
      if (stopped) fail('computer_continuation_prefix_invalid');
      if (knownApplied) applied++; else stopped = true;
    }
    const nextStep = start + applied;
    if (mode === 'verify' ? nextStep !== rootInput.steps.length : nextStep >= rootInput.steps.length) fail('computer_continuation_mode_invalid');
    const claim = parseContract(ComputerContinuationClaimSchema, { sourceAttemptId: source.id, sourceHead: source.computerUse.head,
      sourceResultArtifact: source.resultArtifact, successorAttemptId, successorTaskDigest: taskDigest(task, this.services.digester), mode, reconciliation,
      rootAttemptId: cp.lineage.rootAttemptId, sourceContractDigest: source.contractDigest, contractDigest: this.digest(targetEntry!.tool.definition),
      goalRevision: cp.goalRevision, scope: cp.scope, policyDigest: cp.policyDigest, generation: cp.lifecycleGeneration, createdAt,
      actionDeadlineAt: cp.lineage.actionDeadlineAt, maxObservations: cp.lineage.maxObservations, maxInputAttempts: cp.lineage.maxInputAttempts,
      maxSuccessors: cp.lineage.maxSuccessors, depth: cp.lineage.depth + 1, observationsUsed: cp.lineage.observationsUsed,
      inputAttemptsUsed: cp.lineage.inputAttemptsUsed, nextStep, totalSteps: rootInput.steps.length });
    await this.resultCurrent(state, source, selection);
    await this.canonical(state); this.selected(source, state); this.selected(this.attempt(state, claim.rootAttemptId), state);
    this.selected({ toolId: task.toolId, toolVersion: task.toolVersion, contractDigest: claim.contractDigest }, state);
    return { claim, rootInput, sourceCheckpoint: cp };
  }
  async prepare(input: WorkState, task: TaskSpec, successorAttemptId: string): Promise<ComputerContinuationClaim> {
    const state = parseContract(WorkStateSchema, input); task = structuredClone(task);
    if (!successorAttemptId || successorAttemptId.length > 256) fail('computer_continuation_task_invalid');
    await this.canonical(state); const graph = this.graph(state);
    if (graph.claims.some(claim => claim.sourceAttemptId === task.computerResume?.attemptId || claim.successorAttemptId === successorAttemptId) ||
      state.attempts.some(attempt => attempt.id === successorAttemptId)) fail('computer_continuation_successor_exists');
    if (['paused', 'cancelled', 'failed', 'completed'].includes(state.status) || this.services.clock.now() >= state.deadlineAt ||
      !state.plan?.tasks.some(selected => this.same(selected, task))) fail('computer_continuation_not_ready');
    const now = this.services.clock.now(); const resolved = await this.derive(state, task, successorAttemptId, now); const claim = resolved.claim;
    if (claim.goalRevision !== state.goal.revision || claim.scope !== state.goal.scope || this.services.clock.now() >= state.deadlineAt || claim.observationsUsed >= claim.maxObservations ||
      (claim.mode === 'continue' && (this.services.clock.now() >= claim.actionDeadlineAt || claim.inputAttemptsUsed >= claim.maxInputAttempts)))
      fail('computer_continuation_budget_or_deadline');
    return structuredClone(claim);
  }
  async resolve(input: WorkState, successorAttemptId: string): Promise<Resolved> {
    const state = parseContract(WorkStateSchema, input); const graph = this.graph(state); const claim = graph.successors.get(successorAttemptId);
    if (!claim) fail('computer_continuation_claim_missing');
    await this.canonical(state);
    const child = this.attempt(state, successorAttemptId);
    const receipt = await this.services.state.receipt(state.id, `reserve:${child.id}`);
    const reserved = receipt?.state.attempts.find(attempt => attempt.id === child.id);
    const task = receipt?.state.plan?.tasks.find(task => task.id === child.taskId);
    const stored = receipt?.state.computerContinuations?.find(value => value.successorAttemptId === child.id);
    if (!receipt || !reserved || !task || !this.same(stored, claim) || reserved.status !== 'reserved' || reserved.effectState !== 'none' ||
      reserved.execution?.mode !== 'not_invoked' || reserved.resultArtifact !== null || reserved.resultId !== null || reserved.adopted || reserved.finishedAt !== null ||
      receipt.state.id !== state.id || receipt.state.policy.tenantId !== state.policy.tenantId || this.digest(receipt.state.policy) !== claim.policyDigest ||
      receipt.state.goal.revision !== claim.goalRevision || receipt.state.goal.scope !== claim.scope || dataGeneration(receipt.state) !== claim.generation ||
      receipt.state.budget.reservedToolCalls < 1 || reserved.startedAt !== claim.createdAt || reserved.owner !== child.owner || reserved.leaseUntil !== child.leaseUntil ||
      reserved.planRevision !== child.planRevision || reserved.taskId !== child.taskId || reserved.toolId !== child.toolId || reserved.toolVersion !== child.toolVersion ||
      reserved.goalRevision !== child.goalRevision || reserved.scope !== child.scope || reserved.effect !== child.effect ||
      reserved.inputDigest !== claim.successorTaskDigest || reserved.contractDigest !== claim.contractDigest || taskDigest(task, this.services.digester) !== claim.successorTaskDigest ||
      receipt.digest !== this.digest({ type: 'attempt_reserved', data: { taskId: child.taskId, id: child.id, owner: child.owner } }))
      fail('computer_continuation_reservation_unproven');
    const derived = await this.derive(state, task, child.id, claim.createdAt);
    if (!this.same(derived.claim, claim)) fail('computer_continuation_claim_changed');
    return structuredClone(derived);
  }
  async current(input: WorkState): Promise<boolean> {
    try {
      const state = parseContract(WorkStateSchema, input); const graph = this.graph(state);
      if (!graph.claims.length) return true;
      await this.canonical(state);
      for (const claim of graph.claims) {
        await this.resolve(state, claim.successorAttemptId);
        const child = this.attempt(state, claim.successorAttemptId); const selected = this.selected(child, state);
        if (child.computerUse) await this.computer.inspectCheckpoint(state, child.id, child.computerUse.head);
        await this.resultCurrent(state, child, selected);
      }
      await this.canonical(state);
      return true;
    } catch { return false; }
  }
  async refresh(workId: string): Promise<WorkState> {
    for (let retry = 0; retry < 8; retry++) {
      const state = await this.services.state.get(workId); if (!state) fail('work_not_found');
      const valid = await this.current(state); const obligation = state.obligations.find(value => value.id === obligationId);
      const reserved = state.attempts.some(attempt => attempt.status === 'reserved') || state.modelCalls.some(call => call.status === 'reserved') ||
        state.computerReconciliations?.some(record => record.status === 'reserved');
      if (valid ? !obligation || obligation.status === 'satisfied' : obligation?.status === 'pending' && !reserved) {
        if (!valid) this.interrupt?.(workId); return state;
      }
      const next = structuredClone(state); const now = this.services.clock.now();
      const target = next.obligations.find(value => value.id === obligationId);
      if (valid) target!.status = 'satisfied';
      else {
        if (target) target.status = 'pending';
        else next.obligations.push({ id: obligationId, kind: 'effect_reconciliation', reason: 'computer_continuation_proof_unavailable', status: 'pending', wakeKey: null, dueAt: null });
        cancelBudgetReservations(next, now);
      }
      next.revision++; next.updatedAt = now;
      const data = { revision: state.revision, valid }; const commandId = `computer-continuations:proof:${state.revision}:${valid}`;
      const digest = this.digest({ type: 'computer_continuation_proofs_checked', data });
      const receipt = await this.services.state.receipt(workId, commandId);
      if (receipt) { if (receipt.digest !== digest) fail('idempotency_conflict'); continue; }
      // No new artifact is published here. Missing originals must not prevent installing the blocking obligation.
      const result = await this.services.state.commit({ workId, expectedRevision: state.revision, commandId, commandDigest: digest, next,
        events: [{ type: 'computer_continuation_proofs_checked', at: now, data: { payload: data } }], deliveries: [] });
      if (result.kind === 'idempotency_conflict') fail('idempotency_conflict');
      if (result.kind === 'committed' || result.kind === 'duplicate') {
        if (!valid) this.interrupt?.(workId);
        const current = await this.services.state.get(workId); if (!current) fail('work_not_found'); return current;
      }
    }
    return fail('computer_continuation_contention');
  }
}
