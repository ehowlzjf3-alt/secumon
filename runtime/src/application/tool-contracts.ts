import type { Policy, TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import { z } from 'zod';
import type { ReadDeferralProofInput, ReadPageProofInput, ReadResponseRestoreInput, ReadResponseRestoreResult, ReadUsageRestoreInput, ReadUsageRestoreResult, SchemaCompiler, StoredToolResult, StoredToolResultInput, StoredToolUsage, Tool } from './ports.js';
import { ReadKeySchema, ReadRequestSchema, ReadResponseSchema } from './read-collection-contracts.js';
import { ArtifactSchema, parseContract, TaskSchema, ToolResultSchema, ToolUsageSchema } from './contracts.js';
import { frozen, ToolDefinitionSchema } from './resource-contracts.js';

export function toolAllowed(definition: Tool['definition'], policy: Policy): boolean {
  return policy.allowedTools.includes(definition.id) && policy.allowedDestinations.includes(definition.destination) &&
    definition.labels.every(label => policy.allowedLabels.includes(label)) && (definition.effect !== 'write' || policy.allowWrites);
}

export interface RegisteredTool {
  tool: Tool;
  input: (value: unknown) => boolean;
  output: (value: unknown) => boolean;
}

export interface ProviderSnapshot {
  epoch: number;
  sourceRevision: string | null;
  toolCount: number;
}

export function validProvider(provider: string): boolean {
  return typeof provider === 'string' && /^[a-z][a-z0-9_-]{0,99}$/.test(provider);
}

/** Captures metadata and callback together; later adapter mutation cannot change this registration. */
export function snapshotTool(tool: Tool): Tool {
  const availability = tool?.availability;
  const execute = tool?.execute; const validateResult = tool?.validateResult; const validateReadPage = tool?.validateReadPage;
  const validateReadDeferral = tool?.validateReadDeferral;
  const restoreReadResponse = tool?.restoreReadResponse; const restoreResult = tool?.restoreResult; const restoreUsage = tool?.restoreUsage;
  const restoreReadUsage = tool?.restoreReadUsage; const readManifest = tool?.readManifest;
  if (availability !== undefined && availability !== 'available' && availability !== 'stored_only' ||
    typeof execute !== 'function' || validateResult !== undefined && typeof validateResult !== 'function' ||
    validateReadPage !== undefined && typeof validateReadPage !== 'function' ||
    validateReadDeferral !== undefined && typeof validateReadDeferral !== 'function' ||
    restoreReadResponse !== undefined && typeof restoreReadResponse !== 'function' ||
    restoreResult !== undefined && typeof restoreResult !== 'function' ||
    restoreUsage !== undefined && typeof restoreUsage !== 'function' ||
    restoreReadUsage !== undefined && typeof restoreReadUsage !== 'function' ||
    readManifest !== undefined && typeof readManifest !== 'function') throw new Error('invalid_tool_adapter');
  const definition = frozen(parseContract(ToolDefinitionSchema, tool.definition));
  if (definition.resultValidation && !validateResult) throw new Error('tool_result_validator_required');
  if (definition.collection?.pageValidation && !validateReadPage) throw new Error('tool_page_validator_required');
  if (definition.collection?.deferralValidation && !validateReadDeferral) throw new Error('tool_deferral_validator_required');
  if (definition.collection?.responseRecovery && !restoreReadResponse) throw new Error('tool_response_restorer_required');
  if (definition.collection?.coverage && !readManifest) throw new Error('tool_read_manifest_required');
  const boundManifest = readManifest?.bind(tool);
  return Object.freeze({ definition, ...(availability === undefined ? {} : { availability }), execute: execute.bind(tool), ...(validateResult ? { validateResult: validateResult.bind(tool) } : {}),
    ...(validateReadPage ? { validateReadPage: validateReadPage.bind(tool) } : {}),
    ...(validateReadDeferral ? { validateReadDeferral: validateReadDeferral.bind(tool) } : {}),
    ...(restoreReadResponse ? { restoreReadResponse: restoreReadResponse.bind(tool) } : {}),
    ...(restoreResult ? { restoreResult: restoreResult.bind(tool) } : {}),
    ...(restoreUsage ? { restoreUsage: restoreUsage.bind(tool) } : {}),
    ...(restoreReadUsage ? { restoreReadUsage: restoreReadUsage.bind(tool) } : {}),
    ...(boundManifest ? { readManifest: (task: TaskSpec) => z.array(ReadKeySchema).max(10000).parse(boundManifest(structuredClone(task))) } : {}) });
}

export class ToolContracts {
  #entries = new Map<string, RegisteredTool>();
  #providers = new Map<string, ProviderSnapshot>();
  #revision = 1;
  constructor(tools: Tool[], private readonly schemas: SchemaCompiler) {
    this.#entries = this.compile(tools);
    for (const { tool } of this.#entries.values()) {
      const provider = tool.definition.provider; const previous = this.#providers.get(provider);
      this.#providers.set(provider, { epoch: 1, sourceRevision: null, toolCount: (previous?.toolCount ?? 0) + 1 });
    }
  }
  private compile(tools: Tool[]): Map<string, RegisteredTool> {
    const entries = new Map<string, RegisteredTool>();
    for (const candidate of tools) {
      const tool = snapshotTool(candidate); const d = tool.definition; const key = this.key(d.id, d.version);
      if (entries.has(key)) throw new Error('duplicate_or_invalid_tool');
      entries.set(key, Object.freeze({ tool, input: this.schemas.compile(d.inputSchema), output: this.schemas.compile(d.outputSchema) }));
    }
    return entries;
  }
  get revision(): number { return this.#revision; }
  providerEpoch(provider: string): number { return this.#providers.get(provider)?.epoch ?? 0; }
  providerSnapshot(provider: string): ProviderSnapshot | null {
    const snapshot = this.#providers.get(provider); return snapshot ? { ...snapshot } : null;
  }
  /** Only complete listings may publish. Providers must change definition.version when callback behavior changes; a listing revision alone does not change a contract digest. */
  replaceProvider(provider: string, tools: Tool[], options: { expectedEpoch: number; sourceRevision: string; signal?: AbortSignal }): ProviderSnapshot {
    const { expectedEpoch, sourceRevision, signal } = options;
    if (!validProvider(provider) || !Number.isSafeInteger(expectedEpoch) || expectedEpoch < 0 ||
        typeof sourceRevision !== 'string' || !sourceRevision.length || sourceRevision.length > 256 || !Array.isArray(tools)) throw new Error('invalid_provider_snapshot');
    if (signal?.aborted) throw new Error('provider_refresh_cancelled');
    if (this.providerEpoch(provider) !== expectedEpoch) throw new Error('provider_snapshot_conflict');
    const replacement = this.compile(tools);
    if ([...replacement.values()].some(entry => entry.tool.definition.provider !== provider)) throw new Error('provider_namespace_mismatch');
    // A schema compiler is injected code; check the epoch again after calling it.
    if (signal?.aborted) throw new Error('provider_refresh_cancelled');
    if (this.providerEpoch(provider) !== expectedEpoch) throw new Error('provider_snapshot_conflict');
    if (this.#revision === Number.MAX_SAFE_INTEGER || expectedEpoch === Number.MAX_SAFE_INTEGER) throw new Error('provider_revision_overflow');
    const next = new Map([...this.#entries].filter(([, entry]) => entry.tool.definition.provider !== provider));
    for (const [key, entry] of replacement) {
      if (next.has(key)) throw new Error('duplicate_or_invalid_tool');
      next.set(key, entry);
    }
    const snapshot = { epoch: expectedEpoch + 1, sourceRevision, toolCount: replacement.size };
    this.#entries = next; this.#providers.set(provider, snapshot); this.#revision++;
    return { ...snapshot };
  }
  private key(id: string, version: string) { return JSON.stringify([id, version]); }
  get(id: string, version: string) { return this.#entries.get(this.key(id, version)); }
  /** Custody-only measurements; this never validates or returns a projected tool result. */
  async restoreUsage(state: WorkState, input: StoredToolResultInput): Promise<StoredToolUsage> {
    const parsed = z.strictObject({ attemptId: z.string().min(1).max(256), task: TaskSchema }).parse(input);
    const attempt = state.attempts.find(value => value.id === parsed.attemptId);
    const entry = attempt && this.get(attempt.toolId, attempt.toolVersion), definition = entry?.tool.definition;
    if (!attempt || !entry?.tool.restoreUsage || !entry.tool.validateResult || !definition || definition.effect !== 'read' ||
        definition.resultValidation !== 'artifact-proof-v1' || definition.collection || definition.reuse || definition.computerContinuation ||
        definition.computerInputAssurance || parsed.task.toolId !== attempt.toolId || parsed.task.toolVersion !== attempt.toolVersion ||
        parsed.task.id !== attempt.taskId || parsed.task.effect !== 'read' || parsed.task.readResume || parsed.task.computerResume)
      throw new Error('stored_usage_restore_unavailable');
    const value = await entry.tool.restoreUsage(structuredClone(state), structuredClone(parsed));
    if (this.get(attempt.toolId, attempt.toolVersion) !== entry) throw new Error('stored_usage_changed');
    const result = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('absent') }), z.strictObject({
      kind: z.literal('available'), usage: ToolUsageSchema, receivedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      receipt: z.strictObject({ commandId: z.string().min(1).max(256), digest: z.string().regex(/^[a-f0-9]{64}$/), artifact: ArtifactSchema }),
      custodyOnly: z.boolean(), responseObserved: z.boolean(),
    })]).parse(value);
    if (this.get(attempt.toolId, attempt.toolVersion) !== entry) throw new Error('stored_usage_changed');
    return structuredClone(result);
  }
  async restoreResult(state: WorkState, input: StoredToolResultInput): Promise<StoredToolResult> {
    const parsed = z.strictObject({ attemptId: z.string().min(1).max(256), task: TaskSchema }).parse(input);
    const attempt = state.attempts.find(value => value.id === parsed.attemptId);
    const entry = attempt && this.get(attempt.toolId, attempt.toolVersion), definition = entry?.tool.definition;
    if (!attempt || !entry?.tool.restoreResult || !entry.tool.validateResult || !definition || definition.effect !== 'read' ||
        definition.resultValidation !== 'artifact-proof-v1' || definition.collection || definition.reuse || definition.computerContinuation ||
        definition.computerInputAssurance || parsed.task.toolId !== attempt.toolId || parsed.task.toolVersion !== attempt.toolVersion ||
        parsed.task.id !== attempt.taskId || parsed.task.effect !== 'read' || parsed.task.readResume || parsed.task.computerResume)
      throw new Error('stored_result_restore_unavailable');
    const value = await entry.tool.restoreResult(structuredClone(state), structuredClone(parsed));
    if (this.get(attempt.toolId, attempt.toolVersion) !== entry) throw new Error('stored_result_changed');
    const result = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('absent') }), z.strictObject({
      kind: z.literal('available'), result: ToolResultSchema, receivedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      receipt: z.strictObject({ commandId: z.string().min(1).max(256), digest: z.string().regex(/^[a-f0-9]{64}$/), artifact: ArtifactSchema }),
    })]).parse(value);
    if (result.kind === 'available' && (result.result.attemptId !== attempt.id || result.result.effectState !== 'none' ||
        result.result.collection || result.result.reuse || result.result.effectReceipt)) throw new Error('stored_result_invalid');
    if (this.get(attempt.toolId, attempt.toolVersion) !== entry) throw new Error('stored_result_changed');
    return structuredClone(result);
  }
  async validateResult(state: WorkState, result: ToolResult): Promise<boolean> {
    const attempt = state.attempts.find(value => value.id === result.attemptId);
    if (!attempt) return false;
    const { toolId, toolVersion } = attempt;
    const entry = this.get(toolId, toolVersion);
    if (!entry) return false;
    try {
      const accepted = entry.tool.validateResult ? (await entry.tool.validateResult(structuredClone(state), structuredClone(result))) === true : true;
      return accepted && this.get(toolId, toolVersion) === entry;
    }
    catch { return false; }
  }
  async validateReadPage(state: WorkState, input: ReadPageProofInput): Promise<boolean> {
    const attempt = state.attempts.find(value => value.id === input.attemptId);
    if (!attempt || attempt.taskId !== input.task.id || attempt.toolId !== input.task.toolId || attempt.toolVersion !== input.task.toolVersion) return false;
    const entry = this.get(attempt.toolId, attempt.toolVersion);
    if (!entry?.tool.definition.collection || entry.tool.definition.collection.pageValidation && !input.page.rawArtifact) return false;
    try {
      const accepted = entry.tool.validateReadPage ? (await entry.tool.validateReadPage(structuredClone(state), structuredClone(input))) === true : true;
      return accepted && this.get(attempt.toolId, attempt.toolVersion) === entry;
    } catch { return false; }
  }
  visible(policy: Policy) { return [...this.#entries.values()].filter(entry => toolAllowed(entry.tool.definition, policy)).map(entry => entry.tool.definition); }
  /** New-call discovery only. Stored contract visibility does not depend on a live connection. */
  callable(policy: Policy) {
    return [...this.#entries.values()].filter(entry => toolAllowed(entry.tool.definition, policy) && entry.tool.availability !== 'stored_only')
      .map(entry => entry.tool.definition);
  }
  async validateReadDeferral(state: WorkState, input: ReadDeferralProofInput): Promise<boolean> {
    const attempt = state.attempts.find(value => value.id === input.attemptId);
    if (!attempt || attempt.taskId !== input.task.id || attempt.toolId !== input.task.toolId || attempt.toolVersion !== input.task.toolVersion) return false;
    const entry = this.get(attempt.toolId, attempt.toolVersion);
    if (!entry?.tool.definition.collection || entry.tool.definition.collection.deferralValidation && !input.deferral.rawArtifact) return false;
    try {
      const accepted = entry.tool.validateReadDeferral ? (await entry.tool.validateReadDeferral(structuredClone(state), structuredClone(input))) === true : true;
      return accepted && this.get(attempt.toolId, attempt.toolVersion) === entry;
    } catch { return false; }
  }
  check(task: TaskSpec, policy: Policy): string | null {
    const entry = this.get(task.toolId, task.toolVersion);
    if (!entry) return 'tool_version_unavailable';
    const d = entry.tool.definition;
    if (task.effect !== d.effect) return 'tool_effect_mismatch';
    if (task.computerResume && task.readResume) return 'computer_resume_conflict';
    if (task.computerResume && !d.computerContinuation) return 'computer_resume_requires_continuation';
    if (d.computerContinuation && !task.computerResume) return 'computer_continuation_resume_required';
    if (d.computerContinuation && Object.keys(task.input).length) return 'invalid_tool_input';
    if (task.readResume && !d.collection) return 'read_resume_requires_collection';
    if (task.readResume && task.freshness === 'fresh') return 'read_resume_fresh_conflict';
    if (!toolAllowed(d, policy)) return 'tool_permission_denied';
    if (!entry.input(task.input)) return 'invalid_tool_input';
    return null;
  }
  /** New reservation/dispatch only; never use this for stored result or usage validation. */
  checkExecution(task: TaskSpec, policy: Policy): string | null {
    const entry = this.get(task.toolId, task.toolVersion);
    const error = this.check(task, policy); if (error) return error;
    if (this.get(task.toolId, task.toolVersion) !== entry) return 'tool_contract_changed';
    return entry?.tool.availability === 'stored_only' ? 'tool_connection_required' : null;
  }
  readManifest(task: TaskSpec) {
    const entry = this.get(task.toolId, task.toolVersion);
    if (!entry?.tool.readManifest) throw new Error('tool_read_manifest_required');
    const manifest = entry.tool.readManifest(structuredClone(task));
    if (this.get(task.toolId, task.toolVersion) !== entry) throw new Error('read_manifest_changed');
    return structuredClone(manifest);
  }
  /** One original page's custody measurements. Current body permission and page projection are not part of this port. */
  async restoreReadUsage(state: WorkState, input: ReadUsageRestoreInput): Promise<ReadUsageRestoreResult> {
    const parsed = z.strictObject({ attemptId: z.string().min(1).max(256), task: TaskSchema, request: ReadRequestSchema,
      dispatchedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).parse(input);
    const captured = structuredClone(state), matches = captured.attempts.filter(value => value.id === parsed.attemptId), attempt = matches[0];
    const entry = attempt && this.get(attempt.toolId, attempt.toolVersion), definition = entry?.tool.definition;
    if (matches.length !== 1 || !attempt || !entry?.tool.restoreReadUsage || !entry.tool.restoreReadResponse ||
      !entry.tool.validateReadPage || !definition || definition.effect !== 'read' || definition.resultValidation ||
      definition.collection?.pageValidation !== 'artifact-proof-v1' || definition.collection.responseRecovery !== 'stored-response-v1' ||
      definition.reuse || definition.computerContinuation || definition.computerInputAssurance ||
      attempt.effect !== 'read' || attempt.effectState !== 'none' || attempt.reuse || attempt.computerUse || attempt.effectReceipt ||
      parsed.task.id !== attempt.taskId || parsed.task.toolId !== attempt.toolId || parsed.task.toolVersion !== attempt.toolVersion ||
      parsed.task.effect !== 'read' || parsed.task.computerResume) throw new Error('read_usage_restore_unavailable');
    const value = await entry.tool.restoreReadUsage(captured, structuredClone(parsed));
    if (this.get(attempt.toolId, attempt.toolVersion) !== entry) throw new Error('read_usage_changed');
    const receipt = z.strictObject({ commandId: z.string().min(1).max(256), digest: z.string().regex(/^[a-f0-9]{64}$/), artifact: ArtifactSchema });
    const result = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('absent') }), z.strictObject({
      kind: z.literal('available'), usage: ToolUsageSchema, receivedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      receipt, intent: receipt, custodyOnly: z.boolean(), responseObserved: z.boolean(),
    })]).parse(value);
    if (this.get(attempt.toolId, attempt.toolVersion) !== entry) throw new Error('read_usage_changed');
    return structuredClone(result);
  }
  async restoreReadResponse(state: WorkState, input: ReadResponseRestoreInput): Promise<ReadResponseRestoreResult> {
    const attempt = state.attempts.find(value => value.id === input.attemptId);
    const entry = this.get(input.task.toolId, input.task.toolVersion);
    if (!attempt || attempt.taskId !== input.task.id || attempt.toolId !== input.task.toolId || attempt.toolVersion !== input.task.toolVersion ||
      !entry?.tool.definition.collection?.responseRecovery || !entry.tool.restoreReadResponse) throw new Error('read_response_restore_unavailable');
    const result = await entry.tool.restoreReadResponse(structuredClone(state), structuredClone(input));
    if (this.get(input.task.toolId, input.task.toolVersion) !== entry) throw new Error('read_response_restore_changed');
    const parsed = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('absent') }),
      z.strictObject({ kind: z.literal('custody_only'), reason: z.enum(['captured', 'failure', 'late_returned']) }),
      z.strictObject({ kind: z.literal('available'), response: ReadResponseSchema,
        receivedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) })]).safeParse(result);
    if (!parsed.success) throw new Error('read_response_restore_invalid');
    return structuredClone(parsed.data);
  }
}
