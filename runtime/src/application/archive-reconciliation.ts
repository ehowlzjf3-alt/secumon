import { z } from 'zod';
import type { Attempt, EffectReceipt, WorkState } from '../domain/model.js';
import { dataGeneration, visibleArtifact } from '../domain/data-lifecycle.js';
import { ArchiveMutationResultSchema } from './archive-contracts.js';
import type { ArchiveService } from './archive-service.js';
import { archiveMutationForTask, archiveMutationToolResult } from './archive-tools.js';
import type { ExecutionRuntime } from './execution-runtime.js';
import { assertExecutionAuthority } from './execution-authority.js';
import { asJson, taskDigest } from './plan-validator.js';
import type { RuntimeServices } from './services.js';
import { frozen } from './resource-contracts.js';
import { transact } from './work-transactions.js';
import type { WorkActor } from './work-resources.js';
import { cancelBudgetReservations } from './budget-delegation.js';
import { ToolResultSchema } from './contracts.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const ProofSchema = z.strictObject({ schemaVersion: z.literal(1), providerId: z.string(), workId: z.string(), attemptId: z.string(),
  boundary: hash, dispatchDigest: hash, commandDigest: hash, receipt: ArchiveMutationResultSchema,
  result: ToolResultSchema, observedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
type Dependencies = { services: RuntimeServices; execution: ExecutionRuntime; archive: ArchiveService; actor: WorkActor };
function fail(): never { throw new Error('archive_reconciliation_changed'); }
function identity(attempt: Attempt) {
  return { id: attempt.id, taskId: attempt.taskId, toolId: attempt.toolId, toolVersion: attempt.toolVersion,
    inputDigest: attempt.inputDigest, contractDigest: attempt.contractDigest ?? null, scope: attempt.scope,
    goalRevision: attempt.goalRevision, planRevision: attempt.planRevision, owner: attempt.owner,
    startedAt: attempt.startedAt, leaseUntil: attempt.leaseUntil, effect: attempt.effect };
}

/** Receipt lookup only. No mutation retry, executor impersonation, lease renewal or new effect registry. */
export class ArchiveReconciliation {
  readonly #actor: WorkActor;
  constructor(readonly deps: Dependencies) {
    if (deps.execution.services !== deps.services) throw new Error('archive_reconciliation_runtime_mismatch');
    this.#actor = frozen(structuredClone(deps.actor));
  }
  private digest(value: unknown) { return this.deps.services.digester.digest(asJson(value)); }
  private async state(workId: string) {
    const state = await this.deps.services.state.get(workId);
    if (!state) throw new Error('work_not_found');
    return state;
  }
  private access(state: WorkState) {
    const { archive, services } = this.deps;
    archive.authorize(this.#actor, state.policy); assertExecutionAuthority(services, state);
    if (state.goal.scope !== archive.owner.scope || state.conversation?.session?.scope.agentId !== archive.owner.agentId ||
      !state.policy.allowedLabels.every(label => this.#actor.allowedLabels?.includes(label))) fail();
  }
  private owns(attempt: Attempt) {
    return attempt.effect === 'write' && ['register', 'revise', 'delete'].some(operation =>
      attempt.toolId === `${this.deps.archive.descriptor.id}.${operation}`);
  }
  private boundary(state: WorkState, attempt: Attempt) {
    return this.digest({ workId: state.id, createdAt: state.createdAt, owner: this.deps.archive.owner,
      generation: dataGeneration(state), policy: state.policy, attempt: identity(attempt) });
  }
  private async descriptor(state: WorkState, attemptId: string) {
    this.access(state);
    const attempt = state.attempts.find(value => value.id === attemptId);
    const dispatch = await this.deps.services.state.receipt(state.id, `dispatch:${attemptId}`);
    const original = dispatch?.state.attempts.find(value => value.id === attemptId);
    const task = dispatch?.state.plan?.tasks.find(value => value.id === original?.taskId);
    const entry = attempt && this.deps.execution.tools.get(attempt.toolId, attempt.toolVersion);
    if (!attempt || !this.owns(attempt) || !dispatch || !original || !task || !entry || original.status !== 'running' ||
      original.effectState !== 'unknown' || dispatch.state.id !== state.id || dispatch.state.createdAt !== state.createdAt ||
      this.digest(identity(original)) !== this.digest(identity(attempt)) || this.boundary(dispatch.state, original) !== this.boundary(state, attempt) ||
      dispatch.state.goal.scope !== original.scope || dispatch.state.goal.revision !== original.goalRevision ||
      dispatch.state.plan?.revision !== original.planRevision || taskDigest(task, this.deps.services.digester) !== original.inputDigest ||
      attempt.contractDigest !== this.digest(entry.tool.definition) || this.deps.execution.tools.check(task, state.policy) ||
      dispatch.digest !== this.digest({ type: 'attempt_dispatched', data: { attemptId, owner: original.owner } }) ||
      state.revision < dispatch.state.revision || dispatch.state.updatedAt < original.startedAt ||
      this.deps.services.clock.now() < Math.max(state.updatedAt, dispatch.state.updatedAt)) fail();
    const command = archiveMutationForTask(this.deps.archive.descriptor, task, state.id, attemptId);
    const latest = await this.state(state.id); this.access(latest);
    if (this.digest(latest) !== this.digest(state)) fail();
    return { attempt, command, dispatch, boundary: this.boundary(state, attempt), entry };
  }
  private operationId(commandId: string) { return `archive:${this.digest({ provider: this.deps.archive.descriptor.id, commandId })}`; }
  private async verify(state: WorkState, attemptId: string, receipt: EffectReceipt) {
    try {
      if (receipt.provider !== 'archive' || receipt.outcome !== 'applied' || receipt.origin !== 'reconciliation' ||
        !visibleArtifact(state, receipt.artifact) || receipt.artifact.byteLength > 16384) return false;
      const descriptor = await this.descriptor(state, attemptId);
      const raw = await this.deps.services.artifacts.get(receipt.artifact, state.policy);
      if (raw.byteLength !== receipt.artifact.byteLength) return false;
      const proof = ProofSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
      const stored = await this.deps.archive.receipt(this.#actor, descriptor.command);
      if (!stored || proof.providerId !== this.deps.archive.descriptor.id || proof.workId !== state.id || proof.attemptId !== attemptId ||
        proof.boundary !== descriptor.boundary || proof.dispatchDigest !== descriptor.dispatch.digest ||
        proof.commandDigest !== this.digest(descriptor.command) || this.digest(proof.receipt) !== this.digest(stored) ||
        this.digest(proof.result) !== this.digest(archiveMutationToolResult(this.deps.archive.descriptor.id, attemptId, stored)) ||
        receipt.operationId !== this.operationId(descriptor.command.commandId) || receipt.observedAt !== proof.observedAt ||
        proof.observedAt < descriptor.attempt.startedAt || proof.observedAt > this.deps.services.clock.now()) return false;
      const finalRaw = await this.deps.services.artifacts.get(receipt.artifact, state.policy);
      const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(finalRaw).buffer);
      if (finalRaw.byteLength !== raw.byteLength || finalRaw.some((byte, index) => byte !== raw[index]) ||
        Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') !== receipt.artifact.sha256) return false;
      const latest = await this.state(state.id); this.access(latest);
      return this.digest(latest) === this.digest(state) && this.deps.execution.tools.get(descriptor.attempt.toolId, descriptor.attempt.toolVersion) === descriptor.entry;
    } catch { return false; }
  }
  async current(state: WorkState): Promise<boolean> {
    for (const attempt of state.attempts) if (attempt.effectReceipt?.provider === 'archive' && !(await this.verify(state, attempt.id, attempt.effectReceipt))) return false;
    return true;
  }
  async recover(workId: string, attemptId: string): Promise<WorkState> {
    for (let retry = 0; retry < 8; retry++) {
      const state = await this.state(workId), attempt = state.attempts.find(value => value.id === attemptId);
      this.access(state);
      if (!attempt || !this.owns(attempt) || !this.deps.archive.supportsReceipts || attempt.status === 'reserved' || attempt.status === 'received' ||
        attempt.status === 'running' && attempt.leaseUntil > this.deps.services.clock.now() || attempt.adopted ||
        attempt.effectState !== 'unknown' && !state.obligations.some(value => value.id === `effect:${attemptId}` && value.status === 'pending')) return state;
      if (attempt.effectReceipt) return state;
      try {
        const descriptor = await this.descriptor(state, attemptId);
        const stored = await this.deps.archive.receipt(this.#actor, descriptor.command);
        const latest = await this.state(workId); this.access(latest);
        if (this.digest(latest) !== this.digest(state)) fail();
        if (!stored) return latest;
        if (attempt.status === 'running' && attempt.owner !== this.deps.execution.owner) {
          // Use the original runtime expiry transition; never borrow or replace the original executor owner.
          await this.deps.execution.recover(workId, attemptId);
          continue;
        }
        if (!attempt.resultArtifact && attempt.owner === this.deps.execution.owner &&
          (attempt.status === 'running' || ['failed', 'unknown'].includes(attempt.status) && attempt.error?.code === 'lease_expired')) {
          await this.deps.execution.receive(workId, attemptId, archiveMutationToolResult(this.deps.archive.descriptor.id, attemptId, stored),
            attempt.execution?.mode ?? 'unreported');
          await this.deps.execution.adopt(workId, attemptId);
          continue;
        }
        const proof = { schemaVersion: 1, providerId: this.deps.archive.descriptor.id, workId, attemptId, boundary: descriptor.boundary,
          dispatchDigest: descriptor.dispatch.digest, commandDigest: this.digest(descriptor.command), receipt: stored,
          result: archiveMutationToolResult(this.deps.archive.descriptor.id, attemptId, stored), observedAt: this.deps.services.clock.now() };
        const bytes = new TextEncoder().encode(JSON.stringify(proof));
        if (bytes.byteLength > 16384) throw new Error('archive_proof_too_large');
        const artifact = await this.deps.services.artifacts.put(bytes, { tenantId: state.policy.tenantId, labels: [...state.policy.allowedLabels], mediaType: 'application/json' });
        const receipt: EffectReceipt = { provider: 'archive', operationId: this.operationId(descriptor.command.commandId), outcome: 'applied',
          origin: 'reconciliation', artifact, observedAt: proof.observedAt };
        if (!(await this.verify(state, attemptId, receipt))) fail();
        return (await transact(this.deps.services, workId, `archive-reconcile:${this.digest({ attemptId, revision: state.revision })}`, 'effect_reconciled',
          { attemptId, outcome: 'applied', artifactId: artifact.id }, next => {
            if (this.digest(next) !== this.digest(state)) fail();
            this.access(next);
            const target = next.attempts.find(value => value.id === attemptId)!;
            target.effectReceipt = receipt; target.effectState = 'confirmed'; target.adopted = false;
            const obligation = next.obligations.find(value => value.id === `effect:${attemptId}` && value.kind === 'effect_reconciliation');
            if (obligation?.status === 'pending') obligation.status = 'satisfied';
            if (!['paused', 'cancelled', 'failed', 'blocked', 'completed'].includes(next.status)) {
              next.status = 'ready'; next.statusReason = 'effect_reconciled_requires_plan';
            }
          }, async () => { if (!(await this.verify(await this.state(workId), attemptId, receipt))) fail(); })).state;
      } catch (error) {
        if (!(error instanceof Error && error.message === 'archive_reconciliation_changed') || retry === 7) throw error;
      }
    }
    return this.state(workId);
  }
  async refresh(workId: string): Promise<WorkState> {
    let state = await this.state(workId);
    this.access(state);
    const invalid: string[] = [];
    for (const attempt of state.attempts) if (attempt.effectReceipt?.provider === 'archive' &&
      !(await this.verify(state, attempt.id, attempt.effectReceipt)) &&
      !state.obligations.some(value => value.id === `effect:${attempt.id}` && value.status === 'pending')) invalid.push(attempt.id);
    if (invalid.length) {
      state = (await transact(this.deps.services, workId, `archive-proof-invalid:${state.revision}`, 'effect_proofs_invalidated',
        { expectedRevision: state.revision }, next => {
          if (next.revision !== state.revision) fail();
          for (const attempt of next.attempts.filter(value => invalid.includes(value.id))) {
            attempt.adopted = false; attempt.effectState = 'unknown';
            const id = `effect:${attempt.id}`, obligation = next.obligations.find(value => value.id === id);
            if (obligation) obligation.status = 'pending';
            else next.obligations.push({ id, kind: 'effect_reconciliation', status: 'pending', reason: 'archive_receipt_unavailable', wakeKey: null, dueAt: null });
          }
          cancelBudgetReservations(next, this.deps.services.clock.now());
        })).state;
    }
    const candidates = state.attempts.filter(attempt => this.owns(attempt) && !attempt.effectReceipt &&
      (attempt.effectState === 'unknown' || state.obligations.some(value => value.id === `effect:${attempt.id}` && value.status === 'pending'))).map(attempt => attempt.id);
    for (const id of candidates) state = await this.recover(workId, id);
    return state;
  }
}
