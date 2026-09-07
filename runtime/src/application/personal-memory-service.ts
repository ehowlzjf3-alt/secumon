import type { KnowledgeDependency, PersonalMemoryRef } from '../domain/knowledge.js';
import type { PersonalMemoryContext, PersonalMemorySelection } from '../domain/personal-memory.js';
import type { WorkState } from '../domain/model.js';
import type { RuntimeServices } from './services.js';
import type { PersonalKnowledgeFactory, PersonalMemoryContextProvider } from './personal-memory-ports.js';
import { PersonalMemoryContextSchema, PersonalMemorySelectionSchema, PersonalMemorySelectSchema } from './personal-memory-contracts.js';
import { authorizedWork, type WorkActor } from './work-resources.js';
import { asJson } from './plan-validator.js';
import { transact } from './work-transactions.js';
import { quarantineKnowledge } from './data-lifecycle.js';
import { sessionInputsCurrent } from './session-context.js';

type SelectInput = { commandId: string; expectedGoalRevision: number; expectedStateRevision: number; refs: PersonalMemoryRef[] };
const unavailable = () => new Error('personal_memory_unavailable');
const dependencyBasis = (dependency: KnowledgeDependency) => ({ ...dependency,
  sources: dependency.sources.map(({ workRevision: _revision, ...source }) => source) });

export class PersonalMemoryService implements PersonalMemoryContextProvider {
  constructor(readonly services: RuntimeServices, readonly personalKnowledge: PersonalKnowledgeFactory, readonly onChange?: (workId: string) => void) {}
  private digest(value: unknown) { return this.services.digester.digest(asJson(value)); }
  private scope(state: WorkState) {
    const applied = state.conversation?.session;
    if (!applied || applied.scope.tenantId !== state.policy.tenantId || applied.scope.principalId !== state.policy.principalId) throw unavailable();
    return applied;
  }
  private actor(state: WorkState): WorkActor { return { tenantId: state.policy.tenantId, principalId: state.policy.principalId,
    allowedLabels: state.policy.allowedLabels, allowedDestinations: state.policy.allowedDestinations }; }
  private owner(state: WorkState, ref: PersonalMemoryRef) {
    const { scope } = this.scope(state);
    if (ref.tenantId !== scope.tenantId || ref.agentId !== scope.agentId || ref.principalId !== scope.principalId) throw unavailable();
  }
  private async read(state: WorkState, refs: PersonalMemoryRef[], stored?: PersonalMemorySelection) {
    const actor = this.actor(state);
    if (stored) {
      actor.allowedLabels = actor.allowedLabels!.filter(label => stored.policy.allowedLabels.includes(label));
      actor.allowedDestinations = actor.allowedDestinations!.filter(destination => stored.policy.allowedDestinations.includes(destination));
    }
    if (refs.length && !actor.allowedDestinations!.includes(this.services.planner.destination)) throw unavailable();
    const service = await this.personalKnowledge(actor, state.id);
    const entries: PersonalMemorySelection['entries'] = [], cards: PersonalMemoryContext['entries'] = [];
    for (const ref of refs) {
      this.owner(state, ref);
      const read = await service.get(ref.id), { card, dependency } = read;
      if (card.kind !== 'personal' || card.revision !== ref.revision || card.owner?.agentId !== ref.agentId || card.owner.principalId !== ref.principalId ||
        dependency.schemaVersion !== 2 || dependency.owner?.agentId !== ref.agentId || dependency.owner.principalId !== ref.principalId ||
        dependency.tenantId !== ref.tenantId || dependency.knowledgeId !== ref.id || dependency.knowledgeRevision !== ref.revision) throw unavailable();
      const old = stored?.entries.find(value => this.digest(value.ref) === this.digest(ref));
      if (stored && (!old || this.digest(dependencyBasis(old.dependency)) !== this.digest(dependencyBasis(dependency)))) throw unavailable();
      entries.push({ ref: structuredClone(ref), dependency });
      cards.push({ ref: structuredClone(ref), title: card.title, body: card.body, sourceVersions: card.sourceVersions });
    }
    if (!(await service.validateDependencies(entries.map(entry => entry.dependency)))) throw unavailable();
    if (new TextEncoder().encode(JSON.stringify(cards)).byteLength > 8192) throw new Error('personal_memory_capacity');
    return { entries, cards };
  }
  async context(state: WorkState): Promise<PersonalMemoryContext | null> {
    if (!state.personalMemorySelection) return null;
    const selected = PersonalMemorySelectionSchema.parse(state.personalMemorySelection), applied = this.scope(state);
    if (this.digest(selected.basis.scope) !== this.digest(applied.scope) || selected.basis.input.sequence > applied.input.sequence ||
      selected.basis.input.sequence === applied.input.sequence && this.digest(selected.basis.input) !== this.digest(applied.input)) throw unavailable();
    const read = await this.read(state, selected.entries.map(entry => entry.ref), selected);
    return PersonalMemoryContextSchema.parse({ schemaVersion: 1, selectionId: selected.selectionId, basis: selected.basis, entries: read.cards,
      interpretation: 'user_requested_memory_not_verified_evidence' });
  }
  async current(state: WorkState, context?: PersonalMemoryContext, signal?: AbortSignal): Promise<boolean> {
    try {
      if (signal?.aborted) return false;
      if (!state.personalMemorySelection) return context === undefined;
      const fresh = await this.context(state);
      if (!fresh || context && this.digest(fresh) !== this.digest(PersonalMemoryContextSchema.parse(context))) return false;
      const latest = await this.services.state.get(state.id);
      return !signal?.aborted && latest !== null && latest.revision === state.revision &&
        this.digest(latest.personalMemorySelection) === this.digest(state.personalMemorySelection);
    } catch { return false; }
  }
  async selected(workId: string, actor: WorkActor) {
    const state = await authorizedWork(this.services.state, workId, actor); this.scope(state);
    await this.personalKnowledge(this.actor(state), workId);
    const available = await this.current(state);
    return { selectionId: state.personalMemorySelection?.selectionId ?? null,
      refs: available ? structuredClone(state.personalMemorySelection?.entries.map(entry => entry.ref) ?? []) : [], available, stateRevision: state.revision };
  }
  async select(workId: string, actor: WorkActor, input: SelectInput) {
    const args = PersonalMemorySelectSchema.parse(input), state = await authorizedWork(this.services.state, workId, actor);
    const basis = this.scope(state), commandId = `personal-memory-select:${args.commandId}`;
    await this.personalKnowledge(this.actor(state), workId);
    const data = asJson({ actor, ...args }), type = 'personal_memory_selected';
    const receipt = await this.services.state.receipt(workId, commandId);
    if (receipt) {
      if (receipt.digest !== this.digest({ type, data })) throw new Error('idempotency_conflict');
      return { selectionId: args.commandId, applied: false, stateRevision: receipt.state.revision, refs: args.refs };
    }
    if (actor.allowWrites === false || ['cancelled', 'completed', 'failed', 'paused'].includes(state.status)) throw new Error('personal_memory_not_selectable');
    if (state.revision !== args.expectedStateRevision || state.goal.revision !== args.expectedGoalRevision) throw new Error('personal_memory_selection_stale');
    if (!(await sessionInputsCurrent(this.services, state))) throw new Error('personal_memory_selection_stale');
    const read = await this.read(state, args.refs);
    const selected = PersonalMemorySelectionSchema.parse({ schemaVersion: 1, selectionId: args.commandId, basis,
      policy: { allowedLabels: state.policy.allowedLabels, allowedDestinations: state.policy.allowedDestinations }, entries: read.entries });
    const result = await transact(this.services, workId, commandId, type, data, next => {
      if (next.revision !== args.expectedStateRevision || next.goal.revision !== args.expectedGoalRevision ||
        this.digest(next.conversation?.session) !== this.digest(basis) || next.policy.tenantId !== actor.tenantId || next.policy.principalId !== actor.principalId ||
        ['cancelled', 'completed', 'failed', 'paused'].includes(next.status)) throw new Error('personal_memory_selection_stale');
      const existingObligations = new Set(next.obligations.map(obligation => obligation.id));
      if (next.personalMemorySelection?.entries.length) quarantineKnowledge(next, this.services.clock.now());
      next.personalMemorySelection = selected; next.personalMemoryReviewRequired = true; next.contextHead = null;
      if (next.conversation) next.conversation.result = null;
      // Only this selection's new review is replaced by the personal-memory plan review gate.
      for (const obligation of next.obligations) if (!existingObligations.has(obligation.id) && obligation.status === 'pending' &&
        obligation.reason === 'knowledge_dependency_changed_review_required') obligation.status = 'waived';
      next.status = 'ready'; next.statusReason = 'personal_memory_selected'; next.retryWakeAt = null;
      for (const call of next.modelCalls) {
        if (call.status === 'reserved') { call.status = 'cancelled'; call.usageStatus = 'not_called'; call.finishedAt = this.services.clock.now(); next.budget.reservedModelCalls--; next.budget.reservedTokens -= call.tokenReservation; }
        else if (call.status === 'received') call.status = 'rejected';
        if (['running', 'received', 'rejected', 'cancelled'].includes(call.status)) { call.expired = true; call.reason = 'personal_memory_changed'; }
      }
      for (const attempt of next.attempts) {
        if (attempt.status === 'reserved') { attempt.status = 'cancelled'; attempt.finishedAt = this.services.clock.now(); attempt.error = { code: 'reservation_cancelled', retryable: true }; next.budget.reservedToolCalls--; }
        if (attempt.status === 'running') attempt.leaseUntil = Math.min(attempt.leaseUntil, this.services.clock.now());
      }
    }, async () => {
      if (!(await sessionInputsCurrent(this.services, state))) throw new Error('personal_memory_selection_stale');
      await this.read(state, args.refs, selected);
    });
    if (result.committed) this.onChange?.(workId);
    // Publication in another database can race the work CAS; never report an unusable selection as usable.
    if (!(await this.current(result.state))) throw new Error('personal_memory_changed');
    return { selectionId: args.commandId, applied: result.committed, stateRevision: result.state.revision, refs: args.refs };
  }
}
