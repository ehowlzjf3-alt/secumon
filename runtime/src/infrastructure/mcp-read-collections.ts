import { z } from 'zod';
import type { ArtifactRef, Attempt, Evidence, Json, TaskSpec, WorkState } from '../domain/model.js';
import type { ReadItem, ReadKey, ReadPage, ReadRequest, ReadResponse } from '../domain/read-collection.js';
import { artifactBlocked, dataGeneration, visibleArtifact } from '../domain/data-lifecycle.js';
import { disclosureLabels } from '../domain/disclosure.js';
import type { ReadCollectionBinding, ReadCollectionSource, ReadDeferralProofInput, ReadPageProofInput, ReadResponseRestoreInput, ReadUsageRestoreInput, ReadUsageRestoreResult, SchemaCompiler, StateRepository, ToolDefinition } from '../application/ports.js';
import type { RuntimeServices } from '../application/services.js';
import { ArtifactSchema, JsonSchema, parseContract } from '../application/contracts.js';
import { ReadDeferralSchema, ReadPageSchema, ReadRequestSchema } from '../application/read-collection-contracts.js';
import { ReadCheckpointReader } from '../application/read-checkpoint-store.js';
import { frozen, ToolDefinitionSchema } from '../application/resource-contracts.js';
import { asJson, taskDigest } from '../application/plan-validator.js';
import { transact } from '../application/work-transactions.js';
import { sha256 } from './digest.js';
import type { McpReadObservation, McpStoredOrigin } from './mcp-read-tools.js';
import { MCP_PROTOCOL_VERSION, McpCallError, type McpDecodedResponse, type McpRemoteTool, type McpReply, type McpSession, type McpStdioClient } from './mcp-stdio-client.js';

type Services = Pick<RuntimeServices, 'state' | 'artifacts' | 'digester' | 'clock'>;
export interface McpCollectionItem extends Omit<ReadItem, 'evidence' | 'artifacts'> { observations: McpReadObservation[] }
export interface McpCollectionProjection extends Pick<ReadPage, 'sourceSnapshot' | 'cursor' | 'nextCursor' | 'exhausted' | 'totalItems' | 'expected'> {
  items: McpCollectionItem[];
}
export interface McpReadCollectionBinding {
  definition: ToolDefinition;
  remote: McpRemoteTool;
  projectorId: string;
  projectorVersion: string;
  manifest(task: TaskSpec): ReadKey[];
  project(value: Json, task: TaskSpec, request: ReadRequest, context: { recordedAt: number }): McpCollectionProjection;
  /** A reviewed mapper of the complete MCP result, including its error discriminator. */
  deferral?: { id: string; version: string; maxDelayMs: number;
    project(value: Json, task: TaskSpec, request: ReadRequest): { retryAfterMs: number } | null };
}
const deferralConfigSchema = z.strictObject({ id: z.string().min(1).max(256), version: z.string().min(1).max(256),
  maxDelayMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
const deferralProjectionSchema = z.strictObject({ retryAfterMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const sessionSchema = z.strictObject({ endpointId: z.string().min(1).max(256), generation: z.number().int().positive(),
  protocolVersion: z.string().min(1).max(64), discoveryDigest: digestSchema });
const storedOriginSchema = z.strictObject({
  endpointId: z.string().min(1).max(256).refine(value => value.trim().length > 0 && !value.includes('\0')),
  protocolVersion: z.literal(MCP_PROTOCOL_VERSION),
});
type CollectionSource = { kind: 'online'; session: McpSession; client: Pick<McpStdioClient, 'call'> } |
  { kind: 'stored_only'; origin: McpStoredOrigin };
const envelopeSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('mcp_collection_response'),
  workId: z.string(), attemptId: z.string(), request: ReadRequestSchema, intentHead: ArtifactSchema,
  inputDigest: digestSchema, contractDigest: digestSchema, bindingDigest: digestSchema,
  goalDigest: digestSchema, policyDigest: digestSchema, lifecycleGeneration: z.number().int().nonnegative(),
  session: sessionSchema, recordedAt: z.number().int().nonnegative(), value: JsonSchema,
  failure: z.strictObject({ code: z.enum(['mcp_transport_failed', 'mcp_call_not_sent']), sent: z.boolean() }).nullable(),
  transportCalls: z.number().int().min(0).max(1) });
type Envelope = z.infer<typeof envelopeSchema>;
// The finite receipt variants preserve the v1 envelope and distinguish its original clock meaning.
const custodySchema = z.union([
  z.strictObject({ schemaVersion: z.literal(1), outcome: z.literal('returned'), transportCalls: z.literal(1), recordedAtKind: z.literal('decoded_response') }),
  z.strictObject({ schemaVersion: z.literal(1), outcome: z.literal('returned'), transportCalls: z.literal(1), recordedAtKind: z.literal('response_prepared') }),
  z.strictObject({ schemaVersion: z.literal(1), outcome: z.literal('captured'), transportCalls: z.literal(1), recordedAtKind: z.literal('decoded_response') }),
  z.strictObject({ schemaVersion: z.literal(1), outcome: z.literal('failure'), transportCalls: z.literal(0), recordedAtKind: z.literal('response_prepared') }),
  z.strictObject({ schemaVersion: z.literal(1), outcome: z.literal('failure'), transportCalls: z.literal(1), recordedAtKind: z.literal('response_prepared') }),
]);
type CustodyWitness = z.infer<typeof custodySchema>;
const custodyWitnesses: readonly CustodyWitness[] = [
  { schemaVersion: 1, outcome: 'returned', transportCalls: 1, recordedAtKind: 'decoded_response' },
  { schemaVersion: 1, outcome: 'returned', transportCalls: 1, recordedAtKind: 'response_prepared' },
  { schemaVersion: 1, outcome: 'captured', transportCalls: 1, recordedAtKind: 'decoded_response' },
  { schemaVersion: 1, outcome: 'failure', transportCalls: 0, recordedAtKind: 'response_prepared' },
  { schemaVersion: 1, outcome: 'failure', transportCalls: 1, recordedAtKind: 'response_prepared' },
];
type Receipt = NonNullable<Awaited<ReturnType<StateRepository['receipt']>>>;
const object = (value: Json): Record<string, Json> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;

/** MCP only supplies records. The existing collection ledger owns requests, retries and acceptance. */
export function createMcpReadCollection(binding: McpReadCollectionBinding, session: McpSession,
  client: Pick<McpStdioClient, 'call'>, services: Services, schemas: SchemaCompiler): ReadCollectionBinding {
  return buildMcpReadCollection(binding, { kind: 'online', session, client }, services, schemas);
}

/** Authenticate original pages and deferrals without constructing a current session or owning a peer. */
export function createMcpStoredReadCollection(binding: McpReadCollectionBinding, origin: McpStoredOrigin,
  services: Services, schemas: SchemaCompiler): ReadCollectionBinding {
  const { state, artifacts, digester, clock } = services;
  return buildMcpReadCollection(binding, { kind: 'stored_only', origin }, { state, artifacts, digester, clock }, schemas);
}

function buildMcpReadCollection(binding: McpReadCollectionBinding, selected: CollectionSource,
  services: Services, schemas: SchemaCompiler): ReadCollectionBinding {
  const remote = frozen(structuredClone(binding.remote));
  const online = selected.kind === 'online' ? { session: frozen(parseContract(sessionSchema, selected.session)), client: selected.client } : null;
  const origin = online ? { endpointId: online.session.endpointId, protocolVersion: online.session.protocolVersion }
    : frozen(parseContract(storedOriginSchema, (selected as Extract<CollectionSource, { kind: 'stored_only' }>).origin));
  const project = binding.project.bind(binding); const manifest = binding.manifest.bind(binding);
  const deferralProject = binding.deferral?.project.bind(binding.deferral);
  const deferralConfig = binding.deferral ? frozen(parseContract(deferralConfigSchema, { id: binding.deferral.id,
    version: binding.deferral.version, maxDelayMs: binding.deferral.maxDelayMs })) : null;
  if (binding.definition.effect !== 'read' || !binding.definition.collection || binding.definition.reuse ||
    binding.definition.computerContinuation || binding.definition.resultValidation || !remote.outputSchema ||
    !binding.projectorId || !binding.projectorVersion || binding.definition.collection.deferralValidation && !deferralConfig)
    throw new Error('invalid_mcp_collection_binding');
  const digest = (value: unknown) => services.digester.digest(asJson(value));
  const same = (a: unknown, b: unknown) => digest(a) === digest(b);
  const bindingDigest = digest({ remote, projectorId: binding.projectorId, projectorVersion: binding.projectorVersion,
    endpointId: origin.endpointId, protocolVersion: origin.protocolVersion,
    responseRecovery: 'stored-response-v1', ...(binding.definition.collection.coverage ? { coverage: binding.definition.collection.coverage } : {}),
    ...(deferralConfig ? { deferral: deferralConfig } : {}) });
  const definition = frozen(parseContract(ToolDefinitionSchema, { ...binding.definition,
    version: `${binding.definition.version}.${bindingDigest.slice(0, 24)}`,
    collection: { ...binding.definition.collection, pageValidation: 'artifact-proof-v1', responseRecovery: 'stored-response-v1',
      ...(deferralConfig ? { deferralValidation: 'artifact-proof-v1' } : {}) } }));
  const contractDigest = digest(definition);
  const inputValid = schemas.compile(remote.inputSchema); const remoteValid = schemas.compile(remote.outputSchema);
  const maxBytes = Math.min(512 * 1024, definition.collection!.limits.maxPageBytes);
  const responseId = (attemptId: string, requestId: string) => `mcp-page:${attemptId}:${requestId}`;
  const responseData = (attemptId: string, requestId: string, artifact: ArtifactRef, custody?: CustodyWitness) =>
    asJson({ attemptId, requestId, artifact, ...(custody ? { custody } : {}) });
  function invalid(): never { throw new Error('mcp_saved_response_invalid'); }
  const originOf = (attempt: Attempt) => ({ id: attempt.id, taskId: attempt.taskId, planRevision: attempt.planRevision,
    goalRevision: attempt.goalRevision, toolId: attempt.toolId, toolVersion: attempt.toolVersion, inputDigest: attempt.inputDigest,
    contractDigest: attempt.contractDigest ?? null, scope: attempt.scope, effect: attempt.effect, effectState: attempt.effectState,
    owner: attempt.owner, startedAt: attempt.startedAt, leaseUntil: attempt.leaseUntil, reuse: attempt.reuse ?? null,
    computerUse: attempt.computerUse ?? null });
  function indexed(state: WorkState, ref: ArtifactRef) {
    const matches = state.artifacts.filter(value => value.id === ref.id);
    if (ref.tenantId !== state.policy.tenantId || artifactBlocked(state, ref) || matches.length !== 1 || !same(matches[0], ref)) invalid();
  }
  function owned(state: WorkState, basis: WorkState, attempt: Attempt) {
    const matches = state.attempts.filter(value => value.id === attempt.id), active = matches[0];
    if (state.id !== basis.id || state.createdAt !== basis.createdAt || state.policy.tenantId !== basis.policy.tenantId ||
      state.policy.principalId !== basis.policy.principalId || dataGeneration(state) !== dataGeneration(basis) ||
      matches.length !== 1 || !active || !same(originOf(active), originOf(attempt))) invalid();
    return active;
  }
  function dispatched(dispatch: Receipt, input: Pick<ReadResponseRestoreInput, 'attemptId' | 'task'>) {
    const basis = dispatch.state, attempt = basis.attempts.find(value => value.id === input.attemptId);
    const task = basis.plan?.tasks.find(value => value.id === attempt?.taskId);
    if (!attempt || !task || !same(task, input.task) || task.effect !== 'read' || task.toolId !== definition.id || task.toolVersion !== definition.version ||
      attempt.status !== 'running' || attempt.effect !== 'read' || attempt.effectState !== 'none' || attempt.reuse || attempt.computerUse ||
      attempt.resultId !== null || attempt.resultArtifact !== null || attempt.adopted || attempt.error !== null ||
      attempt.goalRevision !== basis.goal.revision || attempt.scope !== basis.goal.scope || attempt.planRevision !== basis.plan?.revision ||
      taskDigest(task, services.digester) !== attempt.inputDigest || attempt.contractDigest !== contractDigest ||
      dispatch.digest !== digest({ type: 'attempt_dispatched', data: asJson({ attemptId: attempt.id, owner: attempt.owner }) })) invalid();
    return { basis, attempt, task };
  }
  function responseRecord(response: Receipt, input: Pick<ReadResponseRestoreInput, 'attemptId' | 'request'>, expected?: ArtifactRef) {
    const matches = response.state.artifacts.flatMap(ref => [undefined, ...custodyWitnesses].filter(custody =>
      response.digest === digest({ type: 'mcp_collection_response_recorded', data: responseData(input.attemptId, input.request.requestId, ref, custody) }))
      .map(custody => ({ ref, custody })));
    if (matches.length !== 1 || expected && !same(expected, matches[0]!.ref)) invalid();
    return matches[0]!;
  }
  async function readEnvelope(state: WorkState, ref: ArtifactRef, policy: WorkState['policy']) {
    indexed(state, ref);
    if (ref.byteLength > maxBytes) invalid();
    const bytes = await services.artifacts.get(structuredClone(ref), structuredClone(policy));
    if (bytes.byteLength !== ref.byteLength || sha256(bytes) !== ref.sha256) invalid();
    return parseContract(envelopeSchema, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  }
  async function intentOriginal(state: WorkState, dispatch: Receipt,
    input: Pick<ReadResponseRestoreInput, 'attemptId' | 'task' | 'request'>, head: ArtifactRef, expectedDispatchedAt?: number) {
    const { basis, attempt, task } = dispatched(dispatch, input);
    owned(state, basis, attempt); indexed(state, head);
    const commandId = `read:${attempt.id}:${head.id}`, receipt = await services.state.receipt(state.id, commandId);
    if (!receipt || !(dispatch.state.revision < receipt.state.revision && receipt.state.revision <= state.revision)) invalid();
    const active = owned(receipt.state, basis, attempt);
    if (active.status !== 'running' || active.resultId !== null || active.resultArtifact !== null || active.adopted || active.error !== null ||
      !active.readProgress || !same(active.readProgress.head, head) || active.readProgress.successorAttemptId !== null ||
      ['paused', 'cancelled', 'failed', 'completed', 'blocked'].includes(receipt.state.status) ||
      !same(receipt.state.goal, basis.goal) || !same(receipt.state.policy, basis.policy) || !same(receipt.state.plan, basis.plan)) invalid();
    const reader = new ReadCheckpointReader(receipt.state, services.artifacts, services.digester);
    const headBytes = await reader.proofOriginal(head, definition.collection!.limits.maxCheckpointBytes);
    if (sha256(headBytes) !== head.sha256) invalid();
    const checkpoint = await reader.load(head), call = checkpoint.calls.at(-1);
    if (checkpoint.workId !== state.id || checkpoint.attemptId !== attempt.id || checkpoint.contractDigest !== contractDigest ||
      checkpoint.toolId !== task.toolId || checkpoint.toolVersion !== task.toolVersion ||
      checkpoint.queryDigest !== digest({ toolId: task.toolId, toolVersion: task.toolVersion, input: task.input }) ||
      !same(checkpoint.goal, basis.goal) || !same(checkpoint.policy, basis.policy) || checkpoint.lifecycleGeneration !== dataGeneration(basis) ||
      !same(checkpoint.limits, definition.collection!.limits) || checkpoint.phase !== 'running' || !call || call.status !== 'intent' ||
      call.response !== null || call.receivedAt !== null || call.attemptId !== attempt.id || !same(call.request, input.request) ||
      expectedDispatchedAt !== undefined && call.dispatchedAt !== expectedDispatchedAt ||
      checkpoint.calls.filter(value => value.request.requestId === input.request.requestId).length !== 1 ||
      active.readProgress.operationId !== checkpoint.operationId || active.readProgress.callCount !== checkpoint.calls.length ||
      receipt.digest !== digest({ type: 'read_checkpoint_committed', data: {
        attemptId: attempt.id, checkpointId: head.id, phase: checkpoint.phase, calls: checkpoint.calls.length } })) invalid();
    for (const ref of checkpoint.artifacts) indexed(state, ref);
    const times = [attempt.startedAt, dispatch.state.updatedAt, call.dispatchedAt, checkpoint.updatedAt, receipt.state.updatedAt];
    if (!times.every(value => Number.isSafeInteger(value) && value >= 0) || times.some((value, i) => i > 0 && value < times[i - 1]!) ||
      receipt.state.updatedAt >= Math.min(attempt.leaseUntil, receipt.state.deadlineAt)) invalid();
    await reader.revalidate();
    return { commandId, receipt, checkpoint, call, basis, attempt, task };
  }
  /** Original-call custody, independent of permission to project or use a page now. */
  async function custodyOriginal(state: WorkState, input: Pick<ReadResponseRestoreInput, 'attemptId' | 'task' | 'request'>,
    response: Receipt, expected?: ArtifactRef, expectedDispatchedAt?: number) {
    const dispatch = await services.state.receipt(state.id, `dispatch:${input.attemptId}`);
    if (!dispatch) invalid();
    const { basis, attempt, task } = dispatched(dispatch, input);
    owned(state, basis, attempt); owned(response.state, basis, attempt);
    const { ref, custody } = responseRecord(response, input, expected);
    const envelope = await readEnvelope(state, ref, basis.policy);
    if (envelope.workId !== state.id || envelope.attemptId !== attempt.id || !same(envelope.request, input.request) ||
      envelope.inputDigest !== attempt.inputDigest || envelope.contractDigest !== contractDigest || envelope.bindingDigest !== bindingDigest ||
      envelope.goalDigest !== digest(basis.goal) || envelope.policyDigest !== digest(basis.policy) ||
      envelope.lifecycleGeneration !== dataGeneration(basis) || envelope.session.endpointId !== origin.endpointId ||
      envelope.session.protocolVersion !== origin.protocolVersion ||
      !same(ref.labels, [...new Set([...disclosureLabels(basis), ...definition.labels])].sort()) ||
      custody && (custody.transportCalls !== envelope.transportCalls || (custody.outcome === 'failure') !== (envelope.failure !== null)) ||
      envelope.failure && (envelope.failure.sent !== (envelope.transportCalls === 1) ||
        envelope.failure.code !== (envelope.failure.sent ? 'mcp_transport_failed' : 'mcp_call_not_sent')) ||
      !envelope.failure && envelope.transportCalls !== 1) invalid();
    const intent = await intentOriginal(state, dispatch, input, envelope.intentHead, expectedDispatchedAt);
    indexed(response.state, envelope.intentHead);
    if (!(intent.receipt.state.revision < response.state.revision && response.state.revision <= state.revision)) invalid();
    const times = [intent.receipt.state.updatedAt, envelope.recordedAt, response.state.updatedAt];
    const now = services.clock.now();
    if (!times.every(value => Number.isSafeInteger(value) && value >= 0) || times.some((value, i) => i > 0 && value < times[i - 1]!) ||
      !Number.isSafeInteger(now) || now < Math.max(state.updatedAt, response.state.updatedAt)) invalid();
    if (!same(await services.state.receipt(state.id, `dispatch:${attempt.id}`), dispatch) ||
      !same(await services.state.receipt(state.id, intent.commandId), intent.receipt) ||
      !same(await services.state.receipt(state.id, responseId(attempt.id, input.request.requestId)), response) ||
      !same(await services.state.get(state.id), state)) throw new Error('mcp_custody_changed');
    return { dispatch, intent, ref, custody, envelope, basis, attempt, task };
  }

  function projectResponse(envelope: Envelope, rawArtifact: ArtifactRef, basis: WorkState, task: TaskSpec): ReadResponse {
    if (envelope.failure) throw new Error(envelope.failure.code);
    const raw = object(envelope.value);
    if (!raw || raw['resultType'] !== undefined && raw['resultType'] !== 'complete' ||
      !Array.isArray(raw['content']) || raw['content'].some(value => object(value)?.['type'] !== 'text')) throw new Error('mcp_collection_result_unsupported');
    if (deferralProject) {
      const candidate = deferralProject(structuredClone(envelope.value), structuredClone(task), structuredClone(envelope.request));
      if (candidate !== null) {
        const projected = parseContract(deferralProjectionSchema, candidate);
        const dueAt = envelope.recordedAt + projected.retryAfterMs;
        if (!deferralConfig || projected.retryAfterMs > deferralConfig.maxDelayMs || !Number.isSafeInteger(dueAt))
          throw new Error('mcp_collection_deferral_invalid');
        return parseContract(ReadDeferralSchema, { kind: 'read_deferral', requestId: envelope.request.requestId, dueAt,
          reason: 'rate_limited', rawArtifact, usage: { transportCalls: envelope.transportCalls, internalOperations: null, imageBytes: null, waitMs: null } });
      }
    }
    if (raw['isError'] === true) throw new Error('mcp_collection_result_unsupported');
    const value = raw['structuredContent'];
    if (value === undefined || !remoteValid(value)) throw new Error('mcp_collection_output_invalid');
    const projected = structuredClone(project(structuredClone(value), structuredClone(task), structuredClone(envelope.request), { recordedAt: envelope.recordedAt }));
    if (!Array.isArray(projected.items) || projected.items.length > envelope.request.itemLimit) throw new Error('mcp_collection_projection_invalid');
    const items: ReadItem[] = projected.items.map((item, index) => {
      const { observations, ...body } = item;
      if (item.retryAt !== undefined && (!deferralConfig || !Number.isSafeInteger(item.retryAt) ||
        item.retryAt <= envelope.recordedAt || item.retryAt - envelope.recordedAt > deferralConfig.maxDelayMs ||
        item.status === 'success' || item.error?.retryable !== true)) throw new Error('mcp_collection_item_retry_invalid');
      if (!Array.isArray(observations) || observations.length > 100 || item.status !== 'success' && observations.length)
        throw new Error('mcp_collection_observation_invalid');
      const evidence: Evidence[] = observations.map((record, observation) => ({ id: `mcp:${envelope.request.requestId}:${index}:${observation}`,
        tenantId: basis.policy.tenantId, scope: basis.goal.scope, sourceId: record.sourceId, lineageId: record.lineageId,
        locator: record.locator, observedAt: record.observedAt, recordedAt: envelope.recordedAt, labels: [...rawArtifact.labels],
        coverage: record.coverage, facts: structuredClone(record.facts), artifact: structuredClone(rawArtifact),
        status: 'accepted', access: 'available', supersedes: [], derivedFrom: [] }));
      if (evidence.some(record => record.observedAt > envelope.recordedAt)) throw new Error('mcp_collection_observation_invalid');
      return { ...body, evidence, artifacts: item.status === 'not_run' ? [] : [structuredClone(rawArtifact)] };
    });
    return parseContract(ReadPageSchema, { ...projected, items, requestId: envelope.request.requestId, rawArtifact,
      usage: { transportCalls: envelope.transportCalls, internalOperations: null, imageBytes: null, waitMs: null } });
  }

  async function original(state: WorkState, input: Pick<ReadResponseRestoreInput, 'attemptId' | 'task' | 'request'>, ref: ArtifactRef) {
    const dispatch = await services.state.receipt(state.id, `dispatch:${input.attemptId}`);
    const receipt = await services.state.receipt(state.id, responseId(input.attemptId, input.request.requestId));
    if (!dispatch || !receipt) invalid();
    const record = responseRecord(receipt, input, ref);
    if (record.custody) {
      const saved = await custodyOriginal(state, input, receipt, ref);
      if (saved.custody?.outcome !== 'returned' || !visibleArtifact(state, ref) ||
        !same(state.goal, saved.basis.goal) || !same(state.policy, saved.basis.policy) ||
        saved.envelope.recordedAt >= Math.min(saved.attempt.leaseUntil, saved.basis.deadlineAt)) invalid();
      return { envelope: saved.envelope, basis: saved.basis, task: saved.task };
    }
    // Unmarked v1 bodies retain their original validation and timestamp semantics.
    if (!ref || !dispatch || !receipt || ref.byteLength > maxBytes || !visibleArtifact(state, ref) ||
      !state.artifacts.some(value => same(value, ref)) ||
      receipt.digest !== digest({ type: 'mcp_collection_response_recorded', data: responseData(input.attemptId, input.request.requestId, ref) }))
      throw new Error('mcp_saved_response_invalid');
    const bytes = await services.artifacts.get(structuredClone(ref), structuredClone(state.policy));
    if (bytes.byteLength !== ref.byteLength || sha256(bytes) !== ref.sha256) throw new Error('mcp_saved_response_invalid');
    const envelope = parseContract(envelopeSchema, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    const basis = dispatch.state; const attempt = basis.attempts.find(value => value.id === input.attemptId);
    const task = basis.plan?.tasks.find(value => value.id === attempt?.taskId);
    const responseAttempt = receipt.state.attempts.find(value => value.id === input.attemptId);
    if (!attempt || !task || !responseAttempt?.readProgress || envelope.workId !== state.id || envelope.attemptId !== attempt.id ||
      !same(envelope.request, input.request) || !same(task, input.task) || !same(envelope.intentHead, responseAttempt.readProgress.head) ||
      envelope.inputDigest !== attempt.inputDigest || taskDigest(task, services.digester) !== attempt.inputDigest ||
      envelope.contractDigest !== contractDigest || attempt.contractDigest !== contractDigest || envelope.bindingDigest !== bindingDigest ||
      envelope.goalDigest !== digest(basis.goal) || envelope.policyDigest !== digest(basis.policy) ||
      envelope.lifecycleGeneration !== dataGeneration(basis) || dataGeneration(state) !== dataGeneration(basis) ||
      !same(state.goal, basis.goal) || !same(state.policy, basis.policy) ||
      envelope.session.endpointId !== origin.endpointId || envelope.session.protocolVersion !== origin.protocolVersion ||
      envelope.recordedAt < attempt.startedAt || envelope.recordedAt > receipt.state.updatedAt ||
      !same(ref.labels, [...new Set([...disclosureLabels(basis), ...definition.labels])].sort())) throw new Error('mcp_saved_response_invalid');
    const reader = new ReadCheckpointReader(receipt.state, services.artifacts, services.digester);
    const intent = await reader.load(envelope.intentHead); const call = intent.calls.at(-1);
    if (intent.attemptId !== attempt.id || intent.contractDigest !== contractDigest || !call || call.status !== 'intent' ||
      call.attemptId !== attempt.id || !same(call.request, input.request)) throw new Error('mcp_saved_response_invalid');
    await reader.revalidate();
    return { envelope, basis, task };
  }
  async function proof(state: WorkState, input: ReadPageProofInput | ReadDeferralProofInput): Promise<boolean> {
    const response = 'page' in input ? input.page : input.deferral;
    const ref = response.rawArtifact; if (!ref) return false;
    const { envelope, basis, task } = await original(state, input, ref);
    return same(response, projectResponse(envelope, ref, basis, task));
  }

  async function restoreUsage(suppliedState: WorkState, suppliedInput: ReadUsageRestoreInput): Promise<ReadUsageRestoreResult> {
    const state = structuredClone(suppliedState), input = structuredClone(suppliedInput);
    if (!Number.isSafeInteger(input.dispatchedAt) || input.dispatchedAt < 0) invalid();
    const commandId = responseId(input.attemptId, input.request.requestId), response = await services.state.receipt(state.id, commandId);
    if (!response) return { kind: 'absent' };
    const saved = await custodyOriginal(state, input, response, undefined, input.dispatchedAt);
    // Old sent=true failure records also represented arbitrary exceptions; they cannot prove one send.
    const transportCalls = saved.custody ? saved.custody.transportCalls : saved.envelope.failure?.sent ? null : saved.envelope.transportCalls;
    return { kind: 'available', usage: { transportCalls, internalOperations: null, imageBytes: null, waitMs: null },
      receivedAt: saved.envelope.recordedAt, receipt: { commandId, digest: response.digest, artifact: structuredClone(saved.ref) },
      custodyOnly: saved.custody !== undefined, responseObserved: saved.envelope.failure === null,
      intent: { commandId: saved.intent.commandId, digest: saved.intent.receipt.digest, artifact: structuredClone(saved.envelope.intentHead) } };
  }

  return Object.freeze({ definition, ...(online ? {} : { availability: 'stored_only' as const }), source: Object.freeze({ manifest: (task: TaskSpec) => structuredClone(manifest(structuredClone(task))),
    restoreUsage,
    async restoreResponse(state: WorkState, input: ReadResponseRestoreInput) {
      const receipt = await services.state.receipt(state.id, responseId(input.attemptId, input.request.requestId));
      if (!receipt) return { kind: 'absent' as const };
      // The receipt authenticates the ref without searching or loading unrelated artifact bodies.
      const { ref, custody } = responseRecord(receipt, input);
      if (custody) {
        const saved = await custodyOriginal(state, input, receipt, ref);
        if (!same(saved.envelope.intentHead, input.intentHead)) invalid();
        if (custody.outcome === 'captured' || custody.outcome === 'failure')
          return { kind: 'custody_only' as const, reason: custody.outcome };
        if (saved.envelope.recordedAt >= Math.min(saved.attempt.leaseUntil, saved.basis.deadlineAt))
          return { kind: 'custody_only' as const, reason: 'late_returned' as const };
        if (!visibleArtifact(state, ref) || !same(state.goal, saved.basis.goal) || !same(state.policy, saved.basis.policy)) invalid();
        return { kind: 'available' as const, response: projectResponse(saved.envelope, ref, saved.basis, saved.task),
          receivedAt: saved.envelope.recordedAt };
      }
      const { envelope, basis, task } = await original(state, input, ref);
      if (!same(envelope.intentHead, input.intentHead)) throw new Error('mcp_saved_response_invalid');
      return { kind: 'available' as const, response: projectResponse(envelope, ref, basis, task), receivedAt: envelope.recordedAt };
    },
    async fetch(originalTask: TaskSpec, originalRequest: ReadRequest, originalContext: Parameters<ReadCollectionSource['fetch']>[2]) {
      if (!online) throw new Error('mcp_stored_only');
      const capturedSession = online.session, client = online.client;
      const task = structuredClone(originalTask), request = structuredClone(originalRequest);
      const context = { ...originalContext, policy: structuredClone(originalContext.policy) };
      if (!context.authorize) throw new Error('mcp_authority_required');
      const authorize = context.authorize;
      await authorize();
      const dispatch = await services.state.receipt(context.workId, `dispatch:${context.attemptId}`);
      const current = await services.state.get(context.workId);
      const basis = dispatch?.state; const attempt = basis?.attempts.find(value => value.id === context.attemptId);
      const head = current?.attempts.find(value => value.id === context.attemptId)?.readProgress?.head;
      if (!dispatch || !basis || !attempt || !current || !head || attempt.contractDigest !== contractDigest ||
        taskDigest(task, services.digester) !== attempt.inputDigest) throw new Error('mcp_collection_dispatch_missing');
      const input = { attemptId: context.attemptId, task, request };
      const intent = await intentOriginal(current, dispatch, input, head);
      if (await services.state.receipt(context.workId, responseId(context.attemptId, request.requestId))) throw new Error('mcp_collection_response_exists');
      const args: Record<string, Json> = { query: structuredClone(task.input), read: { requestId: request.requestId, cursor: request.cursor,
        snapshot: request.snapshot, retryIds: request.retryItems?.map(key => key.id) ?? null, itemLimit: request.itemLimit } };
      if (!inputValid(args)) throw new Error('mcp_collection_input_invalid');
      let reply: McpReply | null = null, captured: Readonly<McpDecodedResponse> | undefined;
      let failure: Envelope['failure'] = null, callError: unknown, failedCall = false;
      try { reply = await client.call(structuredClone(capturedSession), remote.name, structuredClone(args), { signal: context.signal, authorize,
        capture: { now: () => services.clock.now(), decoded: value => {
          if (captured) throw new Error('mcp_collection_capture_duplicate');
          captured = frozen(structuredClone(value));
        } } }); }
      catch (error) { callError = error; failedCall = true; }
      if (captured) {
        if (!same(captured.session, capturedSession) || captured.requestDigest !== digest({ session: capturedSession, name: remote.name, input: args }) ||
          captured.transportCalls !== 1 || !Number.isSafeInteger(captured.observedAt) || captured.observedAt < intent.receipt.state.updatedAt ||
          captured.observedAt > services.clock.now() || !Number.isSafeInteger(captured.byteLength) || captured.byteLength < 0 ||
          new TextEncoder().encode(captured.json).byteLength !== captured.byteLength || captured.byteLength > maxBytes)
          throw new Error('mcp_collection_capture_identity');
        const value = parseContract(JsonSchema, JSON.parse(captured.json));
        if (reply && (!same(reply.session, capturedSession) || reply.transportCalls !== 1 || !same(reply.value, value)))
          throw new Error('mcp_collection_capture_identity');
        reply = { session: structuredClone(capturedSession), value, transportCalls: 1 };
      } else if (failedCall) {
        if (!(callError instanceof McpCallError)) throw callError;
        failure = { code: callError.sent ? 'mcp_transport_failed' : 'mcp_call_not_sent', sent: callError.sent };
      }
      if (!reply && !failure || reply && (!same(reply.session, capturedSession) || reply.transportCalls !== 1))
        throw new Error('mcp_collection_reply_identity');
      const custodyAuthorize = context.authorizeResponseCustody ?? authorize;
      const custodyGuard = (state: WorkState) => {
        owned(state, basis, attempt); indexed(state, head);
        for (const ref of intent.checkpoint.artifacts) indexed(state, ref);
      };
      const assertCustody = async () => {
        await custodyAuthorize();
        const latest = await services.state.get(context.workId);
        if (!latest) throw new Error('mcp_custody_changed');
        custodyGuard(latest);
        if (!same(await services.state.receipt(context.workId, `dispatch:${attempt.id}`), dispatch) ||
          !same(await services.state.receipt(context.workId, intent.commandId), intent.receipt)) throw new Error('mcp_custody_changed');
        const bytes = await services.artifacts.get(structuredClone(head), structuredClone(intent.receipt.state.policy));
        if (bytes.byteLength !== head.byteLength || sha256(bytes) !== head.sha256) throw new Error('mcp_custody_changed');
        await custodyAuthorize();
        const after = await services.state.get(context.workId); if (!after) throw new Error('mcp_custody_changed');
        custodyGuard(after);
      };
      try {
        await assertCustody();
        const envelope = parseContract(envelopeSchema, { schemaVersion: 1, kind: 'mcp_collection_response', workId: context.workId,
          attemptId: context.attemptId, request, intentHead: head, inputDigest: attempt.inputDigest, contractDigest, bindingDigest,
          goalDigest: digest(basis.goal), policyDigest: digest(basis.policy), lifecycleGeneration: dataGeneration(basis),
          session: capturedSession, recordedAt: captured?.observedAt ?? services.clock.now(), value: reply?.value ?? null, failure,
          transportCalls: reply ? 1 : failure?.sent ? 1 : 0 });
        if (!Number.isSafeInteger(envelope.recordedAt) || envelope.recordedAt < intent.receipt.state.updatedAt ||
          envelope.recordedAt > services.clock.now()) throw new Error('mcp_collection_capture_identity');
        const bytes = new TextEncoder().encode(JSON.stringify(envelope));
        if (bytes.byteLength > maxBytes) throw new Error('mcp_collection_response_too_large');
        const rawArtifact = await services.artifacts.put(bytes, { tenantId: basis.policy.tenantId,
          labels: [...new Set([...disclosureLabels(basis), ...definition.labels])].sort(), mediaType: 'application/json' });
        await assertCustody();
        const witness = parseContract(custodySchema, { schemaVersion: 1, outcome: failure ? 'failure' : failedCall ? 'captured' : 'returned',
          transportCalls: envelope.transportCalls, recordedAtKind: captured ? 'decoded_response' : 'response_prepared' });
        await transact(services, context.workId, responseId(context.attemptId, request.requestId), 'mcp_collection_response_recorded',
          responseData(context.attemptId, request.requestId, rawArtifact, witness), state => {
            custodyGuard(state);
            if (state.artifacts.some(value => value.id === rawArtifact.id)) throw new Error('mcp_collection_response_exists');
            state.artifacts.push(structuredClone(rawArtifact));
          }, assertCustody);
        if (failedCall) throw callError;
        await authorize();
        return projectResponse(envelope, rawArtifact, basis, task);
      } catch (error) {
        if (failedCall && error !== callError) throw new AggregateError([callError, error], 'mcp_collection_custody_failed');
        throw error;
      }
    },
    async validatePage(state: WorkState, input: ReadPageProofInput) { try { return await proof(state, input); } catch { return false; } },
    ...(deferralConfig ? { async validateDeferral(state: WorkState, input: ReadDeferralProofInput) {
      try { return await proof(state, input); } catch { return false; }
    } } : {}),
  }) });
}
