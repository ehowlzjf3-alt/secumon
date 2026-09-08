import { z } from 'zod';
import type { TaskSpec, ToolResult } from '../domain/model.js';
import type { Tool } from './ports.js';
import { A2aMessageSchema, A2aReplySchema, A2aTaskSchema, type A2aMessage, type A2aTask } from './a2a-contracts.js';

const sendInput = A2aMessageSchema.omit({ role: true, messageId: true }).strict();
const taskInput = z.strictObject({ taskId: A2aTaskSchema.shape.id });
const envelope = z.strictObject({ kind: z.literal('unreviewed_a2a_reply'), peer: z.string(), reply: z.unknown() });

/** Classifies adopted native replies as preparation, never independent evidence or local completion. */
export function a2aProgressKeys(task: TaskSpec, result: ToolResult, tool: Tool,
  key: (kind: string, value: unknown) => string): string[] {
  if (tool.definition.version !== '1.0' || result.status !== 'success' || result.coverage !== 'complete' ||
    result.artifacts.length || result.evidence.length || result.cursor !== null) return [];
  const page = envelope.safeParse(result.output);
  if (!page.success || page.data.peer !== tool.definition.provider) return [];
  const peer = { id: tool.definition.provider, version: tool.definition.version, destination: tool.definition.destination };
  // Protocol handles and tracing metadata are not new content. Business data is preserved verbatim.
  const parts = (values: A2aMessage['parts']) => values.map(({ metadata: _metadata, ...content }) => content);
  const meaning = (value: A2aTask) => ({ state: value.status.state,
    message: value.status.message ? parts(value.status.message.parts) : null,
    artifacts: [...new Set((value.artifacts ?? []).map(artifact => key('a2a-artifact', parts(artifact.parts))))].sort() });
  if (task.toolId === `${peer.id}.send`) {
    if (task.effect !== 'write' || result.effectState !== 'confirmed') return [];
    const input = sendInput.safeParse(task.input), reply = A2aReplySchema.safeParse(page.data.reply);
    if (!input.success || !reply.success) return [];
    const request = parts(input.data.parts);
    return [key('a2a-send', { peer, request }), key('a2a-send-reply', { peer, request,
      reply: 'task' in reply.data ? meaning(reply.data.task) : { message: parts(reply.data.message.parts) } })];
  }
  const read = task.toolId === `${peer.id}.get`, cancel = task.toolId === `${peer.id}.cancel`;
  if ((!read && !cancel) || task.effect !== (read ? 'read' : 'write') || result.effectState !== (read ? 'none' : 'confirmed')) return [];
  const input = taskInput.safeParse(task.input), reply = A2aTaskSchema.safeParse(page.data.reply);
  if (!input.success || !reply.success || reply.data.id !== input.data.taskId) return [];
  // The selected resource distinguishes separate real tasks. Polling that same task only credits changed meaning.
  // Cancel and get share the key so reading an already observed cancellation cannot mint another milestone.
  return [key('a2a-task', { peer, taskId: input.data.taskId, reply: meaning(reply.data) })];
}
