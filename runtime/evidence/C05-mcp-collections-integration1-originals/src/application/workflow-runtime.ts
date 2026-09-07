import type { Control } from '../domain/control.js';
import type { ArtifactRef, Policy } from '../domain/model.js';
import type { RuntimeServices } from './services.js';
import { assertOwner, type AcceptRequest, type ConversationService } from './conversation-service.js';
import type { ExecutionRuntime } from './execution-runtime.js';
import type { PlanningRuntime } from './planning-runtime.js';
import type { OutboxDispatcher } from './outbox.js';
import type { WorkActor } from './work-resources.js';
import { ContextRecovery } from './context-recovery.js';
import { refreshKnowledge } from './knowledge-state.js';
import { allowsDisclosure, disclosureLabels } from '../domain/disclosure.js';
import { transact } from './work-transactions.js';
import { asJson } from './plan-validator.js';
import { assertExecutionAuthority, assertExecutionCustodyOwner } from './execution-authority.js';

export type WorkflowControl = Control | { kind: 'continue'; action: 'model'; id: string; reason: string } | { kind: 'yield'; reason: string };
export interface WorkflowRunOptions { maxSteps?: number; onStep?: () => Promise<void>; previousPacket?: ArtifactRef; expectedGoalRevision?: number }
export interface WorkflowRunResult { control: WorkflowControl; steps: number; reason: string; stateRevision: number; goalRevision: number; checkpoint: ArtifactRef; resumeDisposition: 'created' | 'reused' | 'regenerated' }

function requireExecutionPolicy(policy: Policy, actor: WorkActor, services: RuntimeServices, scope: string) {
  if (policy.tenantId !== actor.tenantId || policy.principalId !== actor.principalId) throw new Error('work_unavailable');
  if (!policy.allowedLabels.every(label => actor.allowedLabels === undefined || actor.allowedLabels.includes(label)) ||
      !policy.allowedTools.every(tool => actor.allowedTools === undefined || actor.allowedTools.includes(tool)) ||
      !policy.allowedDestinations.every(destination => actor.allowedDestinations === undefined || actor.allowedDestinations.includes(destination)) ||
      (policy.allowWrites && actor.allowWrites === false)) throw new Error('workflow_policy_insufficient');
  assertExecutionAuthority(services, { policy, goal: { scope } });
  if (!services.executionAuthority && (actor.allowedLabels !== undefined || actor.allowedTools !== undefined || actor.allowedDestinations !== undefined || actor.allowWrites !== undefined)) throw new Error('workflow_scoped_execution_not_supported');
}

export class WorkflowRuntime {
  constructor(readonly services: RuntimeServices, readonly execution: ExecutionRuntime, readonly planning: PlanningRuntime | null,
    readonly conversation: ConversationService, readonly outbox: OutboxDispatcher, readonly recovery = new ContextRecovery(services, execution.tools),
    readonly compactPlanning: PlanningRuntime | null = planning) {}

  private async authorize(workId: string, actor: WorkActor) {
    const state = await this.execution.state(workId); assertOwner(state, actor); requireExecutionPolicy(state.policy, actor, this.services, state.goal.scope); return state;
  }

  /** Host bookkeeping after a selected mutation/resume, never a read-only view operation. */
  async reconcileUsage(workId: string, actor: WorkActor) {
    const owner = { tenantId: actor.tenantId, principalId: actor.principalId };
    const entry = await this.execution.state(workId);
    assertOwner(entry, owner); assertExecutionCustodyOwner(this.services, entry);
    const session = this.services.digester.digest(asJson(entry.conversation?.session?.scope ?? null));
    return this.execution.reconcileStoredUsages(workId, current => {
      assertOwner(current, owner); assertExecutionCustodyOwner(this.services, current);
      if (current.id !== workId || current.createdAt !== entry.createdAt || current.goal.scope !== entry.goal.scope ||
          this.services.digester.digest(asJson(current.conversation?.session?.scope ?? null)) !== session)
        throw new Error('work_unavailable');
    });
  }

  async accept(actor: WorkActor, request: AcceptRequest) {
    requireExecutionPolicy(request.policy, actor, this.services, request.goal.scope);
    const accepted = await this.conversation.accept(actor, request);
    await this.authorize(accepted.workId, actor);
    await this.outbox.flush(accepted.workId, actor);
    return { ...accepted, state: await this.execution.state(accepted.workId) };
  }
  private async recordChannelDenial(workId: string, actor: WorkActor): Promise<boolean> {
    const state = await this.authorize(workId, actor);
    const binding = state.conversation?.bindings.find(value => value.id === state.conversation?.primaryBindingId);
    if (!binding || !state.policy.disclosure || allowsDisclosure(state.policy, binding.destination, 'channel', disclosureLabels(state))) return false;
    if (state.status === 'blocked' && state.statusReason === 'channel_disclosure_denied') return true;
    const basis = this.services.digester.digest(asJson({ goalRevision: state.goal.revision, binding, policy: state.policy, labels: disclosureLabels(state) }));
    const key = ['completed', 'cancelled', 'paused', 'failed', 'blocked'].includes(state.status) ? basis : `${basis}:${state.revision}`;
    try {
      await transact(this.services, workId, `workflow-channel-disclosure:${key}`, 'workflow_channel_disclosure_denied', { code: 'channel_disclosure_denied' }, next => {
        assertOwner(next, actor);
        if (next.revision !== state.revision) throw new Error('workflow_disclosure_state_changed');
        if (!['completed', 'cancelled', 'paused', 'failed', 'blocked'].includes(next.status)) {
          next.status = 'blocked'; next.statusReason = 'channel_disclosure_denied'; next.retryWakeAt = null;
        }
      });
      return true;
    } catch (error) {
      if (error instanceof Error && error.message === 'workflow_disclosure_state_changed') return false;
      throw error;
    }
  }

  async run(workId: string, actor: WorkActor, options: WorkflowRunOptions = {}): Promise<WorkflowRunResult> {
    const maximum = options.maxSteps ?? 100;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 10000) throw new Error('invalid_step_limit');
    const entry = await this.authorize(workId, actor);
    if (options.expectedGoalRevision !== undefined && options.expectedGoalRevision !== entry.goal.revision) throw new Error('stale_user_command');
    await refreshKnowledge(this.services, workId, id => this.execution.interrupt(id));
    await this.services.obligations?.refresh(workId);
    await this.services.notifications?.refresh(workId);
    let compactSteps = 0;
    let compactControl: WorkflowControl | null = null;
    let storedBlockReason: string | null = null;
    let usageReconciled = false;
    while (compactSteps < maximum) {
      await this.authorize(workId, actor);
      // Durable result settlement needs no context packet. Finish it before a
      // smaller reconnect window can prevent the first checkpoint/compact.
      const stored = await this.execution.settleStoredResult(workId);
      if (stored?.kind === 'blocked') storedBlockReason = stored.reason;
      if (!usageReconciled && (!stored || stored.kind !== 'continue')) {
        await this.reconcileUsage(workId, actor); usageReconciled = true;
      }
      compactControl = stored ?? (this.compactPlanning ?
        await this.compactPlanning.compactStep(workId, { nextModelEnabled: this.compactPlanning === this.planning }) : null);
      if (!compactControl) break;
      compactSteps++;
      await options.onStep?.();
      if (compactControl.kind !== 'continue') break;
    }
    if (!usageReconciled) await this.reconcileUsage(workId, actor);
    const restore = async (previous?: ArtifactRef) => {
      try { return await this.recovery.restore(workId, actor, previous); }
      catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (!['session_context_capacity', 'session_compact_capacity', 'resume_packet_too_large'].includes(code)) throw error;
        const state = await this.authorize(workId, actor);
        const pending = state.modelCalls.some(c => c.purpose === 'session_compact' && ['reserved', 'running', 'received'].includes(c.status));
        throw new Error(pending ? 'session_compact_pending' : this.compactPlanning ? 'session_compact_capacity' : 'session_compact_unavailable', { cause: error });
      }
    };
    const restored = await restore(options.previousPacket);
    const finish = async (control: WorkflowControl, steps: number): Promise<WorkflowRunResult> => {
      for (let retry = 0; retry < 8; retry++) {
        await refreshKnowledge(this.services, workId, id => this.execution.interrupt(id));
        await this.services.obligations?.refresh(workId);
        await this.services.notifications?.refresh(workId);
        const final = await restore(restored.artifact);
        const state = await this.authorize(workId, actor);
        if (state.revision !== final.packet.stateRevision) continue;
        const current = this.execution.control(state);
        const disclosureYield = control.kind === 'yield' && control.reason === 'channel_disclosure_denied' && !['cancelled', 'paused', 'failed', 'blocked'].includes(current.kind);
        const storedBlock = storedBlockReason !== null && control.kind === 'blocked' && control.reason === storedBlockReason &&
          state.status === 'blocked' && state.statusReason === storedBlockReason;
        const outcome: WorkflowControl = disclosureYield || storedBlock ? control : current.kind === 'complete' && state.status !== 'completed' ? { kind: 'yield', reason: 'state_changed' } :
          control.kind === 'yield' && !['complete', 'cancelled', 'paused', 'failed', 'blocked'].includes(current.kind) ? control : current;
        return { control: outcome, steps, reason: outcome.reason, stateRevision: state.revision, goalRevision: state.goal.revision, checkpoint: final.artifact, resumeDisposition: restored.disposition };
      }
      throw new Error('workflow_snapshot_contention');
    };
    if (compactControl && (compactControl.kind !== 'continue' || compactSteps === maximum))
      return finish(compactControl.kind === 'continue' ? { kind: 'yield', reason: 'step_limit' } : compactControl, compactSteps);
    await this.outbox.flush(workId, actor);
    for (let steps = compactSteps + 1; steps <= maximum; steps++) {
      await this.authorize(workId, actor);
      const compact = this.compactPlanning && this.compactPlanning !== this.planning ?
        await this.compactPlanning.compactStep(workId, { nextModelEnabled: false }) : null;
      const control = compact ?? (this.planning ? await this.planning.step(workId) : await this.execution.step(workId));
      await options.onStep?.();
      await this.authorize(workId, actor);
      let prepared = null;
      try { prepared = await this.conversation.prepare(workId, actor); }
      catch (error) {
        if (error instanceof Error && error.message === 'channel_disclosure_denied' && (await this.authorize(workId, actor)).policy.disclosure) {
          if (await this.recordChannelDenial(workId, actor)) return finish({ kind: 'yield', reason: 'channel_disclosure_denied' }, steps);
          continue;
        }
        if (!(error instanceof Error && error.message === 'response_state_changed')) throw error;
      }
      if (prepared) await this.outbox.flush(workId, actor);
      const state = await this.authorize(workId, actor); const latest = this.execution.control(state);
      if (control.kind === 'continue' || latest.kind === 'continue' ||
          (latest.kind === 'complete' && state.status !== 'completed') ||
          (latest.kind === 'replan' && this.planning !== null)) continue;
      return finish(latest, steps);
    }
    const control = { kind: 'yield' as const, reason: 'step_limit' };
    return finish(control, maximum);
  }
}
