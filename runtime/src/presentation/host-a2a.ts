import { z } from 'zod';
import { A2aMessageSchema, A2aReplySchema, A2aTaskSchema, type A2aCall, type A2aMessage, type A2aPeer } from '../application/a2a-contracts.js';
import type { Tool } from '../application/ports.js';
import type { ToolResult } from '../domain/model.js';
import type { WorkActor } from '../application/work-resources.js';
import { asJson } from '../application/plan-validator.js';
import { frozen } from '../application/resource-contracts.js';
import { toolInputSchema } from '../application/tool-input-schema.js';
import { markCollaborationTool } from '../application/collaboration-tool-identity.js';
import { A2aJsonRpcPeer, type A2aJsonRpcOptions } from '../infrastructure/a2a-json-rpc.js';
import { a2aReplyMissionSource } from '../infrastructure/mission-sources.js';
import type { MissionEventSource } from '../application/mission-contracts.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { closeAgentTurnResources } from './host-models.js';

export interface HostA2aContext {
  readonly agentId: string; readonly root: string; readonly scope: string; readonly actor: WorkActor; readonly signal: AbortSignal;
}
export interface HostA2aRegistration {
  readonly allowWrites?: boolean;
  open(context: Readonly<HostA2aContext>): Promise<{ peer: A2aPeer; close(): Promise<void> }>;
}
export interface OpenedHostA2a {
  readonly peer: A2aPeer; readonly tools: readonly Tool[]; readonly sources: readonly MissionEventSource[];
  readonly allowedTools: readonly string[]; readonly allowWrites: boolean;
  close(): Promise<void>;
}
const GetSchema = z.strictObject({ taskId: A2aTaskSchema.shape.id });
const SendSchema = A2aMessageSchema.omit({ role: true, messageId: true }).strict();

/** Host injection only. Endpoint, authentication and remote identity never come from model input. */
export async function openHostA2a(registration: HostA2aRegistration | undefined, context: HostA2aContext): Promise<OpenedHostA2a | null> {
  if (registration === undefined) return null;
  const open = registration.open, allowWrites = registration.allowWrites;
  if (typeof open !== 'function' || allowWrites !== undefined && typeof allowWrites !== 'boolean') throw new Error('a2a_registration_invalid');
  const actor = frozen(structuredClone(context.actor)), lifetime = new AbortController();
  const signal = AbortSignal.any([context.signal, lifetime.signal]); signal.throwIfAborted();
  const opened = await open.call(registration, Object.freeze({ ...context, actor, signal }));
  let close: (() => Promise<void>) | undefined;
  try {
    const sourceClose = opened.close;
    if (typeof sourceClose !== 'function') throw new Error('a2a_registration_invalid');
    let closing: Promise<void> | undefined;
    const pending = new Set<Promise<unknown>>();
    close = () => {
      lifetime.abort();
      // Source cleanup may itself release pending I/O. Start it before draining the accepted entries.
      return closing ??= Promise.allSettled([Promise.resolve().then(() => sourceClose.call(opened)), ...pending]).then(([result]) => {
        if (result!.status === 'rejected') throw result!.reason;
      });
    };
    const source = opened.peer, { id, protocolVersion, destination, labels: sourceLabels, send, get, cancel } = source;
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id) || id === 'core' || protocolVersion !== '1.0' || !destination ||
      !Array.isArray(sourceLabels) || sourceLabels.some(value => typeof value !== 'string' || !actor.allowedLabels?.includes(value)) ||
      !actor.allowedDestinations?.includes(destination) || [send, get, cancel].some(value => typeof value !== 'function')) throw new Error('a2a_registration_invalid');
    const labels = Object.freeze([...sourceLabels]);
    const invoke = <T>(call: A2aCall, read: boolean, operation: (selected: A2aCall) => Promise<T>): Promise<T> => {
      const combined = AbortSignal.any([signal, call.signal]), check = call.authorize;
      if (combined.aborted) return Promise.reject(combined.reason);
      if (!read && !allowWrites) return Promise.reject(new Error('a2a_access_denied'));
      const authorize = async () => {
        combined.throwIfAborted(); await check?.call(call); combined.throwIfAborted();
      };
      const selected = Object.freeze({ requestId: call.requestId, signal: combined, authorize });
      const result = Promise.resolve().then(async () => {
        await authorize(); combined.throwIfAborted(); const value = await operation(selected);
        if (read) await authorize();
        // A confirmed write reply survives later cancellation; receiving it does not authorize local adoption.
        return value;
      });
      pending.add(result);
      void result.then(() => { pending.delete(result); }, () => { pending.delete(result); });
      return result;
    };
    const peer: A2aPeer = Object.freeze({ id, protocolVersion, destination, labels,
      send: async (message: A2aMessage, call: A2aCall) => {
        const captured = A2aMessageSchema.parse(structuredClone(message));
        return invoke(call, false, async selected => A2aReplySchema.parse(await send.call(source, captured, selected)));
      },
      get: (taskId: string, call: A2aCall) => invoke(call, true, async selected => {
        const requestedId = A2aTaskSchema.shape.id.parse(taskId), task = A2aTaskSchema.parse(await get.call(source, requestedId, selected));
        if (task.id !== requestedId) throw new Error('a2a_task_identity'); return task;
      }),
      cancel: (taskId: string, call: A2aCall) => invoke(call, false, async selected => {
        const requestedId = A2aTaskSchema.shape.id.parse(taskId), task = A2aTaskSchema.parse(await cancel.call(source, requestedId, selected));
        if (task.id !== requestedId) throw new Error('a2a_task_identity'); return task;
      }), close });
    const digester = new Sha256Digester();
    const tools: Tool[] = (allowWrites ? ['get', 'send', 'cancel'] as const : ['get'] as const).map(operation => {
      const toolId = `${id}.${operation}`, schema = operation === 'send' ? SendSchema : GetSchema;
      return markCollaborationTool({ definition: { provider: id, id: toolId, version: '1.0', destination, labels: [...labels], effect: operation === 'get' ? 'read' : 'write',
        description: operation === 'get' ? 'Read an A2A task as unreviewed external reference material; its remote status does not complete this work.' :
          `Explicit A2A ${operation}. Requires host write permission. Remote acknowledgement is not local goal completion. Unknown outcomes require reconciliation, never automatic replay.`,
        inputSchema: toolInputSchema(schema), outputSchema: { type: 'object' } },
        async execute(task, invocation): Promise<ToolResult> {
          const combined = AbortSignal.any([signal, invocation.signal]);
          const authorize = async () => {
            combined.throwIfAborted(); await invocation.authorize?.(); combined.throwIfAborted();
            if (invocation.policy.tenantId !== actor.tenantId || invocation.policy.principalId !== actor.principalId ||
              !invocation.policy.allowedTools.includes(toolId) || !invocation.policy.allowedDestinations.includes(destination) ||
              labels.some(label => !invocation.policy.allowedLabels.includes(label)) ||
              operation !== 'get' && (!allowWrites || !invocation.policy.allowWrites)) throw new Error('a2a_access_denied');
          };
          if (task.toolId !== toolId || task.toolVersion !== '1.0' || task.effect !== (operation === 'get' ? 'read' : 'write')) throw new Error('a2a_task_invalid');
          const input = schema.parse(task.input), requestId = digester.digest(asJson({ agentId: context.agentId, workId: invocation.workId, attemptId: invocation.attemptId, operation }));
          await authorize();
          const call = { requestId, signal: combined, authorize };
          const reply = operation === 'send' ? A2aReplySchema.parse(await peer.send(A2aMessageSchema.parse({ ...input, messageId: requestId, role: 'ROLE_USER' }), call)) :
            A2aTaskSchema.parse(await (operation === 'get' ? peer.get : peer.cancel)(GetSchema.parse(input).taskId, call));
          if (operation === 'get') await authorize();
          // A returned write acknowledgement remains a fact even if cancellation arrives later. Runtime adoption rechecks authority.
          return { resultId: `${invocation.attemptId}:result`, attemptId: invocation.attemptId, status: 'success', coverage: 'complete',
            effectState: operation === 'get' ? 'none' : 'confirmed', output: asJson({ kind: 'unreviewed_a2a_reply', peer: id, reply }),
            evidence: [], artifacts: [], cursor: null, error: null };
        } }, 'a2a');
    });
    signal.throwIfAborted();
    return Object.freeze({ peer, tools: Object.freeze(tools), sources: Object.freeze([a2aReplyMissionSource(peer)]),
      allowedTools: Object.freeze(tools.map(tool => tool.definition.id)), allowWrites: allowWrites === true, close });
  } catch (error) { await closeAgentTurnResources(close ? [close] : [], { error }); throw error; }
}

export function createJsonRpcA2aRegistration(options: A2aJsonRpcOptions, grants: { allowWrites?: boolean } = {}): HostA2aRegistration {
  const selected = { ...options, labels: Object.freeze([...options.labels]), ...(options.headers ? { headers: Object.freeze({ ...options.headers }) } : {}) };
  return Object.freeze({ ...(grants.allowWrites === undefined ? {} : { allowWrites: grants.allowWrites }), async open() {
    const peer = new A2aJsonRpcPeer(selected); return { peer, close: () => peer.close() };
  } });
}
