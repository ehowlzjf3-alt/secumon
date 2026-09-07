import { visibleComputerProgress } from '../domain/computer-use.js';
import type { ArtifactRef, Delivery, WorkState } from '../domain/model.js';
import { artifactBlocked, dataGeneration } from '../domain/data-lifecycle.js';
import { historicalEvidence } from '../domain/completion.js';
import { knowledgeInputsCurrent } from './knowledge-state.js';
import type { ResumePacket } from '../domain/recovery.js';
import { ArtifactSchema, parseContract } from './contracts.js';
import { buildContextPacket, computerContinuationContext, computerContinuationOriginalRefs,
  computerReconciliationContext, computerReconciliationRefs, verifyComputerContextHead } from './context-packet.js';
import { asJson } from './plan-validator.js';
import { ResumePacketSchema } from './recovery-contracts.js';
import type { RuntimeServices } from './services.js';
import type { ToolContracts } from './tool-contracts.js';
import { authorizedWork, type WorkActor } from './work-resources.js';
import { readCollectionContext, visibleReadProgress } from '../domain/context.js';
import { ReadCheckpoints } from './read-checkpoints.js';
import { executionControl } from '../domain/execution-policy.js';
import { progressSummary } from './execution-control.js';
import { budgetSummary } from '../domain/budget-delegation.js';
import { disclosureLabels } from '../domain/disclosure.js';
import { controlProofsCurrent as effectProofsCurrent, requiresControlProofs as requiresEffectProofs } from './control-proofs.js';
import { readSessionContext, sessionContextCurrent, sessionInputsCurrent } from './session-context.js';
import { personalMemoryContextCurrent, readPersonalMemoryContext } from './personal-memory-context.js';
import { assertExecutionAuthority } from './execution-authority.js';
import { StoredToolUsages } from './stored-tool-usage.js';

export class RecoveryError extends Error {
  constructor(readonly code: string, readonly referenceIds: string[] = []) { super(code); }
}
export class ContextRecovery {
  constructor(readonly services: Pick<RuntimeServices, 'state' | 'artifacts' | 'digester' | 'clock' | 'knowledge' | 'effects' | 'obligations' | 'notifications' | 'inputs' | 'sessions' | 'personalMemories' | 'executionAuthority'>, readonly tools: ToolContracts, readonly maxBytes = 1048576) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('invalid_resume_limit');
  }
  private async refs(state: WorkState, deliveries: Delivery[]): Promise<ArtifactRef[]> {
    const visibleReconciliations = computerReconciliationContext(state);
    const lookupRefs = (records: NonNullable<WorkState['computerReconciliations']>) => records.flatMap(record =>
      [record.requestArtifact, record.responseArtifact, record.proofArtifact].filter((ref): ref is ArtifactRef => ref !== null));
    const allLookupIds = new Set(lookupRefs(state.computerReconciliations ?? []).map(ref => ref.id));
    const visibleLookupIds = new Set(lookupRefs(visibleReconciliations).map(ref => ref.id));
    let continuationOriginals: ArtifactRef[] = [];
    if (state.computerContinuations?.length) {
      try { continuationOriginals = await computerContinuationOriginalRefs(state, ref => this.services.artifacts.get(ref, state.policy)); }
      catch { throw new RecoveryError('resume_computer_continuation_unavailable'); }
    }
    const required = [...state.attempts.flatMap(attempt => attempt.effectReceipt ? [attempt.effectReceipt.artifact] : []),
      ...continuationOriginals,
      ...visibleReconciliations.flatMap(computerReconciliationRefs),
      ...state.evidence.flatMap(e => e.artifact ? [e.artifact] : []), ...state.attempts.flatMap(a => a.resultArtifact ? [a.resultArtifact] : []),
      ...state.modelCalls.flatMap(c => [c.inputArtifact, ...(c.replyArtifact ? [c.replyArtifact] : [])]), ...(state.conversation?.result ? [state.conversation.result.artifact] : []), ...deliveries.flatMap(d => d.context?.artifact ? [d.context.artifact] : []),
      ...(state.workspaceCheckpoints?.map(c => c.artifact) ?? []),
      ...state.attempts.flatMap(attempt => attempt.computerUse && visibleComputerProgress(state, attempt.computerUse) ? [attempt.computerUse.head] : []),
      ...state.attempts.flatMap(attempt => attempt.readProgress && visibleReadProgress(state, attempt.readProgress) ? [attempt.readProgress.head] : [])]
      .filter(ref => !artifactBlocked(state, ref));
    const requiredIds = new Set(required.map(ref => ref.id));
    const protectedOnly = new Set(state.artifacts.filter(ref => ref.tenantId === state.policy.tenantId &&
      !artifactBlocked(state, ref) && !requiredIds.has(ref.id) && ref.labels.some(label => !state.policy.allowedLabels.includes(label))).map(ref => ref.id));
    const excluded = new Set<string>();
    if (protectedOnly.size) {
      const usages = new StoredToolUsages(this.services, this.tools);
      for (const attempt of state.attempts) {
        if (excluded.size === protectedOnly.size) break;
        if (!usages.candidate(state, attempt.id)) continue;
        const ticket = await usages.prepare(state, attempt.id);
        if (ticket?.custodyOnly && protectedOnly.has(ticket.receipt.artifact.id)) excluded.add(ticket.receipt.artifact.id);
      }
    }
    // Only authenticated, otherwise unused raw custody is projected out. Required evidence/result references still fail closed.
    const refs = [...state.artifacts.filter(ref => (!allLookupIds.has(ref.id) || visibleLookupIds.has(ref.id)) && !excluded.has(ref.id)),
      ...required].filter(ref => !artifactBlocked(state, ref));
    const unique = new Map<string, ArtifactRef>();
    for (const ref of refs) {
      const prior = unique.get(ref.id);
      if (prior && this.services.digester.digest(asJson(prior)) !== this.services.digester.digest(asJson(ref))) throw new RecoveryError('resume_reference_conflict', [ref.id]);
      unique.set(ref.id, ref);
    }
    return [...unique.values()].sort((a, b) => a.id.localeCompare(b.id, 'en'));
  }
  private async invalidComputerHeads(state: WorkState): Promise<string[]> {
    const invalid: string[] = [];
    for (const attempt of state.attempts) {
      if (!attempt.computerUse || !visibleComputerProgress(state, attempt.computerUse)) continue;
      try { await verifyComputerContextHead(state, attempt, this.services); }
      catch { invalid.push(attempt.computerUse.head.id); }
    }
    return invalid;
  }
  private async snapshot(workId: string, actor: WorkActor) {
    for (let retry = 0; retry < 8; retry++) {
      const state = await authorizedWork(this.services.state, workId, actor);
      const original = this.services.executionAuthority ? await this.services.state.get(workId) : state;
      if (!original || original.revision !== state.revision) continue;
      assertExecutionAuthority(this.services, original);
      if (!(await sessionInputsCurrent(this.services, state))) throw new RecoveryError('resume_session_changed');
      const session = await readSessionContext(this.services, state);
      const personalMemory = await readPersonalMemoryContext(this.services, state);
      const toolDigest = this.services.digester.digest(asJson(this.tools.visible(state.policy)));
      if (!(await knowledgeInputsCurrent(this.services, state))) throw new RecoveryError('resume_knowledge_dependency_changed');
      if (requiresEffectProofs(state) && !(await effectProofsCurrent(this.services, state))) throw new RecoveryError('resume_effect_proof_changed');
      const [events, deliveries] = await Promise.all([this.services.state.events(workId, 0), this.services.state.deliveries(workId)]);
      const latest = await authorizedWork(this.services.state, workId, actor);
      if (latest.revision !== state.revision) continue;
      const stored = await this.services.state.get(workId);
      if (!stored || stored.revision !== state.revision) continue;
      if (this.services.digester.digest(asJson(stored.policy)) !== this.services.digester.digest(asJson(state.policy))) throw new RecoveryError('resume_policy_insufficient');
      const last = events.at(-1);
      if (!last || last.revision !== state.revision || events.some((e, i) => e.workId !== workId || e.sequence !== i + 1 || e.revision > state.revision || (i === 0 ? e.revision !== 1 : e.revision < events[i - 1]!.revision || e.revision > events[i - 1]!.revision + 1))) throw new RecoveryError('resume_event_history_invalid');
      let refs: ArtifactRef[];
      try { refs = await this.refs(state, deliveries); }
      catch (error) {
        if ((await this.services.state.get(workId))?.revision !== state.revision) continue;
        if (error instanceof RecoveryError) throw error;
        throw new RecoveryError('resume_custody_unavailable');
      }
      const readable = state.evidence.filter(e => (e.access ?? 'available') === 'available');
      const visibleDeliveries = deliveries.filter(d => d.context?.artifact ? !artifactBlocked(state, d.context.artifact) : !state.dataLifecycle || d.context?.sourceRevision === state.revision);
      const labels = [...new Set([...disclosureLabels(state), ...readable.flatMap(e => e.labels), ...refs.flatMap(r => r.labels), ...visibleDeliveries.flatMap(d => d.context?.labels ?? [])])].sort();
      if (labels.some(l => !state.policy.allowedLabels.includes(l)) || refs.some(r => r.tenantId !== state.policy.tenantId) || state.evidence.some(e => e.tenantId !== state.policy.tenantId)) throw new RecoveryError('resume_policy_insufficient');
      const unavailable: string[] = [];
      for (const ref of refs) if (!(await this.services.artifacts.exists(ref))) unavailable.push(ref.id);
      const invalidCollections: string[] = []; const checkpoints = new ReadCheckpoints(this.services, this.tools);
      for (const collection of readCollectionContext(state)) {
        try { await checkpoints.read(state, collection.attemptId, collection.progress.head); }
        catch { invalidCollections.push(collection.progress.head.id); }
      }
      const invalidComputerHeads = await this.invalidComputerHeads(state);
      if ((await authorizedWork(this.services.state, workId, actor)).revision !== state.revision) continue;
      if (this.services.digester.digest(asJson(this.tools.visible(state.policy))) !== toolDigest) continue;
      if (unavailable.length) throw new RecoveryError('resume_original_unavailable', unavailable);
      if (invalidCollections.length) throw new RecoveryError('resume_read_collection_unavailable', invalidCollections);
      if (invalidComputerHeads.length) throw new RecoveryError('resume_computer_checkpoint_unavailable', invalidComputerHeads);
      const packet: ResumePacket = { schemaVersion: 1, kind: 'runtime_resume', builderRevision: '1', workId, stateRevision: state.revision, eventCursor: last.sequence,
        stateDigest: this.services.digester.digest(asJson({ state, deliveries })), toolDigest,
        context: { ...buildContextPacket(state, this.tools), ...(session ? { session } : {}), ...(personalMemory ? { personalMemory } : {}) },
        runtime: { ...(state.subscriptions ? { subscriptions: state.subscriptions } : {}), status: state.status, statusReason: state.statusReason, budget: state.budget, deadlineAt: state.deadlineAt,
          executionControl: executionControl(state), ...(state.progress ? { progress: progressSummary(state) } : {}),
          ...(state.budgetParent || state.budgetGrants?.length ? { delegation: budgetSummary(state) } : {}),
          ...(state.retryWakeAt === undefined ? {} : { retryWakeAt: state.retryWakeAt }),
          ...(state.computerReconciliations === undefined ? {} : { computerReconciliations: computerReconciliationContext(state) }),
          ...(state.computerContinuations === undefined ? {} : { computerContinuations: computerContinuationContext(state) }),
          attempts: state.attempts.map(({ knowledgeDependencies: _dependencies, inputDependencies: _dependenciesInputs, readProgress, computerUse, ...a }) => ({ ...a,
            ...(readProgress && visibleReadProgress(state, readProgress) ? { readProgress } : {}),
            ...(computerUse && visibleComputerProgress(state, computerUse) ? { computerUse } : {}),
            resultArtifact: a.resultArtifact && artifactBlocked(state, a.resultArtifact) ? null : a.resultArtifact })),
          modelCalls: state.modelCalls.map(c => ({ ...c, inputArtifact: artifactBlocked(state, c.inputArtifact) ? null : c.inputArtifact,
            replyArtifact: c.replyArtifact && artifactBlocked(state, c.replyArtifact) ? null : c.replyArtifact })),
          hypothesisAssessment: state.hypothesisAssessment, artifacts: refs, conversation: state.conversation,
          ...(state.dataLifecycle ? { dataLifecycle: state.dataLifecycle } : {}),
          ...(state.workspaceCheckpoints ? { workspaceCheckpoints: state.workspaceCheckpoints.filter(c => c.lifecycleGeneration === dataGeneration(state) && !artifactBlocked(state, c.artifact)) } : {}) },
        evidenceIndex: historicalEvidence(state.evidence, state.policy, state.goal.scope).map(({ facts: _facts, ...metadata }) =>
          metadata.artifact && artifactBlocked(state, metadata.artifact) ? { ...metadata, artifact: null } : metadata),
        deliveries: deliveries.map(({ text: _text, ...metadata }) => metadata.context && state.dataLifecycle ?
          { ...metadata, context: { ...metadata.context, labels: [], evidenceIds: [], artifact: null } } : metadata).sort((a, b) => a.id.localeCompare(b.id, 'en')) };
      const valid = parseContract(ResumePacketSchema, packet);
      if (!(await sessionContextCurrent(this.services, state, valid.context.session))) throw new RecoveryError('resume_session_changed');
      if (!(await personalMemoryContextCurrent(this.services, state, valid.context.personalMemory))) throw new RecoveryError('resume_knowledge_dependency_changed');
      if (!(await knowledgeInputsCurrent(this.services, state))) throw new RecoveryError('resume_knowledge_dependency_changed');
      if (requiresEffectProofs(state) && !(await effectProofsCurrent(this.services, state))) throw new RecoveryError('resume_effect_proof_changed');
      if (this.services.digester.digest(asJson(this.tools.visible(state.policy))) !== toolDigest) continue;
      const bytes = new TextEncoder().encode(JSON.stringify(valid));
      if (bytes.byteLength > this.maxBytes) throw new RecoveryError('resume_packet_too_large');
      const final = this.services.executionAuthority ? await this.services.state.get(workId) : state;
      if (!final || final.revision !== state.revision) continue;
      assertExecutionAuthority(this.services, final);
      return { state, packet: valid, bytes, labels };
    }
    throw new RecoveryError('resume_snapshot_contention');
  }
  async restore(workId: string, actor: WorkActor, previous?: ArtifactRef) {
    for (let retry = 0; retry < 8; retry++) {
      const fresh = await this.snapshot(workId, actor);
      let disposition: 'created' | 'reused' | 'regenerated' = previous ? 'regenerated' : 'created';
      let artifact: ArtifactRef | null = null;
      if (previous) {
        const parsed = ArtifactSchema.safeParse(previous);
        if (parsed.success && parsed.data.byteLength <= this.maxBytes && parsed.data.tenantId === fresh.state.policy.tenantId && parsed.data.labels.every(l => fresh.state.policy.allowedLabels.includes(l)) && parsed.data.mediaType === 'application/json') {
          try {
            const bytes = await this.services.artifacts.get(parsed.data, fresh.state.policy);
            if (bytes.byteLength <= this.maxBytes) {
              const prior = parseContract(ResumePacketSchema, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
              if (this.services.digester.digest(asJson(prior)) === this.services.digester.digest(asJson(fresh.packet)) && fresh.labels.every(l => parsed.data.labels.includes(l))) { artifact = parsed.data; disposition = 'reused'; }
            }
          } catch { /* A derived packet can be reconstructed from the authoritative snapshot. */ }
        }
      }
      const beforeWrite = this.services.executionAuthority ? await this.services.state.get(workId) : fresh.state;
      if (!beforeWrite || beforeWrite.revision !== fresh.state.revision) continue;
      assertExecutionAuthority(this.services, beforeWrite);
      if (!artifact) artifact = await this.services.artifacts.put(fresh.bytes, { tenantId: fresh.state.policy.tenantId, labels: fresh.labels, mediaType: 'application/json' });
      if (!(await sessionContextCurrent(this.services, fresh.state, fresh.packet.context.session))) throw new RecoveryError('resume_session_changed');
      if (!(await personalMemoryContextCurrent(this.services, fresh.state, fresh.packet.context.personalMemory))) throw new RecoveryError('resume_knowledge_dependency_changed');
      if (!(await knowledgeInputsCurrent(this.services, fresh.state))) throw new RecoveryError('resume_knowledge_dependency_changed');
      if (requiresEffectProofs(fresh.state) && !(await effectProofsCurrent(this.services, fresh.state))) throw new RecoveryError('resume_effect_proof_changed');
      if ((await authorizedWork(this.services.state, workId, actor)).revision !== fresh.state.revision) continue;
      const invalidCollections: string[] = []; const checkpoints = new ReadCheckpoints(this.services, this.tools);
      for (const collection of readCollectionContext(fresh.state)) {
        try { await checkpoints.read(fresh.state, collection.attemptId, collection.progress.head); }
        catch { invalidCollections.push(collection.progress.head.id); }
      }
      const invalidComputerHeads = await this.invalidComputerHeads(fresh.state);
      if (!(await knowledgeInputsCurrent(this.services, fresh.state))) throw new RecoveryError('resume_knowledge_dependency_changed');
      if (requiresEffectProofs(fresh.state) && !(await effectProofsCurrent(this.services, fresh.state))) throw new RecoveryError('resume_effect_proof_changed');
      if ((await authorizedWork(this.services.state, workId, actor)).revision !== fresh.state.revision) continue;
      if (invalidCollections.length) throw new RecoveryError('resume_read_collection_unavailable', invalidCollections);
      if (invalidComputerHeads.length) throw new RecoveryError('resume_computer_checkpoint_unavailable', invalidComputerHeads);
      if (this.services.digester.digest(asJson(this.tools.visible(fresh.state.policy))) !== fresh.packet.toolDigest) continue;
      if (!(await sessionContextCurrent(this.services, fresh.state, fresh.packet.context.session))) throw new RecoveryError('resume_session_changed');
      if (!(await personalMemoryContextCurrent(this.services, fresh.state, fresh.packet.context.personalMemory))) throw new RecoveryError('resume_knowledge_dependency_changed');
      const final = this.services.executionAuthority ? await this.services.state.get(workId) : fresh.state;
      if (!final || final.revision !== fresh.state.revision) continue;
      assertExecutionAuthority(this.services, final);
      return { packet: fresh.packet, artifact, disposition };
    }
    throw new RecoveryError('resume_snapshot_contention');
  }
}
