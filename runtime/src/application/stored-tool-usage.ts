import type { ArtifactRef, Attempt, WorkState } from '../domain/model.js';
import { artifactBlocked, dataGeneration, visibleArtifact } from '../domain/data-lifecycle.js';
import type { StoredToolUsage } from './ports.js';
import type { RuntimeServices } from './services.js';
import type { RegisteredTool, ToolContracts } from './tool-contracts.js';
import { asJson, taskDigest } from './plan-validator.js';
import { frozen } from './resource-contracts.js';
import { isEndedToolReservation } from './tool-execution-usage.js';

type Available = Extract<StoredToolUsage, { kind: 'available' }>;
type Services = Pick<RuntimeServices, 'state' | 'artifacts' | 'digester' | 'clock'>;
export interface StoredToolUsageTicket {
  readonly workId: string;
  readonly attemptId: string;
  readonly usage: Available['usage'];
  readonly receivedAt: number;
  readonly receipt: Available['receipt'];
  readonly custodyOnly: boolean;
  readonly responseObserved: boolean;
}
interface Proof { entry: RegisteredTool; stateDigest: string; sourceDigest: string; restoredDigest: string }
const MAX_RAW_BYTES = 512 * 1024;
function fail(code = 'stored_usage_invalid'): never { throw new Error(code); }
function identity(attempt: Attempt) {
  return { id: attempt.id, taskId: attempt.taskId, planRevision: attempt.planRevision, goalRevision: attempt.goalRevision,
    toolId: attempt.toolId, toolVersion: attempt.toolVersion, inputDigest: attempt.inputDigest, scope: attempt.scope,
    contractDigest: attempt.contractDigest ?? null, owner: attempt.owner, startedAt: attempt.startedAt, leaseUntil: attempt.leaseUntil,
    effect: attempt.effect, effectState: attempt.effectState, readProgress: attempt.readProgress ?? null,
    reuse: attempt.reuse ?? null, computerUse: attempt.computerUse ?? null, effectReceipt: attempt.effectReceipt ?? null };
}

/** Host-internal custody inspection only: no model body, writes, dispatch, adoption or settlement. */
export class StoredToolUsages {
  readonly #issued = new WeakMap<StoredToolUsageTicket, Proof>();
  constructor(readonly services: Services, readonly contracts: ToolContracts) {}
  private digest(value: unknown) { return this.services.digester.digest(asJson(value)); }
  private same(left: unknown, right: unknown) { return this.digest(left) === this.digest(right); }

  /** Current execution permission is intentionally irrelevant to accounting for an original dispatch. */
  candidate(state: WorkState, attemptId: string): boolean {
    const matches = state.attempts.filter(value => value.id === attemptId), attempt = matches[0];
    if (matches.length !== 1 || !attempt || attempt.status === 'reserved' || attempt.effect !== 'read' || attempt.effectState !== 'none' ||
        isEndedToolReservation(attempt) || attempt.readProgress || attempt.computerUse || attempt.reuse || attempt.effectReceipt || !attempt.contractDigest) return false;
    const entry = this.contracts.get(attempt.toolId, attempt.toolVersion), definition = entry?.tool.definition;
    return !!entry?.tool.restoreUsage && !!entry.tool.validateResult && !!definition && definition.effect === 'read' &&
      definition.resultValidation === 'artifact-proof-v1' && !definition.collection && !definition.reuse &&
      !definition.computerContinuation && !definition.computerInputAssurance && this.digest(definition) === attempt.contractDigest;
  }

  private async current(state: WorkState, attemptId: string, entry: RegisteredTool): Promise<void> {
    if (!this.candidate(state, attemptId) || this.contracts.get(entry.tool.definition.id, entry.tool.definition.version) !== entry ||
        !this.same(await this.services.state.get(state.id), state)) fail('stored_usage_changed');
  }

  private owner(state: WorkState, basis: WorkState): boolean {
    return state.id === basis.id && state.createdAt === basis.createdAt &&
      state.policy.tenantId === basis.policy.tenantId && state.policy.principalId === basis.policy.principalId &&
      dataGeneration(state) === dataGeneration(basis);
  }

  private async original(ref: ArtifactRef, state: WorkState, basis: WorkState): Promise<void> {
    if (ref.byteLength > MAX_RAW_BYTES || !visibleArtifact(basis, ref) || artifactBlocked(state, ref) ||
        state.artifacts.filter(value => value.id === ref.id).length !== 1 ||
        !state.artifacts.some(value => this.same(value, ref))) fail('stored_usage_original_unavailable');
    // The original dispatch policy is used only by this host-internal proof reader, never as a caller's read policy.
    const bytes = await this.services.artifacts.get(structuredClone(ref), structuredClone(basis.policy));
    if (bytes.byteLength !== ref.byteLength) fail('stored_usage_original_unavailable');
    const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
    if (Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('') !== ref.sha256)
      fail('stored_usage_original_unavailable');
  }

  private async inspect(state: WorkState, attemptId: string): Promise<{ restored: Available; proof: Proof } | null> {
    if (!this.candidate(state, attemptId)) fail('stored_usage_not_eligible');
    const attempt = state.attempts.find(value => value.id === attemptId)!;
    const entry = this.contracts.get(attempt.toolId, attempt.toolVersion)!;
    await this.current(state, attemptId, entry);
    const dispatch = await this.services.state.receipt(state.id, `dispatch:${attemptId}`);
    const sent = dispatch?.state.attempts.find(value => value.id === attemptId);
    const task = dispatch?.state.plan?.tasks.find(value => value.id === attempt.taskId);
    if (!dispatch || !this.owner(state, dispatch.state) || dispatch.state.revision > state.revision ||
        dispatch.digest !== this.digest({ type: 'attempt_dispatched', data: { attemptId, owner: attempt.owner } }) ||
        !sent || dispatch.state.attempts.filter(value => value.id === attemptId).length !== 1 ||
        sent.status !== 'running' || sent.resultArtifact !== null || sent.resultId !== null || sent.adopted || sent.error !== null ||
        !this.same(identity(sent), identity(attempt)) || !task || task.effect !== 'read' || task.readResume || task.computerResume ||
        task.toolId !== attempt.toolId || task.toolVersion !== attempt.toolVersion ||
        sent.goalRevision !== dispatch.state.goal.revision || sent.scope !== dispatch.state.goal.scope ||
        sent.planRevision !== dispatch.state.plan?.revision || dispatch.state.plan.goalRevision !== sent.goalRevision ||
        taskDigest(task, this.services.digester) !== attempt.inputDigest) fail();
    const restored = await this.contracts.restoreUsage(state, { attemptId, task });
    await this.current(state, attemptId, entry);
    if (restored.kind === 'absent') {
      if (!this.same(dispatch, await this.services.state.receipt(state.id, `dispatch:${attemptId}`))) fail('stored_usage_changed');
      await this.current(state, attemptId, entry); return null;
    }
    const response = await this.services.state.receipt(state.id, restored.receipt.commandId);
    const responded = response?.state.attempts.find(value => value.id === attemptId);
    if (!response || !this.owner(response.state, dispatch.state) || response.digest !== restored.receipt.digest ||
        response.state.revision <= dispatch.state.revision || response.state.revision > state.revision ||
        !responded || response.state.attempts.filter(value => value.id === attemptId).length !== 1 ||
        !this.same(identity(responded), identity(sent)) ||
        response.state.artifacts.filter(value => value.id === restored.receipt.artifact.id).length !== 1 ||
        !response.state.artifacts.some(value => this.same(value, restored.receipt.artifact))) fail();
    // Captured host preparation times; late responses may exceed the original lease/deadline.
    const times = [sent.startedAt, dispatch.state.updatedAt, restored.receivedAt, response.state.updatedAt, state.updatedAt, this.services.clock.now()];
    if (!times.every(value => Number.isSafeInteger(value) && value >= 0) ||
        times.some((value, index) => index > 0 && value < times[index - 1]!)) fail('stored_usage_time_invalid');
    await this.original(restored.receipt.artifact, state, dispatch.state);
    const [latestDispatch, latestResponse] = await Promise.all([
      this.services.state.receipt(state.id, `dispatch:${attemptId}`), this.services.state.receipt(state.id, restored.receipt.commandId),
    ]);
    if (!this.same({ dispatch, response }, { dispatch: latestDispatch, response: latestResponse })) fail('stored_usage_changed');
    await this.current(state, attemptId, entry);
    return { restored, proof: { entry, stateDigest: this.digest(state), sourceDigest: this.digest({ dispatch, response }),
      restoredDigest: this.digest(restored) } };
  }

  async prepare(state: WorkState, attemptId: string): Promise<StoredToolUsageTicket | null> {
    const captured = structuredClone(state), inspected = await this.inspect(captured, attemptId);
    if (!inspected) return null;
    const { restored, proof } = inspected;
    const ticket = frozen({ workId: captured.id, attemptId, usage: structuredClone(restored.usage), receivedAt: restored.receivedAt,
      receipt: structuredClone(restored.receipt), custodyOnly: restored.custodyOnly, responseObserved: restored.responseObserved });
    this.#issued.set(ticket, proof); return ticket;
  }

  async assertCurrent(state: WorkState, ticket: StoredToolUsageTicket): Promise<void> {
    const expected = this.#issued.get(ticket);
    if (!expected || ticket.workId !== state.id || this.digest(state) !== expected.stateDigest) fail('stored_usage_ticket_invalid');
    const inspected = await this.inspect(structuredClone(state), ticket.attemptId);
    if (!inspected || inspected.proof.entry !== expected.entry || inspected.proof.sourceDigest !== expected.sourceDigest ||
        inspected.proof.restoredDigest !== expected.restoredDigest || inspected.proof.stateDigest !== expected.stateDigest)
      fail('stored_usage_changed');
  }
}
