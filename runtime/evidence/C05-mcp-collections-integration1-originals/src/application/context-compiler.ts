import { visibleComputerProgress } from '../domain/computer-use.js';
import type { ContextDecision, ContextGuidance, ContextHead, ContextItem, ContextObservation, ContextRepresentation } from '../domain/context.js';
import type { ArtifactRef, Attempt, ContextPacket, Json, TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import { taskSucceeded } from '../domain/control.js';
import { artifactBlocked, dataGeneration, visibleArtifact } from '../domain/data-lifecycle.js';
import { ContextPacketSchema, parseContract, ToolResultSchema } from './contracts.js';
import { ContextFrameSchema, type ContextFrame } from './context-contracts.js';
import { buildContextPacket, computerContinuationContext, computerContinuationOriginalRefs, computerContinuationRefs,
  computerReconciliationContext, computerReconciliationRefs, mandatoryComputerAttempt, verifyComputerContextHead } from './context-packet.js';
import { ContextFrameStore } from './context-store.js';
import { selectContextItems } from './context-selection.js';
import type { GuidanceCatalog } from './guidance.js';
import { knowledgeInputsCurrent } from './knowledge-validity.js';
import { asJson, taskDigest } from './plan-validator.js';
import type { ModelCallOptions, ModelInputEstimate, ToolDefinition } from './ports.js';
import type { RuntimeServices } from './services.js';
import { toolAllowed, type ToolContracts } from './tool-contracts.js';
import { WorkResources } from './work-resources.js';
import { readCollectionContext, visibleReadProgress } from '../domain/context.js';
import { ReadCheckpoints } from './read-checkpoints.js';
import { allowsDisclosure, disclosureLabels } from '../domain/disclosure.js';
import { controlProofsCurrent as effectProofsCurrent, requiresControlProofs as requiresEffectProofs } from './control-proofs.js';
import { readSessionContext, sessionContextCurrent, sessionInputsCurrent } from './session-context.js';
import { personalMemoryContextCurrent, personalMemoryDigest, readPersonalMemoryContext } from './personal-memory-context.js';
import { retainedKnowledgeDependencies } from './knowledge-validity.js';
import type { SessionContext } from '../domain/session.js';
import type { SessionContextDraft } from './session-ports.js';
import { estimateModelContextPreview, type ModelContextPreview } from './model-context-preview.js';
import { assessInputFit, validateModelInputEstimate } from './model-input-budget.js';

export interface ContextLimits { callId: string; maxOutputTokens: number; maxInputBytes: number; maxInputTokens: number; forceCompact?: boolean;
  estimateInput?: (packet: ContextPacket, options: ModelCallOptions) => ModelInputEstimate;
  previewTurn?: ModelContextPreview['turn'] }
export interface PreparedContext { packet: ContextPacket; options: ModelCallOptions; frame: ContextFrame; head: ContextHead; estimate: ModelInputEstimate }
export interface ContextInspection {
  kind: 'fits' | 'needs_session_compact' | 'required_overflow';
  requiredEstimate: ModelInputEstimate; selectedEstimate: ModelInputEstimate | null;
  interpretation: 'preview_hint_actual_request_must_be_checked';
}
type Candidate = { item: ContextItem; apply(packet: ContextPacket, options: ModelCallOptions, representation: ContextRepresentation): void };
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const size = (value: unknown) => encode(value).byteLength;
const unsettled = (a: Attempt) => Boolean(a.effectReceipt) || ['reserved', 'running', 'received', 'unknown'].includes(a.status) || a.effectState === 'unknown';
const discovery = ['core.catalog.search', 'core.catalog.get', 'core.evidence.find', 'core.evidence.get', 'core.calls.find', 'core.calls.get', 'core.guidance.find', 'core.guidance.load'];
function object(value: Json): Record<string, Json> | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null; }

/** Builds a disposable model working set from authoritative state and verified stored observations. */
export class ContextCompiler {
  readonly frames: ContextFrameStore;
  readonly #preparations = new WeakMap<ContextInspection, () => Promise<PreparedContext>>();
  constructor(readonly services: RuntimeServices, readonly tools: ToolContracts, readonly guidance?: GuidanceCatalog) { this.frames = new ContextFrameStore(services); }
  private digest(value: unknown) { return this.services.digester.digest(asJson(value)); }
  private key(kind: string, id: string, version = '1') { return `${kind}:${this.digest([id, version])}`; }
  private collectionContractsCurrent(packet: ContextPacket, state: WorkState): boolean {
    const collections = readCollectionContext(state);
    if (this.digest(packet.readCollections ?? []) !== this.digest(collections)) return false;
    const required = new Set(collections.map(collection => collection.attemptId));
    for (const attempt of state.attempts) if (attempt.adopted && attempt.scope === state.goal.scope && attempt.resultArtifact && visibleArtifact(state, attempt.resultArtifact) &&
      (attempt.readProgress || this.tools.get(attempt.toolId, attempt.toolVersion)?.tool.definition.collection)) required.add(attempt.id);
    return [...required].every(id => {
      const attempt = state.attempts.find(value => value.id === id)!;
      const definition = this.tools.get(attempt.toolId, attempt.toolVersion)?.tool.definition;
      return Boolean(definition?.collection && definition.effect === 'read' && toolAllowed(definition, state.policy) &&
        attempt.contractDigest === this.digest(definition));
    });
  }
  definitionsCurrent(packet: ContextPacket, options: ModelCallOptions, state: WorkState): boolean {
    try {
      if (!this.collectionContractsCurrent(packet, state)) return false;
      for (const old of options.tools) {
        const current = this.tools.get(old.id, old.version)?.tool.definition;
        if (!current || !toolAllowed(current, state.policy) || this.digest(old) !== this.digest(current)) return false;
      }
      for (const observation of packet.toolObservations ?? []) {
        if (!observation.sourceContracts?.length) return false;
        for (const pin of observation.sourceContracts) {
          const current = this.tools.get(pin.id, pin.version)?.tool.definition;
          if (!current || !toolAllowed(current, state.policy) || this.digest(current) !== pin.digest) return false;
        }
      }
      for (const guide of packet.activeGuidance ?? []) {
        const current = this.guidance?.describe(state, guide.id, guide.version);
        if (!current || this.digest(current) !== guide.manifestDigest || current.sha256 !== guide.sha256) return false;
      }
      return true;
    } catch { return false; }
  }
  /** Only new model transmission requires these definitions to remain callable. Stored reply proof uses definitionsCurrent. */
  outgoingDefinitionsCurrent(packet: ContextPacket, options: ModelCallOptions, state: WorkState): boolean {
    return this.definitionsCurrent(packet, options, state) && options.tools.every(definition => {
      const current = this.tools.get(definition.id, definition.version);
      return !!current && current.tool.availability !== 'stored_only';
    });
  }
  async sourcesCurrent(packet: ContextPacket, state: WorkState, signal?: AbortSignal, options: { ignoreDeliveryObligations?: boolean } = {}): Promise<boolean> {
    try {
      if (!(await personalMemoryContextCurrent(this.services, state, packet.personalMemory, signal))) return false;
      if (!(await sessionContextCurrent(this.services, state, packet.session, signal))) return false;
      const obligations = (values: WorkState['obligations']) => options.ignoreDeliveryObligations ? values.filter(value => value.kind !== 'delivery') : values;
      if (this.digest(obligations(packet.obligations)) !== this.digest(obligations(state.obligations)) || this.digest(packet.notifications ?? []) !== this.digest(state.notifications ?? [])) return false;
      for (const attempt of state.attempts.filter(value => value.effectReceipt)) {
        const projected = packet.execution?.attempts.find(value => value.id === attempt.id);
        if (!projected || this.digest(projected.effectReceipt) !== this.digest(attempt.effectReceipt)) return false;
      }
      if (packet.execution?.attempts.some(projected => projected.effectReceipt && !state.attempts.some(attempt => attempt.id === projected.id && attempt.effectReceipt))) return false;
      const reconciliations = computerReconciliationContext(state);
      const continuations = computerContinuationContext(state);
      if (this.digest(packet.computerReconciliations ?? []) !== this.digest(reconciliations)) return false;
      if (this.digest(packet.computerContinuations ?? []) !== this.digest(continuations)) return false;
      if (requiresEffectProofs(state) && !(await effectProofsCurrent(this.services, state))) return false;
      for (const ref of [...reconciliations.flatMap(computerReconciliationRefs), ...computerContinuationRefs(state)]) {
        if (signal?.aborted || !(await this.services.artifacts.exists(ref))) return false;
      }
      for (const ref of await computerContinuationOriginalRefs(state, ref => this.services.artifacts.get(ref, state.policy))) {
        if (signal?.aborted || !(await this.services.artifacts.exists(ref))) return false;
      }
      const computerAttempts = (packet.execution?.attempts ?? []).filter(attempt => attempt.computerUse);
      if (state.attempts.some(attempt => mandatoryComputerAttempt(state, attempt) && !computerAttempts.some(projected => projected.id === attempt.id))) return false;
      for (const projected of computerAttempts) {
        const attempt = state.attempts.find(value => value.id === projected.id);
        if (signal?.aborted || !attempt?.computerUse || projected.goalRevision !== attempt.goalRevision || projected.scope !== attempt.scope ||
          this.digest(projected.computerUse) !== this.digest(attempt.computerUse)) return false;
      }
      const readCollections = readCollectionContext(state);
      if (this.digest(packet.readCollections ?? []) !== this.digest(readCollections)) return false;
      const checkpoints = new ReadCheckpoints(this.services, this.tools);
      for (const collection of readCollections) {
        if (signal?.aborted) return false;
        await checkpoints.read(state, collection.attemptId, collection.progress.head);
      }
      // Completed, adopted checkpoints leave the resume list but still back copied observations and accepted evidence.
      for (const attempt of state.attempts) {
        if (!attempt.adopted || attempt.scope !== state.goal.scope || !attempt.resultArtifact || !visibleArtifact(state, attempt.resultArtifact)) continue;
        const definition = this.tools.get(attempt.toolId, attempt.toolVersion)?.tool.definition;
        if (!attempt.readProgress && !definition?.collection && !(attempt.goalRevision === state.goal.revision &&
          this.tools.get(attempt.toolId, attempt.toolVersion)?.tool.validateResult)) continue;
        if (signal?.aborted) return false;
        const bytes = await this.services.artifacts.get(attempt.resultArtifact, state.policy);
        const result = parseContract(ToolResultSchema, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
        if (result.resultId !== attempt.resultId || result.attemptId !== attempt.id || !(await checkpoints.validateResult(state, result)) ||
          !(await this.tools.validateResult(state, result))) return false;
      }
      const checked = new Set<string>();
      for (const guide of packet.activeGuidance ?? []) {
        if (signal?.aborted || !this.guidance) return false;
        const current = this.guidance.describe(state, guide.id, guide.version);
        if (this.digest(current) !== guide.manifestDigest || current.sha256 !== guide.sha256 || !visibleArtifact(state, guide.artifact) ||
          guide.artifact.sha256 !== current.sha256 || guide.artifact.byteLength !== current.byteLength) return false;
        const key = this.key('guidance-source', guide.id, guide.version);
        if (!checked.has(key)) {
          if (!(await this.guidance.validateCurrent(state, this.services.artifacts, current, signal ? { signal } : {}))) return false;
          checked.add(key);
        }
        if (signal?.aborted || !(await this.services.artifacts.exists(guide.artifact))) return false;
      }
      for (const projected of computerAttempts) {
        if (signal?.aborted) return false;
        await verifyComputerContextHead(state, state.attempts.find(value => value.id === projected.id)!, this.services);
      }
      if (requiresEffectProofs(state) && !(await effectProofsCurrent(this.services, state))) return false;
      if ((computerAttempts.length || reconciliations.length || continuations.length) && (!(await knowledgeInputsCurrent(this.services, state)) ||
        this.digest(await this.services.state.get(state.id)) !== this.digest(state))) return false;
      return !signal?.aborted && this.collectionContractsCurrent(packet, state) && await sessionContextCurrent(this.services, state, packet.session, signal) &&
        await personalMemoryContextCurrent(this.services, state, packet.personalMemory, signal);
    } catch { return false; }
  }
  private async fresh(state: WorkState) {
    if (!(await sessionInputsCurrent(this.services, state)) || !(await knowledgeInputsCurrent(this.services, state)) ||
      requiresEffectProofs(state) && !(await effectProofsCurrent(this.services, state)) ||
      this.digest(await this.services.state.get(state.id)) !== this.digest(state)) throw new Error('context_state_changed');
  }
  private frontier(state: WorkState): TaskSpec[] {
    if (state.plan?.goalRevision !== state.goal.revision) return [];
    const tasks = new Map(state.plan?.tasks.map(t => [t.id, t]) ?? []); const keep = new Set<string>();
    const pending = [...tasks.values()].filter(t => !taskSucceeded(state, t)).map(t => t.id);
    while (pending.length) {
      const id = pending.pop()!; if (keep.has(id)) continue;
      const task = tasks.get(id); if (!task) throw new Error('context_plan_invalid');
      keep.add(id); pending.push(...task.dependsOn);
    }
    return [...tasks.values()].filter(t => keep.has(t.id));
  }
  async prepare(value: WorkState, limits: ContextLimits): Promise<PreparedContext> {
    return await this.compile(value, limits, false) as PreparedContext;
  }
  async inspect(value: WorkState, limits: ContextLimits): Promise<ContextInspection> {
    return await this.compile(value, limits, true) as ContextInspection;
  }
  async materialize(inspection: ContextInspection): Promise<PreparedContext> {
    const prepare = this.#preparations.get(inspection);
    if (!prepare || inspection.kind !== 'fits') throw new Error('context_preparation_unavailable');
    this.#preparations.delete(inspection);
    return prepare();
  }
  private async sessionDraftFailure(state: WorkState, draft: SessionContextDraft, original: Error): Promise<Error> {
    let current: SessionContextDraft | null;
    try { current = await this.services.sessions!.inspectContext!(state); }
    catch { return original; }
    await this.fresh(state);
    const newer = current?.summary?.ref, older = draft.summary?.ref;
    if (current && newer && (!older || newer.revision > older.revision && newer.throughSequence >= older.throughSequence) &&
        this.digest(current.basis) === this.digest(draft.basis) && this.digest(current.currentInput) === this.digest(draft.currentInput) &&
        this.digest(current.sourceManifest) === this.digest(draft.sourceManifest))
      return new Error('context_state_changed', { cause: original });
    return original;
  }
  private async compile(value: WorkState, limits: ContextLimits, inspecting: boolean): Promise<PreparedContext | ContextInspection> {
    if (!limits.callId || [limits.maxOutputTokens, limits.maxInputBytes, limits.maxInputTokens].some(n => !Number.isSafeInteger(n) || n < 1)) throw new Error('invalid_context_limits');
    const state = structuredClone(value); await this.fresh(state);
    const previous = await this.frames.previous(state); const memo = previous.frame?.memo ?? null;
    const observedThrough = state.contextHead && state.contextHead.basisRevision < state.revision ? state.contextHead.basisRevision :
      state.modelCalls.filter(c => c.goalRevision === state.goal.revision).reduce((n, c) => Math.max(n, c.baseStateRevision), 0);
    let session: SessionContext | undefined;
    let sessionDraft: SessionContextDraft | undefined;
    if (inspecting && state.conversation?.session) {
      if (!this.services.sessions?.inspectContext || !this.services.sessions.draftCurrent || !this.services.sessions.materializeContext)
        throw new Error('context_inspection_unavailable');
      sessionDraft = await this.services.sessions.inspectContext(state) ?? undefined;
      if (!sessionDraft) throw new Error('session_context_unavailable');
    } else if (!inspecting) session = await readSessionContext(this.services, state);
    const personalMemory = await readPersonalMemoryContext(this.services, state);
    const baseline = { ...buildContextPacket(state, this.tools), ...(session ? { session } : {}), ...(personalMemory ? { personalMemory } : {}), readCollections: readCollectionContext(state) }; const frontier = this.frontier(state);
    const toolsRevision = this.tools.revision;
    const toolsCurrent = () => { if (this.tools.revision !== toolsRevision) throw new Error('context_state_changed'); };
    const visible = this.tools.visible(state.policy), callable = this.tools.callable(state.policy); const candidates: Candidate[] = [];
    const sources = new Map<string, { ref: string; bytes: Uint8Array }>(); let sourceReads = 0; let sourceCacheBytes = 0;
    const materializedRefs = new Map<string, ArtifactRef>(); const reusedRefs = new Map<string, ArtifactRef>();
    const read = async (value: ArtifactRef) => {
      const ref = structuredClone(value);
      if (!visibleArtifact(state, ref)) throw new Error('context_source_unavailable');
      const signature = this.digest(ref); const cached = sources.get(ref.id);
      if (cached) { if (cached.ref !== signature) throw new Error('artifact_reference_conflict'); reusedRefs.set(ref.id, ref); return cached.bytes; }
      const bytes = await this.services.artifacts.get(structuredClone(ref), state.policy); sourceReads++;
      if (bytes.byteLength !== ref.byteLength) throw new Error('context_source_unavailable');
      if (sourceCacheBytes + bytes.byteLength <= 16 * 1024 * 1024 && sources.size < 10000) {
        sources.set(ref.id, { ref: signature, bytes }); sourceCacheBytes += bytes.byteLength;
      }
      return bytes;
    };
    const requireOriginal = async (value: ArtifactRef) => {
      const ref = structuredClone(value);
      const verified = materializedRefs.get(ref.id);
      if (!verified) { await read(ref); return; }
      if (!visibleArtifact(state, ref) || this.digest(verified) !== this.digest(ref)) throw new Error('context_source_unavailable');
      reusedRefs.set(ref.id, ref);
    };
    for (const attempt of state.attempts) if (attempt.effectReceipt) await requireOriginal(attempt.effectReceipt.artifact);
    for (const collection of baseline.readCollections) await read(collection.progress.head);
    for (const record of baseline.computerReconciliations ?? []) {
      for (const ref of computerReconciliationRefs(record)) await requireOriginal(ref);
    }
    for (const ref of await computerContinuationOriginalRefs(state, read)) await requireOriginal(ref);
    const add = (kind: ContextItem['kind'], id: string, version: string, full: unknown, reference: unknown, minimum: ContextItem['minimum'], priority: number,
      useMarker: string | null, apply: Candidate['apply'], overhead = 1) => {
      const key = this.key(kind, id, version);
      candidates.push({ item: { key, kind, version, digest: this.digest(full), fullBytes: size(full) + overhead, referenceBytes: size(reference) + overhead, minimum, priority, useMarker }, apply });
      return key;
    };
    const protectedEvidence = new Set(state.hypotheses.flatMap(h => [...h.supportIds, ...h.counterIds]));
    const inputStrings = new Set<string>();
    function strings(value: Json) { if (typeof value === 'string') inputStrings.add(value); else if (Array.isArray(value)) value.forEach(strings); else if (value && typeof value === 'object') Object.values(value).forEach(strings); }
    frontier.forEach(t => strings(t.input));
    const usedEvidence = new Map<string, { marker: string; fresh: boolean }>(); const requestedTools = new Map<string, { version: string; marker: string; fresh: boolean }>();
    const loadedGuidance = new Map<string, { value: ContextGuidance; hasRules: boolean; marker: string }>();
    const dispatchedTasks = new Map<string, TaskSpec>();
    const resources = new WorkResources(this.services.state, this.services.artifacts, this.tools, this.services.digester, this.services.knowledge, this.guidance, this.services.effects, this.services.inputs);
    const continuationSources = new Set((state.computerContinuations ?? []).map(claim => claim.sourceAttemptId));
    const observations: { attempt: Attempt; task: TaskSpec; result: ToolResult; full: ContextObservation; reference: ContextObservation; isNew: boolean; referenceOnly: boolean }[] = [];
    for (const attempt of state.attempts) {
      if (!attempt.adopted || attempt.scope !== state.goal.scope || !attempt.resultArtifact || artifactBlocked(state, attempt.resultArtifact)) continue;
      if (this.tools.get(attempt.toolId, attempt.toolVersion)?.tool.validateResult && attempt.goalRevision !== state.goal.revision) continue;
      const definition = this.tools.get(attempt.toolId, attempt.toolVersion)?.tool.definition;
      if (!definition || !toolAllowed(definition, state.policy) || !visibleArtifact(state, attempt.resultArtifact)) continue;
      if (attempt.contractDigest && attempt.contractDigest !== this.digest(definition)) continue;
      let checked: Awaited<ReturnType<WorkResources['resultWithDependencies']>> | null = null;
      let referenceOnly = continuationSources.has(attempt.id);
      if (attempt.reuse || attempt.toolId === 'core.calls.get') {
        try { checked = await resources.resultWithDependencies(state.id, state.policy, attempt.id, 65536); }
        catch (error) {
          if (attempt.reuse || !(error instanceof Error && error.message === 'invocation_unavailable')) throw error;
          referenceOnly = true;
        }
      }
      const result = checked?.materialized.result ?? parseContract(ToolResultSchema, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await read(attempt.resultArtifact))));
      if (result.attemptId !== attempt.id || result.resultId !== attempt.resultId) throw new Error('invocation_identity_mismatch');
      if ((definition.collection || attempt.readProgress || result.collection) && !(await new ReadCheckpoints(this.services, this.tools).validateResult(state, result)))
        throw new Error('context_source_unavailable');
      if (!(await this.tools.validateResult(state, result))) throw new Error('context_source_unavailable');
      let sourceContracts = [{ id: definition.id, version: definition.version, digest: this.digest(definition) }];
      if (!checked && !referenceOnly && result.reuse) {
        try {
          checked = await resources.resultWithDependencies(state.id, state.policy, attempt.id, 65536);
        } catch (error) {
          if (result.reuse || attempt.reuse || !(error instanceof Error && error.message === 'invocation_unavailable')) throw error;
          referenceOnly = true;
        }
      }
      if (checked) {
        sourceContracts = checked.toolContracts;
        sourceReads += checked.materialized.reads.artifacts + checked.materialized.reads.receipts;
        for (const ref of checked.materialized.verifiedArtifacts) {
          const previous = materializedRefs.get(ref.id);
          if (previous && this.digest(previous) !== this.digest(ref)) throw new Error('artifact_reference_conflict');
          if (!previous && materializedRefs.size >= 10000) throw new Error('context_source_limit');
          materializedRefs.set(ref.id, structuredClone(ref));
        }
        reusedRefs.set(attempt.resultArtifact.id, structuredClone(attempt.resultArtifact));
        for (const source of checked.materialized.sourceTasks) dispatchedTasks.set(source.attemptId, structuredClone(source.task));
      }
      if (result.knowledgeDependencies?.length && (!this.services.knowledge || !(await this.services.knowledge.validate(result.knowledgeDependencies, state.id, state.policy)))) throw new Error('context_state_changed');
      if (result.inputDependencies?.length && (!this.services.inputs || !(await this.services.inputs.validate(result.inputDependencies, state)))) throw new Error('context_state_changed');
      let task: TaskSpec; let dispatchRevision: number;
      if (checked) { task = checked.materialized.task; dispatchRevision = checked.materialized.dispatchRevision; }
      else {
        const receipt = await this.services.state.receipt(state.id, `dispatch:${attempt.id}`); sourceReads++;
        const original = receipt?.state.plan?.tasks.find(t => t.id === attempt.taskId);
        const dispatched = receipt?.state.attempts.find(a => a.id === attempt.id);
        if (!original || !dispatched || dispatched.status !== 'running' || receipt!.state.id !== state.id || receipt!.state.policy.tenantId !== state.policy.tenantId ||
          receipt!.state.goal.revision !== attempt.goalRevision || receipt!.state.goal.scope !== attempt.scope || receipt!.state.plan!.revision !== attempt.planRevision ||
          original.toolId !== attempt.toolId || original.toolVersion !== attempt.toolVersion || original.effect !== attempt.effect || taskDigest(original, this.services.digester) !== attempt.inputDigest ||
          dispatched.taskId !== attempt.taskId || dispatched.inputDigest !== attempt.inputDigest) throw new Error('context_invocation_pair_invalid');
        task = original; dispatchRevision = receipt!.state.revision;
      }
      dispatchedTasks.set(attempt.id, task);
      const reference: ContextObservation = { attemptId: attempt.id, taskId: attempt.taskId, toolId: attempt.toolId, toolVersion: attempt.toolVersion, inputDigest: attempt.inputDigest,
        resultId: result.resultId, resultArtifact: attempt.resultArtifact, status: result.status, coverage: result.coverage, representation: 'reference', historical: true,
        sourceContracts,
        ...(result.reuse ? { reuse: structuredClone(result.reuse) } : {}) };
      const full: ContextObservation = { ...reference, representation: 'full', input: structuredClone(task.input), output: result.output };
      const isNew = dispatchRevision > observedThrough;
      observations.push({ attempt, task, result, full, reference, isNew, referenceOnly });
      if (attempt.goalRevision !== state.goal.revision || result.status !== 'success') continue;
      if (attempt.toolId === 'core.evidence.get' && typeof task.input['evidenceId'] === 'string') usedEvidence.set(task.input['evidenceId'], { marker: attempt.id, fresh: isNew });
      if (attempt.toolId === 'core.catalog.get') {
        const output = object(result.output); const id = task.input['id']; const version = task.input['version'];
        if (output?.['status'] === 'available' && typeof id === 'string' && typeof version === 'string') {
          const current = this.tools.get(id, version)?.tool.definition;
          if (current && toolAllowed(current, state.policy) && this.digest(output['definition']) === this.digest(current)) requestedTools.set(id, { version, marker: attempt.id, fresh: isNew });
        }
      }
      if (attempt.toolId === 'core.guidance.load' && this.guidance) {
        const output = object(result.output); const id = task.input['id']; const version = task.input['version'];
        if (output?.['status'] !== 'available' || typeof id !== 'string' || typeof version !== 'string') continue;
        let manifest; try { manifest = this.guidance.describe(state, id, version); } catch { continue; }
        if (!manifest.supportedKinds.includes(task.input['kind'] as never)) continue;
        const ref = result.artifacts.find(a => a.sha256 === manifest.sha256 && a.byteLength === manifest.byteLength);
        if (!ref || this.digest(output['manifest']) !== this.digest(manifest)) throw new Error('context_guidance_invalid');
        const body = new TextDecoder('utf-8', { fatal: true }).decode(await read(ref));
        if (output['body'] !== body) throw new Error('context_guidance_invalid');
        loadedGuidance.set(this.key('guidance', id, version), { value: { id, version, sha256: manifest.sha256, manifestDigest: this.digest(manifest), artifact: ref, rules: manifest.requiredRules ?? [], body }, hasRules: Boolean(manifest.requiredRules), marker: attempt.id });
      }
    }
    const copyRequiresReference = async (task: TaskSpec): Promise<boolean> => {
      const visited = new Set<string>();
      for (let depth = 0; depth < 64; depth++) {
        if (['core.guidance.load', 'core.catalog.get'].includes(task.toolId)) return true;
        if (task.toolId !== 'core.calls.get') return false;
        const id = task.input['attemptId'];
        if (typeof id !== 'string' || visited.has(id)) return true;
        visited.add(id);
        const parent = state.attempts.find(a => a.id === id);
        const definition = parent && this.tools.get(parent.toolId, parent.toolVersion)?.tool.definition;
        if (!parent?.resultArtifact || parent.scope !== state.goal.scope || !visibleArtifact(state, parent.resultArtifact) || !definition || !toolAllowed(definition, state.policy)) return true;
        let original = dispatchedTasks.get(id);
        if (!original) {
          const receipt = await this.services.state.receipt(state.id, `dispatch:${id}`); sourceReads++;
          original = receipt?.state.plan?.tasks.find(t => t.id === parent.taskId);
          if (!original || original.toolId !== parent.toolId || original.toolVersion !== parent.toolVersion || taskDigest(original, this.services.digester) !== parent.inputDigest) return true;
          dispatchedTasks.set(id, original);
        }
        task = original;
      }
      return true;
    };
    for (const e of baseline.evidence) {
      if (e.artifact) await requireOriginal(e.artifact);
      if (inputStrings.has(e.id) || state.goal.criteria.some(c => Object.hasOwn(e.facts, c.key))) protectedEvidence.add(e.id);
      const { id, sourceId, locator, observedAt, coverage, status } = e;
      const reference = { id, sourceId, locator, observedAt, coverage, status };
      const marker = usedEvidence.get(e.id)?.marker ?? null;
      const justRequested = usedEvidence.get(e.id)?.fresh ?? false;
      add('evidence', e.id, '1', e, reference, protectedEvidence.has(e.id) || justRequested ? 'full' : 'omitted', protectedEvidence.has(e.id) ? 100 : justRequested ? 90 : 10, marker,
        (p, _o, representation) => { if (representation === 'full') p.evidence.push(e); else if (representation === 'reference') p.evidenceReferences!.push(reference); });
    }
    const allowedAttempts = new Map(baseline.execution!.attempts.map(a => [a.id, a]));
    for (const a of state.attempts.filter(unsettled)) {
      const { knowledgeDependencies: _dependencies, inputDependencies: _dependenciesInputs, readProgress, computerUse, ...publicAttempt } = a;
      allowedAttempts.set(a.id, { ...publicAttempt, ...(readProgress && visibleReadProgress(state, readProgress) ? { readProgress } : {}),
        ...(computerUse && visibleComputerProgress(state, computerUse) ? { computerUse } : {}),
        resultArtifact: a.resultArtifact && visibleArtifact(state, a.resultArtifact) ? a.resultArtifact : null });
    }
    const frontierIds = new Set(frontier.map(t => t.id));
    for (const a of allowedAttempts.values()) {
      if (a.resultArtifact) await requireOriginal(a.resultArtifact);
      if (a.computerUse) {
        await verifyComputerContextHead(state, state.attempts.find(attempt => attempt.id === a.id)!, this.services);
        sourceReads++;
      }
      const mandatory = unsettled(a) || mandatoryComputerAttempt(state, a);
      add('attempt', a.id, '1', a, a, mandatory || frontierIds.has(a.taskId) ? 'full' : 'omitted', mandatory ? 100 : 5, null,
        (p, _o, r) => { if (r !== 'omitted') p.execution!.attempts.push(a); });
    }
    const requiredVersions = new Map<string, string>();
    for (const task of frontier) {
      const old = requiredVersions.get(task.toolId); if (old && old !== task.toolVersion) throw new Error('context_tool_version_conflict');
      if (this.tools.check(task, state.policy)) throw new Error('context_tool_unavailable');
      requiredVersions.set(task.toolId, task.toolVersion);
    }
    const groups = new Map<string, ToolDefinition[]>();
    for (const d of callable) { const group = groups.get(d.id) ?? []; group.push(d); groups.set(d.id, group); }
    const hasCatalog = groups.has('core.catalog.search') && groups.has('core.catalog.get');
    for (const [id, group] of groups) {
      const request = requestedTools.get(id); const required = requiredVersions.get(id);
      if (required && request?.fresh && request.version !== required) throw new Error('context_tool_version_conflict');
      const recent = [...state.attempts].reverse().find(a => a.toolId === id && group.some(d => d.version === a.toolVersion));
      const desired = required ?? request?.version ?? recent?.toolVersion;
      const d = group.find(d => d.version === desired) ?? [...group].sort((a, b) => a.version < b.version ? -1 : a.version > b.version ? 1 : 0)[0]!;
      const mandatory = Boolean(required || request?.fresh || discovery.includes(id) || !hasCatalog);
      const marker = request?.marker ?? recent?.id ?? null;
      add('tool', d.id, d.version, d, d, mandatory ? 'full' : 'omitted', mandatory ? 100 : marker ? 60 : 0, marker,
        (p, o, r) => { if (r !== 'omitted') { o.tools.push(d); p.activeToolIds.push(d.id); p.policy.allowedTools.push(d.id); } }, 3 * size(d.id) + 8);
    }
    for (const { value: guide, hasRules, marker } of loadedGuidance.values()) {
      const { body: _body, ...reference } = guide;
      add('guidance', guide.id, guide.version, guide, reference, hasRules ? 'reference' : 'full', 95, marker,
        (p, _o, r) => { if (r !== 'omitted') p.activeGuidance!.push(r === 'full' ? guide : reference); });
    }
    const memoryObservations = observations.filter(o => o.result.knowledgeDependencies?.length).slice(-8);
    for (const o of observations) {
      const redundant = o.referenceOnly || ['core.guidance.load', 'core.catalog.get'].includes(o.attempt.toolId) && object(o.result.output)?.['status'] === 'available' ||
        o.attempt.toolId === 'core.calls.get' && await copyRequiresReference(o.task);
      const memory = memoryObservations.includes(o);
      const full = memory ? { observation: o.reference, memory: { attemptId: o.attempt.id, toolId: o.attempt.toolId, output: o.result.output } } : o.full;
      add('result', o.attempt.id, '1', full, o.reference, 'omitted', o.isNew && !redundant ? 80 : 20, o.attempt.id,
        (p, _options, r) => {
          if (r === 'omitted') return;
          p.toolObservations!.push(r === 'full' && !memory ? o.full : o.reference);
          if (memory && r === 'full') p.retrievedKnowledge!.entries.push({ attemptId: o.attempt.id, toolId: o.attempt.toolId, output: o.result.output });
        });
      if (redundant) {
        const last = candidates.at(-1)!;
        last.item.maximum = 'reference'; last.item.digest = this.digest(o.reference);
        last.apply = (p, _o, r) => { if (r !== 'omitted') p.toolObservations!.push(o.reference); };
      }
    }
    const base: ContextPacket = { ...baseline, policy: { ...baseline.policy, allowedTools: [] }, plan: baseline.plan ? { ...baseline.plan, tasks: frontier } : null,
      evidence: [], evidenceReferences: [], activeToolIds: [], activeGuidance: [], toolObservations: [],
      execution: { ...baseline.execution!, attempts: [] }, retrievedKnowledge: { entries: [], omitted: memoryObservations.length, interpretation: 'prior_observations_not_fresh_evidence' },
      contextView: { policyTools: 'active_subset', planTasks: 'frontier', omitted: { tools: visible.length, evidence: baseline.evidence.length, attempts: allowedAttempts.size,
        tasks: (state.plan?.tasks.length ?? 0) - frontier.length, results: observations.length }, discoveryToolIds: discovery.filter(id => groups.has(id)) } };
    const optionsBase: ModelCallOptions = { callId: limits.callId, maxOutputTokens: limits.maxOutputTokens, tools: [] };
    const estimate = (packet: ContextPacket, options: ModelCallOptions) => {
      if (!allowsDisclosure(state.policy, this.services.planner.destination, 'model', disclosureLabels(state))) throw new Error('model_disclosure_denied');
      const envelope = size({ packet, options });
      const measured = (limits.estimateInput ?? this.services.planner.estimateInput?.bind(this.services.planner))?.(structuredClone(packet), structuredClone(options)) ?? { tokens: envelope + 2048, bytes: envelope, method: 'utf8_bytes_with_template_allowance' };
      return validateModelInputEstimate(measured, envelope);
    };
    const publish = async (selectedPacket: ContextPacket, options: ModelCallOptions, chosen: ReturnType<typeof selectContextItems>, session?: SessionContext): Promise<PreparedContext> => {
      await this.fresh(state); toolsCurrent();
      const packet = parseContract(ContextPacketSchema, { ...selectedPacket, ...(session ? { session } : {}) });
      if (!this.outgoingDefinitionsCurrent(packet, options, state)) throw new Error('context_state_changed');
      const measured = estimate(packet, options);
      if (assessInputFit(measured, limits, size({ packet, options })).kind !== 'fit') throw new Error('model_input_limit');
    const protectedInput = (p: ContextPacket) => ({ goal: p.goal, policy: { ...p.policy, allowedTools: state.policy.allowedTools }, ...(p.disclosureLabels ? { disclosureLabels: p.disclosureLabels } : {}), hypotheses: p.hypotheses, obligations: p.obligations, ...(p.notifications ? { notifications: p.notifications } : {}),
      ...(p.session ? { session: p.session } : {}),
      ...(p.personalMemory ? { personalMemory: p.personalMemory } : {}),
      ...(p.computerReconciliations === undefined ? {} : { computerReconciliations: p.computerReconciliations }),
      ...(p.computerContinuations === undefined ? {} : { computerContinuations: p.computerContinuations }),
      budget: p.execution!.budget, deadlineAt: p.execution!.deadlineAt, hypothesisAssessment: p.execution!.hypothesisAssessment, plan: p.plan,
      evidence: p.evidence.filter(e => protectedEvidence.has(e.id)), pending: p.execution!.attempts.filter(a => unsettled(a) || mandatoryComputerAttempt(state, a)), readCollections: p.readCollections ?? [] });
    const expected = { ...base, ...(session ? { session } : {}), evidence: baseline.evidence, execution: { ...base.execution!, attempts: [...allowedAttempts.values()] } };
    const protectedDigest = this.digest(protectedInput(expected));
    if (this.digest(protectedInput(packet)) !== protectedDigest) throw new Error('context_protected_input_changed');
    await this.fresh(state);
    const events = await this.services.state.events(state.id, 0); sourceReads++;
    const frame: ContextFrame = ContextFrameSchema.parse({ schemaVersion: 1, kind: 'model_context',
      basis: { workId: state.id, stateRevision: state.revision, goalRevision: state.goal.revision, planRevision: state.plan?.revision ?? 0, eventCursor: events.at(-1)?.sequence ?? 1,
        policyDigest: this.digest(state.policy), dataGeneration: dataGeneration(state), toolsDigest: this.digest(visible),
        knowledgeDigest: this.digest(state.personalMemorySelection ? retainedKnowledgeDependencies(state) : state.attempts.flatMap(a => a.knowledgeDependencies ?? [])),
        ...(personalMemory ? { personalMemoryDigest: personalMemoryDigest(this.services, state) } : {}),
        ...(session ? { session: { basis: session.basis, head: session.head } } : {}) }, packet, tools: options.tools, decisions: chosen.decisions, memo: chosen.memo, protectedDigest,
      metrics: { baselinePacketBytes: size({ ...baseline, ...(session ? { session } : {}) }), baselineToolBytes: size(visible), packetBytes: size(packet), toolBytes: size(options.tools), envelopeBytes: size({ packet, options }),
        requestBytes: measured.bytes, estimatedTokens: measured.tokens, estimateMethod: measured.method, outputTokenReservation: limits.maxOutputTokens, sourceReads,
        extraModelCalls: 0, evictions: chosen.memo.evictions, reloads: chosen.memo.reloads } });
    toolsCurrent();
    const head = await this.frames.stage(state, frame);
    if (!(await this.sourcesCurrent(packet, state))) throw new Error('context_guidance_unavailable');
    await this.fresh(state);
    for (const ref of reusedRefs.values()) if (!(await this.services.artifacts.exists(structuredClone(ref)))) throw new Error('context_source_unavailable');
    if (reusedRefs.size && this.digest(await this.services.state.get(state.id)) !== this.digest(state)) throw new Error('context_state_changed');
    toolsCurrent();
    if (!this.outgoingDefinitionsCurrent(packet, options, state)) throw new Error('context_state_changed');
    return { packet, options, frame, head, estimate: measured };
    };
    if (inspecting) {
      const compose = (representations: Map<string, ContextRepresentation>) => {
        const packet = structuredClone(base), options = structuredClone(optionsBase);
        candidates.forEach(candidate => candidate.apply(packet, options, representations.get(candidate.item.key)!));
        packet.contextView!.omitted = { ...base.contextView!.omitted, tools: visible.length - options.tools.length, evidence: baseline.evidence.length - packet.evidence.length,
          attempts: allowedAttempts.size - packet.execution!.attempts.length, results: observations.length - packet.toolObservations!.length };
        packet.retrievedKnowledge!.omitted = memoryObservations.length - packet.retrievedKnowledge!.entries.length;
        return { packet: parseContract(ContextPacketSchema, packet), options };
      };
      const measuredPreview = (packet: ContextPacket, options: ModelCallOptions, minimum: boolean) => {
        const preview: ModelContextPreview = { kind: 'model_context_preview', packet, ...(limits.previewTurn ? { turn: limits.previewTurn } : {}),
          ...(sessionDraft ? { session: { basis: sessionDraft.basis, summary: sessionDraft.summary,
            entries: minimum || sessionDraft.status === 'capacity' ? [sessionDraft.currentInput] : sessionDraft.entries } } : {}) };
        return estimateModelContextPreview(this.services.planner, preview, options);
      };
      const minimumRepresentations = new Map(candidates.map(({ item }) => [item.key,
        item.minimum === 'reference' && item.maximum !== 'reference' && item.fullBytes <= item.referenceBytes ? 'full' as const : item.minimum]));
      const minimum = compose(minimumRepresentations);
      const requiredEstimate = measuredPreview(minimum.packet, minimum.options, true);
      const report = async (kind: ContextInspection['kind'], selectedEstimate: ModelInputEstimate | null): Promise<ContextInspection> => {
        await this.fresh(state);
        if (sessionDraft && !(await this.services.sessions!.draftCurrent!(state, sessionDraft))) throw new Error('session_context_changed');
        toolsCurrent();
        if (!this.outgoingDefinitionsCurrent(minimum.packet, minimum.options, state)) throw new Error('context_state_changed');
        return { kind, requiredEstimate, selectedEstimate, interpretation: 'preview_hint_actual_request_must_be_checked' };
      };
      if (assessInputFit(requiredEstimate, limits, 0).kind !== 'fit') return report('required_overflow', requiredEstimate);
      if (sessionDraft?.status === 'capacity') return report('needs_session_compact', null);
      const hasPast = !!sessionDraft && sessionDraft.status === 'complete' && sessionDraft.entries.some(entry => entry.sequence < sessionDraft.basis.input.sequence);
      const overflow = (measured: ModelInputEstimate) => report(hasPast ? 'needs_session_compact' : 'required_overflow', measured);
      const fullMinimum = measuredPreview(minimum.packet, minimum.options, false);
      if (assessInputFit(fullMinimum, limits, 0).kind !== 'fit') return overflow(fullMinimum);
      const fits = async (selected: { packet: ContextPacket; options: ModelCallOptions }, chosen: ReturnType<typeof selectContextItems>, measured: ModelInputEstimate) => {
        const inspection = await report('fits', measured);
        this.#preparations.set(inspection, async () => {
          toolsCurrent(); await this.fresh(state); toolsCurrent();
          let currentSession: SessionContext | undefined;
          if (sessionDraft) {
            if (!(await this.services.sessions!.draftCurrent!(state, sessionDraft)))
              throw await this.sessionDraftFailure(state, sessionDraft, new Error('session_context_changed'));
            toolsCurrent();
            try { currentSession = await this.services.sessions!.materializeContext!(state, sessionDraft); }
            catch (error) {
              if (error instanceof Error && error.message === 'session_context_changed') throw await this.sessionDraftFailure(state, sessionDraft, error);
              throw error;
            }
          }
          return publish(selected.packet, selected.options, chosen, currentSession);
        });
        return inspection;
      };
      const useMinimum = async () => {
        // Item costs guide selection but can exceed their actual encoded contribution. The complete minimum already fits.
        let minimumBytes = 0;
        for (const { item } of candidates) {
          const representation = minimumRepresentations.get(item.key)!;
          const itemBytes = representation === 'full' ? item.fullBytes : representation === 'reference' ? item.referenceBytes : 0;
          if (itemBytes > Number.MAX_SAFE_INTEGER - minimumBytes) throw new Error('context_invalid_items');
          minimumBytes += itemBytes;
        }
        const chosen = selectContextItems(candidates.map(candidate => candidate.item), memo, { budgetBytes: minimumBytes, forceCompact: true });
        if (chosen.decisions.some(decision => decision.representation !== minimumRepresentations.get(decision.key)))
          throw new Error('context_protected_input_changed');
        return fits(minimum, chosen, fullMinimum);
      };
      const fullBase = measuredPreview(base, optionsBase, false);
      let budgetBytes = Math.max(0, limits.maxInputBytes - fullBase.bytes);
      for (let attempt = 0; ; attempt++) {
        let chosen: ReturnType<typeof selectContextItems>;
        try { chosen = selectContextItems(candidates.map(candidate => candidate.item), memo, { budgetBytes, forceCompact: limits.forceCompact ?? false }); }
        catch (error) { if (error instanceof Error && error.message === 'context_required_overflow') return useMinimum(); throw error; }
        const selected = compose(new Map(chosen.decisions.map(decision => [decision.key, decision.representation])));
        const measured = measuredPreview(selected.packet, selected.options, false);
        if (assessInputFit(measured, limits, 0).kind === 'fit') return fits(selected, chosen, measured);
        if (attempt >= 5 || budgetBytes === 0) return useMinimum();
        budgetBytes = Math.max(0, Math.floor(budgetBytes * Math.min(limits.maxInputBytes / measured.bytes, limits.maxInputTokens / measured.tokens)) - 64);
      }
    }
    await this.fresh(state);
    const baseEstimate = estimate(base, optionsBase);
    if (baseEstimate.bytes > limits.maxInputBytes || baseEstimate.tokens > limits.maxInputTokens) throw new Error('model_input_limit');
    let budgetBytes = limits.maxInputBytes - baseEstimate.bytes;
    let chosen: ReturnType<typeof selectContextItems>; let packet: ContextPacket; let options: ModelCallOptions; let measured: ReturnType<typeof estimate>;
    for (let n = 0; ; n++) {
      try { chosen = selectContextItems(candidates.map(c => c.item), memo, { budgetBytes, forceCompact: limits.forceCompact ?? false }); }
      catch (error) { if (error instanceof Error && error.message === 'context_required_overflow') throw new Error('model_input_limit'); throw error; }
      packet = structuredClone(base); options = structuredClone(optionsBase);
      const decisions = new Map<string, ContextDecision>(chosen.decisions.map(d => [d.key, d]));
      candidates.forEach(c => c.apply(packet, options, decisions.get(c.item.key)!.representation));
      packet.contextView!.omitted = { ...base.contextView!.omitted, tools: visible.length - options.tools.length, evidence: baseline.evidence.length - packet.evidence.length,
        attempts: allowedAttempts.size - packet.execution!.attempts.length, results: observations.length - packet.toolObservations!.length };
      packet.retrievedKnowledge!.omitted = memoryObservations.length - packet.retrievedKnowledge!.entries.length;
      packet = parseContract(ContextPacketSchema, packet);
      await this.fresh(state);
      measured = estimate(packet, options);
      if (measured.bytes <= limits.maxInputBytes && measured.tokens <= limits.maxInputTokens) break;
      if (n >= 5 || budgetBytes === 0) throw new Error('model_input_limit');
      const ratio = Math.min(limits.maxInputBytes / measured.bytes, limits.maxInputTokens / measured.tokens);
      budgetBytes = Math.max(0, Math.floor(budgetBytes * ratio) - 64);
    }
    return publish(packet, options, chosen, session);
  }
}
