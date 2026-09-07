import type { Control } from '../domain/control.js';
import { assertExecutionAuthority, executionAuthorityCurrent } from './execution-authority.js';
import { modelFailureKey } from './execution-decision.js';
import { captureProgress, progressGate } from './work-progress.js';
import { executionBasis, prepareExecutionBoundary } from './execution-control.js';
import { effectiveExecutionLimits } from '../domain/execution-policy.js';
import type { ContextPacket, ModelCall, WorkState } from '../domain/model.js';
import type { ModelCallOptions, ModelReply, SessionCompactReply } from './ports.js';
import type { RuntimeServices } from './services.js';
import { ContextPacketSchema, PlanProposalSchema, parseContract } from './contracts.js';
import { ModelIdentitySchema, ModelReplySchema, SessionCompactReplySchema } from './model-contracts.js';
import { applyValidatedPlan, asJson, unchangedPlanTasks, validatePlan } from './plan-validator.js';
import { transact } from './work-transactions.js';
import { artifactBlocked, dataGeneration } from '../domain/data-lifecycle.js';
import { knowledgeInputsCurrent, refreshKnowledge } from './knowledge-state.js';
import { refreshEffectProofs } from './effect-proofs.js';
import { controlProofsCurrent as effectProofsCurrent } from './control-proofs.js';
import type { ExecutionRuntime } from './execution-runtime.js';
import type { ToolContracts } from './tool-contracts.js';
import { ContextCompiler, type ContextInspection } from './context-compiler.js';
import { budgetAllocationError } from '../domain/budget-delegation.js';
import { assertBudgetAuthority, cancelBudgetReservations } from './budget-delegation.js';
import { allowsDisclosure, disclosureLabels } from '../domain/disclosure.js';
import { validateReadWaits } from './read-waits.js';
import { sessionContextCurrent, sessionInputsCurrent } from './session-context.js';
import { SessionCompactCalls, type CompactRequestOptions } from './session-compact-runtime.js';
import type { ContextHead, ContextMetrics } from '../domain/context.js';
import { personalMemoryContextCurrent, personalMemoryDigest } from './personal-memory-context.js';
import { AgentTurnCalls } from './agent-turn-runtime.js';
import { AgentTurnReplySchema } from './agent-turn-contracts.js';
import type { AgentTurnReply } from './agent-turn-types.js';
import type { AgentTurnResult } from '../domain/agent-turn.js';
import { generatedAnswerBasis } from './generated-answer.js';
import { accessibleEvidence } from '../domain/completion.js';
import { assessInputFit, resolveModelInputLimits } from './model-input-budget.js';
import { inputProfileDigest, inputProfileSnapshot } from './model-input-profile.js';

type Config = { leaseMs: number; maxInputBytes: number; maxOutputTokens: number; maxReplyBytes: number };
type NextModelInput = { workId: string; stateDigest: string; profileDigest: string; promptDigest: string; callId: string;
  agentTurn: boolean; toolsRevision: number; inspection: ContextInspection; autoChecked: boolean };
export type PlanningControl = Control | { kind: 'continue'; action: 'model'; id: string; reason: string };
const transientStatuses = ['reserved', 'running', 'received'];
export class PlanningRuntime {
  readonly context: ContextCompiler;
  readonly identity;
  readonly config: Config;
  readonly destination: string;
  readonly compacts: SessionCompactCalls;
  readonly turns: AgentTurnCalls;
  #pending = new Map<string, Promise<void>>();
  #failures = new Map<string, string>();
  // One disposable handoff between compact preflight and reservation; never persisted or shared across runtimes.
  #nextInput: NextModelInput | undefined;
  constructor(readonly services: RuntimeServices, readonly tools: ToolContracts, readonly execution: ExecutionRuntime, readonly owner: string, config: Partial<Config> = {}, context?: ContextCompiler) {
    this.context = context ?? new ContextCompiler(services, tools);
    this.compacts = new SessionCompactCalls(services);
    this.turns = new AgentTurnCalls(services, this.context);
    if (this.context.tools !== tools || this.context.services !== services) throw new Error('invalid_context_configuration');
    this.identity = Object.freeze(parseContract(ModelIdentitySchema, services.planner.identity));
    this.destination = services.planner.destination;
    this.config = Object.freeze({ leaseMs: 30000, maxInputBytes: 65536, maxOutputTokens: 2048, maxReplyBytes: 1048576, ...config });
    if (!owner || !this.destination || Object.values(this.config).some(v => !Number.isSafeInteger(v) || v < 1) || !Number.isSafeInteger(services.planner.capabilities.maxInputTokens) || services.planner.capabilities.maxInputTokens < 1) throw new Error('invalid_model_configuration');
  }
  private digest(state: WorkState, version: 1 | 2 | 3 | 4 = state.goal.responseRequirement ? 4 : state.conversation?.session ? 3 : 2) {
    return this.services.digester.digest(asJson({ goal: state.goal, policy: state.policy, plan: state.plan, attempts: state.attempts,
      ...(state.computerReconciliations?.length ? { computerReconciliations: state.computerReconciliations } : {}),
      ...(state.disclosureLabels ? { disclosureLabels: state.disclosureLabels } : {}),
      ...(state.notifications?.length ? { notifications: state.notifications } : {}),
      evidence: state.evidence, hypotheses: state.hypotheses, hypothesisAssessment: state.hypothesisAssessment, obligations: state.obligations, dataGeneration: dataGeneration(state),
      ...(version >= 2 ? { execution: executionBasis(state) } : {}),
      ...(version >= 3 ? { session: state.conversation?.session ?? null } : {}),
      ...(version === 4 ? { generatedAnswer: state.generatedAnswer ?? null } : {}) }));
  }
  private call(state: WorkState, id: string) { const call = state.modelCalls.find(c => c.id === id); if (!call) throw new Error('model_call_missing'); return call; }
  private matches(call: ModelCall) {
    return call.provider === this.identity.provider && call.model === this.identity.model && call.adapterRevision === this.identity.revision && call.destination === this.destination &&
      this.services.planner.destination === this.destination && this.services.digester.digest(asJson(this.services.planner.identity)) === this.services.digester.digest(asJson(this.identity));
  }
  private inputProfile(purpose: ModelCall['purpose']) {
    return inputProfileDigest(this.services.digester, inputProfileSnapshot(this.services.planner, purpose ?? 'planning', this.config));
  }
  private profileCurrent(call: ModelCall): boolean {
    try { return call.inputProfileDigest === undefined || call.inputProfileDigest === this.inputProfile(call.purpose); }
    catch { return false; }
  }
  private sameInputProfile(purpose: ModelCall['purpose'], expected: string): boolean {
    try { return this.inputProfile(purpose) === expected; } catch { return false; }
  }
  /** Only unsent legacy calls need a fresh estimate; never rewrite their input or reservation. */
  private async outgoingInputCurrent(state: WorkState, call: ModelCall): Promise<boolean> {
    if (call.inputProfileDigest !== undefined) return this.profileCurrent(call);
    try {
      const profile = this.inputProfile(call.purpose);
      if (call.maxOutputTokens > this.config.maxOutputTokens) return false;
      const limits = resolveModelInputLimits(this.services.planner.capabilities, { maxInputBytes: this.config.maxInputBytes, maxOutputTokens: call.maxOutputTokens });
      const fallback = (envelope: unknown) => { const bytes = new TextEncoder().encode(JSON.stringify(envelope)).byteLength;
        return { tokens: bytes + 2048, bytes, method: 'utf8_bytes_with_template_allowance' }; };
      let options: ModelCallOptions, estimate: { tokens: number; bytes: number; method: string }, bytes: number;
      if (call.purpose === 'session_compact') {
        const input = await this.compacts.load(state, call); options = input.options;
        const base = fallback(input); bytes = base.bytes;
        estimate = this.services.planner.estimateCompactInput?.(structuredClone(input.compact), structuredClone(options)) ?? base;
      } else if (call.purpose === 'agent_turn') {
        const input = await this.turns.load(state, call); options = input.options;
        const base = fallback(input); bytes = base.bytes;
        estimate = this.services.planner.estimateTurnInput?.(structuredClone(input.turn), structuredClone(options)) ?? base;
      } else {
        const raw = await this.services.artifacts.get(call.inputArtifact, state.policy);
        const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as { packet: ContextPacket; options: ModelCallOptions };
        const packet = parseContract(ContextPacketSchema, input.packet); options = input.options;
        const base = fallback({ packet, options }); bytes = base.bytes;
        estimate = this.services.planner.estimateInput?.(structuredClone(packet), structuredClone(options)) ?? base;
      }
      return options.callId === call.id && options.maxOutputTokens === call.maxOutputTokens &&
        assessInputFit(estimate, limits, bytes).kind === 'fit' && estimate.tokens <= call.inputEstimate &&
        estimate.tokens + call.maxOutputTokens <= call.tokenReservation && profile === this.inputProfile(call.purpose);
    } catch { return false; }
  }
  /** Capture the fixed sent definitions once; check current availability synchronously after later awaits. */
  private async outgoingDefinitionsCheck(state: WorkState, call: ModelCall): Promise<(current: WorkState) => boolean> {
    if (call.purpose === 'session_compact') return () => true;
    try {
      const input = call.purpose === 'agent_turn' ? await this.turns.load(state, call) : null;
      const stored = input ? { packet: input.turn.packet, options: input.options } :
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await this.services.artifacts.get(call.inputArtifact, state.policy))) as { packet: ContextPacket; options: ModelCallOptions };
      const packet = parseContract(ContextPacketSchema, stored.packet), options = stored.options;
      if (packet.workId !== state.id || options.callId !== call.id || options.maxOutputTokens !== call.maxOutputTokens || !Array.isArray(options.tools)) return () => false;
      return current => this.context.outgoingDefinitionsCurrent(packet, options, current);
    } catch { return () => false; }
  }
  private async rejectChangedInput(workId: string, state: WorkState, call: ModelCall, reason: 'model_input_profile_changed' | 'model_tools_changed' = 'model_input_profile_changed'): Promise<void> {
    await transact(this.services, workId, reason === 'model_tools_changed' ? `model-tools:${call.id}` : `model-input-profile:${call.id}`, 'model_gate_rejected', { callId: call.id, code: reason }, next => {
      const current = this.call(next, call.id);
      if (next.revision !== state.revision || current.status !== 'reserved' || current.owner !== this.owner) throw new Error('model_not_dispatchable');
      current.status = 'cancelled'; current.usageStatus = 'not_called'; current.expired = true; current.finishedAt = this.services.clock.now();
      current.inputTokens = 0; current.outputTokens = 0; current.outcome = 'cancelled'; current.reason = reason;
      next.budget.reservedModelCalls--; next.budget.reservedTokens -= current.tokenReservation;
    });
  }
  private allowed(state: WorkState, call?: ModelCall) {
    if (!executionAuthorityCurrent(this.services, state)) return false;
    if (call?.purpose === 'agent_turn' && (!this.services.planner.turn || call.agentTurnPromptDigest !== this.services.planner.prompt?.digest)) return false;
    if (call && call.personalMemoryDigest !== personalMemoryDigest(this.services, state)) return false;
    if (call && Boolean(state.conversation?.session) !== (call.semanticVersion === 3 || call.semanticVersion === 4)) return false;
    if (!state.policy.allowedDestinations.includes(this.destination)) return false;
    if (!allowsDisclosure(state.policy, this.destination, 'model', [...disclosureLabels(state), ...(call?.inputArtifact.labels ?? [])])) return false;
    return !call || !artifactBlocked(state, call.inputArtifact) && call.inputArtifact.tenantId === state.policy.tenantId && call.inputArtifact.labels.every(l => state.policy.allowedLabels.includes(l));
  }
  private async sessionCurrent(state: WorkState, call: ModelCall): Promise<boolean> {
    if (call.purpose === 'agent_turn') {
      try { const input = await this.turns.load(state, call); return await this.turns.current(state, input.turn, input.options); } catch { return false; }
    }
    if (!state.conversation?.session) return call.semanticVersion !== 3 && call.semanticVersion !== 4 && await sessionInputsCurrent(this.services, state);
    if (call.semanticVersion !== 3) return false;
    try {
      if (call.purpose === 'session_compact') return await this.compacts.current(state, (await this.compacts.load(state, call)).compact);
      const bytes = await this.services.artifacts.get(call.inputArtifact, state.policy);
      const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      const packet = parseContract(ContextPacketSchema, input.packet);
      return packet.workId === state.id && await sessionContextCurrent(this.services, state, packet.session) &&
        await personalMemoryContextCurrent(this.services, state, packet.personalMemory);
    } catch { return false; }
  }
  private async refresh(workId: string) {
    await refreshKnowledge(this.services, workId, id => this.execution.interrupt(id));
    return refreshEffectProofs(this.services, workId);
  }
  private canInspect(state: WorkState): boolean {
    return !!state.conversation?.session && !!this.services.sessions?.inspectContext &&
      !!this.services.sessions.draftCurrent && !!this.services.sessions.materializeContext;
  }
  private async inspectNext(state: WorkState): Promise<NextModelInput> {
    const agentTurn = !!state.goal.responseRequirement;
    const profileDigest = this.inputProfile(agentTurn ? 'agent_turn' : undefined);
    const stateDigest = this.services.digester.digest(asJson(state));
    const promptDigest = this.services.digester.digest(asJson(this.services.planner.prompt ?? null));
    const toolsRevision = this.tools.revision;
    const prior = this.#nextInput;
    if (prior && prior.workId === state.id && prior.stateDigest === stateDigest && prior.profileDigest === profileDigest &&
      prior.promptDigest === promptDigest && prior.agentTurn === agentTurn && prior.toolsRevision === toolsRevision) return prior;
    this.#nextInput = undefined;
    const callId = this.services.ids.next('model');
    const limits = resolveModelInputLimits(this.services.planner.capabilities, this.config);
    const inspection = agentTurn ? await this.turns.inspect(state, callId, limits) : await this.context.inspect(state, { ...limits, callId });
    if (!this.sameInputProfile(agentTurn ? 'agent_turn' : undefined, profileDigest)) throw new Error('model_input_profile_changed');
    if (toolsRevision !== this.tools.revision) throw new Error('context_state_changed');
    const next = { workId: state.id, stateDigest, profileDigest, promptDigest, callId, agentTurn, toolsRevision, inspection, autoChecked: false };
    // Capacity results are not cached: a peer may publish a new session summary without revising this work.
    if (inspection.kind === 'fits') this.#nextInput = next;
    return next;
  }
  async reserve(workId: string): Promise<ModelCall> {
    const call = await this.reserveModel(workId);
    if (!call) throw new Error('model_not_needed');
    return call;
  }
  private compactRequest(options: CompactRequestOptions) {
    return { requestId: options.requestId ?? null, force: options.force ?? false, expectedGoalRevision: options.expectedGoalRevision ?? null };
  }
  async requestCompact(workId: string, options: CompactRequestOptions = {}): Promise<ModelCall | null> {
    if (options.requestId !== undefined && (!options.requestId || options.requestId.length > 256) ||
      options.expectedGoalRevision !== undefined && (!Number.isSafeInteger(options.expectedGoalRevision) || options.expectedGoalRevision < 1)) throw new Error('invalid_compact_request');
    if (options.requestId) {
      const receipt = await this.services.state.receipt(workId, `session-compact-request:${options.requestId}`);
      if (receipt) {
        if (receipt.digest !== this.services.digester.digest({ type: 'session_compact_requested', data: this.compactRequest(options) })) throw new Error('idempotency_conflict');
        const state = await this.execution.state(workId);
        assertExecutionAuthority(this.services, state);
        return structuredClone(state.modelCalls.find(c => c.purpose === 'session_compact' && c.compactRequestId === options.requestId) ?? null);
      }
    }
    return this.reserveModel(workId, options);
  }
  private async reserveModel(workId: string, compactRequest?: CompactRequestOptions): Promise<ModelCall | null> {
    if (this.services.executionAuthority) assertExecutionAuthority(this.services, await this.execution.state(workId));
    await this.refresh(workId);
    await prepareExecutionBoundary(this.services, workId);
    const state = await this.execution.budgets.prepare(workId); const control = this.execution.control(state);
    assertExecutionAuthority(this.services, state);
    if (!(await sessionInputsCurrent(this.services, state))) throw new Error('model_session_changed');
    const compact = compactRequest !== undefined;
    const agentTurn = !compact && !!state.goal.responseRequirement;
    if (compactRequest?.expectedGoalRevision !== undefined && compactRequest.expectedGoalRevision !== state.goal.revision) throw new Error('stale_user_command');
    if (compact) {
      const pending = state.modelCalls.find(c => transientStatuses.includes(c.status));
      if (pending) {
        if (pending.purpose === 'session_compact' && !compactRequest.requestId) return structuredClone(pending);
        throw new Error('session_compact_pending');
      }
      if (!state.conversation?.session || ['paused', 'cancelled', 'failed', 'completed', 'blocked'].includes(state.status) ||
        state.attempts.some(a => ['reserved', 'running', 'received'].includes(a.status)) ||
        state.obligations.some(o => o.kind === 'effect_reconciliation' && o.status === 'pending')) throw new Error('model_not_needed');
    } else if (control.kind !== 'replan') throw new Error('model_not_needed');
    await validateReadWaits(this.services, this.tools, state);
    if (!state.policy.allowedDestinations.includes(this.destination)) throw new Error('model_destination_denied');
    if (!this.allowed(state)) throw new Error('model_disclosure_denied');
    if (state.budget.used.unmeasuredModelCalls) throw new Error('model_usage_unknown');
    if (!compact) {
      const gate = progressGate(state, this.services.clock.now(), modelFailureKey(state, this.identity, this.destination, this.services.digester));
      if (gate) throw new Error(gate.reason);
    }
    const limits = effectiveExecutionLimits(state);
    if (state.budget.used.modelCalls + state.budget.reservedModelCalls >= limits.modelCalls) throw new Error(limits.modelCalls < state.budget.limits.modelCalls ? 'fast_model_budget_exhausted' : 'model_budget_exhausted');
    if (this.services.clock.now() >= state.deadlineAt) throw new Error('deadline_exceeded');
    if (!(await effectProofsCurrent(this.services, state))) throw new Error('model_reservation_stale');
    const purpose = compact ? 'session_compact' : agentTurn ? 'agent_turn' : undefined;
    const profileDigest = this.inputProfile(purpose);
    const inputLimits = resolveModelInputLimits(this.services.planner.capabilities, this.config);
    const inspected = !compact && this.canInspect(state) ? await this.inspectNext(state) : undefined;
    if (inspected?.inspection.kind === 'required_overflow') throw new Error('model_input_required_overflow');
    if (inspected?.inspection.kind === 'needs_session_compact') {
      this.#nextInput = undefined;
      const call = await this.reserveModel(workId, { force: true });
      if (!call) throw new Error('session_compact_capacity');
      return call;
    }
    const id = inspected?.callId ?? this.services.ids.next('model');
    let head: ContextHead | undefined, metrics: ContextMetrics | undefined;
    let options: ModelCallOptions, bytes: Uint8Array, estimate: { tokens: number; bytes: number; method: string }, compactInputDigest: string | undefined;
    let inputCurrent: (value: WorkState) => Promise<boolean>;
    let inputDefinitionsCurrent: (value: WorkState) => boolean = () => true;
    if (compact) {
      this.#nextInput = undefined;
      const prepared = await this.compacts.prepare(state, id, inputLimits, compactRequest.force);
      if (!prepared) {
        if (compactRequest.requestId) await transact(this.services, workId, `session-compact-request:${compactRequest.requestId}`, 'session_compact_requested', this.compactRequest(compactRequest), next => {
          if (next.revision !== state.revision) throw new Error('model_reservation_stale');
        });
        return null;
      }
      ({ options, bytes, estimate } = prepared); compactInputDigest = prepared.compact.inputDigest;
      inputCurrent = value => this.compacts.current(value, prepared.compact);
      if (!compactRequest.requestId && state.modelCalls.filter(c => c.purpose === 'session_compact' && c.compactInputDigest === compactInputDigest &&
        c.goalRevision === state.goal.revision && ['rejected', 'unknown', 'cancelled'].includes(c.status)).length >= 2) return null;
    } else if (agentTurn) {
      this.#nextInput = undefined;
      if (inspected && inspected.toolsRevision !== this.tools.revision) throw new Error('context_state_changed');
      const prepared = inspected ? await this.turns.materialize(inspected.inspection) : await this.turns.prepare(state, id, inputLimits);
      ({ options, head, estimate, bytes } = prepared); metrics = prepared.frame.metrics;
      inputCurrent = value => this.turns.current(value, prepared.turn, prepared.options);
      inputDefinitionsCurrent = value => this.context.outgoingDefinitionsCurrent(prepared.turn.packet, prepared.options, value);
    } else {
      this.#nextInput = undefined;
      if (inspected && inspected.toolsRevision !== this.tools.revision) throw new Error('context_state_changed');
      const prepared = inspected ? await this.context.materialize(inspected.inspection) : await this.context.prepare(state, { ...inputLimits, callId: id });
      ({ options, head, estimate } = prepared); metrics = prepared.frame.metrics;
      bytes = new TextEncoder().encode(JSON.stringify({ packet: prepared.packet, options }));
      inputCurrent = value => sessionContextCurrent(this.services, value, prepared.packet.session);
      inputDefinitionsCurrent = value => this.context.outgoingDefinitionsCurrent(prepared.packet, prepared.options, value);
    }
    const failureKey = modelFailureKey(state, this.identity, this.destination, this.services.digester, compactInputDigest);
    const gate = progressGate(state, this.services.clock.now(), failureKey); if (gate) throw new Error(gate.reason);
    if (assessInputFit(estimate, inputLimits, bytes.byteLength).kind !== 'fit') throw new Error('model_input_limit');
    if (profileDigest !== this.inputProfile(purpose)) throw new Error('model_input_profile_changed');
    const reservation = estimate.tokens + options.maxOutputTokens;
    const budget = budgetAllocationError(state, { modelCalls: 1, tokens: reservation }); if (budget) throw new Error(budget);
    if (!Number.isSafeInteger(reservation) || state.budget.used.tokens + state.budget.reservedTokens + reservation > state.budget.limits.tokens) throw new Error('token_budget_exhausted');
    const inputArtifact = await this.services.artifacts.put(bytes, { tenantId: state.policy.tenantId, labels: disclosureLabels(state), mediaType: 'application/json' });
    if (!(await inputCurrent(state)) || !(await knowledgeInputsCurrent(this.services, state)) || !(await effectProofsCurrent(this.services, state)) || !inputDefinitionsCurrent(state)) throw new Error('model_reservation_stale');
    const call: ModelCall = { id, provider: this.identity.provider, model: this.identity.model, adapterRevision: this.identity.revision, destination: this.destination, owner: this.owner,
      ...(compact ? { purpose: 'session_compact', compactInputDigest, ...(compactRequest.requestId ? { compactRequestId: compactRequest.requestId } : {}) } : {}),
      ...(agentTurn ? { purpose: 'agent_turn', agentTurnPromptDigest: this.services.planner.prompt!.digest } : {}),
      goalRevision: state.goal.revision, baseStateRevision: state.revision, basePlanRevision: state.plan?.revision ?? 0,
      semanticDigest: this.digest(state, agentTurn ? 4 : state.conversation?.session ? 3 : 2), semanticVersion: agentTurn ? 4 : state.conversation?.session ? 3 : 2,
      ...(state.personalMemorySelection ? { personalMemoryDigest: personalMemoryDigest(this.services, state) } : {}), failureKey, inputArtifact, replyArtifact: null,
      inputProfileDigest: profileDigest,
      inputEstimate: estimate.tokens, maxOutputTokens: options.maxOutputTokens, tokenReservation: reservation, inputTokens: null, outputTokens: null, usageStatus: 'reserved', status: 'reserved',
      startedAt: this.services.clock.now(), leaseUntil: Math.min(state.deadlineAt, this.services.clock.now() + this.config.leaseMs), finishedAt: null, expired: false, outcome: null, reason: estimate.method, ...(metrics ? { contextMetrics: metrics } : {}) };
    const explicit = compactRequest?.requestId;
    const publication = await transact(this.services, workId, explicit ? `session-compact-request:${explicit}` : `model-reserve:${id}`, explicit ? 'session_compact_requested' : 'model_call_reserved',
      explicit ? this.compactRequest(compactRequest!) : { callId: id, destination: this.destination, provider: call.provider, model: call.model, estimate: estimate.tokens, ...(compact ? { purpose: 'session_compact' } : {}) }, next => {
      assertExecutionAuthority(this.services, next);
      if (next.revision !== state.revision || (!compact && this.execution.control(next).kind !== 'replan') || progressGate(next, this.services.clock.now(), failureKey)) throw new Error('model_reservation_stale');
      if (profileDigest !== this.inputProfile(purpose)) throw new Error('model_input_profile_changed');
      if (!inputDefinitionsCurrent(next)) throw new Error('model_reservation_stale');
      const budget = budgetAllocationError(next, { modelCalls: 1, tokens: reservation }); if (budget) throw new Error(budget);
      if (head) next.contextHead = head;
      next.modelCalls.push(call); next.budget.reservedModelCalls++; next.budget.reservedTokens += reservation;
      next.status = 'waiting'; next.statusReason = 'model_call_pending'; next.retryWakeAt = null;
    }, async () => { if (!(await inputCurrent(state)) || !(await knowledgeInputsCurrent(this.services, state))) throw new Error('context_state_changed');
      await assertBudgetAuthority(this.services, await this.execution.state(workId), { modelCalls: 1, tokens: reservation }, { kind: 'model' });
      if (!(await effectProofsCurrent(this.services, state))) throw new Error('context_state_changed');
      if (this.services.executionAuthority) assertExecutionAuthority(this.services, await this.execution.state(workId));
      if (!inputDefinitionsCurrent(state)) throw new Error('context_state_changed'); });
    if (explicit && !publication.committed) return structuredClone(publication.state.modelCalls.find(c => c.purpose === 'session_compact' && c.compactRequestId === explicit) ?? null);
    const published = await this.refresh(workId);
    const current = this.call(published, id);
    if (current.status !== 'reserved' || ['cancelled', 'paused', 'failed', 'completed'].includes(published.status) || !this.allowed(published, current) || this.digest(published, current.semanticVersion ?? 1) !== current.semanticDigest ||
      !(await inputCurrent(published)) || !(await knowledgeInputsCurrent(this.services, published)) || !(await effectProofsCurrent(this.services, published)) ||
      (await this.execution.state(workId)).revision !== published.revision || !inputDefinitionsCurrent(published)) throw new Error('context_state_changed');
    return structuredClone(current);
  }
  async dispatch(workId: string, callId: string): Promise<boolean> {
    if (this.services.executionAuthority) assertExecutionAuthority(this.services, await this.execution.state(workId));
    await this.refresh(workId);
    await this.execution.budgets.prepare(workId);
    const before = await this.execution.state(workId), pending = this.call(before, callId);
    if (pending.status === 'reserved' && pending.owner === this.owner && !(await this.outgoingInputCurrent(before, pending))) {
      await this.rejectChangedInput(workId, before, pending); return false;
    }
    const definitionsCurrent = pending.status === 'reserved' && pending.owner === this.owner ? await this.outgoingDefinitionsCheck(before, pending) : () => true;
    if (pending.status === 'reserved' && pending.owner === this.owner && !definitionsCurrent(before)) {
      await this.rejectChangedInput(workId, before, pending, 'model_tools_changed'); return false;
    }
    const dispatchProfile = this.inputProfile(pending.purpose);
    try {
    const result = await transact(this.services, workId, `model-dispatch:${callId}`, 'model_call_dispatched', { callId, owner: this.owner }, state => {
      const call = this.call(state, callId);
      if (dispatchProfile !== this.inputProfile(call.purpose)) throw new Error('model_not_dispatchable');
      if (!definitionsCurrent(state)) throw new Error('model_tools_changed');
      const budget = budgetAllocationError(state); if (budget) throw new Error(budget);
      if (state.obligations.some(o => o.kind === 'effect_reconciliation' && o.status === 'pending')) throw new Error('model_not_dispatchable');
      if (call.status !== 'reserved' || call.owner !== this.owner || !this.matches(call) || !this.profileCurrent(call) || !this.allowed(state, call) || this.digest(state, call.semanticVersion ?? 1) !== call.semanticDigest || ['paused', 'cancelled', 'failed', 'completed'].includes(state.status)) throw new Error('model_not_dispatchable');
      if (this.services.clock.now() >= call.leaseUntil) throw new Error('model_lease_expired');
      call.status = 'running'; state.budget.reservedModelCalls--; state.budget.used.modelCalls++;
    }, async () => {
      const current = await this.execution.state(workId);
      if (!(await this.outgoingInputCurrent(current, this.call(current, callId)))) throw new Error('model_not_dispatchable');
      if (!(await this.sessionCurrent(current, this.call(current, callId)))) throw new Error('model_not_dispatchable');
      await assertBudgetAuthority(this.services, current, {}, { kind: 'model' });
      if (!(await effectProofsCurrent(this.services, current))) throw new Error('model_not_dispatchable');
      if (this.services.executionAuthority) assertExecutionAuthority(this.services, await this.execution.state(workId));
      if (!definitionsCurrent(current)) throw new Error('model_tools_changed');
    }); return result.committed;
    } catch (error) {
      if (!(error instanceof Error && error.message === 'model_tools_changed')) throw error;
      const current = await this.execution.state(workId), call = this.call(current, callId);
      if (call.status === 'reserved' && call.owner === this.owner) await this.rejectChangedInput(workId, current, call, 'model_tools_changed');
      return false;
    }
  }
  private normalized(value: unknown, call: ModelCall): ModelReply | SessionCompactReply | AgentTurnReply {
    try {
      if (new TextEncoder().encode(JSON.stringify(value)).byteLength > this.config.maxReplyBytes) throw new Error('oversize');
      const reply = call.purpose === 'session_compact' ? parseContract(SessionCompactReplySchema, value) : call.purpose === 'agent_turn' ? parseContract(AgentTurnReplySchema, value) : parseContract(ModelReplySchema, value);
      if (reply.inputTokens !== null && reply.outputTokens !== null && !Number.isSafeInteger(reply.inputTokens + reply.outputTokens)) throw new Error('overflow');
      if (reply.status === 'ok' && (reply.provider !== call.provider || reply.model !== call.model)) return { status: 'invalid', code: 'model_identity_mismatch', inputTokens: reply.inputTokens, outputTokens: reply.outputTokens };
      return reply.status === 'ok' ? reply : { ...reply, code: `model_${reply.status}` };
    } catch { return { status: 'invalid', code: 'model_reply_invalid', inputTokens: null, outputTokens: null }; }
  }
  async receive(workId: string, callId: string, value: unknown): Promise<void> {
    for (let n = 0; n < 8; n++) {
      try { await this.receiveOnce(workId, callId, value); return; }
      catch (error) { if (!(error instanceof Error && error.message === 'model_receive_policy_changed')) throw error; }
    }
    throw new Error('model_receive_contention');
  }
  private async receiveOnce(workId: string, callId: string, value: unknown): Promise<void> {
    const state = await this.execution.state(workId); const call = this.call(state, callId);
    if (call.replyArtifact || !['running', 'unknown'].includes(call.status)) return;
    let reply = this.normalized(value, call);
    const basePermission = this.allowed(state, call);
    const permitted = basePermission && !state.obligations.some(o => o.kind === 'effect_reconciliation' && o.status === 'pending') &&
      await this.sessionCurrent(state, call) && await knowledgeInputsCurrent(this.services, state) && await effectProofsCurrent(this.services, state);
    if (!permitted) reply = { status: 'error', code: 'model_authorization_changed', inputTokens: reply.inputTokens, outputTokens: reply.outputTokens };
    const artifact = await this.services.artifacts.put(new TextEncoder().encode(JSON.stringify(reply)), { tenantId: call.inputArtifact.tenantId, labels: permitted ? call.inputArtifact.labels : [], mediaType: 'application/json' });
    if (permitted && (!(await this.sessionCurrent(state, call)) || !(await knowledgeInputsCurrent(this.services, state)) || !(await effectProofsCurrent(this.services, state)))) throw new Error('model_receive_policy_changed');
    await transact(this.services, workId, `model-receive:${callId}`, 'model_reply_received', { callId, outcome: reply.status }, next => {
      const current = this.call(next, callId); if (current.replyArtifact) return;
      if (this.allowed(next, current) !== basePermission || dataGeneration(next) !== dataGeneration(state)) throw new Error('model_receive_policy_changed');
      if (this.services.digester.digest(asJson(next.computerReconciliations ?? [])) !==
        this.services.digester.digest(asJson(state.computerReconciliations ?? []))) throw new Error('model_receive_policy_changed');
      next.budget.used.tokens += (reply.inputTokens ?? 0) + (reply.outputTokens ?? 0);
      if (reply.inputTokens !== null && reply.outputTokens !== null) {
        next.budget.reservedTokens -= current.tokenReservation;
        if (current.usageStatus === 'unknown') next.budget.used.unmeasuredModelCalls--;
        current.usageStatus = 'reported';
      } else { if (current.usageStatus !== 'unknown') next.budget.used.unmeasuredModelCalls++; current.usageStatus = 'unknown'; }
      current.inputTokens = reply.inputTokens; current.outputTokens = reply.outputTokens; current.replyArtifact = artifact; current.outcome = reply.status;
      current.expired ||= this.services.clock.now() >= current.leaseUntil; current.status = 'received'; current.finishedAt = this.services.clock.now();
    }, async () => {
      if (permitted && (!(await this.sessionCurrent(state, call)) || !(await effectProofsCurrent(this.services, state)))) throw new Error('model_receive_policy_changed');
      if (this.services.executionAuthority && this.allowed(await this.execution.state(workId), call) !== basePermission) throw new Error('model_receive_policy_changed');
    });
  }
  async execute(workId: string, callId: string) {
    if (!(await this.dispatch(workId, callId))) return;
    const abort = new AbortController(); const unregister = this.execution.registerCancellation(workId, callId, abort);
    const authoritySignal = this.services.executionAuthority?.signal;
    const revoke = () => abort.abort();
    authoritySignal?.addEventListener('abort', revoke, { once: true });
    if (authoritySignal?.aborted) revoke();
    let preflightTimer: ReturnType<typeof setTimeout> | undefined;
    try {
    const state = await this.execution.state(workId); const call = this.call(state, callId);
    if (!this.allowed(state, call) || this.digest(state, call.semanticVersion ?? 1) !== call.semanticDigest || call.expired) { await this.receive(workId, callId, { status: 'cancelled', code: 'model_not_sent', inputTokens: 0, outputTokens: 0 }); return; }
    preflightTimer = setTimeout(() => abort.abort(), Math.max(1, Math.min(2147483647, call.leaseUntil - this.services.clock.now())));
    const compactInput = call.purpose === 'session_compact' ? await this.compacts.load(state, call) : null;
    const turnInput = call.purpose === 'agent_turn' ? await this.turns.load(state, call) : null;
    const input = turnInput ? { packet: turnInput.turn.packet, options: turnInput.options } : compactInput ? null : JSON.parse(new TextDecoder().decode(await this.services.artifacts.get(call.inputArtifact, state.policy))) as { packet: ContextPacket; options: ModelCallOptions };
    const latest = await this.execution.state(workId);
    let sendProfile: string;
    try { sendProfile = this.inputProfile(call.purpose); }
    catch { await this.receive(workId, callId, { status: 'cancelled', code: 'model_not_sent', inputTokens: 0, outputTokens: 0 }); return; }
    const eligible = (value: WorkState) => { const active = this.call(value, callId);
      return !abort.signal.aborted && active.status === 'running' && !active.expired && this.matches(active) && this.profileCurrent(active) && this.allowed(value, active) &&
        !value.obligations.some(o => o.kind === 'effect_reconciliation' && o.status === 'pending') &&
        !['paused', 'cancelled', 'failed', 'completed'].includes(value.status) && this.digest(value, active.semanticVersion ?? 1) === active.semanticDigest && this.services.clock.now() < active.leaseUntil; };
    const sourcesValid = eligible(latest) && await this.outgoingInputCurrent(latest, call) &&
      (compactInput ? await this.compacts.current(latest, compactInput.compact, abort.signal) : await this.context.sourcesCurrent(input!.packet, latest, abort.signal));
    const knowledgeValid = sourcesValid && await knowledgeInputsCurrent(this.services, latest);
    let budgetValid = true;
    try { await assertBudgetAuthority(this.services, latest, {}, { kind: 'model' }); } catch { budgetValid = false; }
    const effectsValid = knowledgeValid && await effectProofsCurrent(this.services, latest);
    const sessionsValid = effectsValid && (compactInput ? await this.compacts.current(latest, compactInput.compact, abort.signal) : await sessionContextCurrent(this.services, latest, input!.packet.session, abort.signal));
    const checked = await this.execution.state(workId);
    if (!budgetValid || !knowledgeValid || !effectsValid || !sessionsValid || checked.revision !== latest.revision || !eligible(checked) || !this.sameInputProfile(call.purpose, sendProfile) ||
      (compactInput ? !this.services.planner.compact : turnInput ? !(await this.turns.current(checked, turnInput.turn, turnInput.options, abort.signal)) : !this.context.definitionsCurrent(input!.packet, input!.options, checked))) {
      await this.receive(workId, callId, { status: 'cancelled', code: 'model_not_sent', inputTokens: 0, outputTokens: 0 }); return;
    }
    const final = this.services.executionAuthority ? await this.execution.state(workId) : checked;
    if (this.services.executionAuthority && (final.revision !== checked.revision || !eligible(final)) || !this.profileCurrent(call) || !this.sameInputProfile(call.purpose, sendProfile) ||
      !compactInput && !this.context.outgoingDefinitionsCurrent(input!.packet, input!.options, final)) {
      await this.receive(workId, callId, { status: 'cancelled', code: 'model_not_sent', inputTokens: 0, outputTokens: 0 }); return;
    }
    clearTimeout(preflightTimer); preflightTimer = undefined;
    const pending = (async () => {
      let reply: unknown;
      try { reply = compactInput ? await this.services.planner.compact!(compactInput.compact, abort.signal, compactInput.options) : turnInput ? await this.services.planner.turn!(turnInput.turn, abort.signal, turnInput.options) : await this.services.planner.propose(input!.packet, abort.signal, input!.options); }
      catch { reply = { status: 'error', code: 'model_transport_failed', inputTokens: null, outputTokens: null }; }
      await this.receive(workId, callId, reply);
    })().catch(() => { this.#failures.set(callId, 'model_receive_failed'); });
    this.#pending.set(callId, pending);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<false>(resolve => { onAbort = () => resolve(false); if (abort.signal.aborted) resolve(false); else abort.signal.addEventListener('abort', onAbort, { once: true }); });
    const finished = await Promise.race([pending.then(() => true), interrupted, new Promise<false>(resolve => { timer = setTimeout(() => { abort.abort(); resolve(false); }, Math.max(1, call.leaseUntil - this.services.clock.now())); })]);
    if (timer) clearTimeout(timer);
    if (onAbort) abort.signal.removeEventListener('abort', onAbort);
    if (!finished) await this.recover(workId, callId, true);
    else this.#pending.delete(callId);
    } finally { if (preflightTimer) clearTimeout(preflightTimer); authoritySignal?.removeEventListener('abort', revoke); unregister(); }
  }
  async settlePending() { await Promise.all(this.#pending.values()); this.#pending.clear(); return [...this.#failures.entries()]; }
  async recover(workId: string, callId: string, force = false) {
    const prior = await this.execution.state(workId); const call = this.call(prior, callId);
    if (!['reserved', 'running'].includes(call.status)) return;
    await transact(this.services, workId, `model-recover:${callId}`, 'model_call_recovered', { callId }, state => {
      const c = this.call(state, callId); if (!['reserved', 'running'].includes(c.status)) return;
      if (!force && !c.expired && this.services.clock.now() < c.leaseUntil) throw new Error('model_call_not_expired');
      if (c.status === 'reserved') { state.budget.reservedModelCalls--; state.budget.reservedTokens -= c.tokenReservation; c.usageStatus = 'not_called'; c.status = 'cancelled'; }
      else { if (c.usageStatus !== 'unknown') state.budget.used.unmeasuredModelCalls++; c.usageStatus = 'unknown'; c.status = 'unknown'; }
      c.expired = true; c.finishedAt = this.services.clock.now(); c.reason = 'model_lease_expired';
    });
  }
  private async reject(workId: string, callId: string, reason: string) {
    const purpose = this.call(await this.execution.state(workId), callId).purpose;
    await transact(this.services, workId, `model-reject:${callId}`, purpose === 'session_compact' ? 'model_compact_rejected' : purpose === 'agent_turn' ? 'model_turn_rejected' : 'model_plan_rejected', { callId, reason }, state => {
      const call = this.call(state, callId); if (call.status !== 'received') return; call.status = 'rejected'; call.reason = reason;
      if (call.goalRevision === state.goal.revision && !['paused', 'cancelled', 'failed', 'completed'].includes(state.status))
        captureProgress(state, this.services.digester, `model:${call.id}:settled`, this.services.clock.now(), {
          failureKey: call.failureKey ?? modelFailureKey(state, this.identity, this.destination, this.services.digester, call.compactInputDigest),
        });
    });
  }
  async adopt(workId: string, callId: string): Promise<boolean> {
    const state = await this.refresh(workId); const call = this.call(state, callId);
    if (call.purpose === 'session_compact') return this.adoptCompact(workId, callId);
    if (call.status !== 'received' || !call.replyArtifact) return call.status === 'accepted' &&
      this.allowed(state, call) && !state.obligations.some(o => o.kind === 'effect_reconciliation' && o.status === 'pending') && await this.sessionCurrent(state, call) && await effectProofsCurrent(this.services, state);
    if (!this.allowed(state, call) || call.expired || !(await this.sessionCurrent(state, call)) || state.obligations.some(o => o.kind === 'effect_reconciliation' && o.status === 'pending') ||
      ['paused', 'cancelled', 'failed', 'completed'].includes(state.status) || this.digest(state, call.semanticVersion ?? 1) !== call.semanticDigest) { await this.reject(workId, callId, 'model_snapshot_stale'); return false; }
    const storedReply = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await this.services.artifacts.get(call.replyArtifact, state.policy)));
    const turnReply = call.purpose === 'agent_turn' ? parseContract(AgentTurnReplySchema, storedReply) : null;
    if (turnReply?.status === 'ok' && turnReply.result.kind !== 'plan') return this.adoptResponse(state, call, turnReply.result);
    const reply: ModelReply = turnReply ? turnReply.status === 'ok' && turnReply.result.kind === 'plan'
      ? { ...turnReply, proposal: turnReply.result.proposal } : turnReply as Exclude<AgentTurnReply, { status: 'ok' }> : parseContract(ModelReplySchema, storedReply);
    if (reply.status !== 'ok') { await this.reject(workId, callId, `model_${reply.status}`); return false; }
    if (reply.proposal.baseStateRevision !== call.baseStateRevision || reply.proposal.baseGoalRevision !== call.goalRevision || reply.proposal.basePlanRevision !== call.basePlanRevision) { await this.reject(workId, callId, 'model_proposal_base_mismatch'); return false; }
    const historical = (await this.services.state.events(workId, 0)).filter(e => ['plan_accepted', 'model_plan_accepted'].includes(e.type)).flatMap(e => parseContract(PlanProposalSchema, e.data['payload']).tasks);
    if (!(await knowledgeInputsCurrent(this.services, state))) { await refreshKnowledge(this.services, workId, id => this.execution.interrupt(id)); return false; }
    if (!(await effectProofsCurrent(this.services, state))) { await refreshEffectProofs(this.services, workId); return false; }
    try {
      await this.execution.budgets.prepare(workId);
      await transact(this.services, workId, `model-adopt:${callId}`, 'model_plan_accepted', asJson(reply.proposal), next => {
        const current = this.call(next, callId);
        if (current.status !== 'received' || current.expired || !this.allowed(next, current) || this.digest(next, current.semanticVersion ?? 1) !== current.semanticDigest || ['paused', 'cancelled', 'failed', 'completed'].includes(next.status)) throw new Error('model_snapshot_stale');
        const valid = validatePlan({ ...reply.proposal, baseStateRevision: next.revision }, next, this.tools, this.services.digester, historical);
        current.reason = applyValidatedPlan(next, valid, this.services.digester, true); current.status = 'accepted';
        captureProgress(next, this.services.digester, `model:${current.id}:settled`, this.services.clock.now());
      }, async () => {
        const current = await this.execution.state(workId);
        if (!(await this.sessionCurrent(current, this.call(current, callId)))) throw new Error('model_snapshot_stale');
        await assertBudgetAuthority(this.services, current, current.plan && !unchangedPlanTasks(current, reply.proposal, this.services.digester) ? { replans: 1 } : {}, { kind: 'model' });
        if (!(await effectProofsCurrent(this.services, current))) throw new Error('effect_proof_unavailable');
        if (this.services.executionAuthority && !this.allowed(await this.execution.state(workId), current.modelCalls.find(value => value.id === callId))) throw new Error('model_snapshot_stale');
      });
      const settled = await this.refresh(workId);
      return this.call(settled, callId).status === 'accepted' && !this.call(settled, callId).expired &&
        this.allowed(settled, this.call(settled, callId)) &&
        !settled.obligations.some(o => o.kind === 'effect_reconciliation' && o.status === 'pending') && await this.sessionCurrent(settled, this.call(settled, callId)) && await effectProofsCurrent(this.services, settled);
    } catch (error) {
      const code = error instanceof Error && /^[a-z][a-z0-9_]+$/.test(error.message) ? error.message : 'model_plan_invalid';
      await this.reject(workId, callId, code); return false;
    }
  }
  private async adoptResponse(state: WorkState, call: ModelCall, result: Exclude<AgentTurnResult, { kind: 'plan' }>): Promise<boolean> {
    const workId = state.id, callId = call.id;
    const active = (value: WorkState) => {
      const current = this.call(value, callId);
      return current.status === 'received' && !current.expired && this.matches(current) && this.allowed(value, current) &&
        !!value.goal.responseRequirement && !!value.conversation?.session &&
        !['paused', 'cancelled', 'failed', 'completed'].includes(value.status) &&
        this.digest(value, current.semanticVersion ?? 1) === current.semanticDigest &&
        !value.obligations.some(obligation => obligation.kind === 'effect_reconciliation' && obligation.status === 'pending');
    };
    try {
      if (!active(state) || !(await this.sessionCurrent(state, call)) || !(await knowledgeInputsCurrent(this.services, state)) ||
        !(await effectProofsCurrent(this.services, state))) throw new Error('model_snapshot_stale');
      const observedEvidenceIds = accessibleEvidence(state.evidence, state.policy, state.goal.scope).map(item => item.id).sort();
      if (result.kind === 'answer' && (!result.text.trim() || new Set(result.evidenceIds).size !== result.evidenceIds.length ||
        result.evidenceIds.some(id => !observedEvidenceIds.includes(id)))) throw new Error('agent_answer_evidence_invalid');
      if (result.kind === 'question' && !result.question.trim()) throw new Error('agent_question_invalid');
      const artifact = result.kind === 'answer' ? await this.services.artifacts.put(new TextEncoder().encode(result.text), {
        tenantId: state.policy.tenantId, labels: disclosureLabels(state), mediaType: 'text/plain',
      }) : null;
      await transact(this.services, workId, `model-adopt:${callId}`, 'model_turn_accepted', { callId, kind: result.kind }, next => {
        if (!active(next)) throw new Error('model_snapshot_stale');
        const current = this.call(next, callId);
        current.status = 'accepted'; current.reason = result.kind === 'answer' ? 'agent_answer_stored' : 'agent_question_stored';
        if (next.conversation?.sessionReviewRequired) next.conversation.sessionReviewRequired = false;
        if (next.personalMemoryReviewRequired) next.personalMemoryReviewRequired = false;
        if (result.kind === 'answer') {
          next.generatedAnswer = { id: `answer:${callId}`, callId, goalRevision: next.goal.revision,
            planRevision: next.plan?.revision ?? 0, dataGeneration: dataGeneration(next), input: structuredClone(next.conversation!.session!),
            inputArtifact: current.inputArtifact, promptDigest: current.agentTurnPromptDigest!, basisDigest: generatedAnswerBasis(this.services, next),
            artifact: artifact!, evidenceIds: [...result.evidenceIds], observedEvidenceIds, assessment: structuredClone(result.assessment), createdAt: this.services.clock.now() };
          next.status = 'ready'; next.statusReason = 'agent_answer_stored';
        } else {
          const id = `agent-question:${callId}`;
          if (next.obligations.some(obligation => obligation.id === id)) throw new Error('agent_question_conflict');
          next.obligations.push({ id, kind: 'response', reason: result.question, status: 'pending', wakeKey: id, dueAt: null });
          next.status = 'waiting'; next.statusReason = 'pending_obligation';
        }
        next.retryWakeAt = null;
        const completedAnswer = result.kind === 'answer' && result.assessment.verdict === 'satisfied' && result.assessment.missing.length === 0;
        captureProgress(next, this.services.digester, `model:${callId}:settled`, this.services.clock.now(), completedAnswer ? {
          additionalKeys: [`response:${this.services.digester.digest(asJson({ input: next.conversation!.session, result }))}`],
        } : {});
      }, async () => {
        const latest = await this.execution.state(workId);
        if (!active(latest) || !(await this.sessionCurrent(latest, this.call(latest, callId))) ||
          !(await knowledgeInputsCurrent(this.services, latest)) || !(await effectProofsCurrent(this.services, latest))) throw new Error('model_snapshot_stale');
        await assertBudgetAuthority(this.services, latest, {}, { kind: 'model' });
        if (this.services.executionAuthority && !active(await this.execution.state(workId))) throw new Error('model_snapshot_stale');
      });
      return this.call(await this.execution.state(workId), callId).status === 'accepted';
    } catch (error) {
      const code = error instanceof Error && /^[a-z][a-z0-9_]+$/.test(error.message) ? error.message : 'agent_turn_invalid';
      await this.reject(workId, callId, code); return false;
    }
  }
  private async adoptCompact(workId: string, callId: string): Promise<boolean> {
    const source = this.services.sessionCompacts;
    if (!source) throw new Error('session_compact_unavailable');
    const state = await this.refresh(workId); const call = this.call(state, callId);
    if (!['received', 'accepted'].includes(call.status) || !call.replyArtifact) return false;
    const { compact } = await this.compacts.load(state, call);
    const active = (value: WorkState) => {
      const current = this.call(value, callId);
      return this.allowed(value, current) && this.digest(value, current.semanticVersion ?? 1) === current.semanticDigest &&
        !['paused', 'cancelled', 'failed', 'completed', 'blocked'].includes(value.status) &&
        !value.obligations.some(o => o.kind === 'effect_reconciliation' && o.status === 'pending');
    };
    if (!active(state) || !(await this.compacts.current(state, compact)) || !(await knowledgeInputsCurrent(this.services, state)) || !(await effectProofsCurrent(this.services, state))) {
      if (call.status === 'received') await this.reject(workId, callId, 'model_snapshot_stale');
      return false;
    }
    const reply = parseContract(SessionCompactReplySchema, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await this.services.artifacts.get(call.replyArtifact, state.policy))));
    if (reply.status !== 'ok') { if (call.status === 'received') await this.reject(workId, callId, `model_${reply.status}`); return false; }
    const matches = (receipt: NonNullable<Awaited<ReturnType<typeof source.compactPublication>>>) =>
      this.compacts.matchesReceipt(state, call, compact, receipt) &&
      this.services.digester.digest(asJson(receipt.content)) === this.services.digester.digest(asJson(reply.candidate.content));
    // Query the immutable receipt before lease expiry: a previous publication may need only local settlement.
    let receipt = await source.compactPublication(state, callId, compact);
    if (receipt && !matches(receipt)) throw new Error('session_compact_receipt_invalid');
    if (call.status === 'accepted') return !!receipt;
    if (!receipt) {
      if (call.expired) { await this.reject(workId, callId, 'model_snapshot_stale'); return false; }
      const current = await this.execution.budgets.prepare(workId);
      if (!active(current) || !(await this.compacts.current(current, compact)) || !(await effectProofsCurrent(this.services, current))) {
        await this.reject(workId, callId, 'model_snapshot_stale'); return false;
      }
      await assertBudgetAuthority(this.services, current, {}, { kind: 'model' });
      const beforePublish = this.services.executionAuthority ? await this.execution.state(workId) : current;
      if (beforePublish.revision !== current.revision || !active(beforePublish)) { await this.reject(workId, callId, 'model_snapshot_stale'); return false; }
      try { receipt = await source.publishCompact(current, callId, compact, reply.candidate); }
      catch (error) {
        // A store can publish and then fail while acknowledging. Never charge another call before checking its receipt.
        const latest = await this.execution.state(workId);
        receipt = await source.compactPublication(latest, callId, compact);
        if (!receipt) {
          const code = error instanceof Error && /^[a-z][a-z0-9_]+$/.test(error.message) ? error.message : 'session_compact_failed';
          await this.reject(workId, callId, code); return false;
        }
      }
      if (!matches(receipt)) throw new Error('session_compact_receipt_invalid');
    }
    try {
      await transact(this.services, workId, `model-adopt:${callId}`, 'model_compact_accepted', { callId, summaryId: receipt.ref.id, inputDigest: compact.inputDigest }, next => {
        const current = this.call(next, callId);
        if (current.status !== 'received' || !active(next)) throw new Error('model_snapshot_stale');
        current.status = 'accepted'; current.reason = 'session_compact_published';
        next.status = 'ready'; next.statusReason = 'session_compact_accepted'; next.retryWakeAt = null;
      }, async () => {
        const current = await this.execution.state(workId);
        if (!active(current) || !(await this.compacts.current(current, compact)) || !(await effectProofsCurrent(this.services, current))) throw new Error('model_snapshot_stale');
        const published = await source.compactPublication(current, callId, compact);
        if (!published || !matches(published)) throw new Error('session_compact_receipt_invalid');
        await assertBudgetAuthority(this.services, current, {}, { kind: 'model' });
        if (this.services.executionAuthority && !active(await this.execution.state(workId))) throw new Error('model_snapshot_stale');
      });
    } catch (error) {
      if (!(error instanceof Error && error.message === 'model_snapshot_stale')) throw error;
      await this.reject(workId, callId, 'model_snapshot_stale'); return false;
    }
    const final = await this.execution.state(workId);
    return this.call(final, callId).status === 'accepted' && active(final) && await this.compacts.current(final, compact);
  }
  /** Compact-only orchestration. auto=false never allocates another call or runs planning/tools. */
  async compactStep(workId: string, options: { auto?: boolean; nextModelEnabled?: boolean } = {}): Promise<PlanningControl | null> {
    const state = await this.refresh(workId);
    const pending = state.modelCalls.find(c => transientStatuses.includes(c.status));
    if (pending) { this.#nextInput = undefined; return pending.purpose === 'session_compact' ? this.step(workId) : null; }
    const control = this.execution.control(state);
    if (control.kind === 'wait' && control.reason === 'connection_required') { this.#nextInput = undefined; return null; }
    if (options.auto === false || !this.services.sessionCompacts || !this.services.planner.compact || !state.conversation?.session ||
      ['paused', 'cancelled', 'failed', 'completed', 'blocked'].includes(state.status) ||
      state.attempts.some(a => ['reserved', 'running', 'received'].includes(a.status))) return null;
    if (this.execution.hasStoredResultCandidate(state)) return null;
    const inspectInput = options.nextModelEnabled !== false && this.canInspect(state) &&
      this.execution.control(state).kind === 'replan';
    let inspected: NextModelInput | undefined;
    try {
      inspected = inspectInput ? await this.inspectNext(state) : undefined;
      if (inspected?.inspection.kind === 'required_overflow') throw new Error('model_input_required_overflow');
      if (inspected?.autoChecked) return null;
      const call = await this.requestCompact(workId, inspected?.inspection.kind === 'needs_session_compact' ? { force: true } : {});
      if (!call && inspected?.inspection.kind === 'needs_session_compact') throw new Error('session_compact_capacity');
      if (!call && inspected) { inspected.autoChecked = true; this.#nextInput = inspected; }
      return call ? { kind: 'continue', action: 'model', id: call.id, reason: 'session_compact_reserved' } : null;
    } catch (error) {
      this.#nextInput = undefined;
      const code = error instanceof Error ? error.message : 'session_compact_failed';
      if (['model_not_needed', 'model_reservation_stale', 'context_state_changed'].includes(code)) return null;
      if (inspectInput) {
        // A capacity-only failure is optional when the whole next request fits the preview.
        // Materialization still rechecks every source and the actual request before any reservation.
        if (code === 'session_compact_capacity' && inspected?.inspection.kind === 'fits') {
          inspected.autoChecked = true; this.#nextInput = inspected; return null;
        }
        throw error;
      }
      // A failed optional compact must not prevent a valid bounded raw/tail context from doing useful work.
      try {
        const latest = await this.execution.state(workId);
        const context = await this.services.sessions?.context(latest);
        if (context && await sessionContextCurrent(this.services, latest, context)) return null;
      } catch { /* The source remains authoritative; no truncated or stale checkpoint is manufactured. */ }
      throw new Error(code === 'model_input_limit' || code === 'session_context_capacity' ? 'session_compact_capacity' :
        code === 'session_compact_unavailable' ? code : 'session_compact_failed', { cause: error });
    }
  }
  private async rejectReservedDisclosure(workId: string, callId: string): Promise<PlanningControl | null> {
    const state = await this.execution.state(workId); const call = this.call(state, callId);
    const denied = (work: WorkState, value: ModelCall) => Boolean(work.policy.disclosure &&
      !allowsDisclosure(work.policy, value.destination, 'model', [...disclosureLabels(work), ...value.inputArtifact.labels]));
    if (call.status !== 'reserved' || !denied(state, call)) return null;
    try {
      const result = await transact(this.services, workId, `model-disclosure-gate:${callId}:${state.revision}`, 'model_gate_rejected', { callId, code: 'model_disclosure_denied' }, next => {
        const current = this.call(next, callId);
        if (next.revision !== state.revision || current.status !== 'reserved' || !denied(next, current)) throw new Error('model_disclosure_gate_changed');
        current.status = 'cancelled'; current.usageStatus = 'not_called'; current.expired = true; current.finishedAt = this.services.clock.now();
        current.inputTokens = 0; current.outputTokens = 0; current.outcome = 'cancelled'; current.reason = 'model_disclosure_denied';
        next.budget.reservedModelCalls--; next.budget.reservedTokens -= current.tokenReservation;
        if (!['paused', 'cancelled', 'failed', 'completed', 'blocked'].includes(next.status)) { next.status = 'blocked'; next.statusReason = 'model_disclosure_denied'; next.retryWakeAt = null; }
      });
      return this.execution.control(result.state);
    } catch (error) {
      if (error instanceof Error && error.message === 'model_disclosure_gate_changed') return null;
      throw error;
    }
  }
  async step(workId: string): Promise<PlanningControl> {
    const state = await this.refresh(workId);
    const pending = state.modelCalls.find(c => transientStatuses.includes(c.status));
    if (pending) {
      if (pending.status === 'reserved') { const denied = await this.rejectReservedDisclosure(workId, pending.id); if (denied) return denied; }
      if (pending.status === 'received') { await this.adopt(workId, pending.id); return { kind: 'continue', action: 'model', id: pending.id, reason: 'stored_model_reply' }; }
      if (pending.expired || this.services.clock.now() >= pending.leaseUntil) { await this.recover(workId, pending.id); return { kind: 'continue', action: 'model', id: pending.id, reason: 'model_recovered' }; }
      if (pending.status === 'reserved' && pending.owner === this.owner) {
        try { await this.execute(workId, pending.id); }
        catch (error) {
          if (error instanceof Error && error.message === 'model_not_dispatchable') {
            const denied = await this.rejectReservedDisclosure(workId, pending.id); if (denied) return denied;
            const current = await this.execution.state(workId);
            if (current.policy.disclosure) return this.execution.control(current);
          }
          if (!(error instanceof Error && error.message.startsWith('budget_'))) throw error;
          const code = error.message;
          await transact(this.services, workId, `model-budget-gate:${pending.id}`, 'model_gate_rejected', { code }, next => {
            cancelBudgetReservations(next, this.services.clock.now());
            if (!['paused', 'cancelled', 'failed', 'completed'].includes(next.status)) { next.status = 'blocked'; next.statusReason = code; }
          });
          return { kind: 'blocked', reason: code };
        }
        return { kind: 'continue', action: 'model', id: pending.id, reason: 'model_dispatched' };
      }
      return { kind: 'wait', reason: 'model_call_pending', wakeAt: pending.leaseUntil };
    }
    const compact = await this.compactStep(workId); if (compact) return compact;
    const control = await this.execution.step(workId); if (control.kind !== 'replan') return control;
    const candidate = await this.execution.state(workId);
    const gate = candidate.budget.used.unmeasuredModelCalls ? null : progressGate(candidate, this.services.clock.now(), modelFailureKey(candidate, this.identity, this.destination, this.services.digester));
    if (gate) {
      try {
        await transact(this.services, workId, `model-progress-gate:${candidate.revision}`, 'model_gate_rejected', { code: gate.reason }, next => {
          if (next.revision !== candidate.revision) throw new Error('model_reservation_stale');
          next.status = gate.kind === 'wait' ? 'waiting' : 'blocked'; next.statusReason = gate.reason;
          next.retryWakeAt = gate.kind === 'wait' ? gate.wakeAt : null;
        }); return gate;
      } catch (error) {
        if (!(error instanceof Error && error.message === 'model_reservation_stale')) throw error;
        return this.execution.control(await this.execution.state(workId));
      }
    }
    try {
      const call = await this.reserve(workId); return { kind: 'continue', action: 'model', id: call.id, reason: 'model_reserved' };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'model_reservation_failed';
      if (['model_reservation_stale', 'model_not_needed', 'context_state_changed'].includes(code)) return this.execution.control(await this.execution.state(workId));
      const safeCode = /^[a-z][a-z0-9_]+$/.test(code) ? code : 'model_reservation_failed';
      await transact(this.services, workId, `model-gate:${state.revision}`, 'model_gate_rejected', { code: safeCode }, next => {
        if (this.digest(next) === this.digest(state) && !['cancelled', 'paused', 'failed', 'completed'].includes(next.status)) { next.status = 'blocked'; next.statusReason = safeCode; }
      }); return this.execution.control(await this.execution.state(workId));
    }
  }
  async runUntilYield(workId: string, maxSteps = 100) {
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 10000) throw new Error('invalid_step_limit');
    for (let n = 0; n < maxSteps; n++) { const control = await this.step(workId); if (control.kind !== 'continue') return control; }
    return { kind: 'yield' as const, reason: 'step_limit' };
  }
}
