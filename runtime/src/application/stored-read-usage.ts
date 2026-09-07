import type { ArtifactRef, Attempt, TaskSpec, ToolUsage, WorkState } from '../domain/model.js';
import type { ReadCall, ReadCheckpoint } from '../domain/read-checkpoint.js';
import type { ReadCheckpointRecord } from '../domain/read-checkpoint-record.js';
import { artifactBlocked, dataGeneration } from '../domain/data-lifecycle.js';
import { isReadDeferral } from '../domain/read-collection.js';
import { projectReadCoverage } from '../domain/read-coverage.js';
import type { ArtifactStore, ReadUsageRestoreResult } from './ports.js';
import type { RuntimeServices } from './services.js';
import type { RegisteredTool, ToolContracts } from './tool-contracts.js';
import { ReadCheckpointReader } from './read-checkpoint-store.js';
import { ReadCheckpointRecordSchema } from './read-checkpoint-record.js';
import { ReadCheckpointSchema } from './read-checkpoint-contracts.js';
import { ArtifactSchema } from './contracts.js';
import { ReadDeferralSchema, ReadPageSchema } from './read-collection-contracts.js';
import { asJson, taskDigest } from './plan-validator.js';
import { frozen } from './resource-contracts.js';
import { isEndedToolReservation } from './tool-execution-usage.js';
import { sumReadUsage } from './read-usage.js';

type Services = Pick<RuntimeServices, 'state' | 'artifacts' | 'digester' | 'clock'>;
type Receipt = NonNullable<Awaited<ReturnType<Services['state']['receipt']>>>;
type Available = Extract<ReadUsageRestoreResult, { kind: 'available' }>;
export interface ReadCustodyInspection {
  readonly workId: string;
  readonly attemptId: string;
  readonly head: ArtifactRef;
  readonly custodyRefs: ArtifactRef[];
  readonly sourceDigest: string;
  readonly receivedAt: number | null;
}
export interface ReadUsageTicket {
  readonly workId: string;
  readonly attemptId: string;
  readonly usage: ToolUsage;
  readonly sourceDigest: string;
  readonly receivedAt: number | null;
  readonly custodyRefs: ArtifactRef[];
}
interface Scope {
  store: ArtifactStore;
  json(ref: ArtifactRef, basis: WorkState): Promise<unknown>;
  original(ref: ArtifactRef, basis: WorkState, maximum?: number): Promise<Uint8Array>;
  revalidate(): Promise<void>;
}
interface Branch {
  attempt: Attempt; dispatch: Receipt; task: TaskSpec; checkpoint: ReadCheckpoint; head: ArtifactRef;
  publication: Receipt; publicationId: string; records: ArtifactRef[];
}
interface Proof {
  stateDigest: string; entry: RegisteredTool; sourceDigest: string;
  observations: (ToolUsage | null)[]; inspection: ReadCustodyInspection;
}
interface Issued { kind: 'inspection' | 'usage'; proof: Proof; valueDigest: string; closureDigest?: string }
const maxBytes = 64 * 1024 * 1024, maxRecordBytes = 16 * 1024 * 1024, maxRefs = 10000;
const closedStatuses = new Set<Attempt['status']>(['received', 'succeeded', 'partial', 'failed', 'cancelled', 'unknown']);
function fail(code = 'stored_read_usage_invalid'): never { throw new Error(code); }
function identity(attempt: Attempt) {
  return { id: attempt.id, taskId: attempt.taskId, planRevision: attempt.planRevision, goalRevision: attempt.goalRevision,
    toolId: attempt.toolId, toolVersion: attempt.toolVersion, inputDigest: attempt.inputDigest, scope: attempt.scope,
    contractDigest: attempt.contractDigest ?? null, owner: attempt.owner, startedAt: attempt.startedAt, leaseUntil: attempt.leaseUntil,
    effect: attempt.effect, effectState: attempt.effectState, reuse: attempt.reuse ?? null,
    computerUse: attempt.computerUse ?? null, effectReceipt: attempt.effectReceipt ?? null };
}

/** Historical custody proof only. It cannot project a page, write state, dispatch or adopt a result. */
export class StoredReadUsages {
  readonly #issued = new WeakMap<object, Issued>();
  constructor(readonly services: Services, readonly contracts: ToolContracts) {}
  private digest(value: unknown) { return this.services.digester.digest(asJson(value ?? null)); }
  private same(a: unknown, b: unknown) { return this.digest(a) === this.digest(b); }
  candidate(state: WorkState, attemptId: string): boolean {
    const matches = state.attempts.filter(value => value.id === attemptId), attempt = matches[0];
    if (matches.length !== 1 || !attempt || attempt.status === 'reserved' || isEndedToolReservation(attempt) ||
      attempt.effect !== 'read' || attempt.effectState !== 'none' || !attempt.readProgress || !attempt.contractDigest ||
      attempt.reuse || attempt.computerUse || attempt.effectReceipt) return false;
    const entry = this.contracts.get(attempt.toolId, attempt.toolVersion), d = entry?.tool.definition;
    return !!entry?.tool.restoreReadUsage && !!entry.tool.restoreReadResponse && !!entry.tool.validateReadPage &&
      !!d && d.effect === 'read' && d.collection?.pageValidation === 'artifact-proof-v1' &&
      d.collection.responseRecovery === 'stored-response-v1' && !d.resultValidation && !d.reuse &&
      !d.computerContinuation && !d.computerInputAssurance && this.digest(d) === attempt.contractDigest;
  }
  private owner(state: WorkState, basis: WorkState) {
    if (state.id !== basis.id || state.createdAt !== basis.createdAt || state.policy.tenantId !== basis.policy.tenantId ||
      state.policy.principalId !== basis.policy.principalId || dataGeneration(state) !== dataGeneration(basis))
      fail('stored_read_usage_owner_mismatch');
  }
  private attempt(state: WorkState, id: string) {
    const matches = state.attempts.filter(value => value.id === id);
    if (matches.length !== 1) fail(); return matches[0]!;
  }
  private indexed(state: WorkState, ref: ArtifactRef) {
    const matches = state.artifacts.filter(value => value.id === ref.id);
    if (artifactBlocked(state, ref) || ref.tenantId !== state.policy.tenantId || matches.length !== 1 || !this.same(matches[0], ref))
      fail('stored_read_usage_original_unavailable');
  }
  private async current(state: WorkState, attemptId: string, entry: RegisteredTool) {
    const now = this.services.clock.now();
    if (!Number.isSafeInteger(now) || now < state.updatedAt) fail('stored_read_usage_time_invalid');
    const latest = await this.services.state.get(state.id);
    if (latest) this.owner(latest, state);
    if (!this.candidate(state, attemptId) || this.contracts.get(entry.tool.definition.id, entry.tool.definition.version) !== entry ||
      !this.same(latest, state)) fail('stored_read_usage_changed');
  }
  private scope(state: WorkState): Scope {
    const cache = new Map<string, { ref: ArtifactRef; policy: WorkState['policy']; bytes: Uint8Array; json?: unknown }>(); let bytesRead = 0;
    const freshBytes = async (ref: ArtifactRef, policy: WorkState['policy']) => {
      this.indexed(state, ref);
      const bytes = new Uint8Array(await this.services.artifacts.get(structuredClone(ref), structuredClone(policy)));
      const hash = await crypto.subtle.digest('SHA-256', bytes.buffer);
      if (bytes.byteLength !== ref.byteLength || Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('') !== ref.sha256)
        fail('stored_read_usage_original_unavailable');
      this.indexed(state, ref); return bytes;
    };
    const read = async (value: ArtifactRef, policy: WorkState['policy'], maximum = maxRecordBytes) => {
      const ref = ArtifactSchema.parse(value); this.indexed(state, ref);
      if (ref.byteLength > maximum || ref.tenantId !== policy.tenantId || ref.labels.some(label => !policy.allowedLabels.includes(label)))
        fail('stored_read_usage_original_unavailable');
      const cached = cache.get(ref.id);
      if (cached) { if (!this.same(cached.ref, ref)) fail(); return cached; }
      if (cache.size >= maxRefs || bytesRead + ref.byteLength > maxBytes) fail('read_checkpoint_unavailable');
      const bytes = await freshBytes(ref, policy); bytesRead += bytes.byteLength;
      const result: { ref: ArtifactRef; policy: WorkState['policy']; bytes: Uint8Array; json?: unknown } =
        { ref, policy: structuredClone(policy), bytes }; cache.set(ref.id, result); return result;
    };
    return { store: {
      put: async () => { throw new Error('stored_read_usage_read_only'); },
      get: async (ref, policy) => new Uint8Array((await read(ref, policy)).bytes),
      exists: async ref => { this.indexed(state, ref); return this.services.artifacts.exists(structuredClone(ref)); },
    }, original: async (ref, basis, maximum) => new Uint8Array((await read(ref, basis.policy, maximum)).bytes),
    json: async (ref, basis) => {
      const entry = await read(ref, basis.policy);
      if (entry.json === undefined) entry.json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes)) as unknown;
      return entry.json;
    }, revalidate: async () => {
      // A previous scope read is not a final integrity check. Use the real store again;
      // cache membership fixes the bounded set, never the bytes accepted by this fence.
      for (const { ref, policy } of cache.values()) await freshBytes(ref, policy);
    } };
  }
  private async dispatch(state: WorkState, attempt: Attempt) {
    const receipt = await this.services.state.receipt(state.id, `dispatch:${attempt.id}`);
    if (!receipt) fail(); this.owner(state, receipt.state);
    const sent = this.attempt(receipt.state, attempt.id), task = receipt.state.plan?.tasks.find(value => value.id === attempt.taskId);
    if (!this.same(identity(sent), identity(attempt)) || sent.status !== 'running' || sent.resultId !== null || sent.resultArtifact !== null ||
      sent.adopted || sent.error !== null || !task || task.effect !== 'read' || task.computerResume ||
      task.toolId !== attempt.toolId || task.toolVersion !== attempt.toolVersion || taskDigest(task, this.services.digester) !== attempt.inputDigest ||
      sent.goalRevision !== receipt.state.goal.revision || sent.scope !== receipt.state.goal.scope ||
      sent.planRevision !== receipt.state.plan?.revision || receipt.state.plan.goalRevision !== sent.goalRevision ||
      receipt.state.revision > state.revision || receipt.digest !== this.digest({ type: 'attempt_dispatched', data: { attemptId: attempt.id, owner: attempt.owner } })) fail();
    return { receipt, task };
  }
  private progress(attempt: Attempt, cp: ReadCheckpoint, head: ArtifactRef) {
    const p = attempt.readProgress;
    const completed = cp.collection.pages.reduce((sum, page) => sum + page.items.length, 0) +
      (cp.collection.pending?.items.filter(item => item.status === 'success').length ?? 0);
    const pending = cp.collection.pending?.items.filter(item => item.status !== 'success').length ?? 0;
    if (!p || !this.same(p.head, head) || p.operationId !== cp.operationId || p.callCount !== cp.calls.length ||
      p.remainingCalls !== cp.limits.maxCalls - cp.calls.length || p.completedPages !== cp.collection.pages.length ||
      p.completedItems !== completed || p.pendingItems !== pending || p.unknownCalls !== cp.calls.filter(call => call.status === 'intent' || call.status === 'unknown').length ||
      p.phase !== cp.phase || p.retryAt !== cp.retryAt || p.queryDigest !== (cp.retryAt !== undefined ? cp.queryDigest : undefined) ||
      !this.same(p.coverage, projectReadCoverage(cp))) fail('read_checkpoint_unavailable');
  }
  private async recordRefs(scope: Scope, basis: WorkState, head: ArtifactRef) {
    const refs: ArtifactRef[] = []; const seen = new Set<string>(); let ref = head;
    for (;;) {
      if (seen.has(ref.id) || seen.size >= maxRefs) fail('read_checkpoint_unavailable');
      seen.add(ref.id); refs.push(ref);
      const value = await scope.json(ref, basis);
      if ((value as { schemaVersion?: unknown } | null)?.schemaVersion === 1) { ReadCheckpointSchema.parse(value); break; }
      const record = ReadCheckpointRecordSchema.parse(value);
      if (record.change.type === 'start') break;
      ref = record.change.base;
    }
    return refs;
  }
  private async branch(state: WorkState, attempt: Attempt, entry: RegisteredTool, scope: Scope): Promise<Branch> {
    if (!this.candidate(state, attempt.id)) fail();
    const { receipt: dispatch, task } = await this.dispatch(state, attempt);
    const head = attempt.readProgress!.head;
    let publicationId = `read:${attempt.id}:${head.id}`, publication = await this.services.state.receipt(state.id, publicationId);
    let recovery: ReadCheckpointRecord | undefined;
    if (!publication) {
      recovery = ReadCheckpointRecordSchema.parse(await scope.json(head, dispatch.state));
      if (recovery.change.type !== 'settle' || !recovery.change.call.response) fail('read_checkpoint_unavailable');
      publicationId = `read-reconcile:${attempt.id}:${recovery.change.base.id}`;
      publication = await this.services.state.receipt(state.id, publicationId);
    }
    if (!publication) fail('read_checkpoint_unavailable'); this.owner(publication.state, dispatch.state);
    const published = this.attempt(publication.state, attempt.id);
    if (!this.same(identity(published), identity(attempt)) || !this.same(publication.state.goal, dispatch.state.goal) ||
      !this.same(publication.state.policy, dispatch.state.policy) || !(dispatch.state.revision < publication.state.revision && publication.state.revision <= state.revision)) fail();
    const reader = new ReadCheckpointReader(publication.state, scope.store, this.services.digester);
    const cp = await reader.load(head), d = entry.tool.definition;
    if (cp.workId !== state.id || cp.attemptId !== attempt.id || cp.toolId !== attempt.toolId || cp.toolVersion !== attempt.toolVersion ||
      cp.contractDigest !== attempt.contractDigest || cp.lifecycleGeneration !== dataGeneration(dispatch.state) ||
      !this.same(cp.goal, dispatch.state.goal) || !this.same(cp.policy, dispatch.state.policy) ||
      cp.queryDigest !== this.digest({ toolId: task.toolId, toolVersion: task.toolVersion, input: task.input }) ||
      !this.same(cp.limits, d.collection!.limits) || cp.collection.kind !== d.collection!.kind) fail('read_checkpoint_unavailable');
    this.progress(attempt, cp, head); this.progress(published, cp, head);
    const payload = recovery?.change.type === 'settle' ? { type: 'read_response_reconciled', data: {
      attemptId: attempt.id, intentHeadId: recovery.change.base.id, checkpointId: head.id,
      requestId: recovery.change.call.request.requestId, responseId: recovery.change.call.response!.id,
    } } : { type: 'read_checkpoint_committed', data: { attemptId: attempt.id, checkpointId: head.id, phase: cp.phase, calls: cp.calls.length } };
    if (publication.digest !== this.digest(payload)) fail();
    const times = [attempt.startedAt, dispatch.state.updatedAt, cp.createdAt, cp.updatedAt, publication.state.updatedAt, state.updatedAt];
    // Child checkpoints keep their parent's createdAt, which may precede this child's dispatch.
    const ordered = cp.parent ? [attempt.startedAt, dispatch.state.updatedAt, cp.updatedAt, publication.state.updatedAt, state.updatedAt] : times;
    if (!ordered.every(value => Number.isSafeInteger(value) && value >= 0) || ordered.some((value, i) => i > 0 && value < ordered[i - 1]!))
      fail('stored_read_usage_time_invalid');
    const records = await this.recordRefs(scope, publication.state, head);
    await reader.revalidate();
    return { attempt, dispatch, task, checkpoint: cp, head, publication, publicationId, records };
  }
  private async branches(state: WorkState, attemptId: string, entry: RegisteredTool, scope: Scope) {
    const result: Branch[] = [], seen = new Set<string>(); let id = attemptId, expected: ArtifactRef | undefined;
    for (;;) {
      if (seen.has(id) || seen.size >= 64) fail('read_checkpoint_unavailable'); seen.add(id);
      const attempt = this.attempt(state, id);
      if (this.contracts.get(attempt.toolId, attempt.toolVersion) !== entry || expected && !this.same(attempt.readProgress?.head, expected)) fail();
      const branch = await this.branch(state, attempt, entry, scope); result.push(branch);
      const cp = branch.checkpoint;
      if (!cp.parent) {
        if (branch.task.readResume || cp.rootAttemptId !== attempt.id) fail(); break;
      }
      if (!branch.task.readResume || branch.task.readResume.attemptId !== cp.parent.attemptId ||
        branch.task.readResume.checkpointId !== cp.parent.checkpoint.id) fail();
      id = cp.parent.attemptId; expected = cp.parent.checkpoint;
    }
    for (let i = 0; i < result.length; i++) {
      const child = result[i]!, parent = result[i + 1], cp = child.checkpoint;
      if (parent) {
        const p = parent.checkpoint;
        if (!['partial', 'failed', 'cancelled', 'succeeded'].includes(parent.attempt.status) ||
          parent.attempt.readProgress!.successorAttemptId !== child.attempt.id || p.phase === 'complete' && parent.attempt.adopted ||
          cp.operationId !== p.operationId || cp.rootAttemptId !== p.rootAttemptId || cp.createdAt !== p.createdAt ||
          cp.updatedAt < p.updatedAt || !this.same(cp.goal, p.goal) || !this.same(cp.policy, p.policy) ||
          cp.queryDigest !== p.queryDigest || cp.contractDigest !== p.contractDigest || !this.same(cp.limits, p.limits) || cp.calls.length < p.calls.length) fail();
        for (let n = 0; n < p.calls.length; n++) {
          const before = p.calls[n]!, after = cp.calls[n]!;
          if (before.status === 'intent') {
            if (after.status !== 'unknown' || after.response !== null || after.errorCode === null ||
              !this.same(before.request, after.request) || before.attemptId !== after.attemptId || before.dispatchedAt !== after.dispatchedAt) fail();
          } else if (!this.same(before, after)) fail();
        }
      }
      const ids = new Set<string>();
      for (let n = 0; n < cp.calls.length; n++) {
        const call = cp.calls[n]!;
        if (ids.has(call.request.requestId) || n >= (parent?.checkpoint.calls.length ?? 0) && call.attemptId !== child.attempt.id ||
          !Number.isSafeInteger(call.dispatchedAt) || call.dispatchedAt < 0 || call.dispatchedAt > cp.updatedAt ||
          call.attemptId === child.attempt.id && call.dispatchedAt < child.attempt.startedAt ||
          n > 0 && call.dispatchedAt < cp.calls[n - 1]!.dispatchedAt) fail();
        ids.add(call.request.requestId);
      }
    }
    return result;
  }
  private async observed(state: WorkState, branch: Branch, call: ReadCall, value: Available, scope: Scope) {
    const response = await this.services.state.receipt(state.id, value.receipt.commandId);
    const intent = await this.services.state.receipt(state.id, value.intent.commandId);
    if (!response || !intent || response.digest !== value.receipt.digest || intent.digest !== value.intent.digest ||
      value.intent.commandId !== `read:${branch.attempt.id}:${value.intent.artifact.id}`) fail();
    for (const receipt of [intent, response]) {
      this.owner(receipt.state, branch.dispatch.state);
      if (!this.same(identity(this.attempt(receipt.state, branch.attempt.id)), identity(branch.attempt))) fail();
    }
    const atIntent = this.attempt(intent.state, branch.attempt.id);
    if (atIntent.status !== 'running' || !this.same(atIntent.readProgress?.head, value.intent.artifact) ||
      !this.same(intent.state.goal, branch.dispatch.state.goal) || !this.same(intent.state.policy, branch.dispatch.state.policy) ||
      !(branch.dispatch.state.revision < intent.state.revision && intent.state.revision < response.state.revision && response.state.revision <= state.revision)) fail();
    this.indexed(response.state, value.receipt.artifact); this.indexed(intent.state, value.intent.artifact);
    const reader = new ReadCheckpointReader(intent.state, scope.store, this.services.digester);
    const intentCp = await reader.load(value.intent.artifact), original = intentCp.calls.at(-1);
    if (intentCp.attemptId !== branch.attempt.id || intentCp.operationId !== branch.checkpoint.operationId || intentCp.phase !== 'running' ||
      !this.same(intentCp.goal, branch.checkpoint.goal) || !this.same(intentCp.policy, branch.checkpoint.policy) ||
      intentCp.contractDigest !== branch.checkpoint.contractDigest || intentCp.queryDigest !== branch.checkpoint.queryDigest ||
      !original || original.status !== 'intent' || original.attemptId !== branch.attempt.id ||
      original.dispatchedAt !== call.dispatchedAt || !this.same(original.request, call.request) ||
      intent.digest !== this.digest({ type: 'read_checkpoint_committed', data: { attemptId: branch.attempt.id,
        checkpointId: value.intent.artifact.id, phase: intentCp.phase, calls: intentCp.calls.length } })) fail();
    const times = [call.dispatchedAt, intent.state.updatedAt, value.receivedAt, response.state.updatedAt, state.updatedAt];
    if (!times.every(t => Number.isSafeInteger(t) && t >= 0) || times.some((t, i) => i > 0 && t < times[i - 1]!)) fail('stored_read_usage_time_invalid');
    await scope.original(value.receipt.artifact, branch.dispatch.state, Math.min(512 * 1024, branch.checkpoint.limits.maxPageBytes));
    const refs = await this.recordRefs(scope, intent.state, value.intent.artifact);
    const custodyRefs = value.custodyOnly ? [value.receipt.artifact, ...refs] : [];
    if (value.custodyOnly && value.responseObserved && (call.status === 'accepted' || call.status === 'deferred') && call.response) {
      const json = await scope.json(call.response, branch.publication.state);
      const normalized = call.status === 'deferred' ? ReadDeferralSchema.parse(json) : ReadPageSchema.parse(json);
      if ((call.status === 'deferred') !== isReadDeferral(normalized) || normalized.requestId !== call.request.requestId ||
        !normalized.rawArtifact || !this.same(normalized.rawArtifact, value.receipt.artifact) || !this.same(normalized.usage, value.usage)) fail();
      // This authenticates custody linkage, not permission to project or adopt its contents.
      custodyRefs.push(call.response);
    }
    await reader.revalidate();
    if (!this.same(response, await this.services.state.receipt(state.id, value.receipt.commandId)) ||
      !this.same(intent, await this.services.state.receipt(state.id, value.intent.commandId))) fail('stored_read_usage_changed');
    return { custodyRefs, source: this.digest({ response, intent, value }) };
  }
  private async inspect(state: WorkState, attemptId: string): Promise<Proof | null> {
    if (!this.candidate(state, attemptId)) return null;
    const attempt = this.attempt(state, attemptId), entry = this.contracts.get(attempt.toolId, attempt.toolVersion)!;
    await this.current(state, attemptId, entry);
    const scope = this.scope(state), branches = await this.branches(state, attemptId, entry, scope), branch = branches[0]!;
    const calls = branch.checkpoint.calls.filter(call => call.attemptId === attemptId);
    const observations: (ToolUsage | null)[] = [], sources: unknown[] = [], custodyRefs = new Map<string, ArtifactRef>();
    const responseIds = new Set<string>(); let receivedAt: number | null = null, ownsCustody = false;
    const addRef = (ref: ArtifactRef) => {
      this.indexed(state, ref); const old = custodyRefs.get(ref.id);
      if (old && !this.same(old, ref) || custodyRefs.size >= maxRefs && !old) fail(); custodyRefs.set(ref.id, ref);
    };
    for (const call of calls) {
      const restored = await this.contracts.restoreReadUsage(state, { attemptId, task: branch.task, request: call.request, dispatchedAt: call.dispatchedAt });
      await this.current(state, attemptId, entry);
      if (restored.kind === 'absent') { observations.push(null); sources.push({ request: call.request, dispatchedAt: call.dispatchedAt, observation: null }); continue; }
      if (responseIds.has(restored.receipt.commandId)) fail(); responseIds.add(restored.receipt.commandId);
      const observed = await this.observed(state, branch, call, restored, scope);
      observations.push(restored.usage); sources.push({ request: call.request, dispatchedAt: call.dispatchedAt, source: observed.source });
      receivedAt = Math.max(receivedAt ?? 0, restored.receivedAt);
      for (const ref of observed.custodyRefs) addRef(ref);
      ownsCustody ||= restored.custodyOnly;
    }
    // Only the traversed record chain belongs here, never checkpoint.artifacts as a blanket exclusion.
    if (ownsCustody) for (const ref of branch.records) addRef(ref);
    await scope.revalidate();
    for (const b of branches) if (!this.same(b.dispatch, await this.services.state.receipt(state.id, `dispatch:${b.attempt.id}`)) ||
      !this.same(b.publication, await this.services.state.receipt(state.id, b.publicationId))) fail('stored_read_usage_changed');
    await this.current(state, attemptId, entry);
    const sourceDigest = this.digest({ branches: branches.map(b => ({ attemptId: b.attempt.id, head: b.head,
      dispatch: this.digest(b.dispatch), publication: this.digest(b.publication) })), calls: sources });
    const inspection: ReadCustodyInspection = frozen({ workId: state.id, attemptId, head: structuredClone(branch.head),
      custodyRefs: [...custodyRefs.values()].map(ref => structuredClone(ref)).sort((a, b) => a.id.localeCompare(b.id, 'en')),
      sourceDigest, receivedAt });
    return { stateDigest: this.digest(state), entry, sourceDigest, observations, inspection };
  }
  private closure(state: WorkState, attemptId: string) {
    const attempt = this.attempt(state, attemptId), now = this.services.clock.now();
    if (!Number.isSafeInteger(now) || now < state.updatedAt) fail('stored_read_usage_time_invalid');
    const origin = identity(attempt);
    if (closedStatuses.has(attempt.status)) return { kind: 'status', status: attempt.status, origin };
    if (attempt.status === 'running' && now >= attempt.leaseUntil) return { kind: 'lease', leaseUntil: attempt.leaseUntil, origin };
    return null;
  }
  async inspectCustody(state: WorkState, attemptId: string): Promise<ReadCustodyInspection | null> {
    const proof = await this.inspect(structuredClone(state), attemptId); if (!proof) return null;
    const inspection = proof.inspection;
    this.#issued.set(inspection, { kind: 'inspection', proof, valueDigest: this.digest(inspection) }); return inspection;
  }
  async prepareUsage(state: WorkState, inspection: ReadCustodyInspection): Promise<ReadUsageTicket | null> {
    const expected = this.#issued.get(inspection);
    if (!expected || expected.kind !== 'inspection') fail('stored_read_usage_ticket_invalid');
    await this.assertCurrent(state, inspection);
    const closure = this.closure(state, inspection.attemptId); if (!closure) return null;
    const ticket: ReadUsageTicket = frozen({ workId: inspection.workId, attemptId: inspection.attemptId,
      usage: sumReadUsage(expected.proof.observations), sourceDigest: this.digest({ source: inspection.sourceDigest, closure }),
      receivedAt: inspection.receivedAt, custodyRefs: structuredClone(inspection.custodyRefs) });
    this.#issued.set(ticket, { kind: 'usage', proof: expected.proof, closureDigest: this.digest(closure), valueDigest: this.digest(ticket) });
    return ticket;
  }
  async assertCurrent(state: WorkState, value: ReadCustodyInspection | ReadUsageTicket): Promise<void> {
    const expected = this.#issued.get(value);
    if (!expected || value.workId !== state.id || this.digest(value) !== expected.valueDigest || this.digest(state) !== expected.proof.stateDigest)
      fail('stored_read_usage_ticket_invalid');
    const current = await this.inspect(structuredClone(state), value.attemptId);
    if (!current || current.entry !== expected.proof.entry || current.sourceDigest !== expected.proof.sourceDigest ||
      current.stateDigest !== expected.proof.stateDigest || !this.same(current.inspection, expected.proof.inspection)) fail('stored_read_usage_changed');
    if (expected.kind === 'usage') {
      const closure = this.closure(state, value.attemptId);
      if (!closure || this.digest(closure) !== expected.closureDigest) fail('stored_read_usage_changed');
    }
  }
}
