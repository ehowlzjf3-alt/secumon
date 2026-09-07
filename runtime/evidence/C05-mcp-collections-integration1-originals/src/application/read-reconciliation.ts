import type { ArtifactRef, Attempt, Evidence, TaskSpec, WorkState } from '../domain/model.js';
import type { ReadCheckpoint, ReadProgress } from '../domain/read-checkpoint.js';
import { isReadDeferral, type ReadResponse } from '../domain/read-collection.js';
import { visibleArtifact } from '../domain/data-lifecycle.js';
import { projectReadCoverage, validateReadCoverage } from '../domain/read-coverage.js';
import type { ReadResponseRestoreInput } from './ports.js';
import type { RuntimeServices } from './services.js';
import { type RegisteredTool, ToolContracts } from './tool-contracts.js';
import { ReadCheckpoints } from './read-checkpoints.js';
import { settleReadCheckpoint } from './read-checkpoint-record.js';
import { storeReadCheckpoint } from './read-checkpoint-store.js';
import { knowledgeInputsCurrent, uniqueKnowledgeDependencies } from './knowledge-validity.js';
import { validateEvidenceRecords } from './evidence-intake.js';
import { asJson } from './plan-validator.js';
import { transact } from './work-transactions.js';

const terminal = new Set<Attempt['status']>(['failed', 'cancelled', 'partial', 'succeeded']);
function invalid(): never { throw new Error('read_reconciliation_invalid'); }

/** Repairs a missing checkpoint settlement from stored custody only. It cannot dispatch, adopt evidence or reserve budget. */
export class ReadReconciliation {
  private readonly active = new Map<string, Promise<WorkState>>();
  private readonly checkpoints: ReadCheckpoints;
  constructor(readonly services: RuntimeServices, readonly contracts: ToolContracts) { this.checkpoints = new ReadCheckpoints(services, contracts); }
  private same(a: unknown, b: unknown) { return this.services.digester.digest(asJson(a ?? null)) === this.services.digester.digest(asJson(b ?? null)); }
  private candidate(state: WorkState, attemptId: string) {
    const attempt = state.attempts.find(value => value.id === attemptId);
    return attempt && terminal.has(attempt.status) && attempt.effect === 'read' && attempt.effectState === 'none' &&
      attempt.goalRevision === state.goal.revision && attempt.scope === state.goal.scope &&
      attempt.leaseUntil <= this.services.clock.now() && attempt.resultId === null && attempt.resultArtifact === null && !attempt.adopted &&
      attempt.readProgress && attempt.readProgress.successorAttemptId === null ? attempt : null;
  }
  private async state(workId: string) { const state = await this.services.state.get(workId); if (!state) throw new Error('work_not_found'); return state; }
  private refs(values: ArtifactRef[]) {
    const refs = new Map<string, ArtifactRef>();
    for (const value of values) {
      const prior = refs.get(value.id); if (prior && !this.same(prior, value)) invalid();
      refs.set(value.id, structuredClone(value));
    }
    if (refs.size > 10000) invalid(); return [...refs.values()];
  }
  private async current(state: WorkState, attempt: Attempt, entry: RegisteredTool, head: ArtifactRef) {
    if (this.contracts.get(attempt.toolId, attempt.toolVersion) !== entry || !this.same(await this.state(state.id), state)) invalid();
    if (!this.same(this.candidate(state, attempt.id), attempt)) invalid();
    await this.checkpoints.read(state, attempt.id, head);
    if (!(await knowledgeInputsCurrent(this.services, state))) invalid();
    if (this.contracts.get(attempt.toolId, attempt.toolVersion) !== entry || !this.same(await this.state(state.id), state)) invalid();
  }
  private progress(checkpoint: ReadCheckpoint, head: ArtifactRef): ReadProgress {
    const coverage = projectReadCoverage(checkpoint);
    return { operationId: checkpoint.operationId, head, callCount: checkpoint.calls.length,
      remainingCalls: checkpoint.limits.maxCalls - checkpoint.calls.length, completedPages: checkpoint.collection.pages.length,
      completedItems: checkpoint.collection.pages.reduce((n, page) => n + page.items.length, 0) +
        (checkpoint.collection.pending?.items.filter(item => item.status === 'success').length ?? 0),
      pendingItems: checkpoint.collection.pending?.items.filter(item => item.status !== 'success').length ?? 0,
      unknownCalls: checkpoint.calls.filter(call => call.status === 'unknown' || call.status === 'intent').length,
      phase: checkpoint.phase, successorAttemptId: null,
      ...(checkpoint.retryAt !== undefined ? { retryAt: checkpoint.retryAt, queryDigest: checkpoint.queryDigest } : {}),
      ...(coverage ? { coverage } : {}) };
  }
  private async proof(state: WorkState, checkpoint: ReadCheckpoint, task: TaskSpec, response: ReadResponse) {
    const request = checkpoint.calls.at(-1)!.request;
    if (response.requestId !== request.requestId || !response.rawArtifact ||
      new TextEncoder().encode(JSON.stringify(response)).byteLength > checkpoint.limits.maxPageBytes) invalid();
    const raw = response.rawArtifact;
    const refs = this.refs([raw, ...(!isReadDeferral(response) ? response.items.flatMap(item =>
      [...item.artifacts, ...item.evidence.flatMap(evidence => evidence.artifact ? [evidence.artifact] : [])]) : [])]);
    const originalsCurrent = async () => {
      for (const ref of refs) if (!visibleArtifact(state, ref) || ref.id === raw.id && ref.byteLength > checkpoint.limits.maxPageBytes ||
        !(await this.services.artifacts.exists(ref))) invalid();
    };
    await originalsCurrent();
    const input = { attemptId: checkpoint.attemptId, task, request };
    if (isReadDeferral(response) ? !(await this.contracts.validateReadDeferral(state, { ...input, deferral: response })) :
      !(await this.contracts.validateReadPage(state, { ...input, page: response }))) invalid();
    const dependencies = uniqueKnowledgeDependencies([...checkpoint.knowledgeDependencies, ...(response.knowledgeDependencies ?? [])]);
    if (dependencies.length > 50 || dependencies.length && (!this.services.knowledge ||
      !(await this.services.knowledge.validate(dependencies, state.id, state.policy)))) invalid();
    const evidence = new Map<string, Evidence>();
    const items = [...checkpoint.collection.pages, ...(checkpoint.collection.pending ? [checkpoint.collection.pending] : [])].flatMap(page => page.items);
    if (!isReadDeferral(response)) items.push(...response.items);
    for (const value of items.flatMap(item => item.evidence)) {
      const previous = evidence.get(value.id); if (previous && !this.same(previous, value)) invalid(); evidence.set(value.id, value);
    }
    validateEvidenceRecords([...evidence.values()], state.goal.scope, state, this.services.digester);
    await originalsCurrent();
  }
  async reconcile(workId: string, attemptId: string): Promise<WorkState> {
    const key = JSON.stringify([workId, attemptId]); let pending = this.active.get(key);
    if (!pending) {
      pending = this.run(workId, attemptId); this.active.set(key, pending);
      void pending.finally(() => { if (this.active.get(key) === pending) this.active.delete(key); }).catch(() => {});
    }
    return structuredClone(await pending);
  }
  private async run(workId: string, attemptId: string): Promise<WorkState> {
    const state = await this.state(workId); const attempt = this.candidate(state, attemptId); if (!attempt) return state;
    const entry = this.contracts.get(attempt.toolId, attempt.toolVersion);
    if (!entry?.tool.definition.collection?.responseRecovery) return state;
    try {
      const head = structuredClone(attempt.readProgress!.head);
      const checkpoint = await this.checkpoints.read(state, attempt.id, head); const call = checkpoint.calls.at(-1);
      if (call?.status !== 'intent' || call.attemptId !== attempt.id) return state;
      const receipt = await this.services.state.receipt(workId, `dispatch:${attempt.id}`);
      const task = receipt?.state.plan?.tasks.find(value => value.id === attempt.taskId); if (!task) invalid();
      const input: ReadResponseRestoreInput = { attemptId, task: structuredClone(task), request: structuredClone(call.request), intentHead: head };
      await this.current(state, attempt, entry, head);
      const restored = await this.contracts.restoreReadResponse(state, input);
      await this.current(state, attempt, entry, head);
      if (restored.kind === 'absent') return state;
      if (restored.receivedAt < checkpoint.updatedAt || restored.receivedAt < call.dispatchedAt || restored.receivedAt > this.services.clock.now()) invalid();
      const response = restored.response;
      await this.proof(state, checkpoint, task, response);
      await this.current(state, attempt, entry, head);
      const mapped = await this.services.artifacts.put(new TextEncoder().encode(JSON.stringify(response)),
        { tenantId: checkpoint.policy.tenantId, labels: checkpoint.policy.allowedLabels, mediaType: 'application/json' });
      const next = settleReadCheckpoint({ head, checkpoint }, { ...call, status: isReadDeferral(response) ? 'deferred' : 'accepted',
        response: mapped, receivedAt: restored.receivedAt, errorCode: isReadDeferral(response) ? 'read_rate_limited' : null }, response, this.services.digester);
      if (next.coverageManifest) validateReadCoverage(next.coverageManifest, next.collection);
      const settledHead = await storeReadCheckpoint(this.services.artifacts, this.services.digester, next, { head, checkpoint });
      const commandId = `read-reconcile:${attempt.id}:${head.id}`;
      const data = { attemptId, intentHeadId: head.id, checkpointId: settledHead.id, requestId: call.request.requestId, responseId: mapped.id };
      const beforeCommit = async () => {
        await this.current(state, attempt, entry, head);
        await this.proof(state, checkpoint, task, response);
        await this.current(state, attempt, entry, head);
      };
      try {
        return (await transact(this.services, workId, commandId, 'read_response_reconciled', data, latest => {
          if (!this.same(latest, state) || !this.same(this.candidate(latest, attemptId), attempt) ||
            this.contracts.get(attempt.toolId, attempt.toolVersion) !== entry) invalid();
          const target = latest.attempts.find(value => value.id === attemptId)!;
          target.readProgress = this.progress(next, settledHead);
          if (next.knowledgeDependencies.length) target.knowledgeDependencies = structuredClone(next.knowledgeDependencies);
          latest.artifacts = this.refs([...latest.artifacts, settledHead, ...next.artifacts]);
        }, beforeCommit)).state;
      } catch {
        // A durable acknowledgement may be lost. Only the exact committed settlement can resolve that uncertainty.
        const committed = await this.services.state.receipt(workId, commandId);
        if (committed?.digest !== this.services.digester.digest({ type: 'read_response_reconciled', data })) invalid();
        const latest = await this.state(workId); const target = latest.attempts.find(value => value.id === attemptId);
        if (!target?.readProgress || !this.same(target.readProgress.head, settledHead) ||
          this.contracts.get(attempt.toolId, attempt.toolVersion) !== entry ||
          !this.same(await this.checkpoints.read(latest, attemptId, settledHead), next)) invalid();
        return latest;
      }
    } catch { return invalid(); }
  }
}
