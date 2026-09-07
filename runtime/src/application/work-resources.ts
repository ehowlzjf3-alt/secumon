import { z } from 'zod';
import { accessibleEvidence } from '../domain/completion.js';
import { artifactBlocked } from '../domain/data-lifecycle.js';
import type { ArtifactRef, Attempt, Json, Policy, TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import type { ArtifactStore, Digester, StateRepository, ToolDefinition } from './ports.js';
import { parseContract, ToolResultSchema } from './contracts.js';
import { asJson, taskDigest } from './plan-validator.js';
import { ReadLimitSchema, WorkActorSchema } from './resource-contracts.js';
import { toolAllowed, type ToolContracts } from './tool-contracts.js';
import type { EffectProofValidator, KnowledgeValidator, WorkInputValidator } from './services.js';
import { knowledgeInputsCurrent, uniqueKnowledgeDependencies } from './knowledge-validity.js';
import { uniqueInputDependencies } from './input-validity.js';
import { effectProofsCurrent } from './effect-proofs.js';
import type { GuidanceCatalog, GuidanceManifest } from './guidance.js';
import { ReadCheckpoints } from './read-checkpoints.js';

export type WorkActor = { tenantId: string; principalId: string } & Partial<Pick<Policy, 'allowedLabels' | 'allowedTools' | 'allowedDestinations' | 'allowWrites'>>;
export interface ToolContractPin { id: string; version: string; digest: string }
export interface ResultMaterialization {
  result: ToolResult;
  task: TaskSpec;
  dispatchRevision: number;
  sourceTasks: { attemptId: string; task: TaskSpec }[];
  verifiedArtifacts: ArtifactRef[];
  reads: { artifacts: number; receipts: number; parses: number };
}
export function bounded(value: Json, maxBytes: number, reference: Json) {
  const limit = parseContract(ReadLimitSchema, maxBytes); const byteLength = new TextEncoder().encode(JSON.stringify(value)).length;
  return byteLength > limit ? { status: 'too_large' as const, byteLength, reference } : { status: 'available' as const, byteLength, value };
}
export async function authorizedWork(store: StateRepository, workId: string, actor: WorkActor): Promise<WorkState> {
  parseContract(WorkActorSchema, { tenantId: actor.tenantId, principalId: actor.principalId });
  const state = await store.get(workId);
  if (!state || state.policy.tenantId !== actor.tenantId || state.policy.principalId !== actor.principalId) throw new Error('work_unavailable');
  state.policy.allowedLabels = state.policy.allowedLabels.filter(l => actor.allowedLabels === undefined || actor.allowedLabels.includes(l));
  state.policy.allowedTools = state.policy.allowedTools.filter(t => actor.allowedTools === undefined || actor.allowedTools.includes(t));
  state.policy.allowedDestinations = state.policy.allowedDestinations.filter(d => actor.allowedDestinations === undefined || actor.allowedDestinations.includes(d));
  state.policy.allowWrites = state.policy.allowWrites && actor.allowWrites !== false;
  return state;
}
function artifactAllowed(ref: { tenantId: string; labels: string[] }, policy: Policy) {
  return ref.tenantId === policy.tenantId && ref.labels.every(l => policy.allowedLabels.includes(l));
}
const CallsQuerySchema = z.strictObject({ toolId: z.string().min(1).max(256), toolVersion: z.string().min(1).max(256),
  inputDigest: z.string().regex(/^[0-9a-f]{64}$/).nullable(), limit: z.number().int().min(1).max(20) });
const EvidenceFindQuerySchema = z.strictObject({ query: z.string().max(128), limit: z.number().int().min(1).max(20) });

export class WorkResources {
  constructor(readonly store: StateRepository, readonly artifacts: ArtifactStore, readonly tools: ToolContracts, readonly digester: Digester,
    readonly knowledge?: KnowledgeValidator, readonly guidance?: GuidanceCatalog, readonly effects?: Pick<EffectProofValidator, 'current'>, readonly inputs?: WorkInputValidator) {}
  private async fresh(workId: string, actor: WorkActor, revision: number) {
    const state = await authorizedWork(this.store, workId, actor);
    const raw = await this.store.get(workId);
    if (state.revision !== revision || !raw || raw.revision !== revision ||
      !(await knowledgeInputsCurrent({ knowledge: this.knowledge, inputs: this.inputs }, state)) ||
      !(await effectProofsCurrent({ effects: this.effects }, raw))) throw new Error('resource_state_changed');
    const latest = await authorizedWork(this.store, workId, actor);
    if (latest.revision !== revision) throw new Error('resource_state_changed');
    return latest;
  }
  async findEvidence(workId: string, actor: WorkActor, input: { query: string; limit: number }) {
    const query = parseContract(EvidenceFindQuerySchema, input); const state = await authorizedWork(this.store, workId, actor);
    const fingerprint = (value: WorkState) => this.digester.digest(asJson({ revision: value.revision, policy: value.policy, goal: value.goal }));
    const expected = fingerprint(state);
    if (fingerprint(await this.fresh(workId, actor, state.revision)) !== expected) throw new Error('resource_state_changed');
    const text = query.query.normalize('NFC').toLocaleLowerCase('en-US');
    const matched = accessibleEvidence(state.evidence, state.policy, state.goal.scope).filter(e =>
      `${e.id}\n${e.sourceId}\n${e.locator}\n${JSON.stringify(e.facts)}`.normalize('NFC').toLocaleLowerCase('en-US').includes(text))
      .sort((a, b) => b.observedAt - a.observedAt || a.id.localeCompare(b.id, 'en'));
    let truncated = false;
    const cards = matched.slice(0, query.limit).map(e => {
      const locator = Array.from(e.locator); const shortened = locator.length > 256; truncated ||= shortened;
      return { id: e.id, sourceId: e.sourceId, locator: shortened ? `${locator.slice(0, 255).join('')}…` : e.locator,
        observedAt: e.observedAt, coverage: e.coverage };
    });
    if (fingerprint(await this.fresh(workId, actor, state.revision)) !== expected) throw new Error('resource_state_changed');
    return { cards, hasMore: matched.length > query.limit, truncated, stateRevision: state.revision };
  }
  async evidence(workId: string, actor: WorkActor, evidenceId: string, maxBytes: number) {
    const state = await authorizedWork(this.store, workId, actor);
    const evidence = accessibleEvidence(state.evidence, state.policy, state.goal.scope).find(e => e.id === evidenceId);
    if (!evidence || (evidence.artifact && !artifactBlocked(state, evidence.artifact) && (!artifactAllowed(evidence.artifact, state.policy) || !(await this.artifacts.exists(evidence.artifact))))) throw new Error('evidence_unavailable');
    await this.fresh(workId, actor, state.revision);
    const view = evidence.artifact && artifactBlocked(state, evidence.artifact) ? { ...evidence, artifact: null } : evidence;
    return bounded(asJson({ evidence: view, view: 'current_accepted_evidence', stateRevision: state.revision }), maxBytes, { kind: 'evidence', workId, evidenceId });
  }
  async original(workId: string, actor: WorkActor, evidenceId: string, maxBytes: number) {
    const state = await authorizedWork(this.store, workId, actor); const limit = parseContract(ReadLimitSchema, maxBytes);
    const evidence = accessibleEvidence(state.evidence, state.policy, state.goal.scope).find(e => e.id === evidenceId);
    if (!evidence?.artifact || artifactBlocked(state, evidence.artifact) || !artifactAllowed(evidence.artifact, state.policy)) throw new Error('evidence_unavailable');
    const ref = structuredClone(evidence.artifact);
    if (!['text/plain', 'text/markdown', 'application/json'].includes(ref.mediaType)) {
      if (!(await this.artifacts.exists(ref))) throw new Error('evidence_unavailable');
      await this.fresh(workId, actor, state.revision);
      return { status: 'reference_only', artifact: ref, locator: evidence.locator };
    }
    let bytes: Uint8Array;
    try { bytes = await this.artifacts.get(structuredClone(ref), state.policy); } catch { throw new Error('evidence_unavailable'); }
    if (bytes.byteLength !== ref.byteLength) throw new Error('evidence_unavailable');
    await this.fresh(workId, actor, state.revision);
    if (bytes.byteLength > limit) return { status: 'too_large', byteLength: bytes.byteLength, artifact: ref, locator: evidence.locator };
    let content: string; try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('artifact_not_utf8'); }
    return { status: 'available', byteLength: bytes.byteLength, content, artifact: ref, locator: evidence.locator, observedAt: evidence.observedAt };
  }
  async calls(workId: string, actor: WorkActor, input: z.infer<typeof CallsQuerySchema>) {
    const query = parseContract(CallsQuerySchema, input); const state = await authorizedWork(this.store, workId, actor);
    const definition = this.tools.get(query.toolId, query.toolVersion)?.tool.definition;
    if (!definition || !toolAllowed(definition, state.policy)) throw new Error('tool_unavailable');
    const attempts = state.attempts.filter(a => a.toolId === query.toolId && a.toolVersion === query.toolVersion && a.scope === state.goal.scope &&
      (query.inputDigest === null || a.inputDigest === query.inputDigest) && (!a.resultArtifact || (!artifactBlocked(state, a.resultArtifact) && artifactAllowed(a.resultArtifact, state.policy))))
      .sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id, 'en'));
    const cards = attempts.slice(0, query.limit).map(a => ({ attemptId: a.id, taskId: a.taskId, toolId: a.toolId, toolVersion: a.toolVersion,
      goalRevision: a.goalRevision, status: a.status, effect: a.effect, effectState: a.effectState, adoptedThen: a.adopted,
      startedAt: a.startedAt, finishedAt: a.finishedAt, hasStoredResult: a.resultArtifact !== null, error: a.error, view: 'invocation_history' }));
    await this.fresh(workId, actor, state.revision);
    return { cards, hasMore: attempts.length > query.limit, stateRevision: state.revision };
  }
  async result(workId: string, actor: WorkActor, attemptId: string, maxBytes: number) {
    return (await this.resultWithDependencies(workId, actor, attemptId, maxBytes)).output;
  }
  /** Internal transport envelope; callers expose only output to people and models. */
  async resultWithDependencies(workId: string, actor: WorkActor, attemptId: string, maxBytes: number) {
    parseContract(ReadLimitSchema, maxBytes);
    const state = await authorizedWork(this.store, workId, actor);
    const digest = (value: unknown) => this.digester.digest(asJson(value ?? null));
    const toolContracts = new Map<string, ToolContractPin>(); const guidanceContracts = new Map<string, ToolContractPin>();
    const guidanceSources = new Map<string, GuidanceManifest>();
    const pin = (pins: Map<string, ToolContractPin>, id: string, version: string, value: unknown) => {
      const key = JSON.stringify([id, version]); const current = digest(value); const previous = pins.get(key);
      if (previous && previous.digest !== current) throw new Error('invocation_unavailable');
      pins.set(key, { id, version, digest: current });
    };
    const pinTool = (definition: ToolDefinition) => pin(toolContracts, definition.id, definition.version, definition);
    const contractsCurrent = () => {
      for (const value of toolContracts.values()) {
        const definition = this.tools.get(value.id, value.version)?.tool.definition;
        if (!definition || !toolAllowed(definition, state.policy) || digest(definition) !== value.digest) throw new Error('invocation_unavailable');
      }
      for (const value of guidanceContracts.values()) {
        let manifest;
        try { manifest = this.guidance?.describe(state, value.id, value.version); } catch { throw new Error('invocation_unavailable'); }
        if (!manifest || digest(manifest) !== value.digest) throw new Error('invocation_unavailable');
      }
    };
    const fingerprint = (value: WorkState) => digest({ revision: value.revision, policy: value.policy, goal: value.goal });
    const expected = fingerprint(state);
    const current = async () => {
      if (fingerprint(await this.fresh(workId, actor, state.revision)) !== expected) throw new Error('resource_state_changed');
    };
    await current();
    const object = (value: Json | undefined): Record<string, Json> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
    const originals = new Map<string, { ref: ArtifactRef; bytes: Uint8Array }>();
    const verified = new Map<string, ArtifactRef>(); const reused = new Map<string, ArtifactRef>(); let cachedBytes = 0;
    const reads = { artifacts: 0, receipts: 0, parses: 0 };
    const read = async (value: ArtifactRef, refresh = false) => {
      const ref = structuredClone(value);
      if (artifactBlocked(state, ref) || !artifactAllowed(ref, state.policy)) throw new Error('invocation_unavailable');
      const previous = originals.get(ref.id);
      if (previous && !refresh) { if (digest(previous.ref) !== digest(ref)) throw new Error('invocation_unavailable'); reused.set(ref.id, ref); return previous.bytes; }
      if (verified.has(ref.id) && digest(verified.get(ref.id)) !== digest(ref)) throw new Error('invocation_unavailable');
      if (!verified.has(ref.id) && verified.size >= 10000) throw new Error('invocation_unavailable');
      // ArtifactStore.get verifies the stored reference, byte count and content hash.
      let bytes: Uint8Array;
      try { reads.artifacts++; bytes = await this.artifacts.get(structuredClone(ref), state.policy); } catch { throw new Error('invocation_unavailable'); }
      if (bytes.byteLength !== ref.byteLength) throw new Error('invocation_unavailable');
      verified.set(ref.id, structuredClone(ref));
      const previousBytes = previous?.bytes.byteLength ?? 0;
      if (cachedBytes - previousBytes + bytes.byteLength <= 16 * 1024 * 1024) {
        originals.set(ref.id, { ref: structuredClone(ref), bytes }); cachedBytes += bytes.byteLength - previousBytes;
      }
      return bytes;
    };
    const chain: { attempt: Attempt; task: TaskSpec; result: ToolResult; dispatchRevision: number }[] = [];
    const collections = new ReadCheckpoints({ state: this.store, artifacts: this.artifacts, digester: this.digester, knowledge: this.knowledge, inputs: this.inputs }, this.tools);
    const visited = new Set<string>(); let id: string | null = attemptId;
    while (id !== null) {
      if (visited.has(id) || visited.size >= 64) throw new Error('invocation_unavailable');
      visited.add(id);
      const attempt = state.attempts.find(a => a.id === id && a.scope === state.goal.scope);
      const definition = attempt && this.tools.get(attempt.toolId, attempt.toolVersion)?.tool.definition;
      if (!attempt?.resultArtifact || !definition || !toolAllowed(definition, state.policy)) throw new Error('invocation_unavailable');
      if (attempt.contractDigest && attempt.contractDigest !== digest(definition)) throw new Error('invocation_unavailable');
      pinTool(definition);
      const receipt = await this.store.receipt(workId, `dispatch:${attempt.id}`); reads.receipts++;
      const task = receipt?.state.plan?.tasks.find(t => t.id === attempt.taskId);
      const dispatched = receipt?.state.attempts.find(value => value.id === attempt.id);
      if (!receipt || receipt.state.id !== workId || receipt.state.policy.tenantId !== state.policy.tenantId ||
        receipt.state.policy.principalId !== state.policy.principalId || receipt.state.goal.scope !== attempt.scope ||
        receipt.state.goal.revision !== attempt.goalRevision || receipt.state.plan?.revision !== attempt.planRevision ||
        !task || task.toolId !== attempt.toolId || task.toolVersion !== attempt.toolVersion || task.effect !== attempt.effect ||
        !dispatched || dispatched.status !== 'running' || dispatched.taskId !== attempt.taskId || dispatched.inputDigest !== attempt.inputDigest ||
        taskDigest(task, this.digester) !== attempt.inputDigest) throw new Error('invocation_unavailable');
      let result: ToolResult;
      try {
        if (attempt.resultArtifact.byteLength > 16 * 1024 * 1024) throw new Error('invocation_unavailable');
        const bytes = await read(attempt.resultArtifact); reads.parses++; result = parseContract(ToolResultSchema, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      }
      catch { throw new Error('invocation_unavailable'); }
      if (result.resultId !== attempt.resultId || result.attemptId !== attempt.id) throw new Error('invocation_identity_mismatch');
      if (digest(result.reuse) !== digest(attempt.reuse)) throw new Error('invocation_identity_mismatch');
      if ((definition.collection || attempt.readProgress || result.collection) && !(await collections.validateResult(state, result))) throw new Error('invocation_unavailable');
      if (!(await this.tools.validateResult(state, result))) throw new Error('invocation_unavailable');
      for (const ref of [...result.artifacts, ...result.evidence.flatMap(e => e.artifact ? [e.artifact] : [])]) await read(ref);
      const output = object(result.output);
      if (attempt.toolId === 'core.catalog.get') {
        const targetId = task.input['id']; const targetVersion = task.input['version'];
        const target = typeof targetId === 'string' && typeof targetVersion === 'string' ? this.tools.get(targetId, targetVersion)?.tool.definition : undefined;
        if (!target || !toolAllowed(target, state.policy)) throw new Error('invocation_unavailable');
        pinTool(target);
        if (output) {
          const card = object(output['card']);
          if (!card || card['id'] !== target.id || card['version'] !== target.version || card['contractDigest'] !== digest(target) ||
            (output['status'] === 'available' && digest(output['definition']) !== digest(target))) throw new Error('invocation_unavailable');
        }
      }
      if (attempt.toolId === 'core.guidance.load') {
        const targetId = task.input['id']; const version = task.input['version'];
        if (!this.guidance || typeof targetId !== 'string' || typeof version !== 'string') throw new Error('invocation_unavailable');
        let manifest;
        try { manifest = this.guidance.describe(state, targetId, version); } catch { throw new Error('invocation_unavailable'); }
        if (!manifest.supportedKinds.includes(task.input['kind'] as never)) throw new Error('invocation_unavailable');
        pin(guidanceContracts, targetId, version, manifest);
        guidanceSources.set(JSON.stringify([targetId, version]), manifest);
        if (output?.['status'] === 'available') {
          const ref = result.artifacts.find(a => a.sha256 === manifest.sha256 && a.byteLength === manifest.byteLength);
          if (!ref || digest(output['manifest']) !== digest(manifest) || digest(output['artifact']) !== digest(ref) ||
            output['body'] !== new TextDecoder('utf-8', { fatal: true }).decode(await read(ref, true))) throw new Error('invocation_unavailable');
        } else if (output && (output['status'] !== 'too_large' || output['id'] !== targetId || output['version'] !== version || output['byteLength'] !== manifest.byteLength)) {
          throw new Error('invocation_unavailable');
        }
      }
      chain.push({ attempt, task, result, dispatchRevision: receipt.state.revision });
      if (result.reuse) {
        if (attempt.toolId === 'core.calls.get' || attempt.execution?.mode !== 'reused' || attempt.execution.implementationCalls !== 0) throw new Error('invocation_unavailable');
        id = result.reuse.attemptId;
      } else if (attempt.toolId === 'core.calls.get') {
        const source = task.input['attemptId'];
        if (typeof source !== 'string' || !source) throw new Error('invocation_unavailable');
        id = source;
      } else id = null;
    }
    for (let index = 0; index < chain.length - 1; index++) {
      const target = chain[index]!; const copied = object(target.result.output); const source = chain[index + 1]!;
      if (target.result.reuse) {
        const stamp = target.result.reuse;
        const { attemptId: _consumerId, resultId: _consumerResultId, reuse: _stamp, knowledgeDependencies: _consumerDeps, inputDependencies: _consumerDepsInputs, ...body } = target.result;
        const { attemptId: _sourceId, resultId: _sourceResultId, knowledgeDependencies: _sourceDeps, inputDependencies: _sourceDepsInputs, ...sourceBody } = source.result;
        if (source.result.reuse || source.attempt.execution?.mode !== 'invoked' || source.attempt.execution.implementationCalls !== 1 ||
          source.attempt.toolId !== target.attempt.toolId || source.attempt.toolVersion !== target.attempt.toolVersion ||
          source.attempt.contractDigest !== target.attempt.contractDigest || source.attempt.goalRevision !== target.attempt.goalRevision ||
          digest(source.task.input) !== digest(target.task.input) || stamp.attemptId !== source.attempt.id || stamp.resultId !== source.result.resultId ||
          stamp.observedAt !== source.attempt.startedAt || digest(stamp.resultArtifact) !== digest(source.attempt.resultArtifact) || digest(body) !== digest(sourceBody)) throw new Error('invocation_unavailable');
        continue;
      }
      if (copied?.['status'] === 'available') {
        const value = object(copied['value']); const { knowledgeDependencies: _dependencies, inputDependencies: _dependenciesInputs, ...publicSource } = source.result;
        if (!value || value['originalAttemptId'] !== source.attempt.id || value['view'] !== 'historical_tool_result' || value['newObservation'] !== false ||
          digest(value['result']) !== digest(publicSource)) throw new Error('invocation_unavailable');
      } else if (copied) {
        const reference = object(copied['reference']);
        if (copied['status'] !== 'too_large' || reference?.['kind'] !== 'tool_result' || reference['attemptId'] !== source.attempt.id ||
          reference['artifactId'] !== source.attempt.resultArtifact!.id) throw new Error('invocation_unavailable');
      }
    }
    const knowledgeDependencies = uniqueKnowledgeDependencies(chain.flatMap(item => item.result.knowledgeDependencies ?? []));
    const inputDependencies = uniqueInputDependencies(chain.flatMap(item => item.result.inputDependencies ?? []));
    if (inputDependencies.length > 50 || (inputDependencies.length && (!this.inputs || !(await this.inputs.validate(inputDependencies, state))))) throw new Error('invocation_unavailable');
    for (const manifest of guidanceSources.values()) {
      if (!(await this.guidance?.validateCurrent(state, this.artifacts, manifest))) throw new Error('invocation_unavailable');
    }
    for (const item of chain) if (item.result.collection && !(await collections.validateResult(state, item.result))) throw new Error('invocation_unavailable');
    for (const item of chain) if (!(await this.tools.validateResult(state, item.result))) throw new Error('invocation_unavailable');
    if (knowledgeDependencies.length > 50 || (knowledgeDependencies.length && (!this.knowledge || !(await this.knowledge.validate(knowledgeDependencies, workId, state.policy))))) throw new Error('invocation_unavailable');
    await current();
    for (const ref of reused.values()) if (!(await this.artifacts.exists(structuredClone(ref)))) throw new Error('invocation_unavailable');
    if (reused.size) await current();
    // Registry changes are independent of WorkState revisions. No asynchronous work may follow this guard.
    contractsCurrent();
    const { attempt, result, task, dispatchRevision } = chain[0]!;
    const allowed = new Map(accessibleEvidence(state.evidence, state.policy, state.goal.scope).map(e => [e.id, e]));
    const evidenceCurrent = result.evidence.length > 0 && result.evidence.every(e => allowed.has(e.id) && this.digester.digest(asJson(allowed.get(e.id))) === this.digester.digest(asJson(e)));
    const { knowledgeDependencies: _dependencies, inputDependencies: _dependenciesInputs, ...publicResult } = result;
    return { output: bounded(asJson({ result: publicResult, originalAttemptId: attempt.id, goalRevision: attempt.goalRevision, adoptedThen: attempt.adopted,
      evidenceCurrent, view: 'historical_tool_result', newObservation: false }), maxBytes, { kind: 'tool_result', attemptId, artifactId: attempt.resultArtifact!.id }),
      knowledgeDependencies, inputDependencies, toolContracts: [...toolContracts.values()],
      materialized: structuredClone({ result, task, dispatchRevision,
        sourceTasks: chain.map(item => ({ attemptId: item.attempt.id, task: item.task })),
        verifiedArtifacts: [...verified.values()], reads } satisfies ResultMaterialization) };
  }
}
