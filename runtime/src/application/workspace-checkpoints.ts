import { accessibleEvidence } from '../domain/completion.js';
import { dataGeneration, visibleArtifact } from '../domain/data-lifecycle.js';
import type { WorkState } from '../domain/model.js';
import type { WorkspaceCheckpoint, WorkspaceFile } from '../domain/workspace.js';
import type { RuntimeServices } from './services.js';
import { knowledgeInputsCurrent } from './knowledge-validity.js';
import { ArtifactSchema, parseContract } from './contracts.js';
import { commitWithArtifacts } from './commit-artifacts.js';
import { asJson } from './plan-validator.js';
import { authorizedWork, type WorkActor } from './work-resources.js';
import { WorkspaceCheckpointSchema, WorkspaceFileSchema, WorkspacePathSchema, WorkspaceSourcesSchema } from './workspace-contracts.js';

export interface WorkspaceStore {
  stage(workId: string, attemptId: string, path: string, bytes: Uint8Array,
    attributes: Pick<WorkspaceFile, 'tenantId' | 'labels' | 'lifecycleGeneration'>): Promise<WorkspaceFile>;
  read(workId: string, attemptId: string, path: string): Promise<{ file: WorkspaceFile; bytes: Uint8Array }>;
  list(workId: string, attemptId: string): Promise<WorkspaceFile[]>;
  removeAttempt(workId: string, attemptId: string, expectedFiles: WorkspaceFile[]): Promise<void>;
}
export type WorkspaceCheckpointServices = Pick<RuntimeServices, 'state' | 'artifacts' | 'clock' | 'digester' | 'knowledge' | 'inputs'>;
export interface RestoredWorkspaceCheckpoint { checkpoint: WorkspaceCheckpoint; file: WorkspaceFile; receiptDigest: string }
export class WorkspaceError extends Error {
  readonly cleanupError?: unknown;
  constructor(readonly code: string, options?: ErrorOptions & { cleanupError?: unknown }) {
    super(code, options);
    if (options && 'cleanupError' in options) this.cleanupError = options.cleanupError;
  }
}

export class WorkspaceCheckpoints {
  constructor(readonly services: WorkspaceCheckpointServices, readonly workspaces: WorkspaceStore) {}
  private generation(state: WorkState) { return dataGeneration(state); }
  private async authorized(workId: string, actor: WorkActor) {
    const state = await authorizedWork(this.services.state, workId, actor);
    if (!(await knowledgeInputsCurrent(this.services, state))) throw new WorkspaceError('workspace_knowledge_changed');
    const latest = await authorizedWork(this.services.state, workId, actor);
    if (latest.revision !== state.revision || this.services.digester.digest(asJson(latest.policy)) !== this.services.digester.digest(asJson(state.policy))) throw new WorkspaceError('workspace_state_changed');
    return latest;
  }
  private async state(workId: string, actor: WorkActor, attemptId: string) {
    const state = await this.authorized(workId, actor);
    if (!state.attempts.some(attempt => attempt.id === attemptId)) throw new WorkspaceError('workspace_attempt_unavailable');
    return state;
  }
  private async fresh(before: WorkState, actor: WorkActor, attemptId: string) {
    const latest = await this.state(before.id, actor, attemptId);
    if (latest.revision !== before.revision || this.generation(latest) !== this.generation(before) ||
      this.services.digester.digest(asJson(latest.policy)) !== this.services.digester.digest(asJson(before.policy))) throw new WorkspaceError('workspace_state_changed');
    return latest;
  }
  private permitted(state: WorkState, value: { tenantId: string; labels: string[] }, generation: number) {
    if (value.tenantId !== state.policy.tenantId || value.labels.some(label => !state.policy.allowedLabels.includes(label))) throw new WorkspaceError('workspace_permission_denied');
    if (generation !== this.generation(state)) throw new WorkspaceError('workspace_lifecycle_changed');
  }
  private sources(state: WorkState, ids: string[]) {
    const allowed = new Set(accessibleEvidence(state.evidence, state.policy, state.goal.scope)
      .filter(evidence => (evidence.access ?? 'available') === 'available' && (!evidence.artifact || visibleArtifact(state, evidence.artifact))).map(evidence => evidence.id));
    if (ids.some(id => !allowed.has(id))) throw new WorkspaceError('workspace_source_unavailable');
  }
  private file(state: WorkState, attemptId: string, path: string, value: WorkspaceFile) {
    const file = parseContract(WorkspaceFileSchema, value);
    if (file.workId !== state.id || file.attemptId !== attemptId || file.path !== path) throw new WorkspaceError('workspace_file_identity_mismatch');
    this.permitted(state, file, file.lifecycleGeneration); return file;
  }
  async stage(workId: string, actor: WorkActor, attemptId: string, path: string, bytes: Uint8Array) {
    path = parseContract(WorkspacePathSchema, path); const content = bytes.slice(); const state = await this.state(workId, actor, attemptId);
    const file = this.file(state, attemptId, path, await this.workspaces.stage(workId, attemptId, path, content, {
      tenantId: state.policy.tenantId, labels: [...state.policy.allowedLabels], lifecycleGeneration: this.generation(state),
    }));
    await this.fresh(state, actor, attemptId); return file;
  }
  async read(workId: string, actor: WorkActor, attemptId: string, path: string) {
    path = parseContract(WorkspacePathSchema, path); const state = await this.state(workId, actor, attemptId);
    const stored = await this.workspaces.read(workId, attemptId, path); const file = this.file(state, attemptId, path, stored.file);
    if (stored.bytes.byteLength !== file.byteLength) throw new WorkspaceError('workspace_file_integrity_failure');
    const checkpoint = state.workspaceCheckpoints?.find(value => value.attemptId === attemptId && value.path === path && value.artifact.sha256 === file.sha256);
    if (checkpoint) { this.sources(state, checkpoint.sourceEvidenceIds); if (!visibleArtifact(state, checkpoint.artifact)) throw new WorkspaceError('workspace_permission_denied'); }
    await this.fresh(state, actor, attemptId); return { file, bytes: stored.bytes.slice() };
  }
  async checkpoint(workId: string, actor: WorkActor, attemptId: string, path: string, options: { sourceEvidenceIds?: string[] } = {}) {
    path = parseContract(WorkspacePathSchema, path); const selected = parseContract(WorkspaceSourcesSchema, options);
    const sourceEvidenceIds = [...new Set(selected.sourceEvidenceIds)].sort(); const state = await this.state(workId, actor, attemptId);
    this.sources(state, sourceEvidenceIds);
    const stored = await this.workspaces.read(workId, attemptId, path); const file = this.file(state, attemptId, path, stored.file);
    const artifact = parseContract(ArtifactSchema, await this.services.artifacts.put(stored.bytes, { tenantId: file.tenantId, labels: file.labels, mediaType: 'application/octet-stream' }));
    if (artifact.sha256 !== file.sha256 || artifact.byteLength !== file.byteLength || artifact.tenantId !== file.tenantId ||
      this.services.digester.digest(asJson([...artifact.labels].sort())) !== this.services.digester.digest(asJson([...file.labels].sort()))) throw new WorkspaceError('workspace_artifact_mismatch');
    if (!visibleArtifact(state, artifact)) throw new WorkspaceError('workspace_permission_denied');
    await this.fresh(state, actor, attemptId);
    const basis = { workId, attemptId, path, artifact, sourceEvidenceIds, lifecycleGeneration: this.generation(state) };
    const id = `checkpoint-${this.services.digester.digest(asJson(basis))}`;
    const existing = state.workspaceCheckpoints?.find(checkpoint => checkpoint.id === id);
    if (existing) return parseContract(WorkspaceCheckpointSchema, existing);
    const checkpoint = parseContract(WorkspaceCheckpointSchema, { ...basis, id, createdAt: this.services.clock.now() });
    const raw = await this.services.state.get(workId);
    if (!raw || raw.revision !== state.revision) throw new WorkspaceError('workspace_state_changed');
    const next = structuredClone(raw); next.workspaceCheckpoints = [...(next.workspaceCheckpoints ?? []), checkpoint];
    next.revision++; next.updatedAt = this.services.clock.now();
    const result = await commitWithArtifacts(this.services.state, this.services.artifacts, { workId, expectedRevision: state.revision,
      commandId: id, commandDigest: this.services.digester.digest(asJson(basis)), next,
      events: [{ type: 'workspace_checkpoint_saved', at: next.updatedAt, data: { checkpointId: id, attemptId, path, artifactId: artifact.id } }], deliveries: [] });
    if (result.kind === 'conflict') throw new WorkspaceError('workspace_state_changed');
    if (result.kind === 'idempotency_conflict') throw new WorkspaceError('workspace_checkpoint_identity_conflict');
    const latest = await this.state(workId, actor, attemptId); this.permitted(latest, artifact, checkpoint.lifecycleGeneration); this.sources(latest, sourceEvidenceIds);
    const saved = latest.workspaceCheckpoints?.find(value => value.id === id);
    if (!saved) throw new WorkspaceError('workspace_checkpoint_unavailable');
    return parseContract(WorkspaceCheckpointSchema, saved);
  }
  async restore(workId: string, actor: WorkActor, checkpointId: string) {
    const state = await this.authorized(workId, actor);
    const value = state.workspaceCheckpoints?.find(checkpoint => checkpoint.id === checkpointId);
    if (!value) throw new WorkspaceError('workspace_checkpoint_unavailable');
    const checkpoint = parseContract(WorkspaceCheckpointSchema, value);
    if (checkpoint.workId !== workId || !state.attempts.some(attempt => attempt.id === checkpoint.attemptId)) throw new WorkspaceError('workspace_attempt_unavailable');
    return this.restoreCheckpoint(state, actor, checkpoint, this.workspaces);
  }
  private async restoreCheckpoint(state: WorkState, actor: WorkActor, checkpoint: WorkspaceCheckpoint, target: WorkspaceStore) {
    const workId = state.id;
    this.permitted(state, checkpoint.artifact, checkpoint.lifecycleGeneration); this.sources(state, checkpoint.sourceEvidenceIds);
    if (!visibleArtifact(state, checkpoint.artifact)) throw new WorkspaceError('workspace_permission_denied');
    const bytes = await this.services.artifacts.get(checkpoint.artifact, state.policy);
    await this.fresh(state, actor, checkpoint.attemptId);
    const file = this.file(state, checkpoint.attemptId, checkpoint.path, await target.stage(workId, checkpoint.attemptId, checkpoint.path, bytes, {
      tenantId: checkpoint.artifact.tenantId, labels: checkpoint.artifact.labels, lifecycleGeneration: checkpoint.lifecycleGeneration,
    }));
    if (file.sha256 !== checkpoint.artifact.sha256 || file.byteLength !== checkpoint.artifact.byteLength) throw new WorkspaceError('workspace_file_integrity_failure');
    await this.fresh(state, actor, checkpoint.attemptId); return file;
  }
  /** Host recovery only: committed checkpoint originals go to an explicitly supplied store, without touching the source workspace. */
  async restoreInto(workId: string, actor: WorkActor, checkpointIds: readonly string[], target: WorkspaceStore): Promise<RestoredWorkspaceCheckpoint[]> {
    if (!Array.isArray(checkpointIds) || checkpointIds.length < 1 || checkpointIds.length > 128 ||
      checkpointIds.some(id => typeof id !== 'string' || !id || id.length > 256)) throw new WorkspaceError('workspace_recovery_selection_invalid');
    const ids = [...new Set(checkpointIds)].sort(), state = await this.authorized(workId, actor);
    const selected: { checkpoint: WorkspaceCheckpoint; file: WorkspaceFile; receiptDigest: string }[] = [];
    const paths = new Map<string, WorkspaceFile>(); let total = 0;
    for (const id of ids) {
      const value = state.workspaceCheckpoints?.find(item => item.id === id);
      if (!value) throw new WorkspaceError('workspace_checkpoint_unavailable');
      const checkpoint = parseContract(WorkspaceCheckpointSchema, value);
      if (checkpoint.workId !== workId || !state.attempts.some(attempt => attempt.id === checkpoint.attemptId)) throw new WorkspaceError('workspace_attempt_unavailable');
      this.permitted(state, checkpoint.artifact, checkpoint.lifecycleGeneration); this.sources(state, checkpoint.sourceEvidenceIds);
      if (!visibleArtifact(state, checkpoint.artifact)) throw new WorkspaceError('workspace_permission_denied');
      const basis = { workId, attemptId: checkpoint.attemptId, path: checkpoint.path, artifact: checkpoint.artifact,
        sourceEvidenceIds: checkpoint.sourceEvidenceIds, lifecycleGeneration: checkpoint.lifecycleGeneration };
      const receiptDigest = this.services.digester.digest(asJson(basis));
      const receipt = await this.services.state.receipt(workId, id);
      if (id !== `checkpoint-${receiptDigest}` || !receipt || receipt.digest !== receiptDigest || receipt.state.id !== workId ||
        receipt.state.revision > state.revision || receipt.state.policy.tenantId !== state.policy.tenantId ||
        receipt.state.policy.principalId !== state.policy.principalId || !receipt.state.workspaceCheckpoints?.some(saved =>
          this.services.digester.digest(asJson(saved)) === this.services.digester.digest(asJson(checkpoint))))
        throw new WorkspaceError('workspace_checkpoint_receipt_invalid');
      const file = this.file(state, checkpoint.attemptId, checkpoint.path, {
        workId, attemptId: checkpoint.attemptId, path: checkpoint.path, tenantId: checkpoint.artifact.tenantId,
        labels: [...checkpoint.artifact.labels].sort(), lifecycleGeneration: checkpoint.lifecycleGeneration,
        sha256: checkpoint.artifact.sha256, byteLength: checkpoint.artifact.byteLength,
      });
      if (file.byteLength > 1048576) throw new WorkspaceError('workspace_file_too_large');
      const key = JSON.stringify([file.attemptId, file.path]), previous = paths.get(key);
      if (previous && this.services.digester.digest(asJson(previous)) !== this.services.digester.digest(asJson(file))) throw new WorkspaceError('workspace_file_conflict');
      if (!previous) { paths.set(key, file); total += file.byteLength; }
      if (total > 16777216) throw new WorkspaceError('workspace_capacity_exceeded');
      await this.fresh(state, actor, checkpoint.attemptId); selected.push({ checkpoint, file, receiptDigest });
    }
    const restored: RestoredWorkspaceCheckpoint[] = [];
    for (const item of selected) {
      const file = await this.restoreCheckpoint(state, actor, item.checkpoint, target);
      if (this.services.digester.digest(asJson(file)) !== this.services.digester.digest(asJson(item.file))) throw new WorkspaceError('workspace_file_identity_mismatch');
      restored.push({ checkpoint: structuredClone(item.checkpoint), file: structuredClone(file), receiptDigest: item.receiptDigest });
    }
    return restored;
  }
  async cleanup(workId: string, actor: WorkActor, attemptId: string) {
    const state = await this.state(workId, actor, attemptId); const attempt = state.attempts.find(value => value.id === attemptId)!;
    if (['reserved', 'running', 'received'].includes(attempt.status) || attempt.leaseUntil > this.services.clock.now() && attempt.finishedAt === null) throw new WorkspaceError('workspace_attempt_active');
    if (state.attempts.some(value => value.status === 'unknown' || value.effectState === 'unknown') ||
      state.obligations.some(obligation => obligation.kind === 'effect_reconciliation' && obligation.status === 'pending') ||
      (await this.services.state.deliveries(workId)).some(value => value.status === 'sending' || value.status === 'unknown')) throw new WorkspaceError('workspace_unknown_obligation');
    const files = await this.workspaces.list(workId, attemptId);
    for (const file of files) {
      this.file(state, attemptId, file.path, file);
      const checkpoint = state.workspaceCheckpoints?.find(value => value.attemptId === attemptId && value.path === file.path &&
        value.artifact.sha256 === file.sha256 && value.artifact.byteLength === file.byteLength && value.lifecycleGeneration === file.lifecycleGeneration);
      if (!checkpoint) throw new WorkspaceError('workspace_uncheckpointed_file');
      this.permitted(state, checkpoint.artifact, checkpoint.lifecycleGeneration); this.sources(state, checkpoint.sourceEvidenceIds);
      if (!visibleArtifact(state, checkpoint.artifact)) throw new WorkspaceError('workspace_permission_denied');
      if (!(await this.services.artifacts.exists(checkpoint.artifact))) throw new WorkspaceError('workspace_checkpoint_unavailable');
    }
    await this.fresh(state, actor, attemptId); await this.workspaces.removeAttempt(workId, attemptId, files);
    await this.fresh(state, actor, attemptId); return { removed: files.length };
  }
}
