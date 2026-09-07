import type { ArtifactRef, Attempt, Evidence, TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import { sumReadUsage } from './read-usage.js';
import type { ReadCheckpoint } from '../domain/read-checkpoint.js';
import { isReadDeferral, pendingReadRetryAt, type ReadResponse } from '../domain/read-collection.js';
import type { KnowledgeDependency } from '../domain/knowledge.js';
import { dataGeneration } from '../domain/data-lifecycle.js';
import { projectReadCoverage, validateReadCoverage } from '../domain/read-coverage.js';
import { ReadCheckpointReader } from './read-checkpoint-store.js';
import { acceptPage, initialize, nextRequest } from './read-collection-validation.js';
import { ToolResultSchema } from './contracts.js';
import { validateEvidenceRecords } from './evidence-intake.js';
import { asJson, taskDigest } from './plan-validator.js';
import { knowledgeInputsCurrent, uniqueKnowledgeDependencies } from './knowledge-validity.js';
import type { RuntimeServices } from './services.js';
import type { SourceInputInspection } from './source-input-inspection.js';
import { toolAllowed, type RegisteredTool, type ToolContracts } from './tool-contracts.js';

type Services = Pick<RuntimeServices, 'state' | 'artifacts' | 'digester' | 'knowledge' | 'inputs'>;
type Verified = { checkpoint: ReadCheckpoint; head: ArtifactRef; raw: Map<string, ReadResponse>; checkpoints: ReadCheckpoint[] };
function unavailable(): never { throw new Error('read_checkpoint_unavailable'); }

/** Checkpoint bytes are claims until matched against the work's committed head and original responses. */
export class ReadCheckpoints {
  constructor(readonly services: Services, readonly contracts: ToolContracts) {}
  private digest(value: unknown): string { return this.services.digester.digest(asJson(value ?? null)); }
  private same(a: unknown, b: unknown): boolean { return this.digest(a) === this.digest(b); }
  private dependencyKey(dependency: KnowledgeDependency) {
    return this.digest({ ...dependency, sources: dependency.sources.map(({ workRevision: _revision, ...source }) => source) });
  }
  private includesDependencies(actual: KnowledgeDependency[], required: KnowledgeDependency[]) {
    const keys = new Set(actual.map(value => this.dependencyKey(value)));
    return required.every(value => keys.has(this.dependencyKey(value)));
  }
  private ownedArtifact(checkpoint: ReadCheckpoint, ref: ArtifactRef) {
    if (ref.tenantId !== checkpoint.policy.tenantId || ref.mediaType !== 'application/json' ||
      !this.same([...ref.labels].sort(), [...checkpoint.policy.allowedLabels].sort())) unavailable();
  }
  private async dispatch(state: WorkState, checkpoint: ReadCheckpoint, attempt: Attempt): Promise<TaskSpec> {
    const receipt = await this.services.state.receipt(state.id, `dispatch:${attempt.id}`);
    const dispatched = receipt?.state.attempts.find(value => value.id === attempt.id);
    const task = receipt?.state.plan?.tasks.find(value => value.id === attempt.taskId);
    if (!receipt || !dispatched || !task || receipt.state.id !== state.id || dispatched.status !== 'running' ||
      !this.same(receipt.state.goal, checkpoint.goal) || !this.same(receipt.state.policy, checkpoint.policy) ||
      dataGeneration(receipt.state) !== checkpoint.lifecycleGeneration || receipt.state.plan?.revision !== attempt.planRevision ||
      task.effect !== 'read' || attempt.effect !== 'read' || dispatched.effect !== 'read' ||
      task.toolId !== checkpoint.toolId || task.toolVersion !== checkpoint.toolVersion ||
      attempt.toolId !== checkpoint.toolId || attempt.toolVersion !== checkpoint.toolVersion ||
      attempt.goalRevision !== checkpoint.goal.revision || attempt.scope !== checkpoint.goal.scope ||
      dispatched.taskId !== attempt.taskId || dispatched.toolId !== attempt.toolId || dispatched.toolVersion !== attempt.toolVersion ||
      dispatched.owner !== attempt.owner || dispatched.startedAt !== attempt.startedAt || dispatched.scope !== attempt.scope ||
      dispatched.goalRevision !== attempt.goalRevision || dispatched.planRevision !== attempt.planRevision ||
      dispatched.inputDigest !== attempt.inputDigest || dispatched.contractDigest !== checkpoint.contractDigest ||
      attempt.contractDigest !== checkpoint.contractDigest || taskDigest(task, this.services.digester) !== attempt.inputDigest ||
      this.digest({ toolId: task.toolId, toolVersion: task.toolVersion, input: task.input }) !== checkpoint.queryDigest) unavailable();
    return task;
  }
  private contract(checkpoint: ReadCheckpoint, state: WorkState) {
    const entry = this.contracts.get(checkpoint.toolId, checkpoint.toolVersion); const definition = entry?.tool.definition;
    if (!definition || definition.effect !== 'read' || !definition.collection || !toolAllowed(definition, state.policy) ||
      this.digest(definition) !== checkpoint.contractDigest || definition.collection.kind !== checkpoint.collection.kind ||
      !this.same(definition.collection.limits, checkpoint.limits)) unavailable();
    return entry!;
  }
  private async fresh(state: WorkState, checkpoints: ReadCheckpoint[]) {
    if (!(await knowledgeInputsCurrent(this.services, state))) unavailable();
    const dependencies = uniqueKnowledgeDependencies(checkpoints.flatMap(checkpoint => checkpoint.knowledgeDependencies));
    if (dependencies.length > 50 || (dependencies.length && (!this.services.knowledge ||
      !(await this.services.knowledge.validate(dependencies, state.id, state.policy))))) unavailable();
    await this.structuralBoundary(state, checkpoints);
  }
  private async structuralBoundary(state: WorkState, checkpoints: ReadCheckpoint[]) {
    if (!this.same(await this.services.state.get(state.id), state)) unavailable();
    for (const checkpoint of checkpoints) this.contract(checkpoint, state);
  }
  private progress(attempt: Attempt, checkpoint: ReadCheckpoint, head: ArtifactRef) {
    const progress = attempt.readProgress;
    const completed = checkpoint.collection.pages.flatMap(page => page.items).length +
      (checkpoint.collection.pending?.items.filter(item => item.status === 'success').length ?? 0);
    const pending = checkpoint.collection.pending?.items.filter(item => item.status !== 'success').length ?? 0;
    if (!progress || progress.operationId !== checkpoint.operationId || !this.same(progress.head, head) ||
      progress.callCount !== checkpoint.calls.length || progress.remainingCalls !== checkpoint.limits.maxCalls - checkpoint.calls.length ||
      progress.completedPages !== checkpoint.collection.pages.length || progress.completedItems !== completed || progress.pendingItems !== pending ||
      progress.unknownCalls !== checkpoint.calls.filter(call => call.status === 'unknown' || call.status === 'intent').length ||
      progress.phase !== checkpoint.phase || progress.retryAt !== checkpoint.retryAt ||
      progress.queryDigest !== (checkpoint.retryAt !== undefined ? checkpoint.queryDigest : undefined) ||
      !this.same(progress.coverage, projectReadCoverage(checkpoint))) unavailable();
  }
  private async verify(input: WorkState, attemptId: string, expectedHead?: ArtifactRef): Promise<Verified> {
    const state = structuredClone(input); const reader = new ReadCheckpointReader(state, this.services.artifacts, this.services.digester);
    if (!this.same(await this.services.state.get(state.id), state)) unavailable();
    const chain: { checkpoint: ReadCheckpoint; head: ArtifactRef; attempt: Attempt; task: TaskSpec; registered: RegisteredTool }[] = [];
    const visited = new Set<string>(); let id = attemptId; let wanted = expectedHead && structuredClone(expectedHead);
    for (;;) {
      if (visited.has(id) || visited.size >= 64) unavailable();
      visited.add(id);
      const attempt = state.attempts.find(value => value.id === id);
      const head = attempt?.readProgress?.head;
      if (!attempt || !head || (wanted && !this.same(head, wanted))) unavailable();
      const checkpoint = await reader.load(head);
      if (checkpoint.workId !== state.id || checkpoint.attemptId !== id ||
        !this.same(checkpoint.goal, state.goal) || !this.same(checkpoint.policy, state.policy) || checkpoint.lifecycleGeneration !== dataGeneration(state)) unavailable();
      this.ownedArtifact(checkpoint, head); const registered = this.contract(checkpoint, state); this.progress(attempt, checkpoint, head);
      const task = await this.dispatch(state, checkpoint, attempt);
      if (registered.tool.definition.collection?.coverage) {
        if (!checkpoint.coverageManifest || !this.same(checkpoint.coverageManifest, this.contracts.readManifest(task))) unavailable();
        validateReadCoverage(checkpoint.coverageManifest, checkpoint.collection);
        if (this.contract(checkpoint, state) !== registered) unavailable();
      } else if (checkpoint.coverageManifest !== undefined) unavailable();
      if (checkpoint.parent ? !task.readResume || task.readResume.attemptId !== checkpoint.parent.attemptId || task.readResume.checkpointId !== checkpoint.parent.checkpoint.id :
        task.readResume !== undefined || checkpoint.rootAttemptId !== id) unavailable();
      chain.push({ checkpoint, head, attempt, task, registered });
      if (!checkpoint.parent) break;
      id = checkpoint.parent.attemptId; wanted = checkpoint.parent.checkpoint;
    }
    const raw = new Map<string, ReadResponse>();
    const ordered = [...chain].reverse();
    const origins = new Map(chain.map(value => [value.attempt.id, value]));
    for (let position = 0; position < ordered.length; position++) {
      const entry = ordered[position]!; const checkpoint = entry.checkpoint; const parent = ordered[position - 1];
      const refs = new Map<string, ArtifactRef>();
      for (const ref of checkpoint.artifacts) {
        if (refs.has(ref.id)) unavailable();
        refs.set(ref.id, ref);
        await reader.original(ref);
      }
      const requireRef = (ref: ArtifactRef) => { if (!this.same(refs.get(ref.id), ref)) unavailable(); };
      if (parent) {
        if (!['partial', 'failed', 'cancelled', 'succeeded'].includes(parent.attempt.status) || parent.attempt.effectState !== 'none' ||
          (parent.checkpoint.phase === 'complete' && parent.attempt.adopted) ||
          parent.attempt.readProgress?.successorAttemptId !== entry.attempt.id || checkpoint.operationId !== parent.checkpoint.operationId ||
          checkpoint.rootAttemptId !== parent.checkpoint.rootAttemptId || checkpoint.createdAt !== parent.checkpoint.createdAt ||
          checkpoint.updatedAt < parent.checkpoint.updatedAt || entry.attempt.startedAt < (parent.checkpoint.retryAt ?? 0) || checkpoint.queryDigest !== parent.checkpoint.queryDigest ||
          checkpoint.contractDigest !== parent.checkpoint.contractDigest || !this.same(checkpoint.limits, parent.checkpoint.limits) ||
          checkpoint.calls.length < parent.checkpoint.calls.length || !this.same(checkpoint.collection.batchExpected, parent.checkpoint.collection.batchExpected) ||
          !this.includesDependencies(checkpoint.knowledgeDependencies, parent.checkpoint.knowledgeDependencies)) unavailable();
        requireRef(parent.head); parent.checkpoint.artifacts.forEach(requireRef);
        for (let n = 0; n < parent.checkpoint.calls.length; n++) {
          const prior = parent.checkpoint.calls[n]!; const inherited = checkpoint.calls[n]!;
          if (prior.status === 'intent') {
            if (inherited.status !== 'unknown' || inherited.errorCode === null || inherited.response !== null ||
              !this.same(inherited.request, prior.request) || inherited.attemptId !== prior.attemptId || inherited.dispatchedAt !== prior.dispatchedAt) unavailable();
          } else if (!this.same(prior, inherited)) unavailable();
        }
      }
      if (checkpoint.collection.batchExpected && checkpoint.collection.batchExpected.length > Math.min(checkpoint.limits.pageSize, checkpoint.limits.maxItems)) unavailable();
      let replay = initialize(checkpoint.collection.kind, checkpoint.collection.batchExpected);
      let retryAt: number | null | undefined;
      const dependencies: KnowledgeDependency[] = [];
      const evidence = new Map<string, Evidence>();
      for (let n = 0; n < checkpoint.calls.length; n++) {
        const call = checkpoint.calls[n]!;
        const inherited = n < (parent?.checkpoint.calls.length ?? 0);
        if ((!inherited && (call.attemptId !== checkpoint.attemptId || call.dispatchedAt < entry.attempt.startedAt)) ||
          (n > 0 && call.dispatchedAt < checkpoint.calls[n - 1]!.dispatchedAt) || call.dispatchedAt < (retryAt ?? 0)) unavailable();
        const expected = nextRequest(replay, call.request.requestId, checkpoint.limits);
        if (!this.same(expected, call.request)) unavailable();
        if (call.response) { requireRef(call.response); this.ownedArtifact(checkpoint, call.response); }
        if (call.status !== 'accepted' && call.status !== 'deferred') continue;
        if (!call.response) unavailable();
        let response = raw.get(call.response.id);
        if (!response) {
          response = call.status === 'deferred' ? await reader.deferral(call.response, checkpoint.limits.maxPageBytes) :
            await reader.page(call.response, checkpoint.limits.maxPageBytes);
          raw.set(call.response.id, response);
        }
        if (response.requestId !== call.request.requestId || (call.status === 'deferred') !== isReadDeferral(response)) unavailable();
        if (response.rawArtifact) {
          requireRef(response.rawArtifact);
          await reader.proofOriginal(response.rawArtifact, checkpoint.limits.maxPageBytes);
        }
        const origin = origins.get(call.attemptId); if (!origin) unavailable();
        dependencies.push(...(response.knowledgeDependencies ?? []));
        if (isReadDeferral(response)) {
          if (!(await this.contracts.validateReadDeferral(state, { attemptId: call.attemptId, task: origin.task, request: call.request, deferral: response }))) unavailable();
          retryAt = Math.max(response.dueAt, pendingReadRetryAt(replay) ?? 0);
          continue;
        }
        const page = response;
        if (!(await this.contracts.validateReadPage(state, { attemptId: call.attemptId, task: origin.task, request: call.request, page }))) unavailable();
        replay = acceptPage(replay, call.request, page, checkpoint.limits);
        const pendingAt = pendingReadRetryAt(replay);
        if (pendingAt !== null || retryAt !== undefined) retryAt = pendingAt;
        for (const item of page.items) {
          for (const ref of [...item.artifacts, ...item.evidence.flatMap(value => value.artifact ? [value.artifact] : [])]) requireRef(ref);
          for (const value of item.evidence) {
            const prior = evidence.get(value.id);
            if (prior && !this.same(prior, value)) unavailable();
            evidence.set(value.id, value);
          }
        }
      }
      if (!this.same(replay, checkpoint.collection) || retryAt !== checkpoint.retryAt || !this.includesDependencies(checkpoint.knowledgeDependencies, dependencies)) unavailable();
      validateEvidenceRecords([...evidence.values()], checkpoint.goal.scope, state, this.services.digester);
    }
    await this.structuralBoundary(state, chain.map(value => value.checkpoint));
    await reader.revalidate();
    if (!this.same(await this.services.state.get(state.id), state)) unavailable();
    for (const value of chain) if (this.contract(value.checkpoint, state) !== value.registered) unavailable();
    return { checkpoint: chain[0]!.checkpoint, head: chain[0]!.head, raw, checkpoints: chain.map(value => value.checkpoint) };
  }
  async read(state: WorkState, attemptId: string, expectedHead?: ArtifactRef): Promise<ReadCheckpoint> {
    const verified = await this.verify(state, attemptId, expectedHead);
    await this.fresh(state, verified.checkpoints); return verified.checkpoint;
  }
  /** Authenticate stored bytes and contracts, returning the inputs that a closure must still validate. */
  async inspectInputs(state: WorkState, attemptId: string, expectedHead?: ArtifactRef): Promise<SourceInputInspection> {
    const verified = await this.verify(state, attemptId, expectedHead);
    const version = this.digest({ checkpoint: verified.checkpoint, head: verified.head });
    return { version, sourceWorkIds: [state.id], knowledgeDependencies: uniqueKnowledgeDependencies(verified.checkpoints.flatMap(value => value.knowledgeDependencies)),
      bytesRead: new TextEncoder().encode(JSON.stringify(verified.checkpoints)).byteLength,
      current: async () => {
        try { const fresh = await this.verify(state, attemptId, expectedHead); return this.digest({ checkpoint: fresh.checkpoint, head: fresh.head }) === version; }
        catch { return false; }
      } };
  }
  private projection({ checkpoint, head, raw }: Verified): ToolResult {
    if (checkpoint.phase === 'running' || checkpoint.calls.some(call => call.status === 'intent')) unavailable();
    const items = [...checkpoint.collection.pages, ...(checkpoint.collection.pending ? [checkpoint.collection.pending] : [])].flatMap(page => page.items);
    const evidence = new Map<string, Evidence>();
    for (const item of items) if (item.status === 'success' || item.status === 'partial') for (const value of item.evidence) {
      const prior = evidence.get(value.id); if (prior && !this.same(prior, value)) unavailable(); evidence.set(value.id, value);
    }
    const artifacts = new Map<string, ArtifactRef>();
    for (const ref of [head, ...checkpoint.artifacts]) {
      const prior = artifacts.get(ref.id); if (prior && !this.same(prior, ref)) unavailable(); artifacts.set(ref.id, ref);
    }
    const calls = checkpoint.calls.filter(call => call.attemptId === checkpoint.attemptId);
    const usage = sumReadUsage(calls.map(call => (call.status === 'accepted' || call.status === 'deferred') && call.response ?
      raw.get(call.response.id)?.usage : null));
    const complete = checkpoint.phase === 'complete';
    return ToolResultSchema.parse({ resultId: `${checkpoint.attemptId}:collection`, attemptId: checkpoint.attemptId,
      status: complete ? 'success' : 'partial', effectState: 'none', evidence: [...evidence.values()], artifacts: [...artifacts.values()],
      output: asJson({ operationId: checkpoint.operationId, snapshot: checkpoint.collection.snapshot, items,
        resume: { attemptId: checkpoint.attemptId, checkpointId: head.id } }),
      error: complete ? null : { code: 'read_collection_partial', retryable: false }, cursor: complete ? null : head.id,
      coverage: complete ? 'complete' : 'partial', collection: { operationId: checkpoint.operationId, checkpoint: head }, usage,
      ...(checkpoint.knowledgeDependencies.length ? { knowledgeDependencies: checkpoint.knowledgeDependencies } : {}) });
  }
  async project(input: ReadCheckpoint, head: ArtifactRef): Promise<ToolResult> {
    const checkpoint = structuredClone(input); const state = await this.services.state.get(checkpoint.workId);
    if (!state) unavailable();
    const verified = await this.verify(state, checkpoint.attemptId, head);
    await this.fresh(state, verified.checkpoints);
    if (!this.same(checkpoint, verified.checkpoint)) unavailable();
    return this.projection(verified);
  }
  async validateResult(input: WorkState, value: ToolResult): Promise<boolean> {
    try {
      const state = structuredClone(input);
      const result = ToolResultSchema.parse(value); const attempt = state.attempts.find(item => item.id === result.attemptId);
      if (!attempt) return false;
      const definition = this.contracts.get(attempt.toolId, attempt.toolVersion)?.tool.definition;
      if (!result.collection) return !definition?.collection || (result.status !== 'success' && result.status !== 'partial');
      if (result.reuse || !definition?.collection) return false;
      const verified = await this.verify(state, attempt.id, result.collection.checkpoint);
      const projected = this.projection(verified);
      if (result.inputDependencies?.length && (!this.services.inputs || !(await this.services.inputs.validate(result.inputDependencies, state)))) return false;
      const { knowledgeDependencies: actualDependencies = [], inputDependencies: _actualInputs, ...actual } = result;
      const { knowledgeDependencies: expectedDependencies = [], inputDependencies: _expectedInputs, ...expected } = projected;
      if (!this.same(actual, expected) || !this.includesDependencies(actualDependencies, expectedDependencies)) return false;
      if (actualDependencies.length && (!this.services.knowledge || !(await this.services.knowledge.validate(actualDependencies, state.id, state.policy)))) return false;
      await this.fresh(state, verified.checkpoints);
      return true;
    } catch { return false; }
  }
}
