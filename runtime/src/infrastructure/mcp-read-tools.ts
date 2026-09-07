import { z } from 'zod';
import type { ArtifactRef, Attempt, Evidence, Json, Scalar, TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import { artifactBlocked, dataGeneration, visibleArtifact } from '../domain/data-lifecycle.js';
import { disclosureLabels } from '../domain/disclosure.js';
import type { SchemaCompiler, StateRepository, StoredToolResult, StoredToolResultInput, StoredToolUsage, Tool, ToolDefinition } from '../application/ports.js';
import type { RuntimeServices } from '../application/services.js';
import type { ProviderToolSource } from '../application/provider-tool-snapshot.js';
import { JsonSchema, parseContract, ToolResultSchema } from '../application/contracts.js';
import { frozen, ToolDefinitionSchema } from '../application/resource-contracts.js';
import { asJson, taskDigest } from '../application/plan-validator.js';
import { transact } from '../application/work-transactions.js';
import { sha256 } from './digest.js';
import { MCP_PROTOCOL_VERSION, McpCallError, type McpDecodedResponse, type McpRemoteTool, type McpReply, type McpSession, type McpStdioClient } from './mcp-stdio-client.js';

type Services = Pick<RuntimeServices, 'state' | 'artifacts' | 'digester' | 'clock'>;
type Context = Parameters<Tool['execute']>[1];
export interface McpReadObservation {
  sourceId: string; lineageId: string; locator: string; observedAt: number;
  coverage: Evidence['coverage']; facts: Record<string, Scalar>;
}
export interface McpReadProjection { output: Json; coverage: ToolResult['coverage']; observations: McpReadObservation[] }
export interface McpReadBinding {
  definition: ToolDefinition;
  remote: McpRemoteTool;
  projectorId: string;
  projectorVersion: string;
  project(value: Json, task: TaskSpec): McpReadProjection;
}
type ClientPort = Pick<McpStdioClient, 'discover' | 'call'>;
export interface McpStoredOrigin { readonly endpointId: string; readonly protocolVersion: string }
const storedOriginSchema = z.strictObject({
  endpointId: z.string().min(1).max(256).refine(value => value.trim().length > 0 && !value.includes('\0')),
  protocolVersion: z.literal(MCP_PROTOCOL_VERSION),
});
type ReadSource = { kind: 'online'; session: McpSession; client: ClientPort } | { kind: 'stored_only'; origin: McpStoredOrigin };
const sessionSchema = z.strictObject({ endpointId: z.string().min(1).max(256), generation: z.number().int().positive(),
  protocolVersion: z.string().min(1).max(64), discoveryDigest: z.string().regex(/^[a-f0-9]{64}$/) });
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const envelopeSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('mcp_decoded_response'),
  workId: z.string(), attemptId: z.string(), inputDigest: digestSchema, contractDigest: digestSchema, bindingDigest: digestSchema,
  goalDigest: digestSchema, policyDigest: digestSchema, lifecycleGeneration: z.number().int().nonnegative(),
  session: sessionSchema, recordedAt: z.number().int().nonnegative(), value: JsonSchema,
  failure: z.strictObject({ code: z.enum(['mcp_transport_failed', 'mcp_call_not_sent']), sent: z.boolean() }).nullable(),
  transportCalls: z.number().int().min(0).max(1) });
type Envelope = z.infer<typeof envelopeSchema>;
// This receipt metadata authenticates the observed outcome without changing the v1 raw envelope or tool definition.
type CustodyWitness = { schemaVersion: 1; outcome: 'returned' | 'captured' | 'failure'; transportCalls: 0 | 1 };
const custodyWitnesses: CustodyWitness[] = [
  { schemaVersion: 1, outcome: 'returned', transportCalls: 1 }, { schemaVersion: 1, outcome: 'captured', transportCalls: 1 },
  { schemaVersion: 1, outcome: 'failure', transportCalls: 0 }, { schemaVersion: 1, outcome: 'failure', transportCalls: 1 },
];
const MAX_ENVELOPE_BYTES = 512 * 1024;
const object = (value: Json): Record<string, Json> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;

/** Host-reviewed semantics are captured separately from remote descriptions and connection generations. */
export function createMcpReadTool(binding: McpReadBinding, session: McpSession, client: ClientPort, services: Services, schemas: SchemaCompiler): Tool {
  return buildMcpReadTool(binding, { kind: 'online', session, client }, services, schemas);
}

/** Read original custody with a trusted current binding and endpoint, without constructing an online session. */
export function createMcpStoredReadTool(binding: McpReadBinding, origin: McpStoredOrigin, services: Services, schemas: SchemaCompiler): Tool {
  return buildMcpReadTool(binding, { kind: 'stored_only', origin }, services, schemas);
}

function buildMcpReadTool(binding: McpReadBinding, source: ReadSource, services: Services, schemas: SchemaCompiler): Tool {
  const remote = frozen(structuredClone(binding.remote));
  const online = source.kind === 'online' ? { session: frozen(parseContract(sessionSchema, source.session)), client: source.client } : null;
  const origin = online ? { endpointId: online.session.endpointId, protocolVersion: online.session.protocolVersion }
    : frozen(parseContract(storedOriginSchema, (source as Extract<ReadSource, { kind: 'stored_only' }>).origin));
  const project = binding.project.bind(binding);
  if (binding.definition.effect !== 'read' || binding.definition.collection || binding.definition.computerContinuation || binding.definition.reuse ||
    !binding.projectorId || !binding.projectorVersion || !remote.outputSchema) throw new Error('invalid_mcp_read_binding');
  const bindingDigest = services.digester.digest(asJson({ remote, projectorId: binding.projectorId, projectorVersion: binding.projectorVersion,
    endpointId: origin.endpointId, protocolVersion: origin.protocolVersion }));
  const definition = frozen(parseContract(ToolDefinitionSchema, { ...binding.definition,
    version: `${binding.definition.version}.${bindingDigest.slice(0, 24)}`, resultValidation: 'artifact-proof-v1' }));
  const inputValid = schemas.compile(remote.inputSchema); const remoteValid = schemas.compile(remote.outputSchema);
  const outputValid = schemas.compile(definition.outputSchema);
  const digest = (value: unknown) => services.digester.digest(asJson(value));
  const same = (a: unknown, b: unknown) => digest(a) === digest(b);
  const contractDigest = digest(definition);
  const intentId = (attemptId: string) => `mcp-intent:${attemptId}`;
  const responseId = (attemptId: string) => `mcp-response:${attemptId}`;
  const intentData = (attemptId: string, inputDigest: string, expectedSession: McpSession) =>
    asJson({ attemptId, inputDigest, contractDigest, bindingDigest, session: expectedSession });
  const responseData = (attemptId: string, artifact: ArtifactRef, custody?: CustodyWitness) =>
    asJson({ attemptId, artifact, ...(custody ? { custody } : {}) });

  function projectResult(envelope: Envelope, ref: ArtifactRef, basis: WorkState, task: TaskSpec): ToolResult {
    const base = { resultId: `mcp:${envelope.attemptId}`, attemptId: envelope.attemptId, effectState: 'none' as const,
      cursor: null, usage: { transportCalls: envelope.transportCalls, internalOperations: null, imageBytes: null, waitMs: null } };
    const failed = (code: string): ToolResult => ({ ...base, status: 'error', evidence: [], artifacts: [], output: {},
      error: { code, retryable: false }, coverage: 'unknown' });
    if (envelope.failure) return failed(envelope.failure.code);
    const raw = object(envelope.value);
    // The pinned SDK removes the complete discriminator while decoding this result.
    if (!raw || raw['resultType'] !== undefined && raw['resultType'] !== 'complete') return failed('mcp_result_unsupported');
    if (raw['isError'] === true) return failed('mcp_tool_error');
    if (!Array.isArray(raw['content']) || raw['content'].some(value => object(value)?.['type'] !== 'text')) return failed('mcp_content_unsupported');
    const structured = raw['structuredContent'];
    if (structured === undefined || !remoteValid(structured)) return failed('mcp_output_invalid');
    let projected: McpReadProjection;
    try { projected = structuredClone(project(structuredClone(structured), structuredClone(task))); }
    catch { return failed('mcp_projection_invalid'); }
    if (!outputValid(projected.output) || !['complete', 'partial', 'unknown'].includes(projected.coverage) ||
      !Array.isArray(projected.observations) || projected.observations.length > 100) return failed('mcp_projection_invalid');
    const evidence: Evidence[] = projected.observations.map((record, index) => ({ id: `mcp:${envelope.attemptId}:${index}`,
      tenantId: basis.policy.tenantId, scope: basis.goal.scope, sourceId: record.sourceId, lineageId: record.lineageId,
      locator: record.locator, observedAt: record.observedAt, recordedAt: envelope.recordedAt, labels: [...ref.labels],
      coverage: record.coverage, facts: structuredClone(record.facts), artifact: structuredClone(ref),
      status: 'accepted', access: 'available', supersedes: [], derivedFrom: [] }));
    if (evidence.some(value => value.observedAt > envelope.recordedAt ||
      projected.coverage !== 'complete' && value.coverage === 'complete')) return failed('mcp_projection_invalid');
    try { return parseContract(ToolResultSchema, { ...base, status: projected.coverage === 'complete' ? 'success' : 'partial',
      evidence, artifacts: [ref], output: projected.output, coverage: projected.coverage, error: null }); }
    catch { return failed('mcp_projection_invalid'); }
  }

  const invalidSavedResult = (): never => { throw new Error('mcp_saved_result_invalid'); };
  type Receipt = NonNullable<Awaited<ReturnType<StateRepository['receipt']>>>;
  async function original(state: WorkState, attemptId: string, response: Receipt, custodyRead = false) {
    const dispatch = await services.state.receipt(state.id, `dispatch:${attemptId}`);
    const intent = await services.state.receipt(state.id, intentId(attemptId));
    if (!dispatch || !intent) return invalidSavedResult();
    // Authenticate the exact reference without relying on artifact insertion order or reading other bodies.
    const matches = response.state.artifacts.flatMap(ref => [undefined, ...custodyWitnesses].filter(custody => response.digest ===
      digest({ type: 'mcp_response_recorded', data: responseData(attemptId, ref, custody) })).map(custody => ({ ref, custody })));
    if (matches.length !== 1) return invalidSavedResult();
    const { ref, custody } = matches[0]!;
    const basis = dispatch.state;
    if (basis.id !== state.id || basis.policy.tenantId !== state.policy.tenantId || basis.policy.principalId !== state.policy.principalId ||
      ref.tenantId !== basis.policy.tenantId || ref.byteLength > MAX_ENVELOPE_BYTES || artifactBlocked(state, ref) ||
      !custodyRead && !visibleArtifact(state, ref) ||
      !state.artifacts.some(value => same(value, ref))) return invalidSavedResult();
    const bytes = await services.artifacts.get(structuredClone(ref), structuredClone(custodyRead ? basis.policy : state.policy));
    if (bytes.byteLength !== ref.byteLength || sha256(bytes) !== ref.sha256) return invalidSavedResult();
    const envelope = parseContract(envelopeSchema, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    const attempt = basis.attempts.find(value => value.id === attemptId);
    const task = basis.plan?.tasks.find(value => value.id === attempt?.taskId);
    if (!attempt || !task || envelope.workId !== state.id || envelope.attemptId !== attemptId ||
      envelope.inputDigest !== attempt.inputDigest || envelope.inputDigest !== taskDigest(task, services.digester) ||
      envelope.contractDigest !== contractDigest || attempt.contractDigest !== contractDigest || envelope.bindingDigest !== bindingDigest ||
      envelope.policyDigest !== digest(basis.policy) || envelope.goalDigest !== digest(basis.goal) ||
      envelope.lifecycleGeneration !== dataGeneration(basis) || dataGeneration(state) !== dataGeneration(basis) ||
      envelope.session.endpointId !== origin.endpointId || envelope.session.protocolVersion !== origin.protocolVersion ||
      envelope.recordedAt < attempt.startedAt || envelope.recordedAt > response.state.updatedAt ||
      !same(ref.labels, [...new Set([...disclosureLabels(basis), ...definition.labels])].sort()) ||
      intent.digest !== digest({ type: 'mcp_request_intent', data: intentData(attemptId, attempt.inputDigest, envelope.session) })) return invalidSavedResult();
    if (custody && (custody.transportCalls !== envelope.transportCalls ||
      (custody.outcome === 'failure') !== (envelope.failure !== null))) return invalidSavedResult();
    return { dispatch, intent, response, ref, envelope, basis, attempt, task, custody };
  }

  async function readProof(state: WorkState, result: ToolResult): Promise<boolean> {
    const response = await services.state.receipt(state.id, responseId(result.attemptId));
    if (!response) return false;
    const { envelope, ref, basis, task, custody } = await original(state, result.attemptId, response);
    if (custody?.outcome === 'captured') return false;
    const { knowledgeDependencies: _retainedDependencies, ...body } = result;
    return same(body, projectResult(envelope, ref, basis, task));
  }

  const originOf = (attempt: Attempt) => ({ id: attempt.id, taskId: attempt.taskId, planRevision: attempt.planRevision,
    goalRevision: attempt.goalRevision, toolId: attempt.toolId, toolVersion: attempt.toolVersion, inputDigest: attempt.inputDigest,
    contractDigest: attempt.contractDigest, scope: attempt.scope, effect: attempt.effect,
    owner: attempt.owner, startedAt: attempt.startedAt, leaseUntil: attempt.leaseUntil });
  async function restoreResult(suppliedState: WorkState, suppliedInput: StoredToolResultInput): Promise<StoredToolResult> {
    const state = structuredClone(suppliedState), input = structuredClone(suppliedInput);
    const commandId = responseId(input.attemptId), response = await services.state.receipt(state.id, commandId);
    if (!response) return { kind: 'absent' };
    const saved = await original(state, input.attemptId, response);
    const { dispatch, intent, ref, envelope, basis, attempt, task, custody } = saved;
    if (custody?.outcome === 'captured') return invalidSavedResult();
    const current = state.attempts.find(value => value.id === input.attemptId);
    if (!current || !same(task, input.task) || !same(originOf(current), originOf(attempt)) ||
      attempt.effect !== 'read' || attempt.effectState !== 'none' || attempt.status !== 'running' ||
      attempt.resultId !== null || attempt.resultArtifact !== null || attempt.adopted || attempt.error !== null ||
      task.toolId !== definition.id || task.toolVersion !== definition.version || task.effect !== 'read' ||
      attempt.planRevision !== basis.plan?.revision || attempt.goalRevision !== basis.goal.revision || attempt.scope !== basis.goal.scope ||
      dispatch.digest !== digest({ type: 'attempt_dispatched', data: asJson({ attemptId: attempt.id, owner: attempt.owner }) }) ||
      !(dispatch.state.revision < intent.state.revision && intent.state.revision < response.state.revision && response.state.revision <= state.revision) ||
      !same(state.goal, basis.goal) || !same(state.plan, basis.plan) || !same(state.policy, basis.policy) || state.deadlineAt !== basis.deadlineAt ||
      !['running', 'failed'].includes(current.status) || current.effectState !== 'none' || current.resultId !== null || current.resultArtifact !== null || current.adopted ||
      current.status === 'running' && current.error !== null || current.status === 'failed' && current.error?.code !== 'lease_expired' ||
      ['paused', 'cancelled', 'completed', 'failed', 'blocked'].includes(state.status)) return invalidSavedResult();
    for (const snapshot of [intent.state, response.state]) {
      const originalAttempt = snapshot.attempts.find(value => value.id === attempt.id);
      if (snapshot.id !== state.id || !originalAttempt || !same(originOf(originalAttempt), originOf(attempt)) ||
        originalAttempt.status !== 'running' || originalAttempt.effectState !== 'none' || originalAttempt.error !== null ||
        originalAttempt.resultId !== null || originalAttempt.resultArtifact !== null || originalAttempt.adopted ||
        ['paused', 'cancelled', 'completed', 'failed', 'blocked'].includes(snapshot.status) ||
        !same(snapshot.goal, basis.goal) || !same(snapshot.plan, basis.plan) || !same(snapshot.policy, basis.policy) ||
        snapshot.deadlineAt !== basis.deadlineAt || dataGeneration(snapshot) !== dataGeneration(basis)) return invalidSavedResult();
    }
    if (basis.id !== state.id || state.attempts.some(value => value.id !== attempt.id && value.taskId === attempt.taskId &&
      !basis.attempts.some(original => original.id === value.id))) return invalidSavedResult();
    // These are host-clock capture/preparation times, not network arrival or physical commit completion times.
    const times = [attempt.startedAt, dispatch.state.updatedAt, intent.state.updatedAt, envelope.recordedAt, response.state.updatedAt];
    const now = services.clock.now();
    if (!times.every(value => Number.isSafeInteger(value) && value >= 0) || times.some((value, index) => index > 0 && value < times[index - 1]!) ||
      response.state.updatedAt >= Math.min(attempt.leaseUntil, basis.deadlineAt) || !Number.isSafeInteger(now) ||
      now < Math.max(state.updatedAt, response.state.updatedAt) || now >= state.deadlineAt) return invalidSavedResult();
    return { kind: 'available', result: projectResult(envelope, ref, basis, task), receivedAt: envelope.recordedAt,
      receipt: { commandId, digest: response.digest, artifact: structuredClone(ref) } };
  }

  async function restoreUsage(suppliedState: WorkState, suppliedInput: StoredToolResultInput): Promise<StoredToolUsage> {
    const state = structuredClone(suppliedState), input = structuredClone(suppliedInput), commandId = responseId(input.attemptId);
    const response = await services.state.receipt(state.id, commandId);
    if (!response) return { kind: 'absent' };
    const { dispatch, intent, basis, attempt, task, ref, envelope, custody } = await original(state, input.attemptId, response, true);
    const current = state.attempts.find(value => value.id === input.attemptId);
    if (!current || !same(input.task, task) || !same(originOf(current), originOf(attempt)) ||
      attempt.status !== 'running' || attempt.effect !== 'read' || attempt.effectState !== 'none' ||
      attempt.resultId !== null || attempt.resultArtifact !== null || attempt.adopted ||
      dispatch.digest !== digest({ type: 'attempt_dispatched', data: asJson({ attemptId: attempt.id, owner: attempt.owner }) }) ||
      !(dispatch.state.revision < intent.state.revision && intent.state.revision < response.state.revision && response.state.revision <= state.revision))
      return invalidSavedResult();
    for (const snapshot of [intent.state, response.state]) {
      const originalAttempt = snapshot.attempts.find(value => value.id === attempt.id);
      if (snapshot.id !== state.id || snapshot.policy.tenantId !== basis.policy.tenantId || snapshot.policy.principalId !== basis.policy.principalId ||
        !originalAttempt || !same(originOf(originalAttempt), originOf(attempt)) || dataGeneration(snapshot) !== dataGeneration(basis)) return invalidSavedResult();
    }
    const times = [attempt.startedAt, dispatch.state.updatedAt, intent.state.updatedAt, envelope.recordedAt, response.state.updatedAt];
    if (!times.every(value => Number.isSafeInteger(value) && value >= 0) || times.some((value, index) => index > 0 && value < times[index - 1]!) ||
      services.clock.now() < Math.max(state.updatedAt, response.state.updatedAt)) return invalidSavedResult();
    // An old generic exception was not distinguishable from a measured send in a v1 failure envelope.
    const transportCalls = custody ? custody.transportCalls : envelope.failure?.sent ? null : envelope.transportCalls;
    return { kind: 'available', usage: { transportCalls, internalOperations: null, imageBytes: null, waitMs: null },
      receivedAt: envelope.recordedAt, receipt: { commandId, digest: response.digest, artifact: structuredClone(ref) },
      custodyOnly: custody !== undefined, responseObserved: envelope.failure === null };
  }

  async function execute(originalTask: TaskSpec, originalContext: Context): Promise<ToolResult> {
    if (!online) throw new Error('mcp_stored_only');
    const capturedSession = online.session, client = online.client;
    const task = structuredClone(originalTask); const context = { ...originalContext, policy: structuredClone(originalContext.policy) };
    if (!context.authorize || !inputValid(task.input)) throw new Error('mcp_authority_required');
    const authorize = context.authorize;
    const dispatch = await services.state.receipt(context.workId, `dispatch:${context.attemptId}`);
    if (!dispatch) throw new Error('mcp_dispatch_missing');
    const basis = dispatch.state; const attempt = basis.attempts.find(value => value.id === context.attemptId);
    if (!attempt || attempt.contractDigest !== contractDigest || taskDigest(task, services.digester) !== attempt.inputDigest)
      throw new Error('mcp_dispatch_mismatch');
    const guard = (state: WorkState) => {
      const active = state.attempts.find(value => value.id === context.attemptId);
      if (!active || active.status !== 'running' || active.owner !== attempt.owner || context.signal.aborted ||
        ['paused', 'cancelled', 'completed', 'failed', 'blocked'].includes(state.status) ||
        services.clock.now() >= Math.min(active.leaseUntil, state.deadlineAt) ||
        !same(state.goal, basis.goal) || !same(state.policy, basis.policy) || !same(context.policy, basis.policy) ||
        dataGeneration(state) !== dataGeneration(basis)) throw new Error('mcp_execution_not_current');
    };
    await authorize();
    if (await services.state.receipt(context.workId, intentId(context.attemptId))) throw new Error('mcp_attempt_already_started');
    const intent = await transact(services, context.workId, intentId(context.attemptId), 'mcp_request_intent',
      intentData(context.attemptId, attempt.inputDigest, capturedSession), guard, authorize);
    if (!intent.committed) throw new Error('mcp_attempt_already_started');
    let reply: McpReply | null = null, captured: Readonly<McpDecodedResponse> | undefined;
    let failure: Envelope['failure'] = null, callError: unknown, failedCall = false;
    try { reply = await client.call(structuredClone(capturedSession), remote.name, task.input, { signal: context.signal, authorize,
      capture: { now: () => services.clock.now(), decoded: value => { captured = value; } } }); }
    catch (error) {
      callError = error; failedCall = true;
    }
    if (captured) {
      if (!same(captured.session, capturedSession) || captured.requestDigest !== digest({ session: capturedSession, name: remote.name, input: task.input }) ||
        captured.transportCalls !== 1 || !Number.isSafeInteger(captured.observedAt) || captured.observedAt < intent.state.updatedAt ||
        captured.observedAt > services.clock.now() || new TextEncoder().encode(captured.json).byteLength !== captured.byteLength ||
        captured.byteLength > MAX_ENVELOPE_BYTES) throw new Error('mcp_capture_identity');
      const value = parseContract(JsonSchema, JSON.parse(captured.json));
      if (reply && !same(reply.value, value)) throw new Error('mcp_capture_identity');
      reply = { session: structuredClone(capturedSession), value, transportCalls: 1 };
    } else if (failedCall) {
      if (!(callError instanceof McpCallError)) throw callError;
      failure = { code: callError.sent ? 'mcp_transport_failed' : 'mcp_call_not_sent', sent: callError.sent };
    }
    if (!reply && !failure) throw new Error('mcp_reply_identity');
    if (reply && (!same(reply.session, capturedSession) || reply.transportCalls !== 1)) throw new Error('mcp_reply_identity');
    const custodyAuthorize = context.authorizeResponseCustody ?? authorize;
    const custodyGuard = (state: WorkState) => {
      const active = state.attempts.find(value => value.id === context.attemptId);
      if (!active || !same(originOf(active), originOf(attempt)) || state.policy.tenantId !== basis.policy.tenantId ||
        state.policy.principalId !== basis.policy.principalId || dataGeneration(state) !== dataGeneration(basis))
        throw new Error('mcp_custody_changed');
      if (!context.authorizeResponseCustody) guard(state);
    };
    const assertCustody = async () => {
      await custodyAuthorize();
      const currentIntent = await services.state.receipt(context.workId, intentId(context.attemptId));
      if (!currentIntent || currentIntent.digest !== digest({ type: 'mcp_request_intent',
        data: intentData(context.attemptId, attempt.inputDigest, capturedSession) }) || !same(currentIntent.state, intent.state))
        throw new Error('mcp_custody_changed');
      await custodyAuthorize();
    };
    await assertCustody();
    const envelope = parseContract(envelopeSchema, { schemaVersion: 1, kind: 'mcp_decoded_response', workId: context.workId,
      attemptId: context.attemptId, inputDigest: attempt.inputDigest, contractDigest, bindingDigest,
      goalDigest: digest(basis.goal), policyDigest: digest(basis.policy), lifecycleGeneration: dataGeneration(basis),
      session: capturedSession, recordedAt: captured?.observedAt ?? services.clock.now(), value: reply?.value ?? null, failure,
      transportCalls: reply ? 1 : failure?.sent ? 1 : 0 });
    const bytes = new TextEncoder().encode(JSON.stringify(envelope));
    if (bytes.byteLength > MAX_ENVELOPE_BYTES) throw new Error('mcp_response_too_large');
    const ref = await services.artifacts.put(bytes, { tenantId: basis.policy.tenantId,
      labels: [...new Set([...disclosureLabels(basis), ...definition.labels])].sort(), mediaType: 'application/json' });
    await assertCustody();
    const witness: CustodyWitness = { schemaVersion: 1, outcome: failure ? 'failure' : failedCall ? 'captured' : 'returned',
      transportCalls: envelope.transportCalls as 0 | 1 };
    await transact(services, context.workId, responseId(context.attemptId), 'mcp_response_recorded', responseData(context.attemptId, ref, witness), state => {
      custodyGuard(state);
      if (state.artifacts.some(value => value.id === ref.id)) throw new Error('mcp_response_already_present');
      state.artifacts.push(structuredClone(ref));
    }, assertCustody);
    // A captured value after a failed SDK post-check is retained, never returned as an authorized answer.
    if (failedCall && captured) throw callError;
    await authorize();
    return projectResult(envelope, ref, basis, task);
  }
  return Object.freeze({ definition, ...(online ? {} : { availability: 'stored_only' as const }), execute, restoreResult, restoreUsage, validateResult: async (state: WorkState, result: ToolResult) => {
    try { return await readProof(state, result); } catch { return false; }
  } });
}

/** One locally approved publication after bounded remote discovery; not a remote atomic snapshot claim. */
export function createMcpProviderSource(bindings: McpReadBinding[], client: ClientPort, services: Services, schemas: SchemaCompiler): ProviderToolSource {
  const captured = bindings.map(value => ({ ...value, definition: structuredClone(value.definition), remote: structuredClone(value.remote), project: value.project.bind(value) }));
  return { async list({ cursor, signal }) {
    if (cursor !== null) throw new Error('mcp_local_snapshot_has_no_cursor');
    const session = await client.discover(captured.map(value => value.remote), signal);
    const tools = captured.map(binding => createMcpReadTool(binding, session, client, services, schemas));
    return { revision: services.digester.digest(asJson({ session, definitions: tools.map(tool => tool.definition) })), tools, nextCursor: null };
  } };
}
