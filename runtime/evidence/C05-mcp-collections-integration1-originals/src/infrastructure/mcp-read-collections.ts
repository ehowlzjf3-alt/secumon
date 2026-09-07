import { z } from 'zod';
import type { ArtifactRef, Evidence, Json, TaskSpec, WorkState } from '../domain/model.js';
import type { ReadItem, ReadKey, ReadPage, ReadRequest, ReadResponse } from '../domain/read-collection.js';
import { dataGeneration, visibleArtifact } from '../domain/data-lifecycle.js';
import { disclosureLabels } from '../domain/disclosure.js';
import type { ReadCollectionBinding, ReadCollectionSource, ReadDeferralProofInput, ReadPageProofInput, ReadResponseRestoreInput, SchemaCompiler, ToolDefinition } from '../application/ports.js';
import type { RuntimeServices } from '../application/services.js';
import { ArtifactSchema, JsonSchema, parseContract } from '../application/contracts.js';
import { ReadDeferralSchema, ReadPageSchema, ReadRequestSchema } from '../application/read-collection-contracts.js';
import { ReadCheckpointReader } from '../application/read-checkpoint-store.js';
import { frozen, ToolDefinitionSchema } from '../application/resource-contracts.js';
import { asJson, taskDigest } from '../application/plan-validator.js';
import { transact } from '../application/work-transactions.js';
import { sha256 } from './digest.js';
import type { McpReadObservation } from './mcp-read-tools.js';
import { McpCallError, type McpRemoteTool, type McpReply, type McpSession, type McpStdioClient } from './mcp-stdio-client.js';

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
const envelopeSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('mcp_collection_response'),
  workId: z.string(), attemptId: z.string(), request: ReadRequestSchema, intentHead: ArtifactSchema,
  inputDigest: digestSchema, contractDigest: digestSchema, bindingDigest: digestSchema,
  goalDigest: digestSchema, policyDigest: digestSchema, lifecycleGeneration: z.number().int().nonnegative(),
  session: sessionSchema, recordedAt: z.number().int().nonnegative(), value: JsonSchema,
  failure: z.strictObject({ code: z.enum(['mcp_transport_failed', 'mcp_call_not_sent']), sent: z.boolean() }).nullable(),
  transportCalls: z.number().int().min(0).max(1) });
type Envelope = z.infer<typeof envelopeSchema>;
const object = (value: Json): Record<string, Json> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;

/** MCP only supplies records. The existing collection ledger owns requests, retries and acceptance. */
export function createMcpReadCollection(binding: McpReadCollectionBinding, session: McpSession,
  client: Pick<McpStdioClient, 'call'>, services: Services, schemas: SchemaCompiler): ReadCollectionBinding {
  const remote = frozen(structuredClone(binding.remote)); const capturedSession = frozen(parseContract(sessionSchema, session));
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
    endpointId: capturedSession.endpointId, protocolVersion: capturedSession.protocolVersion,
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
  const responseData = (attemptId: string, requestId: string, artifact: ArtifactRef) => asJson({ attemptId, requestId, artifact });

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
      envelope.session.endpointId !== capturedSession.endpointId || envelope.session.protocolVersion !== capturedSession.protocolVersion ||
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

  return Object.freeze({ definition, source: Object.freeze({ manifest: (task: TaskSpec) => structuredClone(manifest(structuredClone(task))),
    async restoreResponse(state: WorkState, input: ReadResponseRestoreInput) {
      const receipt = await services.state.receipt(state.id, responseId(input.attemptId, input.request.requestId));
      if (!receipt) return { kind: 'absent' as const };
      // The receipt authenticates the ref without searching or loading unrelated artifact bodies.
      const matches = receipt.state.artifacts.filter(ref => receipt.digest === digest({ type: 'mcp_collection_response_recorded',
        data: responseData(input.attemptId, input.request.requestId, ref) }));
      if (matches.length !== 1) throw new Error('mcp_saved_response_invalid');
      const ref = matches[0]!; const { envelope, basis, task } = await original(state, input, ref);
      if (!same(envelope.intentHead, input.intentHead)) throw new Error('mcp_saved_response_invalid');
      return { kind: 'available' as const, response: projectResponse(envelope, ref, basis, task), receivedAt: envelope.recordedAt };
    },
    async fetch(task: TaskSpec, request: ReadRequest, context: Parameters<ReadCollectionSource['fetch']>[2]) {
      if (!context.authorize) throw new Error('mcp_authority_required');
      const authorize = context.authorize;
      await authorize();
      const dispatch = await services.state.receipt(context.workId, `dispatch:${context.attemptId}`);
      const current = await services.state.get(context.workId);
      const basis = dispatch?.state; const attempt = basis?.attempts.find(value => value.id === context.attemptId);
      const head = current?.attempts.find(value => value.id === context.attemptId)?.readProgress?.head;
      if (!basis || !attempt || !current || !head || attempt.contractDigest !== contractDigest ||
        taskDigest(task, services.digester) !== attempt.inputDigest) throw new Error('mcp_collection_dispatch_missing');
      const checkpoint = await new ReadCheckpointReader(current, services.artifacts, services.digester).load(head);
      const call = checkpoint.calls.at(-1);
      if (!call || call.status !== 'intent' || call.attemptId !== context.attemptId || !same(call.request, request)) throw new Error('mcp_collection_intent_missing');
      if (await services.state.receipt(context.workId, responseId(context.attemptId, request.requestId))) throw new Error('mcp_collection_response_exists');
      const args: Record<string, Json> = { query: structuredClone(task.input), read: { requestId: request.requestId, cursor: request.cursor,
        snapshot: request.snapshot, retryIds: request.retryItems?.map(key => key.id) ?? null, itemLimit: request.itemLimit } };
      if (!inputValid(args)) throw new Error('mcp_collection_input_invalid');
      let reply: McpReply | null = null; let failure: Envelope['failure'] = null;
      try { reply = await client.call(capturedSession, remote.name, args, { signal: context.signal, authorize }); }
      catch (error) { const sent = !(error instanceof McpCallError) || error.sent; failure = { code: sent ? 'mcp_transport_failed' : 'mcp_call_not_sent', sent }; }
      await authorize();
      if (reply && (!same(reply.session, capturedSession) || reply.transportCalls !== 1)) throw new Error('mcp_collection_reply_identity');
      const envelope = parseContract(envelopeSchema, { schemaVersion: 1, kind: 'mcp_collection_response', workId: context.workId,
        attemptId: context.attemptId, request, intentHead: head, inputDigest: attempt.inputDigest, contractDigest, bindingDigest,
        goalDigest: digest(basis.goal), policyDigest: digest(basis.policy), lifecycleGeneration: dataGeneration(basis),
        session: capturedSession, recordedAt: services.clock.now(), value: reply?.value ?? null, failure,
        transportCalls: reply ? 1 : failure?.sent ? 1 : 0 });
      const bytes = new TextEncoder().encode(JSON.stringify(envelope));
      if (bytes.byteLength > maxBytes) throw new Error('mcp_collection_response_too_large');
      const rawArtifact = await services.artifacts.put(bytes, { tenantId: basis.policy.tenantId,
        labels: [...new Set([...disclosureLabels(basis), ...definition.labels])].sort(), mediaType: 'application/json' });
      await authorize();
      await transact(services, context.workId, responseId(context.attemptId, request.requestId), 'mcp_collection_response_recorded',
        responseData(context.attemptId, request.requestId, rawArtifact), state => {
          if (!same(state.attempts.find(value => value.id === context.attemptId)?.readProgress?.head, head)) throw new Error('mcp_collection_head_changed');
          state.artifacts.push(structuredClone(rawArtifact));
        }, authorize);
      return projectResponse(envelope, rawArtifact, basis, task);
    },
    async validatePage(state: WorkState, input: ReadPageProofInput) { try { return await proof(state, input); } catch { return false; } },
    ...(deferralConfig ? { async validateDeferral(state: WorkState, input: ReadDeferralProofInput) {
      try { return await proof(state, input); } catch { return false; }
    } } : {}),
  }) });
}
