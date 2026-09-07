import type { ArtifactRef, Evidence, TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import type { ReadCheckpoint, ReadProgress } from '../domain/read-checkpoint.js';
import { isReadDeferral, pendingReadRetryAt, type ReadResponse } from '../domain/read-collection.js';
import { dataGeneration, visibleArtifact } from '../domain/data-lifecycle.js';
import { projectReadCoverage, validateReadCoverage, validateReadCoverageManifest } from '../domain/read-coverage.js';
import type { ReadCollectionBinding, ReadCollectionSource, Tool, ToolDefinition } from './ports.js';
import type { RuntimeServices } from './services.js';
import { ToolContracts, type RegisteredTool } from './tool-contracts.js';
import { ToolDefinitionSchema, frozen } from './resource-contracts.js';
import { ReadCheckpointSchema } from './read-checkpoint-contracts.js';
import { ReadResponseSchema } from './read-collection-contracts.js';
import { acceptPage, initialize, nextRequest, ReadCollectionError } from './read-collection-validation.js';
import { ReadCheckpoints } from './read-checkpoints.js';
import { storeReadCheckpoint } from './read-checkpoint-store.js';
import { parseContract } from './contracts.js';
import { asJson, taskDigest } from './plan-validator.js';
import { validateEvidenceRecords } from './evidence-intake.js';
import { knowledgeInputsCurrent, retainedKnowledgeDependencies, uniqueKnowledgeDependencies } from './knowledge-validity.js';
import { transact } from './work-transactions.js';
import { assertReadWaitReady, readReadyCheckpoints } from './read-waits.js';

type Context = Parameters<Tool['execute']>[1];
type ExecutionContext = Context & { registered: RegisteredTool };
function fail(code: string): never { throw new Error(code); }

/** Captures the reviewed collection contract and source callbacks together. */
export function snapshotReadCollectionBinding(binding: ReadCollectionBinding): ReadCollectionBinding {
  const definition = frozen(parseContract(ToolDefinitionSchema, binding.definition));
  const availability = binding.availability;
  if (availability !== undefined && availability !== 'available' && availability !== 'stored_only') fail('invalid_tool_availability');
  if (!definition.collection || typeof binding.source?.fetch !== 'function' ||
    (definition.collection.kind === 'batch' && typeof binding.source.manifest !== 'function')) fail('invalid_collection_source');
  if (binding.source.validatePage !== undefined && typeof binding.source.validatePage !== 'function') fail('invalid_collection_source');
  if (binding.source.validateDeferral !== undefined && typeof binding.source.validateDeferral !== 'function') fail('invalid_collection_source');
  if (binding.source.restoreResponse !== undefined && typeof binding.source.restoreResponse !== 'function' ||
    binding.source.restoreUsage !== undefined && typeof binding.source.restoreUsage !== 'function' ||
    binding.source.manifest !== undefined && typeof binding.source.manifest !== 'function') fail('invalid_collection_source');
  if (definition.collection.pageValidation && !binding.source.validatePage) fail('tool_page_validator_required');
  if (definition.collection.deferralValidation && !binding.source.validateDeferral) fail('tool_deferral_validator_required');
  if (definition.collection.responseRecovery && !binding.source.restoreResponse) fail('tool_response_restorer_required');
  if (definition.collection.coverage && !binding.source.manifest) fail('tool_read_manifest_required');
  const source: ReadCollectionSource = Object.freeze({ fetch: binding.source.fetch.bind(binding.source),
    ...(binding.source.manifest ? { manifest: binding.source.manifest.bind(binding.source) } : {}),
    ...(binding.source.validatePage ? { validatePage: binding.source.validatePage.bind(binding.source) } : {}),
    ...(binding.source.validateDeferral ? { validateDeferral: binding.source.validateDeferral.bind(binding.source) } : {}),
    ...(binding.source.restoreResponse ? { restoreResponse: binding.source.restoreResponse.bind(binding.source) } : {}),
    ...(binding.source.restoreUsage ? { restoreUsage: binding.source.restoreUsage.bind(binding.source) } : {}) });
  return Object.freeze({ definition, source, ...(availability !== undefined ? { availability } : {}) });
}

export function createReadCollectionTool(binding: ReadCollectionBinding, runner: () => ReadCollections): Tool {
  const { definition, source, availability } = snapshotReadCollectionBinding(binding);
  return Object.freeze({ definition, ...(availability !== undefined ? { availability } : {}),
    execute: (task: TaskSpec, context: Context) => runner().execute(definition, source, task, context),
    ...(source.validatePage ? { validateReadPage: source.validatePage } : {}),
    ...(source.validateDeferral ? { validateReadDeferral: source.validateDeferral } : {}),
    ...(source.restoreResponse ? { restoreReadResponse: source.restoreResponse } : {}),
    ...(source.restoreUsage ? { restoreReadUsage: source.restoreUsage } : {}),
    ...(source.manifest ? { readManifest: source.manifest } : {}) });
}

/** Work CAS owns progress; the source executes only after its request intent has committed. */
export class ReadCollections {
  readonly checkpoints: ReadCheckpoints;
  constructor(readonly services: RuntimeServices, readonly contracts: ToolContracts, readonly owner: string) {
    this.checkpoints = new ReadCheckpoints(services, contracts);
  }
  private same(a: unknown, b: unknown) { return this.services.digester.digest(asJson(a ?? null)) === this.services.digester.digest(asJson(b ?? null)); }
  private refs(refs: ArtifactRef[]): ArtifactRef[] {
    const unique = new Map<string, ArtifactRef>();
    for (const ref of refs) {
      if (unique.has(ref.id) && !this.same(unique.get(ref.id), ref)) fail('artifact_reference_conflict');
      unique.set(ref.id, structuredClone(ref));
    }
    if (unique.size > 10000) fail('read_artifact_limit');
    return [...unique.values()];
  }
  private registration(task: TaskSpec, context: ExecutionContext) {
    if (this.contracts.get(task.toolId, task.toolVersion) !== context.registered) fail('read_contract_changed');
  }
  private guard(state: WorkState, definition: ToolDefinition, task: TaskSpec, context: ExecutionContext, basis: WorkState) {
    this.registration(task, context);
    const attempt = state.attempts.find(a => a.id === context.attemptId);
    const currentTask = state.plan?.tasks.find(t => t.id === task.id);
    if (context.signal.aborted || ['cancelled', 'paused', 'failed', 'completed', 'blocked'].includes(state.status)) fail('read_interrupted');
    if (!attempt || attempt.status !== 'running' || attempt.owner !== this.owner || attempt.effect !== 'read' || attempt.effectState !== 'none' ||
      this.services.clock.now() >= Math.min(attempt.leaseUntil, state.deadlineAt)) fail('read_lease_unavailable');
    if (!this.same(state.goal, basis.goal) || !this.same(state.policy, basis.policy) || !this.same(context.policy, basis.policy) ||
      dataGeneration(state) !== dataGeneration(basis)) fail('read_scope_changed');
    if (!currentTask || state.plan?.goalRevision !== state.goal.revision || attempt.planRevision !== state.plan.revision ||
      taskDigest(currentTask, this.services.digester) !== attempt.inputDigest || !this.same(currentTask, task)) fail('read_task_changed');
    if (this.contracts.check(task, state.policy) || !this.same(this.contracts.get(task.toolId, task.toolVersion)?.tool.definition, definition) ||
      attempt.contractDigest !== this.services.digester.digest(asJson(definition))) fail('read_contract_changed');
    return attempt;
  }
  private async current(definition: ToolDefinition, task: TaskSpec, context: ExecutionContext, basis: WorkState) {
    const state = await this.services.state.get(context.workId); if (!state) fail('work_not_found');
    this.guard(state, definition, task, context, basis);
    if (!(await knowledgeInputsCurrent(this.services, state))) fail('knowledge_dependency_changed');
    const fresh = await this.services.state.get(context.workId);
    if (!fresh || fresh.revision !== state.revision) fail('read_state_changed');
    this.guard(fresh, definition, task, context, basis); return fresh;
  }
  private progress(cp: ReadCheckpoint, head: ArtifactRef): ReadProgress {
    const coverage = projectReadCoverage(cp);
    return { operationId: cp.operationId, head, callCount: cp.calls.length, remainingCalls: cp.limits.maxCalls - cp.calls.length,
      completedPages: cp.collection.pages.length, completedItems: cp.collection.pages.reduce((n, p) => n + p.items.length, 0) +
        (cp.collection.pending?.items.filter(i => i.status === 'success').length ?? 0),
      pendingItems: cp.collection.pending?.items.filter(i => i.status !== 'success').length ?? 0,
      unknownCalls: cp.calls.filter(c => c.status === 'unknown' || c.status === 'intent').length,
      phase: cp.phase, successorAttemptId: null, ...(cp.retryAt !== undefined ? { retryAt: cp.retryAt, queryDigest: cp.queryDigest } : {}),
      ...(coverage ? { coverage } : {}) };
  }
  private parent(state: WorkState, task: TaskSpec, consumer: string) {
    const resume = task.readResume; if (!resume) return null;
    const parent = state.attempts.find(a => a.id === resume.attemptId);
    if (!parent || parent.id === consumer || parent.effect !== 'read' || parent.effectState !== 'none' ||
      !['partial', 'failed', 'cancelled', 'succeeded'].includes(parent.status) || !parent.readProgress ||
      parent.readProgress.head.id !== resume.checkpointId || parent.readProgress.successorAttemptId !== null ||
      (parent.readProgress.phase === 'complete' && parent.adopted)) fail('read_resume_unavailable');
    return parent;
  }
  /** Scheduling hint. Reserve, dispatch and consumption authenticate the original checkpoint. */
  isCompleteResumeCandidate(state: WorkState, task: TaskSpec, consumer = ''): boolean {
    const definition = this.contracts.get(task.toolId, task.toolVersion)?.tool.definition;
    if (!task.readResume || task.computerResume || task.effect !== 'read' || !definition?.collection) return false;
    try {
      const parent = this.parent(state, task, consumer);
      return !!parent && parent.goalRevision === state.goal.revision && parent.scope === state.goal.scope &&
        parent.toolId === task.toolId && parent.toolVersion === task.toolVersion && parent.readProgress!.phase === 'complete';
    } catch { return false; }
  }
  private resumeInput(state: WorkState, definition: ToolDefinition, task: TaskSpec, consumer: string,
    originals: ReadonlyMap<string, ReadCheckpoint>, completeOnly: boolean) {
    if (!definition.collection || this.contracts.check(task, state.policy)) fail('read_contract_changed');
    const parentAttempt = this.parent(state, task, consumer);
    const parent = parentAttempt ? originals.get(parentAttempt.id) : null;
    if (parentAttempt && !parent) fail('read_resume_unavailable');
    const queryDigest = this.services.digester.digest({ toolId: task.toolId, toolVersion: task.toolVersion, input: task.input });
    if (parent && (parent.queryDigest !== queryDigest || !this.same(parent.limits, definition.collection.limits) ||
      parent.contractDigest !== this.services.digester.digest(asJson(definition)))) fail('read_resume_query_changed');
    if (this.services.clock.now() < (parent?.retryAt ?? 0)) fail('read_retry_not_due');
    if (completeOnly && (!parent || parent.phase !== 'complete' || !parent.collection.exhausted ||
      parent.calls.some(call => call.status === 'intent'))) fail('read_complete_resume_unavailable');
    const coverageManifest = definition.collection.coverage ? this.contracts.readManifest(task) : undefined;
    if (coverageManifest) {
      validateReadCoverageManifest(coverageManifest);
      if (coverageManifest.length > definition.collection.limits.maxItems ||
        parent && !this.same(coverageManifest, parent.coverageManifest)) fail('read_coverage_manifest_changed');
    }
    return { parentAttempt, parent: parent ?? null, queryDigest, coverageManifest };
  }
  async assertCompleteResume(state: WorkState, task: TaskSpec, consumer: string): Promise<void> {
    const entry = this.contracts.get(task.toolId, task.toolVersion);
    if (!entry || !this.isCompleteResumeCandidate(state, task, consumer)) fail('read_complete_resume_unavailable');
    const originals = await readReadyCheckpoints(this.services, this.contracts, state, task);
    this.resumeInput(state, entry.tool.definition, task, consumer, originals, true);
    if (!this.same(await this.services.state.get(state.id), state) || this.contracts.get(task.toolId, task.toolVersion) !== entry)
      fail('read_state_changed');
  }
  private async publish(cp: ReadCheckpoint, expected: ArtifactRef | null, definition: ToolDefinition, task: TaskSpec, context: ExecutionContext, basis: WorkState,
    base: { head: ArtifactRef; checkpoint: ReadCheckpoint } | null, receivedResponse?: ReadResponse, completeOnly = false) {
    const checkpoint = parseContract(ReadCheckpointSchema, cp);
    const bytes = new TextEncoder().encode(JSON.stringify(checkpoint));
    if (bytes.byteLength > checkpoint.limits.maxCheckpointBytes) fail('read_checkpoint_too_large');
    await this.current(definition, task, context, basis);
    const head = await storeReadCheckpoint(this.services.artifacts, this.services.digester, checkpoint, base);
    const dependencies = checkpoint.knowledgeDependencies;
    const current = async () => {
      const state = await this.current(definition, task, context, basis);
      if (!expected && !completeOnly) await assertReadWaitReady(this.services, this.contracts, state, task);
      if (dependencies.length && (!this.services.knowledge || !(await this.services.knowledge.validate(dependencies, state.id, state.policy)))) fail('knowledge_dependency_changed');
      if (receivedResponse) await this.responseProof(state, checkpoint, task, receivedResponse, context);
      if (completeOnly) {
        await context.authorize!();
        if (!expected) await this.assertCompleteResume(state, task, context.attemptId);
      }
      const fresh = await this.services.state.get(context.workId);
      if (!fresh || fresh.revision !== state.revision) fail('read_state_changed');
      this.guard(fresh, definition, task, context, basis); return fresh;
    };
    await current();
    await transact(this.services, context.workId, `read:${context.attemptId}:${head.id}`, 'read_checkpoint_committed',
      { attemptId: context.attemptId, checkpointId: head.id, phase: checkpoint.phase, calls: checkpoint.calls.length }, state => {
        const attempt = this.guard(state, definition, task, context, basis);
        if (!this.same(attempt.readProgress?.head ?? null, expected) || attempt.readProgress?.successorAttemptId) fail('read_head_changed');
        if (!expected && checkpoint.parent) {
          if (this.services.clock.now() < (checkpoint.retryAt ?? 0)) fail('read_retry_not_due');
          const parent = this.parent(state, task, attempt.id)!;
          if (!this.same(parent.readProgress!.head, checkpoint.parent.checkpoint)) fail('read_parent_changed');
          parent.readProgress!.successorAttemptId = attempt.id;
        }
        attempt.readProgress = this.progress(checkpoint, head);
        if (dependencies.length) attempt.knowledgeDependencies = structuredClone(dependencies);
        state.artifacts = this.refs([...state.artifacts, head, ...checkpoint.artifacts]);
      }, async () => { await current(); });
    return head;
  }
  private evidence(cp: ReadCheckpoint): Evidence[] {
    const unique = new Map<string, Evidence>();
    for (const item of [...cp.collection.pages, ...(cp.collection.pending ? [cp.collection.pending] : [])].flatMap(p => p.items)) {
      for (const e of item.evidence) {
        if (unique.has(e.id) && !this.same(unique.get(e.id), e)) fail('evidence_id_collision');
        unique.set(e.id, e);
      }
    }
    return [...unique.values()];
  }
  private async responseProof(state: WorkState, cp: ReadCheckpoint, task: TaskSpec, response: ReadResponse, context: ExecutionContext) {
    this.registration(task, context);
    const raw = response.rawArtifact;
    if (raw && (!visibleArtifact(state, raw) || raw.byteLength > cp.limits.maxPageBytes || !(await this.services.artifacts.exists(raw))))
      fail('read_page_original_unavailable');
    const input = { attemptId: cp.attemptId, task, request: cp.calls.at(-1)!.request };
    const valid = isReadDeferral(response) ? await this.contracts.validateReadDeferral(state, { ...input, deferral: response }) :
      await this.contracts.validateReadPage(state, { ...input, page: response });
    if (!valid) fail(isReadDeferral(response) ? 'read_deferral_proof_unavailable' : 'read_page_proof_unavailable');
    if (raw && !(await this.services.artifacts.exists(raw))) fail('read_page_original_unavailable');
    this.registration(task, context);
  }
  private async accept(state: WorkState, cp: ReadCheckpoint, task: TaskSpec, value: unknown, context: ExecutionContext): Promise<{ response: ReadResponse; refs: ArtifactRef[] }> {
    const response = parseContract(ReadResponseSchema, value);
    if (new TextEncoder().encode(JSON.stringify(response)).byteLength > cp.limits.maxPageBytes || response.requestId !== cp.calls.at(-1)!.request.requestId)
      fail('read_response_invalid');
    const page = isReadDeferral(response) ? null : response;
    if (page) {
      const collection = acceptPage(cp.collection, cp.calls.at(-1)!.request, page, cp.limits);
      if (cp.coverageManifest) validateReadCoverage(cp.coverageManifest, collection);
    }
    const unique = new Map(this.evidence(cp).map(e => [e.id, e]));
    for (const e of page?.items.flatMap(i => i.evidence) ?? []) {
      if (unique.has(e.id) && !this.same(unique.get(e.id), e)) fail('evidence_id_collision');
      unique.set(e.id, e);
    }
    validateEvidenceRecords([...unique.values()], state.goal.scope, state, this.services.digester);
    const refs = this.refs([...(response.rawArtifact ? [response.rawArtifact] : []),
      ...(page?.items.flatMap(i => [...i.artifacts, ...i.evidence.flatMap(e => e.artifact ? [e.artifact] : [])]) ?? [])]);
    for (const ref of refs) if (!visibleArtifact(state, ref) || !(await this.services.artifacts.exists(ref))) fail('artifact_unavailable');
    const dependencies = uniqueKnowledgeDependencies([...cp.knowledgeDependencies, ...(response.knowledgeDependencies ?? [])]);
    if (dependencies.length > 50 || (dependencies.length && (!this.services.knowledge ||
      !(await this.services.knowledge.validate(dependencies, state.id, state.policy))))) fail('knowledge_dependency_changed');
    await this.responseProof(state, cp, task, response, context);
    return { response, refs };
  }
  private async begin(definition: ToolDefinition, source: ReadCollectionSource | null, task: TaskSpec, suppliedContext: Context) {
    const registered = this.contracts.get(task.toolId, task.toolVersion); if (!registered) fail('read_contract_changed');
    const context: ExecutionContext = { ...suppliedContext, registered };
    if ((!source || definition.collection?.pageValidation || definition.collection?.deferralValidation) && typeof context.authorize !== 'function') fail('read_authority_required');
    const dispatch = await this.services.state.receipt(context.workId, `dispatch:${context.attemptId}`);
    if (!dispatch || !definition.collection) fail('read_without_dispatch');
    const basis = dispatch.state; let state = await this.current(definition, task, context, basis);
    const originals = await readReadyCheckpoints(this.services, this.contracts, state, task);
    if (state.attempts.find(a => a.id === context.attemptId)!.readProgress) fail('read_collection_already_started');
    const { parentAttempt, parent, queryDigest, coverageManifest } = this.resumeInput(state, definition, task, context.attemptId, originals, source === null);
    const now = this.services.clock.now();
    let cp: ReadCheckpoint = { schemaVersion: 1, kind: 'read_checkpoint', operationId: parent?.operationId ?? this.services.ids.next('read'),
      workId: context.workId, rootAttemptId: parent?.rootAttemptId ?? context.attemptId, attemptId: context.attemptId,
      goal: structuredClone(basis.goal), policy: structuredClone(basis.policy), lifecycleGeneration: dataGeneration(basis),
      toolId: task.toolId, toolVersion: task.toolVersion, queryDigest, contractDigest: this.services.digester.digest(asJson(definition)),
      limits: structuredClone(definition.collection.limits), collection: parent ? structuredClone(parent.collection) :
        initialize(definition.collection.kind, definition.collection.kind === 'batch' ? source!.manifest!(structuredClone(task)) : null),
      calls: parent ? parent.calls.map(c => c.status === 'intent' ? { ...structuredClone(c), status: 'unknown' as const, errorCode: 'read_response_unknown' } : structuredClone(c)) : [],
      parent: parentAttempt ? { attemptId: parentAttempt.id, checkpoint: structuredClone(parentAttempt.readProgress!.head) } : null,
      artifacts: parentAttempt ? this.refs([parentAttempt.readProgress!.head, ...parent!.artifacts]) : [],
      knowledgeDependencies: uniqueKnowledgeDependencies([...(parent?.knowledgeDependencies ?? []), ...retainedKnowledgeDependencies(state)]),
      phase: parent?.collection.exhausted ? 'complete' : 'running', stopReason: null, createdAt: parent?.createdAt ?? now, updatedAt: now,
      ...(parent?.retryAt !== undefined ? { retryAt: parent.retryAt } : {}), ...(coverageManifest ? { coverageManifest } : {}) };
    return { cp, state, context, basis, base: parentAttempt ? { head: parentAttempt.readProgress!.head, checkpoint: parent! } : null };
  }
  /** Consumes only a proven complete parent. No source callback is available on this path. */
  async consumeComplete(task: TaskSpec, suppliedContext: Context): Promise<ToolResult> {
    const registered = this.contracts.get(task.toolId, task.toolVersion); if (!registered) fail('read_contract_changed');
    const definition = registered.tool.definition;
    const { cp, context, basis, base } = await this.begin(definition, null, task, suppliedContext);
    await context.authorize!();
    this.registration(task, context);
    if (registered !== context.registered) fail('read_contract_changed');
    const head = await this.publish(cp, null, definition, task, context, basis, base, undefined, true);
    const result = await this.checkpoints.project(cp, head);
    await context.authorize!();
    const state = await this.current(definition, task, context, basis);
    const active = state.attempts.find(attempt => attempt.id === context.attemptId)!;
    if (!this.same(active.readProgress?.head, head) || active.readProgress?.successorAttemptId ||
      !base || state.attempts.find(attempt => attempt.id === cp.parent!.attemptId)?.readProgress?.successorAttemptId !== context.attemptId)
      fail('read_head_changed');
    return result;
  }
  async execute(definition: ToolDefinition, source: ReadCollectionSource, task: TaskSpec, suppliedContext: Context): Promise<ToolResult> {
    let { cp, state, context, basis, base } = await this.begin(definition, source, task, suppliedContext);
    let head = await this.publish(cp, null, definition, task, context, basis, base);
    while (cp.phase === 'running') {
      state = await this.current(definition, task, context, basis);
      await this.checkpoints.read(state, context.attemptId, head);
      if (this.services.clock.now() < (cp.retryAt ?? 0)) fail('read_retry_not_due');
      let request;
      try {
        if (cp.calls.length >= cp.limits.maxCalls) fail('read_call_limit');
        request = nextRequest(cp.collection, this.services.ids.next('read_request'), cp.limits);
        if (!request) fail('read_already_complete');
      } catch (error) {
        const previous = cp;
        cp = { ...cp, phase: 'partial', stopReason: error instanceof ReadCollectionError ? error.code : 'read_call_limit',
          artifacts: this.refs([...cp.artifacts, head]), updatedAt: this.services.clock.now() };
        head = await this.publish(cp, head, definition, task, context, basis, { head, checkpoint: previous }); break;
      }
      const beforeIntent = cp;
      cp = { ...cp, calls: [...cp.calls, { request, attemptId: context.attemptId, status: 'intent', response: null,
        dispatchedAt: this.services.clock.now(), receivedAt: null, errorCode: null }], artifacts: this.refs([...cp.artifacts, head]), updatedAt: this.services.clock.now() };
      head = await this.publish(cp, head, definition, task, context, basis, { head, checkpoint: beforeIntent });
      state = await this.current(definition, task, context, basis);
      await this.checkpoints.read(state, context.attemptId, head);
      await this.current(definition, task, context, basis);
      let response: unknown; let failure: string | null = null;
      const intentHead = head; const intentRequest = structuredClone(request); const brokerAuthorize = context.authorize;
      const brokerCustody = context.authorizeResponseCustody;
      const intentCommandId = `read:${context.attemptId}:${intentHead.id}`;
      const intentReceipt = brokerCustody ? await this.services.state.receipt(context.workId, intentCommandId) : null;
      if (brokerCustody && (!intentReceipt || intentReceipt.digest !== this.services.digester.digest(asJson({
        type: 'read_checkpoint_committed', data: { attemptId: context.attemptId, checkpointId: intentHead.id,
          phase: cp.phase, calls: cp.calls.length } })) ||
        !this.same(intentReceipt.state.attempts.find(value => value.id === context.attemptId)?.readProgress?.head, intentHead)))
        fail('read_intent_changed');
      const authorizeResponseCustody = brokerCustody ? async () => {
        await brokerCustody();
        if (!this.same(intentReceipt, await this.services.state.receipt(context.workId, intentCommandId))) fail('read_intent_changed');
        // A later current head does not change the original page's dispatch or authorize another request.
        await brokerCustody();
      } : undefined;
      const authorize = async () => {
        await brokerAuthorize?.();
        const current = await this.current(definition, task, context, basis);
        const verified = await this.checkpoints.read(current, context.attemptId, intentHead);
        const call = verified.calls.at(-1);
        if (verified.phase !== 'running' || call?.status !== 'intent' || call.attemptId !== context.attemptId ||
          !this.same(call.request, intentRequest)) fail('read_intent_changed');
        if (this.services.clock.now() < (verified.retryAt ?? 0)) fail('read_retry_not_due');
        await assertReadWaitReady(this.services, this.contracts, current, task);
        const latest = await this.services.state.get(context.workId);
        if (!latest || latest.revision !== current.revision) fail('read_state_changed');
        const active = this.guard(latest, definition, task, context, basis);
        if (!this.same(active.readProgress?.head, intentHead) || active.readProgress?.successorAttemptId) fail('read_head_changed');
      };
      try { response = await source.fetch(structuredClone(task), structuredClone(request), { workId: context.workId, attemptId: context.attemptId,
        policy: structuredClone(basis.policy), signal: context.signal, authorize,
        ...(authorizeResponseCustody ? { authorizeResponseCustody } : {}) }); }
      catch { failure = 'read_source_failed'; }
      state = await this.current(definition, task, context, basis);
      let accepted: { response: ReadResponse; refs: ArtifactRef[] } | null = null;
      if (!failure) {
        try { accepted = await this.accept(state, cp, task, response, context); }
        catch (error) { failure = error instanceof ReadCollectionError ? error.code : 'read_response_invalid'; }
      }
      await this.current(definition, task, context, basis);
      let raw: ArtifactRef | null = null;
      if (accepted) raw = await this.services.artifacts.put(new TextEncoder().encode(JSON.stringify(accepted.response)),
        { tenantId: basis.policy.tenantId, labels: [...basis.policy.allowedLabels], mediaType: 'application/json' });
      const deferred = accepted && isReadDeferral(accepted.response) ? accepted.response : null;
      const page = accepted && !isReadDeferral(accepted.response) ? accepted.response : null;
      const collection = page ? acceptPage(cp.collection, request, page, cp.limits) : cp.collection;
      const pendingAt = pendingReadRetryAt(collection);
      const retryAt = deferred ? Math.max(deferred.dueAt, pendingAt ?? 0) : page ? pendingAt : cp.retryAt;
      const beforeSettle = cp;
      cp = { ...cp, collection, calls: cp.calls.map((call, i) => i === cp.calls.length - 1 ?
        { ...call, status: deferred ? 'deferred' : accepted ? 'accepted' : 'rejected', response: raw, receivedAt: this.services.clock.now(),
          errorCode: deferred ? 'read_rate_limited' : failure } : call),
        ...(retryAt !== null && retryAt !== undefined || cp.retryAt !== undefined ? { retryAt } : {}),
        artifacts: this.refs([...cp.artifacts, head, ...(raw ? [raw] : []), ...(accepted?.refs ?? [])]),
        knowledgeDependencies: uniqueKnowledgeDependencies([...cp.knowledgeDependencies, ...(accepted?.response.knowledgeDependencies ?? [])]),
        phase: collection.exhausted ? 'complete' : !accepted || deferred || collection.pending ? 'partial' : 'running',
        stopReason: collection.exhausted ? null : deferred ? 'read_rate_limited' : failure ?? (collection.pending ? 'read_items_pending' : null), updatedAt: this.services.clock.now() };
      head = await this.publish(cp, head, definition, task, context, basis, { head, checkpoint: beforeSettle }, accepted?.response);
    }
    await this.current(definition, task, context, basis);
    return this.checkpoints.project(cp, head);
  }
}
