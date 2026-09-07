import type { ArtifactRef, Attempt, ToolResult, WorkState } from '../domain/model.js';
import { dataGeneration, visibleArtifact } from '../domain/data-lifecycle.js';
import type { StoredToolResult } from './ports.js';
import type { RuntimeServices } from './services.js';
import type { RegisteredTool, ToolContracts } from './tool-contracts.js';
import { assertExecutionAuthority } from './execution-authority.js';
import { validateEvidence } from './evidence-intake.js';
import { knowledgeInputsCurrent } from './knowledge-validity.js';
import { sessionInputsCurrent, sameSessionInput } from './session-context.js';
import { asJson, taskDigest } from './plan-validator.js';
import { frozen } from './resource-contracts.js';
import { StoredToolUsages } from './stored-tool-usage.js';
import { mergeToolExecution, toolExecution } from './tool-execution-usage.js';

type Available = Extract<StoredToolResult, { kind: 'available' }>;
export interface StoredToolResultTicket {
  readonly workId: string;
  readonly attemptId: string;
  readonly result: ToolResult;
  readonly receivedAt: number;
  readonly receipt: Available['receipt'];
}
interface Proof {
  entry: RegisteredTool;
  stateDigest: string;
  sourceDigest: string;
  restoredDigest: string;
}
const MAX_RAW_BYTES = 512 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const terminal = new Set<WorkState['status']>(['cancelled', 'paused', 'failed', 'completed']);
function fail(code = 'stored_result_invalid'): never { throw new Error(code); }
function unknownExecution(attempt: Attempt): boolean {
  const execution = attempt.execution;
  return !execution || execution.mode === 'unreported' && execution.implementationCalls === null &&
    Object.values(execution.usage).every(value => value === null);
}
function identity(attempt: Attempt) {
  return { id: attempt.id, taskId: attempt.taskId, planRevision: attempt.planRevision, goalRevision: attempt.goalRevision,
    toolId: attempt.toolId, toolVersion: attempt.toolVersion, inputDigest: attempt.inputDigest, scope: attempt.scope,
    contractDigest: attempt.contractDigest ?? null, owner: attempt.owner, startedAt: attempt.startedAt, leaseUntil: attempt.leaseUntil,
    effect: attempt.effect, effectState: attempt.effectState };
}

/** Reads and revalidates durable custody; it cannot dispatch, store results, settle usage or adopt evidence. */
export class StoredToolResults {
  readonly #issued = new WeakMap<StoredToolResultTicket, Proof>();
  constructor(readonly services: RuntimeServices, readonly contracts: ToolContracts) {}
  private digest(value: unknown) { return this.services.digester.digest(asJson(value)); }
  private same(left: unknown, right: unknown) { return this.digest(left) === this.digest(right); }

  /** Metadata prefilter only. Invoked candidates still require a source-bound accounting receipt in prepare. */
  candidate(state: WorkState, attemptId: string): boolean {
    const index = state.attempts.findIndex(attempt => attempt.id === attemptId), attempt = state.attempts[index];
    if (!attempt || terminal.has(state.status) || attempt.effect !== 'read' || attempt.effectState !== 'none' ||
        !(attempt.status === 'running' && attempt.error === null || attempt.status === 'failed' && attempt.error?.code === 'lease_expired') ||
        attempt.resultId !== null || attempt.resultArtifact !== null || attempt.adopted ||
        !(unknownExecution(attempt) || attempt.execution?.mode === 'invoked' && this.contracts.get(attempt.toolId, attempt.toolVersion)?.tool.restoreUsage) ||
        attempt.readProgress || attempt.computerUse || attempt.reuse || attempt.effectReceipt || !attempt.contractDigest || !state.plan ||
        attempt.goalRevision !== state.goal.revision || attempt.scope !== state.goal.scope || attempt.planRevision !== state.plan.revision ||
        state.plan.goalRevision !== state.goal.revision || state.attempts.slice(index + 1).some(next => next.taskId === attempt.taskId)) return false;
    const task = state.plan.tasks.find(value => value.id === attempt.taskId);
    if (!task || task.effect !== 'read' || task.readResume || task.computerResume || taskDigest(task, this.services.digester) !== attempt.inputDigest) return false;
    const entry = this.contracts.get(attempt.toolId, attempt.toolVersion), definition = entry?.tool.definition;
    return !!entry?.tool.restoreResult && !!entry.tool.validateResult && !!definition && definition.effect === 'read' &&
      definition.resultValidation === 'artifact-proof-v1' && !definition.collection && !definition.reuse &&
      !definition.computerContinuation && !definition.computerInputAssurance && this.digest(definition) === attempt.contractDigest &&
      task.toolId === attempt.toolId && task.toolVersion === attempt.toolVersion;
  }

  private async current(state: WorkState, attemptId: string, entry: RegisteredTool): Promise<void> {
    if (state.status === 'blocked') fail('stored_result_work_blocked');
    if (!this.candidate(state, attemptId) || this.contracts.get(entry.tool.definition.id, entry.tool.definition.version) !== entry)
      fail('stored_result_changed');
    assertExecutionAuthority(this.services, state);
    const task = state.plan!.tasks.find(value => value.id === state.attempts.find(attempt => attempt.id === attemptId)!.taskId)!;
    if (this.contracts.check(task, state.policy)) fail('stored_result_permission_denied');
    if (!(await sessionInputsCurrent(this.services, state)) || !(await knowledgeInputsCurrent(this.services, state)))
      fail('stored_result_source_changed');
    if (!this.same(await this.services.state.get(state.id), state) ||
        this.contracts.get(entry.tool.definition.id, entry.tool.definition.version) !== entry) fail('stored_result_changed');
    assertExecutionAuthority(this.services, state);
  }

  private async original(ref: ArtifactRef, state: WorkState): Promise<void> {
    if (!visibleArtifact(state, ref) || ref.byteLength > MAX_RAW_BYTES ||
        !state.artifacts.some(value => this.same(value, ref))) fail('stored_result_original_unavailable');
    const bytes = await this.services.artifacts.get(structuredClone(ref), structuredClone(state.policy));
    if (bytes.byteLength !== ref.byteLength) fail('stored_result_original_unavailable');
    const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
    if (Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('') !== ref.sha256)
      fail('stored_result_original_unavailable');
  }

  private async accounting(state: WorkState, attempt: Attempt) {
    if (unknownExecution(attempt)) return null;
    const ticket = await new StoredToolUsages(this.services, this.contracts).prepare(state, attempt.id);
    if (!ticket) fail('stored_result_usage_unproven');
    const source = this.digest({ receipt: ticket.receipt, usage: ticket.usage });
    const commandId = `tool-usage:${attempt.id}:${source}`;
    const receipt = await this.services.state.receipt(state.id, commandId);
    const accounted = receipt?.state.attempts.find(value => value.id === attempt.id);
    if (!receipt || receipt.digest !== this.digest({ type: 'tool_execution_usage_recorded', data: { attemptId: attempt.id, source } }) ||
        receipt.state.id !== state.id || receipt.state.createdAt !== state.createdAt || receipt.state.revision > state.revision ||
        receipt.state.policy.tenantId !== state.policy.tenantId || receipt.state.policy.principalId !== state.policy.principalId ||
        dataGeneration(receipt.state) !== dataGeneration(state) || receipt.state.updatedAt > state.updatedAt ||
        !accounted || !accounted.execution || receipt.state.attempts.filter(value => value.id === attempt.id).length !== 1 ||
        !this.same(identity(accounted), identity(attempt)) || accounted.resultId !== null || accounted.resultArtifact !== null || accounted.adopted ||
        !(accounted.status === 'running' && accounted.error === null || accounted.status === 'failed' && accounted.error?.code === 'lease_expired') ||
        !this.same(accounted.execution, attempt.execution) ||
        !this.same(mergeToolExecution(accounted.execution, toolExecution('invoked', ticket.usage)), attempt.execution))
      fail('stored_result_usage_unproven');
    return { commandId, receipt, ticket };
  }

  private async inspect(state: WorkState, attemptId: string): Promise<{ restored: Available; proof: Proof } | null> {
    if (!this.candidate(state, attemptId)) fail('stored_result_not_eligible');
    const attempt = state.attempts.find(value => value.id === attemptId)!;
    const entry = this.contracts.get(attempt.toolId, attempt.toolVersion)!;
    await this.current(state, attemptId, entry);
    const dispatch = await this.services.state.receipt(state.id, `dispatch:${attemptId}`);
    const recovery = await this.services.state.receipt(state.id, `recover:${attemptId}`);
    const [received, adopted] = await Promise.all([
      this.services.state.receipt(state.id, `receive:${attemptId}`), this.services.state.receipt(state.id, `adopt:${attemptId}`),
    ]);
    if (received || adopted || !dispatch || dispatch.state.id !== state.id || dispatch.state.revision > state.revision ||
        dispatch.digest !== this.digest({ type: 'attempt_dispatched', data: { attemptId, owner: attempt.owner } })) fail();
    const sent = dispatch.state.attempts.find(value => value.id === attemptId);
    const task = dispatch.state.plan?.tasks.find(value => value.id === attempt.taskId);
    if (!sent || sent.status !== 'running' || sent.resultArtifact !== null || sent.resultId !== null || sent.adopted ||
        !unknownExecution(sent) || !this.same(identity(sent), identity(attempt)) || !task ||
        !this.same(dispatch.state.goal, state.goal) || !this.same(dispatch.state.plan, state.plan) ||
        !this.same(dispatch.state.policy, state.policy) || dataGeneration(dispatch.state) !== dataGeneration(state) ||
        !sameSessionInput(dispatch.state.conversation?.session, state.conversation?.session) ||
        taskDigest(task, this.services.digester) !== attempt.inputDigest) fail();
    const accounting = await this.accounting(state, attempt);
    if (accounting) await this.current(state, attemptId, entry);
    if (attempt.status === 'failed') {
      const recovered = recovery?.state.attempts.find(value => value.id === attemptId);
      if (!recovery || recovery.state.id !== state.id || recovery.state.revision > state.revision || recovery.state.revision <= dispatch.state.revision ||
          recovery.digest !== this.digest({ type: 'attempt_recovered', data: { attemptId } }) || !recovered ||
          !this.same(accounting ? { ...recovered, execution: attempt.execution } : recovered, attempt) ||
          (accounting && !unknownExecution(recovered) && !this.same(recovered.execution, attempt.execution)) ||
          recovered.status !== 'failed' || recovered.error?.code !== 'lease_expired' ||
          !this.same(recovery.state.goal, dispatch.state.goal) || !this.same(recovery.state.plan, dispatch.state.plan) ||
          !this.same(recovery.state.policy, dispatch.state.policy) || dataGeneration(recovery.state) !== dataGeneration(state) ||
          !sameSessionInput(recovery.state.conversation?.session, dispatch.state.conversation?.session) ||
          recovery.state.updatedAt < attempt.leaseUntil) fail();
    } else if (recovery) fail();
    const restored = await this.contracts.restoreResult(state, { attemptId, task });
    await this.current(state, attemptId, entry);
    if (restored.kind === 'absent') return null;
    if (new TextEncoder().encode(JSON.stringify(restored.result)).byteLength > MAX_RESULT_BYTES) fail('stored_result_too_large');
    const response = await this.services.state.receipt(state.id, restored.receipt.commandId);
    const responded = response?.state.attempts.find(value => value.id === attemptId);
    if (!response || response.state.id !== state.id || response.digest !== restored.receipt.digest ||
        response.state.revision <= dispatch.state.revision || response.state.revision > state.revision ||
        recovery && response.state.revision >= recovery.state.revision || !responded || responded.status !== 'running' ||
        responded.resultArtifact !== null || responded.resultId !== null || responded.adopted || !unknownExecution(responded) ||
        !this.same(identity(responded), identity(sent)) || !this.same(response.state.goal, dispatch.state.goal) ||
        !this.same(response.state.plan, dispatch.state.plan) || !this.same(response.state.policy, dispatch.state.policy) ||
        dataGeneration(response.state) !== dataGeneration(state) ||
        !sameSessionInput(response.state.conversation?.session, dispatch.state.conversation?.session) ||
        !response.state.artifacts.some(ref => this.same(ref, restored.receipt.artifact))) fail();
    if (accounting && (!this.same(accounting.ticket.receipt, restored.receipt) || accounting.ticket.receivedAt !== restored.receivedAt ||
        accounting.receipt.state.revision <= response.state.revision || accounting.receipt.state.updatedAt < response.state.updatedAt ||
        !this.same(mergeToolExecution(attempt.execution, toolExecution('invoked', restored.result.usage)), attempt.execution)))
      fail('stored_result_usage_unproven');
    // These are captured preparation timestamps, not a claim about the physical commit instant.
    if (sent.startedAt > dispatch.state.updatedAt || dispatch.state.updatedAt > restored.receivedAt ||
        restored.receivedAt > response.state.updatedAt || response.state.updatedAt > state.updatedAt ||
        response.state.updatedAt >= Math.min(sent.leaseUntil, dispatch.state.deadlineAt) ||
        this.services.clock.now() < Math.max(state.updatedAt, restored.receivedAt)) fail('stored_result_time_invalid');
    await this.original(restored.receipt.artifact, state);
    validateEvidence(restored.result, attempt, state, this.services.digester);
    if ((restored.result.status === 'success' || restored.result.status === 'partial') && !entry.output(restored.result.output)) fail();
    if (restored.result.knowledgeDependencies?.length && (!this.services.knowledge ||
        !(await this.services.knowledge.validate(restored.result.knowledgeDependencies, state.id, state.policy)))) fail('stored_result_source_changed');
    if (restored.result.inputDependencies?.length && (!this.services.inputs ||
        !(await this.services.inputs.validate(restored.result.inputDependencies, state)))) fail('stored_result_source_changed');
    for (const ref of [...restored.result.artifacts, ...restored.result.evidence.flatMap(value => value.artifact ? [value.artifact] : [])])
      if (!visibleArtifact(state, ref) || !(await this.services.artifacts.exists(ref))) fail('stored_result_original_unavailable');
    if (!(await this.contracts.validateResult(state, restored.result))) fail('stored_result_proof_invalid');
    await this.original(restored.receipt.artifact, state);
    const [latestDispatch, latestRecovery, latestResponse, latestReceived, latestAdopted, latestAccounting] = await Promise.all([
      this.services.state.receipt(state.id, `dispatch:${attemptId}`), this.services.state.receipt(state.id, `recover:${attemptId}`),
      this.services.state.receipt(state.id, restored.receipt.commandId), this.services.state.receipt(state.id, `receive:${attemptId}`),
      this.services.state.receipt(state.id, `adopt:${attemptId}`),
      accounting ? this.services.state.receipt(state.id, accounting.commandId) : Promise.resolve(null),
    ]);
    if (latestReceived || latestAdopted || !this.same({ dispatch, recovery, response, accounting: accounting?.receipt ?? null },
      { dispatch: latestDispatch, recovery: latestRecovery, response: latestResponse, accounting: latestAccounting })) fail('stored_result_changed');
    await this.current(state, attemptId, entry);
    const sourceDigest = this.digest({ dispatch, recovery, response, accounting: accounting?.receipt ?? null });
    return { restored, proof: { entry, stateDigest: this.digest(state), sourceDigest, restoredDigest: this.digest(restored) } };
  }

  async prepare(state: WorkState, attemptId: string): Promise<StoredToolResultTicket | null> {
    const captured = structuredClone(state), inspected = await this.inspect(captured, attemptId);
    if (!inspected) return null;
    const { restored, proof } = inspected;
    const ticket = frozen({ workId: captured.id, attemptId, result: structuredClone(restored.result),
      receivedAt: restored.receivedAt, receipt: structuredClone(restored.receipt) });
    this.#issued.set(ticket, proof); return ticket;
  }

  async assertCurrent(state: WorkState, ticket: StoredToolResultTicket): Promise<void> {
    const expected = this.#issued.get(ticket);
    if (!expected || ticket.workId !== state.id || this.digest(state) !== expected.stateDigest) fail('stored_result_ticket_invalid');
    const inspected = await this.inspect(structuredClone(state), ticket.attemptId);
    if (!inspected || inspected.proof.entry !== expected.entry || inspected.proof.sourceDigest !== expected.sourceDigest ||
        inspected.proof.restoredDigest !== expected.restoredDigest || inspected.proof.stateDigest !== expected.stateDigest)
      fail('stored_result_changed');
  }
}
