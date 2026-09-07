import { z } from 'zod';
import { A2aMessageSchema, A2aTaskSchema, type A2aTask } from '../application/a2a-contracts.js';
import type { AgentTurnService, AgentTurnRequest } from '../application/agent-turn-service.js';
import type { SessionService } from '../application/session-service.js';
import type { ConversationService } from '../application/conversation-service.js';
import type { WorkflowRuntime } from '../application/workflow-runtime.js';
import type { RuntimeServices } from '../application/services.js';
import type { WorkActor } from '../application/work-resources.js';
import { authorizedWork } from '../application/work-resources.js';
import { JsonSchema } from '../application/contracts.js';
import { UserCommandSchema } from '../application/execution-runtime.js';
import { asJson } from '../application/plan-validator.js';
import { frozen } from '../application/resource-contracts.js';
import { allowsDisclosure, disclosureLabels } from '../domain/disclosure.js';
import { assertExecutionAuthority } from '../application/execution-authority.js';

const Id = z.string().min(1).max(256);
const RequestSchema = z.strictObject({ jsonrpc: z.literal('2.0'), id: z.union([Id, z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)]),
  method: Id, params: JsonSchema });
const SendSchema = z.strictObject({ message: A2aMessageSchema, configuration: z.strictObject({ returnImmediately: z.literal(true),
  historyLength: z.number().int().min(0).max(100).optional(), acceptedOutputModes: z.array(z.string()).max(16).optional() }) });
const GetSchema = z.strictObject({ id: Id, historyLength: z.number().int().min(0).max(100).optional() });
const CancelSchema = z.strictObject({ id: Id });
type RpcReply = { jsonrpc: '2.0'; id: string | number | null; result: unknown } |
  { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string } };
export interface A2aRequestHost {
  /** The authenticated caller and its granted actor are fixed by the listener, never by the JSON-RPC body. */
  agentId: string; callerId: string; actor: WorkActor; scope: string; destination: string; signal: AbortSignal;
  policy: AgentTurnRequest['policy']; limits: AgentTurnRequest['limits']; mode?: AgentTurnRequest['mode']; maxSteps?: number;
  services: RuntimeServices; sessions: SessionService; turns: AgentTurnService; conversation: ConversationService; workflow: WorkflowRuntime;
}

/** No listener or authentication implementation. Open one binding only after the host authenticated/authorized its caller. */
export async function openA2aRequestHandler(input: A2aRequestHost) {
  const actor = frozen(structuredClone(input.actor)), policy = frozen(structuredClone(input.policy)), limits = frozen(structuredClone(input.limits));
  const agentId = Id.parse(input.agentId), callerId = Id.parse(input.callerId), scope = Id.parse(input.scope), destination = Id.parse(input.destination);
  const steps = z.number().int().min(1).max(1000).parse(input.maxSteps ?? 100), mode = input.mode ?? 'auto';
  if (input.sessions.agentId !== agentId || policy.tenantId !== actor.tenantId || policy.principalId !== actor.principalId ||
    !policy.allowedDestinations.includes(destination) || !actor.allowedDestinations?.includes(destination)) throw new Error('a2a_caller_denied');
  const lifetime = new AbortController(), signal = AbortSignal.any([input.signal, lifetime.signal]); signal.throwIfAborted();
  const digest = (value: unknown) => input.services.digester.digest(asJson(value));
  const conversationId = `a2a-${digest({ agentId, callerId, tenantId: actor.tenantId, principalId: actor.principalId })}`;
  const session = await input.sessions.open(actor, { channel: 'peer', conversationId });
  const sessionId = session.scope.sessionId;
  const pending = new Set<Promise<unknown>>();
  const running = new Set<{ workId: string }>();
  let closing: Promise<void> | undefined;
  const track = <T>(operation: () => Promise<T>): Promise<T> => {
    if (signal.aborted) return Promise.reject(signal.reason);
    const promise = Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); });
    pending.add(promise);
    // Observe settlement without replacing the promise or its original rejection for the caller.
    void promise.then(() => { pending.delete(promise); }, () => { pending.delete(promise); });
    return promise;
  };
  const messageId = (id: string) => `a2a-message-${digest({ callerId, id })}`;
  const selected = async (workId: string) => {
    signal.throwIfAborted(); const state = await authorizedWork(input.services.state, workId, actor); signal.throwIfAborted();
    const owner = state.conversation?.session?.scope;
    if (!owner || owner.agentId !== agentId || owner.sessionId !== sessionId || state.goal.scope !== scope ||
      !state.conversation?.bindings.some(binding => binding.channel === 'peer' && binding.conversationId === conversationId &&
        binding.destination === destination && binding.session?.sessionId === sessionId)) throw new Error('a2a_task_unavailable');
    assertExecutionAuthority(input.services, state); return state;
  };
  const task = async (workId: string): Promise<A2aTask> => {
    for (let retry = 0; retry < 8; retry++) {
      const state = await selected(workId), view = await input.conversation.snapshot(workId, actor);
      const deliveries = await input.services.state.deliveries(workId);
      if (state.revision !== view.revision || (await selected(workId)).revision !== state.revision) continue;
      const disclosed = allowsDisclosure(state.policy, destination, 'channel', disclosureLabels(state));
      const result = disclosed && view.resultReady ? deliveries.find(value => value.id === state.conversation?.result?.id && value.kind === 'result' &&
        value.goalRevision === state.goal.revision && value.status === 'delivered' && value.context?.binding.channel === 'peer' &&
        value.context.binding.conversationId === conversationId && value.context.binding.session?.sessionId === sessionId) : undefined;
      const question = disclosed ? deliveries.findLast(value => value.kind === 'question' && value.status === 'delivered' &&
        value.goalRevision === state.goal.revision && value.context?.binding.conversationId === conversationId &&
        value.context.binding.session?.sessionId === sessionId && value.context.obligationIds.some(id => view.pendingQuestions.some(q => q.id === id))) : undefined;
      const status: A2aTask['status']['state'] = state.status === 'cancelled' ? 'TASK_STATE_CANCELED' :
        ['failed', 'blocked'].includes(state.status) ? 'TASK_STATE_FAILED' : state.status === 'completed' && result ? 'TASK_STATE_COMPLETED' :
          question || state.status === 'paused' ? 'TASK_STATE_INPUT_REQUIRED' : state.modelCalls.length || state.attempts.length ? 'TASK_STATE_WORKING' : 'TASK_STATE_SUBMITTED';
      const reply = A2aTaskSchema.parse({ id: workId, contextId: sessionId, status: { state: status,
        ...(question ? { message: { messageId: question.id, taskId: workId, contextId: sessionId, role: 'ROLE_AGENT', parts: [{ text: question.text }] } } : {}) },
        ...(result ? { artifacts: [{ artifactId: result.id, parts: [{ text: result.text }] }] } : {}) });
      signal.throwIfAborted(); return reply;
    }
    throw new Error('a2a_task_changed');
  };
  const run = (workId: string) => track(async () => {
    const state = await selected(workId); signal.throwIfAborted();
    const active = { workId }; running.add(active);
    try {
      return await input.workflow.run(workId, actor, { maxSteps: steps, expectedGoalRevision: state.goal.revision,
        onStep: async () => { signal.throwIfAborted(); await selected(workId); } });
    } finally { running.delete(active); }
  });
  const handle = (version: string, value: unknown): Promise<RpcReply> => track(async (): Promise<RpcReply> => {
    signal.throwIfAborted();
    const parsed = RequestSchema.safeParse(value);
    if (!parsed.success) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid JSON-RPC request' } };
    const request = parsed.data, ok = (result: unknown): RpcReply => ({ jsonrpc: '2.0', id: request.id, result });
    const error = (code: number, message: string): RpcReply => ({ jsonrpc: '2.0', id: request.id, error: { code, message } });
    if (version !== '1.0') return error(-32602, 'Only A2A-Version 1.0 is supported');
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 262144) return error(-32602, 'Request exceeds the supported byte limit');
    if (request.method === 'GetTask') {
      const params = GetSchema.safeParse(request.params); if (!params.success) return error(-32602, 'Invalid GetTask parameters');
      return ok(await task(params.data.id));
    }
    if (request.method === 'SendMessage') {
      const params = SendSchema.safeParse(request.params);
      if (!params.success) return error(-32602, 'This subset requires returnImmediately:true and text/data parts');
      const message = params.data.message;
      if (message.role !== 'ROLE_USER' || message.contextId !== undefined && message.contextId !== sessionId ||
        params.data.configuration.acceptedOutputModes?.length && !params.data.configuration.acceptedOutputModes.includes('text/plain'))
        return error(-32602, 'Unsupported sender, context or output mode');
      // Serialize the complete incoming message: metadata/data remain untrusted original input, not host configuration.
      const rawText = JSON.stringify(message);
      if (rawText.length > 64000) return error(-32602, 'Message exceeds the supported text limit');
      let workId: string;
      if (message.taskId) {
        const state = await selected(message.taskId);
        const prior = await input.sessions.commandContext(actor, { sessionId, workId: state.id, messageId: messageId(message.messageId) });
        const saved = prior.receipt ? z.strictObject({ expectedGoalRevision: z.number().int().positive(), command: UserCommandSchema }).parse(prior.receipt.payload) : null;
        if (saved && (prior.receipt!.text !== rawText || !['input', 'resolve'].includes(saved.command.kind))) throw new Error('a2a_message_identity_conflict');
        const pending = state.obligations.filter(item => !item.source && item.status === 'pending' && ['response', 'evidence'].includes(item.kind));
        if (!saved && pending.length > 1) return error(-32602, 'Multiple questions require explicit local clarification');
        const command = saved?.command ?? (pending[0] ? { kind: 'resolve' as const, obligationId: pending[0].id, reason: 'a2a_question_answered' } :
          { kind: 'input' as const, reason: 'a2a_followup_received' });
        await input.sessions.command(actor, { sessionId, workId: state.id, messageId: messageId(message.messageId), rawText,
          expectedGoalRevision: saved?.expectedGoalRevision ?? state.goal.revision, command });
        workId = state.id;
      } else {
        const accepted = await input.turns.accept(actor, { sessionId, messageId: messageId(message.messageId), rawText, scope, mode, policy, limits,
          binding: { channel: 'peer', conversationId, destination, tenantId: actor.tenantId, principalId: actor.principalId, recipientId: actor.principalId } });
        workId = accepted.workId;
      }
      return ok({ task: await task(workId) });
    }
    if (request.method === 'CancelTask') {
      const params = CancelSchema.safeParse(request.params); if (!params.success) return error(-32602, 'Invalid CancelTask parameters');
      const state = await selected(params.data.id), commandId = `a2a-cancel-${digest({ callerId, requestId: request.id })}`;
      const prior = await input.sessions.commandContext(actor, { sessionId, workId: state.id, messageId: commandId });
      const saved = prior.receipt ? z.strictObject({ expectedGoalRevision: z.number().int().positive(), command: UserCommandSchema }).parse(prior.receipt.payload) : null;
      if (saved && saved.command.kind !== 'cancel') throw new Error('a2a_command_identity_conflict');
      await input.sessions.command(actor, { sessionId, workId: state.id, messageId: commandId,
        rawText: JSON.stringify({ method: 'CancelTask', id: state.id }), expectedGoalRevision: saved?.expectedGoalRevision ?? state.goal.revision,
        command: { kind: 'cancel', reason: 'a2a_caller_cancelled' } });
      return ok(await task(state.id));
    }
    return error(-32601, 'Method not supported by this A2A subset');
  });
  const close = (): Promise<void> => {
    if (closing) return closing;
    lifetime.abort();
    const errors: unknown[] = [];
    for (const workId of new Set([...running].map(value => value.workId))) {
      try { input.workflow.execution.interrupt(workId); } catch (error) { errors.push(error); }
    }
    // New handle/run entries are denied synchronously; all accepted entries are now in this snapshot.
    closing = Promise.allSettled([...pending]).then(() => {
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'a2a_handler_interrupt_failed', { cause: errors[0] });
    });
    return closing;
  };
  signal.throwIfAborted();
  return Object.freeze({ sessionId, handle, run, close,
    subset: Object.freeze({ protocolVersion: '1.0', binding: 'JSONRPC', methods: ['SendMessage', 'GetTask', 'CancelTask'],
      returnImmediatelyRequired: true, streaming: false, pushNotifications: false, history: false, fileParts: false }) });
}

/** Publish only at the host's actual authenticated listener URL. This helper does not listen or claim deployment. */
export function a2aAgentCard(input: { name: string; description: string; url: string; version: string;
  securitySchemes: Record<string, unknown>; securityRequirements: unknown[] }) {
  const url = new URL(input.url);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('a2a_card_url_invalid');
  return frozen(asJson({ name: Id.parse(input.name), description: z.string().min(1).max(4096).parse(input.description), version: Id.parse(input.version),
    supportedInterfaces: [{ url: url.href, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: { streaming: false, pushNotifications: false }, defaultInputModes: ['text/plain', 'application/json'], defaultOutputModes: ['text/plain'],
    securitySchemes: input.securitySchemes, securityRequirements: input.securityRequirements,
    skills: [{ id: 'bounded-request', name: 'Bounded task request', tags: ['text'],
      description: 'Non-blocking SendMessage requires returnImmediately:true. GetTask is read-only; host run resumes accepted tasks. Text/data subset; no streaming, push, file parts or task history.' }] }));
}
