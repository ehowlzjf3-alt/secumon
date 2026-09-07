import type { ArtifactRef, ToolExecution, ToolUsage, WorkState } from '../domain/model.js';
import type { ComputerReconciliation } from '../domain/computer-reconciliation.js';
import type { ComputerLease } from '../domain/computer-use.js';
import { visibleArtifact, dataGeneration } from '../domain/data-lifecycle.js';
import { allowsDisclosure, disclosureLabels } from '../domain/disclosure.js';
import { effectiveExecutionLimits } from '../domain/execution-policy.js';
import type { RuntimeServices } from './services.js';
import type { ExecutionRuntime } from './execution-runtime.js';
import type { ToolContracts, RegisteredTool } from './tool-contracts.js';
import { toolAllowed } from './tool-contracts.js';
import { ComputerUse, type BoundComputerBinding } from './computer-use.js';
import { authorizedWork, type WorkActor } from './work-resources.js';
import { asJson } from './plan-validator.js';
import { transact } from './work-transactions.js';
import { assertBudgetAuthority, cancelBudgetReservations } from './budget-delegation.js';
import { knowledgeInputsCurrent } from './knowledge-validity.js';
import { toolExecution } from './tool-execution-usage.js';
import { captureProgress } from './work-progress.js';
import { ComputerReconciliationSchema, ToolUsageSchema } from './contracts.js';
import { ComputerLeaseSchema } from './computer-use-contracts.js';
import { ComputerOperationLookupResultSchema } from './computer-operation-contracts.js';
import { ComputerReconciliationInputSchema, ComputerReconciliationIntentSchema, ComputerReconciliationResponseSchema,
  ComputerReconciliationProofSchema, ReconciliationActorSchema, type ComputerReconciliationIntent } from './computer-reconciliation-contracts.js';

type Selected = { binding: BoundComputerBinding; act: RegisteredTool; read: RegisteredTool };
function fail(code: string): never { throw new Error(code); }
const unknown = (): ToolUsage => ({ transportCalls: null, internalOperations: null, imageBytes: null, waitMs: null });
const parseActor = (actor: WorkActor): WorkActor => JSON.parse(JSON.stringify(ReconciliationActorSchema.parse(actor))) as WorkActor;

/** Explicit read-only reconciliation. The original input and its result are never replayed or rewritten. */
export class ComputerReconciliations {
  #bindings = new Map<string, Selected>();
  #pending = new Map<string, { digest: string; promise: Promise<ComputerReconciliation> }>();
  constructor(readonly services: RuntimeServices, readonly contracts: ToolContracts, readonly computer: ComputerUse,
    readonly runtime: ExecutionRuntime, bindings: BoundComputerBinding[]) {
    for (const binding of bindings) {
      const act = contracts.get(`${binding.id}.act`, binding.version); const read = contracts.get(`${binding.id}.observe`, binding.version);
      if (!act || !read) fail('computer_reconciliation_binding_missing');
      const key = `${act.tool.definition.id}@${binding.version}`;
      if (this.#bindings.has(key)) fail('computer_reconciliation_binding_duplicate');
      this.#bindings.set(key, { binding, act, read });
      const continuation = contracts.get(`${binding.id}.continue`, binding.version);
      if (continuation) this.#bindings.set(`${continuation.tool.definition.id}@${binding.version}`, { binding, act: continuation, read });
    }
  }
  private digest(value: unknown): string { return this.services.digester.digest(asJson(value ?? null)); }
  private same(left: unknown, right: unknown): boolean { return this.digest(left) === this.digest(right); }
  private basis(record: ComputerReconciliation) {
    const { status: _status, dispatchedAt: _dispatchedAt, finishedAt: _finishedAt, responseArtifact: _responseArtifact,
      proofArtifact: _proofArtifact, execution: _execution, outcome: _outcome, effectState: _effectState, reason: _reason, ...basis } = record;
    return basis;
  }
  private async single(key: string, value: unknown, run: () => Promise<ComputerReconciliation>) {
    const digest = this.digest(value); const pending = this.#pending.get(key);
    if (pending) { if (pending.digest !== digest) fail('idempotency_conflict'); return pending.promise; }
    const promise = run(); const entry = { digest, promise }; this.#pending.set(key, entry);
    try { return await promise; } finally { if (this.#pending.get(key) === entry) this.#pending.delete(key); }
  }
  private async bounded<T>(call: Promise<T>, signal: AbortSignal): Promise<T> {
    let abort!: () => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error('computer_reconciliation_interrupted'));
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    });
    try { return await Promise.race([call, stopped]); } finally { signal.removeEventListener('abort', abort); }
  }
  private async release(binding: BoundComputerBinding, lease: ComputerLease) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 1000);
    try { await this.bounded(binding.driver.release(lease), controller.signal); } catch { /* The driver must also enforce grant expiry. */ }
    finally { clearTimeout(timer); }
  }
  private record(state: WorkState, id: string): ComputerReconciliation {
    return state.computerReconciliations?.find(value => value.id === id) ?? fail('computer_reconciliation_missing');
  }
  private selected(state: WorkState, sourceAttemptId: string): Selected {
    const attempt = state.attempts.find(value => value.id === sourceAttemptId);
    if (!attempt) fail('computer_reconciliation_source_missing');
    const entry = this.#bindings.get(`${attempt.toolId}@${attempt.toolVersion}`);
    if (!entry?.binding.driver.lookup || this.contracts.get(attempt.toolId, attempt.toolVersion) !== entry.act ||
      this.contracts.get(entry.read.tool.definition.id, entry.read.tool.definition.version) !== entry.read ||
      attempt.contractDigest !== this.digest(entry.act.tool.definition)) fail('computer_reconciliation_contract_changed');
    if (!toolAllowed(entry.read.tool.definition, state.policy) ||
      !allowsDisclosure(state.policy, entry.binding.destination, 'tool', disclosureLabels(state))) fail('computer_reconciliation_read_denied');
    return entry;
  }
  private async read<T>(state: WorkState, ref: ArtifactRef, parse: (value: unknown) => T): Promise<T> {
    if (ref.byteLength > 262144 || ref.mediaType !== 'application/json' || !visibleArtifact(state, ref)) fail('computer_reconciliation_original_unavailable');
    const bytes = await this.services.artifacts.get(ref, state.policy);
    if (bytes.byteLength !== ref.byteLength) fail('computer_reconciliation_original_unavailable');
    return parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  }
  private put(state: WorkState, value: unknown, labels: string[]): Promise<ArtifactRef> {
    return this.services.artifacts.put(new TextEncoder().encode(JSON.stringify(value)), { tenantId: state.policy.tenantId,
      labels: [...new Set([...disclosureLabels(state), ...labels])].sort(), mediaType: 'application/json' });
  }
  private async load(workId: string, actor: WorkActor) {
    const view = await authorizedWork(this.services.state, workId, actor); const raw = await this.services.state.get(workId);
    if (!raw || raw.revision !== view.revision) fail('computer_reconciliation_state_changed');
    return { raw, view };
  }
  private async source(state: WorkState, record: ComputerReconciliation) {
    const selected = this.selected(state, record.sourceAttemptId);
    const basis = await this.computer.reconciliationBasis(state, record.sourceAttemptId, selected.binding, selected.act.tool.definition);
    const source = state.attempts.find(value => value.id === record.sourceAttemptId)!;
    if (!this.same(basis.head, record.sourceHead) || !this.same(source.resultArtifact, record.sourceResultArtifact) ||
      basis.identity.operationId !== record.operationId || basis.stepIndex !== record.stepIndex || !this.same(basis.checkpoint.driver, record.driver) ||
      basis.checkpoint.contractDigest !== record.contractDigest) fail('computer_reconciliation_source_changed');
    return { ...basis, ...selected };
  }
  private async intent(state: WorkState, record: ComputerReconciliation): Promise<ComputerReconciliationIntent> {
    const intent = await this.read(state, record.requestArtifact, value => ComputerReconciliationIntentSchema.parse(value));
    const source = await this.source(state, record);
    if (intent.workId !== state.id || intent.reconciliationId !== record.id || intent.sourceAttemptId !== record.sourceAttemptId ||
      !this.same(intent.sourceHead, record.sourceHead) || !this.same(intent.sourceResultArtifact, record.sourceResultArtifact) ||
      !this.same(intent.identity, source.identity) || intent.stepIndex !== record.stepIndex || !this.same(intent.driver, record.driver) ||
      intent.contractDigest !== record.contractDigest || intent.goalRevision !== record.goalRevision || intent.policyDigest !== record.policyDigest ||
      intent.generation !== record.generation || intent.readDeadlineAt !== record.leaseUntil || intent.createdAt !== record.createdAt ||
      intent.originalDeadlineAt !== source.checkpoint.deadlineAt) fail('computer_reconciliation_intent_changed');
    const reservation = await this.services.state.receipt(state.id, `reconcile-reserve:${record.id}`);
    const reserved = reservation?.state.computerReconciliations?.find(value => value.id === record.id);
    if (!reservation || !reserved || reserved.status !== 'reserved' || !this.same(this.basis(reserved), this.basis(record)) ||
      reservation.digest !== this.digest({ type: 'computer_reconciliation_reserved', data: { actor: intent.actor,
        input: { attemptId: record.sourceAttemptId, checkpointId: record.sourceHead.id }, sourceHead: record.sourceHead,
        requestArtifact: record.requestArtifact, operationId: record.operationId } }) ||
      this.digest(reservation.state.policy) !== record.policyDigest || reservation.state.goal.revision !== record.goalRevision ||
      dataGeneration(reservation.state) !== record.generation || record.leaseUntil > reservation.state.deadlineAt ||
      record.leaseUntil > record.createdAt + source.binding.limits.maxDurationMs) fail('computer_reconciliation_reservation_unproven');
    return intent;
  }
  private async guard(workId: string, id: string, actor: WorkActor, signal?: AbortSignal, settlement = false) {
    const { raw, view } = await this.load(workId, actor); const record = this.record(raw, id);
    if (!['reserved', 'running', 'received'].includes(record.status) || signal?.aborted || ['paused', 'cancelled', 'failed', 'completed'].includes(raw.status) ||
      this.services.clock.now() >= (settlement ? raw.deadlineAt : Math.min(record.leaseUntil, raw.deadlineAt))) fail('computer_reconciliation_interrupted');
    if (settlement && record.status !== 'received') fail('computer_reconciliation_not_received');
    if (record.goalRevision !== raw.goal.revision || record.policyDigest !== this.digest(raw.policy) || record.generation !== dataGeneration(raw)) fail('computer_reconciliation_scope_changed');
    if (!(await knowledgeInputsCurrent(this.services, view))) fail('computer_reconciliation_knowledge_changed');
    const intent = await this.intent(view, record);
    if (!this.same(intent.actor, actor)) fail('computer_reconciliation_actor_changed');
    await assertBudgetAuthority(this.services, raw);
    const latest = await this.load(workId, actor);
    if (latest.raw.revision !== raw.revision) fail('computer_reconciliation_state_changed');
    this.selected(latest.view, record.sourceAttemptId);
    return { ...latest, record, intent };
  }
  async inspect(workId: string, id: string, actor: WorkActor): Promise<ComputerReconciliation> {
    actor = parseActor(actor); const { raw, view } = await this.load(workId, actor); const record = this.record(raw, id);
    await this.intent(view, record);
    if (!(await knowledgeInputsCurrent(this.services, view)) || (await this.load(workId, actor)).raw.revision !== raw.revision) fail('computer_reconciliation_state_changed');
    return structuredClone(record);
  }
  async reserve(workId: string, commandId: string, actor: WorkActor, input: { attemptId: string; checkpointId: string }): Promise<ComputerReconciliation> {
    if (!commandId || commandId.length > 96) fail('computer_reconciliation_command_invalid');
    actor = parseActor(actor); input = ComputerReconciliationInputSchema.parse(input);
    return this.single(JSON.stringify(['reserve', workId, commandId]), { actor, input }, async () => {
      for (let retry = 0; retry < 8; retry++) {
        try { return await this.reserveOnce(workId, commandId, actor, input); }
        catch (error) {
          if (!(error instanceof Error) || !['computer_reconciliation_state_changed', 'idempotency_conflict'].includes(error.message)) throw error;
          if (error.message === 'idempotency_conflict' && retry === 7) throw error;
        }
      }
      return fail('computer_reconciliation_contention');
    });
  }
  private async reserveOnce(workId: string, commandId: string, actor: WorkActor, input: { attemptId: string; checkpointId: string }): Promise<ComputerReconciliation> {
    const id = `computer-reconcile:${commandId}`;
    let { raw, view } = await this.load(workId, actor);
    const existing = raw.computerReconciliations?.find(value => value.id === id);
    if (existing) {
      const intent = await this.intent(view, existing);
      if (existing.sourceAttemptId !== input.attemptId || existing.sourceHead.id !== input.checkpointId || !this.same(intent.actor, actor)) fail('idempotency_conflict');
      return this.inspect(workId, id, actor);
    }
    await this.refresh(workId); ({ raw, view } = await this.load(workId, actor));
    if (['paused', 'cancelled', 'failed', 'completed'].includes(raw.status) || this.services.clock.now() >= raw.deadlineAt) fail('computer_reconciliation_interrupted');
    const source = raw.attempts.find(value => value.id === input.attemptId);
    if (!source || source.effect !== 'write' || !['unknown', 'partial', 'failed'].includes(source.status) || source.adopted ||
      !raw.obligations.some(value => value.id === `effect:${input.attemptId}` && value.kind === 'effect_reconciliation' && value.status === 'pending') ||
      raw.attempts.some(value => ['reserved', 'running', 'received'].includes(value.status)) ||
      raw.modelCalls.some(value => ['reserved', 'running', 'received'].includes(value.status)) ||
      raw.computerReconciliations?.some(value => ['reserved', 'running', 'received'].includes(value.status))) fail('computer_reconciliation_source_not_ready');
    if ((raw.computerReconciliations?.length ?? 0) >= 1000) fail('computer_reconciliation_limit');
    const selected = this.selected(view, source.id);
    const basis = await this.computer.reconciliationBasis(view, source.id, selected.binding, selected.act.tool.definition);
    if (basis.head.id !== input.checkpointId) fail('computer_reconciliation_head_changed');
    if (!(await knowledgeInputsCurrent(this.services, view))) fail('computer_reconciliation_knowledge_changed');
    const limit = effectiveExecutionLimits(raw).toolCalls;
    if (raw.budget.used.toolCalls + raw.budget.reservedToolCalls >= limit) fail('tool_budget_exhausted');
    await assertBudgetAuthority(this.services, raw, { toolCalls: 1 });
    const now = this.services.clock.now(); const deadline = Math.min(raw.deadlineAt, now + Math.min(this.runtime.leaseMs, selected.binding.limits.maxDurationMs));
    const intent = ComputerReconciliationIntentSchema.parse({ schemaVersion: 1, kind: 'computer_reconciliation_intent', workId, reconciliationId: id, actor,
      sourceAttemptId: source.id, sourceHead: basis.head, sourceResultArtifact: source.resultArtifact, identity: basis.identity, stepIndex: basis.stepIndex,
      driver: selected.binding.identity, contractDigest: source.contractDigest, goalRevision: raw.goal.revision, policyDigest: this.digest(raw.policy),
      generation: dataGeneration(raw), originalDeadlineAt: basis.checkpoint.deadlineAt, readDeadlineAt: deadline, createdAt: now });
    const requestArtifact = await this.put(view, intent, selected.binding.labels);
    const record = ComputerReconciliationSchema.parse({ id, sourceAttemptId: source.id, obligationId: `effect:${source.id}`, sourceHead: basis.head,
      sourceResultArtifact: source.resultArtifact, requestArtifact, responseArtifact: null, proofArtifact: null, operationId: basis.identity.operationId,
      stepIndex: basis.stepIndex, goalRevision: raw.goal.revision, policyDigest: this.digest(raw.policy), generation: dataGeneration(raw),
      contractDigest: source.contractDigest, driver: selected.binding.identity, owner: this.runtime.owner, leaseUntil: deadline, createdAt: now,
      dispatchedAt: null, finishedAt: null, status: 'reserved', execution: toolExecution('not_invoked'), reason: null, outcome: null, effectState: 'unknown' });
    const reserved = await transact(this.services, workId, `reconcile-reserve:${id}`, 'computer_reconciliation_reserved',
      asJson({ actor, input, sourceHead: basis.head, requestArtifact, operationId: record.operationId }), next => {
        if (next.revision !== raw.revision) fail('computer_reconciliation_state_changed');
        next.computerReconciliations ??= []; next.computerReconciliations.push(record); next.budget.reservedToolCalls++;
      }, async () => {
        const current = await this.load(workId, actor);
        if (current.raw.revision !== raw.revision || !(await knowledgeInputsCurrent(this.services, current.view)) || this.services.clock.now() >= deadline) fail('computer_reconciliation_state_changed');
        this.selected(current.view, source.id); await assertBudgetAuthority(this.services, current.raw, { toolCalls: 1 });
        if (!this.same(await this.read(current.view, requestArtifact, value => ComputerReconciliationIntentSchema.parse(value)), intent)) fail('computer_reconciliation_intent_changed');
      });
    return this.record(reserved.state, id);
  }
  private async failure(workId: string, id: string, reason: string, execution?: ToolExecution): Promise<ComputerReconciliation> {
    const current = await this.services.state.get(workId); if (!current) fail('work_not_found');
    const prior = this.record(current, id); if (['received', 'settled', 'failed'].includes(prior.status) && reason === 'computer_reconciliation_execution_failed' || ['settled', 'failed'].includes(prior.status)) return prior;
    const result = await transact(this.services, workId, `reconcile-fail:${id}:${reason}`, 'computer_reconciliation_failed', { id, reason }, state => {
      const record = this.record(state, id); if (record.status === 'failed' || record.status === 'settled') return;
      if (record.status === 'received' && reason === 'computer_reconciliation_execution_failed') return;
      if (record.status === 'reserved') state.budget.reservedToolCalls--;
      record.status = 'failed'; record.finishedAt ??= this.services.clock.now(); record.reason = reason;
      if (execution && record.responseArtifact === null) record.execution = execution;
      const obligation = state.obligations.find(value => value.id === record.obligationId); if (obligation) obligation.status = 'pending';
    });
    return this.record(result.state, id);
  }
  async execute(workId: string, id: string, actor: WorkActor): Promise<ComputerReconciliation> {
    actor = parseActor(actor);
    return this.single(JSON.stringify(['execute', workId, id]), actor, async () => {
      const observed = await this.inspect(workId, id, actor);
      if (observed.status === 'reserved' && observed.owner !== this.runtime.owner) fail('computer_reconciliation_owner_changed');
      return this.executeOnce(workId, id, actor);
    });
  }
  private async executeOnce(workId: string, id: string, actor: WorkActor): Promise<ComputerReconciliation> {
    let initial = (await this.load(workId, actor)).raw; let record = this.record(initial, id);
    if (record.status !== 'reserved') return structuredClone(record);
    const controller = new AbortController(); let unregister = () => {}; let lease: ComputerLease | null = null;
    let binding: BoundComputerBinding | null = null; let timer: ReturnType<typeof setTimeout> | undefined;
    let execution = toolExecution('not_invoked');
    try {
      const guard = await this.guard(workId, id, actor); initial = guard.raw; record = guard.record;
      if (record.owner !== this.runtime.owner) fail('computer_reconciliation_owner_changed');
      const dispatched = await transact(this.services, workId, `reconcile-dispatch:${id}`, 'computer_reconciliation_dispatched', asJson({ id, requestArtifact: record.requestArtifact }), state => {
        if (state.revision !== initial.revision || this.record(state, id).status !== 'reserved') fail('computer_reconciliation_state_changed');
        const next = this.record(state, id); next.status = 'running'; next.dispatchedAt = this.services.clock.now(); next.execution = toolExecution('unreported');
        state.budget.reservedToolCalls--; state.budget.used.toolCalls++;
      }, async () => { await this.guard(workId, id, actor); });
      if (!dispatched.committed) return this.record(dispatched.state, id);
      unregister = this.runtime.registerCancellation(workId, JSON.stringify([workId, id]), controller);
      timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(2147483647, record.leaseUntil - this.services.clock.now())));
      const current = await this.guard(workId, id, actor, controller.signal); binding = this.selected(current.view, record.sourceAttemptId).binding;
      const acquiredBinding = binding;
      const acquisition = binding.driver.acquire({ sessionId: binding.sessionId, workId, attemptId: id, deadlineAt: record.leaseUntil }, controller.signal);
      void acquisition.then(async value => {
        if (controller.signal.aborted) { const parsed = ComputerLeaseSchema.safeParse(value); if (parsed.success) await this.release(acquiredBinding, parsed.data); }
      }).catch(() => {});
      lease = ComputerLeaseSchema.parse(await this.bounded(acquisition, controller.signal));
      if (lease.workId !== workId || lease.attemptId !== id || lease.sessionId !== binding.sessionId || lease.expiresAt > record.leaseUntil ||
        this.services.clock.now() >= lease.expiresAt) fail('computer_reconciliation_lease_changed');
      await this.guard(workId, id, actor, controller.signal);
      execution = toolExecution('invoked', unknown());
      const call = binding.driver.lookup!(lease, { identity: structuredClone(current.intent.identity) }, controller.signal,
        async () => { await this.guard(workId, id, actor, controller.signal); });
      const response: unknown = await this.bounded(call, controller.signal);
      const usage = response && typeof response === 'object' ? ToolUsageSchema.safeParse((response as { usage?: unknown }).usage) : null;
      execution = toolExecution('invoked', usage?.success ? usage.data : unknown());
      const result = ComputerOperationLookupResultSchema.parse(response);
      const basis = await this.guard(workId, id, actor, controller.signal);
      if (result.status === 'found' && (!this.same(result.receipt.identity, basis.intent.identity) || !this.same(result.receipt.driver, binding.identity) ||
        result.receipt.decidedAt > this.services.clock.now() || (result.receipt.outcome === 'applied' && result.receipt.decidedAt >= basis.intent.originalDeadlineAt))) fail('computer_reconciliation_receipt_changed');
      const raw = ComputerReconciliationResponseSchema.parse({ schemaVersion: 1, kind: 'computer_reconciliation_response', workId, reconciliationId: id,
        request: record.requestArtifact, lease, respondedAt: this.services.clock.now(), result });
      const responseArtifact = await this.put(basis.view, raw, binding.labels);
      const received = await transact(this.services, workId, `reconcile-receive:${id}`, 'computer_reconciliation_response_stored', asJson({ id, responseArtifact }), state => {
        const next = this.record(state, id); if (next.status !== 'running' || state.revision !== basis.raw.revision) fail('computer_reconciliation_state_changed');
        next.status = 'received'; next.responseArtifact = responseArtifact; next.finishedAt = raw.respondedAt; next.execution = execution;
        next.outcome = result.status === 'found' ? result.receipt.outcome : 'unknown';
      }, async () => {
        const latest = await this.guard(workId, id, actor, controller.signal);
        if (!this.same(await this.read(latest.view, responseArtifact, value => ComputerReconciliationResponseSchema.parse(value)), raw)) fail('computer_reconciliation_response_changed');
      });
      return this.record(received.state, id);
    } catch { return this.failure(workId, id, 'computer_reconciliation_execution_failed', execution); }
    finally {
      if (timer) clearTimeout(timer); unregister();
      if (lease && binding) await this.release(binding, lease);
    }
  }
  private async proof(state: WorkState, record: ComputerReconciliation) {
    const intent = await this.intent(state, record);
    if (!record.responseArtifact || record.dispatchedAt === null || record.finishedAt === null) fail('computer_reconciliation_response_missing');
    const response = await this.read(state, record.responseArtifact, value => ComputerReconciliationResponseSchema.parse(value));
    if (response.workId !== state.id || response.reconciliationId !== record.id || !this.same(response.request, record.requestArtifact) ||
      response.lease.workId !== state.id || response.lease.attemptId !== record.id || response.lease.sessionId !== intent.identity.sessionId ||
      response.lease.expiresAt > record.leaseUntil || response.respondedAt !== record.finishedAt || response.respondedAt < record.dispatchedAt ||
      response.respondedAt >= Math.min(record.leaseUntil, response.lease.expiresAt) || !this.same(record.execution, toolExecution('invoked', response.result.usage))) fail('computer_reconciliation_response_changed');
    if (response.result.status !== 'found') fail('computer_reconciliation_unresolved');
    const dispatched = await this.services.state.receipt(state.id, `reconcile-dispatch:${record.id}`);
    const dispatchedRecord = dispatched?.state.computerReconciliations?.find(value => value.id === record.id);
    const received = await this.services.state.receipt(state.id, `reconcile-receive:${record.id}`);
    const receivedRecord = received?.state.computerReconciliations?.find(value => value.id === record.id);
    if (!dispatched || !dispatchedRecord || dispatchedRecord.status !== 'running' || !this.same(this.basis(dispatchedRecord), this.basis(record)) ||
      dispatchedRecord.dispatchedAt !== record.dispatchedAt || dispatched.digest !== this.digest({ type: 'computer_reconciliation_dispatched', data: { id: record.id, requestArtifact: record.requestArtifact } }) ||
      !received || !receivedRecord || receivedRecord.status !== 'received' || !this.same(this.basis(receivedRecord), this.basis(record)) ||
      !this.same(receivedRecord.responseArtifact, record.responseArtifact) || !this.same(receivedRecord.execution, record.execution) ||
      receivedRecord.finishedAt !== record.finishedAt || receivedRecord.outcome !== record.outcome || receivedRecord.dispatchedAt !== record.dispatchedAt ||
      received.digest !== this.digest({ type: 'computer_reconciliation_response_stored', data: { id: record.id, responseArtifact: record.responseArtifact } })) fail('computer_reconciliation_response_unproven');
    const receipt = response.result.receipt;
    if (!this.same(receipt.identity, intent.identity) || !this.same(receipt.driver, intent.driver) || (receipt.outcome === 'applied' && receipt.decidedAt >= intent.originalDeadlineAt) ||
      receipt.decidedAt > response.respondedAt) fail('computer_reconciliation_receipt_changed');
    const source = await this.source(state, record);
    const effectState = receipt.outcome === 'applied' || source.checkpoint.steps.some(step => step.status === 'applied') ? 'confirmed' as const : 'none' as const;
    return ComputerReconciliationProofSchema.parse({ schemaVersion: 1, kind: 'computer_reconciliation_proof', workId: state.id, reconciliationId: record.id,
      sourceAttemptId: record.sourceAttemptId, sourceHead: record.sourceHead, request: record.requestArtifact, response: record.responseArtifact,
      operationId: record.operationId, stepIndex: record.stepIndex, outcome: receipt.outcome, effectState, confirmedAt: record.finishedAt });
  }
  async settle(workId: string, id: string, actor: WorkActor): Promise<ComputerReconciliation> {
    actor = parseActor(actor);
    return this.single(JSON.stringify(['settle', workId, id]), actor, () => this.settleOnce(workId, id, actor));
  }
  private async settleOnce(workId: string, id: string, actor: WorkActor): Promise<ComputerReconciliation> {
    const observed = await this.inspect(workId, id, actor);
    if (observed.status !== 'received') return observed;
    try {
      const { raw, view, record } = await this.guard(workId, id, actor, undefined, true); const proof = await this.proof(view, record);
      const selected = this.selected(view, record.sourceAttemptId); const proofArtifact = await this.put(view, proof, selected.binding.labels);
      const result = await transact(this.services, workId, `reconcile-settle:${id}`, 'computer_reconciliation_settled', asJson({ id, proofArtifact }), state => {
        if (state.revision !== raw.revision) fail('computer_reconciliation_state_changed'); const next = this.record(state, id);
        if (next.status !== 'received') fail('computer_reconciliation_not_received');
        next.status = 'settled'; next.proofArtifact = proofArtifact; next.outcome = proof.outcome; next.effectState = proof.effectState; next.reason = null;
        const obligation = state.obligations.find(value => value.id === next.obligationId && value.kind === 'effect_reconciliation');
        if (!obligation) fail('computer_reconciliation_obligation_missing'); obligation.status = 'satisfied';
        captureProgress(state, this.services.digester, `reconcile-settle:${id}`, this.services.clock.now(), {
          additionalKeys: [`computer-effect:${this.digest({ sourceAttemptId: record.sourceAttemptId, operationId: record.operationId, outcome: proof.outcome })}`],
        });
        if (state.status === 'blocked' && state.statusReason === 'effect_unknown') { state.status = 'ready'; state.statusReason = 'computer_effect_reconciled'; }
      }, async () => {
        const latest = await this.guard(workId, id, actor, undefined, true);
        if (!(await this.proof(latest.view, latest.record)) || this.selected(latest.view, record.sourceAttemptId) !== selected) fail('computer_reconciliation_proof_changed');
        if (!this.same(await this.read(latest.view, proofArtifact, value => ComputerReconciliationProofSchema.parse(value)), proof)) fail('computer_reconciliation_proof_changed');
      });
      return this.record(result.state, id);
    } catch { return this.failure(workId, id, 'computer_reconciliation_unresolved'); }
  }
  async reconcile(workId: string, commandId: string, actor: WorkActor, input: { attemptId: string; checkpointId: string }): Promise<ComputerReconciliation> {
    const reserved = await this.reserve(workId, commandId, actor, input);
    await this.execute(workId, reserved.id, actor); return this.settle(workId, reserved.id, actor);
  }
  /** Authenticate stored effects without following knowledge dependencies back into their source work. */
  async proofsCurrent(state: WorkState): Promise<boolean> {
    const records = state.computerReconciliations ?? [];
    if (!records.some(record => record.status === 'settled' || record.proofArtifact !== null)) return true;
    try {
      const sourceClaim = (record: ComputerReconciliation) => ({ sourceAttemptId: record.sourceAttemptId, sourceHead: record.sourceHead,
        sourceResultArtifact: record.sourceResultArtifact, operationId: record.operationId, stepIndex: record.stepIndex,
        goalRevision: record.goalRevision, policyDigest: record.policyDigest, generation: record.generation,
        contractDigest: record.contractDigest, driver: record.driver, outcome: record.outcome, effectState: record.effectState });
      // Invalidating a proof must not remove the dependency of copied evidence on the original effect.
      for (const prior of records) if (prior.proofArtifact && prior.status !== 'settled' &&
        !records.some(record => record.status === 'settled' && this.same(sourceClaim(prior), sourceClaim(record)))) return false;
      for (const record of records) if (record.status === 'settled' && !(await this.proofCurrent(state, record.id))) return false;
      return (await this.services.state.get(state.id))?.revision === state.revision;
    } catch { return false; }
  }
  /** Validate one exact source proof without walking unrelated descendant reconciliations. */
  async proofCurrent(state: WorkState, id: string): Promise<boolean> {
    try {
      const record = state.computerReconciliations?.find(item => item.id === id);
      if (!record || record.status !== 'settled' || record.policyDigest !== this.digest(state.policy) ||
        record.generation !== dataGeneration(state) || !record.proofArtifact ||
        !state.obligations.some(value => value.id === record.obligationId && value.status === 'satisfied')) return false;
      const proof = await this.proof(state, record); const stored = await this.read(state, record.proofArtifact, value => ComputerReconciliationProofSchema.parse(value));
      if (!this.same(proof, stored) || proof.outcome !== record.outcome || proof.effectState !== record.effectState) return false;
      const settlement = await this.services.state.receipt(state.id, `reconcile-settle:${record.id}`);
      const settled = settlement?.state.computerReconciliations?.find(value => value.id === record.id);
      return !!settlement && !!settled && this.same(settled, record) && settlement.digest === this.digest({ type: 'computer_reconciliation_settled',
        data: { id: record.id, proofArtifact: record.proofArtifact } }) && (await this.services.state.get(state.id))?.revision === state.revision;
    } catch { return false; }
  }
  async current(state: WorkState): Promise<boolean> {
    if (!state.computerReconciliations?.some(record => record.status === 'settled' || record.proofArtifact !== null)) return true;
    if (!(await this.proofsCurrent(state))) return false;
    try {
      return await knowledgeInputsCurrent(this.services, state) && (await this.services.state.get(state.id))?.revision === state.revision;
    } catch { return false; }
  }
  async refresh(workId: string): Promise<WorkState> {
    for (let retry = 0; retry < 8; retry++) {
      try { return await this.refreshOnce(workId); }
      catch (error) { if (!(error instanceof Error && error.message === 'computer_reconciliation_state_changed')) throw error; }
    }
    return fail('computer_reconciliation_contention');
  }
  private async refreshOnce(workId: string): Promise<WorkState> {
    const state = await this.services.state.get(workId); if (!state) fail('work_not_found');
    const invalid = !(await this.current(state)); const now = this.services.clock.now();
    const expired = (state.computerReconciliations ?? []).filter(record => ['reserved', 'running'].includes(record.status) && record.leaseUntil <= now);
    if ((!invalid || !state.computerReconciliations?.some(record => record.status === 'settled')) && !expired.length) return state;
    const result = await transact(this.services, workId, `reconcile-refresh:${state.revision}`, 'computer_reconciliation_refreshed',
      { revision: state.revision, invalid, expired: expired.map(record => record.id) }, next => {
        if (next.revision !== state.revision) fail('computer_reconciliation_state_changed');
        for (const record of next.computerReconciliations ?? []) {
          if (!(invalid && record.status === 'settled') && !expired.some(value => value.id === record.id)) continue;
          if (record.status === 'reserved') next.budget.reservedToolCalls--;
          record.status = 'failed'; record.finishedAt ??= now; record.reason = invalid ? 'effect_proof_unavailable' : 'computer_reconciliation_expired';
          const obligation = next.obligations.find(value => value.id === record.obligationId); if (obligation) obligation.status = 'pending';
          else next.obligations.push({ id: record.obligationId, kind: 'effect_reconciliation', reason: 'dispatched_effect_requires_reconciliation', status: 'pending', wakeKey: null, dueAt: null });
        }
        if (invalid) cancelBudgetReservations(next, now);
      });
    if (invalid || expired.length) this.runtime.interrupt(workId);
    return result.state;
  }
}
